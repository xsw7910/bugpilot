import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { COMMANDS } from "../src/commands.ts";

import { Controller } from "../src/app/controller.ts";
import type { ControllerPorts, RunOptions } from "../src/app/controller.ts";
import { DEFAULT_FORM, restoreForm } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import type { Environment } from "../src/app/environment.ts";
import type { Envelope, StreamEvent } from "../src/protocol.ts";
import type { PanelMessage, PanelState } from "../src/panel/messages.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";
import { fixModesFromPayload, managedFixModesFromPayload } from "../src/app/fixModes.ts";
import type { FixModeCatalog, ManagedFixModes } from "../src/app/fixModes.ts";
import type { FixModeRequest } from "../src/app/controller.ts";
import type { PayloadCommandRequest } from "../src/app/fixModeTransport.ts";

import { REVIEW_NEXT_STEP } from "../src/app/workflow.ts";
import { SETTINGS_SECTION_OF_STEP } from "../src/app/workflowSettings.ts";
import { MAX_REVIEW_OUTPUT } from "../src/app/reviewOutput.ts";
import { CLAUDE_CAPTURED_REVIEW } from "../src/app/agents.ts";
import type { InstalledExtension, LastAgentStore } from "../src/app/agents.ts";
import type { CapturedRun } from "../src/app/reviewRun.ts";
import { ARTIFACT_REFRESH_DEBOUNCE_MS, ARTIFACT_REFRESH_RETRY_MS } from "../src/app/controller.ts";
import { VERIFICATION_AUTOSAVE_MS } from "../src/app/verificationCapture.ts";
import { feedbackFromVerification } from "../src/app/nextAction.ts";
import { parseVerificationReport } from "../src/app/verificationReport.ts";
import type { WorkflowStepId, WorkflowStepResult } from "../src/app/workflow.ts";
import type { UserFacingError } from "../src/app/failures.ts";
import { GITIGNORE_ACTION_NAME, GITIGNORE_FAILED } from "../src/app/controller.ts";
import { SUPPORTING_FILE_MISSING, SUPPORTING_FILE_NOT_A_FILE, SUPPORTING_FILE_UNCHECKED } from "../src/app/controller.ts";
import { SESSION_FEEDBACK_MS } from "../src/app/controller.ts";
import { RESET_WAITS_FOR_HANDOFF } from "../src/app/controller.ts";
import { RESET_CANCELS_REVIEW, RESET_LEAVES_AGENT, RESET_STOPS_RUN } from "../src/app/sessionReset.ts";
import type { GitignoreDocument, GitignoreEntry, GitignoreIo } from "../src/app/gitignore.ts";
import { historyFromPayload } from "../src/app/artifacts.ts";
import { CURRENT_GROUP, DIAGNOSTICS_GROUP, HISTORY_GROUP, resultsChildren, resultsItem } from "../src/app/results.ts";
import type { ResultsNode, ResultsSources } from "../src/app/results.ts";

/**
 * One workflow row of a pushed state.
 *
 * Since Batch 6 the rows are the result view: what the Context Ready card used
 * to carry is on the row that owns it — the files and terms on Code search, the
 * context actions on Build context, the button, Strategy, outcome and handoff
 * card on Fix with AI. These getters name that owner in every assertion.
 */
function stepOf(state: PanelState, id: WorkflowStepId): WorkflowStepResult {
  const step = state.workflow.find((entry) => entry.id === id);
  assert.ok(step, `no ${id} row`);
  return step;
}
const codeRow = (state: PanelState) => stepOf(state, "codeSearch");
const buildRow = (state: PanelState) => stepOf(state, "buildContext");
const fixRow = (state: PanelState) => stepOf(state, "fixWithAI");
/** A finished package the panel reports: Build context says the context is ready. */
const reportsContext = (state: PanelState) => buildRow(state).statusText === "Context ready";
/**
 * Fix with AI is on offer: the panel's primary action, pressable. Since the
 * next-action redesign that is the only place it is offered — the row keeps
 * the status and no button.
 */
const canFix = (state: PanelState) => state.primary.action === "fixWithAI" && state.primary.enabled;
/**
 * The run's failure card, wherever it is rendered: on the row whose step was in
 * flight, or standalone when no row owns it. Never the handoff's card, which is
 * a different failure.
 */
const runErrorOf = (state: PanelState): UserFacingError | undefined =>
  state.runError ??
  state.workflow.find((step) => step.id !== "fixWithAI" && step.error !== undefined)?.error;

const ROOT = "/work/app";
const TOKEN = "ATATT3xFfGF0abcdef1234567890";

const READY: Environment = {
  kind: "ready",
  root: ROOT,
  executable: "bugpilot",
  report: { python_ok: true },
};

interface StreamRun {
  readonly args: readonly string[];
  readonly options: RunOptions;
}

interface Harness {
  readonly controller: Controller;
  readonly states: PanelState[];
  readonly streamRuns: StreamRun[];
  readonly jsonRuns: StreamRun[];
  readonly written: { path: string; contents: string }[];
  readonly opened: string[];
  readonly clipboard: string[];
  readonly notices: { kind: string; message: string }[];
  readonly logged: string[];
  readonly refreshes: { count: number };
  /** Every question asked, with its buttons. */
  readonly confirms: { message: string; confirmLabel: string; keepLabel?: string }[];
  readonly ranCommands: string[];
  readonly terminals: { name: string; cwd: string; commandLine: string }[];
  /** Terminal names still open, newest last: every one the harness opened, less any a test closes. */
  readonly openTerminals: string[];
  /** Every terminal Open AI Session brought forward, by name. */
  readonly revealed: string[];
  readonly folders: string[];
  /** Which executables `canRun` was asked about, in order. */
  readonly probed: string[];
  /** Every other extension's command BugPilot ran, in order. */
  readonly extensionCommands: string[];
  readonly saved: FormState[];
  /** Every work item the window was told to reopen after a restart; `undefined` is "none" (Reset Session). */
  readonly savedWorkItems: (string | undefined)[];
  /** How many times the Fix Mode catalog was asked for. */
  readonly fixModeCalls: { count: number };
  /** The fake file contents, live: a test may add or remove one mid-scenario. */
  readonly files: Record<string, string>;
  /** Every prompt the hint improver sent, in order. */
  readonly hintPrompts: string[];
  /** Every issue key the lightweight lookup was asked for. */
  readonly issueLookups: string[];
  readonly last: () => PanelState;
}

interface HarnessOptions {
  readonly events?: readonly StreamEvent[];
  readonly terminated?: boolean;
  readonly aborted?: boolean;
  readonly foreignVersion?: number;
  readonly stderr?: string;
  readonly streamThrows?: Error;
  /** A function may answer later, which is how a test holds a request open. */
  readonly json?: Envelope | (() => Envelope | Promise<Envelope>);
  readonly jsonThrows?: Error;
  /** A function is asked on every environment check, so a test can change the answer. */
  readonly environment?: Environment | (() => Environment);
  readonly files?: Record<string, string>;
  readonly directory?: readonly string[];
  /** Make the artifact directory unreadable rather than absent. */
  readonly directoryError?: string;
  /** Called for every file the controller reads, so a test can count them — or, returning a promise, hold a read open. */
  readonly onReadFile?: (file: string) => unknown;
  /** Whether a Jira credential is stored. Configured unless a test says not. */
  readonly credentialsConfigured?: boolean;
  /** Make reading the stored credentials reject, as a broken keyring can — from when it returns an error. */
  readonly credentialsThrow?: () => Error | undefined;
  /** This extension's own version, which is not the CLI's. */
  readonly extensionVersion?: string;
  readonly confirm?: boolean;
  /** Answer the confirm dialog later: a promise holds it open. */
  readonly confirmAnswer?: () => Promise<boolean>;
  readonly form?: FormState;
  /** Hold the stream open so a Stop can be observed mid-run. */
  readonly hold?: boolean;
  /** Whether an agent CLI can be started. */
  readonly agentOnPath?: boolean;
  /** The AI extensions installed, by id; absent means the host has no extensions port. */
  readonly extensions?: Readonly<Record<string, InstalledExtension>>;
  /** Run another extension's command: a function may answer later, or throw. */
  readonly executeExtensionCommand?: (command: string) => Promise<void>;
  /** The host's store for the last agent a handoff reached; absent keeps it for the session. */
  readonly lastAgent?: LastAgentStore;
  /** Keep a pasted or dropped file; absent means the host cannot. */
  readonly storeAttachment?: NonNullable<ControllerPorts["storeAttachment"]>;
  /** What the file dialog returns when the panel asks for attachments. */
  readonly pickFiles?: readonly string[];
  /** The Fix Mode catalog discovery returns; absent means no discovery port. */
  readonly fixModes?: FixModeCatalog;
  /** Every physical definition, for the management view. */
  readonly managed?: ManagedFixModes;
  /** What a Fix Mode management command does, and what it answers. */
  readonly runFixMode?: (request: FixModeRequest) => Promise<Envelope>;
  /** What `record-review` does, and what it answers; absent means no such port. */
  readonly runReview?: (request: PayloadCommandRequest) => Promise<Envelope>;
  /** What `record-verification` does, and what it answers; absent means no such port. */
  readonly runVerification?: (request: PayloadCommandRequest) => Promise<Envelope>;
  /** What the AI CLI answers when asked to improve a hint. */
  readonly improveHint?: (request: {
    provider: { id: string; label: string; command: string; args: readonly string[] };
    prompt: string;
  }) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /** The issue text the lightweight lookup returns; absent means it fails. */
  readonly issueDetails?: { title: string; description: string };
  /** Make the issue lookup throw rather than come back empty. */
  readonly issueDetailsThrows?: Error;
  /** Make the clipboard refuse, as a webview host can. */
  readonly clipboardThrows?: Error;
  /** Answer `canRun` instead of `agentOnPath`: a function may answer later, holding the probe open. */
  readonly agentProbe?: (command: string) => Promise<boolean>;
  /** Make opening a terminal throw, as a host that cannot start a shell would. */
  readonly terminalThrows?: Error;
  /** Hold a clipboard write open until the promise settles. */
  readonly clipboardHold?: () => Promise<void>;
  /** Answer a captured one-shot review; absent means the host has none. */
  readonly runCaptured?: NonNullable<ControllerPorts["runCapturedReview"]>;
  /** False: the fake captured review never reports that its process started. */
  readonly capturedStarts?: boolean;
  /** The host's clock. */
  readonly now?: () => number;
  /** The persisted reviewed-fix store; absent keeps it for the controller's life. */
  readonly reviewedFixes?: NonNullable<ControllerPorts["reviewedFixes"]>;
  /** The artifact watcher; absent means the host has none. */
  readonly watchArtifacts?: NonNullable<ControllerPorts["watchArtifacts"]>;
  /** A hand-run timer for the refresh debounce. */
  readonly schedule?: NonNullable<ControllerPorts["schedule"]>;
  /** The repository's .gitignore, for Repository Files' quick fix; absent means the host has none. */
  readonly gitignore?: GitignoreIo;
  /** Make bringing a found terminal forward throw, as an editor that cannot show it would. */
  readonly revealThrows?: Error;
  /** Reset Session's delete port; absent means the host has none. */
  readonly deleteArtifacts?: NonNullable<ControllerPorts["deleteWorkItemArtifacts"]>;
  /** Handed every streaming run's event callback, so a test can deliver an event late. */
  readonly onStream?: (onEvent: (event: StreamEvent) => void) => void;
}

function harness(options: HarnessOptions = {}): Harness & { release: () => void } {
  const states: PanelState[] = [];
  const streamRuns: StreamRun[] = [];
  const jsonRuns: StreamRun[] = [];
  const written: { path: string; contents: string }[] = [];
  const opened: string[] = [];
  const clipboard: string[] = [];
  const notices: { kind: string; message: string }[] = [];
  const logged: string[] = [];
  const refreshes = { count: 0 };
  const confirms: { message: string; confirmLabel: string; keepLabel?: string }[] = [];
  const saved: FormState[] = [];
  const savedWorkItems: (string | undefined)[] = [];
  const ranCommands: string[] = [];
  const terminals: { name: string; cwd: string; commandLine: string }[] = [];
  const openTerminals: string[] = [];
  const revealed: string[] = [];
  const folders: string[] = [];
  const probed: string[] = [];
  const extensionCommands: string[] = [];
  const fixModeCalls = { count: 0 };
  const files: Record<string, string> = { ...(options.files ?? {}) };
  let release = () => {};

  const hintPrompts: string[] = [];
  const issueLookups: string[] = [];
  const ports: ControllerPorts = {
    runner: {
      runStreaming: async (args, runOptions, onEvent) => {
        streamRuns.push({ args, options: runOptions });
        options.onStream?.(onEvent);
        if (options.streamThrows) throw options.streamThrows;
        for (const event of options.events ?? []) onEvent(event);
        if (options.hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
            runOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return {
          result: {
            code: options.aborted ? null : 0,
            stdout: "",
            stderr: options.stderr ?? "",
            aborted: options.aborted ?? runOptions.signal?.aborted ?? false,
          },
          terminated: options.terminated ?? true,
          events: [...(options.events ?? [])],
          ...(options.foreignVersion === undefined ? {} : { foreignVersion: options.foreignVersion }),
        };
      },
      runJson: async (args, runOptions) => {
        jsonRuns.push({ args, options: runOptions });
        if (options.jsonThrows) throw options.jsonThrows;
        const json = options.json;
        if (!json) return { ok: true, command: "bug", warnings: [] };
        return typeof json === "function" ? json() : json;
      },
    },
    files: {
      listDirectory: async () =>
        options.directoryError
          ? { kind: "unreadable", detail: options.directoryError }
          : options.directory
            ? { kind: "ok", names: [...options.directory] }
            : { kind: "missing" },
      readFile: async (file) => {
        await options.onReadFile?.(file);
        const key = Object.keys(files).find((name) => file.endsWith(name));
        return key ? files[key] : undefined;
      },
      writeFile: async (file, contents) => {
        written.push({ path: file, contents });
      },
    },
    ui: {
      render: (state) => states.push(state),
      openFile: async (file) => {
        opened.push(file);
      },
      copyToClipboard: async (text) => {
        if (options.clipboardHold) await options.clipboardHold();
        if (options.clipboardThrows) throw options.clipboardThrows;
        clipboard.push(text);
      },
      confirm: async (message, confirmLabel, keepLabel) => {
        confirms.push({ message, confirmLabel, ...(keepLabel === undefined ? {} : { keepLabel }) });
        return options.confirmAnswer ? options.confirmAnswer() : (options.confirm ?? true);
      },
      notify: (kind, message) => notices.push({ kind, message }),
      refreshViews: () => {
        refreshes.count += 1;
      },
      editCredentials: async () => {
        notices.push({ kind: "info", message: "credentials prompt" });
      },
      runCommand: async (commandId) => {
        ranCommands.push(commandId);
      },
      runInTerminal: (name, cwd, commandLine) => {
        if (options.terminalThrows) throw options.terminalThrows;
        terminals.push({ name, cwd, commandLine });
        openTerminals.push(name);
      },
      revealTerminal: (matches) => {
        const name = [...openTerminals].reverse().find((candidate) => matches(candidate));
        if (name === undefined) return false;
        if (options.revealThrows) throw options.revealThrows;
        revealed.push(name);
        return true;
      },
      openFolder: async (directory) => {
        folders.push(directory);
      },
      pickFiles: async () => options.pickFiles ?? [],
    },
    log: {
      info: (message) => logged.push(message),
      error: (message) => logged.push(`ERROR ${message}`),
    },
    environment: async () =>
      (typeof options.environment === "function" ? options.environment() : options.environment) ?? READY,
    credentials: async () => {
      const broken = options.credentialsThrow?.();
      if (broken) throw broken;
      return {
      configured: options.credentialsConfigured ?? true,
      environment: { JIRA_EMAIL: "me@example.com", JIRA_TOKEN: TOKEN },
      };
    },
    descriptionFilePath: () => "/tmp/bugpilot-description.md",
    ...(options.extensionVersion === undefined
      ? {}
      : { extensionVersion: options.extensionVersion }),
    canRun: async (command) => {
      probed.push(command);
      if (options.agentProbe) return options.agentProbe(command);
      return options.agentOnPath ?? false;
    },
    ...(options.lastAgent === undefined ? {} : { lastAgent: options.lastAgent }),
    ...(options.storeAttachment === undefined ? {} : { storeAttachment: options.storeAttachment }),
    ...(options.extensions === undefined
      ? {}
      : {
          extensions: {
            get: (id: string) => options.extensions?.[id],
            executeCommand: async (command: string) => {
              extensionCommands.push(command);
              await options.executeExtensionCommand?.(command);
            },
          },
        }),
    now: () => 1_000,
    ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
    saveForm: (form) => saved.push(form),
    saveWorkItem: (workItemId) => savedWorkItems.push(workItemId),
    ...(options.deleteArtifacts === undefined ? {} : { deleteWorkItemArtifacts: options.deleteArtifacts }),
    ...(options.fixModes === undefined
      ? {}
      : {
          listFixModes: async () => {
            fixModeCalls.count += 1;
            return options.fixModes!;
          },
        }),
    ...(options.managed === undefined
      ? {}
      : { listManagedFixModes: async () => options.managed! }),
    ...(options.runFixMode === undefined ? {} : { runFixModeCommand: options.runFixMode }),
    ...(options.runReview === undefined ? {} : { runReviewCommand: options.runReview }),
    ...(options.runVerification === undefined ? {} : { runVerificationCommand: options.runVerification }),
    ...(options.runCaptured === undefined
      ? {}
      : {
          // A process that started, as the host's `spawn` event says — unless the
          // test is about the moment before that.
          runCapturedReview: async (request: Parameters<NonNullable<ControllerPorts["runCapturedReview"]>>[0]) => {
            if (options.capturedStarts !== false) request.onStarted?.();
            return options.runCaptured!(request);
          },
        }),
    ...(options.reviewedFixes === undefined ? {} : { reviewedFixes: options.reviewedFixes }),
    ...(options.watchArtifacts === undefined ? {} : { watchArtifacts: options.watchArtifacts }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    improveHint: async (request) => {
      hintPrompts.push(request.prompt);
      return options.improveHint
        ? options.improveHint(request)
        : { ok: true as const, text: "Improved hint." };
    },
    loadIssueDetails: async (issueKey) => {
      issueLookups.push(issueKey);
      if (options.issueDetailsThrows) throw options.issueDetailsThrows;
      return options.issueDetails;
    },
  };

  const controller = new Controller(ports, options.form ?? DEFAULT_FORM);
  return {
    controller,
    hintPrompts,
    issueLookups,
    folders,
    probed,
    extensionCommands,
    states,
    streamRuns,
    jsonRuns,
    written,
    opened,
    clipboard,
    notices,
    logged,
    refreshes,
    confirms,
    ranCommands,
    terminals,
    openTerminals,
    revealed,
    saved,
    savedWorkItems,
    fixModeCalls,
    files,
    last: () => {
      assert.ok(states.length > 0, "no state was rendered");
      return states[states.length - 1]!;
    },
    release: () => release(),
  };
}

const jiraForm = (overrides: Partial<FormState> = {}): FormState => ({
  ...DEFAULT_FORM,
  issueKey: "JR-12345",
  ...overrides,
});

/**
 * A whole prepare, every marker step in `WORKFLOW_STEPS` order.
 *
 * Complete on purpose since Batch 6: a row reports its result only once its own
 * step finished, so a fixture that skipped Build context's steps would describe
 * a run whose context appeared from nowhere.
 */
const successfulRun: readonly StreamEvent[] = [
  { type: "started", work_item_id: "JR-12345", source: "jira" },
  { type: "step_started", step: "fetch" },
  { type: "step_completed", step: "fetch" },
  { type: "step_started", step: "parse" },
  { type: "step_completed", step: "parse" },
  { type: "step_started", step: "memory_search" },
  { type: "step_completed", step: "memory_search" },
  { type: "step_started", step: "code_search" },
  { type: "step_completed", step: "code_search" },
  { type: "step_started", step: "git_context" },
  { type: "step_completed", step: "git_context" },
  { type: "step_started", step: "context" },
  { type: "step_completed", step: "context" },
  { type: "step_started", step: "prompt" },
  { type: "step_completed", step: "prompt" },
  { type: "artifact", path: ".ai/JR-12345/task.md" },
  { type: "completed", ok: true },
];

/** The `run.json` a finished prepare leaves, for work items reopened from History. */
const PREPARED_RUN_JSON = JSON.stringify({
  schema_version: 1,
  work_item_id: "JR-12345",
  status: "prepared",
  steps: {
    doctor: "pass",
    fetch: "pass",
    parse: "pass",
    keywords: "pass",
    memory_search: "pass",
    code_search: "pass",
    git_context: "pass",
    context: "pass",
    prompt: "pass",
    memory_add: "pass",
    agent_fix: "skipped",
  },
  generated_files: [],
});

// --- running ---------------------------------------------------------------

test("a valid run streams, finishes, and refreshes what the editor shows", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md", "context.md"] });
  await h.controller.refreshEnvironment();
  const refreshesBefore = h.refreshes.count;
  await h.controller.run(jiraForm());

  assert.equal(h.streamRuns.length, 1);
  assert.deepEqual(h.streamRuns[0]!.args.slice(0, 2), ["bug", "JR-12345"]);
  assert.equal(h.streamRuns[0]!.options.cwd, ROOT);
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().artifacts.kind, "ready");
  assert.equal(h.refreshes.count - refreshesBefore, 1, "the trees must be re-read after a run changes .ai/");
  assert.equal(h.last().primary.action, "fixWithAI", "a prepared task is the next thing to hand over");
});

test("the Jira token travels in the environment and never in argv or the panel", async () => {
  // The two places a credential must never appear: a command line any process
  // can list, and a webview.
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.streamRuns[0]!.options.env?.["JIRA_TOKEN"], TOKEN);
  assert.equal(
    h.streamRuns[0]!.args.some((arg) => arg.includes(TOKEN)),
    false,
  );
  assert.equal(JSON.stringify(h.states).includes(TOKEN), false);
  assert.equal(
    h.logged.some((line) => line.includes(TOKEN)),
    false,
    "the log must not carry the token either",
  );
});

test("an invalid form is rendered as field problems and spawns nothing", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ issueKey: "not a key" }));

  assert.equal(h.streamRuns.length, 0);
  assert.deepEqual(
    h.last().problems.map((problem) => problem.field),
    ["issueKey"],
  );
  assert.equal(h.last().progress.state, "idle");
});

test("a hand-written bug learns its work item id from the stream", async () => {
  // The id is minted by the CLI (`local_<timestamp>`), so there is nowhere else
  // to get it — and without it no artifact can be opened afterwards.
  const h = harness({
    events: [
      { type: "started", work_item_id: "local_20260904160612", source: "manual" },
      { type: "completed", ok: true },
    ],
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ source: "manual", description: "crash on save", issueKey: "" }));

  assert.equal(h.controller.workItemId, "local_20260904160612");
  assert.equal(h.last().workItemId, "local_20260904160612");
});

test("a long description is written to a file before the process starts", async () => {
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(
    jiraForm({ source: "manual", issueKey: "", description: "x".repeat(5_000) }),
  );

  assert.deepEqual(
    h.written.map((file) => file.path),
    ["/tmp/bugpilot-description.md"],
  );
  assert.ok(
    h.streamRuns[0]!.args.some((arg) => arg.startsWith("--description-file=")),
    "the flag carries its value with =, so argparse cannot mistake it for an option",
  );
});

test("Stop aborts the run and reports it as stopped, not failed", async () => {
  const h = harness({
    hold: true,
    terminated: false,
    aborted: true,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "code_search" },
    ],
  });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await Promise.resolve();
  h.controller.stop();
  await running;

  assert.equal(h.last().progress.state, "stopped");
  assert.equal(h.last().progress.failure, undefined, "pressing Stop is not an error");
});

test("a stream with no terminal event is reported as a failure, with stderr logged", async () => {
  const h = harness({
    terminated: false,
    stderr: "Traceback (most recent call last): ...",
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "code_search" },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.last().progress.state, "failed");
  assert.match(h.last().progress.failure?.summary ?? "", /stopped before finishing/);
  assert.ok(h.logged.some((line) => line.includes("Traceback")));
});

test("a newer event contract asks for an extension update", async () => {
  const h = harness({ foreignVersion: 2, terminated: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.match(h.last().progress.failure?.action ?? "", /Update the BugPilot extension/);
});

test("a spawn failure notifies and leaves the panel usable", async () => {
  const h = harness({ streamThrows: new Error("spawn ENOENT") });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.last().progress.state, "failed");
  assert.ok(h.notices.some((notice) => notice.kind === "error"));
  // Not stuck: a second Run must be possible.
  await h.controller.run(jiraForm());
  assert.equal(h.streamRuns.length, 2);
});

test("a second Run while one is in flight is ignored", async () => {
  const h = harness({ hold: true, events: successfulRun });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await Promise.resolve();
  await h.controller.run(jiraForm());
  h.release();
  await running;

  assert.equal(h.streamRuns.length, 1);
});

test("a fresh run is confirmed first, and declining spawns nothing", async () => {
  // --fresh deletes an agent's results. Phase 3 lost a fix_summary.md that way.
  const h = harness({ confirm: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ fresh: true }));
  assert.equal(h.streamRuns.length, 0);

  const yes = harness({ confirm: true, events: successfulRun });
  await yes.controller.refreshEnvironment();
  await yes.controller.run(jiraForm({ fresh: true }));
  assert.ok(yes.streamRuns[0]!.args.includes("--fresh"));
});

test("an unusable CLI is re-checked on Run before refusing", async () => {
  // The developer may have installed bugpilot since the panel was opened;
  // refusing on stale state would be infuriating and hard to understand.
  let environment: Environment = {
    kind: "unusable-cli",
    root: ROOT,
    verdict: { kind: "not-found", executable: "bugpilot", detail: "not on PATH" },
    summary: "bugpilot is not on PATH.",
    action: "Install it.",
    actions: [{ title: "Install Instructions", command: "bugpilot.showInstallInstructions" }],
  };
  const states: PanelState[] = [];
  const controller = new Controller({
    runner: {
      runStreaming: async () => {
        throw new Error("should not run");
      },
      runJson: async () => ({ ok: true, command: "bug", warnings: [] }),
    },
    files: {
      listDirectory: async () => ({ kind: "missing" }),
      readFile: async () => undefined,
      writeFile: async () => {},
    },
    ui: {
      render: (state) => states.push(state),
      openFile: async () => {},
      copyToClipboard: async () => {},
      confirm: async () => true,
      notify: () => {},
      refreshViews: () => {},
      editCredentials: async () => {},
      runCommand: async () => {},
      runInTerminal: () => {},
      revealTerminal: () => false,
      openFolder: async () => {},
      pickFiles: async () => [],
    },
    log: { info: () => {}, error: () => {} },
    environment: async () => environment,
    credentials: async () => ({ configured: false, environment: {} }),
    descriptionFilePath: () => "/tmp/d.md",
  });

  await controller.refreshEnvironment();
  const blocked = states[states.length - 1]!.readiness;
  assert.equal(blocked.kind, "blocked");
  if (blocked.kind === "blocked") {
    assert.deepEqual(
      blocked.actions.map((action) => action.command),
      ["bugpilot.showInstallInstructions"],
    );
  }

  environment = READY;
  // Run re-resolves and then proceeds, which here means reaching the runner.
  await assert.doesNotReject(controller.run(jiraForm()));
});

// --- the retry loop --------------------------------------------------------

test("the first Retry opens the feedback template and stops there", async () => {
  // Handing an agent a file of placeholders would defeat the only purpose of
  // this loop: carrying the developer's account of what went wrong (§5.6).
  const h = harness({
    events: successfulRun,
    json: { ok: true, command: "bug", warnings: [], retry: true, feedback_created: true },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.retry();

  assert.deepEqual(h.jsonRuns[0]!.args, ["bug", "JR-12345", "--retry", "--prepare-only", "--json"]);
  assert.ok(h.opened.some((file) => file.endsWith("user_feedback.md")));
  assert.match(h.notices.at(-1)?.message ?? "", /Describe what the previous attempt got wrong/);
});

test("the second Retry reports the package as ready", async () => {
  const h = harness({
    events: successfulRun,
    json: { ok: true, command: "bug", warnings: [], retry: true, feedback_created: false },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.retry();

  assert.match(h.notices.at(-1)?.message ?? "", /agent_retry_prompt\.md/);
});

test("a retry failure is explained through the code table", async () => {
  const h = harness({
    events: successfulRun,
    json: {
      ok: false,
      command: "bug",
      error: { code: "WORK_ITEM_NOT_FOUND", message: "no such work item" },
    },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.retry();

  const notice = h.notices.at(-1)!;
  assert.equal(notice.kind, "error");
  assert.notEqual(notice.message, "no such work item");
  assert.equal(h.opened.length, 0, "nothing is opened when the retry did not happen");
});

test("Retry does nothing without a prepared work item", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.retry();
  assert.equal(h.jsonRuns.length, 0);
});

// --- artifacts and handoff -------------------------------------------------

test("opening an artifact resolves inside the work item directory", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.openArtifact("task.md");

  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0]!, /JR-12345[\\/]task\.md$/);
});

test("a traversal attempt is refused at the point of opening, too", async () => {
  // The message parser already refuses these, but the tree views reach this
  // method as well, and this is the call that actually opens a path.
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  for (const name of ["../../etc/passwd", "sub/file.md", ".."]) {
    await h.controller.openArtifact(name);
  }
  assert.equal(h.opened.length, 0);
  assert.ok(h.logged.some((line) => line.startsWith("ERROR Refusing")));
});

test("opening an artifact before any run explains itself instead of failing", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.openArtifact("task.md");
  assert.equal(h.opened.length, 0);
  assert.equal(h.notices.at(-1)?.kind, "warning");
});

test("the handoff prompt is the one sentence pointing at task.md, whatever else is on disk", async () => {
  // No agent_handoff.md is read, even when an old one is lying in the directory:
  // everything the agent needs is in task.md, and the sentence names it.
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "agent_handoff.md"],
    files: { "agent_handoff.md": "Read .ai/JR-12345/agent_task.md and fix the bug.\n" },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.copyHandoff();

  assert.equal(h.clipboard[0], "Read .ai/JR-12345/task.md and complete the workflow.");
});

// --- reopening a past work item -------------------------------------------

test("a past work item is restored from run.json", async () => {
  const h = harness({
    files: {
      "run.json": JSON.stringify({
        steps: { parse: "pass", code_search: "pass", git_context: "skipped" },
      }),
    },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-999");

  assert.equal(h.last().workItemId, "JR-999");
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().artifacts.kind, "ready");
});

test("a corrupt status file still lists the artifacts", async () => {
  const h = harness({
    files: { "run.json": "{ truncated" },
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-999");

  assert.equal(h.last().progress.state, "idle");
  assert.equal(h.last().artifacts.kind, "ready");
});

// --- messages from the panel ----------------------------------------------

test("a form change is persisted without starting anything", async () => {
  // What the developer typed has to survive a window reload even if they never
  // press Run, and typing must never spawn a process.
  const h = harness();
  await h.controller.handle({ type: "formChanged", form: jiraForm({ hint: "look here" }) });

  assert.equal(h.streamRuns.length, 0);
  assert.deepEqual(
    h.saved.map((form) => form.hint),
    ["look here"],
  );
});

test("a run persists the form it actually ran", async () => {
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ keywords: "save, crash" }));
  assert.deepEqual(
    h.saved.map((form) => form.keywords),
    ["save, crash"],
  );
});

test("the ready message re-pushes state so a reloaded page catches up", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  const before = h.states.length;
  await h.controller.handle({ type: "ready" });
  assert.equal(h.states.length, before + 1);
  assert.ok(h.last().revision > 0);
});

test("the credentials action is delegated to the host, not handled here", async () => {
  // SecretStorage lives in the host; the controller must not learn the token.
  const h = harness();
  await h.controller.handle({ type: "action", id: "setCredentials" });
  assert.equal(h.notices.at(-1)?.message, "credentials prompt");
});


test("an unreadable .ai/ directory is reported, not shown as empty", async () => {
  // §5.4 asks for this state explicitly. Returning an empty list for a
  // permission problem tells the developer their run produced nothing, which
  // sends them looking in the wrong place entirely.
  const h = harness({ events: successfulRun, directoryError: "EACCES: permission denied" });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const artifacts = h.last().artifacts;
  assert.equal(artifacts.kind, "error");
  assert.match(artifacts.kind === "error" ? artifacts.detail : "", /permission denied/);
});

test("the artifact list reports itself as loading while the directory is read", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  // A "loading" state must have been pushed before the final one; on a network
  // share the read is not instant and an empty list would look like a failure.
  assert.ok(
    h.states.some((state) => state.artifacts.kind === "loading"),
    "no loading state was ever rendered",
  );
  assert.equal(h.last().artifacts.kind, "ready");
});


test("the work item is remembered, so a restart can restore its progress", async () => {
  // The event stream dies with the process; run.json is the only
  // record that survives it, and reading that needs the id.
  const h = harness({
    events: [
      { type: "started", work_item_id: "local_20260904160612", source: "manual" },
      { type: "completed", ok: true },
    ],
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ source: "manual", issueKey: "", description: "crash" }));

  assert.ok(h.savedWorkItems.includes("local_20260904160612"));
});

test("readiness starts as checking, not as blocked", async () => {
  // Before the handshake answers there is nothing wrong; a warning card would
  // say there was, and a ready state would enable a Run that cannot work.
  const h = harness();
  await h.controller.handle({ type: "ready" });
  assert.equal(h.last().readiness.kind, "checking");
});

// --- review follow-ups -----------------------------------------------------

test("a command from outside the editor's own vocabulary is refused", async () => {
  // The id round-trips through the page, so it is untrusted on the way back.
  // Executing an arbitrary editor command on a webview's word — say
  // workbench.action.terminal.new — is a privilege it must not have.
  // (That the *offered* buttons work is covered by "only a command the host
  // actually offered can be run" below, which also pins down the narrower
  // allowlist this replaced.)
  const h = harness();
  await h.controller.handle({ type: "command", id: "workbench.action.quit" });
  assert.deepEqual(h.ranCommands, []);
  assert.ok(h.logged.some((line) => line.includes("Refusing to run a command")));
});

test("refreshing artifacts on its own leaves the panel showing the result", async () => {
  // refreshArtifacts pushes a loading state first. When it is invoked as its
  // own command, nothing else pushes afterwards, so the panel would sit on
  // "Scanning .ai/ …" forever.
  const h = harness({ events: successfulRun, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.refreshArtifacts();

  assert.equal(h.last().artifacts.kind, "ready");
});

test("an environment refresh does not overwrite what is being typed", async () => {
  // Bumping the revision makes the page rewrite every field from the host's
  // copy, moving the caret and discarding anything typed inside the 400ms
  // debounce. Credential changes and every Run call this.
  const h = harness();
  await h.controller.handle({ type: "ready" });
  const afterReady = h.last().revision;

  await h.controller.refreshEnvironment();
  assert.equal(h.last().revision, afterReady, "the form must not be replaced by a refresh");
});

test("Fix with AI is the primary action only when there is a package to hand over", async () => {
  // A run that was stopped before producing a task has nothing to hand over:
  // the button stays Run. (It was Retry's rule too, while Retry had a button:
  // `bug --retry` reads the prepared artifacts.)
  const stopped = harness({
    hold: true,
    terminated: false,
    aborted: true,
    events: [{ type: "started", work_item_id: "JR-12345", source: "jira" }],
    directory: [],
  });
  await stopped.controller.refreshEnvironment();
  const running = stopped.controller.run(jiraForm());
  await Promise.resolve();
  stopped.controller.stop();
  await running;
  assert.equal(stopped.last().primary.action, "run");
  assert.deepEqual(stopped.last().primary.more, []);

  const finished = harness({ events: successfulRun, directory: ["task.md"] });
  await finished.controller.refreshEnvironment();
  await finished.controller.run(jiraForm());
  assert.equal(finished.last().primary.action, "fixWithAI");
});

test("starting a hand-written run drops the previous item's artifact list", async () => {
  // The new id only arrives with the `started` event. Leaving the old list on
  // screen offers files that openArtifact then refuses to open.
  const h = harness({ hold: true, events: [], directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-999");
  assert.equal(h.last().artifacts.kind, "ready");

  const running = h.controller.run(
    jiraForm({ source: "manual", issueKey: "", description: "crash" }),
  );
  await Promise.resolve();
  assert.notEqual(h.last().artifacts.kind, "ready");
  assert.equal(h.last().workItemId, undefined);
  h.release();
  await running;
});

// --- second review round ---------------------------------------------------

test("only a command the host actually offered can be run", async () => {
  // Validating against the whole COMMANDS table would also accept
  // bugpilot.clean and bugpilot.clearCredentials, which the page is never
  // offered and has no business asking for.
  const h = harness({
    environment: {
      kind: "unusable-cli",
      root: ROOT,
      verdict: { kind: "not-found", executable: "bugpilot", detail: "not on PATH" },
      summary: "bugpilot is not on PATH.",
      action: "Install it.",
      actions: [{ title: "Install Instructions", command: "bugpilot.showInstallInstructions" }],
    },
  });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "command", id: "bugpilot.showInstallInstructions" });
  assert.deepEqual(h.ranCommands, ["bugpilot.showInstallInstructions"]);

  // A real command of this extension — but not one that was offered.
  await h.controller.handle({ type: "command", id: "bugpilot.clean" });
  assert.deepEqual(h.ranCommands, ["bugpilot.showInstallInstructions"]);
  assert.ok(h.logged.some((line) => line.includes("Refusing to run a command")));
});

test("nothing is offered while the environment is fine", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "command", id: "bugpilot.doctor" });
  assert.deepEqual(h.ranCommands, []);
});

test("the second Retry opens the package it tells you to hand off", async () => {
  // Naming agent_retry_prompt.md in the message while opening user_feedback.md
  // sends the developer looking for a file that never appeared.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    json: { ok: true, command: "bug", warnings: [], retry: true, feedback_created: false },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.retry();

  assert.ok(h.opened.at(-1)?.endsWith("agent_retry_prompt.md"), h.opened.at(-1));
});

test("clicking a history item during a run says why nothing happened", async () => {
  const h = harness({ hold: true, events: successfulRun, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await Promise.resolve();

  await h.controller.showWorkItem("JR-999");
  assert.equal(h.last().workItemId, "JR-12345", "the run keeps the panel");
  assert.equal(h.notices.at(-1)?.kind, "warning");
  assert.match(h.notices.at(-1)?.message ?? "", /run is in progress/);

  h.release();
  await running;
});

test("a timeout is reported as a timeout, not as a cancel", async () => {
  // The Runner reports `aborted` for both a Stop and a timeout. Calling the
  // latter "stopped" tells the developer they clicked something they did not,
  // and hides a run that is genuinely too slow for this repository.
  const h = harness({
    // A killed run leaves no terminal event, which is how the reader reports it.
    terminated: false,
    aborted: true,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "code_search" },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.last().progress.state, "failed");
  assert.equal(h.last().progress.failure?.code, "TIMEOUT");
  assert.match(h.last().progress.failure?.action ?? "", /Narrow the search/);
});

test("a Stop is still a Stop, not a timeout", async () => {
  const h = harness({
    hold: true,
    aborted: true,
    terminated: false,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "code_search" },
    ],
  });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await Promise.resolve();
  h.controller.stop();
  await running;

  assert.equal(h.last().progress.state, "stopped");
  assert.equal(h.last().progress.failure, undefined);
});

test("a second run after a Stop is not still marked as stopped by the user", async () => {
  // The flag has to reset, or a later timeout inherits the previous Stop.
  const h = harness({
    hold: true,
    aborted: true,
    terminated: false,
    events: [{ type: "started", work_item_id: "JR-12345", source: "jira" }],
  });
  await h.controller.refreshEnvironment();
  const first = h.controller.run(jiraForm());
  await Promise.resolve();
  h.controller.stop();
  await first;

  const second = h.controller.run(jiraForm());
  await Promise.resolve();
  h.release();
  await second;
  assert.equal(h.last().progress.failure?.code, "TIMEOUT");
});

test("overlapping environment refreshes share one probe", async () => {
  // The probe spawns `doctor --json`, and a folder change, a configuration
  // change and activation can all ask within milliseconds. A frozen executable
  // takes seconds to answer, so a queue of identical processes is both slow and
  // pointless.
  let probes = 0;
  const controller = new Controller({
    runner: {
      runStreaming: async () => {
        throw new Error("not used");
      },
      runJson: async () => ({ ok: true, command: "doctor", warnings: [] }),
    },
    files: {
      listDirectory: async () => ({ kind: "missing" }),
      readFile: async () => undefined,
      writeFile: async () => {},
    },
    ui: {
      render: () => {},
      openFile: async () => {},
      copyToClipboard: async () => {},
      confirm: async () => true,
      notify: () => {},
      refreshViews: () => {},
      editCredentials: async () => {},
      runCommand: async () => {},
      runInTerminal: () => {},
      revealTerminal: () => false,
      openFolder: async () => {},
      pickFiles: async () => [],
    },
    log: { info: () => {}, error: () => {} },
    environment: async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return READY;
    },
    credentials: async () => ({ configured: false, environment: {} }),
    descriptionFilePath: () => "/tmp/d.md",
  });

  await Promise.all([
    controller.refreshEnvironment(),
    controller.refreshEnvironment(),
    controller.refreshEnvironment(),
  ]);
  assert.equal(probes, 1);

  // A later refresh is a new question and does run.
  await controller.refreshEnvironment();
  assert.equal(probes, 2);
});

test("the handoff fallback matches the sentence bugpilot itself uses", () => {
  // Four places tell an agent to read task.md: the CLI's launch prompt,
  // the MCP prompt, the Claude Code skill, and this fallback. The first three
  // are rendered from bugpilot/core/handoff.py; this one is a TypeScript
  // string, so it is compared against that source the same way the error-code
  // table is.
  const source = readFileSync(new URL("../../bugpilot/core/handoff.py", import.meta.url), "utf8");
  const template = /return f"(Read \.ai\/\{issue_key\}\/[^"]+)"/.exec(source);
  assert.ok(template, "could not find handoff_prompt's text in handoff.py");
  // The file name is a constant in artifacts.py, so it is resolved from there.
  const artifacts = readFileSync(new URL("../../bugpilot/core/artifacts.py", import.meta.url), "utf8");
  const task = /^TASK_ARTIFACT = "([^"]+)"/m.exec(artifacts);
  assert.ok(task, "could not find TASK_ARTIFACT in artifacts.py");
  const expected = template[1]!.replace("{issue_key}", "JR-12345").replace("{TASK_ARTIFACT}", task[1]!);

  const h = harness({ events: successfulRun, directory: ["task.md"] });
  return h.controller
    .refreshEnvironment()
    .then(() => h.controller.run(jiraForm()))
    .then(() => h.controller.copyHandoff())
    .then(() => {
      assert.equal(h.clipboard[0], expected);
    });
});


test("the doctor report becomes a warning the panel can show", async () => {
  // The report has been carried into the controller since phase 5 and used for
  // nothing. `docs/safety.md` forbids the agent from committing .ai/; nothing
  // stopped a developer, and one of those files holds fetched Jira content.
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { python_ok: true, ai_artifacts_ignored: false },
    },
  });
  await h.controller.refreshEnvironment();
  assert.equal(h.last().warnings.length, 1);
  // Titled, because the panel shows one card per notice and there is more than
  // one subject: this one is about files in the repository.
  assert.equal(h.last().warnings[0]!.title, "Repository Files");
  assert.match(h.last().warnings[0]!.message, /\.gitignore/);
});

test("a repository that already ignores the artifacts is not nagged", async () => {
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { python_ok: true, ai_artifacts_ignored: true },
    },
  });
  await h.controller.refreshEnvironment();
  assert.deepEqual(h.last().warnings, []);
});

test("an unknown answer is not a warning", async () => {
  // `null` means the question could not be answered — no git, or not a
  // checkout. Warning about it would be noise in exactly the case where the
  // advice does not apply.
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { ai_artifacts_ignored: null },
    },
  });
  await h.controller.refreshEnvironment();
  assert.deepEqual(h.last().warnings, []);
});

test("a missing Jira site is said out loud, not discovered at the fetch step", async () => {
  // The CLI no longer ships a default site — one company's tenant must not be
  // every installer's default — so credentials set in this panel are no longer
  // enough on their own.
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { python_ok: true, jira_base_url_present: false, ai_artifacts_ignored: true },
    },
  });
  await h.controller.refreshEnvironment();
  assert.equal(h.last().warnings.length, 1);
  // Its own title: joining the notices into one paragraph filed a Jira
  // misconfiguration under a heading about repository files.
  assert.equal(h.last().warnings[0]!.title, "Jira Site");
  assert.match(h.last().warnings[0]!.message, /JIRA_BASE_URL/);
  // And it says what a developer can do instead, since one of the two input
  // sources needs no Jira at all.
  assert.match(h.last().warnings[0]!.message, /describe by hand/);
});

test("a configured Jira site is not mentioned", async () => {
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { python_ok: true, jira_base_url_present: true, ai_artifacts_ignored: true },
    },
  });
  await h.controller.refreshEnvironment();
  assert.deepEqual(h.last().warnings, []);
});

// --- the AI step ------------------------------------------------------------

/** A form with the last workflow row ticked. */
const withFix = (overrides: Partial<FormState> = {}): FormState => ({
  ...jiraForm(),
  fixWithAI: true,
  ...overrides,
});

test("Fix with AI starts the agent in the repository root", async () => {
  // task.md insists on this: "Do not run your AI agent from the bugpilot
  // tool source directory". The cwd is the whole point of the terminal.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.fixWithAI();

  assert.equal(h.terminals.length, 1);
  const terminal = h.terminals[0]!;
  assert.equal(terminal.cwd, ROOT);
  assert.match(terminal.name, /JR-12345/);
  // One argument, quoted: the handoff contains spaces and a path.
  assert.equal(
    terminal.commandLine,
    'claude "Read .ai/JR-12345/task.md and complete the workflow."',
  );
});

test("ticking Fix with AI runs it as the last step, without a second click", async () => {
  // The whole point of the row: Run means run everything that is ticked.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(withFix());

  assert.equal(h.terminals.length, 1);
  const fix = h.last().workflow.find((step) => step.id === "fixWithAI");
  assert.equal(fix?.status, "success");
  assert.match(fix?.detail ?? "", /Handed to Claude CLI in a terminal/);
  assert.equal(h.last().overall.text, "AI fix started");
});

test("leaving it unticked stops after the context is built", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.deepEqual(h.terminals, [], "no agent may start without being asked for");
  // And nothing was even probed: asking "is claude installed" when the answer
  // cannot be used is a spawn for nothing.
  assert.deepEqual(h.probed, []);
  assert.equal(h.last().overall.text, "Ready");
  // Ready to press, and not the green tick: nothing was handed over.
  assert.equal(h.last().workflow.find((step) => step.id === "fixWithAI")?.status, "ready");
});

test("a run that failed hands nothing over, and says why the step did not run", async () => {
  // The prompt names artifacts a failed run never wrote; handing it over sends
  // an agent looking for a file that does not exist.
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(withFix());

  assert.deepEqual(h.terminals, []);
  const fix = h.last().workflow.find((step) => step.id === "fixWithAI");
  assert.equal(fix?.status, "skipped");
  // The reason is the row's line: it is the whole of what happened.
  assert.match(fix?.summary ?? "", /did not finish/);
});

test("a page that still says Build context off cannot turn it off (§37.107)", async () => {
  // Build context had a box, and unticking it ran --only-issue-details and
  // dropped the AI step with it. It always runs now: a page restored from
  // before that sends `buildContext: false` still builds the package, and the
  // ticked AI step still hands it over.
  const h = harness({ events: successfulRun, directory: ["task.md"], agentOnPath: true });
  await h.controller.refreshEnvironment();
  const message = parsePanelMessage({
    type: "run",
    form: { ...withFix(), plan: { ...DEFAULT_FORM.plan, buildContext: false } },
  });
  assert.ok(message && message.type === "run");
  assert.equal(message.form.plan.buildContext, true);
  await h.controller.handle(message);

  assert.equal(h.streamRuns[0]!.args.includes("--only-issue-details"), false);
  assert.equal(h.terminals.length, 1, "the ticked AI step did not hand over");
  const rows = h.last().workflow;
  assert.equal(rows.find((step) => step.id === "buildContext")?.enabled, true);
  assert.equal(rows.find((step) => step.id === "buildContext")?.required, true);
  assert.equal(rows.find((step) => step.id === "fixWithAI")?.enabled, true);
});

test("without any agent it copies the prompt instead, and brings no agent's panel forward", async () => {
  // A terminal printing "command not found" reads as our bug, not a missing
  // tool, so the fallback never opens one.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: false,
    extensions: {},
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.fixWithAI();

  assert.deepEqual(h.terminals, []);
  assert.match(h.clipboard[0] ?? "", /task\.md/);
  assert.match(h.notices.at(-1)?.message ?? "", /clipboard/);
  const fix = h.last().workflow.find((step) => step.id === "fixWithAI");
  // The agent did not start, so the row is failed and carries the card that
  // says what to do; the detail line still says which route the prompt took.
  assert.equal(fix?.status, "failed");
  assert.equal(fix?.summary, "Did not start");
  assert.equal(fix?.error?.title, "AI agent unavailable");
  assert.match(fix?.detail ?? "", /No supported AI agent detected/);
  assert.match(fix?.detail ?? "", /clipboard/);
  assert.deepEqual(h.extensionCommands, []);
});

test("a custom agent command is used verbatim, with the prompt substituted", async () => {
  // The escape hatch for Codex, Gemini or an in-house CLI: nobody here knows
  // their flags, and a guessed command line fails in a terminal.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(
    withFix({ agent: "custom", agentCommand: "my-agent --yolo --prompt {prompt}" }),
  );

  assert.equal(
    h.terminals[0]!.commandLine,
    'my-agent --yolo --prompt "Read .ai/JR-12345/task.md and complete the workflow."',
  );
  // Probed by its own first word, not by "claude".
  assert.deepEqual(h.probed, ["my-agent"]);
});

test("a custom choice with no command explains itself instead of running nothing", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md"], agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(withFix({ agent: "custom", agentCommand: "   " }));

  assert.deepEqual(h.terminals, []);
  assert.match(
    h.last().workflow.find((step) => step.id === "fixWithAI")?.detail ?? "",
    /No custom agent command is set/,
  );
});

test("Fix with AI before any run explains itself instead of doing nothing", async () => {
  const h = harness({ agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.fixWithAI();

  assert.deepEqual(h.terminals, []);
  assert.equal(h.notices.at(-1)?.kind, "warning");
  assert.match(h.notices.at(-1)?.message ?? "", /Prepare a bug first/);
});

test("the handed-over sentence is the same one Copy Handoff Prompt puts on the clipboard", async () => {
  // Four entry points say this; a fifth wording would be a fifth thing to drift.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.copyHandoff();
  await h.controller.fixWithAI();

  assert.equal(h.terminals[0]!.commandLine, `claude ${JSON.stringify(h.clipboard[0])}`);
});

test("Fix with AI refuses a package with no task.md rather than sending an agent after it", async () => {
  // --only-issue-details writes a context and no task — the CLI's flag still,
  // and a work item the panel prepared with it before §37.107 still exists. A
  // prompt naming a missing file would send the agent looking for it.
  const h = harness({ events: successfulRun, directory: ["context.md"], agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.fixWithAI();

  assert.deepEqual(h.terminals, []);
  assert.equal(h.notices.at(-1)?.kind, "warning");
  assert.match(h.notices.at(-1)?.message ?? "", /task\.md/);
  const row = h.last().workflow.find((step) => step.id === "fixWithAI");
  assert.equal(row?.status, "skipped");
  assert.match(row?.summary ?? "", /No task\.md was prepared/);
});

test("the old context and task files do not make a package", async () => {
  // No fallback: a directory holding only bug_context.md and agent_task.md has
  // no context and no task under the current contract.
  const h = harness({
    events: successfulRun,
    directory: ["bug_context.md", "agent_task.md", "agent_handoff.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(reportsContext(h.last()), false);
  // Nothing for Build context to act on; the folder is the work item's.
  assert.deepEqual(h.last().workflow.find((step) => step.id === "buildContext")?.actions, []);
  assert.deepEqual([...h.last().workItemActions], ["openFolder"]);
  await h.controller.fixWithAI();
  assert.deepEqual(h.terminals, []);
});

test("Copy puts context.md itself on the clipboard", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md"],
    files: { "context.md": "# Bug Context: JR-12345\n\n## Issue\n" },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "copyContext" });

  assert.equal(h.clipboard.at(-1), "# Bug Context: JR-12345\n\n## Issue\n");
  assert.equal(h.notices.at(-1)?.kind, "info");
});

test("Copy with no context.md on disk says so instead of copying nothing", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md", "context.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.copyContext();

  assert.deepEqual(h.clipboard, []);
  assert.equal(h.notices.at(-1)?.kind, "warning");
});

// --- the row actions --------------------------------------------------------

test("the Build context icons open the context, copy it and reveal the folder", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md"],
    files: { "context.md": "# Bug Context\n" },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "openContext" });
  assert.match(h.opened.at(-1) ?? "", /context\.md$/);

  await h.controller.handle({ type: "action", id: "copyContext" });
  assert.equal(h.clipboard.at(-1), "# Bug Context\n");

  await h.controller.handle({ type: "action", id: "openFolder" });
  assert.match(h.folders.at(-1) ?? "", /JR-12345$/);
});

test("the icons are offered only once the files they open exist", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md"],
  });
  await h.controller.refreshEnvironment();
  assert.deepEqual(
    h.last().workflow.find((step) => step.id === "buildContext")?.actions,
    [],
    "nothing has been built yet",
  );

  await h.controller.run(jiraForm());
  assert.deepEqual(h.last().workflow.find((step) => step.id === "buildContext")?.actions, [
    "openContext",
    "copyContext",
  ]);
  assert.deepEqual([...h.last().workItemActions], ["openFolder"]);
});

test("opening the folder before a run explains itself", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.openArtifactsFolder();

  assert.deepEqual(h.folders, []);
  assert.equal(h.notices.at(-1)?.kind, "warning");
});

test("two notices about two subjects stay two notices", async () => {
  // The regression this guards: they used to be joined with a space, which put
  // "no Jira site" under a heading about repository files.
  const h = harness({
    environment: {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { jira_base_url_present: false, ai_artifacts_ignored: false },
    },
  });
  await h.controller.refreshEnvironment();

  assert.deepEqual(
    h.last().warnings.map((notice) => notice.title),
    ["Jira Site", "Repository Files"],
  );
  for (const notice of h.last().warnings) {
    assert.notEqual(notice.title.trim(), "");
    assert.notEqual(notice.message.trim(), "");
  }
});

// --- attachments ------------------------------------------------------------

test("picked files are appended to the form the page sent", async () => {
  // The page's form, not the host's: the host's copy can be a debounce
  // interval stale, and merging onto it would discard whatever was typed in
  // that window.
  const h = harness({ pickFiles: ["/logs/crash.log"] });
  await h.controller.refreshEnvironment();
  await h.controller.handle({
    type: "addAttachments",
    form: { ...jiraForm(), hint: "typed a moment ago", attachments: ["/logs/old.log"] },
  });

  const pushed = h.last().form;
  assert.deepEqual(pushed?.attachments, ["/logs/old.log", "/logs/crash.log"]);
  assert.equal(pushed?.hint, "typed a moment ago", "the host stomped on unsent input");
});

test("the same file picked twice is attached once", async () => {
  const h = harness({ pickFiles: ["/logs/crash.log"] });
  await h.controller.refreshEnvironment();
  await h.controller.handle({
    type: "addAttachments",
    form: { ...jiraForm(), attachments: ["/logs/crash.log"] },
  });

  assert.deepEqual(h.last().form?.attachments, ["/logs/crash.log"]);
});

test("cancelling the dialog changes nothing, not even the revision", async () => {
  // A revision bump rewrites every field in the page from the host's copy.
  // Doing that because somebody pressed Escape would move the caret and
  // discard a debounce window's typing for no reason at all.
  const h = harness({ pickFiles: [] });
  await h.controller.refreshEnvironment();
  const before = h.last().revision;
  await h.controller.handle({ type: "addAttachments", form: jiraForm() });

  assert.equal(h.last().revision, before);
});

test("attachments reach the command line, and nothing else does", async () => {
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run({ ...jiraForm(), attachments: ["/logs/crash.log", "/shots/a.png"] });

  const args = h.streamRuns[0]!.args;
  assert.deepEqual(
    args.filter((arg) => arg.startsWith("--attach")),
    ["--attach=/logs/crash.log", "--attach=/shots/a.png"],
  );
  // Still prepare-only: attaching a file is not involving a model.
  assert.ok(args.includes("--prepare-only"));
});

test("a warning from the run reaches the developer, not just the log", async () => {
  // The case this exists for: three files picked, two copied. Without this
  // the warning would exist only in the CLI's own diagnostics, which is not
  // where anybody looks.
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "fetch" },
      { type: "step_completed", step: "fetch" },
      {
        type: "completed",
        ok: true,
        warnings: ["Attachment not added (not a file): C:/gone.log"],
      },
    ],
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const warning = h.notices.find((notice) => notice.kind === "warning");
  assert.ok(warning, "the run warning was swallowed");
  assert.match(warning.message, /Attachment not added/);
});

// --- fix mode selection ----------------------------------------------------

const MODE_PAYLOAD = {
  schema_version: 1,
  ok: true,
  command: "fix-mode",
  default_mode_id: "standard",
  modes: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default workflow.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
    },
    {
      id: "conservative",
      name: "Conservative Fix",
      description: "Minimal, low-risk changes.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
    },
    {
      id: "investigate-first",
      name: "Investigate First",
      description: "Diagnose before changing source.",
      version: 1,
      source: "builtin",
      execution_kind: "investigate",
    },
    {
      id: "test-driven",
      name: "Test-Driven Fix",
      description: "Reproduce with a focused test first.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
    },
    {
      id: "deep-analysis",
      name: "Deep Analysis",
      description: "Deeper evidence review.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
    },
  ],
  warnings: [],
};

const CATALOG = fixModesFromPayload(MODE_PAYLOAD);

/** A status file for a package prepared with one mode. */
function statusWith(modeId: string, name: string, kind = "fix"): string {
  return JSON.stringify({
    schema_version: 1,
    work_item_id: "JR-12345",
    status: "prepared",
    steps: { doctor: "pass" },
    generated_files: [],
    fix_mode: { id: modeId, name, version: 1, source: "builtin", execution_kind: kind },
  });
}

test("the catalog is discovered once per environment resolution", () => {
  // Not per render and not per keystroke: this spawns a process.
  return (async () => {
    const h = harness({ fixModes: CATALOG });
    await h.controller.refreshEnvironment();

    assert.equal(h.fixModeCalls.count, 1);
    assert.equal(h.last().fixModes.kind, "ready");
  })();
});

test("a new form takes the default the CLI declared", async () => {
  const h = harness({ fixModes: CATALOG });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().form?.fixModeId, "standard");
});

test("a selection the catalog no longer offers falls back to the declared default", async () => {
  const h = harness({ fixModes: CATALOG, form: jiraForm({ fixModeId: "team-safe-fix" }) });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().form?.fixModeId, "standard");
});

test("the developer's own choice survives an environment refresh", async () => {
  const h = harness({ fixModes: CATALOG, form: jiraForm({ fixModeId: "conservative" }) });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().form?.fixModeId, "conservative");
});

test("the selected mode reaches the command line", async () => {
  const h = harness({ fixModes: CATALOG, events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ fixModeId: "conservative" }));

  assert.ok(h.streamRuns[0]!.args.includes("--fix-mode=conservative"));
  assert.equal(
    h.streamRuns[0]!.args.filter((arg) => arg.startsWith("--fix-mode")).length,
    1,
  );
});

/** The catalog with a project custom mode in it. */
const CATALOG_WITH_CUSTOM = fixModesFromPayload({
  ...MODE_PAYLOAD,
  modes: [
    ...MODE_PAYLOAD.modes,
    {
      id: "team-safe",
      name: "Team Safe Fix",
      description: "Our conservative variant.",
      version: 1,
      source: "project",
      execution_kind: "fix",
      based_on: "conservative",
    },
  ],
});

test("the run request carries exactly the mode the form holds: Standard, a built-in, a custom mode", async () => {
  // Batch 7 moved the selector; the request must not notice. One --fix-mode,
  // spelled as the id the form holds, for each kind of mode.
  for (const fixModeId of ["standard", "investigate-first", "team-safe"]) {
    const h = harness({ fixModes: CATALOG_WITH_CUSTOM, events: successfulRun });
    await h.controller.refreshEnvironment();
    await h.controller.run(jiraForm({ fixModeId }));

    const flags = h.streamRuns[0]!.args.filter((arg) => arg.startsWith("--fix-mode"));
    assert.deepEqual(flags, [`--fix-mode=${fixModeId}`], fixModeId);
  }
});

test("a restored custom mode survives the catalog arriving", async () => {
  const h = harness({ fixModes: CATALOG_WITH_CUSTOM, form: jiraForm({ fixModeId: "team-safe" }) });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().form?.fixModeId, "team-safe");
});

test("a custom mode that was deleted falls back to the default, like any other", async () => {
  const h = harness({ fixModes: CATALOG, form: jiraForm({ fixModeId: "team-safe" }) });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().form?.fixModeId, "standard");
});

test("opening a prepared work item shows the mode it was prepared with", async () => {
  const h = harness({
    fixModes: CATALOG,
    files: { "run.json": statusWith("conservative", "Conservative Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  assert.deepEqual(h.last().preparedFixMode, {
    id: "conservative",
    name: "Conservative Fix",
    executionKind: "fix",
    availability: "available",
  });
  // And the selector follows it, so running again repeats what was prepared.
  assert.equal(h.last().form?.fixModeId, "conservative");
});

test("switching to a work item with no recorded mode does not keep the previous one", async () => {
  // Otherwise JR-100's Deep Analysis silently becomes JR-200's workflow.
  const h = harness({
    fixModes: CATALOG,
    form: jiraForm({ fixModeId: "investigate-first" }),
    files: { "run.json": JSON.stringify({ steps: {}, generated_files: [] }) },
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-999");

  assert.equal(h.last().form?.fixModeId, "standard");
  assert.equal(h.last().preparedFixMode, undefined);
});

test("reopening a Jira work item puts its key in the Issue field, so Run prepares that item with its own mode", async () => {
  // Release stabilization, found in a real window: reopening JR-23456 re-selected
  // its mode while the Issue field still named JR-12345, and Run then re-prepared
  // JR-12345 with JR-23456's mode — an investigate-only package silently becoming
  // a fixing one. The reopened item is now the subject of the field too.
  const h = harness({
    fixModes: CATALOG,
    form: jiraForm({ issueKey: "JR-12345", fixModeId: "investigate-first" }),
    files: { "run.json": statusWith("standard", "Standard Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-23456");

  assert.equal(h.last().form?.issueKey, "JR-23456");
  assert.equal(h.last().form?.source, "jira");
  assert.equal(h.last().form?.fixModeId, "standard");
  await h.controller.run(h.last().form!);
  const args = h.streamRuns[0]!.args;
  assert.ok(args.includes("JR-23456"), args.join(" "));
  assert.equal(args.includes("JR-12345"), false, "the key still in the field was re-prepared with another item's mode");
  assert.ok(args.includes("--fix-mode=standard"));
});

test("reopening a hand-written bug leaves a typed Jira key, and that key's mode, alone", async () => {
  // A local id cannot be put back into the field — its text is the bug — so the
  // field keeps naming the key the next Run prepares, and the selection stays that key's.
  const h = harness({
    fixModes: CATALOG,
    form: jiraForm({ issueKey: "JR-12345", fixModeId: "investigate-first" }),
    files: { "run.json": statusWith("standard", "Standard Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("local_20260927101010");

  assert.equal(h.last().form?.issueKey, "JR-12345");
  assert.equal(h.last().form?.fixModeId, "investigate-first");
  // The rows describe the reopened item all the same.
  assert.equal(h.last().workItemId, "local_20260927101010");
  assert.equal(h.last().preparedFixMode?.id, "standard");
});

test("a prepared mode the catalog no longer has is shown as unavailable", async () => {
  const h = harness({
    fixModes: CATALOG,
    files: { "run.json": statusWith("team-safe-fix", "Team Safe Fix") },
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  assert.equal(h.last().preparedFixMode?.id, "team-safe-fix");
  assert.equal(h.last().preparedFixMode?.availability, "unavailable");
  // The form does not inherit a mode that cannot be run.
  assert.equal(h.last().form?.fixModeId, "standard");
});

test("the prepared mode is what ran, not what is selected now", async () => {
  const h = harness({
    fixModes: CATALOG,
    events: successfulRun,
    files: { "run.json": statusWith("investigate-first", "Investigate First", "investigate") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ fixModeId: "investigate-first" }));

  assert.equal(h.last().preparedFixMode?.id, "investigate-first");
  assert.equal(h.last().preparedFixMode?.executionKind, "investigate");

  // The developer changes their mind without running again. What is on disk did
  // not change, so neither does what the panel says was prepared.
  await h.controller.handle({ type: "formChanged", form: jiraForm({ fixModeId: "conservative" }) });
  await h.controller.showWorkItem("JR-12345");

  assert.equal(h.last().preparedFixMode?.id, "investigate-first");
});

test("a bugpilot that cannot list modes says so and still prepares", async () => {
  const h = harness({
    fixModes: { kind: "unavailable", detail: "This BugPilot version does not expose AI Fix Modes." },
    events: successfulRun,
  });
  await h.controller.refreshEnvironment();

  assert.equal(h.last().fixModes.kind, "unavailable");

  await h.controller.run(jiraForm({ fixModeId: "" }));

  // No invented id reaches the CLI, and the run still happens.
  assert.equal(
    h.streamRuns[0]!.args.find((arg) => arg.startsWith("--fix-mode")),
    undefined,
  );
  assert.equal(h.streamRuns.length, 1);
});

test("a blocked environment does not spawn a discovery process", async () => {
  const h = harness({
    fixModes: CATALOG,
    environment: { kind: "no-folder", summary: "Open a folder first." },
  });
  await h.controller.refreshEnvironment();

  assert.equal(h.fixModeCalls.count, 0);
  assert.equal(h.last().fixModes.kind, "unavailable");
});

// --- a Fix Mode belongs to a work item, not to the panel --------------------

test("typing another issue key does not carry the previous bug's Fix Mode", async () => {
  // The reviewed defect. JR-12345 was prepared with Deep Analysis, so the
  // selector shows it; typing a different key used to leave it there, and the
  // next run prepared an unrelated bug under a workflow nobody chose for it.
  const h = harness({
    fixModes: CATALOG,
    files: { "run.json": statusWith("deep-analysis", "Deep Analysis") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(h.last().form?.fixModeId, "deep-analysis");

  // Same panel, different bug, typed rather than clicked. It has no package.
  delete h.files["run.json"];
  await h.controller.handle({
    type: "formChanged",
    form: jiraForm({ issueKey: "JR-999", fixModeId: "deep-analysis" }),
  });

  assert.equal(h.last().form?.fixModeId, "standard");
});

test("a typed key that names a prepared work item adopts that item's mode", async () => {
  const h = harness({
    fixModes: CATALOG,
    files: { "run.json": statusWith("test-driven", "Test-Driven Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();

  await h.controller.handle({
    type: "formChanged",
    form: jiraForm({ issueKey: "JR-300", fixModeId: "standard" }),
  });

  assert.equal(h.last().form?.fixModeId, "test-driven");
});

test("editing other fields leaves a deliberate choice alone", async () => {
  // The rule is "another bug gets its own mode", not "the panel keeps resetting
  // the dropdown": a hint, a keyword or a focus file is the same bug. A reset
  // would replace the form and push, so the absence of a push is the assertion.
  const h = harness({ fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  const chosen = jiraForm({ issueKey: "JR-200", fixModeId: "conservative" });
  await h.controller.handle({ type: "formChanged", form: jiraForm({ issueKey: "JR-200" }) });
  await h.controller.handle({ type: "formChanged", form: chosen });
  const pushes = h.states.length;

  for (const edit of [{ hint: "look here" }, { keywords: "cache" }, { focusFiles: "src/a.ts" }]) {
    await h.controller.handle({ type: "formChanged", form: { ...chosen, ...edit } });
  }

  assert.equal(h.states.length, pushes, "an edit to another field re-derived the Fix Mode");
  assert.equal(h.saved.at(-1)?.fixModeId, "conservative");
});

test("a half-typed key is not yet another work item", async () => {
  // Otherwise every keystroke of an issue key would re-derive the mode, and a
  // deliberate choice would be wiped out mid-word.
  const h = harness({ fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "formChanged", form: jiraForm({ issueKey: "JR-200" }) });
  const chosen = jiraForm({ issueKey: "JR-200", fixModeId: "conservative" });
  await h.controller.handle({ type: "formChanged", form: chosen });
  const pushes = h.states.length;

  for (const partial of ["JR-", "J", ""]) {
    await h.controller.handle({
      type: "formChanged",
      form: { ...chosen, issueKey: partial },
    });
  }

  assert.equal(h.states.length, pushes);
  assert.equal(h.saved.at(-1)?.fixModeId, "conservative");
});

test("switching to a hand-written bug starts from the default", async () => {
  // A hand-written bug is a new work item too; only its id is minted later.
  const h = harness({
    fixModes: CATALOG,
    files: { "run.json": statusWith("deep-analysis", "Deep Analysis") },
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(h.last().form?.fixModeId, "deep-analysis");

  await h.controller.handle({
    type: "formChanged",
    form: {
      ...DEFAULT_FORM,
      source: "manual",
      description: "it crashes",
      fixModeId: "deep-analysis",
    },
  });

  assert.equal(h.last().form?.fixModeId, "standard");
});

test("the selector follows the typed bug while the prepared line stays with the open one", async () => {
  // Two different questions: what the next run would use, and what produced the
  // package whose artifacts and progress are on screen.
  const h = harness({
    fixModes: CATALOG,
    files: {
      "run.json": statusWith("investigate-first", "Investigate First", "investigate"),
    },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  delete h.files["run.json"];
  await h.controller.handle({
    type: "formChanged",
    form: jiraForm({ issueKey: "JR-999", fixModeId: "investigate-first" }),
  });

  assert.equal(h.last().form?.fixModeId, "standard");
  assert.equal(h.last().preparedFixMode?.id, "investigate-first");
});

// --- managing custom Fix Modes ----------------------------------------------

const MANAGED = managedFixModesFromPayload({
  ok: true,
  builtin: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
      effective: true,
    },
  ],
  user: [
    {
      id: "my-safe",
      name: "My Safe Fix",
      description: "Mine.",
      version: 3,
      source: "user",
      execution_kind: "fix",
      effective: false,
    },
  ],
  project: [
    {
      id: "my-safe",
      name: "Team Safe Fix",
      description: "Ours.",
      version: 1,
      source: "project",
      execution_kind: "fix",
      effective: true,
    },
  ],
  issues: [],
});

const DEFINITION_ENVELOPE: Envelope = {
  ok: true,
  command: "fix-mode",
  warnings: [],
  mode: {
    id: "my-safe",
    name: "My Safe Fix",
    description: "Mine.",
    version: 3,
    source: "user",
    execution_kind: "fix",
    based_on: "standard",
    based_on_version: 1,
    objective: "Objective.",
    investigation: "Investigation.",
    implementation: "Implementation.",
    verification: "Verification.",
    constraints: "Constraints.",
    completion: "Completion.",
  },
};

/** A harness whose Fix Mode commands are scripted and recorded. */
function manageHarness(options: HarnessOptions & { envelopes?: Envelope[] } = {}) {
  const requests: { args: readonly string[]; payload?: unknown }[] = [];
  const queued = [...(options.envelopes ?? [])];
  const h = harness({
    fixModes: CATALOG,
    managed: MANAGED,
    ...options,
    runFixMode: async (request) => {
      const args = request.args("/tmp/payload.json");
      requests.push({ args, ...(request.payload === undefined ? {} : { payload: request.payload }) });
      return queued.shift() ?? DEFINITION_ENVELOPE;
    },
  });
  return { ...h, requests };
}

test("opening the manager reads every physical definition", async () => {
  const h = manageHarness();
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "manageFixModes" });

  const manage = h.last().manage!;
  assert.equal(manage.catalog.kind, "ready");
  if (manage.catalog.kind !== "ready") return;
  // Both definitions of the shadowed id, which the selector never shows.
  assert.deepEqual(manage.catalog.user.map((mode) => mode.name), ["My Safe Fix"]);
  assert.deepEqual(manage.catalog.project.map((mode) => mode.name), ["Team Safe Fix"]);
  assert.equal(manage.catalog.user[0]!.effective, false);
});

test("the manager is absent from the state until it is opened", async () => {
  const h = manageHarness();
  await h.controller.refreshEnvironment();

  assert.equal(h.last().manage, undefined);

  await h.controller.handle({ type: "manageFixModes" });
  assert.ok(h.last().manage);

  await h.controller.handle({ type: "closeFixModes" });
  assert.equal(h.last().manage, undefined);
});

test("a shadowed mode is opened from the scope that owns it", async () => {
  const h = manageHarness();
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });

  await h.controller.handle({ type: "fixModeAction", action: "edit", id: "my-safe", scope: "user" });

  assert.deepEqual(h.requests.at(-1)!.args, [
    "fix-mode",
    "show",
    "my-safe",
    "--scope=user",
    "--json",
  ]);
  const editor = h.last().manage!.editor!;
  assert.equal(editor.intent, "edit");
  assert.equal(editor.version, 3);
  assert.equal(editor.objective, "Objective.");
});

test("a built-in opens read-only and duplicating it starts a new mode", async () => {
  const h = manageHarness();
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });

  await h.controller.handle({ type: "fixModeAction", action: "view", id: "standard", scope: "builtin" });
  assert.equal(h.last().manage!.editor!.intent, "view");
  // No scope flag for a built-in: it is not in either custom directory.
  assert.deepEqual(h.requests.at(-1)!.args, ["fix-mode", "show", "standard", "--json"]);

  await h.controller.handle({
    type: "fixModeAction",
    action: "duplicate",
    id: "standard",
    scope: "builtin",
  });
  const draft = h.last().manage!.editor!;
  assert.equal(draft.intent, "create");
  assert.equal(draft.version, 0);
  assert.equal(draft.basedOn, "my-safe");
  assert.notEqual(draft.id, "my-safe");
  assert.match(draft.name, /copy/);
});

test("saving an edit sends the payload in a file and refreshes both catalogs", async () => {
  const h = manageHarness({
    envelopes: [DEFINITION_ENVELOPE, { ok: true, command: "fix-mode", warnings: [] }],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({ type: "fixModeAction", action: "edit", id: "my-safe", scope: "user" });
  const before = h.fixModeCalls.count;

  const draft = { ...h.last().manage!.editor!, objective: "Edited objective." };
  await h.controller.handle({ type: "saveFixMode", draft });

  const save = h.requests.at(-1)!;
  assert.deepEqual(save.args, [
    "fix-mode",
    "update",
    "my-safe",
    "--scope=user",
    "--expected-version=3",
    "--from-file=/tmp/payload.json",
    "--json",
  ]);
  assert.equal((save.payload as Record<string, unknown>)["objective"], "Edited objective.");
  assert.equal(h.last().manage!.editor, undefined, "the editor closes after a successful save");
  assert.ok(h.fixModeCalls.count > before, "the selector's catalog was not refreshed");
});

test("a refused save keeps the editor open with what was typed", async () => {
  // The conflict case: another editor saved first. Losing the developer's text
  // here would be the worst possible answer to "someone else got there first".
  const h = manageHarness({
    envelopes: [
      DEFINITION_ENVELOPE,
      {
        ok: false,
        command: "fix-mode",
        error: {
          code: "INVALID_INPUT",
          message: "Fix Mode 'my-safe' changed since this editor was opened (expected version 3, found 4). Reload it before saving.",
        },
      },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({ type: "fixModeAction", action: "edit", id: "my-safe", scope: "user" });

  const draft = { ...h.last().manage!.editor!, objective: "Work in progress." };
  await h.controller.handle({ type: "saveFixMode", draft });

  const manage = h.last().manage!;
  assert.equal(manage.editor?.objective, "Work in progress.");
  assert.match(manage.error ?? "", /changed since this editor was opened/);
});

test("deleting asks first, and says what it costs", async () => {
  const h = manageHarness({
    confirm: true,
    envelopes: [{ ok: true, command: "fix-mode", warnings: [] }],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });

  await h.controller.handle({
    type: "fixModeAction",
    action: "delete",
    id: "my-safe",
    scope: "project",
  });

  assert.deepEqual(h.requests.at(-1)!.args, [
    "fix-mode",
    "delete",
    "my-safe",
    "--scope=project",
    "--expected-version=1",
    "--json",
  ]);
});

test("deleting the mode being read closes it, so the panel returns to the list (§37.115)", async () => {
  const h = manageHarness({ confirm: true, envelopes: [DEFINITION_ENVELOPE, { ok: true, command: "fix-mode", warnings: [] }] });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({ type: "fixModeAction", action: "view", id: "my-safe", scope: "user" });
  assert.equal(h.last().manage!.editor?.intent, "view");

  await h.controller.handle({ type: "fixModeAction", action: "delete", id: "my-safe", scope: "user" });

  assert.equal(h.requests.at(-1)!.args[1], "delete");
  assert.equal(h.last().manage!.editor, undefined, "the deleted mode is still on screen");

  // Declined: the mode stays, and so does its page.
  const kept = manageHarness({ confirm: false, envelopes: [DEFINITION_ENVELOPE] });
  await kept.controller.refreshEnvironment();
  await kept.controller.handle({ type: "manageFixModes" });
  await kept.controller.handle({ type: "fixModeAction", action: "view", id: "my-safe", scope: "user" });
  await kept.controller.handle({ type: "fixModeAction", action: "delete", id: "my-safe", scope: "user" });
  assert.equal(kept.last().manage!.editor?.intent, "view");
});

test("a declined delete changes nothing", async () => {
  const h = manageHarness({ confirm: false });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });

  await h.controller.handle({
    type: "fixModeAction",
    action: "delete",
    id: "my-safe",
    scope: "user",
  });

  assert.equal(h.requests.length, 0);
});

test("a stale delete is reported rather than pretended", async () => {
  const h = manageHarness({
    confirm: true,
    envelopes: [
      {
        ok: false,
        command: "fix-mode",
        error: { code: "INVALID_INPUT", message: "changed since it was listed" },
      },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });

  await h.controller.handle({
    type: "fixModeAction",
    action: "delete",
    id: "my-safe",
    scope: "user",
  });

  assert.match(h.last().manage!.error ?? "", /changed since it was listed/);
});

test("a bugpilot that cannot manage modes says so instead of failing quietly", async () => {
  const h = harness({ fixModes: CATALOG });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "manageFixModes" });

  assert.equal(h.last().manage!.catalog.kind, "unavailable");
});

test("a successful create reports what it wrote, by id and scope", async () => {
  // The page needs to point at the new row, and a name cannot do it: the same
  // id can exist in the user and the project scope. So the host says which,
  // taken from the draft core accepted rather than guessed from the catalog.
  const h = manageHarness({
    envelopes: [DEFINITION_ENVELOPE, { ok: true, command: "fix-mode", warnings: [] }],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({
    type: "fixModeAction",
    action: "duplicate",
    id: "my-safe",
    scope: "user",
  });
  const draft = { ...h.last().manage!.editor!, scope: "project" as const, name: "Team Copy" };

  await h.controller.handle({ type: "saveFixMode", draft });

  assert.deepEqual(h.last().manage!.created, {
    id: draft.id,
    scope: "project",
    name: "Team Copy",
  });
});

test("a saved edit is not reported as a creation", async () => {
  const h = manageHarness({
    envelopes: [DEFINITION_ENVELOPE, { ok: true, command: "fix-mode", warnings: [] }],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({ type: "fixModeAction", action: "edit", id: "my-safe", scope: "user" });

  await h.controller.handle({ type: "saveFixMode", draft: h.last().manage!.editor! });

  assert.equal(h.last().manage!.created, undefined);
});

test("a refused create reports no creation", async () => {
  const h = manageHarness({
    envelopes: [
      DEFINITION_ENVELOPE,
      { ok: false, command: "fix-mode", error: { code: "INVALID_INPUT", message: "taken" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({
    type: "fixModeAction",
    action: "duplicate",
    id: "my-safe",
    scope: "user",
  });

  await h.controller.handle({ type: "saveFixMode", draft: h.last().manage!.editor! });

  assert.equal(h.last().manage!.created, undefined);
  assert.match(h.last().manage!.error!, /taken/);
  assert.ok(h.last().manage!.editor, "the editor closed on a refused create");
});

test("the creation notice stops following the developer once they act again", async () => {
  const h = manageHarness({
    envelopes: [
      DEFINITION_ENVELOPE,
      { ok: true, command: "fix-mode", warnings: [] },
      DEFINITION_ENVELOPE,
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "manageFixModes" });
  await h.controller.handle({
    type: "fixModeAction",
    action: "duplicate",
    id: "my-safe",
    scope: "user",
  });
  await h.controller.handle({ type: "saveFixMode", draft: h.last().manage!.editor! });
  assert.ok(h.last().manage!.created, "nothing was reported as created");

  await h.controller.handle({ type: "fixModeAction", action: "view", id: "my-safe", scope: "user" });

  assert.equal(h.last().manage!.created, undefined);
});

// --- improving a hint --------------------------------------------------------

const HINTED: FormState = {
  ...DEFAULT_FORM,
  source: "jira",
  issueKey: "JR-1",
  hint: "maybe output validation, don't change VolumeDescriptor",
};

function hintHarness(options: HarnessOptions = {}) {
  return harness({ agentOnPath: true, form: HINTED, ...options });
}

test("a hint is improved from the issue's own words, and nothing else", async () => {
  const h = hintHarness({ issueDetails: { title: "Empty volume crash", description: "No traces." } });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.deepEqual(h.issueLookups, ["JR-1"]);
  assert.equal(h.hintPrompts.length, 1);
  assert.match(h.hintPrompts[0]!, /Empty volume crash/);
  assert.match(h.hintPrompts[0]!, /No traces\./);
  // The constraint the developer wrote reaches the model untouched.
  assert.match(h.hintPrompts[0]!, /don't change VolumeDescriptor/);
  // And nothing built context on the way.
  assert.equal(h.streamRuns.length, 0, "improving a hint started a run");
});

test("improving a hint never touches what the developer wrote", async () => {
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Investigate validation." }) });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.equal(h.last().hintImprovement?.suggestion, "Investigate validation.");
  assert.equal(h.last().form?.hint, HINTED.hint, "the hint was overwritten before it was accepted");
});

test("Use Improved and Keep Original both clear the suggestion; neither writes the host's form", async () => {
  // The page puts an accepted suggestion into the settings page's Hint — a
  // draft, like everything there — so the host's form, and whether a context is
  // stale, changes only when the page is applied.
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Investigate validation." }) });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "ready" });
  const revision = h.last().revision;
  await h.controller.handle({ type: "improveHint", form: { ...HINTED, hint: "a draft hint" } });
  assert.equal(h.last().hintImprovement?.suggestion, "Investigate validation.");

  await h.controller.handle({ type: "useImprovedHint" });
  assert.equal(h.last().form?.hint, HINTED.hint, "the host took the draft or the suggestion as its own");
  assert.equal(h.last().revision, revision, "the page's draft was overwritten");
  assert.equal(h.last().hintImprovement?.suggestion, undefined, "the suggestion outlived its use");

  const kept = hintHarness({ improveHint: async () => ({ ok: true, text: "Something else." }) });
  await kept.controller.refreshEnvironment();
  await kept.controller.handle({ type: "improveHint", form: HINTED });
  await kept.controller.handle({ type: "dismissImprovedHint" });
  assert.equal(kept.last().form?.hint, HINTED.hint);
  assert.equal(kept.last().hintImprovement?.suggestion, undefined);
});

test("a hand-written bug uses its own description, and asks Jira nothing", async () => {
  const form: FormState = {
    ...DEFAULT_FORM,
    source: "manual",
    title: "Crash on empty volume",
    description: "It crashes when the volume has no traces.",
    hint: "maybe the reader",
  };
  const h = harness({ agentOnPath: true, form });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form });

  assert.deepEqual(h.issueLookups, [], "a hand-written bug went to Jira");
  assert.match(h.hintPrompts[0]!, /Crash on empty volume/);
  assert.match(h.hintPrompts[0]!, /It crashes when the volume has no traces\./);
});

test("turning the issue context off keeps the request to the hint alone", async () => {
  const form = { ...HINTED, useIssueDetails: false };
  const h = harness({ agentOnPath: true, form, issueDetails: { title: "t", description: "d" } });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form });

  assert.deepEqual(h.issueLookups, [], "the issue was read although the box was off");
  assert.match(h.hintPrompts[0]!, /No issue details or repository context are available/);
});

test("an issue that cannot be read improves the hint anyway, and says so", async () => {
  // Jira being unreachable is a reason to improve the wording alone, not a
  // reason to refuse.
  const h = hintHarness({ issueDetailsThrows: new Error("network") });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.equal(h.hintPrompts.length, 1, "the improvement was abandoned");
  assert.match(h.hintPrompts[0]!, /No issue details or repository context are available/);
  assert.match(h.last().hintImprovement?.notice ?? "", /Issue details unavailable/);
  assert.equal(h.last().hintImprovement?.error, undefined, "a fallback was reported as an error");
});

test("an empty hint is not worth a model call", async () => {
  const form = { ...HINTED, hint: "   " };
  const h = harness({ agentOnPath: true, form });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form });

  assert.equal(h.hintPrompts.length, 0);
  assert.match(h.last().hintImprovement?.error ?? "", /Enter a hint first/);
});

test("a second press while the first is still out costs nothing", async () => {
  let release: (() => void) | undefined;
  const h = hintHarness({
    improveHint: async () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: "Improved." });
      }),
  });
  await h.controller.refreshEnvironment();

  const first = h.controller.handle({ type: "improveHint", form: HINTED });
  // Wait for the request to actually be out before pressing again; otherwise
  // the test would be asserting that an unstarted request is not duplicated.
  while (h.hintPrompts.length === 0) await new Promise((resolve) => setImmediate(resolve));

  await h.controller.handle({ type: "improveHint", form: HINTED });
  assert.equal(h.hintPrompts.length, 1, "a duplicate press made a second model call");
  assert.equal(h.last().hintImprovement?.busy, true);

  release?.();
  await first;
  assert.equal(h.last().hintImprovement?.busy, false);
  assert.equal(h.last().hintImprovement?.suggestion, "Improved.");
});

test("the same question twice is answered from memory", async () => {
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Improved." }) });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });
  await h.controller.handle({ type: "dismissImprovedHint" });

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.equal(h.hintPrompts.length, 1, "the same request was asked twice");
  assert.equal(h.last().hintImprovement?.suggestion, "Improved.");
});

test("a provider that is not installed says which one, and asks nothing", async () => {
  const h = harness({ agentOnPath: false, form: HINTED });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.equal(h.hintPrompts.length, 0);
  // Auto looked for both and found neither, so the message names both.
  assert.match(h.last().hintImprovement?.error ?? "", /No AI CLI was found on PATH/);
  assert.match(h.last().hintImprovement?.error ?? "", /claude, codex/);
});

test("a failing AI CLI is reported, not thrown", async () => {
  const h = hintHarness({
    improveHint: async () => ({ ok: false, reason: "Claude Code could not improve the hint: boom" }),
  });
  await h.controller.refreshEnvironment();

  await h.controller.handle({ type: "improveHint", form: HINTED });

  assert.match(h.last().hintImprovement?.error ?? "", /could not improve the hint: boom/);
  assert.equal(h.last().hintImprovement?.suggestion, undefined);
  assert.equal(h.last().form?.hint, HINTED.hint);
});

test("editing the hint drops a suggestion made for the old one", async () => {
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Improved." }) });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });
  assert.ok(h.last().hintImprovement?.suggestion);

  await h.controller.handle({ type: "formChanged", form: { ...HINTED, hint: "something else" } });

  assert.equal(h.last().hintImprovement?.suggestion, undefined);
});

test("moving to another issue drops the suggestion too", async () => {
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Improved." }) });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });

  await h.controller.handle({ type: "formChanged", form: { ...HINTED, issueKey: "JR-2" } });

  assert.equal(h.last().hintImprovement?.suggestion, undefined);
});

test("the issue is read once, and reused by a later improvement", async () => {
  const h = hintHarness({ issueDetails: { title: "t", description: "d" } });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });
  await h.controller.handle({ type: "dismissImprovedHint" });

  await h.controller.handle({ type: "improveHint", form: { ...HINTED, hint: "another hint" } });

  assert.deepEqual(h.issueLookups, ["JR-1"], "the same issue was fetched twice");
  assert.equal(h.hintPrompts.length, 2);
});

// --- UI-A3: the result the host decides --------------------------------------

/** A version-1 `retrieval.json` as core writes it, with these lists in it. */
function retrievalJson(lists: { related_files?: unknown; terms?: unknown }): string {
  return JSON.stringify({
    schema_version: 1,
    confidence: "high",
    reasons: [],
    noise_indicators: [],
    related_files: [],
    terms: [],
    ...lists,
  });
}

/** A run whose retrieval is on disk and readable. */
const PREPARED = {
  events: successfulRun,
  directory: ["task.md", "context.md", "retrieval.json"],
  files: {
    "retrieval.json": retrievalJson({
      related_files: [{ file: "a.cpp" }, { file: "b.cpp" }],
      terms: [{ value: "x" }, { value: "y" }, { value: "z" }],
    }),
  },
};

test("a finished run reports what it produced, each on the row that produced it", async () => {
  const h = harness(PREPARED);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const state = h.last();
  assert.ok(reportsContext(state), "a successful run reported no result");
  // Counted from its own files, on the row that searched.
  assert.equal(codeRow(state).summary, "3 terms · 2 relevant files");
  assert.equal(codeRow(state).artifact, "retrieval.json");
  // The context actions on the row that built the context; the folder is the
  // work item's, not Build context's.
  assert.deepEqual([...buildRow(state).actions], ["openContext", "copyContext"]);
  assert.equal(buildRow(state).artifact, "context.md");
  assert.deepEqual([...state.workItemActions], ["openFolder"]);
  // A task ready to hand over is `ready`, never the green tick.
  assert.equal(fixRow(state).status, "ready");
  assert.equal(canFix(state), true);
});

// --- Git History v2, Batch 3: the row reads the structured record ---------------

const gitRowOf = (state: PanelState) => stepOf(state, "gitHistory");

/** A `retrieval.json` with Code search's lists and a Git history section of `count` commits. */
function retrievalWithHistory(count: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...JSON.parse(retrievalJson({ related_files: [{ file: "a.cpp" }, { file: "b.cpp" }], terms: [{ value: "x" }] })),
    git_history: {
      schema_version: 1,
      status: "completed",
      search: { commit_message_search: true, file_history_search: true, history_depth: "recent", max_related_commits: 10 },
      summary: { candidate_count: 9, related_commit_count: count, incomplete: false, failed_lookup_count: 0 },
      commits: Array.from({ length: count }, (_, index) => ({
        hash: String(index).repeat(40),
        short_hash: String(index).repeat(10),
        subject: `Commit ${index}`,
        date: "2026-01-01",
        score: 30,
        matched_terms: [{ value: "poststack", source: "shared_keyword" }],
        files: [{ path: "src/a.cpp", source: "code_search_ranked_file" }],
        reasons: ["matched shared keyword: poststack"],
      })),
      warnings: [],
      ...extra,
    },
  });
}

test("a finished run reports Git history from its structured record", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md", "context.md", "retrieval.json"], files: { "retrieval.json": retrievalWithHistory(3) } });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const row = gitRowOf(h.last());
  assert.equal(row.statusText, "Completed");
  assert.equal(row.summary, "3 related commits found");
  assert.deepEqual(row.gitHistory?.commits.map((commit) => commit.subject), ["Commit 0", "Commit 1", "Commit 2"]);
  // One read of the file, two projections that agree with it.
  assert.equal(codeRow(h.last()).summary, "1 term · 2 relevant files");
  // The gear Batch 2 added is still on the row's model.
  assert.equal(SETTINGS_SECTION_OF_STEP.gitHistory, "git-history");
});

test("a partial record says so on the row", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md", "retrieval.json"],
    files: { "retrieval.json": retrievalWithHistory(6, { summary: { incomplete: true, failed_lookup_count: 1 } }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(gitRowOf(h.last()).summary, "6 related commits found · Some lookups incomplete");
});

test("a work item prepared before the record existed, or with one that cannot be read, says Completed", async () => {
  for (const text of [
    retrievalJson({ related_files: [{ file: "a.cpp" }], terms: [{ value: "x" }] }),
    retrievalWithHistory(2, { schema_version: 99 }),
    retrievalWithHistory(2, { status: "exploded" }),
    JSON.stringify({ ...JSON.parse(retrievalJson({ related_files: [{ file: "a.cpp" }] })), git_history: "{ not json" }),
  ]) {
    const h = harness({ events: successfulRun, directory: ["task.md", "context.md", "retrieval.json"], files: { "retrieval.json": text } });
    await h.controller.refreshEnvironment();
    await h.controller.run(jiraForm());
    const row = gitRowOf(h.last());
    assert.equal(row.statusText, "Completed");
    assert.equal(row.summary, "", "a count was invented");
    assert.equal(row.gitHistory, undefined);
    // And the rest of the workflow is untouched by it.
    assert.match(codeRow(h.last()).summary, /relevant file/);
    assert.ok(reportsContext(h.last()));
  }
});

test("supporting files reach the Git history row, and never Code search's Relevant files", async () => {
  const supporting = [
    { path: "src/stack/StackInputModel.cpp", source: "git_history", score: 22, change: "modified", commit_hashes: ["0".repeat(40), "1".repeat(40)], reasons: ["changed in 2 related commits"] },
  ];
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md", "retrieval.json"],
    files: { "retrieval.json": retrievalWithHistory(2, { supporting_files: supporting }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const row = gitRowOf(h.last());
  assert.equal(row.summary, "2 related commits found · 1 supporting file");
  assert.deepEqual(row.gitHistory?.supportingFiles, [
    { path: "src/stack/StackInputModel.cpp", name: "StackInputModel.cpp", detail: "Changed in 2 related commits" },
  ]);
  assert.deepEqual(codeRow(h.last()).search?.files.map((file) => file.path), ["a.cpp", "b.cpp"]);
  // Opened through its own checked open; with no stat port, as before.
  await h.controller.handle({ type: "openSupportingFile", path: "src/stack/StackInputModel.cpp" });
  assert.match(h.opened.at(-1) ?? "", /StackInputModel\.cpp$/);
});

// --- Supporting files: the open checks the current checkout (post-v2 hardening) ---------

/** The checkout as the stat port sees it: each repository path's entry (missing if unnamed), or a throw. */
function checkout(entries: Readonly<Record<string, GitignoreEntry | Error>>) {
  const asked: string[] = [];
  const io: GitignoreIo = {
    document: () => undefined,
    stat: async (file) => {
      asked.push(file);
      const entry = entries[nodePath.relative(ROOT, file).split(nodePath.sep).join("/")] ?? "missing";
      if (entry instanceof Error) throw entry;
      return entry;
    },
    read: async () => {
      throw new Error("an open reads nothing");
    },
    write: async () => {
      throw new Error("an open writes nothing");
    },
  };
  return { io, asked };
}

const SUPPORTING = [
  { path: "src/stack/StackInputModel.cpp", source: "git_history", score: 22, change: "modified", commit_hashes: ["0".repeat(40), "1".repeat(40)], reasons: ["changed in 2 related commits"] },
];

async function withSupportingFiles(entries: Readonly<Record<string, GitignoreEntry | Error>>) {
  const disk = checkout(entries);
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md", "retrieval.json"],
    files: { "retrieval.json": retrievalWithHistory(2, { supporting_files: SUPPORTING }) },
    gitignore: disk.io,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  return { h, asked: disk.asked };
}

test("a supporting file still in the checkout opens", async () => {
  const { h, asked } = await withSupportingFiles({ "src/stack/StackInputModel.cpp": "file" });
  await h.controller.handle({ type: "openSupportingFile", path: "src/stack/StackInputModel.cpp" });
  const target = nodePath.resolve(ROOT, "src/stack/StackInputModel.cpp");
  assert.deepEqual(asked, [target]);
  assert.deepEqual(h.opened, [target]);
  assert.deepEqual(h.notices, []);
});

test("a supporting file gone from the checkout is not opened, says so, and stays listed", async () => {
  const { h } = await withSupportingFiles({});
  const before = { state: JSON.stringify(h.last()), states: h.states.length, written: h.written.length, runs: h.streamRuns.length + h.jsonRuns.length };

  await h.controller.handle({ type: "openSupportingFile", path: "src/stack/StackInputModel.cpp" });

  assert.deepEqual(h.opened, [], "a missing file was handed to the editor");
  assert.deepEqual(h.notices, [{ kind: "warning", message: SUPPORTING_FILE_MISSING }]);
  assert.equal(SUPPORTING_FILE_MISSING, "This file is no longer in the current checkout.");
  // Evidence from when the run was made: nothing re-rendered, rewritten or rerun,
  // and the row still lists it.
  assert.deepEqual(
    { state: JSON.stringify(h.last()), states: h.states.length, written: h.written.length, runs: h.streamRuns.length + h.jsonRuns.length },
    before,
  );
  assert.deepEqual(gitRowOf(h.last()).gitHistory?.supportingFiles?.map((file) => file.path), ["src/stack/StackInputModel.cpp"]);
});

test("a directory, or a symbolic link, is not opened as a supporting file", async () => {
  for (const entry of ["other", "symlink"] as const) {
    const { h } = await withSupportingFiles({ "src/stack/StackInputModel.cpp": entry });
    await h.controller.handle({ type: "openSupportingFile", path: "src/stack/StackInputModel.cpp" });
    assert.deepEqual(h.opened, [], entry);
    assert.deepEqual(h.notices, [{ kind: "warning", message: SUPPORTING_FILE_NOT_A_FILE }], entry);
  }
});

test("a stat that fails does not crash the panel, and opens nothing", async () => {
  const { h } = await withSupportingFiles({ "src/stack/StackInputModel.cpp": new Error("EACCES: permission denied") });
  await h.controller.handle({ type: "openSupportingFile", path: "src/stack/StackInputModel.cpp" });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.notices, [{ kind: "warning", message: SUPPORTING_FILE_UNCHECKED }]);
  assert.ok(h.logged.some((line) => /^ERROR Could not check a supporting file: EACCES/.test(line)));
  // And the panel goes on answering.
  await h.controller.handle({ type: "openRelevantFile", path: "a.cpp" });
  assert.deepEqual(h.opened, [nodePath.resolve(ROOT, "a.cpp")]);
});

test("an unsafe supporting path is refused before the disk is asked", async () => {
  const { h, asked } = await withSupportingFiles({});
  for (const escape of ["../../outside.txt", "src/../../outside.txt", "/etc/passwd", "C:/Windows/win.ini", ".."]) {
    await h.controller.openSupportingFile(escape);
  }
  assert.deepEqual(asked, [], "a path outside the repository reached the stat");
  assert.deepEqual(h.opened, []);
  assert.equal(h.logged.filter((line) => /Refusing to open/.test(line)).length, 5, "a refusal went unlogged");
});

test("a Relevant file opens as before: Code Search's list is never checked against the disk", async () => {
  // The stat port is there and says missing; a Relevant file is still handed
  // straight to the editor, exactly as before the supporting-file check.
  const { h, asked } = await withSupportingFiles({});
  await h.controller.handle({ type: "openRelevantFile", path: "a.cpp" });
  assert.deepEqual(h.opened, [nodePath.resolve(ROOT, "a.cpp")]);
  assert.deepEqual(asked, []);
  assert.deepEqual(h.notices, []);
});

test("rendering supporting files asks the disk nothing", async () => {
  const { h, asked } = await withSupportingFiles({});
  await h.controller.handle({ type: "ready" });
  assert.equal(gitRowOf(h.last()).gitHistory?.supportingFiles?.length, 1);
  assert.deepEqual(asked, [], "a render stat'ed a supporting file");
});

test("a Batch 3 record without supporting files still reads", async () => {
  const h = harness({ events: successfulRun, directory: ["task.md", "context.md", "retrieval.json"], files: { "retrieval.json": retrievalWithHistory(2) } });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const row = gitRowOf(h.last());
  assert.equal(row.summary, "2 related commits found");
  assert.equal(row.gitHistory?.supportingFiles, undefined);
});

test("mid-run, Git history never shows the previous run's commits", async () => {
  const h = harness({
    hold: true,
    events: successfulRun,
    directory: ["task.md", "context.md", "retrieval.json"],
    files: { "retrieval.json": retrievalWithHistory(4) },
  });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await Promise.resolve();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  const row = gitRowOf(h.last());
  assert.equal(row.gitHistory, undefined, "a previous run's commits were offered mid-run");
  assert.equal(/related commit/.test(row.summary), false);
  h.release();
  await running;
  assert.equal(gitRowOf(h.last()).summary, "4 related commits found");
});

test("counts are omitted, not guessed, when the retrieval cannot be read", async () => {
  for (const unreadable of ["{ half written", JSON.stringify({ related_files: [{ file: "a.cpp" }] })]) {
    // Half-written, and the pre-retrieval.json shape with no schema_version.
    const h = harness({
      events: successfulRun,
      directory: ["task.md", "context.md", "retrieval.json"],
      files: { "retrieval.json": unreadable },
    });
    await h.controller.refreshEnvironment();
    await h.controller.run(jiraForm());

    const state = h.last();
    assert.ok(reportsContext(state), "an unreadable retrieval took the context with it");
    // Finished, and saying only that: no number, no files, no terms.
    assert.equal(codeRow(state).statusText, "Completed");
    assert.equal(codeRow(state).summary, "", "a number was invented");
    assert.equal(codeRow(state).search, undefined);
  }
});

test("the old retrieval files are not read, even when they are on disk", async () => {
  // No fallback: a directory holding the pre-retrieval.json files and no
  // retrieval.json has no retrieval, and the panel says nothing about one.
  const reads: string[] = [];
  const h = harness({
    events: successfulRun,
    directory: ["task.md", "context.md", "related_files.json", "search_quality.json"],
    files: {
      "related_files.json": JSON.stringify([{ file: "a.cpp" }]),
      "search_quality.json": JSON.stringify({ terms: [{ value: "x" }] }),
    },
    onReadFile: (file: string) => reads.push(file),
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(codeRow(h.last()).statusText, "Completed");
  assert.equal(codeRow(h.last()).summary, "");
  assert.equal(codeRow(h.last()).search, undefined);
  assert.deepEqual(
    reads.filter((file) => /related_files|search_quality/.test(file)),
    [],
    "an old artifact was read",
  );
});

test("a run with no context on disk reports no result at all", async () => {
  // The rule that keeps an empty panel empty: the result section exists because
  // `context.md` does, not because a run happened to finish.
  const h = harness({ events: successfulRun, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(reportsContext(h.last()), false);
});

test("a failed run is never crowned with a result", async () => {
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "fetch" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH", message: "refused" } },
    ],
    // Even with a context file left over from an earlier attempt.
    directory: ["task.md", "context.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.last().progress.state, "failed");
  assert.equal(reportsContext(h.last()), false, "a failed run showed Context Ready");
});

test("no result is claimed while the run is still going", async () => {
  // The hard case: the previous run's task.md and context.md were in the
  // listing (the same work item, reopened first), and Build context finishes
  // before the run does. Two things keep Fix with AI from offering the old
  // task meanwhile: the run clears that listing as it starts (Batch 8), and
  // the model's `!running` guard (pinned on its own in workflow.test.ts).
  const h = harness({
    ...PREPARED,
    directory: [...PREPARED.directory, "run.json"],
    files: { ...PREPARED.files, "run.json": PREPARED_RUN_JSON },
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.ok(canFix(h.last()), "the reopened work item offered no handoff to begin with");
  const before = h.states.length;

  await h.controller.run(jiraForm());

  const midRun = h.states.slice(before).filter((state) => state.progress.state === "running");
  assert.ok(midRun.length > 1, "the run pushed no state after a step finished");
  assert.ok(
    midRun.some((state) => buildRow(state).status === "success"),
    "no mid-run push saw Build context finished, so the guard was never exercised",
  );
  for (const state of midRun) {
    // The header is the global status and says the run is going; rows report
    // as their own steps finish, but nothing can be handed over yet.
    assert.equal(state.overall.kind, "running");
    assert.equal(canFix(state), false, "a handoff was offered mid-run");
    assert.notEqual(fixRow(state).status, "ready");
    assert.equal(fixRow(state).artifact, undefined, "the previous run's task.md was offered mid-run");
    assert.deepEqual(state.workItemActions, [], "Open Folder was offered mid-run");
  }
});

test("the Strategy line describes the package, in states that mean different things", async () => {
  // Moved out of the page in UI-A3. "This mode is gone" and "BugPilot could not
  // check" look alike and mean opposite things, so they stay separate here.
  for (const [status, expected] of [
    [statusWith("standard", "Standard Fix"), "Standard Fix"],
    [
      statusWith("investigate-first", "Investigate First", "investigate"),
      "Investigate First · investigation only",
    ],
    // A mode the catalog no longer offers: named, not silently replaced.
    [statusWith("team-safe-fix", "Team Safe Fix"), "Team Safe Fix (unavailable)"],
  ] as const) {
    const h = harness({
      ...PREPARED,
      fixModes: CATALOG,
      directory: [...PREPARED.directory, "run.json"],
      files: { ...PREPARED.files, "run.json": status },
    });
    await h.controller.refreshEnvironment();
    await h.controller.run(jiraForm());
    assert.equal(fixRow(h.last()).strategy, expected);
  }
});

test("a package prepared with no recorded mode carries no Strategy line", async () => {
  const h = harness(PREPARED);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(fixRow(h.last()).strategy, undefined);
});

test("a handoff that already happened closes the door on a second one", async () => {
  // §11: the developer ticked Fix with AI, the run performed it, and the result
  // must not then offer a button that would open a second terminal.
  const h = harness({ ...PREPARED, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ fixWithAI: true }));

  assert.equal(h.terminals.length, 1, "the automatic handoff did not happen exactly once");
  assert.equal(canFix(h.last()), false);
  // The outcome, not a vanished button: a title, a provider-neutral sentence,
  // and the host's own record of which agent it started.
  assert.equal(fixRow(h.last()).statusText, "Started");
  assert.match(fixRow(h.last()).detail ?? "", /Handed to/);
});

test("a run that handed nothing over offers the button", async () => {
  const h = harness(PREPARED);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.terminals.length, 0);
  assert.equal(canFix(h.last()), true);
  assert.notEqual(fixRow(h.last()).status, "success");
});

test("the panel's Fix with AI action is the one the host already performs", async () => {
  // The action has been in PANEL_ACTIONS since phase 5 with nothing on the page
  // sending it. UI-A3 gave it a button; this is the path that button takes.
  const h = harness({ ...PREPARED, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(h.terminals.length, 0);

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(h.terminals.length, 1);
  assert.match(h.terminals[0]!.name, /Fix with AI/);
  assert.equal(canFix(h.last()), false);
});

// --- UI-B1: Relevant Files ---------------------------------------------------

/** The two files the ranker found, as `retrieval.json.related_files` records them. */
const RELATED_ENTRIES = [
  {
    confidence: "medium",
    documentation: false,
    file: "src/widgets/WidgetController.cpp",
    match_count: 3,
    matched_keywords: ["Output", "outputType"],
    noise_flags: [],
    reasons: ["matched keyword in application source path"],
    score: 10,
    snippets: [{ line: 7, text: "void outputType();" }],
  },
  { documentation: true, file: "README.md", matched_keywords: ["restored"], score: 9, snippets: [] },
];

/** A run whose retrieval holds two files the ranker found. */
const WITH_FILES = {
  events: successfulRun,
  directory: ["task.md", "context.md", "retrieval.json"],
  files: {
    "retrieval.json": retrievalJson({ related_files: RELATED_ENTRIES, terms: [{ value: "x" }] }),
  },
};

test("a finished run reports the files it found, in the artifact's order", async () => {
  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const files = codeRow(h.last()).search?.files ?? [];
  assert.deepEqual([...files], [
    {
      path: "src/widgets/WidgetController.cpp",
      name: "WidgetController.cpp",
      documentation: false,
      matched: ["Output", "outputType"],
    },
    { path: "README.md", name: "README.md", documentation: true, matched: ["restored"] },
  ]);
  // Nothing about how the ranking works crossed the boundary.
  for (const file of files) {
    assert.deepEqual(Object.keys(file).sort(), ["documentation", "matched", "name", "path"]);
  }
});

test("a broken file list costs the list, never the result", async () => {
  const h = harness({
    ...WITH_FILES,
    files: { "retrieval.json": retrievalJson({ related_files: "[{ half written", terms: [{ value: "x" }] }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const state = h.last();
  assert.ok(reportsContext(state), "a malformed supplementary artifact took the context with it");
  assert.deepEqual([...(codeRow(state).search?.files ?? [])], []);
  assert.deepEqual([...buildRow(state).actions], ["openContext", "copyContext"]);
});

test("a long list is capped, and says how many it is not showing", async () => {
  // The artifact is bounded by the Max files setting rather than by a constant,
  // so a developer who asked for fifty gets a sidebar that says so.
  const many = Array.from({ length: 14 }, (_, index) => ({ file: `src/f${index}.cpp` }));
  const h = harness({
    ...WITH_FILES,
    files: { "retrieval.json": retrievalJson({ related_files: many, terms: [{ value: "x" }] }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const code = codeRow(h.last());
  assert.equal(code.search?.files.length, 10);
  assert.equal(code.search?.moreFiles, 4);
  // Capping the list does not change what the run found.
  assert.match(code.summary, /· 14 relevant files$/);
});

test("eleven files show ten rows and one more, and still count eleven", async () => {
  // The panel's ten rows are presentation. The retrieval, the count and the
  // agent's context all keep the eleventh file; only the sidebar folds it into
  // the overflow line.
  const eleven = Array.from({ length: 11 }, (_, index) => ({ file: `src/widgets/Part${index}.cpp` }));
  const h = harness({
    ...WITH_FILES,
    files: { "retrieval.json": retrievalJson({ related_files: eleven, terms: [{ value: "x" }] }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const code = codeRow(h.last());
  assert.equal(code.search?.files.length, 10);
  assert.equal(code.search?.files.at(-1)?.path, "src/widgets/Part9.cpp");
  assert.equal(code.search?.moreFiles, 1);
  assert.match(code.summary, /· 11 relevant files$/);
});

test("a run with no files reports an empty list rather than nothing at all", async () => {
  const h = harness({
    ...WITH_FILES,
    files: { "retrieval.json": retrievalJson({ related_files: [], terms: [{ value: "x" }] }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.deepEqual([...(codeRow(h.last()).search?.files ?? [])], []);
  assert.equal(codeRow(h.last()).search?.moreFiles, undefined);
});

test("a failed run carries no files, even with a previous list on disk", async () => {
  const h = harness({
    ...WITH_FILES,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH", message: "refused" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(reportsContext(h.last()), false);
  // Code search never ran this time, so the previous run's list is not its.
  assert.equal(codeRow(h.last()).search, undefined);
});

test("opening a relevant file goes through the editor, resolved against the repository", async () => {
  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({
    type: "openRelevantFile",
    path: "src/widgets/WidgetController.cpp",
  });

  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0], nodePath.resolve(ROOT, "src/widgets/WidgetController.cpp"));
});

test("a path that would leave the repository is refused by the host", async () => {
  // The page checks the shape and `parsePanelMessage` checks it again, but this
  // is the only side that knows where the repository is — so it is the side
  // that has to say no.
  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  for (const escape of [
    "../../outside.txt",
    "src/../../outside.txt",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "..",
  ]) {
    await h.controller.openRelevantFile(escape);
  }

  assert.deepEqual(h.opened, [], "a file outside the repository was opened");
  assert.equal(
    h.logged.filter((line) => /Refusing to open/.test(line)).length,
    5,
    "a refusal went unlogged",
  );
});

test("a relevant file opens even for a work item restored from history", async () => {
  // The list comes from the artifact, so it exists wherever the artifact does —
  // there is no event stream to depend on.
  const h = harness({
    ...WITH_FILES,
    directory: [...WITH_FILES.directory, "run.json"],
    files: { ...WITH_FILES.files, "run.json": PREPARED_RUN_JSON },
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  assert.equal(codeRow(h.last()).status, "success");
  assert.equal(codeRow(h.last()).search?.files.length, 2);
  await h.controller.openRelevantFile("README.md");
  assert.equal(h.opened.at(-1), nodePath.resolve(ROOT, "README.md"));
});

// --- UI-B2: failures, and which state they belong to -------------------------

/** A run that dies the way a Jira credential problem dies. */
const JIRA_REFUSED = [
  { type: "started", work_item_id: "JR-12345", source: "jira" },
  { type: "step_started", step: "fetch" },
  {
    type: "completed",
    ok: false,
    error: { code: "JIRA_AUTH_FAILED", message: "Jira returned HTTP 401 for JR-12345." },
  },
] as readonly StreamEvent[];

test("a failed run is classified, and keeps what the CLI actually said", async () => {
  const h = harness({ events: JIRA_REFUSED, directory: ["task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const error = runErrorOf(h.last());
  assert.equal(error?.kind, "jira-access");
  assert.equal(error?.title, "Unable to access Jira");
  assert.equal(error?.action?.command, COMMANDS.setCredentials);
  // The card is a translation, and the original is still underneath it.
  assert.equal(error?.detail, "Jira returned HTTP 401 for JR-12345.");
});

test("a run that could not find the issue names it", async () => {
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      {
        type: "completed",
        ok: false,
        error: { code: "JIRA_ISSUE_NOT_FOUND", message: "404 for JR-12345" },
      },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(runErrorOf(h.last())?.kind, "jira-not-found");
  assert.match(runErrorOf(h.last())?.message ?? "", /find JR-12345/);
});

test("a failed run has no result and no files to go with it", async () => {
  const h = harness({ ...WITH_FILES, events: JIRA_REFUSED });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.ok(runErrorOf(h.last()), "no error card for a failed run");
  assert.equal(reportsContext(h.last()), false);
  // And the form is untouched, so the developer can fix and press Run again.
  assert.equal(h.last().form?.issueKey, "JR-12345");
  assert.deepEqual(h.last().problems, []);
});

test("a successful run carries no error", async () => {
  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(runErrorOf(h.last()), undefined);
  assert.ok(reportsContext(h.last()));
});

test("a new run clears the error the previous one left", async () => {
  // A stale card beside a Running... button reads as the new run having failed
  // instantly.
  const h = harness({ ...WITH_FILES, events: JIRA_REFUSED });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.ok(runErrorOf(h.last()));

  const before = h.states.length;
  await h.controller.run(jiraForm());
  const midRun = h.states.slice(before).filter((state) => state.progress.state === "running");
  assert.ok(midRun.length > 0, "the second run pushed no state while running");
  for (const state of midRun) assert.equal(runErrorOf(state), undefined);
});

test("a run that succeeds after one that failed shows the result, not the error", async () => {
  // The harness fixes its event list, so the failing attempt is its own
  // harness. What matters is that nothing of a failed run reaches a good one.
  const failing = harness({ ...WITH_FILES, events: JIRA_REFUSED });
  await failing.controller.refreshEnvironment();
  await failing.controller.run(jiraForm());
  assert.ok(runErrorOf(failing.last()));

  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(runErrorOf(h.last()), undefined);
  assert.ok(reportsContext(h.last()));
  assert.ok((codeRow(h.last()).search?.files.length ?? 0) > 0);
});

// --- the other failure: the package is fine, the agent is not ----------------

test("an agent that will not start leaves the whole result standing", async () => {
  // The required acceptance test. Nothing about retrieval went wrong, so making
  // the developer rerun it to fix a PATH problem would be absurd.
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const before = h.last();
  assert.ok(reportsContext(before));

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  const after = h.last();
  assert.equal(runErrorOf(after), undefined, "a handoff failure was reported as a run failure");
  assert.equal(fixRow(after).error?.kind, "agent");
  assert.equal(fixRow(after).error?.title, "AI agent unavailable");
  assert.match(fixRow(after).error?.detail ?? "", /No supported AI agent detected/);
  assert.equal(fixRow(after).error?.action?.command, COMMANDS.openSettings);

  // And the result is exactly what it was.
  // Only Fix with AI failed: every earlier row is exactly what it was.
  assert.ok(reportsContext(after), "the context was cleared by a handoff failure");
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext"] as const) {
    assert.deepEqual(stepOf(after, id), stepOf(before, id), `${id} changed when the handoff failed`);
  }
  assert.equal(fixRow(after).status, "failed");
  assert.equal(fixRow(after).summary, "Did not start");
  // Still offered, because installing an agent and pressing again is real.
  assert.equal(canFix(after), true);
});

test("a handoff that works after one that did not clears the card", async () => {
  // One harness whose PATH answer changes between the two presses, which is
  // what installing an agent looks like from here.
  const options = { ...WITH_FILES, agentOnPath: false };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.ok(fixRow(h.last()).error);

  options.agentOnPath = true;
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(fixRow(h.last()).error, undefined, "the old reason outlived the retry");
  assert.equal(h.terminals.length, 1);
  assert.ok(reportsContext(h.last()));
});

test("a new run clears a handoff error along with everything else", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.ok(fixRow(h.last()).error);

  await h.controller.run(jiraForm());

  assert.equal(fixRow(h.last()).error, undefined);
});

test("neither error follows the developer to another work item", async () => {
  // The cards belong to one bug; opening another is a different subject.
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.ok(fixRow(h.last()).error);

  await h.controller.showWorkItem("JR-999");

  assert.equal(fixRow(h.last()).error, undefined);
  assert.equal(runErrorOf(h.last()), undefined);
});

test("pressing Run with no repository open explains itself once, not twice", async () => {
  // The repository category already exists: `chooseRepoRoot` says "No folder is
  // open. Open the repository you are fixing bugs in.", readiness renders it as
  // the blocked card, and that is also why `run()` refuses. A second card
  // saying the same thing would stack two explanations of one fact.
  const h = harness({
    environment: {
      kind: "no-folder",
      summary: "No folder is open. Open the repository you are fixing bugs in.",
    },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(h.last().readiness.kind, "blocked");
  assert.match(
    (h.last().readiness as { summary: string }).summary,
    /Open the repository you are fixing bugs in/,
  );
  assert.equal(runErrorOf(h.last()), undefined, "a second explanation of the same fact");
  assert.equal(h.streamRuns.length, 0, "a run was started with no repository");
});

// --- UI-B3: the successful handoff -------------------------------------------

test("a manual handoff that works reports itself and keeps everything else", async () => {
  // The acceptance test. Nothing the run produced may be disturbed by an agent
  // starting in a terminal.
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const before = h.last();
  assert.ok(reportsContext(before));
  assert.equal(canFix(before), true, "the button was not on offer before the press");
  assert.equal(fixRow(before).status, "ready");

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  const after = h.last();
  assert.equal(h.terminals.length, 1);
  // The headline names no vendor; the host's own record of the launch does.
  assert.equal(fixRow(after).status, "success");
  assert.equal(fixRow(after).statusText, "Started");
  assert.match(fixRow(after).detail ?? "", /^Handed to .+ in a terminal\.$/);
  assert.equal(canFix(after), false, "a second handoff was still on offer");
  assert.equal(fixRow(after).error, undefined);
  assert.equal(runErrorOf(after), undefined);

  // And every earlier row is exactly what it was.
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext"] as const) {
    assert.deepEqual(stepOf(after, id), stepOf(before, id), `${id} changed when the handoff started`);
  }
  assert.equal(fixRow(after).strategy, fixRow(before).strategy);
});

test("the automatic path lands in the same place as the manual one", async () => {
  // Fix with AI ticked before Run: the run performs the handoff itself, and the
  // developer is not asked to press anything. The final state must not differ.
  const automatic = harness({ ...WITH_FILES, agentOnPath: true });
  await automatic.controller.refreshEnvironment();
  await automatic.controller.run(jiraForm({ fixWithAI: true }));

  const manual = harness({ ...WITH_FILES, agentOnPath: true });
  await manual.controller.refreshEnvironment();
  await manual.controller.run(jiraForm());
  await manual.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(automatic.terminals.length, 1);
  assert.equal(manual.terminals.length, 1);
  assert.deepEqual(fixRow(automatic.last()).status, fixRow(manual.last()).status);
  assert.equal(fixRow(automatic.last()).summary, fixRow(manual.last()).summary);
  assert.equal(fixRow(automatic.last()).detail, fixRow(manual.last()).detail);
  assert.equal(canFix(automatic.last()), false);
});

test("a handoff that started nothing reports no outcome", async () => {
  // A skip is not a quieter success. Nothing was launched, the prompt went to
  // the clipboard, and the button has to come back for the retry.
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(h.terminals.length, 0);
  assert.notEqual(fixRow(h.last()).status, "success");
  assert.equal(canFix(h.last()), true);
  assert.ok(fixRow(h.last()).error, "a skip with no explanation");
});

test("a run that could not finish hands nothing over and claims nothing", async () => {
  // The other kind of skip: the developer ticked Fix with AI and the run died,
  // so there is no package. No result section at all, and no outcome in it.
  const h = harness({
    ...WITH_FILES,
    agentOnPath: true,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ fixWithAI: true }));

  assert.equal(h.terminals.length, 0);
  assert.equal(reportsContext(h.last()), false);
  assert.ok(runErrorOf(h.last()));
});

test("a retry that works clears the failure and reports the success", async () => {
  // The whole lifecycle in one test: fail, explain, retry, succeed — with
  // Context Ready standing throughout.
  const options = { ...WITH_FILES, agentOnPath: false };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const prepared = h.last();
  assert.ok(reportsContext(prepared));

  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.ok(fixRow(h.last()).error);
  assert.notEqual(fixRow(h.last()).status, "success");
  assert.ok(reportsContext(h.last()), "the context went away with the failure");

  options.agentOnPath = true;
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  const after = h.last();
  assert.equal(fixRow(after).error, undefined, "a stale failure survived the retry");
  assert.equal(fixRow(after).statusText, "Started");
  assert.deepEqual(codeRow(after), codeRow(prepared));
  assert.equal(h.terminals.length, 1, "the failed attempt left a terminal behind");
});

test("success and a failure card are never both on screen", async () => {
  // The state consistency this phase has to keep: one handoff, one answer.
  const options = { ...WITH_FILES, agentOnPath: false };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  options.agentOnPath = true;
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  for (const state of h.states) {
    const both = fixRow(state).status === "success" && fixRow(state).error !== undefined;
    assert.equal(both, false, "a success and a failure were reported at once");
  }
});

test("a new run clears the outcome the previous one reached, and keeps the session it started", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.equal(fixRow(h.last()).status, "success");

  const before = h.states.length;
  await h.controller.run(jiraForm());

  const midRun = h.states.slice(before).filter((state) => state.progress.state === "running");
  assert.ok(midRun.length > 0);
  for (const state of midRun) {
    assert.equal(state.overall.kind, "running");
    assert.notEqual(fixRow(state).status, "success", "the last run's outcome showed on this one");
    assert.equal(canFix(state), false, "a handoff was offered mid-run");
    assert.equal(state.primary.busy, true);
  }
  // The package is rebuilt, and the agent the first press started is still the
  // one working on this work item: the next step is to go back to it — or to
  // start another on purpose — never Fix with AI as if nothing had started.
  assert.equal(canFix(h.last()), false, "a second agent was offered for a work item one is working on");
  assert.equal(h.last().primary.action, "openSession");
  assert.deepEqual(h.last().primary.more, ["startNewAttempt", "rebuildContext"]);
  assert.equal(fixRow(h.last()).status, "success");
  assert.equal(fixRow(h.last()).detail, "Handed to Claude CLI in a terminal.");
  assert.equal(h.terminals.length, 1, "rebuilding the context handed it over again");
});

test("the outcome does not follow the developer to another work item", async () => {
  // Both directories hold a finished package (this harness shares one listing),
  // so the second item is ready to hand over — and nothing says it was.
  const h = harness({
    ...WITH_FILES,
    agentOnPath: true,
    directory: [...WITH_FILES.directory, "run.json"],
    files: { ...WITH_FILES.files, "run.json": PREPARED_RUN_JSON },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.equal(fixRow(h.last()).status, "success");

  await h.controller.showWorkItem("JR-999");

  assert.notEqual(fixRow(h.last()).status, "success");
  assert.equal(canFix(h.last()), true);
});

test("the button says it is working while the agent is being resolved", async () => {
  // Resolving spawns a probe per candidate, so the press is not instant. The
  // flag is on while that happens and off however it ends.
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const before = h.states.length;

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  const during = h.states.slice(before).filter((state) => fixRow(state).status === "running");
  assert.ok(during.length > 0, "the handoff never said it was working");
  // Never both: a busy state is not an outcome.
  for (const state of during) assert.notEqual(fixRow(state).status, "success");
  assert.notEqual(fixRow(h.last()).status, "running");
});

test("the busy flag clears even when the handoff cannot start", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.notEqual(fixRow(h.last()).status, "running");
  assert.ok(fixRow(h.last()).error);
});

// --- the freeze pass: an error card's button must actually do something ------

test("the Set Jira Credentials button on a failed run reaches the command", async () => {
  // UI-B2 gave the error cards an action and routed it through the same
  // `{type:"command"}` path the blocked card uses — but that path only accepts
  // ids the host offered in `readiness.actions`, which an error card's action
  // never entered. The page posted the message and the host refused it, so the
  // button did nothing at all.
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const action = runErrorOf(h.last())?.action;
  assert.ok(action, "the card offered no action to press");

  await h.controller.handle({ type: "command", id: action.command });

  assert.deepEqual(h.ranCommands, [COMMANDS.setCredentials]);
  assert.equal(
    h.logged.some((line) => /Refusing to run a command/.test(line)),
    false,
    "the host refused the command it had just offered",
  );
});

test("a card on the row that failed still reaches its command", async () => {
  // Batch 6 moved a failure onto the row whose step was in flight and out of
  // `runError`. The offer is the card being on screen, wherever the page put
  // it, so moving it must neither drop the offer nor show the card twice.
  const h = harness({
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "step_started", step: "fetch" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const state = h.last();
  assert.equal(state.runError, undefined, "an owned failure was also shown on its own");
  const action = stepOf(state, "issueDetails").error?.action;
  assert.ok(action, "the row's card offered no action to press");

  await h.controller.handle({ type: "command", id: action.command });

  assert.deepEqual(h.ranCommands, [COMMANDS.setCredentials]);
});

test("the Open Settings button on a handoff failure reaches the command", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  const action = fixRow(h.last()).error?.action;
  assert.ok(action, "the card offered no action to press");

  await h.controller.handle({ type: "command", id: action.command });

  assert.deepEqual(h.ranCommands, [COMMANDS.openSettings]);
});

test("a command the host never offered is still refused", async () => {
  // The reason the allow-list exists: a webview naming an arbitrary editor
  // command is a privilege it must not have. Widening it for the error cards
  // must not widen it for anything else.
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  for (const id of [
    "workbench.action.terminal.new",
    COMMANDS.clearCredentials,
    COMMANDS.setCredentials,
  ]) {
    await h.controller.handle({ type: "command", id });
  }

  assert.deepEqual(h.ranCommands, [], "an unoffered command was executed");
  assert.equal(h.logged.filter((line) => /Refusing to run a command/.test(line)).length, 3);
});

test("an offer expires with the card that made it", async () => {
  // The offer is the card being on screen. Once a retry clears the failure,
  // the id it carried is no longer one the page may ask for.
  const options = { ...WITH_FILES, agentOnPath: false };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.ok(fixRow(h.last()).error);

  options.agentOnPath = true;
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.equal(fixRow(h.last()).error, undefined);

  await h.controller.handle({ type: "command", id: COMMANDS.openSettings });

  assert.deepEqual(h.ranCommands, [], "a withdrawn offer was still honoured");
});

// --- UI-C1: the terms the host reads back ------------------------------------

/** A run whose retrieval records what each term did. */
const WITH_TERMS = {
  ...WITH_FILES,
  files: {
    "retrieval.json": retrievalJson({
      related_files: RELATED_ENTRIES,
      terms: [
        {
          value: "WidgetController",
          source: "user",
          weight: 8,
          effective_weight: 8,
          match_count: 18,
          classification: "specific",
          derived_from: "",
          status: "retained",
        },
        {
          value: "outputType",
          source: "shape_expansion",
          weight: 5,
          effective_weight: 5,
          match_count: 7,
          classification: "specific",
          derived_from: "output type",
          status: "retained",
        },
        {
          value: "validation",
          source: "hint",
          weight: 4,
          effective_weight: 1,
          match_count: 821,
          classification: "broad",
          derived_from: "",
          status: "retained",
        },
      ],
    }),
  },
};

test("a finished run reports the terms it searched, in the artifact's order", async () => {
  const h = harness(WITH_TERMS);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const terms = codeRow(h.last()).search?.terms ?? [];
  assert.deepEqual([...terms], [
    { term: "WidgetController", source: "User keyword", lines: 18, broad: false, empty: false },
    {
      term: "outputType",
      source: "Shape expansion",
      lines: 7,
      broad: false,
      empty: false,
      derivedFrom: "output type",
    },
    { term: "validation", source: "Hint", lines: 821, broad: true, empty: false },
  ]);
  // And nothing of the ranker's arithmetic crossed the boundary.
  for (const term of terms) {
    assert.equal("weight" in term, false);
    assert.equal("effectiveWeight" in term, false);
  }
});

test("a broken terms list costs the terms, never the result", async () => {
  const h = harness({
    ...WITH_TERMS,
    files: { "retrieval.json": retrievalJson({ related_files: RELATED_ENTRIES, terms: "{ half written" }) },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const code = codeRow(h.last());
  assert.ok(reportsContext(h.last()), "a malformed supplementary artifact took the context with it");
  assert.deepEqual([...(code.search?.terms ?? [])], []);
  // The file list is the other half of the same artifact, and is untouched.
  assert.ok((code.search?.files.length ?? 0) > 0);
});

test("a failed run carries no terms, even with an artifact on disk", async () => {
  const h = harness({
    ...WITH_TERMS,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.equal(reportsContext(h.last()), false);
  assert.equal(codeRow(h.last()).search, undefined);
});

test("the terms do not follow the developer to another work item", async () => {
  const h = harness(WITH_TERMS);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(codeRow(h.last()).search?.terms.length, 3);

  await h.controller.showWorkItem("JR-999");

  // A different bug, read from its own directory. This one has no run.json, so
  // nothing says its search ran: no terms follow it from the previous item.
  assert.equal(codeRow(h.last()).status, "idle");
  assert.equal(codeRow(h.last()).search, undefined);
});

test("a handoff leaves the terms exactly where they were", async () => {
  // Retrieval describes preparing the context, not what an agent did with it.
  const h = harness({ ...WITH_TERMS, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const before = codeRow(h.last()).search?.terms ?? [];

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(fixRow(h.last()).status, "success", "the handoff did not happen");
  assert.deepEqual([...(codeRow(h.last()).search?.terms ?? [])], [...before]);
});

test("a handoff that could not start leaves them too", async () => {
  const h = harness({ ...WITH_TERMS, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  const before = codeRow(h.last()).search?.terms ?? [];

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.ok(fixRow(h.last()).error);
  assert.deepEqual([...(codeRow(h.last()).search?.terms ?? [])], [...before]);
});

test("the artifact is read once for the counts, the files and the terms", async () => {
  // `retrieval.json` answers three questions — how many, which files, which
  // terms — and reading it per question would be three syscalls for one file.
  const reads: string[] = [];
  const h = harness({
    ...WITH_TERMS,
    onReadFile: (file: string) => reads.push(file),
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const retrieval = reads.filter((file) => file.endsWith("retrieval.json"));
  assert.equal(retrieval.length, 1, `retrieval.json was read ${retrieval.length} times`);
});

// --- UI-C2: Diagnostics ------------------------------------------------------

// What Results > Diagnostics shows (§37.110): the controller's own getter,
// which the tree reads; the panel's state no longer carries it.
const rowOf = (h: Harness, label: string) =>
  h.controller.diagnostics.rows.find((row) => row.label === label);

test("a ready environment reports itself without being asked anything", async () => {
  const h = harness({ extensionVersion: "0.1.0" });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Repository")?.value, "app");
  assert.equal(rowOf(h, "Repository")?.detail, ROOT);
  assert.equal(rowOf(h, "Jira")?.value, "Configured");
  assert.equal(rowOf(h, "AI agent")?.value, "Auto-detect");
  assert.equal(rowOf(h, "AI agent")?.detail, "Not checked yet");
  assert.equal(rowOf(h, "Extension")?.value, "0.1.0");
  assert.equal(rowOf(h, "Work item"), undefined, "nothing has run");
});

test("opening the panel probes nothing", async () => {
  // The rule this section is built around. Diagnostics reports state the host
  // already holds, so the counters that would move if it checked anything are
  // exactly the ones that must not.
  const h = harness();
  await h.controller.refreshEnvironment();
  const before = {
    streams: h.streamRuns.length,
    json: h.jsonRuns.length,
    probes: h.probed.length,
    terminals: h.terminals.length,
  };

  // Every way the page can cause a render, short of asking for work.
  await h.controller.handle({ type: "ready" });
  await h.controller.handle({ type: "formChanged", form: jiraForm() });

  assert.ok(h.controller.diagnostics.rows.length > 0, "Diagnostics reported nothing");
  assert.equal("diagnostics" in h.last(), false, "the panel is sent Diagnostics it no longer shows");
  assert.deepEqual(
    {
      streams: h.streamRuns.length,
      json: h.jsonRuns.length,
      probes: h.probed.length,
      terminals: h.terminals.length,
    },
    before,
    "Diagnostics caused work to happen",
  );
});

test("no repository is said plainly rather than left blank", async () => {
  const h = harness({
    environment: { kind: "no-folder", summary: "No folder is open. Open the repository you are fixing bugs in." },
  });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Repository")?.value, "No repository open");
  assert.equal(rowOf(h, "Repository")?.detail, undefined);
  // And the blocked card remains the thing that stops a run.
  assert.equal(h.last().readiness.kind, "blocked");
});

test("the agent row follows the selection", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "formChanged", form: jiraForm({ agent: "custom", agentCommand: "my-agent --prompt {prompt} --token abc123" }) });

  assert.equal(rowOf(h, "AI agent")?.value, "Custom command");
  // The command line can carry a path, an argument or a token. None of it is
  // anywhere in the diagnostics model.
  const text = JSON.stringify(h.controller.diagnostics);
  assert.equal(text.includes("abc123"), false, "a custom command reached Diagnostics");
  assert.equal(text.includes("my-agent"), false);
});

test("the resolved agent appears only once a handoff has resolved one", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(rowOf(h, "AI agent")?.detail, "Not checked yet");

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(rowOf(h, "AI agent")?.detail, "Resolved: Claude CLI");
});

test("a handoff that found nothing says so, without guessing why", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: false });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(rowOf(h, "AI agent")?.detail, "Resolved: none available");
});

test("the work item row follows the run", async () => {
  const h = harness(WITH_FILES);
  await h.controller.refreshEnvironment();
  assert.equal(rowOf(h, "Work item"), undefined);

  await h.controller.run(jiraForm());

  assert.equal(rowOf(h, "Work item")?.value, "JR-12345");
  assert.equal(rowOf(h, "Work item")?.detail, "From a Jira issue");
});

test("a hand-written bug is named by the id the CLI minted", async () => {
  // Never by its description, which is the bug report and not an identity.
  const h = harness({
    ...WITH_FILES,
    events: [
      { type: "started", work_item_id: "local_20260101120000", source: "manual" },
      { type: "completed", ok: true },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(
    jiraForm({ source: "manual", issueKey: "", description: "The export dialog crashes on save." }),
  );

  assert.equal(rowOf(h, "Work item")?.value, "local_20260101120000");
  assert.equal(rowOf(h, "Work item")?.detail, "From a bug description");
  assert.equal(
    JSON.stringify(h.controller.diagnostics).includes("export dialog"),
    false,
    "the bug's own text reached Diagnostics",
  );
});

test("Jira follows the credential, and claims nothing more", async () => {
  const h = harness({ credentialsConfigured: false });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Jira")?.value, "Not configured");
  // The Workflow row says the same, with the action to fix it.
  assert.equal(h.last().jira.status, "Not configured");
  assert.equal(h.last().jira.action, "Configure");
  // Never a claim about Jira itself, which nobody has contacted.
  const text = JSON.stringify(h.controller.diagnostics);
  for (const claim of ["Connected", "Healthy", "Online", "Verified"]) {
    assert.equal(text.includes(claim), false, `Diagnostics claims "${claim}"`);
  }
});

test("no credential material is anywhere in the model", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const text = JSON.stringify(h.controller.diagnostics);
  for (const secret of [TOKEN, "JIRA_TOKEN", "JIRA_EMAIL", "me@example.com", "Bearer"]) {
    assert.equal(text.includes(secret), false, `Diagnostics carries ${secret}`);
  }
});

// --- The Jira row's states (§37.110) -------------------------------------------

const AUTH_REJECTED: readonly StreamEvent[] = [
  { type: "started", work_item_id: "JR-12345", source: "jira" },
  { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
];

test("the Jira row: Configured with Replace, Not configured with Configure", async () => {
  const configured = harness();
  await configured.controller.refreshEnvironment();
  assert.deepEqual(
    [configured.last().jira.state, configured.last().jira.status, configured.last().jira.action],
    ["configured", "Configured", "Replace"],
  );
  const missing = harness({ credentialsConfigured: false });
  await missing.controller.refreshEnvironment();
  assert.deepEqual(
    [missing.last().jira.state, missing.last().jira.status, missing.last().jira.action],
    ["notConfigured", "Not configured", "Configure"],
  );
  // Never the credential itself.
  const text = JSON.stringify(configured.last().jira);
  for (const secret of [TOKEN, "me@example.com"]) assert.equal(text.includes(secret), false);
});

test("Jira turning the credentials away is Authentication failed, until they are saved again", async () => {
  const h = harness({ events: AUTH_REJECTED });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(h.last().jira.state, "authFailed");
  assert.equal(h.last().jira.status, "Authentication failed");
  assert.equal(h.last().jira.action, "Replace");
  assert.equal(rowOf(h, "Jira")?.value, "Authentication failed", "Diagnostics disagrees with the row");
  // The run-blocking card stays in Workflow, with its own way to fix it.
  const card = h.last().workflow.find((step) => step.id === "issueDetails")?.error ?? h.last().runError;
  assert.equal(card?.title, "Unable to access Jira");
  assert.equal(card?.action?.command, "bugpilot.setCredentials");

  // The credential prompt saved new ones: what Jira said about the old ones is over.
  await h.controller.credentialsSaved();
  assert.equal(h.last().jira.state, "configured");
  assert.equal(rowOf(h, "Jira")?.value, "Configured");
});

test("a Jira run that gets its issue clears Authentication failed; one that never asked Jira does not", async () => {
  const options: { events: readonly StreamEvent[] } = { events: AUTH_REJECTED };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(h.last().jira.state, "authFailed");

  // A hand-written bug asks Jira nothing, so says nothing about the credentials.
  options.events = [
    { type: "started", work_item_id: "local_20260101120000", source: "manual" },
    { type: "completed", ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } },
  ];
  await h.controller.run(jiraForm({ source: "manual", issueKey: "", description: "The export dialog crashes." }));
  assert.equal(h.last().jira.state, "authFailed", "a run that never asked Jira cleared it");

  // A Jira run whose issue came back: the credentials work.
  options.events = successfulRun;
  await h.controller.run(jiraForm());
  assert.equal(h.last().jira.state, "configured");
});

test("Results > Diagnostics follows the controller, and the panel's Jira row agrees with it", async () => {
  const h = harness({ ...WITH_FILES, extensionVersion: "0.1.0", events: AUTH_REJECTED });
  await h.controller.refreshEnvironment();
  const tree = resultsOver(h, new Set());
  assert.deepEqual(await tree.root(), ["Current", "History", "Diagnostics"]);
  const before = await tree.diagnostics();
  assert.ok(before.includes("Jira: Configured"), JSON.stringify(before));
  assert.ok(before.includes("Extension: 0.1.0"));
  assert.ok(before.includes(`Repository: ${nodePath.basename(ROOT)}`));

  await h.controller.run(jiraForm());
  const after = await tree.diagnostics();
  assert.ok(after.includes("Jira: Authentication failed"), JSON.stringify(after));
  assert.ok(after.includes("Work item: JR-12345"));
  assert.equal(h.last().jira.status, "Authentication failed");
});

test("both versions are reported, and they are not the same field", async () => {
  const h = harness({ extensionVersion: "0.2.0" });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Extension")?.value, "0.2.0");
  // The CLI's own, from the environment probe that already ran.
  assert.ok(rowOf(h, "BugPilot CLI"), "the CLI row is missing");
  assert.equal(rowOf(h, "BugPilot CLI")?.detail, "bugpilot");
});

// --- Batch 6 review: a History switch never shows the last item's results ----

const issueJson = (id: string, title: string) =>
  JSON.stringify({ schema_version: 1, id, source: "jira", title });

/**
 * Two work items restored from History, each with its own issue on disk.
 *
 * `directory` and `directoryError` are read live by the harness, so a test can
 * make the second item's folder unreadable after the first one was shown.
 */
function twoWorkItems() {
  const options: { directory?: readonly string[]; directoryError?: string; files: Record<string, string> } = {
    directory: ["issue.json", "retrieval.json", "context.md", "task.md", "run.json"],
    files: {
      [nodePath.join("JR-1", "issue.json")]: issueJson("JR-1", "Title of one"),
      [nodePath.join("JR-1", "retrieval.json")]: retrievalJson({ related_files: RELATED_ENTRIES, terms: [{ value: "x" }] }),
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-2", "issue.json")]: issueJson("JR-2", "Title of two"),
      [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
    },
  };
  return { options, h: harness(options) };
}

/** Whatever a state says about JR-1 on the rows that report an issue or a search. */
const mentionsFirst = (state: PanelState) => {
  const issue = stepOf(state, "issueDetails");
  const code = codeRow(state);
  return (
    /JR-1\b|Title of one/.test(`${issue.summary} ${issue.detail ?? ""}`) ||
    (code.search?.files.length ?? 0) > 0 ||
    code.summary !== ""
  );
};

test("a reopened work item's rows name that work item", async () => {
  const { h } = twoWorkItems();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  // One line, the issue's own title (§37.104).
  assert.equal(stepOf(h.last(), "issueDetails").summary, "Title of one");
  assert.equal(stepOf(h.last(), "issueDetails").detail, undefined);
  assert.equal(codeRow(h.last()).search?.files.length, 2);
});

test("switching work items never shows the previous one's issue or search, even for a push", async () => {
  // `refreshArtifacts` pushes a loading state before it reads anything. That
  // push used to carry JR-1's issue and files on JR-2's rows.
  const { h } = twoWorkItems();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");
  const before = h.states.length;

  await h.controller.showWorkItem("JR-2");

  const pushed = h.states.slice(before);
  assert.ok(pushed.length > 1, "the switch pushed no intermediate state");
  for (const state of pushed) {
    assert.equal(mentionsFirst(state), false, `a push during the switch named JR-1: ${stepOf(state, "issueDetails").summary}`);
  }
  assert.equal(stepOf(h.last(), "issueDetails").summary, "Title of two");
  assert.equal(stepOf(h.last(), "issueDetails").detail, undefined);
});

test("an unreadable folder leaves nothing of the previous work item on the rows", async () => {
  const { options, h } = twoWorkItems();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  options.directoryError = "EACCES: permission denied";
  await h.controller.showWorkItem("JR-2");

  assert.equal(h.last().artifacts.kind, "error");
  assert.equal(mentionsFirst(h.last()), false, "JR-1's results were left on JR-2's rows");
});

// --- Batch 8: Fix result, from fix_report.md --------------------------------

/** The report an agent leaves, in the shape `task.md` asks for. */
const fixReportMd = (summary: string, tests: string) =>
  `# Fix Report: JR-1\n\n## Summary\n\n${summary}\n\n## Analysis\n\nWhy.\n\n## Changes\n\nWhat.\n\n## Tests\n\n${tests}\n\n## Review Notes\n\nNone.\n`;

const PREPARED_FILES = ["issue.json", "retrieval.json", "context.md", "task.md", "run.json"];

/**
 * Two restored work items: JR-1 with a report, JR-2 without one.
 *
 * `directory` is read live by the harness, so a test can move between them.
 */
function reportedAndNot() {
  const options: { directory?: readonly string[]; directoryError?: string; files: Record<string, string> } = {
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-1", "fix_report.md")]: fixReportMd(
        "Investigation complete; no source changes applied.",
        "Not run: investigation-only mode.",
      ),
      [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
    },
  };
  return { options, h: harness(options) };
}

const fixResultOf = (state: PanelState) => state.workflow.find((step) => step.id === "fixResult");

test("a reopened work item with a report rebuilds Fix result from the file alone", () => {
  // No handoff happened in this session — handoff state is never persisted —
  // and the row comes back anyway, because the file is the source.
  const { h } = reportedAndNot();
  return (async () => {
    await h.controller.refreshEnvironment();
    await h.controller.showWorkItem("JR-1");

    const row = fixResultOf(h.last());
    assert.ok(row, "no Fix result row for a work item with a report");
    assert.equal(row.status, "ready");
    assert.equal(row.summary, "Investigation complete; no source changes applied.");
    assert.equal(row.detail, "Tests: Not run: investigation-only mode.");
    assert.equal(row.artifact, "fix_report.md");
    assert.equal(h.last().overall.text, "Fix report available");
    // And Fix with AI is what task.md says it is, independent of the report.
    assert.equal(fixRow(h.last()).status, "ready");
    // Nothing but the two lines crossed into the state: not the Analysis, not
    // the Changes, not the report.
    const sent = JSON.stringify(h.last());
    assert.equal(sent.includes("## Analysis"), false);
    assert.equal(sent.includes("Why."), false);
  })();
});

test("switching to a work item without a report never shows the last one's Fix result", async () => {
  // The stale-state bug Batch 6 found, for the seventh row: `refreshArtifacts`
  // pushes before it reads, and that push must not carry JR-1's report.
  const { options, h } = reportedAndNot();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");
  assert.ok(fixResultOf(h.last()));
  const before = h.states.length;

  options.directory = PREPARED_FILES;
  await h.controller.showWorkItem("JR-2");

  const pushed = h.states.slice(before);
  assert.ok(pushed.length > 1, "the switch pushed no intermediate state");
  for (const state of pushed) {
    assert.equal(fixResultOf(state), undefined, "a push during the switch carried JR-1's report");
    assert.notEqual(state.overall.text, "Fix report available");
  }
  // The listing decides what every row offers, so the push before JR-2's
  // listing is read offers none of JR-1's files either.
  const loading = pushed[0]!;
  assert.deepEqual([...buildRow(loading).actions], [], "JR-1's context actions were offered on JR-2");
  assert.deepEqual([...loading.workItemActions], []);
});

test("an unreadable folder after a reported work item leaves no Fix result behind", async () => {
  const { options, h } = reportedAndNot();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  options.directoryError = "EACCES: permission denied";
  await h.controller.showWorkItem("JR-2");

  assert.equal(fixResultOf(h.last()), undefined);
});

test("a run never offers the last listing's report, while it runs or as it finishes", async () => {
  // A fresh re-run deletes fix_report.md, and a run on another key never had
  // one. Until the run ends and the folder is read again, the listing is the
  // old one — so no push from the run's start on may carry its report: not
  // mid-run, not the push at `completed`, not the loading push after it.
  const options: { events: readonly StreamEvent[]; directory: readonly string[]; files: Record<string, string> } = {
    events: successfulRun,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("Fixed it last time.", "12 passed."),
    },
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.ok(fixResultOf(h.last()), "the reopened work item had no report to begin with");
  const before = h.states.length;

  // The fresh run removes the report; the harness lists what the CLI leaves.
  options.directory = PREPARED_FILES;
  await h.controller.run(jiraForm({ fresh: true }));

  const pushed = h.states.slice(before);
  assert.ok(pushed.some((state) => state.progress.state === "done"), "the run never finished");
  for (const state of pushed) {
    assert.equal(fixResultOf(state), undefined, `a ${state.progress.state} push carried the old report`);
    assert.notEqual(state.overall.text, "Fix report available");
  }
});

test("a re-run of the same work item keeps its Fix result row, start to finish", async () => {
  // Not Fresh, same key: the CLI keeps fix_report.md (the retry flow reads
  // it), so the file is there throughout and so is its row.
  const h = harness({
    events: successfulRun,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it last time.", "12 passed.") },
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  const before = h.states.length;

  await h.controller.run(jiraForm());

  const pushed = h.states.slice(before);
  assert.ok(pushed.some((state) => state.progress.state === "running"));
  assert.ok(pushed.some((state) => state.progress.state === "done"));
  for (const state of pushed) {
    assert.equal(fixResultOf(state)?.summary, "Fixed it last time.", `a ${state.progress.state} push lost the report`);
    // Only the report survives the run's start: nothing else of the old
    // listing is offered while the new package is written.
    if (state.progress.state === "running") {
      assert.deepEqual([...buildRow(state).actions], [], "the old context was offered mid-run");
      assert.equal(canFix(state), false);
      // Five chosen steps (Fix with AI unticked); the report adds none.
      assert.match(state.overall.text, /^Running \d\/5…$/);
    }
  }
});

test("a run on another work item never shows the previous item's report", async () => {
  const options: { events: readonly StreamEvent[]; directory: readonly string[]; files: Record<string, string> } = {
    events: successfulRun,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-1", "fix_report.md")]: fixReportMd("JR-1's report.", "1 passed."),
      "run.json": PREPARED_RUN_JSON,
    },
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");
  assert.ok(fixResultOf(h.last()));
  const before = h.states.length;

  options.directory = PREPARED_FILES;
  await h.controller.run(jiraForm());

  for (const state of h.states.slice(before)) {
    assert.equal(fixResultOf(state), undefined, `a ${state.progress.state} push showed JR-1's report on JR-12345`);
  }
});

test("a hand-written bug never shows the previous work item's report", async () => {
  // Its id arrives with the `started` event: until then there is no work item,
  // and after it, a new one — neither owns the report that was on screen.
  const options: { events: readonly StreamEvent[]; directory: readonly string[]; files: Record<string, string> } = {
    events: [
      { type: "started", work_item_id: "local_20260904160612", source: "manual" },
      ...successfulRun.filter((event) => event.type !== "started"),
    ],
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("JR-12345's report.", "1 passed."),
    },
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.ok(fixResultOf(h.last()));
  const before = h.states.length;

  options.directory = PREPARED_FILES;
  await h.controller.run(jiraForm({ source: "manual", issueKey: "", description: "crash on save" }));

  for (const state of h.states.slice(before)) {
    assert.equal(fixResultOf(state), undefined, `a ${state.progress.state} push showed the previous item's report`);
  }
});

test("a report listed but unreadable is still a Fix result to open", async () => {
  // readFile gives undefined for a file that vanished or cannot be read.
  const h = harness({ directory: [...PREPARED_FILES, "fix_report.md"], files: { "run.json": PREPARED_RUN_JSON } });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  const row = fixResultOf(h.last());
  assert.ok(row);
  assert.equal(row.statusText, "Report available");
  assert.equal(row.summary, "");
  assert.equal(row.detail, "Preview unavailable");
  assert.equal(h.last().progress.state === "failed", false, "an unreadable preview became a run failure");
  assert.equal(h.last().runError, undefined);
});

test("a report that appears later is picked up by the next refresh, and not before", async () => {
  // No watcher and no polling: the row reflects the listing the host last
  // read. The Refresh button (bugpilot.refreshViews) is one of the reads.
  const options: { directory?: readonly string[]; files: Record<string, string> } = {
    directory: PREPARED_FILES,
    files: { "run.json": PREPARED_RUN_JSON },
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(fixResultOf(h.last()), undefined);

  // The agent writes its report; nothing re-reads the folder yet.
  options.directory = [...PREPARED_FILES, "fix_report.md"];
  h.files["fix_report.md"] = fixReportMd("Fixed the output-type validation.", "24 passed.");
  await h.controller.handle({ type: "ready" });
  assert.equal(fixResultOf(h.last()), undefined, "a state push re-read the folder");

  await h.controller.refreshArtifacts();
  assert.equal(fixResultOf(h.last())?.summary, "Fixed the output-type validation.");
  assert.equal(fixResultOf(h.last())?.detail, "Tests: 24 passed.");
});

test("Open Fix Report opens fix_report.md in the current work item, and nothing else", async () => {
  const { h } = reportedAndNot();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const message = parsePanelMessage({ type: "openArtifact", name: fixResultOf(h.last())!.artifact });
  assert.ok(message);
  await h.controller.handle(message);
  assert.equal(h.opened.at(-1), nodePath.join(ROOT, ".ai", "JR-1", "fix_report.md"));

  // What a page could try instead never reaches a file open.
  const before = h.opened.length;
  for (const name of ["../fix_report.md", "subdir/fix_report.md", "..\\fix_report.md", "/etc/passwd", "C:/Windows/win.ini", ".."]) {
    const parsed = parsePanelMessage({ type: "openArtifact", name });
    assert.equal(parsed, undefined, `the message parser accepted ${name}`);
    await h.controller.openArtifact(name);
  }
  assert.equal(h.opened.length, before, "a path outside the work item was opened");
});

// --- Batch 9: Fix result's review aids ----------------------------------------

const REVIEW_PROMPT = "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n";

/** What `review-package --json` answers for a work item with a report. */
const REVIEW_PACKAGE: Envelope = {
  ok: true,
  command: "review-package",
  warnings: [],
  work_item_id: "JR-12345",
  prompt: REVIEW_PROMPT,
  validation: {
    steps: ["Reproduce the original issue if possible.", "Confirm the failure no longer occurs."],
    regression_files: ["src/widgets/WidgetController.cpp"],
    review_risks: ["- The legacy VDS path is untested."],
  },
};

/** A reopened work item with a report, and whatever the CLI is to answer. */
const reviewable = (json: HarnessOptions["json"] = REVIEW_PACKAGE, directory: readonly string[] = [...PREPARED_FILES, "fix_report.md"]) =>
  harness({
    directory,
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
    json,
  });

const reviewRuns = (h: Harness) => h.jsonRuns.filter((run) => run.args[0] === "review-package");

test("with no report there is nothing to copy or load, and the host refuses both", async () => {
  const h = reviewable(REVIEW_PACKAGE, PREPARED_FILES);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(fixResultOf(h.last()), undefined);

  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  await h.controller.handle({ type: "action", id: "loadValidation" });

  assert.deepEqual(reviewRuns(h), [], "a review aid ran without a report");
  assert.deepEqual(h.clipboard, []);
  assert.equal(h.logged.filter((line) => /Refusing to (copy a review prompt|load a validation checklist)/.test(line)).length, 2);
});

test("a report offers Copy Review Prompt and Review with AI, after Open Fix Report", async () => {
  const h = reviewable();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI", "pasteReviewOutput", "recordReviewResult", "recordVerification"]);
  // Nothing is run until somebody asks.
  assert.deepEqual(reviewRuns(h), []);
});

test("Copy Review Prompt copies exactly what review-package printed, and does nothing else", async () => {
  const h = reviewable();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  const before = h.states.length;

  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });

  assert.deepEqual(reviewRuns(h).map((run) => [...run.args]), [["review-package", "JR-12345", "--json"]]);
  assert.equal(reviewRuns(h)[0]!.options.cwd, ROOT);
  assert.deepEqual(h.clipboard, [REVIEW_PROMPT]);
  assert.ok(h.notices.some((notice) => notice.kind === "info" && notice.message.startsWith("Review prompt copied.")));
  // The button waited while the CLI worked, and not after.
  assert.ok(h.states.slice(before).some((state) => fixResultOf(state)?.copyingReviewPrompt === true));
  assert.equal(fixResultOf(h.last())?.copyingReviewPrompt, undefined);
  // No review ran, nothing was written, launched, posted or pushed.
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.terminals, []);
  assert.deepEqual(h.streamRuns, []);
  assert.deepEqual(h.ranCommands, []);
  assert.deepEqual(h.probed, [], "an agent was looked for");
  // And nothing about the row or the run says reviewed.
  assert.equal(fixResultOf(h.last())?.summary, "Fixed it.");
  assert.equal(h.last().overall.text, "Fix report available");
  assert.equal(JSON.stringify(h.last()).includes("Reviewed"), false);
});

test("a review prompt that cannot be prepared is said once, and changes nothing else", async () => {
  const h = reviewable({ ok: false, command: "review-package", error: { code: "WORK_ITEM_NOT_FOUND", message: "Work item not found: .ai/JR-12345/" } });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  const rowBefore = fixResultOf(h.last());

  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });

  assert.deepEqual(h.clipboard, []);
  const errors = h.notices.filter((notice) => notice.kind === "error");
  assert.equal(errors.length, 1, "the failure was said more than once");
  assert.match(errors[0]!.message, /^Could not prepare the review prompt: Work item not found/);
  const row = fixResultOf(h.last());
  assert.equal(row?.summary, rowBefore?.summary);
  assert.equal(row?.copyingReviewPrompt, undefined);
  assert.equal(row?.error, undefined, "a secondary failure became the row's failure");
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().runError, undefined);
  assert.equal(fixRow(h.last()).status, "ready", "Fix with AI changed");
});

test("a review prompt for a work item that is no longer shown is never copied", async () => {
  // A on screen, Copy pressed, B opened before the CLI answers: A's prompt must
  // not reach the clipboard, and B must not hear about it.
  let answer: (envelope: Envelope) => void = () => {};
  const options: { directory: readonly string[]; files: Record<string, string>; json: () => Promise<Envelope> } = {
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-1", "fix_report.md")]: fixReportMd("A's report.", "1 passed."),
      [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
    },
    json: () => new Promise<Envelope>((resolve) => { answer = resolve; }),
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const copying = h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  await Promise.resolve();
  options.directory = PREPARED_FILES;
  await h.controller.showWorkItem("JR-2");
  answer({ ...REVIEW_PACKAGE, work_item_id: "JR-1" });
  await copying;

  assert.deepEqual(h.clipboard, [], "A's prompt was copied after switching to B");
  assert.equal(h.notices.some((notice) => /Review prompt copied/.test(notice.message)), false);
  assert.equal(fixResultOf(h.last()), undefined);
});

test("a review prompt for a work item that is no longer shown is never copied onto one with its own report", async () => {
  // As above, but B has a report too, so Copy Review Prompt is offered again by
  // the time A's answer lands: only the work item check keeps A's prompt off
  // the clipboard.
  let answer: (envelope: Envelope) => void = () => {};
  const options: { directory: readonly string[]; files: Record<string, string>; json: () => Promise<Envelope> } = {
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-1", "fix_report.md")]: fixReportMd("A's report.", "1 passed."),
      [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-2", "fix_report.md")]: fixReportMd("B's report.", "2 passed."),
    },
    json: () => new Promise<Envelope>((resolve) => { answer = resolve; }),
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const copying = h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  await Promise.resolve();
  await h.controller.showWorkItem("JR-2");
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI", "pasteReviewOutput", "recordReviewResult", "recordVerification"]);
  answer({ ...REVIEW_PACKAGE, work_item_id: "JR-1", prompt: "# Final Review Request\n\nReview the BugPilot result for work item JR-1.\n" });
  await copying;

  assert.deepEqual(h.clipboard, [], "A's prompt was copied onto B");
  assert.equal(h.notices.some((notice) => /Review prompt copied/.test(notice.message)), false);
  assert.equal(fixResultOf(h.last())?.summary, "B's report.");
  assert.equal(fixResultOf(h.last())?.copyingReviewPrompt, undefined);

  // B's own copy is unaffected.
  const own = "# Final Review Request\n\nReview the BugPilot result for work item JR-2.\n";
  options.json = async () => ({ ...REVIEW_PACKAGE, work_item_id: "JR-2", prompt: own });
  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  assert.deepEqual(h.clipboard, [own]);
  assert.deepEqual(reviewRuns(h).map((run) => run.args[1]), ["JR-1", "JR-2"]);
});

test("the Validation checklist is fetched when asked for, once, and shown as the CLI built it", async () => {
  const h = reviewable();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(fixResultOf(h.last())?.validation, undefined, "the checklist was loaded before anyone asked");
  const before = h.states.length;

  await h.controller.handle({ type: "action", id: "loadValidation" });

  assert.ok(h.states.slice(before).some((state) => fixResultOf(state)?.validation?.state === "loading"));
  assert.deepEqual(fixResultOf(h.last())?.validation, {
    state: "ready",
    checklist: {
      steps: ["Reproduce the original issue if possible.", "Confirm the failure no longer occurs."],
      files: ["src/widgets/WidgetController.cpp"],
      risks: ["The legacy VDS path is untested."],
    },
  });
  // Asking again changes nothing and runs nothing.
  await h.controller.handle({ type: "action", id: "loadValidation" });
  assert.equal(reviewRuns(h).length, 1);
  // Guidance only: nothing written, no run state touched.
  assert.deepEqual(h.written, []);
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().overall.text, "Fix report available");
  assert.deepEqual(h.clipboard, []);
});

test("a checklist that cannot be had is the disclosure's own failure, and can be retried", async () => {
  let fail = true;
  const h = reviewable(() =>
    fail
      ? { ok: false, command: "review-package", error: { code: "INTERNAL_ERROR", message: "retrieval.json could not be read" } }
      : REVIEW_PACKAGE,
  );
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  await h.controller.handle({ type: "action", id: "loadValidation" });
  assert.deepEqual(fixResultOf(h.last())?.validation, { state: "failed", message: "retrieval.json could not be read" });
  // Not a run failure, not the row's failure, not Fix with AI's.
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().runError, undefined);
  assert.equal(fixResultOf(h.last())?.error, undefined);
  assert.equal(fixResultOf(h.last())?.summary, "Fixed it.");
  assert.equal(fixRow(h.last()).status, "ready");

  fail = false;
  await h.controller.handle({ type: "action", id: "loadValidation" });
  assert.equal(fixResultOf(h.last())?.validation?.state, "ready");
});

test("a checklist for a work item that is no longer shown never lands on the new one", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const options: { directory: readonly string[]; files: Record<string, string>; json: () => Promise<Envelope> } = {
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: {
      [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-1", "fix_report.md")]: fixReportMd("A's report.", "1 passed."),
      [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
      [nodePath.join("JR-2", "fix_report.md")]: fixReportMd("B's report.", "2 passed."),
    },
    json: () => new Promise<Envelope>((resolve) => { answer = resolve; }),
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const loading = h.controller.handle({ type: "action", id: "loadValidation" });
  await Promise.resolve();
  await h.controller.showWorkItem("JR-2");
  answer(REVIEW_PACKAGE);
  await loading;

  assert.equal(fixResultOf(h.last())?.summary, "B's report.");
  assert.equal(fixResultOf(h.last())?.validation, undefined, "A's checklist landed on B");
});

test("reading the folder again forgets a checklist only when the report changed", async () => {
  const h = reviewable();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  await h.controller.handle({ type: "action", id: "loadValidation" });
  assert.equal(fixResultOf(h.last())?.validation?.state, "ready");

  // The same report, read again — a refresh for an unrelated artifact: kept.
  await h.controller.refreshArtifacts();
  assert.equal(fixResultOf(h.last())?.validation?.state, "ready", "an unchanged report closed the checklist");
  // A rewritten report may no longer match it.
  h.files["fix_report.md"] = fixReportMd("Fixed it another way.", "5 passed.");
  await h.controller.refreshArtifacts();
  assert.equal(fixResultOf(h.last())?.validation, undefined);
});

test("a re-run of the same work item keeps the review aids on the kept report", async () => {
  // The Batch 8 rule: a non-Fresh re-run keeps the report, so the row — and its
  // aids — stay. The query is read-only, so asking mid-run touches nothing the
  // run is writing.
  // Held before `completed`: the run is genuinely in flight.
  const h = harness({
    events: successfulRun.filter((event) => event.type !== "completed"),
    hold: true,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it last time.", "12 passed.") },
    json: REVIEW_PACKAGE,
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  const running = h.controller.run(jiraForm());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.last().progress.state, "running");
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);

  const writesBefore = h.written.length;
  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  assert.deepEqual(h.clipboard, [REVIEW_PROMPT]);
  assert.equal(h.written.length, writesBefore, "a review aid wrote a file mid-run");

  h.release();
  await running;
});

test("a copy in flight survives the folder being read again: the prompt depends on the work item alone", async () => {
  // Refresh — or the end of a same-key re-run — does not stale a prompt built
  // from the id; dropping it would leave the developer pasting whatever was on
  // the clipboard before.
  let answer: (envelope: Envelope) => void = () => {};
  const h = reviewable(() => new Promise<Envelope>((resolve) => { answer = resolve; }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  const copying = h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  await Promise.resolve();
  await h.controller.refreshArtifacts();
  assert.equal(fixResultOf(h.last())?.copyingReviewPrompt, true, "a refresh re-enabled the button mid-copy");
  answer(REVIEW_PACKAGE);
  await copying;

  assert.deepEqual(h.clipboard, [REVIEW_PROMPT]);
  assert.equal(h.notices.filter((notice) => /Review prompt copied/.test(notice.message)).length, 1);
  assert.equal(fixResultOf(h.last())?.copyingReviewPrompt, undefined);
});

test("a copy whose report vanished meanwhile is not made, and the button comes back", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const options: { directory: readonly string[]; files: Record<string, string>; json: () => Promise<Envelope> } = {
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
    json: () => new Promise<Envelope>((resolve) => { answer = resolve; }),
  };
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  const copying = h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  await Promise.resolve();
  options.directory = PREPARED_FILES;
  await h.controller.refreshArtifacts();
  answer(REVIEW_PACKAGE);
  await copying;

  assert.deepEqual(h.clipboard, [], "a prompt was copied for a report that is gone");
  assert.equal(h.notices.some((notice) => /Review prompt copied/.test(notice.message)), false);
  assert.equal(fixResultOf(h.last()), undefined);
});

test("a checklist in flight when the folder is read again is dropped, not shown", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const h = reviewable(() => new Promise<Envelope>((resolve) => { answer = resolve; }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  const loading = h.controller.handle({ type: "action", id: "loadValidation" });
  await Promise.resolve();
  h.files["fix_report.md"] = fixReportMd("Fixed it another way.", "5 passed.");
  await h.controller.refreshArtifacts();
  answer(REVIEW_PACKAGE);
  await loading;

  // The report changed: the list built before the re-read is not shown.
  assert.equal(fixResultOf(h.last())?.validation, undefined);
});

test("a clipboard that refuses is said, and the button comes back", async () => {
  const h = harness({
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
    json: REVIEW_PACKAGE,
    clipboardThrows: new Error("Clipboard write was denied."),
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");

  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });

  assert.equal(fixResultOf(h.last())?.copyingReviewPrompt, undefined, "the button stayed on Copying…");
  assert.ok(h.notices.some((notice) => notice.kind === "error" && notice.message === "Could not copy the review prompt: Clipboard write was denied."));
  assert.equal(h.notices.some((notice) => /Review prompt copied/.test(notice.message)), false);
});

// --- Batch 10: Review with AI ------------------------------------------------

/** What the terminal handoff does to any prompt: one line (agents.ts). */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const reviewOf = (state: PanelState) => fixResultOf(state)?.review;
const offersReview = (state: PanelState) => fixResultOf(state)?.actions.includes("reviewWithAI") ?? false;
const REVIEW: PanelMessage = { type: "action", id: "reviewWithAI" };
/** Flush every pending promise callback, so a held probe is reached. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Harness options a test can change mid-scenario: the harness reads them live. */
type WritableOptions = { -readonly [K in keyof HarnessOptions]: HarnessOptions[K] };

/** A reopened work item with a report, an agent on PATH, and the CLI's review package. */
const reviewOptions = (extra: HarnessOptions = {}): WritableOptions => ({
  directory: [...PREPARED_FILES, "fix_report.md"],
  files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
  json: REVIEW_PACKAGE,
  agentOnPath: true,
  ...extra,
});

async function openedForReview(options: HarnessOptions = reviewOptions(), workItemId = "JR-12345") {
  const h = harness(options);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem(workItemId);
  return h;
}

/** Two work items with a report each, for switching between mid-handoff. */
const twoReports = (json: NonNullable<HarnessOptions["json"]>, extra: HarnessOptions = {}): HarnessOptions => ({
  directory: [...PREPARED_FILES, "fix_report.md"],
  files: {
    [nodePath.join("JR-1", "run.json")]: PREPARED_RUN_JSON,
    [nodePath.join("JR-1", "fix_report.md")]: fixReportMd("A's report.", "1 passed."),
    [nodePath.join("JR-2", "run.json")]: PREPARED_RUN_JSON,
    [nodePath.join("JR-2", "fix_report.md")]: fixReportMd("B's report.", "2 passed."),
  },
  json,
  agentOnPath: true,
  ...extra,
});

test("with no report, Review with AI is neither offered nor accepted", async () => {
  const h = await openedForReview(reviewOptions({ directory: PREPARED_FILES }));
  assert.equal(fixResultOf(h.last()), undefined);

  await h.controller.handle(REVIEW);

  assert.deepEqual(reviewRuns(h), []);
  assert.deepEqual(h.probed, []);
  assert.deepEqual(h.terminals, []);
  assert.ok(h.logged.some((line) => /Refusing to start a review/.test(line)));
});

test("Review with AI hands review-package's prompt to the selected agent in a terminal, and does nothing else", async () => {
  const h = await openedForReview();
  const fixBefore = fixRow(h.last());
  const noticesBefore = h.notices.length;
  const before = h.states.length;

  await h.controller.handle(REVIEW);

  // The canonical prompt, from the read-only query — asked for once, built
  // nowhere in this extension.
  assert.deepEqual(reviewRuns(h).map((run) => [...run.args]), [["review-package", "JR-12345", "--json"]]);
  // The agent the form selects (auto: Claude CLI), in one terminal, in the
  // repository root where `.ai/JR-12345/` and the diff are.
  assert.deepEqual(h.probed, ["claude"]);
  assert.deepEqual(h.terminals, [
    { name: "Review with AI · JR-12345", cwd: ROOT, commandLine: `claude ${JSON.stringify(oneLine(REVIEW_PROMPT))}` },
  ]);
  // Starting, then started — and started says that and nothing more.
  assert.ok(h.states.slice(before).some((state) => reviewOf(state)?.state === "starting"));
  assert.deepEqual(reviewOf(h.last()), {
    state: "started",
    summary: "AI review started",
    detail: "Handed to Claude CLI in a terminal.",
    next: REVIEW_NEXT_STEP,
  });
  assert.equal(offersReview(h.last()), false, "a second reviewer was offered for the same report");
  // Nothing else moved: not Fix with AI, not the checklist, not the report,
  // not the header, not the run.
  assert.deepEqual(fixRow(h.last()), fixBefore, "Fix with AI changed");
  assert.equal(fixResultOf(h.last())?.validation, undefined, "the checklist was touched");
  assert.equal(fixResultOf(h.last())?.summary, "Fixed it.");
  assert.equal(fixResultOf(h.last())?.error, undefined);
  assert.equal(h.last().overall.text, "Fix report available");
  assert.equal(h.last().progress.state, "done");
  // No clipboard, no file, no command, no run, no toast.
  assert.deepEqual(h.clipboard, []);
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.streamRuns, []);
  assert.deepEqual(h.ranCommands, []);
  assert.equal(h.notices.length, noticesBefore);
  const state = JSON.stringify(h.last());
  for (const claim of ["Reviewed", "Review complete", "Review passed", "Verified", "Approved", "approved"]) {
    assert.equal(state.includes(claim), false, `the panel says "${claim}"`);
  }
});

test("a custom agent gets the same prompt through the same template — which is how Codex is reached", async () => {
  const h = await openedForReview(reviewOptions({ form: { ...DEFAULT_FORM, agent: "custom", agentCommand: "codex exec {prompt}" } }));

  await h.controller.handle(REVIEW);

  assert.deepEqual(h.probed, ["codex"]);
  assert.equal(h.terminals[0]?.commandLine, `codex exec ${JSON.stringify(oneLine(REVIEW_PROMPT))}`);
  assert.deepEqual(reviewOf(h.last()), { state: "started", summary: "AI review started", detail: "Handed to codex in a terminal.", next: REVIEW_NEXT_STEP });
});

test("Review with AI uses the agent selected now, the same one Fix with AI uses", async () => {
  const h = await openedForReview();
  const form = { ...DEFAULT_FORM, issueKey: "JR-12345", agent: "custom" as const, agentCommand: "my-reviewer --prompt {prompt}" };
  await h.controller.handle({ type: "formChanged", form });

  await h.controller.handle(REVIEW);
  await h.controller.handle({ type: "action", id: "fixWithAI" });

  // One selection, two handoffs: the review first, then the fix.
  assert.deepEqual(h.probed, ["my-reviewer", "my-reviewer"]);
  assert.equal(h.terminals[0]?.commandLine, `my-reviewer --prompt ${JSON.stringify(oneLine(REVIEW_PROMPT))}`);
  assert.equal(h.terminals[1]?.commandLine, `my-reviewer --prompt ${JSON.stringify("Read .ai/JR-12345/task.md and complete the workflow.")}`);
});

test("with no agent available, no reviewer starts and the row says why, beside a Copy Review Prompt that still works", async () => {
  const h = await openedForReview(reviewOptions({ agentOnPath: false, extensions: {} }));
  const fixBefore = fixRow(h.last());
  const noticesBefore = h.notices.length;

  await h.controller.handle(REVIEW);

  assert.deepEqual(h.terminals, []);
  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  assert.equal(review.error.title, "AI review did not start");
  assert.match(review.error.message, /^BugPilot couldn't start the selected AI agent\./);
  assert.match(review.error.message, /Copy Review Prompt still gives you the prompt\.$/);
  assert.equal(
    review.error.detail,
    "No supported AI agent detected. BugPilot looked for Claude CLI, Codex CLI, Codex Extension and Claude Extension.",
  );
  assert.deepEqual(review.error.action, { title: "Open Settings", command: COMMANDS.openSettings });
  // No pretend start, no clipboard fallback, no agent panel pushed forward.
  assert.deepEqual(h.clipboard, []);
  assert.equal(h.notices.length, noticesBefore);
  // The row, Fix with AI and the run stand; the button stays for a retry.
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI", "pasteReviewOutput", "recordReviewResult", "recordVerification"]);
  assert.equal(fixResultOf(h.last())?.error, undefined, "the review's failure became the row's");
  assert.deepEqual(fixRow(h.last()), fixBefore);
  assert.equal(h.last().runError, undefined);
  assert.equal(h.last().overall.text, "Fix report available");

  // The card's button does something while the card is there.
  await h.controller.handle({ type: "command", id: COMMANDS.openSettings });
  assert.deepEqual(h.ranCommands, [COMMANDS.openSettings]);
  // Copy Review Prompt still gives the prompt.
  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  assert.deepEqual(h.clipboard, [REVIEW_PROMPT]);

  // Reopened, the card is gone, and so is its button's offer.
  await h.controller.showWorkItem("JR-12345");
  assert.equal(reviewOf(h.last()), undefined);
  await h.controller.handle({ type: "command", id: COMMANDS.openSettings });
  assert.deepEqual(h.ranCommands, [COMMANDS.openSettings], "a card that is gone still ran its command");
});

test("a review prompt that cannot be prepared starts nothing and says so on the row", async () => {
  const h = await openedForReview(
    reviewOptions({ json: { ok: false, command: "review-package", error: { code: "WORK_ITEM_NOT_FOUND", message: "Work item not found: .ai/JR-12345/" } } }),
  );
  const fixBefore = fixRow(h.last());

  await h.controller.handle(REVIEW);

  assert.deepEqual(h.probed, [], "an agent was looked for with no prompt to give it");
  assert.deepEqual(h.terminals, []);
  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  assert.equal(review.error.title, "AI review did not start");
  assert.equal(review.error.message, "BugPilot couldn't prepare the review prompt, so no reviewer was started.");
  assert.equal(review.error.detail, "Work item not found: .ai/JR-12345/");
  assert.equal(review.error.action, undefined);
  assert.equal(offersReview(h.last()), true, "the button did not come back");
  assert.equal(fixResultOf(h.last())?.summary, "Fixed it.");
  assert.deepEqual(fixRow(h.last()), fixBefore);
  assert.equal(h.last().runError, undefined);
});

test("a prompt with anything a shell could act on never reaches a command line", async () => {
  // The canonical prompt is plain; this is the guard for one that is not.
  const prompt = "Review JR-12345 $(rm -rf ~) now.";
  const h = await openedForReview(reviewOptions({ json: { ...REVIEW_PACKAGE, prompt } }));

  await h.controller.handle(REVIEW);

  assert.deepEqual(h.probed, []);
  assert.deepEqual(h.terminals, []);
  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  // Had, but not put on a command line — and said so, with the way round it.
  assert.equal(
    review.error.message,
    "BugPilot won't put this review prompt on a command line, so no reviewer was started. Copy Review Prompt still gives you the text.",
  );
  assert.match(review.error.detail ?? "", /characters a shell could act on/);
  // The clipboard is not a shell: Copy Review Prompt still gives the text.
  await h.controller.handle({ type: "action", id: "copyReviewPrompt" });
  assert.deepEqual(h.clipboard, [prompt]);
});

test("a terminal that cannot be opened is a failure on the row, not a start", async () => {
  const h = await openedForReview(reviewOptions({ terminalThrows: new Error("The terminal process failed to launch.") }));

  await h.controller.handle(REVIEW);

  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  assert.equal(review.error.title, "AI review did not start");
  assert.equal(review.error.message, "BugPilot couldn't open a terminal for the reviewer. Try again, or use Copy Review Prompt.");
  assert.equal(review.error.detail, "The terminal process failed to launch.");
  assert.equal(offersReview(h.last()), true);
  assert.equal(h.last().runError, undefined);
  assert.equal(JSON.stringify(h.last()).includes("AI review started"), false);
});

test("pressed twice, or pressed again once started, Review with AI starts one reviewer", async () => {
  // Every answer the CLI owes is held, then all are given at once: a second
  // handoff, had one been let through, would reach a terminal too — and fail
  // this test rather than hang it.
  const answers: ((envelope: Envelope) => void)[] = [];
  const h = await openedForReview(reviewOptions({ json: () => new Promise<Envelope>((resolve) => { answers.push(resolve); }) }));

  const first = h.controller.handle(REVIEW);
  await Promise.resolve();
  // The host refuses on its own state, whatever the page shows.
  const second = h.controller.handle(REVIEW);
  await Promise.resolve();
  for (const answer of answers) answer(REVIEW_PACKAGE);
  await Promise.all([first, second]);
  assert.equal(reviewRuns(h).length, 1, "a second press asked for a second prompt");
  assert.equal(h.terminals.length, 1, "a second press started a second reviewer");

  await h.controller.handle(REVIEW);
  assert.equal(h.terminals.length, 1, "a second reviewer started for the same report");
  assert.equal(reviewRuns(h).length, 1);
  assert.equal(h.logged.filter((line) => /Refusing to start a review/.test(line)).length, 2);
});

test("a review for a work item that is no longer shown never starts, and never lands on the new one", async () => {
  // A on screen, Review pressed, B — with a report of its own — opened before
  // the CLI answers: no reviewer for A under B, and nothing on B's row.
  let answer: (envelope: Envelope) => void = () => {};
  const h = harness(twoReports(() => new Promise<Envelope>((resolve) => { answer = resolve; })));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");
  const noticesBefore = h.notices.length;

  const reviewing = h.controller.handle(REVIEW);
  await Promise.resolve();
  await h.controller.showWorkItem("JR-2");
  answer({ ...REVIEW_PACKAGE, work_item_id: "JR-1", prompt: "# Final Review Request\n\nReview the BugPilot result for work item JR-1.\n" });
  await reviewing;

  assert.deepEqual(h.terminals, [], "A's reviewer started with B on screen");
  assert.deepEqual(h.probed, []);
  assert.equal(reviewOf(h.last()), undefined, "A's handoff showed on B");
  assert.equal(fixResultOf(h.last())?.summary, "B's report.");
  assert.equal(offersReview(h.last()), true, "B's own Review with AI is gone");
  assert.deepEqual(h.clipboard, []);
  assert.equal(h.notices.length, noticesBefore);
});

test("a failure for a work item that is no longer shown is not shown on the new one", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const h = harness(twoReports(() => new Promise<Envelope>((resolve) => { answer = resolve; })));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const reviewing = h.controller.handle(REVIEW);
  await Promise.resolve();
  await h.controller.showWorkItem("JR-2");
  answer({ ok: false, command: "review-package", error: { code: "WORK_ITEM_NOT_FOUND", message: "Work item not found: .ai/JR-1/" } });
  await reviewing;

  assert.equal(reviewOf(h.last()), undefined, "A's failure showed on B");
  assert.deepEqual(h.terminals, []);
});

test("a switch while the agent is being looked for starts no reviewer", async () => {
  let probe: (found: boolean) => void = () => {};
  const h = harness(twoReports(REVIEW_PACKAGE, { agentProbe: () => new Promise<boolean>((resolve) => { probe = resolve; }) }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const reviewing = h.controller.handle(REVIEW);
  await settle();
  assert.deepEqual(h.probed, ["claude"], "the probe was not reached");
  await h.controller.showWorkItem("JR-2");
  probe(true);
  await reviewing;

  assert.deepEqual(h.terminals, [], "A's reviewer started with B on screen");
  assert.equal(reviewOf(h.last()), undefined);
});

test("a run starting while a review is being started drops it", async () => {
  // A same-key re-prepare keeps the report, so the row stays — but the press
  // was about the package before the run, not the one it is writing.
  let answer: (envelope: Envelope) => void = () => {};
  const options = reviewOptions({ json: () => new Promise<Envelope>((resolve) => { answer = resolve; }) });
  const h = await openedForReview(options);

  const reviewing = h.controller.handle(REVIEW);
  await Promise.resolve();
  await h.controller.run(jiraForm());
  answer(REVIEW_PACKAGE);
  await reviewing;

  assert.deepEqual(h.terminals, []);
  assert.equal(reviewOf(h.last()), undefined);
  assert.equal(offersReview(h.last()), true, "the kept report lost its Review with AI");
});

test("a review whose report vanished meanwhile starts nothing, and leaves nothing to come back", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const options = reviewOptions({ json: () => new Promise<Envelope>((resolve) => { answer = resolve; }) });
  const h = await openedForReview(options);

  const reviewing = h.controller.handle(REVIEW);
  await Promise.resolve();
  options.directory = PREPARED_FILES;
  await h.controller.refreshArtifacts();
  answer(REVIEW_PACKAGE);
  await reviewing;

  assert.deepEqual(h.terminals, []);
  assert.equal(fixResultOf(h.last()), undefined);
  // A new report later gets a clean row, not a handoff stuck on "starting".
  options.directory = [...PREPARED_FILES, "fix_report.md"];
  await h.controller.refreshArtifacts();
  assert.equal(reviewOf(h.last()), undefined);
  assert.equal(offersReview(h.last()), true);
});

test("a review in flight survives the folder being read again: same work item, same report", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const h = await openedForReview(reviewOptions({ json: () => new Promise<Envelope>((resolve) => { answer = resolve; }) }));

  const reviewing = h.controller.handle(REVIEW);
  await Promise.resolve();
  await h.controller.refreshArtifacts();
  assert.equal(reviewOf(h.last())?.state, "starting", "a refresh cancelled the handoff");
  answer(REVIEW_PACKAGE);
  await reviewing;

  assert.equal(h.terminals.length, 1);
  assert.equal(reviewOf(h.last())?.state, "started");
  // And a refresh after it keeps saying so, while the report is there.
  await h.controller.refreshArtifacts();
  assert.equal(reviewOf(h.last())?.state, "started");
});

test("reopened, the same fix stays reviewed: no second Review with AI, and the row says an attempt was made", async () => {
  const h = await openedForReview();
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "started");

  await h.controller.showWorkItem("JR-12345");
  // The transient start is gone; the fact that this fix had an attempt is not.
  assert.equal(reviewOf(h.last())?.state, "earlier");
  assert.equal((reviewOf(h.last()) as { summary: string }).summary, "AI review already started for this fix");
  assert.equal(offersReview(h.last()), false);
  await h.controller.handle(REVIEW);
  assert.equal(h.terminals.length, 1, "a second reviewer started for the same fix");
});

test("a run forgets the last review handoff, even when it keeps the report", async () => {
  const h = await openedForReview(reviewOptions({ agentOnPath: false }));
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "failed");
  const before = h.states.length;

  await h.controller.run(jiraForm());

  // Gone from the first push of the run on, not only at its end.
  assert.equal(h.states.slice(before).every((state) => reviewOf(state) === undefined), true);
  assert.equal(offersReview(h.last()), true);
});

test("Review with AI and Fix with AI keep their own outcomes", async () => {
  const options = reviewOptions({ agentOnPath: false });
  const h = await openedForReview(options);

  // Both fail: each says so on its own row, with its own card.
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  await h.controller.handle(REVIEW);
  assert.equal(fixRow(h.last()).error?.title, "AI agent unavailable");
  assert.equal(reviewOf(h.last())?.state, "failed");
  // Fix's fallback put its own sentence on the clipboard; the review added nothing.
  assert.deepEqual(h.clipboard, ["Read .ai/JR-12345/task.md and complete the workflow."]);

  // The review succeeds: Fix with AI's card stays.
  options.agentOnPath = true;
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "started");
  assert.equal(fixRow(h.last()).error?.title, "AI agent unavailable", "a review cleared Fix with AI's card");

  // Fix with AI succeeds: the review's start stays.
  await h.controller.handle({ type: "action", id: "fixWithAI" });
  assert.equal(fixRow(h.last()).statusText, "Started");
  assert.equal(reviewOf(h.last())?.state, "started", "a fix handoff cleared the review's");
  assert.equal(h.last().overall.text, "AI fix started");
});

test("starting a review leaves the Validation checklist exactly as it was", async () => {
  const h = await openedForReview();
  await h.controller.handle({ type: "action", id: "loadValidation" });
  const checklist = fixResultOf(h.last())?.validation;
  assert.equal(checklist?.state, "ready");

  await h.controller.handle(REVIEW);

  assert.deepEqual(fixResultOf(h.last())?.validation, checklist);
});

test("a review's outcome does not outlive its report", async () => {
  // Started for one report; the report goes (Clean, a Fresh run elsewhere);
  // a new one arrives. The new report has had no review.
  const options = reviewOptions();
  const h = await openedForReview(options);
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "started");

  options.directory = PREPARED_FILES;
  await h.controller.refreshArtifacts();
  // The same report back — the same fix, by content — is still reviewed.
  options.directory = [...PREPARED_FILES, "fix_report.md"];
  await h.controller.refreshArtifacts();
  assert.equal(reviewOf(h.last())?.state, "earlier");
  assert.equal(offersReview(h.last()), false);

  // A different report is a new fix: no attempt was made for it.
  h.files["fix_report.md"] = fixReportMd("Fixed it differently.", "4 passed.");
  await h.controller.refreshArtifacts();
  assert.equal(reviewOf(h.last()), undefined, "the last report's review showed on the next");
  assert.equal(offersReview(h.last()), true);
});

test("a report that goes and comes back mid-handoff drops the first handoff; a new press starts one reviewer", async () => {
  // Pressed for one report; it went (a refresh without it) and a new one
  // arrived (a refresh with it) before the CLI answered. The first handoff is
  // about the report that went; only the press made for the new one may start.
  const answers: ((envelope: Envelope) => void)[] = [];
  const options = reviewOptions({ json: () => new Promise<Envelope>((resolve) => { answers.push(resolve); }) });
  const h = await openedForReview(options);

  const first = h.controller.handle(REVIEW);
  await Promise.resolve();
  options.directory = PREPARED_FILES;
  await h.controller.refreshArtifacts();
  options.directory = [...PREPARED_FILES, "fix_report.md"];
  await h.controller.refreshArtifacts();
  assert.equal(offersReview(h.last()), true);
  const second = h.controller.handle(REVIEW);
  await Promise.resolve();
  for (const answer of answers) answer(REVIEW_PACKAGE);
  await Promise.all([first, second]);

  assert.equal(h.terminals.length, 1, "the handoff for the report that went started a reviewer too");
  assert.equal(reviewOf(h.last())?.state, "started");
});

test("a report removed while the agent is being looked for starts no reviewer", async () => {
  let probe: (found: boolean) => void = () => {};
  const options = reviewOptions({ agentProbe: () => new Promise<boolean>((resolve) => { probe = resolve; }) });
  const h = await openedForReview(options);

  const reviewing = h.controller.handle(REVIEW);
  await settle();
  assert.deepEqual(h.probed, ["claude"], "the probe was not reached");
  options.directory = PREPARED_FILES;
  await h.controller.refreshArtifacts();
  probe(true);
  await reviewing;

  assert.deepEqual(h.terminals, []);
  assert.equal(fixResultOf(h.last()), undefined);
});

test("an agent probe that throws is 'not found' on the row, not a crash or a button left waiting", async () => {
  const h = await openedForReview(reviewOptions({ agentProbe: () => Promise.reject(new Error("spawn EPERM")) }));

  await h.controller.handle(REVIEW);

  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  assert.equal(review.error.title, "AI review did not start");
  // Detection never throws: a probe that did is an agent not found.
  assert.match(review.error.detail ?? "", /^No supported AI agent detected/);
  assert.deepEqual(review.error.action, { title: "Open Settings", command: COMMANDS.openSettings });
  assert.equal(offersReview(h.last()), true, "the button did not come back");
  assert.deepEqual(h.terminals, []);
});

// --- Stabilization (§37.70): Fix with AI's stale and double-press guards ---------

const FIX: PanelMessage = { type: "action", id: "fixWithAI" };

/** A probe that answers when the test says so, one resolver per call. */
const heldProbe = () => {
  const answers: ((found: boolean) => void)[] = [];
  let settled: boolean | undefined;
  return {
    agentProbe: () =>
      settled === undefined ? new Promise<boolean>((resolve) => { answers.push(resolve); }) : Promise.resolve(settled),
    answers,
    /** Answer every probe held now, and every one asked from here on: Auto-detect asks one CLI after another. */
    answerAll: (found: boolean) => {
      settled = found;
      for (const answer of answers) answer(found);
    },
  };
};

/** The Claude Code extension as its 2.1.285 manifest declares it: no prompt-taking command. */
const CLAUDE_EXTENSION: Readonly<Record<string, InstalledExtension>> = {
  "anthropic.claude-code": {
    version: "2.1.285",
    active: true,
    commands: ["claude-vscode.sidebar.open", "claude-vscode.editor.openLast"],
  },
};

test("a Fix with AI press for a work item that is no longer shown never lands on the new one", async () => {
  // A on screen, Fix with AI pressed, B opened while the agent is still being
  // looked for: no terminal for A under B, and nothing of it on B's row.
  const probe = heldProbe();
  const h = harness(twoReports(REVIEW_PACKAGE, { agentProbe: probe.agentProbe }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  assert.deepEqual(h.probed, ["claude"], "the probe was not reached");
  await h.controller.showWorkItem("JR-2");
  const rowOnB = fixRow(h.last());
  const headerOnB = h.last().overall.text;
  const noticesOnB = h.notices.length;
  for (const answer of probe.answers) answer(true);
  await pressing;

  assert.deepEqual(h.terminals, [], "A's agent started with B on screen");
  assert.deepEqual(fixRow(h.last()), rowOnB, "A's handoff changed B's row");
  assert.equal(h.last().overall.text, headerOnB);
  assert.equal(h.notices.length, noticesOnB);
  assert.equal(JSON.stringify(h.last()).includes("AI fix started"), false);
});

test("with no agent, a stale Fix with AI press copies nothing and says nothing on the new work item", async () => {
  const probe = heldProbe();
  const h = harness(twoReports(REVIEW_PACKAGE, { agentProbe: probe.agentProbe, extensions: {} }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  await h.controller.showWorkItem("JR-2");
  const noticesOnB = h.notices.length;
  probe.answerAll(false);
  await pressing;

  assert.deepEqual(h.clipboard, [], "A's prompt went to the clipboard with B on screen");
  assert.equal(fixRow(h.last()).error, undefined, "A's card landed on B");
  assert.equal(fixRow(h.last()).status === "failed" || fixRow(h.last()).status === "skipped", false);
  assert.equal(h.notices.length, noticesOnB);
  assert.deepEqual(h.terminals, []);
});

test("a handoff that resumes while the panel is switching is already stale — Fix with AI", async () => {
  // The switch drops the previous item's handoffs before its first wait, so
  // one that resumes during that wait (reading B's run.json) finds itself stale.
  let releaseRead: () => void = () => {};
  const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
  const probe = heldProbe();
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentProbe: probe.agentProbe,
    onReadFile: (file) => (file.includes("JR-2") && file.endsWith("run.json") ? readHeld : undefined),
  }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  const noticesBefore = h.notices.length;
  const switching = h.controller.showWorkItem("JR-2");
  for (const answer of probe.answers) answer(true);
  await pressing;
  // Nothing of A's handoff reached the screen — not a terminal, and not a
  // notice or an outcome about A's package either.
  assert.deepEqual(h.terminals, [], "A's agent started while the panel was switching to B");
  assert.equal(h.notices.length, noticesBefore, "A's handoff spoke while the panel was switching to B");
  releaseRead();
  await switching;
  assert.equal(h.last().workItemId, "JR-2");
  assert.deepEqual(h.terminals, []);
  assert.equal(fixRow(h.last()).status === "skipped", false, "A's outcome landed on B");
});

test("a handoff that resumes while the panel is switching is already stale — Review with AI", async () => {
  let releaseRead: () => void = () => {};
  const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
  const probe = heldProbe();
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentProbe: probe.agentProbe,
    onReadFile: (file) => (file.includes("JR-2") && file.endsWith("run.json") ? readHeld : undefined),
  }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const reviewing = h.controller.handle(REVIEW);
  await settle();
  assert.deepEqual(h.probed, ["claude"], "the probe was not reached");
  const switching = h.controller.showWorkItem("JR-2");
  for (const answer of probe.answers) answer(true);
  await reviewing;
  assert.deepEqual(h.terminals, [], "A's reviewer started while the panel was switching to B");
  releaseRead();
  await switching;
  assert.equal(reviewOf(h.last()), undefined);
});

test("Fix with AI pressed twice before the agent is found starts one handoff, whoever presses", async () => {
  // The page hides the button, but the palette, the History menu and the end
  // of a run reach the controller without it: the refusal is the host's.
  const probe = heldProbe();
  const h = await openedForReview(reviewOptions({ agentProbe: probe.agentProbe }));

  const fromPage = h.controller.handle(FIX);
  const fromPalette = h.controller.fixWithAI();
  const again = h.controller.handle(FIX);
  await settle();
  for (const answer of probe.answers) answer(true);
  await Promise.all([fromPage, fromPalette, again]);

  assert.deepEqual(h.probed, ["claude"], "a second press looked for an agent again");
  assert.equal(h.terminals.length, 1, "two presses opened two terminals");
  assert.equal(h.logged.filter((line) => /Refusing a second Fix with AI/.test(line)).length, 2);
  assert.equal(fixRow(h.last()).statusText, "Started");
});

test("once a handoff has finished, a deliberate second Fix with AI still works as before", async () => {
  // Busy is about a handoff in flight, not a history: the existing product
  // behaviour after a success is unchanged.
  const h = await openedForReview();
  await h.controller.fixWithAI();
  await h.controller.fixWithAI();
  assert.equal(h.terminals.length, 2);
});

test("a run starting while Fix with AI is being handed over drops the handoff", async () => {
  const probe = heldProbe();
  const h = await openedForReview(reviewOptions({ agentProbe: probe.agentProbe }));

  const pressing = h.controller.handle(FIX);
  await settle();
  await h.controller.run(jiraForm());
  const afterRun = fixRow(h.last());
  for (const answer of probe.answers) answer(true);
  await pressing;

  assert.deepEqual(h.terminals, [], "the handoff pressed before the run started an agent after it");
  assert.deepEqual(fixRow(h.last()), afterRun);
});

test("task.md gone while the agent was looked for: nothing is handed over, and the row says why", async () => {
  const probe = heldProbe();
  const options = reviewOptions({ agentProbe: probe.agentProbe });
  const h = await openedForReview(options);

  const pressing = h.controller.handle(FIX);
  await settle();
  options.directory = ["issue.json", "run.json"];
  await h.controller.refreshArtifacts();
  for (const answer of probe.answers) answer(true);
  await pressing;

  assert.deepEqual(h.terminals, []);
  assert.deepEqual(h.clipboard, []);
  assert.ok(h.notices.some((notice) => notice.kind === "warning" && /There is no task\.md for JR-12345/.test(notice.message)));
});

// --- Stabilization (§37.70): work item ids from outside a form -------------------

test("a work item id that is not one is refused on the way in, and never reaches a handoff", async () => {
  const h = await openedForReview();
  const before = h.states.length;
  const reads: string[] = [];
  for (const id of ["x$(calc)", "x`calc`_1", "../JR-1", "JR-1/x_1", "JR-12345\n", " JR-12345", "JR-\"1", ""]) {
    await h.controller.showWorkItem(id);
    reads.push(id);
  }
  // Nothing switched, nothing was read for them, nothing was saved as the
  // current work item — and the notices do not echo the names back.
  assert.equal(h.controller.workItemId, "JR-12345");
  assert.equal(h.states.length, before, "a refused id pushed a state");
  assert.deepEqual(h.savedWorkItems.filter((id) => id !== "JR-12345"), []);
  const refusals = h.notices.filter((notice) => /will not open this work item/.test(notice.message));
  assert.equal(refusals.length, reads.length);
  for (const notice of refusals) assert.equal(/calc|\.\.\//.test(notice.message), false, notice.message);

  // A handoff afterwards is for the work item on screen, and only it.
  await h.controller.handle(FIX);
  assert.deepEqual(h.terminals.map((terminal) => terminal.commandLine), [
    `claude ${JSON.stringify("Read .ai/JR-12345/task.md and complete the workflow.")}`,
  ]);
});

test("with only an invalid id offered, there is nothing to hand over: no probe, no terminal, no clipboard", async () => {
  const h = harness({ agentOnPath: true, directory: [...PREPARED_FILES], files: { "run.json": PREPARED_RUN_JSON } });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("x$(calc)");
  await h.controller.handle(FIX);
  await h.controller.handle(REVIEW);

  assert.equal(h.controller.workItemId, undefined);
  assert.deepEqual(h.probed, []);
  assert.deepEqual(h.terminals, []);
  assert.deepEqual(h.clipboard, []);
  assert.deepEqual(h.jsonRuns, []);
});

test("an id the CLI streams is checked too: one that is not a work item id is not adopted", async () => {
  const h = harness({
    events: [
      { type: "started", work_item_id: "local_1$(calc)", source: "manual" },
      { type: "completed", ok: true },
    ],
    directory: ["task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm({ source: "manual", description: "crash on save", issueKey: "" }));

  assert.equal(h.controller.workItemId, undefined);
  assert.deepEqual(h.savedWorkItems, []);
});

test("through an extension bridge, a switch while the agent's panel is being revealed leaves the new work item alone", async () => {
  // The prompt was copied for A — A was on screen then — but by the time the
  // reveal answers, B is: no outcome, card or notice of A's may land on B.
  let reveal: () => void = () => {};
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentOnPath: false,
    extensions: CLAUDE_EXTENSION,
    executeExtensionCommand: () => new Promise<void>((resolve) => { reveal = resolve; }),
  }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  assert.equal(h.clipboard.length, 1, "the bridge was not reached");
  assert.deepEqual(h.extensionCommands, ["claude-vscode.sidebar.open"]);
  await h.controller.showWorkItem("JR-2");
  const rowOnB = fixRow(h.last());
  const noticesOnB = h.notices.length;
  reveal();
  await pressing;

  assert.deepEqual(fixRow(h.last()), rowOnB, "A's bridge outcome landed on B");
  assert.equal(fixRow(h.last()).error, undefined);
  assert.equal(h.notices.length, noticesOnB);
});

test("a press dropped by a switch cannot free the new work item's handoff: still one terminal", async () => {
  // A pressed, B opened, B pressed; A's probe answers after B's press. A's
  // handoff must not clear B's busy flag, or a second press on B would start a
  // second handoff alongside B's first.
  const probe = heldProbe();
  const h = harness(twoReports(REVIEW_PACKAGE, { agentProbe: probe.agentProbe }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressA = h.controller.handle(FIX);
  await settle();
  await h.controller.showWorkItem("JR-2");
  const pressB = h.controller.handle(FIX);
  await settle();
  probe.answers[0]!(true);
  await pressA;
  const pressB2 = h.controller.handle(FIX);
  await settle();
  for (const answer of probe.answers.slice(1)) answer(true);
  await Promise.all([pressB, pressB2]);

  assert.equal(h.probed.length, 2, "a second press on B looked for an agent again");
  assert.deepEqual(h.terminals.map((terminal) => terminal.name), ["Fix with AI · JR-2"]);
});

test("through an extension bridge, a switch while the prompt is being copied brings no agent panel forward for it", async () => {
  let release: () => void = () => {};
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentOnPath: false,
    clipboardHold: () => new Promise<void>((resolve) => { release = resolve; }),
    extensions: CLAUDE_EXTENSION,
  }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  await h.controller.showWorkItem("JR-2");
  const rowOnB = fixRow(h.last());
  const noticesOnB = h.notices.length;
  release();
  await pressing;

  assert.deepEqual(h.extensionCommands, [], "an agent panel was brought forward for A with B on screen");
  assert.deepEqual(fixRow(h.last()), rowOnB);
  assert.equal(h.notices.length, noticesOnB);
});

// --- Batch 11: Review Result Capture -------------------------------------------

const REVIEW_REPORT_MD = (summary = "The change reads correctly.") =>
  "# Review Report: JR-12345\n\n" +
  `## Summary\n\n${summary}\n\n` +
  "## Findings\n\n- One duplicate null check.\n\n" +
  "## Validation Notes\n\nNot recorded.\n\n" +
  "## Recommendations\n\n- Remove the duplicate.\n\n" +
  "## Source\n\nRecorded from an external review.\n";

const REVIEW_ENTRY = {
  summary: "The change reads correctly.",
  findings: "- One duplicate null check.",
  validationNotes: "",
  recommendations: "- Remove the duplicate.",
};

const RECORDED: Envelope = {
  ok: true,
  command: "record-review",
  warnings: [],
  work_item_id: "JR-12345",
  review_report: ".ai/JR-12345/review_report.md",
  replaced: false,
};

/**
 * A reopened work item with a fix report, optionally a recorded review, and a
 * `record-review` port that behaves like the CLI: it writes the file (into the
 * live listing) and answers. `answer` may hold the request open.
 */
function capturable(setup: {
  review?: boolean;
  confirm?: boolean;
  answer?: (request: PayloadCommandRequest) => Promise<Envelope>;
  port?: boolean;
} = {}) {
  const calls: { args: readonly string[]; payload: unknown }[] = [];
  const options: {
    directory: readonly string[];
    files: Record<string, string>;
    json: Envelope;
    confirm?: boolean;
    runReview?: (request: PayloadCommandRequest) => Promise<Envelope>;
  } = {
    directory: [...PREPARED_FILES, "fix_report.md", ...(setup.review ? ["review_report.md"] : [])],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("Fixed it.", "3 passed."),
      ...(setup.review ? { "review_report.md": REVIEW_REPORT_MD("Recorded earlier.") } : {}),
    },
    json: REVIEW_PACKAGE,
    ...(setup.confirm === undefined ? {} : { confirm: setup.confirm }),
  };
  if (setup.port !== false) {
    options.runReview = async (request) => {
      calls.push({ args: request.args("/tmp/bugpilot-review-payload.json"), payload: request.payload });
      const envelope = setup.answer ? await setup.answer(request) : RECORDED;
      if (envelope.ok) {
        if (!options.directory.includes("review_report.md")) options.directory = [...options.directory, "review_report.md"];
        h.files["review_report.md"] = REVIEW_REPORT_MD();
      }
      return envelope;
    };
  }
  const h = harness(options);
  return { h, calls, options };
}

const opened = async (h: Harness) => {
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
};

/** A request held open until the test answers it. */
function held(): { answer: (request: PayloadCommandRequest) => Promise<Envelope>; resolve: (envelope: Envelope) => void } {
  let resolve: (envelope: Envelope) => void = () => {};
  return {
    answer: () => new Promise<Envelope>((done) => (resolve = done)),
    resolve: (envelope) => resolve(envelope),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("with no fix report there is no Review Result and nothing to record, and the host refuses", async () => {
  const { h, calls, options } = capturable();
  options.directory = PREPARED_FILES;
  await opened(h);
  assert.equal(fixResultOf(h.last()), undefined);

  await h.controller.handle({ type: "recordReview", review: REVIEW_ENTRY });
  await h.controller.handle({ type: "action", id: "openReviewReport" });

  assert.deepEqual(calls, []);
  assert.deepEqual(h.opened, []);
  assert.ok(h.logged.some((line) => /Refusing to record a review result/.test(line)));
  assert.ok(h.logged.some((line) => /Refusing to open a review report/.test(line)));
});

test("a fix report without a saved review offers Add Review Result and Paste Review Output, and shows no Review Result", async () => {
  const { h } = capturable();
  await opened(h);
  const row = fixResultOf(h.last())!;
  assert.equal(row.reviewResult, undefined);
  assert.equal(row.reviewCapture, undefined);
  assert.ok(row.actions.includes("recordReviewResult"));
  assert.equal(row.actions.includes("openReviewReport"), false);
  assert.equal(row.actions.includes("replaceReviewResult"), false);
});

test("a recorded review is one Review Result in its own words, with Open and Replace", async () => {
  const { h } = capturable({ review: true });
  await opened(h);
  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.reviewResult, {
    status: "Review result saved",
    artifact: "review_report.md",
    summary: "Recorded earlier.",
    detail: "Findings: One duplicate null check.",
    alsoRecorded: "Also recorded: recommendations",
  });
  assert.deepEqual([...row.actions], [
    "openFixReport",
    "copyReviewPrompt",
    "reviewWithAI",
    "openReviewReport",
    "pasteReviewOutput",
    "replaceReviewResult",
    "recordVerification",
  ]);
  // One row for the fix, carrying one review result; no new workflow row.
  assert.equal(h.last().workflow.filter((step) => step.id === "fixResult").length, 1);
  assert.equal(h.last().workflow.length, 7);
  // The Fix result row itself says what it said before.
  assert.equal(row.status, "ready");
  assert.equal(row.statusText, "Report available");
});

test("recording sends the four sections through record-review and shows the file it wrote", async () => {
  const { h, calls } = capturable();
  await opened(h);
  const streamsBefore = h.streamRuns.length;
  const writesBefore = h.written.length;
  const progressBefore = JSON.stringify(h.last().progress);

  await h.controller.handle(parsePanelMessage({ type: "recordReview", review: REVIEW_ENTRY })!);

  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]!.args], ["record-review", "JR-12345", "--from-file", "/tmp/bugpilot-review-payload.json", "--json"]);
  assert.deepEqual(calls[0]!.payload, {
    summary: "The change reads correctly.",
    findings: "- One duplicate null check.",
    validation_notes: "",
    recommendations: "- Remove the duplicate.",
  });
  const row = fixResultOf(h.last())!;
  assert.equal(row.reviewResult?.summary, "The change reads correctly.");
  // Said by the host, explicitly: the page closes the form on this and nothing else.
  assert.deepEqual(row.reviewCapture, { state: "recorded", replaced: false });
  assert.ok(row.actions.includes("replaceReviewResult"));
  // Announced once, by the row's status — no second notification.
  assert.equal(h.notices.some((notice) => /Review result/.test(notice.message)), false);
  // The extension wrote nothing itself, started no run, and changed no row but this one's result.
  assert.equal(h.written.length, writesBefore);
  assert.equal(h.streamRuns.length, streamsBefore);
  assert.equal(JSON.stringify(h.last().progress), progressBefore);
  assert.equal(h.last().runError, undefined);
});

test("while recording, the row says so and Record is not offered", async () => {
  const hold = held();
  const { h } = capturable({ answer: hold.answer });
  await opened(h);

  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.reviewCapture, { state: "recording" });
  assert.equal(row.actions.includes("recordReviewResult"), false);

  hold.resolve(RECORDED);
  await recording;
  assert.deepEqual(fixResultOf(h.last())!.reviewCapture, { state: "recorded", replaced: false });
});

test("nothing entered is refused locally, without running record-review", async () => {
  const { h, calls } = capturable();
  await opened(h);

  await h.controller.recordReview({ summary: "  ", findings: "\n", validationNotes: "", recommendations: "\t" });

  assert.deepEqual(calls, []);
  assert.deepEqual(fixResultOf(h.last())!.reviewCapture, {
    state: "failed",
    message: "Review result was not saved: enter at least one section.",
  });
});

test("a CLI failure is the recording's own, says the result was not recorded, and changes nothing else", async () => {
  const { h } = capturable({
    answer: async () => ({ ok: false, command: "record-review", error: { code: "INVALID_INPUT", message: "Findings is longer than 50000 characters." } }),
  });
  await opened(h);
  const progressBefore = JSON.stringify(h.last().progress);

  await h.controller.recordReview(REVIEW_ENTRY);

  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.reviewCapture, {
    state: "failed",
    message: "Review result was not saved: Findings is longer than 50000 characters.",
  });
  assert.equal(row.reviewResult, undefined);
  assert.equal(row.error, undefined, "the failure became the row's");
  assert.equal(row.status, "ready");
  assert.equal(h.last().runError, undefined);
  assert.equal(JSON.stringify(h.last().progress), progressBefore);
  // And it can be tried again.
  assert.ok(row.actions.includes("recordReviewResult"));
});

test("a report recorded meanwhile is kept, and said plainly", async () => {
  const { h } = capturable({
    answer: async () => ({ ok: false, command: "record-review", error: { code: "ARTIFACT_EXISTS", message: "kept" } }),
  });
  await opened(h);
  await h.controller.recordReview(REVIEW_ENTRY);
  assert.match(
    (fixResultOf(h.last())!.reviewCapture as { message: string }).message,
    /^Review result was not saved: a review result is already saved for this work item, and it was kept\.$/,
  );
});

test("replacing a recorded review asks first, and only a yes passes --replace", async () => {
  const declined = capturable({ review: true, confirm: false });
  await opened(declined.h);
  await declined.h.controller.recordReview(REVIEW_ENTRY);
  assert.deepEqual(declined.calls, []);
  assert.equal(fixResultOf(declined.h.last())!.reviewResult?.summary, "Recorded earlier.");
  assert.equal(fixResultOf(declined.h.last())!.reviewCapture, undefined);
  assert.ok(fixResultOf(declined.h.last())!.actions.includes("replaceReviewResult"), "Replace was not offered again");

  const accepted = capturable({ review: true, confirm: true });
  await opened(accepted.h);
  await accepted.h.controller.recordReview(REVIEW_ENTRY);
  assert.deepEqual([...accepted.calls[0]!.args], [
    "record-review", "JR-12345", "--from-file", "/tmp/bugpilot-review-payload.json", "--json", "--replace",
  ]);
  assert.equal(fixResultOf(accepted.h.last())!.reviewResult?.summary, "The change reads correctly.");
  assert.deepEqual(fixResultOf(accepted.h.last())!.reviewCapture, { state: "recorded", replaced: true });
});

test("a second recording is refused by the host while one is in flight, whatever the page shows", async () => {
  const hold = held();
  const { h, calls } = capturable({ answer: hold.answer });
  await opened(h);

  const first = h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  // Straight to the controller, as a page ignoring its own disabled button would.
  await h.controller.handle({ type: "recordReview", review: REVIEW_ENTRY });
  await h.controller.recordReview(REVIEW_ENTRY);
  assert.equal(calls.length, 1);
  assert.equal(h.logged.filter((line) => /Refusing to record a review result/.test(line)).length, 2);

  hold.resolve(RECORDED);
  await first;
  assert.equal(calls.length, 1);
});

test("a recording in flight when another work item opens is never reported under it", async () => {
  const hold = held();
  const { h } = capturable({ answer: hold.answer });
  await opened(h);
  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();

  await h.controller.showWorkItem("JR-77777");
  hold.resolve({ ok: false, command: "record-review", error: { code: "INVALID_INPUT", message: "late failure" } });
  await recording;

  assert.equal(h.last().workItemId, "JR-77777");
  const row = fixResultOf(h.last());
  assert.equal(row?.reviewCapture, undefined, "the previous item's recording landed on this one");
  assert.equal(h.notices.some((notice) => /Review result/.test(notice.message)), false);
  // And the new item may record its own.
  assert.ok(row?.actions.includes("recordReviewResult"));
});

test("reopening the same work item drops a recording in flight, and a success is not announced", async () => {
  const hold = held();
  const { h } = capturable({ answer: hold.answer });
  await opened(h);
  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();

  await h.controller.showWorkItem("JR-12345");
  hold.resolve(RECORDED);
  await recording;

  assert.equal(fixResultOf(h.last())!.reviewCapture, undefined);
  assert.equal(h.notices.some((notice) => /Review result/.test(notice.message)), false);
});

/** A capturable item whose runs hold open, so a run in flight can be observed. */
function capturableRuns(setup: Parameters<typeof capturable>[0] = {}) {
  const made = capturable(setup);
  (made.options as { events?: readonly StreamEvent[] }).events = successfulRun.filter((event) => event.type !== "completed");
  (made.options as { hold?: boolean }).hold = true;
  return made;
}

const RUN_REFUSED = "Wait for the review result recording to finish before starting a run.";

test("no run of any kind starts while a review result is being recorded; the host refuses it", async () => {
  const hold = held();
  const { h } = capturableRuns({ answer: hold.answer });
  await opened(h);
  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  const progressBefore = JSON.stringify(h.last().progress);

  // Run, Fresh and a re-prepare, straight to the controller and through the page's message.
  // Not awaited one by one: a run that did start would hold here, and the test
  // should fail on the count rather than hang.
  const attempts = [
    h.controller.run(jiraForm()),
    h.controller.run(jiraForm({ fresh: true })),
    h.controller.handle(parsePanelMessage({ type: "run", form: jiraForm({ fresh: true }) })!),
  ];
  await tick();

  assert.equal(h.streamRuns.length, 0, "a run started while a recording was in flight");
  await Promise.all(attempts);
  assert.equal(h.notices.filter((notice) => notice.kind === "warning" && notice.message === RUN_REFUSED).length, 3);
  assert.equal(JSON.stringify(h.last().progress), progressBefore);
  assert.deepEqual(fixResultOf(h.last())!.reviewCapture, { state: "recording" });

  // The recording finishes where it began, on the same work item.
  hold.resolve(RECORDED);
  await recording;
  assert.equal(h.last().workItemId, "JR-12345");
  assert.deepEqual(fixResultOf(h.last())!.reviewCapture, { state: "recorded", replaced: false });
  assert.equal(fixResultOf(h.last())!.reviewResult?.summary, "The change reads correctly.");

  // And now a run may start.
  const running = h.controller.run(jiraForm());
  await tick();
  assert.equal(h.streamRuns.length, 1);
  assert.equal(h.last().progress.state, "running");
  h.release();
  await running;
});

test("a recording that failed, or a replace declined, leaves Run available again", async () => {
  const failing = capturableRuns({
    answer: async () => ({ ok: false, command: "record-review", error: { code: "INVALID_INPUT", message: "no" } }),
  });
  await opened(failing.h);
  await failing.h.controller.recordReview(REVIEW_ENTRY);
  const afterFailure = failing.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  assert.equal(failing.h.streamRuns.length, 1);
  failing.h.release();
  await afterFailure;

  const declined = capturableRuns({ review: true, confirm: false });
  await opened(declined.h);
  await declined.h.controller.recordReview(REVIEW_ENTRY);
  const afterDecline = declined.h.controller.run(jiraForm());
  await tick();
  assert.equal(declined.h.streamRuns.length, 1);
  declined.h.release();
  await afterDecline;
});

test("while a run is in flight no recording starts, and one refused leaves the run alone", async () => {
  const { h, calls } = capturableRuns();
  await opened(h);
  const running = h.controller.run(jiraForm());
  await tick();
  assert.equal(h.last().progress.state, "running");
  assert.equal(fixResultOf(h.last())!.actions.includes("recordReviewResult"), false);

  await h.controller.recordReview(REVIEW_ENTRY);

  assert.deepEqual(calls, []);
  assert.equal(fixResultOf(h.last())!.reviewCapture, undefined);
  assert.equal(h.last().progress.state, "running");
  h.release();
  await running;
});

test("Open Review Report opens the canonical file of the work item on screen, and nothing else", async () => {
  const { h } = capturable({ review: true });
  await opened(h);
  await h.controller.handle(parsePanelMessage({ type: "action", id: "openReviewReport" })!);
  assert.deepEqual(h.opened.map((file) => file.split(/[\\/]/).slice(-3).join("/")), [".ai/JR-12345/review_report.md"]);
  // The page cannot name a file through it.
  assert.equal(parsePanelMessage({ type: "action", id: "openReviewReport", name: "../../secret" })?.type, "action");
  assert.equal(parsePanelMessage({ type: "recordReview", review: "not an object" }), undefined);
});

test("reopening a work item discovers its recorded review from the file alone", async () => {
  const { h, options } = capturable();
  await opened(h);
  assert.equal(fixResultOf(h.last())!.reviewResult, undefined);
  // Recorded outside this panel — by the CLI in a terminal, say.
  options.directory = [...options.directory, "review_report.md"];
  h.files["review_report.md"] = REVIEW_REPORT_MD("Recorded in a terminal.");

  await h.controller.showWorkItem("JR-12345");
  assert.equal(fixResultOf(h.last())!.reviewResult?.summary, "Recorded in a terminal.");
  // An unreadable one is still a result to open.
  delete h.files["review_report.md"];
  await h.controller.refreshArtifacts();
  assert.deepEqual(
    { summary: fixResultOf(h.last())!.reviewResult?.summary, detail: fixResultOf(h.last())!.reviewResult?.detail },
    { summary: "Review result saved", detail: "Preview unavailable" },
  );
});

test("a same-item re-prepare keeps the recorded review on screen; a Fresh run does not", async () => {
  const kept = capturable({ review: true });
  (kept.options as { events?: readonly StreamEvent[]; hold?: boolean }).events = successfulRun.filter((event) => event.type !== "completed");
  (kept.options as { hold?: boolean }).hold = true;
  await opened(kept.h);
  const rerun = kept.h.controller.run(jiraForm());
  await tick();
  assert.equal(fixResultOf(kept.h.last())!.reviewResult?.summary, "Recorded earlier.");
  kept.h.release();
  await rerun;

  const fresh = capturable({ review: true });
  (fresh.options as { events?: readonly StreamEvent[]; hold?: boolean }).events = successfulRun.filter((event) => event.type !== "completed");
  (fresh.options as { hold?: boolean }).hold = true;
  await opened(fresh.h);
  const freshRun = fresh.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  assert.equal(fixResultOf(fresh.h.last()), undefined, "a Fresh run kept the previous attempt's reports on screen");
  fresh.h.release();
  await freshRun;
});

test("without a record-review port the host says so, rather than writing the file itself", async () => {
  const { h } = capturable({ port: false });
  await opened(h);
  const writesBefore = h.written.length;
  await h.controller.recordReview(REVIEW_ENTRY);
  assert.equal(h.written.length, writesBefore);
  assert.match((fixResultOf(h.last())!.reviewCapture as { message: string }).message, /^Review result was not saved/);
});

test("a review recorded elsewhere meanwhile: the failure is said, and the row reads the folder again to offer it", async () => {
  const setup = capturable({
    answer: async () => ({ ok: false, command: "record-review", error: { code: "ARTIFACT_EXISTS", message: "kept" } }),
  });
  await opened(setup.h);
  // Written by a terminal while the panel was open.
  setup.options.directory = [...setup.options.directory, "review_report.md"];
  setup.h.files["review_report.md"] = REVIEW_REPORT_MD("Recorded in a terminal.");

  await setup.h.controller.recordReview(REVIEW_ENTRY);

  const row = fixResultOf(setup.h.last())!;
  assert.match((row.reviewCapture as { message: string }).message, /already saved/);
  assert.equal(row.reviewResult?.summary, "Recorded in a terminal.");
  assert.ok(row.actions.includes("replaceReviewResult"));
  assert.ok(row.actions.includes("openReviewReport"));
});

test("declining a replace leaves no earlier failure on screen", async () => {
  const setup = capturable({ review: true, confirm: false });
  await opened(setup.h);
  await setup.h.controller.recordReview({ summary: " ", findings: "", validationNotes: "", recommendations: "" });
  assert.equal(fixResultOf(setup.h.last())!.reviewCapture?.state, "failed");
  await setup.h.controller.recordReview(REVIEW_ENTRY);
  assert.equal(fixResultOf(setup.h.last())!.reviewCapture, undefined);
});

test("a section over the cap reaches record-review one character too long, never cut to fit", () => {
  const message = parsePanelMessage({
    type: "recordReview",
    review: { summary: "x".repeat(60_000), findings: "", validationNotes: "", recommendations: "" },
  }) as { review: { summary: string } };
  assert.equal(message.review.summary.length, 50_001);
});

// --- Review with AI, captured: one-shot, read back, prefilled, never saved -----

const CAPTURED_REVIEW =
  "Let me look at the diff first.\n\n## Summary\nThe change handles the null input.\n\n## Findings\nNothing to report.\n\n" +
  "## Validation Notes\nRead fix_report.md and ran git diff. No tests were run.\n\n## Recommendations\nAdd a regression test.\n";

const CAPTURED_ENTRY = {
  summary: "The change handles the null input.",
  findings: "Nothing to report.",
  validationNotes: "Read fix_report.md and ran git diff. No tests were run.",
  recommendations: "Add a regression test.",
};

/** Claude Code's `--output-format json` result object around a reply. */
const claudeJson = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "s", ...extra });

type CapturedCall = { command: string; args: readonly string[]; cwd: string; input: string };

/**
 * A report on screen and a captured-review port that records its call and
 * answers — or holds, until `finish` is called.
 */
function capturedReview(answer: (call: CapturedCall) => Promise<CapturedRun> | CapturedRun, extra: HarnessOptions = {}) {
  const calls: CapturedCall[] = [];
  const store = new Map<string, string>();
  const options = reviewOptions({
    runCaptured: async (call) => {
      calls.push({ ...call, args: [...call.args] });
      return answer(call);
    },
    reviewedFixes: { get: (id) => store.get(id), set: (id, fix) => (fix === undefined ? store.delete(id) : store.set(id, fix)) },
    ...extra,
  });
  return { options, calls, store };
}

const ok = (stdout: string): CapturedRun => ({ code: 0, stdout, stderr: "", aborted: false });

test("a supported agent reviews one-shot: the prompt on stdin, the repository as cwd, no terminal", async () => {
  const { options, calls } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)));
  const h = await openedForReview(options);

  await h.controller.handle(REVIEW);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "claude");
  assert.deepEqual(calls[0]!.args, [...CLAUDE_CAPTURED_REVIEW.args]);
  assert.equal(calls[0]!.cwd, ROOT);
  // The prompt review-package gave, exactly, on stdin; never on a command line.
  assert.equal(calls[0]!.input, REVIEW_PROMPT);
  assert.equal(calls[0]!.args.some((arg) => arg.includes("Final Review Request")), false);
  assert.deepEqual(h.terminals, [], "a captured review opened a terminal");
});

test("started is not finished: while the reviewer runs the row says Reviewing…, and nothing else may start", async () => {
  let finish: (run: CapturedRun) => void = () => {};
  const { options, calls } = capturedReview(() => new Promise<CapturedRun>((resolve) => (finish = resolve)));
  const h = await openedForReview(options);

  const reviewing = h.controller.handle(REVIEW);
  await tick();
  const row = fixResultOf(h.last())!;
  assert.equal(reviewOf(h.last())?.state, "reviewing");
  assert.equal((reviewOf(h.last()) as { summary: string }).summary, "Reviewing with Claude CLI…");
  assert.equal(row.reviewPrefill, undefined, "a draft before the reviewer finished");
  assert.equal(row.actions.includes("reviewWithAI"), false);
  // Everything that would touch the folder waits: a second review, recordings, a paste, a run.
  assert.equal(row.actions.includes("pasteReviewOutput"), false);
  assert.equal(row.actions.includes("recordReviewResult"), false);
  assert.equal(h.last().primary.busy || !h.last().primary.enabled, true, "the primary action stayed available");
  await h.controller.handle(REVIEW);
  await h.controller.recordReview(REVIEW_ENTRY);
  await h.controller.handle({ type: "parseReviewOutput", text: CAPTURED_REVIEW });
  await h.controller.run(jiraForm());
  assert.equal(calls.length, 1, "a second reviewer started");
  assert.equal(h.streamRuns.length, 0, "a run started under the reviewer");
  assert.match(h.notices.at(-1)?.message ?? "", /Wait for the AI review to finish/);
  const cleaned = await h.controller.clean("JR-12345", async () => assert.fail("cleaned under the reviewer"));
  assert.equal(cleaned, false);

  finish(ok(claudeJson(CAPTURED_REVIEW)));
  await reviewing;
  assert.equal(reviewOf(h.last())?.state, "captured");
});

test("a finished review whose reply parses becomes the draft — prefilled, marked as AI, and not saved", async () => {
  const { options } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)));
  const saves: unknown[] = [];
  options.runReview = async (request) => {
    saves.push(request.payload);
    return RECORDED;
  };
  const h = await openedForReview(options);

  await h.controller.handle(REVIEW);

  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.reviewPrefill, { token: 1, entry: CAPTURED_ENTRY, leftOut: true, source: "ai" });
  assert.equal(reviewOf(h.last())?.state, "captured");
  assert.equal((reviewOf(h.last()) as { summary: string }).summary, "AI review finished");
  // Not saved: no record-review, no review_report.md, no Review Result.
  assert.deepEqual(saves, []);
  assert.deepEqual(h.written, []);
  assert.equal(row.reviewResult, undefined);
  assert.equal(row.actions.includes("recordReviewResult"), true);
  // Held across pushes, the same token each time.
  await h.controller.refreshArtifacts();
  assert.deepEqual(fixResultOf(h.last())!.reviewPrefill, row.reviewPrefill);
  // Save, with the developer's edits, is what records — and it drops the draft.
  await h.controller.handle({ type: "recordReview", review: { ...CAPTURED_ENTRY, findings: "One nit." } });
  assert.deepEqual(saves, [{
    summary: CAPTURED_ENTRY.summary,
    findings: "One nit.",
    validation_notes: CAPTURED_ENTRY.validationNotes,
    recommendations: CAPTURED_ENTRY.recommendations,
  }]);
  assert.equal(fixResultOf(h.last())!.reviewPrefill, undefined);
  // Saving does not bring Review with AI back: it is the same fix.
  assert.equal(offersReview(h.last()), false);
});

test("the captured and the pasted path give the same draft for the same reply", async () => {
  const captured = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)));
  const a = await openedForReview(captured.options);
  await a.controller.handle(REVIEW);
  const b = await openedForReview(capturedReview(() => ok("")).options);
  await b.controller.handle({ type: "parseReviewOutput", text: CAPTURED_REVIEW });
  const fromCapture = fixResultOf(a.last())!.reviewPrefill as { entry: unknown; leftOut?: boolean };
  const fromPaste = fixResultOf(b.last())!.reviewPrefill as { entry: unknown; leftOut?: boolean };
  assert.deepEqual(fromCapture.entry, fromPaste.entry);
  assert.equal(fromCapture.leftOut, fromPaste.leftOut);
});

test("a finished review with no usable reply gives no draft, keeps Review with AI hidden, and offers the paste", async () => {
  const cases: { run: CapturedRun; title: RegExp; reply?: boolean }[] = [
    { run: ok(""), title: /^Review result could not be captured automatically\.$/ },
    { run: ok("Here is my review, in prose."), title: /^Review result could not be captured automatically\.$/ },
    { run: ok(claudeJson("## Summary\nA.\n## Findings\nB.\n")), title: /^Review result could not be captured automatically\.$/, reply: true },
    { run: ok(claudeJson(`${CAPTURED_REVIEW}\n## Recommendations\nAdd a regression test.\n`)), title: /could not be captured/, reply: true },
    { run: { code: 1, stdout: "", stderr: "Not logged in\n", aborted: false }, title: /^AI review did not produce a usable structured result\.$/ },
    { run: { code: 1, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false }, title: /did not produce a usable/ },
    { run: ok(claudeJson("Credit balance too low", { is_error: true, subtype: "error_during_execution" })), title: /did not produce a usable/ },
    { run: { code: null, stdout: "", stderr: "", aborted: true }, title: /^AI review did not finish within the allowed time\.$/ },
  ];
  for (const { run, title, reply } of cases) {
    const { options } = capturedReview(() => run);
    const h = await openedForReview(options);
    await h.controller.handle(REVIEW);
    const row = fixResultOf(h.last())!;
    const view = reviewOf(h.last()) as { state: string; summary: string; detail: string; reply?: string };
    assert.equal(view.state, "captureFailed", JSON.stringify(run));
    assert.match(view.summary, title);
    assert.equal(/fail(ed)?\b|rejected/i.test(view.summary), false, view.summary);
    assert.equal(row.reviewPrefill, undefined, "a draft from an unusable reply");
    assert.equal(row.actions.includes("reviewWithAI"), false, "Review with AI came back after a started review");
    assert.equal(row.actions.includes("pasteReviewOutput"), true);
    assert.equal(view.reply !== undefined, reply === true, JSON.stringify(run));
    assert.deepEqual(h.written, []);
  }
});

test("a reviewer that never launched is not an attempt: Review with AI stays offered", async () => {
  const { options, store } = capturedReview(() => {
    throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  });
  const h = await openedForReview(options);
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "failed");
  assert.equal(offersReview(h.last()), true);
  assert.equal(store.size, 0, "a launch that failed was remembered as a review attempt");
  // Nor is an agent that is not on PATH.
  const unavailable = await openedForReview(capturedReview(() => ok(""), { agentOnPath: false }).options);
  await unavailable.controller.handle(REVIEW);
  assert.equal(offersReview(unavailable.last()), true);
});

test("a custom agent is never captured: it gets the terminal, and the paste afterwards", async () => {
  const { options, calls } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)), {
    form: { ...DEFAULT_FORM, agent: "custom", agentCommand: "codex {prompt}" },
  });
  const h = await openedForReview(options);
  await h.controller.handle(REVIEW);
  assert.deepEqual(calls, []);
  assert.equal(h.terminals.length, 1);
  assert.equal(reviewOf(h.last())?.state, "started");
  assert.match((reviewOf(h.last()) as { next: string }).next, /Paste Review Output/);
  assert.equal(offersReview(h.last()), false);
});

test("the attempt belongs to the fix: settings, Rebuild Context and a new attempt keep it hidden; a new report brings it back", async () => {
  const { options, store } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)));
  const h = await openedForReview(options);
  await h.controller.handle(REVIEW);
  assert.equal(offersReview(h.last()), false);

  // A settings change, even one that makes the context stale.
  await h.controller.handle({ type: "applySettings", form: jiraForm({ keywords: "cache" }) });
  assert.equal(offersReview(h.last()), false, "a settings change brought Review with AI back");
  // Rebuild Context: a non-Fresh re-prepare keeps the same report.
  await h.controller.run(jiraForm());
  assert.equal(offersReview(h.last()), false, "Rebuild Context brought Review with AI back");
  // The same report written again, byte for byte (CRLF this time): the same fix.
  h.files["fix_report.md"] = fixReportMd("Fixed it.", "3 passed.").replace(/\n/g, "\r\n");
  await h.controller.refreshArtifacts();
  assert.equal(offersReview(h.last()), false, "the same report, rewritten, counted as a new fix");
  // A new attempt's report is a new fix.
  h.files["fix_report.md"] = fixReportMd("Fixed it in the controller instead.", "5 passed.");
  await h.controller.refreshArtifacts();
  assert.equal(offersReview(h.last()), true);
  assert.equal(reviewOf(h.last()), undefined, "the last fix's review showed on the new one");
  assert.equal(store.size, 1);
});

test("the reviewed fix survives a reload of the host, and one work item's review does not hide another's", async () => {
  const { options, store } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)));
  const first = await openedForReview(options);
  await first.controller.handle(REVIEW);
  assert.equal(store.size, 1);

  // A new controller over the same persisted store: a reloaded window.
  const reloaded = await openedForReview({ ...options });
  assert.equal(offersReview(reloaded.last()), false);
  assert.equal(reviewOf(reloaded.last())?.state, "earlier");
  assert.equal(fixResultOf(reloaded.last())!.reviewPrefill, undefined, "an unsaved draft outlived the host");

  // Another work item, with its own report: never reviewed.
  const other = capturedReview(() => ok(""), twoReports(REVIEW_PACKAGE));
  for (const [id, fix] of store) other.store.set(id, fix);
  const b = await openedForReview(other.options, "JR-2");
  assert.equal(offersReview(b.last()), true);
});

test("a saved review is not overwritten by a new captured draft: Save asks before replacing", async () => {
  let confirmed = 0;
  const { options } = capturedReview(() => ok(claudeJson(CAPTURED_REVIEW)), {
    directory: [...PREPARED_FILES, "fix_report.md", "review_report.md"],
    confirmAnswer: async () => {
      confirmed += 1;
      return false;
    },
  });
  options.files!["review_report.md"] = REVIEW_REPORT_MD("Saved earlier.");
  const saves: unknown[] = [];
  options.runReview = async (request) => {
    saves.push(request.payload);
    return RECORDED;
  };
  const h = await openedForReview(options);
  await h.controller.handle(REVIEW);
  const row = fixResultOf(h.last())!;
  assert.ok(row.reviewPrefill && "entry" in row.reviewPrefill);
  assert.equal(row.reviewResult?.summary, "Saved earlier.", "the saved review was touched");
  assert.ok(row.actions.includes("replaceReviewResult"));
  await h.controller.handle({ type: "recordReview", review: CAPTURED_ENTRY });
  assert.equal(confirmed, 1);
  assert.deepEqual(saves, [], "a saved review was replaced without asking");
});

// --- Paste Review Output: a pasted review fills the form, and saves nothing ----

const PASTED_REVIEW =
  "Here is my review.\n\n## Summary\nMain fix addresses the issue.\n\n## Findings\nMissing null handling in WidgetController.\n\n" +
  "## Validation Notes\nReviewed the diff. No tests were run.\n\n## Recommendations\nAdd a regression test.\n";

const PASTED_ENTRY = {
  summary: "Main fix addresses the issue.",
  findings: "Missing null handling in WidgetController.",
  validationNotes: "Reviewed the diff. No tests were run.",
  recommendations: "Add a regression test.",
};

test("a pasted review is read into the four sections and sent once — nothing is saved or written", async () => {
  const { h, calls } = capturable();
  await opened(h);
  assert.ok(fixResultOf(h.last())!.actions.includes("pasteReviewOutput"));
  const before = h.states.length;

  await h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW });

  const pushed = h.states.slice(before);
  assert.equal(pushed.length, 1, "one push carries the answer");
  assert.deepEqual(fixResultOf(pushed[0]!)!.reviewPrefill, { token: 1, entry: PASTED_ENTRY, leftOut: true });
  // Reading is not saving: no record-review, no file, no Review Result, no capture.
  assert.deepEqual(calls, []);
  assert.deepEqual(h.written, []);
  assert.equal(fixResultOf(h.last())!.reviewResult, undefined);
  assert.equal(fixResultOf(h.last())!.reviewCapture, undefined);
  // Held, with the same token, until saved or discarded: a recreated panel
  // fills its form again, and the page's token check keeps it from refilling.
  await h.controller.refreshArtifacts();
  assert.deepEqual(fixResultOf(h.last())!.reviewPrefill, { token: 1, entry: PASTED_ENTRY, leftOut: true });
  // A second paste is a second answer, with its own token.
  await h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW.replace("Here is my review.\n\n", "") });
  assert.deepEqual(fixResultOf(h.states.at(-1)!)!.reviewPrefill, { token: 2, entry: PASTED_ENTRY });
  // Cancel discards it.
  await h.controller.handle({ type: "discardReviewDraft" });
  assert.equal(fixResultOf(h.last())!.reviewPrefill, undefined);
});

test("the prefilled review, edited and saved, is what record-review receives", async () => {
  const { h, calls } = capturable();
  await opened(h);
  await h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW });
  const edited = { ...PASTED_ENTRY, recommendations: "Add a regression test for the null path." };

  await h.controller.handle({ type: "recordReview", review: edited });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.payload, {
    summary: edited.summary,
    findings: edited.findings,
    validation_notes: edited.validationNotes,
    recommendations: edited.recommendations,
  });
  assert.deepEqual(fixResultOf(h.last())!.reviewCapture, { state: "recorded", replaced: false });
});

test("a paste that is not in the four-section shape is refused with the reason, and nothing else changes", async () => {
  const { h, calls } = capturable();
  await opened(h);

  await h.controller.handle({ type: "parseReviewOutput", text: "Verdict: PASS\nLooks good to me.\n" });

  const prefill = fixResultOf(h.states.at(-1)!)!.reviewPrefill as { token: number; error: string };
  assert.equal(prefill.token, 1);
  assert.match(prefill.error, /^Review output was not read: these sections are missing: ## Summary, ## Findings/);
  assert.equal("entry" in prefill, false);
  assert.deepEqual(calls, []);
  assert.equal(fixResultOf(h.last())!.reviewCapture, undefined, "a parse failure was reported as a save failure");
});

test("an oversized paste is refused safely, however the page sent it", async () => {
  const { h, calls } = capturable();
  await opened(h);
  const huge = `## Summary\n${"x".repeat(300_000)}\n## Findings\n\n## Validation Notes\n\n## Recommendations\n`;
  const message = parsePanelMessage({ type: "parseReviewOutput", text: huge });
  assert.ok(message && message.type === "parseReviewOutput");
  // Clamped one past the cap, so the parser refuses it rather than reading a cut-short review.
  assert.equal(message.text.length, MAX_REVIEW_OUTPUT + 1);
  assert.equal(parsePanelMessage({ type: "parseReviewOutput", text: 5 }), undefined, "a paste that is not text");
  assert.equal(parsePanelMessage({ type: "parseReviewOutput" }), undefined);

  await h.controller.handle(message);

  const prefill = fixResultOf(h.states.at(-1)!)!.reviewPrefill as { error: string };
  assert.match(prefill.error, /^Review output was not read: it is longer than/);
  assert.deepEqual(calls, []);
});

test("no pass, fail or approval is read out of a pasted review", async () => {
  const { h } = capturable();
  await opened(h);
  const overallBefore = JSON.stringify(h.last().overall);
  await h.controller.handle({
    type: "parseReviewOutput",
    text: "## Summary\nPASS — approved, safe to merge.\n## Findings\nNone.\n## Validation Notes\nVerified.\n## Recommendations\nMerge.\n",
  });
  const row = fixResultOf(h.states.at(-1)!)!;
  const prefill = row.reviewPrefill as unknown as { entry: Record<string, string> };
  assert.deepEqual(Object.keys(prefill).sort(), ["entry", "token"]);
  assert.equal(prefill.entry["summary"], "PASS — approved, safe to merge.");
  // The row says nothing new: no result, no status, the same summary.
  assert.equal(row.reviewResult, undefined);
  assert.equal(row.status, "ready");
  assert.equal(row.summary, "Fixed it.");
  assert.equal(JSON.stringify(h.last().overall), overallBefore, "the header changed");
});

test("with no fix report, or while a save is in flight, a paste is refused and nothing is sent", async () => {
  const none = capturable();
  none.options.directory = PREPARED_FILES;
  await opened(none.h);
  const before = none.h.states.length;
  await none.h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW });
  assert.equal(none.h.states.length, before);
  assert.ok(none.h.logged.some((line) => /Refusing to read review output/.test(line)));

  const hold = held();
  const busy = capturable({ answer: hold.answer });
  await opened(busy.h);
  const saving = busy.h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  assert.equal(fixResultOf(busy.h.last())!.actions.includes("pasteReviewOutput"), false);
  await busy.h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW });
  assert.equal(busy.h.states.some((state) => fixResultOf(state)?.reviewPrefill !== undefined), false);
  hold.resolve(RECORDED);
  await saving;
});

test("an unsaved pasted review is not Start New Attempt feedback; a saved one is", async () => {
  const setup = {
    agentOnPath: true,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
  };
  const h = harness(setup);
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  await h.controller.handle({ type: "parseReviewOutput", text: PASTED_REVIEW });
  assert.equal(fixRow(h.last()).feedbackHelpers, undefined, "Use Review Findings was offered for an unsaved review");
  await h.controller.handle({ type: "action", id: "useReviewFindings" });
  assert.equal(h.states.some((state) => fixRow(state).attemptDraft !== undefined), false);

  // Saved — review_report.md listed — the helper is offered, and still only on a press.
  const saved = harness({
    ...setup,
    directory: [...setup.directory, "review_report.md"],
    files: { ...setup.files, "review_report.md": REVIEW_REPORT_MD() },
  });
  await saved.controller.refreshEnvironment();
  await saved.controller.showWorkItem("JR-12345");
  assert.deepEqual(fixRow(saved.last()).feedbackHelpers, ["useReviewFindings"]);
  assert.equal(fixRow(saved.last()).attemptDraft, undefined);
});

test("a record-review still running after a reopen or another item keeps every run out, and a second recording too", async () => {
  // The outcome is dropped when the work item changes; the process is not. Until
  // it ends, a Fresh run would delete the folder under its late write.
  const hold = held();
  const { h, calls } = capturableRuns({ answer: hold.answer });
  await opened(h);
  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();

  await h.controller.showWorkItem("JR-12345");
  const sameAgain = h.controller.run(jiraForm({ fresh: true }));
  await h.controller.recordReview(REVIEW_ENTRY);
  await h.controller.showWorkItem("JR-77777");
  const another = h.controller.run(jiraForm({ issueKey: "JR-77777", fresh: true }));
  await tick();
  assert.equal(h.streamRuns.length, 0, "a run started while record-review was still running");
  assert.equal(calls.length, 1, "a second recording started while the first was still running");
  assert.equal(fixResultOf(h.last())?.actions.includes("recordReviewResult"), false);
  await Promise.all([sameAgain, another]);

  hold.resolve(RECORDED);
  await recording;
  // Ended, unreported (another item is on screen) — and the screen is told so.
  assert.equal(fixResultOf(h.last())?.reviewCapture, undefined);
  assert.equal(fixResultOf(h.last())?.actions.includes("recordReviewResult"), true);
  const running = h.controller.run(jiraForm({ issueKey: "JR-77777" }));
  await tick();
  assert.equal(h.streamRuns.length, 1);
  h.release();
  await running;
});

test("a recording pressed while a run is still being set up keeps that run from starting", async () => {
  // Between run()'s first check and the run starting there are waits — the
  // Fresh confirmation among them. A recording begun in that window wins.
  let answer!: (yes: boolean) => void;
  const hold = held();
  const made = capturableRuns({ answer: hold.answer });
  (made.options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = () =>
    new Promise<boolean>((resolve) => (answer = resolve));
  await opened(made.h);

  const run = made.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  const recording = made.h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  answer(true);
  await run;

  assert.equal(made.h.streamRuns.length, 0, "the run started over a recording");
  assert.ok(made.h.notices.some((notice) => notice.message === RUN_REFUSED));
  hold.resolve(RECORDED);
  await recording;
});

// --- Batch 12: Verification Evidence ---------------------------------------------

const VERIFICATION_MD =
  "# Verification Report: JR-12345\n\n" +
  "## Summary\n\n3 checks recorded: 1 passed, 1 failed, 1 not run.\n\n" +
  "## Checks\n\n" +
  "### Check 1: Unit tests\n\nStatus: Passed\nType: Automated\n\n" +
  "Command / Procedure:\n\n> npm test\n\nEvidence:\n\n> 1111 passed\n\nNotes:\n\nNot recorded.\n\n" +
  "### Check 2: Open the dialog\n\nStatus: Failed\nType: Manual\n\n" +
  "Command / Procedure:\n\nNot recorded.\n\nEvidence:\n\n> Crashed on save.\n\nNotes:\n\nNot recorded.\n\n" +
  "### Check 3: Integration suite\n\nStatus: Not Run\nType: Automated\n\n" +
  "Command / Procedure:\n\nNot recorded.\n\nEvidence:\n\nNot recorded.\n\nNotes:\n\nNot recorded.\n\n" +
  "## Overall Recorded Status\n\nRecorded checks include failures.\n\n" +
  "## Source\n\nVerification evidence explicitly recorded by the user.\n";

const ONE_PASSED_MD =
  "# Verification Report: JR-12345\n\n" +
  "## Summary\n\n1 check recorded: 1 passed.\n\n" +
  "## Checks\n\n" +
  "### Check 1: Unit tests\n\nStatus: Passed\nType: Automated\n\n" +
  "Command / Procedure:\n\n> npm test\n\nEvidence:\n\nNot recorded.\n\nNotes:\n\nNot recorded.\n\n" +
  "## Overall Recorded Status\n\nAll recorded checks passed.\n\n" +
  "## Source\n\nVerification evidence explicitly recorded by the user.\n";

const CHECKS = [
  { name: "Unit tests", status: "passed", type: "automated", procedure: "npm test", evidence: "", notes: "" },
] as const;

const VERIFICATION_RECORDED: Envelope = {
  ok: true,
  command: "record-verification",
  warnings: [],
  work_item_id: "JR-12345",
  verification_report: ".ai/JR-12345/verification_report.md",
  replaced: false,
};

const VERIFY_RUN_REFUSED = "Wait for the verification evidence recording to finish before starting a run.";
const CLEAN_REFUSED = "Wait for artifact recording to finish before cleaning this work item.";

/**
 * A reopened work item with a fix report, optionally recorded evidence (the
 * canonical report, or `evidence` text of the test's own), and ports for both
 * recordings that behave like the CLI: they write the file into the live
 * listing and answer. `answer` may hold a verification request open.
 */
function verifiable(setup: {
  evidence?: boolean | string;
  review?: boolean;
  answer?: (request: PayloadCommandRequest) => Promise<Envelope>;
  reviewAnswer?: (request: PayloadCommandRequest) => Promise<Envelope>;
  port?: boolean;
  hold?: boolean;
  confirm?: boolean;
} = {}) {
  const calls: { args: readonly string[]; payload: unknown }[] = [];
  const reviewCalls: { args: readonly string[] }[] = [];
  const evidenceText = typeof setup.evidence === "string" ? setup.evidence : VERIFICATION_MD;
  const options: {
    directory: readonly string[];
    files: Record<string, string>;
    json: Envelope;
    confirm?: boolean;
    events?: readonly StreamEvent[];
    hold?: boolean;
    runReview?: (request: PayloadCommandRequest) => Promise<Envelope>;
    runVerification?: (request: PayloadCommandRequest) => Promise<Envelope>;
  } = {
    directory: [
      ...PREPARED_FILES,
      "fix_report.md",
      ...(setup.review ? ["review_report.md"] : []),
      ...(setup.evidence ? ["verification_report.md"] : []),
    ],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("Fixed it.", "3 passed."),
      ...(setup.review ? { "review_report.md": REVIEW_REPORT_MD("Recorded earlier.") } : {}),
      ...(setup.evidence ? { "verification_report.md": evidenceText } : {}),
    },
    json: REVIEW_PACKAGE,
    ...(setup.confirm === undefined ? {} : { confirm: setup.confirm }),
    ...(setup.hold ? { events: successfulRun.filter((event) => event.type !== "completed"), hold: true } : {}),
  };
  options.runReview = async (request) => {
    reviewCalls.push({ args: request.args("/tmp/bugpilot-review-payload.json") });
    const envelope = setup.reviewAnswer ? await setup.reviewAnswer(request) : RECORDED;
    if (envelope.ok && !options.directory.includes("review_report.md")) {
      options.directory = [...options.directory, "review_report.md"];
      h.files["review_report.md"] = REVIEW_REPORT_MD();
    }
    return envelope;
  };
  if (setup.port !== false) {
    options.runVerification = async (request) => {
      calls.push({ args: request.args("/tmp/bugpilot-verification-payload.json"), payload: request.payload });
      const envelope = setup.answer ? await setup.answer(request) : VERIFICATION_RECORDED;
      if (envelope.ok) {
        if (!options.directory.includes("verification_report.md")) {
          options.directory = [...options.directory, "verification_report.md"];
        }
        h.files["verification_report.md"] = ONE_PASSED_MD;
      }
      return envelope;
    };
  }
  const h = harness(options);
  return { h, calls, reviewCalls, options };
}

const RECORD_ACTIONS = ["recordReviewResult", "replaceReviewResult", "recordVerification", "editVerification"] as const;

function offersNoRecording(state: PanelState): boolean {
  const row = fixResultOf(state);
  return row !== undefined && !RECORD_ACTIONS.some((action) => row.actions.includes(action));
}

test("with no fix report there is no Verification Evidence, nothing to record, and the host refuses", async () => {
  const { h, calls, options } = verifiable();
  options.directory = PREPARED_FILES;
  await opened(h);
  assert.equal(fixResultOf(h.last()), undefined);

  await h.controller.handle({ type: "recordVerification", checks: [...CHECKS], replace: false });
  await h.controller.handle({ type: "action", id: "editVerification" });
  await h.controller.handle({ type: "action", id: "openVerificationReport" });

  assert.deepEqual(calls, []);
  assert.deepEqual(h.opened, []);
  assert.ok(h.logged.some((line) => /Refusing to record verification evidence/.test(line)));
  assert.ok(h.logged.some((line) => /Refusing to edit verification evidence/.test(line)));
  assert.ok(h.logged.some((line) => /Refusing to open a verification report/.test(line)));
});

test("a fix report without evidence offers Add Verification Evidence, without needing a review", async () => {
  const { h } = verifiable();
  await opened(h);
  const row = fixResultOf(h.last())!;
  assert.equal(row.verificationResult, undefined);
  assert.equal(row.verificationCapture, undefined);
  assert.equal(row.reviewResult, undefined);
  assert.ok(row.actions.includes("recordVerification"));
  assert.equal(row.actions.includes("editVerification"), false);
  assert.equal(row.actions.includes("openVerificationReport"), false);
});

test("recorded evidence is counts, the scoped phrase and the checks by name, with Open and Edit", async () => {
  const { h } = verifiable({ evidence: true });
  await opened(h);
  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.verificationResult, {
    artifact: "verification_report.md",
    counts: "Recorded checks: 1 passed, 1 failed, 1 not run",
    overall: "Recorded checks include failures.",
    checks: [
      { name: "Unit tests", status: "Passed", type: "Automated" },
      { name: "Open the dialog", status: "Failed", type: "Manual" },
      { name: "Integration suite", status: "Not Run", type: "Automated" },
    ],
  });
  assert.deepEqual([...row.actions].slice(-2), ["openVerificationReport", "editVerification"]);
  // One Fix result row, saying what it said before; no workflow row, no badge.
  assert.equal(h.last().workflow.length, 7);
  assert.equal(row.status, "ready");
  assert.equal(row.statusText, "Report available");
  assert.doesNotMatch(JSON.stringify(h.last()), /[Vv]erified|Approved|Safe to merge|Fix verified/);
});

test("recording sends the checks through record-verification and shows the file it wrote, and nothing else", async () => {
  const { h, calls } = verifiable();
  await opened(h);
  const noticesBefore = h.notices.length;

  await h.controller.handle(parsePanelMessage({ type: "recordVerification", checks: [...CHECKS], replace: false })!);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, [
    "record-verification",
    "JR-12345",
    "--from-file",
    "/tmp/bugpilot-verification-payload.json",
    "--json",
  ]);
  assert.deepEqual(calls[0]!.payload, { checks: [...CHECKS] });
  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.verificationCapture, { state: "recorded", replaced: false });
  assert.equal(row.verificationResult?.counts, "Recorded checks: 1 passed");
  assert.equal(row.verificationResult?.overall, "All recorded checks passed.");
  // No notification, no file written by the extension, no run.
  assert.equal(h.notices.length, noticesBefore);
  assert.deepEqual(h.written, []);
  assert.equal(h.streamRuns.length, 0);
});

test("checks the CLI would refuse are refused locally, as the recording's failure, without a process", async () => {
  const { h, calls } = verifiable();
  await opened(h);

  await h.controller.recordVerification([], false);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, {
    state: "failed",
    message: "Verification evidence was not recorded: add at least one check.",
  });
  await h.controller.recordVerification([{ ...CHECKS[0], name: "   " }], false);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, {
    state: "failed",
    message: "Verification evidence was not recorded: check 1 needs a name.",
  });
  const many = Array.from({ length: 26 }, (_, index) => ({ ...CHECKS[0], name: `Check ${index}` }));
  await h.controller.recordVerification(many, false);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, {
    state: "failed",
    message: "Verification evidence was not recorded: at most 25 checks can be recorded.",
  });
  assert.deepEqual(calls, []);
});

test("a CLI failure is the recording's own and never reads as a check failing", async () => {
  const { h } = verifiable({
    answer: async () => ({ ok: false, command: "record-verification", error: { code: "INVALID_INPUT", message: "Check 1: invalid recorded status." } }),
  });
  await opened(h);
  await h.controller.recordVerification([...CHECKS], false);
  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.verificationCapture, {
    state: "failed",
    message: "Verification evidence was not recorded: Check 1: invalid recorded status.",
  });
  assert.equal(row.verificationResult, undefined);
  assert.equal(row.error, undefined, "the recording's failure became the row's card");
  assert.ok(row.actions.includes("recordVerification"));
});

test("evidence recorded elsewhere meanwhile is kept: the failure is said and the row offers Edit", async () => {
  const { h, options } = verifiable({
    answer: async () => {
      options.directory = [...options.directory, "verification_report.md"];
      h.files["verification_report.md"] = VERIFICATION_MD;
      return { ok: false, command: "record-verification", error: { code: "ARTIFACT_EXISTS", message: "kept" } };
    },
  });
  await opened(h);
  await h.controller.recordVerification([...CHECKS], false);
  const row = fixResultOf(h.last())!;
  assert.match(
    row.verificationCapture?.state === "failed" ? row.verificationCapture.message : "",
    /^Verification evidence was not recorded: verification evidence is already recorded .* kept\. Use Edit/,
  );
  assert.equal(row.verificationResult?.counts, "Recorded checks: 1 passed, 1 failed, 1 not run");
  assert.ok(row.actions.includes("editVerification"));
});

test("Edit sends the recorded checks once, and a save from Edit passes --replace", async () => {
  const { h, calls } = verifiable({ evidence: true });
  await opened(h);

  await h.controller.handle(parsePanelMessage({ type: "action", id: "editVerification" })!);
  const answered = h.states.at(-1)!;
  const edit = fixResultOf(answered)!.verificationEdit!;
  assert.equal(edit.structured, true);
  assert.deepEqual(edit.checks.map((check) => [check.name, check.status, check.type, check.evidence]), [
    ["Unit tests", "passed", "automated", "1111 passed"],
    ["Open the dialog", "failed", "manual", "Crashed on save."],
    ["Integration suite", "not_run", "automated", ""],
  ]);
  // One push carries it; the next does not.
  await h.controller.refreshArtifacts();
  assert.equal(fixResultOf(h.last())!.verificationEdit, undefined);
  // A second Edit is a new answer, and only the latest answer's save replaces.
  h.controller.editVerification();
  const latest = fixResultOf(h.states.at(-1)!)!.verificationEdit!;
  assert.ok(latest.token > edit.token);
  await h.controller.recordVerification(edit.checks, true, edit.token);
  assert.equal(calls.length, 0, "a save from an earlier Edit answer replaced the report");

  await h.controller.recordVerification(latest.checks, true, latest.token);
  assert.deepEqual(calls[0]!.args.slice(-2), ["--json", "--replace"]);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, { state: "recorded", replaced: true });
});

test("--replace only for an Edit of a listed report; Record never overwrites", async () => {
  const listed = verifiable({ evidence: true, answer: async () => ({ ok: false, command: "record-verification", error: { code: "ARTIFACT_EXISTS", message: "kept" } }) });
  await opened(listed.h);
  // A page claiming Record over a listed report: no --replace, the CLI keeps it.
  await listed.h.controller.recordVerification([...CHECKS], false);
  assert.equal(listed.calls[0]!.args.includes("--replace"), false);

  const absent = verifiable();
  await opened(absent.h);
  // A page claiming Edit with nothing listed: nothing to replace, so no --replace.
  await absent.h.controller.recordVerification([...CHECKS], true);
  assert.equal(absent.calls[0]!.args.includes("--replace"), false);
});

test("Edit of a report not in BugPilot's shape sends no guessed checks, and says saving replaces it", async () => {
  const { h } = verifiable({ evidence: "# Notes\n\n## Checks\n\n### Check 1: tests\nStatus: Passed\nsome prose\n" });
  await opened(h);
  assert.equal(fixResultOf(h.last())!.verificationResult?.counts, "Recorded checks: 1 passed");
  h.controller.editVerification();
  assert.deepEqual(fixResultOf(h.states.at(-1)!)!.verificationEdit?.checks, []);
  assert.equal(fixResultOf(h.states.at(-1)!)!.verificationEdit?.structured, false);
});

test("without a record-verification port the host says so, rather than writing the file itself", async () => {
  const { h } = verifiable({ port: false });
  await opened(h);
  await h.controller.recordVerification([...CHECKS], false);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, {
    state: "failed",
    message: "Verification evidence was not recorded: this host cannot run record-verification.",
  });
  assert.deepEqual(h.written, []);
});

test("Open Verification Report opens the canonical file of the work item on screen, and nothing else", async () => {
  const { h } = verifiable({ evidence: true });
  await opened(h);
  await h.controller.handle(parsePanelMessage({ type: "action", id: "openVerificationReport" })!);
  assert.deepEqual(h.opened.map((file) => file.split(/[\\/]/).slice(-3).join("/")), [".ai/JR-12345/verification_report.md"]);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: "not a list", replace: false }), undefined);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: [{ ...CHECKS[0], status: "verified" }], replace: false }), undefined);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: [{ ...CHECKS[0], status: "skipped" }], replace: false }), undefined);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: [...CHECKS] }), undefined);
});

test("no run of any kind starts while verification evidence is being recorded; the host refuses it", async () => {
  const hold = held();
  const { h, options } = verifiable({ answer: hold.answer, hold: true });
  let asked = 0;
  (options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = async () => {
    asked += 1;
    return true;
  };
  await opened(h);
  const recording = h.controller.recordVerification([...CHECKS], false);
  await tick();
  const progressBefore = JSON.stringify(h.last().progress);

  const attempts = [
    h.controller.run(jiraForm()),
    h.controller.run(jiraForm({ fresh: true })),
    h.controller.handle(parsePanelMessage({ type: "run", form: jiraForm({ fresh: true }) })!),
  ];
  await tick();

  assert.equal(h.streamRuns.length, 0, "a run started while a verification recording was in flight");
  await Promise.all(attempts);
  assert.equal(h.notices.filter((notice) => notice.message === VERIFY_RUN_REFUSED).length, 3);
  // Refused before any setup: a Fresh run does not even ask to delete the folder.
  assert.equal(asked, 0, "the Fresh confirmation was asked while a recording was in flight");
  assert.equal(JSON.stringify(h.last().progress), progressBefore);
  assert.deepEqual(fixResultOf(h.last())!.verificationCapture, { state: "recording" });
  assert.ok(offersNoRecording(h.last()));

  hold.resolve(VERIFICATION_RECORDED);
  await recording;
  const running = h.controller.run(jiraForm());
  await tick();
  assert.equal(h.streamRuns.length, 1);
  h.release();
  await running;
});

test("one artifact write at a time: neither recording starts while the other is in flight", async () => {
  const holdVerification = held();
  const first = verifiable({ answer: holdVerification.answer });
  await opened(first.h);
  const verifying = first.h.controller.recordVerification([...CHECKS], false);
  await tick();
  // Not awaited: one that did start would hold, and the test should fail, not hang.
  void first.h.controller.recordReview(REVIEW_ENTRY);
  void first.h.controller.recordVerification([...CHECKS], false);
  await tick();
  assert.deepEqual(first.reviewCalls, []);
  assert.equal(first.calls.length, 1, "a second verification recording started");
  holdVerification.resolve(VERIFICATION_RECORDED);
  await verifying;

  const holdReview = held();
  const second = verifiable({ reviewAnswer: holdReview.answer });
  await opened(second.h);
  const reviewing = second.h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  assert.ok(offersNoRecording(second.h.last()));
  await second.h.controller.recordVerification([...CHECKS], false);
  assert.deepEqual(second.calls, [], "verification was recorded over a review recording");
  holdReview.resolve(RECORDED);
  await reviewing;
  assert.ok(fixResultOf(second.h.last())!.actions.includes("recordVerification"));
});

test("Clean is refused while either recording is in flight, and asks nothing", async () => {
  for (const kind of ["review", "verification"] as const) {
    const hold = held();
    const made = verifiable(kind === "review" ? { reviewAnswer: hold.answer } : { answer: hold.answer });
    await opened(made.h);
    const recording =
      kind === "review"
        ? made.h.controller.recordReview(REVIEW_ENTRY)
        : made.h.controller.recordVerification([...CHECKS], false);
    await tick();
    let cleaned = 0;
    let asked = 0;
    (made.options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = async () => {
      asked += 1;
      return true;
    };

    assert.equal(await made.h.controller.clean("JR-12345", async () => void (cleaned += 1)), false);

    assert.equal(cleaned, 0, `Clean ran over a ${kind} recording`);
    assert.equal(asked, 0);
    assert.ok(made.h.notices.some((notice) => notice.kind === "warning" && notice.message === CLEAN_REFUSED));
    hold.resolve(kind === "review" ? RECORDED : VERIFICATION_RECORDED);
    await recording;
    // Ended: Clean goes ahead.
    assert.equal(await made.h.controller.clean("JR-12345", async () => void (cleaned += 1)), true);
    assert.equal(cleaned, 1);
  }
});

test("a recording pressed while Clean's confirmation is open keeps the clean from running", async () => {
  let answer!: (yes: boolean) => void;
  const hold = held();
  const made = verifiable({ answer: hold.answer });
  (made.options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = () =>
    new Promise<boolean>((resolve) => (answer = resolve));
  await opened(made.h);
  let cleaned = 0;
  const cleaning = made.h.controller.clean("JR-12345", async () => void (cleaned += 1));
  await tick();
  const recording = made.h.controller.recordVerification([...CHECKS], false);
  await tick();
  answer(true);

  assert.equal(await cleaning, false);
  assert.equal(cleaned, 0, "the clean ran over a recording started during its confirmation");
  assert.ok(made.h.notices.some((notice) => notice.message === CLEAN_REFUSED));
  hold.resolve(VERIFICATION_RECORDED);
  await recording;
});

test("while Clean runs, no recording and no run start; afterwards the folder is read again", async () => {
  const made = verifiable({ evidence: true, hold: true });
  await opened(made.h);
  let finish!: () => void;
  const cleaning = made.h.controller.clean(
    "JR-12345",
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          made.options.directory = [];
          resolve();
        };
      }),
  );
  await tick();
  assert.ok(offersNoRecording(made.h.last()));
  void made.h.controller.recordVerification([...CHECKS], false);
  void made.h.controller.recordReview(REVIEW_ENTRY);
  void made.h.controller.run(jiraForm());
  await tick();
  assert.deepEqual(made.calls, []);
  assert.deepEqual(made.reviewCalls, []);
  assert.equal(made.h.streamRuns.length, 0);
  assert.ok(made.h.notices.some((notice) => notice.message === "Wait for the clean to finish before starting a run."));

  finish();
  assert.equal(await cleaning, true);
  assert.equal(fixResultOf(made.h.last()), undefined, "the cleaned work item still shows its reports");
});

test("a declined Clean runs nothing and leaves everything as it was", async () => {
  const made = verifiable({ evidence: true, confirm: false });
  await opened(made.h);
  const before = JSON.stringify(fixResultOf(made.h.last()));
  let cleaned = 0;
  assert.equal(await made.h.controller.clean("JR-12345", async () => void (cleaned += 1)), false);
  assert.equal(cleaned, 0);
  assert.equal(JSON.stringify(fixResultOf(made.h.last())), before);
  assert.ok(fixResultOf(made.h.last())!.actions.includes("editVerification"));
});

test("a verification recording still running after another item opens keeps runs and Clean out, unreported", async () => {
  const hold = held();
  const made = verifiable({ answer: hold.answer, hold: true });
  await opened(made.h);
  const recording = made.h.controller.recordVerification([...CHECKS], false);
  await tick();
  made.options.directory = [...PREPARED_FILES, "fix_report.md"];
  await made.h.controller.showWorkItem("JR-77777");
  assert.equal(fixResultOf(made.h.last())?.verificationCapture, undefined, "A's recording shows on B");

  void made.h.controller.run(jiraForm({ issueKey: "JR-77777" }));
  await tick();
  assert.equal(made.h.streamRuns.length, 0);
  assert.equal(await made.h.controller.clean("JR-77777", async () => {}), false);

  hold.resolve(VERIFICATION_RECORDED);
  await recording;
  assert.equal(made.h.last().workItemId, "JR-77777");
  assert.equal(fixResultOf(made.h.last())?.verificationCapture, undefined);
  assert.equal(fixResultOf(made.h.last())?.actions.includes("recordVerification"), true);
  const running = made.h.controller.run(jiraForm({ issueKey: "JR-77777" }));
  await tick();
  assert.equal(made.h.streamRuns.length, 1);
  made.h.release();
  await running;
});

test("a verification recording pressed while a run is still being set up keeps that run from starting", async () => {
  let answer!: (yes: boolean) => void;
  const hold = held();
  const made = verifiable({ answer: hold.answer, hold: true });
  (made.options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = () =>
    new Promise<boolean>((resolve) => (answer = resolve));
  await opened(made.h);

  const run = made.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  const recording = made.h.controller.recordVerification([...CHECKS], false);
  await tick();
  answer(true);
  await run;

  assert.equal(made.h.streamRuns.length, 0, "the run started over a verification recording");
  assert.ok(made.h.notices.some((notice) => notice.message === VERIFY_RUN_REFUSED));
  hold.resolve(VERIFICATION_RECORDED);
  await recording;
});

test("a verification recording that failed leaves Run, Record and Clean available again", async () => {
  const made = verifiable({
    hold: true,
    answer: async () => ({ ok: false, command: "record-verification", error: { code: "INVALID_INPUT", message: "no" } }),
  });
  await opened(made.h);
  await made.h.controller.recordVerification([...CHECKS], false);
  assert.ok(fixResultOf(made.h.last())!.actions.includes("recordVerification"));
  assert.ok(fixResultOf(made.h.last())!.actions.includes("recordReviewResult"));
  const running = made.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  assert.equal(made.h.streamRuns.length, 1);
  made.h.release();
  await running;
});

test("while a run is in flight no verification recording starts, and Edit is not offered", async () => {
  const made = verifiable({ evidence: true, hold: true });
  await opened(made.h);
  const running = made.h.controller.run(jiraForm());
  await tick();
  assert.equal(made.h.last().progress.state, "running");
  assert.ok(offersNoRecording(made.h.last()));
  // The kept evidence stays on screen through the run, openable.
  assert.equal(fixResultOf(made.h.last())!.verificationResult?.counts, "Recorded checks: 1 passed, 1 failed, 1 not run");
  assert.ok(fixResultOf(made.h.last())!.actions.includes("openVerificationReport"));

  await made.h.controller.recordVerification([...CHECKS], false);
  made.h.controller.editVerification();
  assert.deepEqual(made.calls, []);
  assert.equal(fixResultOf(made.h.last())!.verificationEdit, undefined);
  made.h.release();
  await running;
});

test("a Fresh run drops the evidence from the screen with the rest of the attempt", async () => {
  const fresh = verifiable({ evidence: true, review: true, hold: true });
  await opened(fresh.h);
  const run = fresh.h.controller.run(jiraForm({ fresh: true }));
  await tick();
  assert.equal(fixResultOf(fresh.h.last()), undefined);
  fresh.h.release();
  await run;
});

test("reopening a work item discovers its evidence from the file alone; an unreadable one still opens", async () => {
  const { h, options } = verifiable();
  await opened(h);
  options.directory = [...options.directory, "verification_report.md"];
  h.files["verification_report.md"] = ONE_PASSED_MD;
  await h.controller.showWorkItem("JR-12345");
  assert.equal(fixResultOf(h.last())!.verificationResult?.counts, "Recorded checks: 1 passed");

  delete h.files["verification_report.md"];
  await h.controller.refreshArtifacts();
  const result = fixResultOf(h.last())!.verificationResult!;
  assert.equal(result.counts, "Recorded checks: preview unavailable");
  assert.equal(result.overall, undefined);
  assert.ok(fixResultOf(h.last())!.actions.includes("openVerificationReport"));
});

test("an Edit's save never replaces a report that changed since Edit was opened; it is kept and said", async () => {
  const { h, calls } = verifiable({ evidence: true });
  await opened(h);
  h.controller.editVerification();
  const edit = fixResultOf(h.states.at(-1)!)!.verificationEdit!;
  // Rewritten outside the panel — a terminal, an agent — without the listing changing.
  h.files["verification_report.md"] = ONE_PASSED_MD;

  await h.controller.handle(
    parsePanelMessage({ type: "recordVerification", checks: [...edit.checks], replace: true, basis: edit.token })!,
  );

  assert.deepEqual(calls, [], "the changed report was overwritten unseen");
  const row = fixResultOf(h.last())!;
  assert.match(
    row.verificationCapture?.state === "failed" ? row.verificationCapture.message : "",
    /^Verification evidence was not recorded: verification_report\.md changed since Edit was opened, and it was kept\./,
  );
  // Read again: the row now shows the report as it is, and offers Edit and Run.
  assert.equal(row.verificationResult?.counts, "Recorded checks: 1 passed");
  assert.ok(row.actions.includes("editVerification"));
  // An Edit save with no basis at all is refused the same way.
  h.controller.editVerification();
  await h.controller.recordVerification([...CHECKS], true);
  assert.deepEqual(calls, []);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: [...CHECKS], replace: true, basis: -1 }), undefined);
  assert.equal(parsePanelMessage({ type: "recordVerification", checks: [...CHECKS], replace: true, basis: "1" }), undefined);
});

test("Clean is refused while a run is in flight, and asks nothing", async () => {
  const made = verifiable({ hold: true });
  let asked = 0;
  (made.options as { confirmAnswer?: () => Promise<boolean> }).confirmAnswer = async () => {
    asked += 1;
    return true;
  };
  await opened(made.h);
  const running = made.h.controller.run(jiraForm());
  await tick();
  let cleaned = 0;
  assert.equal(await made.h.controller.clean("JR-12345", async () => void (cleaned += 1)), false);
  assert.equal(cleaned, 0);
  assert.equal(asked, 0);
  assert.ok(made.h.notices.some((notice) => /run is in progress/.test(notice.message)));
  made.h.release();
  await running;
});

test("Retry is refused while a clean is in flight, and asks the CLI nothing", async () => {
  // Release stabilization: in a real window Retry ran during a clean and wrote
  // user_feedback.md into the folder being deleted. Retry is an artifact write too.
  const h = harness({
    directory: [...PREPARED_FILES],
    files: { "run.json": PREPARED_RUN_JSON },
    json: { ok: true, command: "bug", warnings: [], retry: true, feedback_created: true },
  });
  await opened(h);
  let finish!: () => void;
  const cleaning = h.controller.clean("JR-12345", () => new Promise<void>((resolve) => (finish = resolve)));
  await tick();

  await h.controller.retry();

  assert.equal(h.jsonRuns.filter((run) => run.args.includes("--retry")).length, 0, "a retry ran during a clean");
  assert.ok(h.notices.some((notice) => notice.kind === "warning" && notice.message === "Wait for the clean to finish before retrying."));
  finish();
  assert.equal(await cleaning, true);
});

test("while a Retry is being prepared no clean, no recording and no run start", async () => {
  let answer!: (envelope: Envelope) => void;
  const h = harness({
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
    json: () => new Promise<Envelope>((resolve) => (answer = resolve)),
    hold: true,
    events: successfulRun.filter((event) => event.type !== "completed"),
  });
  await opened(h);
  const retrying = h.controller.retry();
  await tick();

  let cleaned = 0;
  assert.equal(await h.controller.clean("JR-12345", async () => void (cleaned += 1)), false);
  assert.ok(offersNoRecording(h.last()));
  void h.controller.run(jiraForm());
  await tick();
  assert.equal(cleaned, 0);
  assert.equal(h.streamRuns.length, 0, "a run started while a retry was being prepared");
  assert.ok(h.notices.some((notice) => notice.message === "Wait for the retry to finish before starting a run."));
  assert.ok(h.notices.some((notice) => notice.message === "Wait for the retry to finish before cleaning this work item."));

  answer({ ok: true, command: "bug", warnings: [], retry: true, feedback_created: true });
  await retrying;
  // Ended: Clean goes ahead again.
  assert.equal(await h.controller.clean("JR-12345", async () => void (cleaned += 1)), true);
  assert.equal(cleaned, 1);
});

// --- release stabilization: review findings ------------------------------------

test("a Retry whose credentials cannot be read releases the write guard", async () => {
  let broken = false;
  const h = harness({
    directory: [...PREPARED_FILES],
    files: { "run.json": PREPARED_RUN_JSON },
    credentialsThrow: () => (broken ? new Error("keyring unavailable") : undefined),
  });
  await opened(h);
  broken = true;
  await h.controller.retry().catch(() => {});
  broken = false;
  // Nothing is stuck: Clean goes ahead.
  let cleaned = 0;
  assert.equal(await h.controller.clean("JR-12345", async () => void (cleaned += 1)), true);
  assert.equal(cleaned, 1);
});

test("a run whose credentials cannot be read does not stay running", async () => {
  let broken = false;
  const h = harness({ events: successfulRun, credentialsThrow: () => (broken ? new Error("keyring unavailable") : undefined) });
  await h.controller.refreshEnvironment();
  broken = true;
  await h.controller.run(jiraForm()).catch(() => {});
  broken = false;
  assert.notEqual(h.last().progress.state, "running");
  await h.controller.showWorkItem("JR-12345");
  assert.equal(h.notices.some((notice) => /run is in progress/.test(notice.message)), false, "the panel still thinks a run is in flight");
});

test("reopening a work item never replaces a bug description being typed, nor its mode", async () => {
  const draft = "Saving a record with no id crashes in commit_transaction; a long description in progress.";
  const h = harness({
    fixModes: CATALOG,
    form: { ...DEFAULT_FORM, source: "manual", description: draft, fixModeId: "investigate-first" },
    files: { "run.json": statusWith("standard", "Standard Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-23456");
  assert.equal(h.last().form?.source, "manual");
  assert.equal(h.last().form?.description, draft);
  assert.equal(h.last().form?.fixModeId, "investigate-first");
  // A local item reopened over the draft leaves it too.
  await h.controller.showWorkItem("local_20260927101010");
  assert.equal(h.last().form?.description, draft);
  assert.equal(h.last().form?.fixModeId, "investigate-first");
});

test("reopening another Jira item clears Fresh, so its reports are not deleted by the next Run unasked", async () => {
  const h = harness({
    fixModes: CATALOG,
    form: jiraForm({ issueKey: "JR-12345", fresh: true }),
    files: { "run.json": statusWith("standard", "Standard Fix") },
    directory: ["task.md", "run.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-23456");
  assert.equal(h.last().form?.issueKey, "JR-23456");
  assert.equal(h.last().form?.fresh, false);
});

test("reopening another Jira item drops a hint suggestion made for the previous one", async () => {
  const h = hintHarness({ issueDetails: { title: "Empty volume crash", description: "No traces." } });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });
  assert.ok(h.last().hintImprovement?.suggestion, "no suggestion to begin with");
  await h.controller.showWorkItem("JR-23456");
  assert.equal(h.last().hintImprovement?.suggestion, undefined);
});

test("Clean says a retry is what it waits for, while one is being prepared", async () => {
  let answer!: (envelope: Envelope) => void;
  const h = harness({
    directory: [...PREPARED_FILES],
    files: { "run.json": PREPARED_RUN_JSON },
    json: () => new Promise<Envelope>((resolve) => (answer = resolve)),
  });
  await opened(h);
  const retrying = h.controller.retry();
  await tick();
  assert.equal(await h.controller.clean("JR-12345", async () => {}), false);
  assert.ok(h.notices.some((notice) => notice.message === "Wait for the retry to finish before cleaning this work item."));
  answer({ ok: true, command: "bug", warnings: [], retry: true, feedback_created: true });
  await retrying;
});

test("finding the repository re-reads the Artifacts and History trees", async () => {
  // Release stabilization, seen after a window reload: History drew before the
  // environment check found the repository, said "Open the repository you are
  // fixing bugs in." and nothing re-read it — reopening from History was
  // unavailable until a manual refresh.
  const h = harness();
  assert.equal(h.refreshes.count, 0);
  await h.controller.refreshEnvironment();
  assert.equal(h.refreshes.count, 1);
  // The same repository again: nothing new to read.
  await h.controller.refreshEnvironment();
  assert.equal(h.refreshes.count, 1);
});

// --- the primary action: Run → Fix with AI → Open AI Session ----------------
//
// The button at the top follows the work item, so a developer never has to know
// what Resume, Retry or Fresh mean to find the next step. These drive it the way
// the page does — `nextAction` and `startAttempt`, each carrying the form — and
// check what the host decided, did, and refused.

const TASK_HANDOFF = `claude ${JSON.stringify("Read .ai/JR-12345/task.md and complete the workflow.")}`;
const RETRY_HANDOFF = `claude ${JSON.stringify("Read .ai/JR-12345/agent_retry_prompt.md and continue the workflow.")}`;
const RETRY_BUILT: Envelope = { ok: true, command: "bug", warnings: [], retry: true, feedback_created: false };

const next = (action: "run" | "fixWithAI" | "openSession" | "rebuildContext" | "startNewAttempt", form: FormState = jiraForm()) =>
  ({ type: "nextAction", action, form }) as const;
const startAttempt = (feedback: string, form: FormState = jiraForm()) => ({ type: "startAttempt", feedback, form }) as const;
const retryRuns = (h: Harness) => h.jsonRuns.filter((run) => run.args.includes("--retry"));

/** Prepared through the primary action, as the page would press it. */
async function preparedHarness(options: HarnessOptions = {}) {
  const h = harness({ ...WITH_FILES, agentOnPath: true, ...options });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run"));
  return h;
}

/** Prepared, and the first attempt handed over. */
async function attemptedHarness(options: HarnessOptions = {}) {
  const h = await preparedHarness(options);
  await h.controller.handle(next("fixWithAI"));
  assert.equal(h.terminals.length, 1, "the first handoff did not start");
  return h;
}

test("next action 1: with nothing prepared, the one primary action is Run", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  const primary = h.last().primary;
  assert.equal(primary.action, "run");
  assert.equal(primary.label, "Run");
  assert.equal(primary.enabled, true);
  // No line under it: what Run does is its tooltip (§37.104, §37.105).
  assert.equal(primary.hint, "");
  assert.deepEqual(primary.more, [], "a menu was offered before anything was prepared");
});

test("next action 2: Build Context alone prepares, launches nothing, and the button becomes Fix with AI", async () => {
  const h = await preparedHarness();
  assert.equal(h.streamRuns.length, 1);
  assert.equal(h.terminals.length, 0, "Run with Fix with AI unticked launched an agent");
  const primary = h.last().primary;
  assert.equal(primary.action, "fixWithAI");
  assert.equal(primary.label, "Fix with AI");
  assert.equal(primary.enabled, true);
  assert.deepEqual(primary.more, ["rebuildContext"]);
  // No line under it either: the header already says Ready (§37.105).
  assert.equal(primary.hint, "");
  // The row is the status, and says the task is ready — not started.
  assert.equal(fixRow(h.last()).status, "ready");
  assert.deepEqual(fixRow(h.last()).actions, []);
});

test("next action 3: Fix with AI hands over the prepared task.md, and prepares nothing again", async () => {
  const h = await preparedHarness();
  const runs = h.streamRuns.length;
  const queries = h.jsonRuns.length;
  await h.controller.handle(next("fixWithAI"));

  assert.equal(h.streamRuns.length, runs, "Fix with AI prepared the context again");
  assert.equal(h.jsonRuns.length, queries, "Fix with AI asked bugpilot for anything");
  assert.deepEqual(h.written, [], "Fix with AI wrote a file");
  assert.deepEqual(h.terminals, [{ name: "Fix with AI · JR-12345", cwd: ROOT, commandLine: TASK_HANDOFF }]);
  // "Started", and nothing about what the agent did.
  assert.equal(fixRow(h.last()).statusText, "Started");
  assert.equal(fixRow(h.last()).detail, "Handed to Claude CLI in a terminal.");
});

test("next action 3: Fix with AI uses the agent the form has selected now", async () => {
  const custom = jiraForm({ agent: "custom", agentCommand: "my-agent --prompt {prompt}" });
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", custom));
  await h.controller.handle(next("fixWithAI", custom));
  assert.equal(h.terminals.length, 1);
  assert.equal(h.terminals[0]!.commandLine, `my-agent --prompt ${JSON.stringify("Read .ai/JR-12345/task.md and complete the workflow.")}`);
  // The agent is not a preparation input: choosing it did not make the context stale.
  assert.equal(h.streamRuns.length, 1);
});

test("next action 4: once the handoff starts, the button is Open AI Session, which goes back to that terminal", async () => {
  const h = await attemptedHarness();
  const primary = h.last().primary;
  assert.equal(primary.action, "openSession");
  assert.equal(primary.label, "Open AI Session");
  assert.equal(primary.hint, "AI session started");
  assert.deepEqual(primary.more, ["startNewAttempt", "rebuildContext"]);

  await h.controller.handle(next("openSession"));
  assert.deepEqual(h.revealed, ["Fix with AI · JR-12345"]);
  assert.equal(h.terminals.length, 1, "Open AI Session started a terminal");
  // Acknowledged under the button, not in a notification (§37.87).
  assert.equal(h.notices.some((notice) => /session/i.test(notice.message)), false, "a toast about a found session");
  assert.equal(h.last().sessionFeedback?.message, "AI session focused");
});

test("next action 4: a session whose terminal is gone is said plainly, and nothing is started in its place", async () => {
  const h = await attemptedHarness();
  h.openTerminals.length = 0;
  await h.controller.handle(next("openSession"));

  assert.deepEqual(h.revealed, []);
  assert.equal(h.terminals.length, 1, "a new session was started instead of saying the old one is gone");
  // Said under the button, neutrally (§37.87): not a toast, not a failure.
  const feedback = h.last().sessionFeedback!;
  assert.equal(feedback.kind, "unavailable");
  assert.match(feedback.message, /^AI session is no longer available — its terminal was closed\./);
  assert.match(feedback.message, /Start New Attempt/);
  assert.doesNotMatch(feedback.message, /restored|reopened|resumed|reconnected|failed/i);
  assert.equal(h.notices.length, 0);
});

test("next action 4: an earlier attempt's report makes it Open AI Session too, which never invents a session", async () => {
  // Reopened after a reload: an agent wrote fix_report.md, but this window never
  // saw a handoff. The next step is still that attempt, not a second Fix with AI.
  const h = harness({
    agentOnPath: true,
    directory: [...PREPARED_FILES, "fix_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  assert.equal(h.last().primary.action, "openSession");
  // The header says it, so nothing under the button does (§37.105).
  assert.equal(h.last().overall.text, "Fix report available");
  assert.equal(h.last().primary.hint, "");
  assert.equal(fixRow(h.last()).summary, "Fix report available");
  assert.notEqual(fixRow(h.last()).status, "success", "a start nobody saw was reported");

  await h.controller.handle(next("openSession"));
  assert.equal(h.terminals.length, 0);
  assert.equal(h.last().sessionFeedback?.kind, "unavailable");
  assert.match(h.last().sessionFeedback?.message ?? "", /^AI session is no longer available in this window\./);
});

test("next action 5: Start New Attempt is not offered, and refused, before the first attempt", async () => {
  const h = await preparedHarness();
  assert.equal(h.last().primary.more.includes("startNewAttempt"), false);

  await h.controller.handle(startAttempt("Try again."));
  assert.equal(h.terminals.length, 0, "a new attempt started before any attempt");
  assert.deepEqual(h.written, []);
  assert.equal(retryRuns(h).length, 0);
  const attempt = fixRow(h.last()).attempt;
  assert.equal(attempt?.state, "failed");
  assert.match(attempt?.state === "failed" ? attempt.message : "", /offered once an AI attempt exists/);

  // After the first handoff, it is.
  await h.controller.handle(next("fixWithAI"));
  assert.deepEqual(h.last().primary.more, ["startNewAttempt", "rebuildContext"]);
  assert.equal(fixRow(h.last()).attempt, undefined, "the refusal outlived the handoff");
});

test("next action 6: a new attempt with empty feedback writes nothing and hands over task.md again", async () => {
  const h = await attemptedHarness();
  await h.controller.handle(startAttempt("   \n  "));

  assert.deepEqual(h.written, [], "empty feedback wrote user_feedback.md");
  assert.equal(retryRuns(h).length, 0, "empty feedback ran bug --retry, which writes a template");
  assert.equal(h.terminals.length, 2);
  assert.deepEqual(h.terminals[1], { name: "Fix with AI · JR-12345 (2)", cwd: ROOT, commandLine: TASK_HANDOFF });
  assert.equal(fixRow(h.last()).detail, "New attempt handed to Claude CLI in a terminal.");
  assert.equal(fixRow(h.last()).attempt, undefined, "the form was not told the press was answered");
  assert.equal(h.last().primary.action, "openSession");

  // Open AI Session now goes to the new attempt's terminal, not the first one's.
  await h.controller.handle(next("openSession"));
  assert.deepEqual(h.revealed, ["Fix with AI · JR-12345 (2)"]);
});

test("next action 7: feedback goes into user_feedback.md, bug --retry builds the package, and that is handed over", async () => {
  const h = await attemptedHarness({ json: RETRY_BUILT });
  await h.controller.handle(startAttempt("  The previous fix changed the wrong class.\nKeep the public API.\n"));

  assert.deepEqual(h.written, [
    {
      path: nodePath.join(ROOT, ".ai", "JR-12345", "user_feedback.md"),
      contents: "# User Feedback: JR-12345\n\n## Required Next Attempt\n\nThe previous fix changed the wrong class.\nKeep the public API.\n",
    },
  ]);
  // The CLI's own retry path, the same invocation the palette's Retry uses —
  // `--json`, so it never launches an agent of its own.
  assert.deepEqual(retryRuns(h).map((run) => run.args), [["bug", "JR-12345", "--retry", "--prepare-only", "--json"]]);
  assert.equal(retryRuns(h)[0]!.options.env?.["JIRA_TOKEN"], TOKEN);
  assert.equal(h.terminals.length, 2);
  assert.deepEqual(h.terminals[1], { name: "Fix with AI · JR-12345 (2)", cwd: ROOT, commandLine: RETRY_HANDOFF });
  assert.equal(fixRow(h.last()).detail, "New attempt, with your feedback, handed to Claude CLI in a terminal.");
  // The context was not rebuilt for it.
  assert.equal(h.streamRuns.length, 1);
});

test("next action 7: a retry package that could not be built hands nothing over and says why on the form", async () => {
  const failed = await attemptedHarness({
    json: { ok: false, command: "bug", error: { code: "WORK_ITEM_NOT_FOUND", message: "No workflow package found for JR-12345." } },
  });
  await failed.controller.handle(startAttempt("Try the other overload."));
  assert.equal(failed.terminals.length, 1, "a package that was not built was handed over");
  const attempt = fixRow(failed.last()).attempt;
  assert.equal(attempt?.state, "failed");
  assert.match(attempt?.state === "failed" ? attempt.message : "", /^Not started: /);
  assert.equal(failed.last().primary.enabled, true, "the failure left the panel busy");

  // The CLI making its own template means it did not read what was written: nothing is handed over.
  const template = await attemptedHarness({ json: { ...RETRY_BUILT, feedback_created: true } });
  await template.controller.handle(startAttempt("Try the other overload."));
  assert.equal(template.terminals.length, 1);
  assert.match(JSON.stringify(fixRow(template.last()).attempt), /did not find the feedback just written/);
});

test("next action 7: while the feedback is being written, no run, clean or second attempt starts over it", async () => {
  let answer: (envelope: Envelope) => void = () => {};
  const h = await attemptedHarness({ json: () => new Promise<Envelope>((resolve) => { answer = resolve; }) });
  const attempt = h.controller.handle(startAttempt("Try the other overload."));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const primary = h.last().primary;
  assert.equal(primary.busy, true);
  assert.equal(primary.enabled, false);
  assert.equal(primary.label, "Running…");
  assert.equal(fixRow(h.last()).summary, "Starting a new attempt…");

  await h.controller.run(jiraForm());
  assert.equal(h.streamRuns.length, 1, "a run started while the new attempt was being prepared");
  assert.ok(h.notices.some((notice) => notice.message === "Wait for the new attempt to be prepared before starting a run."));
  assert.equal(await h.controller.clean("JR-12345", async () => { throw new Error("cleaned"); }), false);
  assert.ok(h.notices.some((notice) => notice.message === "Wait for the new attempt to be prepared before cleaning this work item."));
  await h.controller.handle(startAttempt("A second press."));
  assert.equal(h.written.length, 1, "a second attempt wrote over the first one's feedback");

  answer(RETRY_BUILT);
  await attempt;
  assert.equal(h.terminals.length, 2);
  assert.equal(h.last().primary.busy, false);
});

test("next action 8: a changed preparation input makes the context stale, and Rebuild Context the button", async () => {
  const h = await preparedHarness();
  for (const change of [
    { hint: "look at the controller" },
    { keywords: "VolumeDescriptor" },
    { focusFiles: "src/widgets/WidgetController.cpp" },
    { ignorePaths: "build/" },
    { maxFiles: "5" },
    { fixModeId: "conservative" },
    { attachments: ["/logs/crash.txt"] },
    { plan: { ...DEFAULT_FORM.plan, gitHistory: false } },
    { issueKey: "JR-99999" },
    { source: "manual" as const, issueKey: "", description: "The dialog crashes on save." },
  ]) {
    await h.controller.handle({ type: "formChanged", form: jiraForm(change) });
    const primary = h.last().primary;
    assert.equal(primary.action, "rebuildContext", `${JSON.stringify(change)} left the context current`);
    assert.equal(primary.label, "Rebuild Context");
    assert.equal(primary.hint, "Settings changed");
    assert.equal(h.last().overall.text, "Needs rebuild", "the header still says the context is ready");
    // Undone: current again, without a run.
    await h.controller.handle({ type: "formChanged", form: jiraForm() });
    assert.equal(h.last().primary.action, "fixWithAI", `undoing ${JSON.stringify(change)} did not make it current`);
  }
  // What happens after a run is not a preparation input.
  await h.controller.handle({ type: "formChanged", form: jiraForm({ agent: "claude-cli", fixWithAI: true, fresh: true, useIssueDetails: false }) });
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(h.streamRuns.length, 1);
});

test("next action 8: a stale context is never handed over — from the button, a stale label, or the palette", async () => {
  const h = await preparedHarness();
  const edited = jiraForm({ hint: "look at the controller" });
  // The page still showed Fix with AI: the edit had not reached the host yet.
  await h.controller.handle(next("fixWithAI", edited));
  assert.equal(h.terminals.length, 0, "a stale context was handed over");
  assert.equal(h.last().primary.action, "rebuildContext", "the button was not corrected");
  assert.match(h.notices.at(-1)!.message, /Nothing was started: the form changed before the panel caught up\. The button now reads “Rebuild Context”\./);
  // The command palette's Fix with AI goes through the same door.
  await h.controller.fixWithAI();
  assert.equal(h.terminals.length, 0);
  assert.match(h.notices.at(-1)!.message, /The form changed since this context was prepared, so nothing was handed over/);
  // Nor a new attempt, once an attempt exists.
  await h.controller.handle({ type: "formChanged", form: jiraForm() });
  await h.controller.handle(next("fixWithAI"));
  await h.controller.handle(startAttempt("", edited));
  assert.equal(h.terminals.length, 1, "a new attempt started on a stale context");
  assert.match(JSON.stringify(fixRow(h.last()).attempt), /Press Rebuild Context first/);
});

test("next action 9: Rebuild Context prepares again with --resume, never Fresh unasked, and hands nothing over", async () => {
  let asked = 0;
  const h = await attemptedHarness({ confirmAnswer: async () => { asked += 1; return true; } });
  const edited = jiraForm({ hint: "look at the controller", fixWithAI: true });
  await h.controller.handle({ type: "formChanged", form: edited });
  await h.controller.handle(next("rebuildContext", edited));

  assert.equal(h.streamRuns.length, 2);
  const args = h.streamRuns[1]!.args;
  assert.ok(args.includes("--resume"), "Rebuild Context did not keep the folder");
  assert.equal(args.includes("--fresh"), false, "Rebuild Context deleted the folder");
  assert.ok(args.includes("--hint=look at the controller"), "Rebuild Context used an older form");
  assert.equal(asked, 0, "a question was asked about a rebuild that deletes nothing");
  // The Fix with AI box is ticked, but this is a rebuild: the attempt that
  // exists is continued, or restarted on purpose — never a second agent unasked.
  assert.equal(h.terminals.length, 1, "Rebuild Context handed the context over");
  // Current again, and the attempt still exists.
  assert.equal(h.last().primary.action, "openSession");
  assert.deepEqual(h.last().primary.more, ["startNewAttempt", "rebuildContext"]);
});

test("next action 9: Rebuild Context with Delete previous artifacts ticked asks first, and a no is no run", async () => {
  let asked = 0;
  const h = await preparedHarness({ confirmAnswer: async () => { asked += 1; return false; } });
  const fresh = jiraForm({ hint: "look at the controller", fresh: true });
  await h.controller.handle({ type: "formChanged", form: fresh });
  // One line, and it is the warning: the header still says Needs rebuild (§37.105).
  assert.equal(h.last().primary.hint, "Asks before deleting artifacts");
  await h.controller.handle(next("rebuildContext", fresh));
  assert.equal(asked, 1, "a Fresh rebuild did not ask");
  assert.equal(h.streamRuns.length, 1, "a declined Fresh rebuild ran anyway");
});

test("next action 9: rebuilding a context nobody handed over leaves Fix with AI the next step", async () => {
  const h = await preparedHarness();
  await h.controller.handle(next("rebuildContext"));
  assert.equal(h.streamRuns.length, 2);
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(h.terminals.length, 0);
});

test("next action 10: while a run is in flight the button is Running…, disabled, and a second press starts nothing", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true, hold: true, events: successfulRun.filter((event) => event.type !== "completed") });
  await h.controller.refreshEnvironment();
  const running = h.controller.handle(next("run"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const primary = h.last().primary;
  assert.equal(primary.label, "Running…");
  assert.equal(primary.enabled, false);
  assert.equal(primary.busy, true);
  assert.deepEqual(primary.more, []);

  await h.controller.handle(next("run"));
  await h.controller.handle(next("rebuildContext"));
  assert.equal(h.streamRuns.length, 1, "a second run started over the first");
  assert.match(h.notices.at(-1)!.message, /A BugPilot run is in progress/);
  // Nor a handoff of the task.md the run is rewriting, however it is asked for.
  await h.controller.fixWithAI();
  assert.equal(h.terminals.length, 0, "a handoff started during a run");

  h.release();
  await running;
  assert.equal(h.last().primary.busy, false);
});

test("next action 10: while a handoff is being worked out, neither a second one nor a new attempt starts", async () => {
  let probe: (value: boolean) => void = () => {};
  const h = await preparedHarness({ agentProbe: () => new Promise<boolean>((resolve) => { probe = resolve; }) });
  const first = h.controller.handle(next("fixWithAI"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.last().primary.label, "Running…");
  assert.equal(h.last().primary.enabled, false);

  await h.controller.handle(next("fixWithAI"));
  await h.controller.handle(startAttempt(""));
  probe(true);
  await first;
  assert.equal(h.terminals.length, 1, "two presses started two agents");
});

test("next action 11: the feedback helpers are offered only by the artifacts that exist, and add text only when pressed", async () => {
  const both = harness({
    agentOnPath: true,
    directory: [...PREPARED_FILES, "fix_report.md", "review_report.md", "verification_report.md"],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("Fixed it.", "3 passed."),
      "review_report.md": REVIEW_REPORT_MD(),
      "verification_report.md": VERIFICATION_MD,
    },
  });
  await both.controller.refreshEnvironment();
  await both.controller.showWorkItem("JR-12345");
  assert.deepEqual(fixRow(both.last()).feedbackHelpers, ["useReviewFindings", "useVerificationEvidence"]);
  // Listing them puts nothing anywhere.
  assert.equal(fixRow(both.last()).attemptDraft, undefined);

  await both.controller.handle({ type: "action", id: "useReviewFindings" });
  const review = both.states.at(-1)!;
  assert.equal(fixRow(review).attemptDraft?.token, 1);
  assert.equal(
    fixRow(review).attemptDraft?.text,
    "From review_report.md (a recorded review):\n\nFindings:\n- One duplicate null check.\n\nRecommendations:\n- Remove the duplicate.",
  );
  await both.controller.handle({ type: "action", id: "useVerificationEvidence" });
  const evidence = fixRow(both.states.at(-1)!).attemptDraft;
  assert.equal(evidence?.token, 2);
  assert.match(evidence?.text ?? "", /- Open the dialog — recorded as Failed/);
  assert.match(evidence?.text ?? "", /- Integration suite — recorded as Not Run/);
  assert.doesNotMatch(evidence?.text ?? "", /Unit tests|verified|approved/i);
  // Sent once, and nothing written, recorded or handed over by pressing them.
  await both.controller.refreshArtifacts();
  assert.equal(fixRow(both.last()).attemptDraft, undefined, "a helper's text was sent twice");
  assert.deepEqual(both.written, []);
  assert.equal(both.terminals.length, 0);

  // Evidence where every check passed has nothing to add; no review, no review helper.
  const passed = harness({
    agentOnPath: true,
    directory: [...PREPARED_FILES, "fix_report.md", "verification_report.md"],
    files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed."), "verification_report.md": ONE_PASSED_MD },
  });
  await passed.controller.refreshEnvironment();
  await passed.controller.showWorkItem("JR-12345");
  assert.equal(fixRow(passed.last()).feedbackHelpers, undefined);
  await passed.controller.handle({ type: "action", id: "useVerificationEvidence" });
  await passed.controller.handle({ type: "action", id: "useReviewFindings" });
  assert.equal(passed.states.some((state) => fixRow(state).attemptDraft !== undefined), false, "a helper nobody was offered answered");
});

test("Start New Attempt on its own keeps Review with AI hidden; the new attempt's report brings it back", async () => {
  const store = new Map<string, string>();
  const h = await preparedHarness({
    directory: [...WITH_FILES.directory, "fix_report.md"],
    files: { ...WITH_FILES.files, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") },
    json: REVIEW_PACKAGE,
    runCaptured: async () => ({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false }),
    reviewedFixes: { get: (id) => store.get(id), set: (id, fix) => (fix === undefined ? store.delete(id) : store.set(id, fix)) },
  });
  assert.equal(offersReview(h.last()), true);
  await h.controller.handle(REVIEW);
  assert.equal(offersReview(h.last()), false);

  await h.controller.handle(startAttempt(""));
  assert.equal(h.terminals.length, 1, "the new attempt did not start");
  assert.equal(offersReview(h.last()), false, "a new session is not a new fix");
  // The session wrote nothing useful: the same report, read again.
  await h.controller.refreshArtifacts();
  assert.equal(offersReview(h.last()), false);
  // It wrote a new report: a new fix to review.
  h.files["fix_report.md"] = fixReportMd("Fixed it at the call site.", "6 passed.");
  await h.controller.refreshArtifacts();
  assert.equal(offersReview(h.last()), true);
});

test("next action 11: no helper before an attempt exists, whatever files are there", async () => {
  const h = harness({
    ...WITH_FILES,
    agentOnPath: true,
    directory: [...WITH_FILES.directory, "review_report.md"],
    files: { ...WITH_FILES.files, "review_report.md": REVIEW_REPORT_MD() },
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run"));
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(fixRow(h.last()).feedbackHelpers, undefined);
});

test("next action 12: a late form change carrying the prepared form, or whitespace, never turns the button back", async () => {
  const form = jiraForm({ hint: "look at the controller", keywords: "a, b" });
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", form));
  assert.equal(h.last().primary.action, "fixWithAI");

  // The debounce's echo of the form the run was pressed with, after the run.
  await h.controller.handle({ type: "formChanged", form });
  assert.equal(h.last().primary.action, "fixWithAI", "the run's own form made its context stale");
  await h.controller.handle({ type: "formChanged", form: { ...form, hint: "look at the controller  ", keywords: "a,\nb" } });
  assert.equal(h.last().primary.action, "fixWithAI", "whitespace made the context stale");
});

test("next action 12: re-preparing with a changed form never flickers Rebuild Context on the way", async () => {
  const h = await preparedHarness();
  const edited = jiraForm({ hint: "look at the controller" });
  await h.controller.handle({ type: "formChanged", form: edited });
  assert.equal(h.last().primary.action, "rebuildContext");

  const before = h.states.length;
  await h.controller.handle(next("rebuildContext", edited));
  const during = h.states.slice(before);
  const settled = during.findIndex((state) => !state.primary.busy);
  // From the moment it starts, the button is Running…, then the next step —
  // never Rebuild Context again for a push computed against the old baseline.
  assert.ok(settled > 0, "the rebuild never showed Running…");
  for (const state of during.slice(settled)) {
    assert.notEqual(state.primary.action, "rebuildContext", "a push after the rebuild compared against the old form");
  }
  assert.equal(h.last().primary.action, "fixWithAI");
});

test("the session belongs to its work item: another item and back keeps it, Clean drops it", async () => {
  const h = await attemptedHarness({
    directory: [...WITH_FILES.directory, "run.json"],
    files: { ...WITH_FILES.files, "run.json": PREPARED_RUN_JSON },
  });
  await h.controller.showWorkItem("JR-2");
  assert.equal(h.last().primary.action, "fixWithAI", "another work item inherited this one's session");
  await h.controller.showWorkItem("JR-12345");
  assert.equal(h.last().primary.action, "openSession", "coming back offered a second agent for the same package");

  assert.equal(await h.controller.clean("JR-12345", async () => {}), true);
  // The harness keeps its listing, so the package is still "there": what
  // changed is that the session to reopen is gone with what it was given.
  assert.equal(h.last().primary.action, "fixWithAI");
});

test("next action 10: a second press while a run is still being set up starts nothing, and a declined one frees the button", async () => {
  // Before the process starts there is the Fresh question: a press made while it
  // is open used to be a second run waiting behind the first.
  let asked = 0;
  let answer: (yes: boolean) => void = () => {};
  const h = await preparedHarness({ confirmAnswer: () => { asked += 1; return new Promise<boolean>((resolve) => { answer = resolve; }); } });
  const fresh = jiraForm({ hint: "look at the controller", fresh: true });
  await h.controller.handle({ type: "formChanged", form: fresh });
  const first = h.controller.handle(next("rebuildContext", fresh));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.controller.handle(next("rebuildContext", fresh));
  await h.controller.run(fresh);
  assert.equal(asked, 1, "a second press asked the Fresh question again");

  answer(false);
  await first;
  assert.equal(h.streamRuns.length, 1, "a declined or doubled rebuild ran");
  assert.equal(h.last().primary.busy, false, "the button stayed Running… after the question was declined");
  assert.equal(h.last().primary.action, "rebuildContext");
});

// --- Workflow Settings: Apply is the one door ----------------------------------

const applySettings = (form: FormState) => ({ type: "applySettings", form }) as const;

test("settings 9: an applied preparation input makes the context stale, and the rows' summaries follow", async () => {
  const h = await preparedHarness();
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(codeRow(h.last()).settingsSummary, undefined, "a row with default settings said something");

  await h.controller.handle(applySettings(jiraForm({ keywords: "VolumeDescriptor, outputType", focusFiles: "src/a.ts\nsrc/b.ts", maxFiles: "10" })));
  assert.equal(h.last().primary.action, "rebuildContext", "applied search settings left the context current");
  assert.equal(codeRow(h.last()).settingsSummary, "2 keywords · 2 focus paths · max 10 files");
  // Saved like any form change, so a reloaded window keeps it.
  assert.equal(h.saved.at(-1)?.keywords, "VolumeDescriptor, outputType");
  assert.equal(h.streamRuns.length, 1, "applying settings started a run");
  assert.equal(h.terminals.length, 0, "applying settings started an agent");
});

const gitRow = (state: PanelState) => stepOf(state, "gitHistory");

test("settings 9b: every applied Git History Setting makes the context stale, and none starts a run", async () => {
  for (const change of [
    { gitUseSharedKeywords: false },
    { gitUseSharedFocusFiles: false },
    { gitKeywords: "stackmerge" },
    { gitFiles: "src/legacy/" },
    { gitSearchMessages: false },
    { gitSearchFileHistory: false },
    { gitHistoryDepth: "broader" as const },
    { gitMaxCommits: "5" },
  ]) {
    const h = await preparedHarness();
    assert.equal(h.last().primary.action, "fixWithAI");
    assert.equal(gitRow(h.last()).settingsSummary, undefined, "a Git history row at its defaults said something");
    await h.controller.handle(applySettings(jiraForm(change)));
    assert.equal(h.last().primary.action, "rebuildContext", `${JSON.stringify(change)} left the context current`);
    assert.equal(h.last().primary.label, "Rebuild Context");
    assert.notEqual(gitRow(h.last()).settingsSummary, undefined, `${JSON.stringify(change)} has no summary`);
    // Saved like any form change, so a reloaded window keeps it.
    const key = Object.keys(change)[0] as keyof FormState;
    assert.deepEqual(h.saved.at(-1)?.[key], change[key as keyof typeof change]);
    // Applying is not rebuilding: nothing ran, nothing was handed over.
    assert.equal(h.streamRuns.length, 1, `${JSON.stringify(change)} started a run`);
    assert.equal(h.terminals.length, 0);
  }
});

test("settings 9c: changing the AI Agent beside Git History Settings still leaves the context current", async () => {
  const h = await preparedHarness();
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli", agentCommand: "" })));
  assert.equal(h.last().primary.action, "fixWithAI");
  // And a Git History change with it is still stale, on its own account.
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli", gitMaxCommits: "3" })));
  assert.equal(h.last().primary.action, "rebuildContext");
});

test("settings 9d: Rebuild Context runs with the applied Git History Settings, and Code search's inputs as they were", async () => {
  const h = await preparedHarness();
  const edited = jiraForm({
    keywords: "poststack",
    focusFiles: "src/Focus.cpp",
    gitKeywords: "stackmerge",
    gitFiles: "src/Legacy.cpp",
    gitUseSharedKeywords: false,
    gitHistoryDepth: "broader",
    gitMaxCommits: "5",
  });
  await h.controller.handle(applySettings(edited));
  await h.controller.handle(next("rebuildContext", edited));

  assert.equal(h.streamRuns.length, 2);
  const args = h.streamRuns[1]!.args;
  for (const expected of [
    "--git-keyword=stackmerge",
    "--git-file=src/Legacy.cpp",
    "--git-no-shared-keywords",
    "--git-history-depth=broader",
    "--git-max-commits=5",
    "--resume",
  ]) {
    assert.ok(args.includes(expected), `${expected} missing from the rebuild`);
  }
  // Code search gets its own keywords and focus files, and none of Git history's.
  assert.deepEqual(args.filter((arg) => arg.startsWith("--keywords=")), ["--keywords=poststack"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("--focus-file=")), ["--focus-file=src/Focus.cpp"]);
});

test("settings 9e: a shared Keyword change is stale whether or not Git history uses it", async () => {
  // One context-wide stale state: Code search reads the Keywords either way.
  const h = await preparedHarness();
  await h.controller.handle(applySettings(jiraForm({ gitUseSharedKeywords: false })));
  await h.controller.handle(next("rebuildContext", jiraForm({ gitUseSharedKeywords: false })));
  await h.controller.handle(applySettings(jiraForm({ gitUseSharedKeywords: false, keywords: "poststack" })));
  assert.equal(h.last().primary.action, "rebuildContext");
});

const similarRow = (state: PanelState) => stepOf(state, "similarFixes");

test("settings 9f: every applied Similar Fixes Setting makes the context stale, and none starts a run (§37.113)", async () => {
  for (const change of [{ similarUseSharedKeywords: false }, { similarKeywords: "legacyexporter" }, { similarMaxFixes: "2" }]) {
    const h = await preparedHarness();
    assert.equal(h.last().primary.action, "fixWithAI");
    assert.equal(similarRow(h.last()).settingsSummary, undefined, "a Similar fixes row at its defaults said something");
    await h.controller.handle(applySettings(jiraForm(change)));
    assert.equal(h.last().primary.action, "rebuildContext", `${JSON.stringify(change)} left the context current`);
    assert.notEqual(similarRow(h.last()).settingsSummary, undefined, `${JSON.stringify(change)} has no summary`);
    const key = Object.keys(change)[0] as keyof FormState;
    assert.deepEqual(h.saved.at(-1)?.[key], change[key as keyof typeof change]);
    assert.equal(h.streamRuns.length, 1, `${JSON.stringify(change)} started a run`);
    assert.equal(h.terminals.length, 0);
  }
});

test("settings 9g: Rebuild Context runs with the applied Similar Fixes Settings; the shared inputs go out once, as before", async () => {
  const h = await preparedHarness();
  const edited = jiraForm({
    keywords: "poststack",
    focusFiles: "src/Focus.cpp",
    similarUseSharedKeywords: false,
    similarKeywords: "legacyexporter, export crash",
    similarMaxFixes: "2",
  });
  await h.controller.handle(applySettings(edited));
  await h.controller.handle(next("rebuildContext", edited));

  assert.equal(h.streamRuns.length, 2);
  const args = h.streamRuns[1]!.args;
  for (const expected of [
    "--similar-fixes-keyword=legacyexporter",
    "--similar-fixes-keyword=export crash",
    "--similar-fixes-no-shared-keywords",
    "--max-similar-fixes=2",
    "--resume",
  ]) {
    assert.ok(args.includes(expected), `${expected} missing from the rebuild`);
  }
  // Off for Similar fixes is not off for everybody: the shared Keywords and
  // Focus files still go out, once, for Code search and Git history.
  assert.deepEqual(args.filter((arg) => arg.startsWith("--keywords=")), ["--keywords=poststack"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("--focus-file=")), ["--focus-file=src/Focus.cpp"]);
  assert.equal(args.some((arg) => arg.startsWith("--git-keyword=") || arg.startsWith("--git-no-shared")), false);
});

test("settings 9h: an unticked Similar fixes skips the step and keeps its settings for the next run", async () => {
  const h = await preparedHarness();
  const off = jiraForm({ similarKeywords: "legacyexporter", similarMaxFixes: "3", plan: { ...DEFAULT_FORM.plan, similarFixes: false } });
  await h.controller.handle(applySettings(off));
  await h.controller.handle(next("rebuildContext", off));
  const skipped = h.streamRuns[1]!.args;
  assert.ok(skipped.includes("--skip-similar-fixes"));
  // Kept, and said: unticking the box is not clearing the settings.
  assert.equal(h.saved.at(-1)?.similarKeywords, "legacyexporter");
  assert.equal(h.saved.at(-1)?.similarMaxFixes, "3");
  // Ticked again, the next run searches with them.
  const on = jiraForm({ similarKeywords: "legacyexporter", similarMaxFixes: "3" });
  await h.controller.handle(applySettings(on));
  await h.controller.handle(next("rebuildContext", on));
  const back = h.streamRuns[2]!.args;
  assert.equal(back.includes("--skip-similar-fixes"), false);
  assert.ok(back.includes("--similar-fixes-keyword=legacyexporter"));
  assert.ok(back.includes("--max-similar-fixes=3"));
});

test("settings 9i: an invalid Max similar fixes blocks the run and names the field", async () => {
  const h = await preparedHarness();
  await h.controller.handle(next("rebuildContext", jiraForm({ similarMaxFixes: "21" })));
  assert.equal(h.streamRuns.length, 1, "a run started with an invalid count");
  assert.deepEqual(
    h.last().problems.map((problem) => problem.field),
    ["similarMaxFixes"],
  );
  assert.match(h.last().problems[0]!.message, /whole number from 1 to 20/);
});

test("settings 10: an applied agent, Fresh or hint-reading choice leaves the context current", async () => {
  const h = await preparedHarness();
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli", fresh: true, useIssueDetails: false })));
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(fixRow(h.last()).settingsSummary, "Claude CLI");
  assert.equal(buildRow(h.last()).settingsSummary, "Deletes previous artifacts first");
  // But a Fix Mode or a hint does make it stale, as the page says.
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli", hint: "look at the controller" })));
  assert.equal(h.last().primary.action, "rebuildContext");
  // The summary is the agent's alone: the hint is on the main page, in view.
  assert.equal(fixRow(h.last()).settingsSummary, "Claude CLI");
});

test("Fix Mode and Hint on the main page: an edit is a form change, and makes the context stale exactly as before", async () => {
  for (const change of [{ fixModeId: "investigate-first" }, { hint: "look at the controller" }]) {
    const h = await preparedHarness();
    assert.equal(h.last().primary.action, "fixWithAI");
    await h.controller.handle({ type: "formChanged", form: jiraForm(change) });
    assert.equal(h.last().primary.action, "rebuildContext", JSON.stringify(change));
    // Nothing ran, and nothing was handed over.
    assert.equal(h.streamRuns.length, 1, "a form change started a run");
    assert.equal(h.terminals.length, 0);
    // And back: the same form as prepared is current again.
    await h.controller.handle({ type: "formChanged", form: jiraForm() });
    assert.equal(h.last().primary.action, "fixWithAI");
  }
  // What the hint improver may read is not a preparation input.
  const h = await preparedHarness();
  await h.controller.handle({ type: "formChanged", form: jiraForm({ useIssueDetails: false }) });
  assert.equal(h.last().primary.action, "fixWithAI");
});

test("settings 14: no summary carries a value the developer typed, a path or a command", async () => {
  const secret = "C:/Users/user/secret/project";
  const h = await preparedHarness();
  await h.controller.handle(
    applySettings(
      jiraForm({
        keywords: "PrivateToken",
        focusFiles: `${secret}/a.ts`,
        ignorePaths: `${secret}/build`,
        hint: "the password is hunter2",
        agent: "custom",
        agentCommand: `${secret}/agent --token abc {prompt}`,
        attachments: [`${secret}/crash.log`],
        title: "Secret title",
      }),
    ),
  );
  const summaries = h.last().workflow.flatMap((step) => (step.settingsSummary ? [step.settingsSummary] : [])).join(" | ");
  assert.equal(summaries, "1 attachment | 1 keyword · 1 focus path · 1 ignored path | Custom agent command");
  for (const leak of ["PrivateToken", "secret", "hunter2", "abc", "Secret title", "crash.log", "someone"]) {
    assert.equal(summaries.includes(leak), false, `a summary carries "${leak}"`);
  }
});

test("settings 18: Apply is refused while anything is in flight, and the page is given the host's form back", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true, hold: true, events: successfulRun.filter((event) => event.type !== "completed") });
  await h.controller.refreshEnvironment();
  const running = h.controller.handle({ type: "nextAction", action: "run", form: jiraForm() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const revision = h.last().revision;

  await h.controller.handle(applySettings(jiraForm({ keywords: "mid-run" })));
  assert.equal(h.last().form?.keywords, "", "the host took settings over a run in flight");
  assert.ok(h.last().revision > revision, "the page was left showing settings the host does not hold");
  assert.match(h.notices.at(-1)!.message, /^Advanced Settings were not applied\. A BugPilot run is in progress/);
  h.release();
  await running;
});

test("settings: the attachment dialog answers the settings page's draft, never the host's form", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true, pickFiles: ["/logs/b.log", "/logs/a.log"] });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "ready" });
  const revision = h.last().revision;
  await h.controller.handle({ type: "pickAttachments", attachments: ["/logs/a.log"] });
  // Merged onto what the page showed, de-duplicated, sent once.
  assert.deepEqual(h.last().attachmentPick, { token: 1, attachments: ["/logs/a.log", "/logs/b.log"] });
  assert.deepEqual(h.last().form?.attachments ?? [], [], "the pick went into the host's form");
  assert.equal(h.last().revision, revision, "the page's draft was overwritten");
  await h.controller.refreshEnvironment();
  assert.equal(h.last().attachmentPick, undefined, "the answer was sent twice");

  // Capped at the CLI's ceiling, and said.
  const many = harness({ agentOnPath: true, pickFiles: Array.from({ length: 12 }, (_, index) => `/logs/${index}.log`) });
  await many.controller.refreshEnvironment();
  await many.controller.handle({ type: "pickAttachments", attachments: [] });
  assert.equal(many.last().attachmentPick?.attachments.length, 10);
  assert.match(many.notices.at(-1)!.message, /at most 10 files/);
  // A cancelled dialog says nothing at all.
  const cancelled = harness({ agentOnPath: true, pickFiles: [] });
  await cancelled.controller.refreshEnvironment();
  const pushes = cancelled.states.length;
  await cancelled.controller.handle({ type: "pickAttachments", attachments: ["/logs/a.log"] });
  assert.equal(cancelled.states.length, pushes);
});

test("settings: improving the draft's hint reads it, and never takes it as the host's form", async () => {
  const h = await preparedHarness();
  await h.controller.handle({ type: "improveHint", form: jiraForm({ hint: "look at the controller" }) });
  assert.equal(h.last().primary.action, "fixWithAI", "a draft hint made the context stale before Apply");
  assert.equal(h.hintPrompts.length, 1);
  assert.match(h.hintPrompts[0]!, /look at the controller/);
});

test("settings 19: the next-action states are unchanged by applying settings that do not touch them", async () => {
  const h = await preparedHarness();
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli" })));
  await h.controller.handle({ type: "nextAction", action: "fixWithAI", form: jiraForm({ agent: "claude-cli" }) });
  assert.equal(h.terminals.length, 1);
  assert.equal(h.last().primary.action, "openSession");
  await h.controller.handle(applySettings(jiraForm({ agent: "claude-cli", maxFiles: "5" })));
  assert.equal(h.last().primary.action, "rebuildContext");
  assert.deepEqual(h.last().primary.more, ["openSession"]);
  await h.controller.handle({ type: "nextAction", action: "rebuildContext", form: jiraForm({ agent: "claude-cli", maxFiles: "5" }) });
  assert.ok(h.streamRuns[1]!.args.includes("--max-files=5"), "Rebuild Context did not use the applied settings");
  assert.equal(h.last().primary.action, "openSession");
  assert.deepEqual(h.last().primary.more, ["startNewAttempt", "rebuildContext"]);
});

// --- Automatic artifact refresh (§37.81): the folder is the truth ------------

interface FakeWatcher {
  readonly directory: string;
  readonly fire: (name: string) => void;
  disposed: boolean;
}

/**
 * A work item with a watcher and a hand-run timer: `fire` is what the host's
 * file watcher would call, `flush` runs whatever the debounce scheduled.
 */
function refreshing(extra: HarnessOptions = {}) {
  const watchers: FakeWatcher[] = [];
  const timers: { callback: () => void; delay: number; cancelled: boolean; ran: boolean }[] = [];
  const store = new Map<string, string>();
  const options = reviewOptions({
    watchArtifacts: (directory, onEvent) => {
      const watcher: FakeWatcher = { directory, fire: onEvent, disposed: false };
      watchers.push(watcher);
      return { dispose: () => { watcher.disposed = true; } };
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, ran: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    reviewedFixes: { get: (id) => store.get(id), set: (id, fix) => (fix === undefined ? store.delete(id) : store.set(id, fix)) },
    ...extra,
  });
  const pending = () => timers.filter((timer) => !timer.cancelled && !timer.ran);
  const flush = async () => {
    for (let round = 0; round < 10; round += 1) {
      const next = pending()[0];
      if (next === undefined) return;
      next.ran = true;
      next.callback();
      for (let i = 0; i < 6; i += 1) await tick();
    }
  };
  const live = () => watchers.filter((watcher) => !watcher.disposed);
  return { options, watchers, timers, pending, flush, live, store };
}

const fixEntry = (h: Harness) => {
  const list = h.controller.artifacts;
  if (list.kind !== "ready") return undefined;
  return list.entries.find((entry) => entry.name === "fix_report.md");
};

test("refresh 1–2: a fix_report.md written by another process shows up, with Review with AI, without a reload", async () => {
  const r = refreshing({ directory: PREPARED_FILES });
  const h = await openedForReview(r.options);
  assert.equal(fixResultOf(h.last()), undefined);
  assert.equal(fixEntry(h)?.written, false, "fix_report.md was not listed as not written yet");
  assert.equal(r.live().length, 1);
  assert.equal(r.live()[0]!.directory, nodePath.join(ROOT, ".ai", "JR-12345"));
  const refreshesBefore = h.refreshes.count;

  // The agent writes it; the watcher says so.
  r.options.directory = [...PREPARED_FILES, "fix_report.md"];
  r.live()[0]!.fire("fix_report.md");
  assert.equal(r.pending().length, 1);
  assert.equal(r.pending()[0]!.delay, ARTIFACT_REFRESH_DEBOUNCE_MS);
  await r.flush();

  assert.equal(fixEntry(h)?.written, true, "fix_report.md still read as not written");
  assert.ok(fixResultOf(h.last()));
  assert.equal(offersReview(h.last()), true);
  assert.ok(h.refreshes.count > refreshesBefore, "the Artifacts and History trees were not told");
  assert.deepEqual(h.written, [], "a refresh wrote something");
});

test("refresh 3–4: a changed report is a new fix; the same report written again is not", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  await h.controller.handle(REVIEW);
  assert.equal(offersReview(h.last()), false);

  // Byte-identical content, and CRLF line endings: the same fix.
  h.files["fix_report.md"] = fixReportMd("Fixed it.", "3 passed.").replace(/\n/g, "\r\n");
  r.live()[0]!.fire("fix_report.md");
  await r.flush();
  assert.equal(offersReview(h.last()), false, "rewriting the same report counted as a new fix");

  // Different content: a new fix to review.
  h.files["fix_report.md"] = fixReportMd("Fixed it in the caller.", "4 passed.");
  r.live()[0]!.fire("fix_report.md");
  await r.flush();
  assert.equal(offersReview(h.last()), true);
});

test("refresh 5: a deleted fix_report.md is gone from the row and the tree, and so is Review with AI", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  assert.equal(offersReview(h.last()), true);
  r.options.directory = PREPARED_FILES;
  r.live()[0]!.fire("fix_report.md");
  await r.flush();
  assert.equal(fixResultOf(h.last()), undefined);
  assert.equal(fixEntry(h)?.written, false);
});

test("refresh 6–7: a review or verification report written outside the panel shows up", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  h.files["review_report.md"] = REVIEW_REPORT_MD("Recorded in a terminal.");
  h.files["verification_report.md"] = VERIFICATION_MD;
  r.options.directory = [...PREPARED_FILES, "fix_report.md", "review_report.md", "verification_report.md"];
  r.live()[0]!.fire("review_report.md");
  r.live()[0]!.fire("verification_report.md");
  await r.flush();
  const row = fixResultOf(h.last())!;
  assert.equal(row.reviewResult?.summary, "Recorded in a terminal.");
  assert.ok(row.verificationResult);
});

test("refresh 8–9: switching work items replaces the watcher, and the old one's events touch nothing", async () => {
  const r = refreshing(twoReports(REVIEW_PACKAGE));
  const h = await openedForReview(r.options, "JR-1");
  const first = r.live()[0]!;
  assert.match(first.directory, /JR-1$/);

  await h.controller.showWorkItem("JR-2");
  assert.equal(first.disposed, true, "JR-1's watcher outlived the switch");
  assert.equal(r.live().length, 1);
  assert.match(r.live()[0]!.directory, /JR-2$/);

  const statesBefore = h.states.length;
  first.fire("fix_report.md");
  assert.equal(r.pending().length, 0, "an event for JR-1 scheduled a refresh of JR-2");
  assert.equal(h.states.length, statesBefore);
});

test("refresh 10: a burst of events is one refresh", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  let listings = 0;
  const readsBefore = h.states.length;
  for (let i = 0; i < 12; i += 1) r.live()[0]!.fire(i % 2 === 0 ? "fix_report.md" : "run.json");
  assert.equal(r.pending().length, 1, "events were not coalesced");
  const wrapped = h.controller as unknown as { refreshActiveWorkItem: (o?: object) => Promise<boolean> };
  const original = wrapped.refreshActiveWorkItem.bind(h.controller);
  wrapped.refreshActiveWorkItem = async (o) => {
    listings += 1;
    return original(o);
  };
  await r.flush();
  assert.equal(listings, 1);
  assert.ok(h.states.length > readsBefore);
});

test("refresh: repeated page loads never stack watchers, and each load asks for one read", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  for (let i = 0; i < 5; i += 1) await h.controller.handle({ type: "ready" });
  assert.equal(r.watchers.length, 1, "a watcher was created per page load");
  assert.equal(r.pending().length, 1, "page loads were not coalesced into one refresh");
});

test("refresh: the panel shown again re-reads the folder — the safety net for a missed event", async () => {
  const r = refreshing({ directory: PREPARED_FILES });
  const h = await openedForReview(r.options);
  r.options.directory = [...PREPARED_FILES, "fix_report.md"];
  // No watcher event at all: the page reloading is the only signal.
  await h.controller.handle({ type: "ready" });
  await r.flush();
  assert.ok(fixResultOf(h.last()));
  assert.equal(offersReview(h.last()), true);
});

test("refresh: the manual Refresh reads the same way, now", async () => {
  const r = refreshing({ directory: PREPARED_FILES });
  const h = await openedForReview(r.options);
  r.options.directory = [...PREPARED_FILES, "fix_report.md"];
  const refreshesBefore = h.refreshes.count;
  await h.controller.refreshActiveWorkItem();
  assert.ok(fixResultOf(h.last()));
  assert.equal(offersReview(h.last()), true);
  assert.equal(h.refreshes.count, refreshesBefore + 1);
  assert.equal(r.pending().length, 0, "the manual refresh went through the timer");
});

test("refresh: an event during an operation waits for it, then reads once — never under it", async () => {
  let finish: (run: CapturedRun) => void = () => {};
  const r = refreshing({
    runCaptured: () => new Promise<CapturedRun>((resolve) => (finish = resolve)),
  });
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  assert.equal(reviewOf(h.last())?.state, "reviewing");

  r.options.directory = [...PREPARED_FILES, "fix_report.md", "review_report.md"];
  h.files["review_report.md"] = REVIEW_REPORT_MD("Written meanwhile.");
  r.live()[0]!.fire("review_report.md");
  await r.flush();
  assert.equal(fixResultOf(h.last())!.reviewResult, undefined, "the folder was read under the reviewer");
  assert.equal(reviewOf(h.last())?.state, "reviewing", "the refresh disturbed the reviewer");

  finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await reviewing;
  assert.equal(r.pending().length, 1, "the deferred refresh was dropped");
  await r.flush();
  const row = fixResultOf(h.last())!;
  assert.equal(row.reviewResult?.summary, "Written meanwhile.");
  // And the captured draft is still the draft.
  assert.ok(row.reviewPrefill && "entry" in row.reviewPrefill, "a refresh wiped the unsaved review draft");
});

test("refresh: an unrelated artifact event keeps the unsaved review draft and the reviewed fix", async () => {
  const r = refreshing({ runCaptured: async () => ({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false }) });
  const h = await openedForReview(r.options);
  await h.controller.handle(REVIEW);
  const draft = fixResultOf(h.last())!.reviewPrefill;
  assert.ok(draft && "entry" in draft);

  h.files["verification_report.md"] = VERIFICATION_MD;
  r.options.directory = [...PREPARED_FILES, "fix_report.md", "verification_report.md"];
  r.live()[0]!.fire("verification_report.md");
  r.live()[0]!.fire("run.json");
  await r.flush();

  const row = fixResultOf(h.last())!;
  assert.deepEqual(row.reviewPrefill, draft, "the draft changed on a refresh");
  assert.ok(row.verificationResult);
  assert.equal(offersReview(h.last()), false);
  assert.equal(reviewOf(h.last())?.state, "captured");
});

test("refresh: a failed capture, or a saved review, on the same fix stays hidden through a refresh", async () => {
  const failed = refreshing({ runCaptured: async () => ({ code: 0, stdout: "", stderr: "", aborted: false }) });
  const a = await openedForReview(failed.options);
  await a.controller.handle(REVIEW);
  assert.equal(reviewOf(a.last())?.state, "captureFailed");
  failed.live()[0]!.fire("fix_report.md");
  await failed.flush();
  assert.equal(offersReview(a.last()), false);
  assert.equal(reviewOf(a.last())?.state, "captureFailed", "the refresh dropped what the attempt said");

  const saved = refreshing({ runCaptured: async () => ({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false }) });
  saved.options.runReview = async () => RECORDED;
  const b = await openedForReview(saved.options);
  await b.controller.handle(REVIEW);
  b.files["review_report.md"] = REVIEW_REPORT_MD("Saved.");
  saved.options.directory = [...PREPARED_FILES, "fix_report.md", "review_report.md"];
  saved.live()[0]!.fire("review_report.md");
  await saved.flush();
  assert.equal(offersReview(b.last()), false);
});

test("refresh: a report caught mid-write keeps the last reading, is read once more, and is never a new fix", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  await h.controller.handle(REVIEW);
  assert.equal(offersReview(h.last()), false);

  // Listed, but the read fails: a writer holds it.
  const text = h.files["fix_report.md"]!;
  delete h.files["fix_report.md"];
  r.live()[0]!.fire("fix_report.md");
  const first = r.pending()[0]!;
  first.ran = true;
  first.callback();
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal(fixResultOf(h.last())?.summary, "Fixed it.", "the last reading was dropped");
  assert.equal(offersReview(h.last()), false, "a failed read counted as a new fix");
  assert.equal(r.pending().length, 1, "no second read was scheduled");
  assert.equal(r.pending()[0]!.delay, ARTIFACT_REFRESH_RETRY_MS);

  // The writer is done by the retry.
  h.files["fix_report.md"] = text;
  await r.flush();
  assert.equal(offersReview(h.last()), false);
  assert.equal(r.pending().length, 0, "it kept retrying");
});

test("refresh: an unreadable folder, known a moment ago, keeps what was shown for one retry", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  r.options.directoryError = "EBUSY: resource busy or locked";
  r.live()[0]!.fire("fix_report.md");
  const first = r.pending()[0]!;
  first.ran = true;
  first.callback();
  for (let i = 0; i < 6; i += 1) await tick();
  assert.ok(fixResultOf(h.last()), "a transient error wiped the row");
  assert.equal(h.controller.artifacts.kind, "ready");
  // Still unreadable on the retry: now it is said.
  await r.flush();
  assert.equal(h.controller.artifacts.kind, "error");
});

test("refresh: dispose stops the watcher and anything scheduled", async () => {
  const r = refreshing();
  const h = await openedForReview(r.options);
  const watcher = r.live()[0]!;
  watcher.fire("fix_report.md");
  const timer = r.pending()[0]!;
  h.controller.dispose();
  assert.equal(watcher.disposed, true);
  assert.equal(timer.cancelled, true);
  watcher.fire("fix_report.md");
  assert.equal(r.pending().length, 0);
});

test("refresh: after a run the watcher is rebuilt on the folder as it is now", async () => {
  const r = refreshing({ events: successfulRun });
  const h = await openedForReview(r.options);
  const before = r.live()[0]!;
  await h.controller.run(jiraForm({ fresh: true }));
  assert.equal(before.disposed, true, "a Fresh run kept watching a folder it deleted");
  assert.equal(r.live().length, 1);
  assert.equal(r.live()[0]!.directory, before.directory);
});

// --- Captured review progress and Cancel Review (§37.82) ---------------------

/**
 * A captured review held open like a real process: it reports its start when
 * `start` is called, answers `finish`, and ends on abort — with whatever it
 * had printed, as `Runner` does, marked aborted.
 */
function heldReview(extra: HarnessOptions = {}) {
  let resolveRun: (run: CapturedRun) => void = () => {};
  let request: Parameters<NonNullable<ControllerPorts["runCapturedReview"]>>[0] | undefined;
  const aborts: number[] = [];
  const store = new Map<string, string>();
  const options = reviewOptions({
    capturedStarts: false,
    runCaptured: (call) =>
      new Promise<CapturedRun>((resolve) => {
        request = call;
        resolveRun = resolve;
        call.signal?.addEventListener("abort", () => {
          aborts.push(1);
          resolve({ code: null, stdout: claudeJson(CAPTURED_REVIEW.slice(0, 40)), stderr: "", aborted: true });
        });
      }),
    reviewedFixes: { get: (id) => store.get(id), set: (id, fix) => (fix === undefined ? store.delete(id) : store.set(id, fix)) },
    now: () => 1_700_000_000_000,
    ...extra,
  });
  return {
    options,
    store,
    aborts,
    start: () => request?.onStarted?.(),
    finish: (run: CapturedRun) => resolveRun(run),
    request: () => request,
  };
}

test("progress 1–3: starting until the process has started, then reviewing with the agent and the start time", async () => {
  const r = heldReview();
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  // Launched, not yet started: starting, no mark, no clock, no Cancel.
  assert.equal(reviewOf(h.last())?.state, "starting");
  assert.equal(r.store.size, 0, "a process not yet started counted as an attempt");
  assert.equal(fixResultOf(h.last())!.actions.includes("cancelReview"), false);

  r.start();
  const view = reviewOf(h.last()) as { state: string; summary: string; detail: string; startedAt: number; details: Record<string, unknown> };
  assert.equal(view.state, "reviewing");
  assert.equal(view.summary, "Reviewing with Claude CLI…");
  assert.equal(view.detail, "BugPilot is running a read-only AI review in the background. This may take a minute.");
  assert.equal(view.startedAt, 1_700_000_000_000);
  assert.deepEqual(view.details, {
    agent: "Claude CLI",
    mode: "Read-only background review",
    status: "Running",
    outputFormat: ["Summary", "Findings", "Validation Notes", "Recommendations"],
  });
  assert.equal(r.store.size, 1);
  assert.equal(offersReview(h.last()), false);
  assert.ok(fixResultOf(h.last())!.actions.includes("cancelReview"));
  // The signal is the one Cancel Review aborts.
  assert.ok(r.request()?.signal instanceof AbortSignal);

  r.finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await reviewing;
  assert.equal(reviewOf(h.last())?.state, "captured");
  assert.equal(fixResultOf(h.last())!.actions.includes("cancelReview"), false);
});

test("cancel: the developer is asked with named buttons; Keep Reviewing leaves the process alone", async () => {
  const r = heldReview({ confirm: false });
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  r.start();

  await h.controller.handle({ type: "action", id: "cancelReview" });

  assert.deepEqual(h.confirms.at(-1), {
    message: "Cancel current AI review? The current review result will be discarded.",
    confirmLabel: "Cancel Review",
    keepLabel: "Keep Reviewing",
  });
  assert.deepEqual(r.aborts, [], "Keep Reviewing ended the process");
  assert.equal(reviewOf(h.last())?.state, "reviewing");
  r.finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await reviewing;
  assert.equal(reviewOf(h.last())?.state, "captured", "the review kept was not the one kept running");
});

test("cancel: confirmed, the process is ended once, its output discarded, nothing saved — and Review with AI is back", async () => {
  const r = heldReview();
  const saves: unknown[] = [];
  r.options.runReview = async (request) => {
    saves.push(request.payload);
    return RECORDED;
  };
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  r.start();
  assert.equal(r.store.size, 1);

  await h.controller.handle({ type: "action", id: "cancelReview" });
  await h.controller.handle({ type: "action", id: "cancelReview" });
  await reviewing;

  assert.equal(r.aborts.length, 1, "the process was not ended exactly once");
  assert.equal(h.confirms.length, 1, "a second press asked again after the cancel");
  const row = fixResultOf(h.last())!;
  const view = reviewOf(h.last()) as { state: string; summary: string };
  assert.equal(view.state, "cancelled");
  assert.equal(view.summary, "Review cancelled");
  assert.equal(row.reviewPrefill, undefined, "a draft from a cancelled review");
  assert.deepEqual(saves, []);
  assert.deepEqual(h.written, []);
  assert.equal(r.store.size, 0, "the cancelled attempt still marks the fix");
  assert.equal(offersReview(h.last()), true);
  assert.equal(row.actions.includes("pasteReviewOutput"), true);
  assert.ok(h.logged.some((line) => /cancelled by the developer/.test(line)));

  // And a new review of the same fix can start.
  const again = h.controller.handle(REVIEW);
  await tick();
  assert.equal(reviewOf(h.last())?.state, "starting");
  r.start();
  r.finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await again;
  assert.equal(reviewOf(h.last())?.state, "captured");
});

test("cancel: a review that finished while the question was open is kept as it finished", async () => {
  let answer: (yes: boolean) => void = () => {};
  const r = heldReview({ confirmAnswer: () => new Promise<boolean>((resolve) => (answer = resolve)) });
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  r.start();
  const asking = h.controller.handle({ type: "action", id: "cancelReview" });
  await tick();
  r.finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await reviewing;
  answer(true);
  await asking;
  assert.deepEqual(r.aborts, []);
  assert.equal(reviewOf(h.last())?.state, "captured");
  assert.ok(fixResultOf(h.last())!.reviewPrefill);
});

test("cancel: nothing to cancel — no question, nothing ended", async () => {
  const r = heldReview();
  const h = await openedForReview(r.options);
  await h.controller.handle({ type: "action", id: "cancelReview" });
  assert.deepEqual(h.confirms, []);
  assert.ok(h.logged.some((line) => /Refusing to cancel a review/.test(line)));
});

test("failure semantics: a launch that failed, a cancel, a process failure, a parse failure and a timeout stay apart", async () => {
  // A. The spawn itself failed: never started, offered again.
  const spawnFailed = heldReview({
    runCaptured: () => Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
  });
  const a = await openedForReview(spawnFailed.options);
  await a.controller.handle(REVIEW);
  assert.equal(reviewOf(a.last())?.state, "failed");
  assert.equal(offersReview(a.last()), true);
  assert.equal(spawnFailed.store.size, 0);

  // C, D, E. Started, then no usable result: hidden, the paste offered, each said as what it was.
  const cases: [string, CapturedRun, RegExp][] = [
    ["process", { code: 1, stdout: "", stderr: "boom", aborted: false }, /^AI review did not produce a usable structured result\.$/],
    ["parse", { code: 0, stdout: claudeJson("## Summary\nOnly one."), stderr: "", aborted: false }, /^Review result could not be captured automatically\.$/],
    ["timeout", { code: null, stdout: "", stderr: "", aborted: true }, /^AI review did not finish within the allowed time\.$/],
  ];
  for (const [kind, run, title] of cases) {
    const r = heldReview();
    const h = await openedForReview(r.options);
    const reviewing = h.controller.handle(REVIEW);
    await tick();
    r.start();
    r.finish(run);
    await reviewing;
    const view = reviewOf(h.last()) as { state: string; summary: string };
    assert.equal(view.state, "captureFailed", kind);
    assert.match(view.summary, title, kind);
    assert.equal(offersReview(h.last()), false, `${kind}: Review with AI came back`);
    assert.equal(r.store.size, 1, `${kind}: the attempt was forgotten`);
    assert.ok(fixResultOf(h.last())!.actions.includes("pasteReviewOutput"), kind);
    if (kind === "timeout") assert.ok(h.logged.some((line) => /timed out/.test(line)));
  }
});

test("progress diagnostics say what happened, and never the prompt or the reply", async () => {
  const r = heldReview();
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  r.start();
  r.finish({ code: 0, stdout: claudeJson(CAPTURED_REVIEW), stderr: "", aborted: false });
  await reviewing;
  const log = h.logged.join("\n");
  for (const said of [/starting with Claude CLI/, /process started/, /completed; its result parsed/]) assert.match(log, said);
  for (const secret of ["Final Review Request", "The change handles the null input", "## Summary"]) {
    assert.equal(log.includes(secret), false, secret);
  }
});

test("opening a work item tells the trees once its folder is read, so the Artifacts view never stays on Scanning", async () => {
  const h = harness({ directory: [...PREPARED_FILES, "fix_report.md"], files: { "run.json": PREPARED_RUN_JSON, "fix_report.md": fixReportMd("Fixed it.", "3 passed.") } });
  await h.controller.refreshEnvironment();
  const before = h.refreshes.count;
  await h.controller.showWorkItem("JR-12345");
  assert.ok(h.refreshes.count > before, "the trees were not told about the work item just opened");
  assert.equal(h.controller.artifacts.kind, "ready");
});

// --- Verification Evidence auto-save (§37.83) ---------------------------------

type Check = { name: string; status: "passed" | "failed" | "not_run"; type: "automated" | "manual" | "other"; procedure: string; evidence: string; notes: string };
const check = (name: string, extra: Partial<Check> = {}): Check => ({ name, status: "passed", type: "automated", procedure: "npm test", evidence: "", notes: "", ...extra });
const blank = (): Check => ({ name: "", status: "not_run", type: "automated", procedure: "", evidence: "", notes: "" });

/**
 * A report on screen, a hand-run timer, and a record-verification fake that
 * writes a new file each time — so the version the form last wrote is known,
 * and a test can change the file behind it.
 */
async function autosaving(setup: {
  evidence?: boolean;
  answer?: (request: PayloadCommandRequest) => Promise<Envelope>;
  confirm?: boolean;
  runReview?: (request: PayloadCommandRequest) => Promise<Envelope>;
} = {}) {
  const timers: { callback: () => void; delay: number; cancelled: boolean; ran: boolean }[] = [];
  const calls: { args: readonly string[]; payload: { checks: Check[] } }[] = [];
  const options = reviewOptions({
    directory: [...PREPARED_FILES, "fix_report.md", ...(setup.evidence ? ["verification_report.md"] : [])],
    files: {
      "run.json": PREPARED_RUN_JSON,
      "fix_report.md": fixReportMd("Fixed it.", "3 passed."),
      ...(setup.evidence ? { "verification_report.md": ONE_PASSED_MD } : {}),
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, ran: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    ...(setup.confirm === undefined ? {} : { confirm: setup.confirm }),
    ...(setup.runReview === undefined ? {} : { runReview: setup.runReview }),
  });
  let h: Harness;
  options.runVerification = async (request) => {
    calls.push({ args: request.args("/tmp/bugpilot-verification-payload.json"), payload: request.payload as { checks: Check[] } });
    const envelope = setup.answer ? await setup.answer(request) : VERIFICATION_RECORDED;
    if (envelope.ok) {
      if (!options.directory!.includes("verification_report.md")) options.directory = [...options.directory!, "verification_report.md"];
      h.files["verification_report.md"] = `# Verification Report: JR-12345\n\n<!-- write ${calls.length} -->\n${JSON.stringify(request.payload)}\n`;
    }
    return envelope;
  };
  h = await openedForReview(options);
  const pending = () => timers.filter((timer) => !timer.cancelled && !timer.ran);
  const flush = async () => {
    for (let round = 0; round < 10; round += 1) {
      const next = pending().find((timer) => timer.delay === VERIFICATION_AUTOSAVE_MS);
      if (next === undefined) return;
      next.ran = true;
      next.callback();
      for (let i = 0; i < 8; i += 1) await tick();
    }
  };
  const draft = (checks: Check[]) => h.controller.handle({ type: "verificationDraft", checks });
  const saveState = () => fixResultOf(h.last())?.verificationAutosave;
  return { h, options, calls, timers, pending, flush, draft, saveState };
}

test("auto-save 1–6: an edit marks the form dirty, a burst of edits is one save after the pause, and the form is saved", async () => {
  const a = await autosaving();
  assert.equal(a.saveState(), undefined, "a form nobody typed in is not dirty");
  assert.equal(a.calls.length, 0);

  await a.draft([check("U")]);
  await a.draft([check("Un")]);
  await a.draft([check("Unit tests"), blank()]);
  assert.deepEqual(a.saveState(), { state: "dirty" });
  assert.equal(a.pending().filter((timer) => timer.delay === VERIFICATION_AUTOSAVE_MS).length, 1, "edits were not coalesced");
  assert.equal(VERIFICATION_AUTOSAVE_MS, 750);
  assert.equal(a.calls.length, 0, "an edit wrote before the pause");

  const states: string[] = [];
  const before = a.h.states.length;
  await a.flush();
  for (const state of a.h.states.slice(before)) {
    const s = fixResultOf(state)?.verificationAutosave?.state;
    if (s !== undefined && states.at(-1) !== s) states.push(s);
  }
  assert.deepEqual(states, ["saving", "saved"]);
  assert.equal(a.calls.length, 1);
  // The blank row an Add Check left is not saved; nothing is inferred from the rest.
  assert.deepEqual(a.calls[0]!.payload.checks, [check("Unit tests")]);
  assert.equal(a.calls[0]!.args.includes("--replace"), false, "a first save replaced something");
  assert.ok(fixResultOf(a.h.last())!.verificationResult, "the saved evidence did not show");
});

test("auto-save 7–9: a later edit — an added check, a changed one, a removed one — replaces the report it wrote", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests")]);
  await a.flush();
  await a.draft([check("Unit tests"), check("Manual repro", { type: "manual", procedure: "Open the dialog" })]);
  await a.flush();
  await a.draft([check("Unit tests", { status: "failed" })]);
  await a.flush();
  assert.equal(a.calls.length, 3);
  for (const call of a.calls.slice(1)) assert.ok(call.args.includes("--replace"), "a later save did not replace");
  assert.deepEqual(a.calls[2]!.payload.checks, [check("Unit tests", { status: "failed" })]);
  assert.deepEqual(a.saveState(), { state: "saved" });
});

test("auto-save: an unchanged form writes nothing, and says it is saved", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests")]);
  await a.flush();
  await a.draft([check("Unit tests"), blank()]);
  await a.flush();
  assert.equal(a.calls.length, 1, "the same checks were written again");
  assert.deepEqual(a.saveState(), { state: "saved" });
});

test("auto-save: an empty form writes no report; an incomplete check is said, not saved, until it is complete", async () => {
  const a = await autosaving();
  await a.draft([blank()]);
  await a.flush();
  assert.deepEqual(a.saveState(), { state: "incomplete", message: "Nothing to save yet: enter a check." });
  assert.equal(a.calls.length, 0);
  assert.equal(a.options.directory!.includes("verification_report.md"), false, "an empty form made a report");

  await a.draft([blank(), { ...blank(), evidence: "It passed" }]);
  await a.flush();
  assert.deepEqual(a.saveState(), { state: "incomplete", message: "Not saved yet: check 1 needs a name." });
  assert.equal(a.calls.length, 0);

  await a.draft([blank(), { ...blank(), name: "Unit tests", evidence: "It passed" }]);
  await a.flush();
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.saveState(), { state: "saved" });
});

test("auto-save: removing every check keeps the saved report, and says so", async () => {
  const a = await autosaving({ evidence: true });
  await a.h.controller.handle({ type: "action", id: "editVerification" });
  const before = a.h.files["verification_report.md"];
  await a.draft([]);
  await a.flush();
  assert.equal(a.calls.length, 0);
  assert.equal(a.h.files["verification_report.md"], before);
  assert.match((a.saveState() as { message: string }).message, /the saved evidence is kept/);
});

test("auto-save: a failed save keeps the draft and says so; Retry Save and a later edit save it", async () => {
  let fail = true;
  const a = await autosaving({
    answer: async () =>
      fail
        ? { ok: false, command: "record-verification", error: { code: "INTERNAL_ERROR", message: "disk full" } }
        : VERIFICATION_RECORDED,
  });
  await a.draft([check("Unit tests")]);
  await a.flush();
  const failed = a.saveState() as { state: string; message: string };
  assert.equal(failed.state, "error");
  assert.match(failed.message, /disk full/);
  assert.equal(a.options.directory!.includes("verification_report.md"), false, "a failed save listed a report");
  fail = false;
  await a.h.controller.handle({ type: "flushVerification" });
  assert.deepEqual(a.saveState(), { state: "saved" });
  assert.deepEqual(a.calls.at(-1)!.payload.checks, [check("Unit tests")], "the draft was not the one retried");
});

test("auto-save conflict: a report changed outside the form is never overwritten; the developer chooses", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests")]);
  await a.flush();
  // Someone else writes the report.
  a.h.files["verification_report.md"] = "# Verification Report: JR-12345\n\nWritten by hand.\n";
  await a.draft([check("Unit tests", { notes: "mine" })]);
  await a.flush();
  const conflict = a.saveState() as { state: string; message: string };
  assert.equal(conflict.state, "conflict");
  assert.match(conflict.message, /changed outside this form/);
  assert.equal(a.calls.length, 1, "the changed report was overwritten");
  assert.equal(a.h.files["verification_report.md"], "# Verification Report: JR-12345\n\nWritten by hand.\n");
  // More edits wait for the choice.
  await a.draft([check("Unit tests", { notes: "mine, again" })]);
  await a.flush();
  assert.equal(a.calls.length, 1);
  assert.equal(a.saveState()?.state, "conflict");
  // Overwrite Saved Version: the form's latest checks, over the version there now.
  await a.h.controller.handle({ type: "overwriteVerification" });
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[1]!.args.includes("--replace"));
  assert.deepEqual(a.calls[1]!.payload.checks, [check("Unit tests", { notes: "mine, again" })]);
  assert.deepEqual(a.saveState(), { state: "saved" });
});

test("auto-save conflict: Reload Saved Version loads the report and clears the conflict", async () => {
  const a = await autosaving({ evidence: true });
  await a.h.controller.handle({ type: "action", id: "editVerification" });
  a.h.files["verification_report.md"] = ONE_PASSED_MD.replace("Unit tests", "Changed elsewhere");
  await a.h.controller.refreshArtifacts();
  await a.draft([check("Unit tests", { notes: "mine" })]);
  await a.flush();
  assert.equal(a.saveState()?.state, "conflict");
  await a.h.controller.handle({ type: "action", id: "editVerification" });
  const edit = fixResultOf(a.h.states.at(-1)!)!.verificationEdit;
  assert.equal(edit?.checks[0]?.name, "Changed elsewhere");
  assert.equal(a.saveState(), undefined);
});

test("auto-save and the watcher: its own write is a read-only refresh — no second save, no loop, the draft intact", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests")]);
  await a.flush();
  // The file watcher sees BugPilot's own write and the folder is read again.
  await a.h.controller.refreshArtifacts();
  await a.h.controller.refreshArtifacts();
  await a.flush();
  assert.equal(a.calls.length, 1, "a refresh started a save");
  assert.deepEqual(a.saveState(), { state: "saved" });
  // The version just written is the one the form edits: the next edit replaces it without a conflict.
  await a.draft([check("Unit tests", { evidence: "12 passed" })]);
  await a.flush();
  assert.equal(a.calls.length, 2);
  assert.deepEqual(a.saveState(), { state: "saved" });
});

test("auto-save: edits made while a save is being written are saved after it", async () => {
  let release: () => void = () => {};
  const a = await autosaving({
    answer: () => new Promise<Envelope>((resolve) => { release = () => resolve(VERIFICATION_RECORDED); }),
  });
  await a.draft([check("Unit tests")]);
  const first = a.pending().find((timer) => timer.delay === VERIFICATION_AUTOSAVE_MS)!;
  first.ran = true;
  first.callback();
  await tick();
  assert.equal(a.saveState()?.state, "saving");
  await a.draft([check("Unit tests", { evidence: "later" })]);
  release();
  for (let i = 0; i < 8; i += 1) await tick();
  assert.equal(a.saveState()?.state, "dirty", "a newer edit was reported as saved");
  await a.flush();
  release();
  for (let i = 0; i < 8; i += 1) await tick();
  assert.deepEqual(a.calls.at(-1)!.payload.checks, [check("Unit tests", { evidence: "later" })]);
});

test("auto-save: opening another work item saves the form first; if it cannot be saved, the developer is asked", async () => {
  const a = await autosaving({});
  await a.draft([check("Unit tests")]);
  await a.h.controller.showWorkItem("JR-12345");
  assert.equal(a.calls.length, 1, "switching dropped an unsaved form");

  const b = await autosaving({
    confirm: false,
    answer: async () => ({ ok: false, command: "record-verification", error: { code: "INTERNAL_ERROR", message: "locked" } }),
  });
  await b.draft([check("Unit tests")]);
  const statesBefore = b.h.states.length;
  await b.h.controller.showWorkItem("JR-77777");
  assert.match(b.h.confirms.at(-1)?.message ?? "", /could not be saved\. Open the other work item anyway\? They will be lost\./);
  assert.equal(b.h.confirms.at(-1)?.keepLabel, "Keep Editing");
  assert.equal(b.h.controller.workItemId, "JR-12345", "Keep Editing still switched");
  assert.ok(b.h.states.length > statesBefore);
});

test("auto-save: a run saves the form first", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests")]);
  await a.h.controller.run(jiraForm());
  assert.equal(a.calls.length, 1);
});

test("auto-save: a save waiting behind another write goes once it ends", async () => {
  let release: () => void = () => {};
  const a = await autosaving({
    runReview: () => new Promise<Envelope>((resolve) => { release = () => resolve(RECORDED); }),
  });
  const recording = a.h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  await a.draft([check("Unit tests")]);
  await a.flush();
  assert.equal(a.calls.length, 0, "the evidence was written under another write");
  release();
  await recording;
  await a.flush();
  assert.equal(a.calls.length, 1);
});

test("auto-save and Start New Attempt: only the saved report is feedback, never the unsaved form", async () => {
  const a = await autosaving({ evidence: true });
  await a.h.controller.handle({ type: "action", id: "editVerification" });
  await a.draft([check("Not saved yet", { status: "failed" })]);
  // The helper reads the file on disk: the saved check, not the typed one.
  const text = feedbackFromVerification(parseVerificationReport(a.h.files["verification_report.md"]));
  assert.doesNotMatch(text ?? "", /Not saved yet/);
});

test("auto-save: a draft with a status or type that is not one is refused before it reaches the host", () => {
  for (const bad of [{ status: "verified" }, { type: "automatic" }]) {
    assert.equal(parsePanelMessage({ type: "verificationDraft", checks: [{ ...check("x"), ...bad }] }), undefined, JSON.stringify(bad));
  }
  assert.equal(parsePanelMessage({ type: "verificationDraft" }), undefined);
});

test("auto-save: all checks saved as Passed is only that — no verdict appears", async () => {
  const a = await autosaving();
  await a.draft([check("Unit tests"), check("Repro", { type: "manual" })]);
  await a.flush();
  const said = JSON.stringify(fixResultOf(a.h.last()));
  for (const verdict of ["Verified", "verified", "Approved", "Safe to merge"]) assert.equal(said.includes(verdict), false, verdict);
});

// --- Repository Files' quick fix: .ai/ and .ai_memory/ in .gitignore (§37.85)

/**
 * A repository's .gitignore and the git that reads it: `doctor` is asked on
 * every environment check and answers from the file on disk, the way `git
 * check-ignore` would for these spellings. `stuck` is a git that goes on saying
 * "not ignored" whatever the file says — a later `!` rule somewhere.
 */
function gitRepo(initial: string | undefined, options: { stuck?: boolean; document?: GitignoreDocument; writeThrows?: Error } = {}) {
  const repo = {
    disk: initial,
    writes: [] as string[],
    checks: 0,
    stuck: options.stuck ?? false,
    document: options.document,
  };
  const ignores = (directory: string) =>
    !repo.stuck &&
    (repo.disk ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => [directory, `${directory}/`, `/${directory}`, `/${directory}/`].includes(line));
  const environment = (): Environment => {
    repo.checks += 1;
    const paths = { ".ai": ignores(".ai"), ".ai_memory": ignores(".ai_memory") };
    return {
      kind: "ready",
      root: ROOT,
      executable: "bugpilot",
      report: { python_ok: true, ai_artifacts_ignored: paths[".ai"] && paths[".ai_memory"], ai_artifacts_ignored_paths: paths },
    };
  };
  const io: GitignoreIo = {
    document: (file) => {
      assert.equal(file, nodePath.join(ROOT, ".gitignore"), "a .gitignore other than the repository root's");
      return repo.document;
    },
    stat: async () => (repo.disk === undefined ? "missing" : "file"),
    read: async () => new TextEncoder().encode(repo.disk ?? ""),
    write: async (file, bytes) => {
      assert.equal(file, nodePath.join(ROOT, ".gitignore"), "a .gitignore other than the repository root's");
      if (options.writeThrows) throw options.writeThrows;
      repo.disk = new TextDecoder().decode(bytes);
      repo.writes.push(repo.disk);
    },
  };
  return { repo, environment, io };
}

async function withGitignore(initial: string | undefined, options: Parameters<typeof gitRepo>[1] = {}) {
  const git = gitRepo(initial, options);
  const h = harness({ environment: git.environment, gitignore: git.io });
  await h.controller.refreshEnvironment();
  return { ...git, h };
}

const repositoryFiles = (state: PanelState) => state.warnings.find((warning) => warning.title === "Repository Files");
const press = (h: Harness) => h.controller.handle({ type: "action", id: "addArtifactsToGitignore" });

test("gitignore fix: both missing — the card offers Add to .gitignore, named for what it does", async () => {
  const { h } = await withGitignore(undefined);
  const card = repositoryFiles(h.last());
  assert.ok(card, "no Repository Files card");
  // The warning's own words are unchanged.
  assert.match(card.message, /does not ignore \.ai\/ and \.ai_memory\//);
  assert.deepEqual(card.action, { id: "addArtifactsToGitignore", label: "Add to .gitignore", accessibleName: GITIGNORE_ACTION_NAME });
  assert.equal(GITIGNORE_ACTION_NAME, "Add .ai and .ai_memory to .gitignore");
  assert.equal(card.status, undefined);
});

test("gitignore fix: no .gitignore — created with the two rules, doctor asked again, and the card is gone", async () => {
  const { h, repo } = await withGitignore(undefined);
  const checksBefore = repo.checks;
  await press(h);
  assert.equal(repo.disk, ".ai/\n.ai_memory/\n");
  // Gone because git said so: doctor ran again after the write, by itself.
  assert.equal(repo.checks, checksBefore + 1, "the warning went without a re-check");
  assert.equal(repositoryFiles(h.last()), undefined);
  assert.equal(h.last().noticeStatus, "Added .ai/ and .ai_memory/ to .gitignore. Git now ignores .ai/ and .ai_memory/.");
  assert.ok(h.logged.some((line) => /Created .*\.gitignore: added \.ai\/, \.ai_memory\//.test(line)));
});

test("gitignore fix: only .ai/ missing — only .ai/ is appended; unrelated rules are untouched", async () => {
  const before = "# build\nnode_modules/\n\n.ai_memory/\n";
  const { h, repo } = await withGitignore(before);
  await press(h);
  assert.equal(repo.disk, `${before}.ai/\n`);
  assert.equal(repositoryFiles(h.last()), undefined);
  assert.equal(h.last().noticeStatus, "Added .ai/ to .gitignore. Git now ignores .ai/ and .ai_memory/.");
});

test("gitignore fix: only .ai_memory/ missing — only .ai_memory/ is appended", async () => {
  const { h, repo } = await withGitignore("dist/\n.ai/\n");
  await press(h);
  assert.equal(repo.disk, "dist/\n.ai/\n.ai_memory/\n");
});

test("gitignore fix: an equivalent spelling git already honours gets no duplicate", async () => {
  // `.ai` and `/.ai_memory` cover the directories; git says so, and only
  // git's answer decides — not whether the exact string `.ai/` is in the file.
  for (const before of [".ai\n", "/.ai/\n", "/.ai\n"]) {
    const { h, repo } = await withGitignore(before);
    assert.deepEqual(repositoryFiles(h.last())?.action?.id, "addArtifactsToGitignore", before);
    await press(h);
    assert.equal(repo.disk, `${before}.ai_memory/\n`, before);
  }
});

test("gitignore fix: both already ignored — no card, no button, and a press writes nothing", async () => {
  const { h, repo } = await withGitignore("/.ai\n.ai_memory\n");
  assert.equal(repositoryFiles(h.last()), undefined);
  await press(h);
  assert.equal(repo.writes.length, 0);
  assert.ok(h.logged.some((line) => /not on offer/.test(line)));
});

test("gitignore fix: a file without a final newline gets the rules on lines of their own", async () => {
  const { h, repo } = await withGitignore("node_modules/");
  await press(h);
  assert.equal(repo.disk, "node_modules/\n.ai/\n.ai_memory/\n");
});

test("gitignore fix: CRLF stays CRLF, LF stays LF", async () => {
  const crlf = await withGitignore("node_modules/\r\ndist/\r\n");
  await press(crlf.h);
  assert.equal(crlf.repo.disk, "node_modules/\r\ndist/\r\n.ai/\r\n.ai_memory/\r\n");
  const lf = await withGitignore("node_modules/\ndist/\n");
  await press(lf.h);
  assert.equal(lf.repo.disk, "node_modules/\ndist/\n.ai/\n.ai_memory/\n");
});

test("gitignore fix: pressed twice, the second press has nothing to do", async () => {
  const { h, repo } = await withGitignore("dist/\n");
  await press(h);
  await press(h);
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.disk, "dist/\n.ai/\n.ai_memory/\n");
});

test("gitignore fix: a write that fails keeps the card, says so, and logs why — not what the file holds", async () => {
  const secret = "internal.example/private-path";
  const { h, repo } = await withGitignore(`${secret}\n`, { writeThrows: new Error("EPERM: operation not permitted") });
  await press(h);
  const card = repositoryFiles(h.last());
  assert.ok(card, "the warning went on a failed write");
  assert.equal(card.status, GITIGNORE_FAILED);
  assert.match(GITIGNORE_FAILED, /^Could not update \.gitignore\./);
  // Still offered: a retry may work once whatever blocked it is gone.
  assert.equal(card.action?.busy, undefined);
  assert.equal(card.action?.id, "addArtifactsToGitignore");
  const error = h.logged.find((line) => line.startsWith("ERROR Could not update"));
  assert.match(error ?? "", /EPERM/);
  assert.equal(h.logged.some((line) => line.includes(secret)), false, "the file's contents reached the log");
  assert.equal(repo.disk, `${secret}\n`);
});

test("gitignore fix: written, and git still does not ignore them — the card stays and says so, neutrally", async () => {
  const { h, repo } = await withGitignore("dist/\n", { stuck: true });
  await press(h);
  assert.equal(repo.disk, "dist/\n.ai/\n.ai_memory/\n");
  const card = repositoryFiles(h.last());
  assert.ok(card, "the warning went because the write succeeded, not because git agreed");
  assert.match(card.status ?? "", /The rules are in \.gitignore, but Git still does not ignore \.ai\/ and \.ai_memory\//);
  // Pressing again could not change git's answer.
  assert.equal(card.action, undefined);
  assert.equal(h.last().noticeStatus, undefined);
});

test("gitignore fix: the button is busy while the write and the re-check run, and a second press is not a second write", async () => {
  const git = gitRepo("dist/\n");
  let release = () => {};
  const held: GitignoreIo = {
    ...git.io,
    write: async (file, bytes) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await git.io.write(file, bytes);
    },
  };
  const h = harness({ environment: git.environment, gitignore: held });
  await h.controller.refreshEnvironment();
  const first = press(h);
  await tick();
  assert.deepEqual(repositoryFiles(h.last())?.action?.busy, true);
  assert.equal(repositoryFiles(h.last())?.action?.label, "Adding to .gitignore…");
  await press(h);
  release();
  await first;
  assert.equal(git.repo.writes.length, 1);
});

test("gitignore fix: an open .gitignore with unsaved edits gets the rules in its buffer — the edits stay, nothing is written", async () => {
  const buffer = { text: "dist/\ncoverage/\n", dirty: true, saves: 0 };
  const document: GitignoreDocument = {
    get text() { return buffer.text; },
    eol: "\n",
    get dirty() { return buffer.dirty; },
    append: async (more) => { buffer.text += more; return true; },
    save: async () => { buffer.saves += 1; return true; },
  };
  const { h, repo } = await withGitignore("dist/\n", { document });
  const checks = repo.checks;
  await press(h);
  assert.equal(buffer.text, "dist/\ncoverage/\n.ai/\n.ai_memory/\n", "the developer's typing was lost");
  assert.equal(buffer.saves, 0, "their unsaved edits were saved for them");
  assert.equal(repo.writes.length, 0, "the disk was written behind a dirty editor");
  const card = repositoryFiles(h.last());
  assert.ok(card);
  assert.match(card.status ?? "", /Added \.ai\/ and \.ai_memory\/ to your open \.gitignore, which has unsaved changes\. Save it to apply them\./);
  assert.equal(card.action, undefined);
  // Git has not seen it: no re-check yet.
  assert.equal(repo.checks, checks);

  // The developer saves; the host re-checks, and the card goes.
  repo.disk = buffer.text;
  buffer.dirty = false;
  await h.controller.gitignoreSaved();
  assert.equal(repo.checks, checks + 1);
  assert.equal(repositoryFiles(h.last()), undefined);
  assert.match(h.last().noticeStatus ?? "", /Git now ignores \.ai\/ and \.ai_memory\//);
});

test("gitignore fix: a .gitignore saved by hand is re-checked by itself — no reload, no refresh button", async () => {
  const { h, repo } = await withGitignore("dist/\n");
  assert.ok(repositoryFiles(h.last()));
  repo.disk = "dist/\n.ai/\n.ai_memory/\n";
  await h.controller.gitignoreSaved();
  assert.equal(repositoryFiles(h.last()), undefined);
  // And the other way: a rule removed by hand brings the card back.
  repo.disk = "dist/\n.ai/\n";
  await h.controller.gitignoreSaved();
  assert.equal(repositoryFiles(h.last())?.action?.id, "addArtifactsToGitignore");
});

test("gitignore fix: a CLI without the per-directory answer shows the warning and no button", async () => {
  const h = harness({
    environment: { kind: "ready", root: ROOT, executable: "bugpilot", report: { ai_artifacts_ignored: false } },
    gitignore: gitRepo(undefined).io,
  });
  await h.controller.refreshEnvironment();
  const card = repositoryFiles(h.last());
  assert.ok(card);
  assert.equal(card.action, undefined);
});

test("gitignore fix: the page may ask for it by name, and for nothing like a path or a rule", () => {
  assert.deepEqual(parsePanelMessage({ type: "action", id: "addArtifactsToGitignore" }), { type: "action", id: "addArtifactsToGitignore" });
  assert.equal(parsePanelMessage({ type: "action", id: "addToGitignore" }), undefined);
});

test("gitignore fix: while the re-check runs the card stays as it was at the press, so the page never loses the button before the result", async () => {
  const git = gitRepo(undefined);
  const h = harness({ environment: git.environment, gitignore: git.io });
  await h.controller.refreshEnvironment();
  const from = h.states.length;
  await press(h);
  const during = h.states.slice(from, -1);
  assert.ok(during.length >= 2, "no intermediate states to look at");
  for (const state of during) {
    assert.equal(repositoryFiles(state)?.action?.busy, true, "an intermediate render dropped or changed the card");
  }
  assert.equal(repositoryFiles(h.last()), undefined);
  assert.match(h.last().noticeStatus ?? "", /Git now ignores/);
});

// --- Open AI Session acknowledgement (§37.87) --------------------------------

/** An attempted work item with a hand-run timer, for Open AI Session's feedback. */
async function sessionHarness(extra: HarnessOptions = {}) {
  const timers: { callback: () => void; delay: number; cancelled: boolean; ran: boolean }[] = [];
  const h = await attemptedHarness({
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, ran: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    ...extra,
  });
  const live = () => timers.filter((timer) => timer.delay === SESSION_FEEDBACK_MS && !timer.cancelled && !timer.ran);
  const expire = () => {
    for (const timer of live()) {
      timer.ran = true;
      timer.callback();
    }
  };
  return { h, timers, live, expire, open: () => h.controller.handle(next("openSession")) };
}

/** What the rows and the button say, which the acknowledgement must never touch. */
const workflowOf = (state: PanelState) => JSON.stringify({ workflow: state.workflow, primary: state.primary, overall: state.overall });

test("Open AI Session: the found terminal is brought forward, and the press says so — for a while", async () => {
  const { h, live, expire, open } = await sessionHarness();
  const before = workflowOf(h.last());
  await open();
  assert.deepEqual(h.revealed, ["Fix with AI · JR-12345"]);
  assert.equal(h.terminals.length, 1, "a second terminal");
  assert.deepEqual(
    { kind: h.last().sessionFeedback?.kind, message: h.last().sessionFeedback?.message },
    { kind: "focused", message: "AI session focused" },
  );
  assert.equal(live().length, 1);
  assert.equal(live()[0]!.delay, 1800);
  // Presentation only: the rows, the button and the header are what they were.
  assert.equal(workflowOf(h.last()), before);

  expire();
  assert.equal(h.last().sessionFeedback, undefined, "the acknowledgement outlived its time");
  assert.equal(workflowOf(h.last()), before, "the timeout took something else with it");
  // Nothing written, nothing run.
  assert.deepEqual(h.written, []);
});

test("Open AI Session pressed again and again: one terminal, one acknowledgement, one timer", async () => {
  const { h, timers, live, open } = await sessionHarness();
  await open();
  const first = h.last().sessionFeedback!.seq;
  await open();
  await open();
  assert.equal(h.revealed.length, 3);
  assert.equal(h.terminals.length, 1, "a press started a session");
  assert.equal(live().length, 1, "timers piled up");
  assert.equal(timers.filter((timer) => timer.delay === SESSION_FEEDBACK_MS && timer.cancelled).length, 2, "an old timer was not replaced");
  assert.equal(h.last().sessionFeedback!.seq, first + 2);
  assert.equal(h.last().sessionFeedback!.message, "AI session focused");
});

test("Open AI Session with its terminal closed: a neutral word that stays, and nothing started", async () => {
  const { h, live, open } = await sessionHarness();
  h.openTerminals.length = 0;
  const before = workflowOf(h.last());
  await open();
  assert.equal(h.terminals.length, 1, "a new terminal was started");
  assert.equal(h.last().sessionFeedback?.kind, "unavailable");
  assert.equal(live().length, 0, "the guidance would vanish before it could be read");
  assert.equal(workflowOf(h.last()), before, "the attempt changed");
  assert.equal(fixRow(h.last()).status, "success", "the row now reads as a failed fix");
});

test("Open AI Session when the editor cannot show the terminal: a neutral message, and nothing else changes", async () => {
  const { h, live, open } = await sessionHarness({ revealThrows: new Error("Terminal has been disposed") });
  const before = workflowOf(h.last());
  await open();
  assert.deepEqual(
    { kind: h.last().sessionFeedback?.kind, message: h.last().sessionFeedback?.message },
    { kind: "failed", message: "Could not open the existing AI session." },
  );
  assert.equal(h.terminals.length, 1, "a new session was started");
  assert.equal(live().length, 0);
  assert.equal(workflowOf(h.last()), before, "the workflow changed on a focus failure");
  assert.equal(fixRow(h.last()).attempt, undefined, "the attempt was touched");
  assert.ok(h.logged.some((line) => /^ERROR Could not show the AI session terminal for JR-12345: Terminal has been disposed/.test(line)));
});

test("Open AI Session's word goes with a new attempt, another work item, or a panel that no longer offers it", async () => {
  const { h, open } = await sessionHarness();
  h.openTerminals.length = 0;
  await open();
  assert.equal(h.last().sessionFeedback?.kind, "unavailable");
  // Start New Attempt opens a new terminal: the old "no longer available" is stale.
  await h.controller.handle(startAttempt(""));
  assert.equal(h.last().sessionFeedback, undefined);

  await open();
  assert.equal(h.last().sessionFeedback?.kind, "focused");
  // A run: the button is Running…, so there is nothing for it to be about.
  await h.controller.handle(next("rebuildContext"));
  assert.equal(h.last().sessionFeedback, undefined);
});

test("Open AI Session's timer is cancelled when the panel goes away", async () => {
  const { h, timers, live, open } = await sessionHarness();
  await open();
  assert.equal(live().length, 1);
  h.controller.dispose();
  assert.equal(live().length, 0);
  assert.equal(timers.filter((timer) => timer.delay === SESSION_FEEDBACK_MS).every((timer) => timer.cancelled), true);
});

test("Open AI Session's acknowledgement is never persisted", async () => {
  const { h, open } = await sessionHarness();
  const savedItems = h.savedWorkItems.length;
  await open();
  // The press saves the form as every primary press does; nothing of the
  // acknowledgement goes with it, and no work item or artifact is written.
  assert.equal(JSON.stringify(h.saved.at(-1) ?? {}).includes("session"), false);
  assert.equal(h.savedWorkItems.length, savedItems);
  assert.deepEqual(h.written, []);
});

// --- Flat Artifacts list (§37.88) ---------------------------------------------

const artifactNames = (h: Harness) => {
  const list = h.controller.artifacts;
  return list.kind === "ready" ? list.entries.map((entry) => `${entry.name}:${entry.written ? "written" : "not written"}`) : [list.kind];
};

test("flat artifacts: a watcher create and delete turn a row Written and back, without a reload", async () => {
  const r = refreshing({ directory: PREPARED_FILES });
  const h = await openedForReview(r.options);
  assert.ok(artifactNames(h).includes("review_report.md:not written"));

  r.options.directory = [...PREPARED_FILES, "review_report.md"];
  r.live()[0]!.fire("review_report.md");
  await r.flush();
  assert.ok(artifactNames(h).includes("review_report.md:written"), "a created file was not listed as written");

  r.options.directory = PREPARED_FILES.filter((name) => name !== "context.md");
  r.live()[0]!.fire("context.md");
  await r.flush();
  assert.ok(artifactNames(h).includes("context.md:not written"), "a deleted file still read as written");
  // One row per file, whatever happened to it.
  assert.equal(artifactNames(h).filter((row) => row.startsWith("context.md:")).length, 1);
});

test("flat artifacts: switching work items lists the new item's files, never the last one's", async () => {
  const { h, options } = twoWorkItems();
  await h.controller.refreshEnvironment();
  options.directory = ["issue.json", "run.json", "fix_report.md", "user_feedback.md"];
  await h.controller.showWorkItem("JR-1");
  assert.ok(artifactNames(h).includes("fix_report.md:written"));
  assert.ok(artifactNames(h).includes("user_feedback.md:written"));

  options.directory = ["issue.json", "run.json"];
  const refreshes = h.refreshes.count;
  await h.controller.showWorkItem("JR-2");
  assert.ok(artifactNames(h).includes("fix_report.md:not written"), "JR-1's report was shown for JR-2");
  assert.equal(artifactNames(h).some((row) => row.startsWith("user_feedback.md")), false, "JR-1's side-band file was shown for JR-2");
  assert.ok(h.refreshes.count > refreshes, "the Artifacts tree was not told");
});

test("flat artifacts: a work item reopened from History ends on its list, never on Scanning", async () => {
  const { h } = twoWorkItems();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");
  assert.equal(h.controller.artifacts.kind, "ready", "left on loading — the tree would say Scanning .ai/ …");
  assert.deepEqual(artifactNames(h).slice(0, 3), ["issue.json:written", "context.md:written", "task.md:written"]);
});

// --- §37.94: the AI Agent layer, through the controller ----------------------------

const CODEX_ONLY = (command: string) => Promise.resolve(command === "codex");
const HANDOFF = "Read .ai/JR-12345/task.md and complete the workflow.";

test("Codex CLI is runnable: an explicit choice starts `codex` in the repository root", async () => {
  const form = jiraForm({ agent: "codex-cli" });
  const h = await preparedHarness({ agentProbe: CODEX_ONLY, form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));

  assert.deepEqual(h.terminals, [{ name: "Fix with AI · JR-12345", cwd: ROOT, commandLine: `codex ${JSON.stringify(HANDOFF)}` }]);
  assert.equal(fixRow(h.last()).detail, "Handed to Codex CLI in a terminal.");
  assert.deepEqual(h.probed, ["codex"], "an agent other than the chosen one was probed");
});

test("explicit Codex CLI that is missing does not silently start Claude", async () => {
  // Claude is installed; Codex is not. The developer chose Codex.
  const form = jiraForm({ agent: "codex-cli" });
  const h = await preparedHarness({ agentProbe: (command) => Promise.resolve(command === "claude"), form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));

  assert.deepEqual(h.terminals, [], "another agent was started in the chosen one's place");
  const row = fixRow(h.last());
  assert.equal(row.status, "failed");
  assert.equal(row.error?.title, "AI agent unavailable");
  assert.equal(
    row.error?.detail,
    "Codex CLI is not available: codex was not found on PATH. Install or configure Codex CLI, or choose another AI Agent.",
  );
  assert.deepEqual(h.probed, ["codex"], "an agent other than the chosen one was probed");
});

test("explicit Claude CLI that is missing does not silently start Codex", async () => {
  const form = jiraForm({ agent: "claude-cli" });
  const h = await preparedHarness({ agentProbe: CODEX_ONLY, form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));
  assert.deepEqual(h.terminals, []);
  assert.match(fixRow(h.last()).error?.detail ?? "", /^Claude CLI is not available/);
  assert.deepEqual(h.probed, ["claude"]);
});

test("Auto-detect hands over to whichever CLI is there, and remembers it", async () => {
  const stored: string[] = [];
  const h = await preparedHarness({
    agentProbe: CODEX_ONLY,
    lastAgent: { get: () => stored.at(-1), set: (id) => void stored.push(id) },
  });
  await h.controller.handle(next("fixWithAI"));

  assert.equal(h.terminals[0]?.commandLine, `codex ${JSON.stringify(HANDOFF)}`);
  assert.deepEqual(stored, ["codex-cli"], "the agent the handoff reached was not remembered");
  assert.ok(h.logged.includes("Auto-detect resolved to Codex CLI."), h.logged.join("\n"));
});

test("an extension bridge: the prompt is copied, the agent's view opened, and the row says to paste", async () => {
  const form = jiraForm({ agent: "claude-extension" });
  const h = await preparedHarness({ agentOnPath: false, extensions: CLAUDE_EXTENSION, form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));

  assert.deepEqual(h.terminals, [], "a bridge opened a terminal");
  assert.deepEqual(h.clipboard, [HANDOFF]);
  assert.deepEqual(h.extensionCommands, ["claude-vscode.sidebar.open"]);
  const row = fixRow(h.last());
  assert.equal(row.status, "success");
  assert.equal(row.detail, "BugPilot AI fix context copied. Paste it into Claude to continue.");
  assert.equal(row.error, undefined);
  assert.equal(h.notices.at(-1)?.message, "BugPilot AI fix context copied. Paste it into Claude to continue.");
  // No terminal to reopen: Open AI Session is not what comes next.
  assert.notEqual(h.last().primary.action, "openSession");
  assert.deepEqual(h.probed, [], "a bridge spawned a CLI probe");
});

test("an explicit extension that is not installed is refused, and its CLI is not used instead", async () => {
  const form = jiraForm({ agent: "codex-extension" });
  const h = await preparedHarness({ agentOnPath: true, extensions: {}, form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));
  assert.deepEqual(h.terminals, []);
  assert.deepEqual(h.extensionCommands, []);
  assert.match(fixRow(h.last()).error?.detail ?? "", /^Codex Extension is not available: the openai\.chatgpt extension is not installed/);
});

test("Review with AI through a bridge copies the review prompt and says so on the row", async () => {
  const h = await openedForReview(
    reviewOptions({ agentOnPath: false, extensions: CLAUDE_EXTENSION, form: { ...DEFAULT_FORM, issueKey: "JR-12345", agent: "claude-extension" } }),
  );
  await h.controller.handle(REVIEW);
  assert.deepEqual(h.terminals, []);
  assert.equal(h.clipboard.length, 1);
  assert.deepEqual(h.extensionCommands, ["claude-vscode.sidebar.open"]);
  const review = reviewOf(h.last());
  assert.equal(review?.state, "started");
  assert.equal(review?.state === "started" && review.detail, "BugPilot review prompt copied. Paste it into Claude to continue.");
});

test("changing the AI Agent does not make the prepared context stale or rebuild it", async () => {
  const h = await preparedHarness();
  const runs = h.streamRuns.length;
  assert.equal(h.last().primary.action, "fixWithAI");
  for (const agent of ["codex-cli", "claude-extension", "custom", "auto"] as const) {
    await h.controller.handle(applySettings(jiraForm({ agent, agentCommand: "my-agent {prompt}" })));
    assert.equal(h.last().primary.action, "fixWithAI", `${agent}: the context was marked stale`);
  }
  assert.equal(h.streamRuns.length, runs, "changing the agent rebuilt the context");
});

test("the picker's status line: detected on request, cached, and in the panel state", async () => {
  const h = harness({ agentProbe: CODEX_ONLY, extensions: CLAUDE_EXTENSION });
  await h.controller.refreshEnvironment();
  assert.deepEqual(h.last().agents.lines, {}, "a status was shown before anything was detected");

  await h.controller.handle({ type: "detectAgents" });
  assert.deepEqual(h.last().agents.lines, {
    "claude-cli": "Not found on PATH",
    "codex-cli": "Available",
    "codex-extension": "Not installed or disabled",
    "claude-extension": "Installed · Limited integration",
    auto: "Detected: Codex CLI",
  });
  const probes = h.probed.length;
  // Opening the settings page again spawns nothing: the answer is cached.
  await h.controller.handle({ type: "detectAgents" });
  assert.equal(h.probed.length, probes);
  // An extension installed or removed: asked again.
  await h.controller.agentsChanged();
  assert.ok(h.probed.length > probes);
});

test("a detection that fails does not crash the extension: every agent is simply unavailable", async () => {
  const h = harness({ agentProbe: () => Promise.reject(new Error("spawn EPERM")) });
  await h.controller.refreshEnvironment();
  await h.controller.detectAgents();
  assert.equal(h.last().agents.lines.auto, "No supported AI agent detected.");
});

test("a page from before §37.94 that still says `claude` is read as Claude CLI", () => {
  const message = parsePanelMessage({ type: "formChanged", form: { ...DEFAULT_FORM, agent: "claude" } });
  assert.equal(message?.type === "formChanged" && message.form.agent, "claude-cli");
  const unknown = parsePanelMessage({ type: "formChanged", form: { ...DEFAULT_FORM, agent: "gemini" } });
  assert.equal(unknown?.type === "formChanged" && unknown.form.agent, "auto");
});

test("an existing custom command keeps working exactly as before", async () => {
  const form = jiraForm({ agent: "custom", agentCommand: "my-agent --prompt {prompt}" });
  const h = await preparedHarness({ agentProbe: (command) => Promise.resolve(command === "my-agent"), form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));
  assert.equal(h.terminals[0]?.commandLine, `my-agent --prompt ${JSON.stringify(HANDOFF)}`);
  assert.equal(fixRow(h.last()).detail, "Handed to my-agent in a terminal.");
});

test("a repository path with spaces, parentheses and an ampersand is only ever the terminal's cwd", async () => {
  // The path is the one piece of machine text near the handoff. It must reach
  // the terminal as its working directory, never as shell text.
  const root = "C:\\path\\to\\sample repo (copy) & more";
  const h = await preparedHarness({ environment: { ...READY, root } });
  await h.controller.handle(next("fixWithAI"));
  assert.equal(h.terminals.length, 1);
  assert.equal(h.terminals[0]!.cwd, root);
  assert.equal(h.terminals[0]!.commandLine, `claude ${JSON.stringify(HANDOFF)}`);
  assert.equal(h.terminals[0]!.commandLine.includes("sample repo"), false);
});

// --- §37.95: nothing typed, read from Jira or handed to an agent reaches the log ---

const SECRET_DESCRIPTION = "SECRET_BUG_DESCRIPTION_48291";
const SECRET_JIRA = "SECRET_JIRA_TEXT_73125";
const SECRET_INSTRUCTION = "SECRET_CUSTOM_INSTRUCTION_99421";
const SECRET_TOKEN_VALUE = "SECRET_TOKEN_ABC123";
const SECRETS = [SECRET_DESCRIPTION, SECRET_JIRA, SECRET_INSTRUCTION, SECRET_TOKEN_VALUE];

/** Which of the secrets the log holds; the answer must always be none. */
const leaked = (h: Harness) => SECRETS.filter((secret) => h.logged.some((line) => line.includes(secret)));

const DESCRIBED: FormState = {
  ...DEFAULT_FORM,
  source: "manual",
  description: `Saving crashes ${SECRET_DESCRIPTION}`,
  title: `Title ${SECRET_JIRA}`,
  hint: SECRET_INSTRUCTION,
  keywords: `${SECRET_INSTRUCTION}_kw, save`,
};

test("a described bug's run logs which flags it had, never its description, title, hint or keywords", async () => {
  const h = harness({ events: successfulRun });
  await h.controller.refreshEnvironment();
  await h.controller.run(DESCRIBED);

  assert.deepEqual(leaked(h), []);
  const line = h.logged.find((entry) => entry.startsWith("bugpilot bug "));
  assert.ok(line, h.logged.join("\n"));
  assert.match(line!, /--description=<redacted> --title=<redacted> --hint=<redacted> --keywords=<redacted> --keywords=<redacted>/);
  assert.match(line!, /--resume --prepare-only --json-lines$/);
  // The run itself still got the text: only the log lost it.
  assert.ok(h.streamRuns[0]!.args.some((arg) => arg.includes(SECRET_DESCRIPTION)));
});

test("a Jira run, and improving its hint from the issue's text, log the key and the outcome only", async () => {
  const h = harness({
    events: successfulRun,
    agentOnPath: true,
    issueDetails: { title: `Crash ${SECRET_JIRA}`, description: `Steps ${SECRET_JIRA}` },
    improveHint: async () => ({ ok: true, text: `Look at the saver ${SECRET_INSTRUCTION}` }),
  });
  await h.controller.refreshEnvironment();
  const form = jiraForm({ hint: SECRET_INSTRUCTION });
  await h.controller.run(form);
  await h.controller.handle({ type: "improveHint", form });

  assert.deepEqual(leaked(h), []);
  assert.ok(h.logged.some((entry) => entry.startsWith("bugpilot bug JR-12345 --hint=<redacted>")), h.logged.join("\n"));
  // The issue's text reached the hint prompt, which is its job, and only that.
  assert.match(h.hintPrompts[0] ?? "", new RegExp(SECRET_JIRA));
});

test("a run that dies says how, with the argv it echoed scrubbed", async () => {
  const h = harness({
    terminated: false,
    stderr: `usage: bugpilot bug [-h] ...\nbugpilot bug: error: unrecognized arguments: --hint=${SECRET_INSTRUCTION}\nTraceback (most recent call last):\nValueError: ${DESCRIBED.description}`,
    events: [{ type: "started", work_item_id: "local_20260930230052", source: "manual" }],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(DESCRIBED);

  assert.deepEqual(leaked(h), []);
  const error = h.logged.find((entry) => entry.startsWith("ERROR bugpilot bug ended without a result"));
  assert.ok(error, h.logged.join("\n"));
  // Still a useful line: where it stopped, the exit, and the traceback's shape.
  assert.match(error!, /\(exit [^)]+\):/);
  assert.match(error!, /unrecognized arguments: --hint=<redacted>/);
  assert.match(error!, /ValueError: <redacted>/);
});

test("a run that could not start says why, without the argv the error carried", async () => {
  const h = harness({ streamThrows: new Error(`spawn failed: bugpilot bug --description=${DESCRIBED.description.trim()}`) });
  await h.controller.refreshEnvironment();
  await h.controller.run(DESCRIBED);

  assert.deepEqual(leaked(h), []);
  assert.ok(h.logged.some((entry) => entry === "ERROR bugpilot bug could not run: spawn failed: bugpilot bug --description=<redacted>"), h.logged.join("\n"));
  // The toast says the same, scrubbed the same way.
  assert.equal(h.notices.some((notice) => notice.message.includes(SECRET_DESCRIPTION)), false);
});

test("Fix with AI logs which agent got which work item, never the handoff prompt", async () => {
  const h = await preparedHarness();
  await h.controller.handle(next("fixWithAI"));

  assert.equal(h.terminals.length, 1);
  assert.ok(h.logged.includes("Handing JR-12345 to Claude CLI in a terminal."), h.logged.join("\n"));
  assert.equal(h.logged.some((entry) => entry.includes("complete the workflow")), false, "the handoff prompt reached the log");
});

test("a custom agent command is never logged: it may carry a token", async () => {
  const form = jiraForm({ agent: "custom", agentCommand: `my-agent --token ${SECRET_TOKEN_VALUE} --prompt {prompt}` });
  const h = await preparedHarness({ agentProbe: (command) => Promise.resolve(command === "my-agent"), form });
  await h.controller.handle(applySettings(form));
  await h.controller.handle(next("fixWithAI", form));

  // The terminal is where the command belongs; the log only says that it went there.
  assert.ok(h.terminals[0]?.commandLine.includes(SECRET_TOKEN_VALUE));
  assert.deepEqual(leaked(h), []);
  assert.ok(h.logged.includes("Handing JR-12345 to Custom command in a terminal."), h.logged.join("\n"));
});

test("Review with AI in a terminal logs the agent, never the review prompt or the command", async () => {
  const h = await openedForReview(
    reviewOptions({ agentProbe: (command) => Promise.resolve(command === "my-reviewer"), form: { ...DEFAULT_FORM, issueKey: "JR-12345", agent: "custom", agentCommand: `my-reviewer --token ${SECRET_TOKEN_VALUE} {prompt}` } }),
  );
  await h.controller.handle(REVIEW);

  assert.equal(h.terminals.length, 1);
  assert.deepEqual(leaked(h), []);
  assert.ok(h.logged.includes("Handing the review of JR-12345 to Custom command in a terminal."), h.logged.join("\n"));
  assert.equal(h.logged.some((entry) => entry.includes("Final Review Request")), false, "the review prompt reached the log");
});

test("a work item id that is not one is logged by its length, not by what was typed", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem(`${SECRET_DESCRIPTION} as typed`);

  assert.deepEqual(leaked(h), []);
  assert.ok(h.logged.some((entry) => /^ERROR Refusing to open a work item whose id is not one \(\d+ characters\)\.$/.test(entry)), h.logged.join("\n"));
});

// --- §37.98: pasted and dropped attachments, and their descriptions ------------------

/** A fake attachment store: records each write and answers a path under its digest. */
function recordingStore() {
  const stored: { digest: string; name: string; bytes: number }[] = [];
  const store: NonNullable<ControllerPorts["storeAttachment"]> = async (digest, name, bytes) => {
    stored.push({ digest, name, bytes: bytes.length });
    return `/storage/attachments/${digest}/${name}`;
  };
  return { stored, store };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
const PASTE = (data: string, attachments: readonly string[] = [], name = "image.png", type = "image/png") =>
  ({ type: "addAttachmentData", origin: "paste", files: [{ name, type, data }], attachments }) as const;
const picked = (h: Harness) => h.last().attachmentPick?.attachments;

test("a pasted screenshot is stored by the host and comes back to the draft as screenshot-1.png", async () => {
  const { stored, store } = recordingStore();
  const h = harness({ storeAttachment: store });
  await h.controller.refreshEnvironment();

  await h.controller.handle(PASTE(b64("first screenshot"), ["/logs/crash.log"]));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.name, "screenshot-1.png");
  assert.match(stored[0]!.digest, /^[0-9a-f]{16}$/);
  assert.deepEqual(picked(h), ["/logs/crash.log", `/storage/attachments/${stored[0]!.digest}/screenshot-1.png`]);
  // The form is not touched: the draft's answer, applied or cancelled by the page.
  assert.deepEqual(h.saved.at(-1)?.attachments ?? [], []);

  await h.controller.handle(PASTE(b64("second screenshot"), picked(h)!));
  assert.equal(stored[1]!.name, "screenshot-2.png");
});

test("the same file pasted or dropped again is not attached twice", async () => {
  const { stored, store } = recordingStore();
  const h = harness({ storeAttachment: store });
  await h.controller.refreshEnvironment();
  await h.controller.handle(PASTE(b64("one screenshot")));
  const list = picked(h)!;
  const pushes = h.states.length;

  await h.controller.handle({ type: "addAttachmentData", origin: "drop", files: [{ name: "shot.png", type: "image/png", data: b64("one screenshot") }], attachments: list });
  assert.equal(stored.length, 1, "the duplicate was stored again");
  assert.equal(h.states.length, pushes, "a duplicate answered the draft anyway");
  assert.equal(h.notices.at(-1)?.message, "Not attached: a file that is already attached.");
  assert.equal(h.notices.at(-1)?.kind, "info");
});

test("a dropped file keeps its own name; one over 10 MB is refused before it is kept", async () => {
  const { stored, store } = recordingStore();
  const h = harness({ storeAttachment: store });
  await h.controller.refreshEnvironment();
  const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  await h.controller.handle({
    type: "addAttachmentData",
    origin: "drop",
    files: [
      { name: "error.log", type: "text/plain", data: b64("stack trace") },
      { name: "huge.bin", type: "", data: big },
    ],
    attachments: [],
  });
  assert.deepEqual(stored.map((entry) => entry.name), ["error.log"]);
  assert.equal(picked(h)?.length, 1);
  assert.match(h.notices.at(-1)?.message ?? "", /larger than 10 MB/);
});

test("without a store the host says so, and keeps nothing", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.handle(PASTE(b64("x")));
  assert.match(h.notices.at(-1)?.message ?? "", /cannot keep pasted or dropped files/);
  assert.equal(picked(h), undefined);
});

test("the log says what kind of file, how big and how many — never its name, bytes or description", async () => {
  const { store } = recordingStore();
  const h = harness({ events: successfulRun, storeAttachment: store });
  await h.controller.refreshEnvironment();
  await h.controller.handle(PASTE(b64("SECRET_CLIPBOARD_CONTENT_7731"), [], "customer-SECRET_FILE_NAME.log", "text/plain"));
  const path = picked(h)![0]!;
  await h.controller.run(jiraForm({ attachments: [path], attachmentDescriptions: { [path]: "SECRET_ATTACHMENT_DESCRIPTION_5520" } }));

  for (const secret of ["SECRET_CLIPBOARD_CONTENT_7731", b64("SECRET_CLIPBOARD_CONTENT_7731"), "SECRET_FILE_NAME", "SECRET_ATTACHMENT_DESCRIPTION_5520"]) {
    assert.equal(h.logged.some((line) => line.includes(secret)), false, `${secret} reached the log:\n${h.logged.join("\n")}`);
  }
  assert.ok(h.logged.includes("Attachment added by paste (text/plain, 1 KB); 1 attached."), h.logged.join("\n"));
  assert.ok(h.logged.some((line) => /--attach=<redacted> --attach-description=<redacted>/.test(line)), h.logged.join("\n"));
  // The run itself got the description: only the log lost it.
  assert.ok(h.streamRuns[0]!.args.includes("--attach-description=SECRET_ATTACHMENT_DESCRIPTION_5520"));
});

test("describing an attachment makes the prepared context stale; changing the AI Agent leaves attachments alone", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", jiraForm({ attachments: ["/logs/crash.log"] })));
  assert.equal(h.last().primary.action, "fixWithAI");

  // The AI Agent: no rebuild, and the attachments and their descriptions as they were.
  await h.controller.handle(applySettings(jiraForm({ attachments: ["/logs/crash.log"], agent: "codex-cli" })));
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.deepEqual(h.saved.at(-1)?.attachments, ["/logs/crash.log"]);
  assert.deepEqual(h.saved.at(-1)?.attachmentDescriptions, {});

  // A description: the context no longer says what the next run would prepare.
  await h.controller.handle(
    applySettings(jiraForm({ attachments: ["/logs/crash.log"], attachmentDescriptions: { "/logs/crash.log": "After Save." }, agent: "codex-cli" })),
  );
  assert.equal(h.last().primary.action, "rebuildContext");
  assert.deepEqual(h.saved.at(-1)?.attachmentDescriptions, { "/logs/crash.log": "After Save." });
});

// --- Reset Session (§37.103) ---------------------------------------------------

/**
 * Everything a long session sets, on a Jira work item: every session field away
 * from its default, the AI Agent preference set, and two markers that must never
 * reach the log.
 */
const SESSION_FORM = (overrides: Partial<FormState> = {}): FormState => ({
  ...DEFAULT_FORM,
  issueKey: "JR-12345",
  hint: "SECRET_HINT_9917 check WidgetController",
  useIssueDetails: false,
  keywords: "SECRET_KEYWORD_4403",
  focusFiles: "src/widgets/",
  ignorePaths: "build/",
  maxFiles: "5",
  maxSearchLines: "100",
  attachments: ["/logs/crash.log"],
  attachmentDescriptions: { "/logs/crash.log": "The trace" },
  fixModeId: "test-driven",
  agent: "codex-cli",
  agentCommand: "my-agent --prompt {prompt}",
  gitUseSharedKeywords: false,
  gitUseSharedFocusFiles: false,
  gitKeywords: "gather order",
  gitFiles: "src/legacy/",
  gitSearchMessages: false,
  gitSearchFileHistory: false,
  gitHistoryDepth: "broader",
  gitMaxCommits: "20",
  similarUseSharedKeywords: false,
  similarKeywords: "SECRET_SIMILAR_KEYWORD_7731",
  similarMaxFixes: "2",
  ...overrides,
});

/** The form a reset leaves: the defaults, Standard Fix, the agent preference kept. */
const FRESH_FORM: FormState = {
  ...DEFAULT_FORM,
  fixModeId: "standard",
  agent: "codex-cli",
  agentCommand: "my-agent --prompt {prompt}",
};

const RESET_KEEP: PanelMessage = { type: "resetSession", deleteGeneratedFiles: false };
const RESET_DELETE: PanelMessage = { type: "resetSession", deleteGeneratedFiles: true };

/** The reset's refusals, as the pushes that carried them said them. */
const resetErrors = (h: Harness) =>
  h.states.map((state) => state.sessionReset.error?.message).filter((message): message is string => message !== undefined);

/** A panel showing a fresh session: nothing bound, nothing prepared, nothing to say. */
function assertFresh(state: PanelState, form: FormState = FRESH_FORM): void {
  assert.deepEqual(state.form, form);
  assert.equal(state.workItemId, undefined);
  assert.equal(state.primary.action, "run");
  assert.equal(state.primary.label, "Run");
  assert.equal(state.primary.busy, false);
  assert.deepEqual(state.primary.more, [], "a next step was offered on a fresh session");
  assert.equal(state.progress.state, "idle");
  assert.equal(state.artifacts.kind, "empty");
  assert.equal(state.preparedFixMode, undefined);
  assert.deepEqual(state.problems, []);
  assert.equal(state.runError, undefined);
  assert.equal(state.sessionFeedback, undefined);
  assert.deepEqual(state.workItemActions, []);
  assert.equal(state.hintImprovement?.suggestion, undefined);
  assert.equal(state.hintImprovement?.busy, false);
  for (const step of state.workflow) {
    assert.equal(step.status, "idle", `${step.id} kept a status`);
    assert.equal(step.artifact, undefined, `${step.id} kept an artifact`);
    assert.equal(step.error, undefined, `${step.id} kept a failure`);
    assert.equal(step.detail, undefined, `${step.id} kept a detail line`);
  }
  assert.equal(state.workflow.some((step) => step.id === "fixResult"), false, "the Fix result row survived");
  assert.deepEqual([...(codeRow(state).search?.files ?? [])], [], "Relevant Files survived");
  assert.equal(stepOf(state, "gitHistory").gitHistory, undefined, "the Git History result survived");
  assert.equal(state.sessionReset.busy, false);
  assert.equal(state.sessionReset.workItemId, undefined);
}

test("reset 1: Keep puts every session field back, keeps the AI Agent, detaches the work item, deletes nothing", async () => {
  const deletes: string[] = [];
  const h = harness({
    ...WITH_FILES,
    fixModes: CATALOG,
    deleteArtifacts: async (_root, id) => {
      deletes.push(id);
      return { kind: "deleted" };
    },
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  // Prepared, with results on the rows and the work item bound.
  assert.equal(h.last().primary.action, "fixWithAI");
  assert.equal(h.last().workItemId, "JR-12345");
  assert.ok((codeRow(h.last()).search?.files ?? []).length > 0);
  assert.equal(h.last().sessionReset.workItemId, "JR-12345", "Delete would have nothing to act on");
  // Then stale: a plan change, the Fix with AI box and Fresh.
  await h.controller.handle(
    applySettings(SESSION_FORM({ fixWithAI: true, fresh: true, plan: { ...DEFAULT_FORM.plan, similarFixes: false } })),
  );
  assert.equal(h.last().primary.action, "rebuildContext");
  const revision = h.last().revision;
  const refreshes = h.refreshes.count;

  await h.controller.handle(RESET_KEEP);

  const after = h.last();
  assert.ok(after.revision > revision, "the page was not told to replace its form");
  assertFresh(after);
  // Persisted: the fresh form, and no work item to reopen after a restart.
  assert.deepEqual(h.saved.at(-1), FRESH_FORM);
  assert.equal(h.savedWorkItems.at(-1), undefined);
  assert.ok(h.savedWorkItems.length >= 2, "the reset never told the host to forget the work item");
  // Keep deletes nothing; the trees are read again, History with them.
  assert.deepEqual(deletes, []);
  assert.ok(h.refreshes.count > refreshes, "the Artifacts and History views were not refreshed");
  assert.ok(h.notices.some((notice) => notice.kind === "info" && notice.message === "Session reset."));
  assert.ok(h.logged.includes("Session reset."), h.logged.join("\n"));
  // Nothing typed reaches the log.
  for (const secret of ["SECRET_HINT_9917", "SECRET_KEYWORD_4403", "SECRET_SIMILAR_KEYWORD_7731"]) {
    assert.equal(h.logged.some((line) => line.includes(secret)), false, `${secret} reached the log`);
  }
  // The Similar Fixes Settings came back to theirs (§37.113): shared Keywords
  // on, no keywords of its own, the default count.
  assert.equal(h.saved.at(-1)?.similarUseSharedKeywords, true);
  assert.equal(h.saved.at(-1)?.similarKeywords, "");
  assert.equal(h.saved.at(-1)?.similarMaxFixes, "");
});

test("reset 2: the next Run after a reset prepares from the fresh form, with no old flag", async () => {
  const h = harness({ ...WITH_FILES, fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  await h.controller.handle(RESET_KEEP);

  await h.controller.handle(next("run", { ...FRESH_FORM, issueKey: "JR-777" }));

  const args = h.streamRuns.at(-1)!.args;
  assert.deepEqual(args.slice(0, 2), ["bug", "JR-777"]);
  for (const gone of ["--hint", "--keywords", "--focus-file", "--ignore-path", "--max-files", "--attach=", "--git-"]) {
    assert.equal(args.some((arg) => arg.startsWith(gone)), false, `${gone} survived the reset: ${args.join(" ")}`);
  }
  assert.ok(args.includes("--fix-mode=standard"));
  assert.ok(args.includes("--resume"), "Fresh survived the reset");
});

test("reset 3: a restart after a reset opens the fresh form, and the AI Agent is still the developer's", async () => {
  const h = harness({ ...WITH_FILES, fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  await h.controller.handle(RESET_KEEP);

  // What extension.ts restores from: the saved form through restoreForm, and
  // the saved work item — none, so nothing is reopened.
  const saved = restoreForm(h.saved.at(-1));
  assert.deepEqual(saved, FRESH_FORM);
  assert.equal(h.savedWorkItems.at(-1), undefined);
  const restarted = harness({ ...WITH_FILES, fixModes: CATALOG, form: saved });
  await restarted.controller.refreshEnvironment();
  assertFresh(restarted.last());
  assert.equal(restarted.last().form?.agent, "codex-cli");
  assert.equal(restarted.last().form?.agentCommand, "my-agent --prompt {prompt}");
});

test("reset 4: from a typed-but-never-run session, or one already fresh, Reset is a fresh form and nothing else", async () => {
  const h = harness({ fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  await h.controller.handle({
    type: "formChanged",
    form: SESSION_FORM({ issueKey: "", description: "SECRET_DESCRIPTION_31 crash", source: "manual" }),
  });
  await h.controller.handle(RESET_KEEP);
  assertFresh(h.last());
  assert.equal(h.logged.some((line) => line.includes("SECRET_DESCRIPTION_31")), false);
  // Again, on a session already fresh, asking to delete: nothing to delete, said so.
  await h.controller.handle(RESET_DELETE);
  assertFresh(h.last());
  assert.ok(h.notices.some((notice) => notice.message === "Session reset. There were no generated files to delete."));
});

test("reset 5: Delete removes only the current work item's files, through the port, then resets", async () => {
  const deletes: [string, string][] = [];
  const h = harness({
    ...WITH_FILES,
    fixModes: CATALOG,
    deleteArtifacts: async (root, id) => {
      deletes.push([root, id]);
      return { kind: "deleted" };
    },
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));

  await h.controller.handle(RESET_DELETE);

  assert.deepEqual(deletes, [[ROOT, "JR-12345"]], "anything but the current work item was asked for");
  assertFresh(h.last());
  assert.ok(h.notices.some((notice) => notice.message === "Session reset. Generated files deleted."));
  assert.ok(h.logged.includes("Session reset; generated artifacts deleted."), h.logged.join("\n"));
  // No CLI call of its own: no `clean` of another item, no `list`.
  assert.equal(h.jsonRuns.some((run) => run.args[0] === "clean" || run.args[0] === "list"), false);

  // A folder already gone is not an error: the reset says there was nothing.
  const gone = harness({ ...WITH_FILES, fixModes: CATALOG, deleteArtifacts: async () => ({ kind: "missing" }) });
  await gone.controller.refreshEnvironment();
  await gone.controller.handle(next("run", SESSION_FORM()));
  await gone.controller.handle(RESET_DELETE);
  assertFresh(gone.last());
  assert.ok(gone.notices.some((notice) => notice.message === "Session reset. There were no generated files to delete."));
});

test("reset 6: a refused or failed delete resets nothing, says why once, and shows what is on disk", async () => {
  for (const [outcome, logged] of [
    [{ kind: "refused", reason: "link" }, "ERROR Session reset deletion failed: refused (link)."],
    [{ kind: "refused", reason: "outside" }, "ERROR Session reset deletion failed: refused (outside)."],
    [{ kind: "failed", reason: "exit-1" }, "ERROR Session reset deletion failed: exit-1."],
  ] as const) {
    let readsAfter = 0;
    let deleting = false;
    const h = harness({
      ...WITH_FILES,
      fixModes: CATALOG,
      deleteArtifacts: async () => {
        deleting = true;
        return outcome;
      },
      onReadFile: () => {
        if (deleting) readsAfter += 1;
      },
    });
    await h.controller.refreshEnvironment();
    await h.controller.handle(next("run", SESSION_FORM()));
    const before = h.last();
    const savedBefore = h.saved.length;

    await h.controller.handle(RESET_DELETE);

    const after = h.last();
    // Nothing reset: the same form, work item, results and next step.
    assert.deepEqual(after.form, before.form, `${outcome.kind}: the form was reset`);
    assert.equal(after.workItemId, "JR-12345");
    assert.equal(after.primary.action, "fixWithAI");
    assert.ok((codeRow(after).search?.files ?? []).length > 0, "the results went with a delete that did not happen");
    assert.equal(h.saved.length, savedBefore, "a form was saved");
    assert.equal(h.savedWorkItems.includes(undefined), false, "the work item was forgotten");
    // Said once, in the dialog, and never as a success.
    const errors = resetErrors(h);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^Session not reset: /);
    assert.equal(after.sessionReset.error, undefined, "the refusal was sent with every push");
    assert.equal(after.sessionReset.busy, false);
    assert.equal(h.notices.some((notice) => /^Session reset/.test(notice.message)), false);
    assert.ok(h.logged.includes(logged), h.logged.join("\n"));
    // The folder was read again: a half-done delete shows what is left.
    assert.ok(readsAfter > 0, "the folder was not read again after the delete");
  }
});

test("reset 7: Delete where this host cannot delete resets nothing", async () => {
  const h = harness({ ...WITH_FILES, fixModes: CATALOG });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  await h.controller.handle(RESET_DELETE);
  assert.equal(h.last().workItemId, "JR-12345");
  assert.equal(resetErrors(h).length, 1);
  assert.ok(h.logged.includes("ERROR Session reset deletion failed: unsupported."), h.logged.join("\n"));
});

/** A run under way: started and searching, not finished. */
const RUNNING_EVENTS: readonly StreamEvent[] = successfulRun.slice(0, 8);

/**
 * A held run whose ending can be held too: once `holdEnd()` is called, the
 * run's own read of the folder after it stops waits for `releaseEnd()`.
 */
function heldRun(extra: HarnessOptions = {}) {
  let holding = false;
  let release: () => void = () => {};
  const h = harness({
    ...WITH_FILES,
    fixModes: CATALOG,
    events: RUNNING_EVENTS,
    hold: true,
    onReadFile: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    ...extra,
  });
  return {
    h,
    holdEnd: () => void (holding = true),
    releaseEnd: () => {
      holding = false;
      release();
    },
  };
}

test("reset 8: during a run, Reset stops it, waits for it to end, then resets", async () => {
  const { h, holdEnd, releaseEnd } = heldRun();
  await h.controller.refreshEnvironment();
  const running = h.controller.run(SESSION_FORM());
  await tick();
  assert.equal(h.last().progress.state, "running");
  // The dialog says so beforehand.
  assert.deepEqual(h.last().sessionReset.notes, [RESET_STOPS_RUN]);

  holdEnd();
  const resetting = h.controller.handle(RESET_KEEP);
  await tick();
  // Stopped as Stop stops it — and, while it ends, nothing is reset yet and
  // nothing can start.
  assert.equal(h.streamRuns[0]!.options.signal?.aborted, true, "the run was not stopped");
  assert.equal(h.controller.workItemId, "JR-12345", "the session was reset before the run had ended");
  assert.equal(h.last().sessionReset.busy, true);
  assert.equal(h.last().primary.busy, true);
  releaseEnd();
  await resetting;
  await running;
  assertFresh(h.last());
  assert.ok(h.logged.includes("Stopping the bugpilot run: the session is being reset."));
  // Nothing it would have done afterwards happened: no handoff, no terminal.
  assert.deepEqual(h.terminals, []);
});

test("reset 9: no event of the old run reaches the fresh session, however late", async () => {
  let deliver: ((event: StreamEvent) => void) | undefined;
  const h = harness({ ...WITH_FILES, hold: true, onStream: (onEvent) => (deliver = onEvent) });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(jiraForm());
  await tick();
  await h.controller.handle(RESET_KEEP);
  await running;
  const pushes = h.states.length;

  // A process the Runner gave up on, still talking.
  deliver!({ type: "started", work_item_id: "JR-99999", source: "jira" });
  deliver!({ type: "step_completed", step: "code_search" });
  deliver!({ type: "completed", ok: true });

  assert.equal(h.states.length, pushes, "a late event pushed a state");
  assert.equal(h.controller.workItemId, undefined, "a late event bound a work item");
  assertFresh(h.last(), { ...DEFAULT_FORM });
});

test("reset 10: a run still being set up when Reset is pressed never starts, and asks nothing more", async () => {
  let answer: (value: boolean) => void = () => {};
  const h = harness({ ...WITH_FILES, fixModes: CATALOG, confirmAnswer: () => new Promise<boolean>((resolve) => (answer = resolve)) });
  await h.controller.refreshEnvironment();
  // Fresh asks first: the run is pending, with no process yet.
  const running = h.controller.run(SESSION_FORM({ fresh: true }));
  await tick();
  assert.equal(h.confirms.length, 1);

  const resetting = h.controller.handle(RESET_KEEP);
  await tick();
  answer(true);
  await running;
  await resetting;

  assert.equal(h.streamRuns.length, 0, "a run started after the session was reset");
  assertFresh(h.last());
  assert.ok(h.logged.includes("Run not started: the session was reset while it was being set up."));
  // Quietly: the developer chose the reset, so no "wait for the reset" warning.
  assert.equal(h.notices.some((notice) => notice.kind === "warning"), false, JSON.stringify(h.notices));
});

test("reset 11: after a failed run, Reset clears the failure with everything else", async () => {
  const h = harness({
    fixModes: CATALOG,
    events: [
      { type: "started", work_item_id: "JR-12345", source: "jira" },
      { type: "completed", ok: false, error: { code: "JIRA_AUTH_FAILED", message: "401" } },
    ],
  });
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  assert.ok(runErrorOf(h.last()), "the run did not fail");

  await h.controller.handle(RESET_KEEP);

  assertFresh(h.last());
  assert.equal(runErrorOf(h.last()), undefined);
});

test("reset 12: refused while a write that cannot be stopped is in flight — said before and on the press", async () => {
  const hold = held();
  const { h } = capturable({ answer: hold.answer });
  await opened(h);
  const recording = h.controller.recordReview(REVIEW_ENTRY);
  await tick();
  // The dialog knows before the press.
  assert.equal(h.last().sessionReset.blocked, "Wait for the review result recording to finish.");

  await h.controller.handle(RESET_KEEP);

  assert.equal(h.last().workItemId, "JR-12345", "a reset went ahead over a recording");
  assert.deepEqual(resetErrors(h), ["Session not reset. Wait for the review result recording to finish."]);
  hold.resolve(RECORDED);
  await recording;
  assert.equal(h.last().sessionReset.blocked, undefined);
  await h.controller.handle(RESET_KEEP);
  assert.equal(h.last().workItemId, undefined, "the reset was still refused once the recording ended");
});

test("reset 13: refused while a handoff is being worked out — it may open a terminal any moment", async () => {
  let release: (value: boolean) => void = () => {};
  const h = await preparedHarness({ agentProbe: () => new Promise<boolean>((resolve) => (release = resolve)) });
  const handing = h.controller.handle(next("fixWithAI"));
  await tick();
  assert.equal(h.last().sessionReset.blocked, RESET_WAITS_FOR_HANDOFF);

  await h.controller.handle(RESET_KEEP);

  assert.equal(h.last().workItemId, "JR-12345");
  assert.deepEqual(resetErrors(h), [`Session not reset. ${RESET_WAITS_FOR_HANDOFF}`]);
  release(true);
  await handing;
});

test("reset 14: a captured AI review is cancelled, waited for, and not counted as an attempt", async () => {
  const r = heldReview();
  const h = await openedForReview(r.options);
  const reviewing = h.controller.handle(REVIEW);
  await tick();
  r.start();
  assert.equal(reviewOf(h.last())?.state, "reviewing");
  assert.ok(h.last().sessionReset.notes.includes(RESET_CANCELS_REVIEW));
  assert.equal(h.last().sessionReset.blocked, undefined, "a review BugPilot can stop blocked the reset");

  await h.controller.handle(RESET_KEEP);
  await reviewing;

  assert.deepEqual(r.aborts, [1], "the review process was not ended");
  assert.equal(r.store.size, 0, "the abandoned review still counts as this fix's attempt");
  // Cancel Review's own question is not asked again: the dialog said it.
  assert.deepEqual(h.confirms, []);
  assert.equal(h.controller.workItemId, undefined);
  assert.equal(fixResultOf(h.last()), undefined);
});

test("reset 15: an agent already handed the work item is said to keep running; Keep keeps its session, Delete drops it", async () => {
  for (const deleting of [false, true]) {
    const h = await attemptedHarness({ deleteArtifacts: async () => ({ kind: "deleted" }) });
    assert.ok(h.last().sessionReset.notes.includes(RESET_LEAVES_AGENT));
    await h.controller.handle(deleting ? RESET_DELETE : RESET_KEEP);
    assert.equal(h.controller.workItemId, undefined);
    // Back to the same work item: its terminal is still the one to reopen,
    // unless the files the agent was given were deleted.
    await h.controller.handle(next("run"));
    assert.equal(h.last().primary.action, deleting ? "fixWithAI" : "openSession", `deleting: ${deleting}`);
  }
});

test("reset 16: Keep saves unsaved verification evidence first, or asks; Delete does not save into a folder it deletes", async () => {
  const keep = await autosaving({});
  await keep.draft([check("Unit tests")]);
  await keep.h.controller.handle(RESET_KEEP);
  assert.equal(keep.calls.length, 1, "Keep dropped an unsaved verification form");
  assert.equal(keep.h.controller.workItemId, undefined);

  const asked = await autosaving({
    confirm: false,
    answer: async () => ({ ok: false, command: "record-verification", error: { code: "INTERNAL_ERROR", message: "locked" } }),
  });
  await asked.draft([check("Unit tests")]);
  await asked.h.controller.handle(RESET_KEEP);
  assert.match(asked.h.confirms.at(-1)?.message ?? "", /could not be saved\. Reset the session anyway\? They will be lost\./);
  assert.equal(asked.h.confirms.at(-1)?.keepLabel, "Keep Editing");
  assert.equal(asked.h.controller.workItemId, "JR-12345", "Keep Editing still reset the session");
  assert.equal(asked.h.last().sessionReset.busy, false);
});

test("reset 17: a hint improvement, a work item being opened, or a folder being read land on nothing after a reset", async () => {
  // The hint: its answer is about a hint the fresh session does not have.
  let improve: (value: { ok: true; text: string }) => void = () => {};
  const hint = harness({ agentOnPath: true, improveHint: () => new Promise((resolve) => (improve = resolve)) });
  await hint.controller.refreshEnvironment();
  const improving = hint.controller.improveHint(jiraForm({ hint: "look at it", useIssueDetails: false }));
  await tick();
  assert.equal(hint.last().hintImprovement?.busy, true);
  await hint.controller.handle(RESET_KEEP);
  assert.equal(hint.last().hintImprovement?.busy, false);
  improve({ ok: true, text: "Improved." });
  await improving;
  assert.equal(hint.last().hintImprovement?.suggestion, undefined, "the old hint's suggestion reached the fresh session");

  // A work item being opened from History when the reset happened.
  let releaseStatus: () => void = () => {};
  let holdStatus = true;
  const opening = harness({
    directory: PREPARED_FILES,
    files: { "run.json": PREPARED_RUN_JSON },
    onReadFile: (file) =>
      holdStatus && file.endsWith("run.json") ? new Promise<void>((resolve) => (releaseStatus = resolve)) : undefined,
  });
  await opening.controller.refreshEnvironment();
  const shown = opening.controller.showWorkItem("JR-12345");
  await tick();
  holdStatus = false;
  await opening.controller.handle(RESET_KEEP);
  releaseStatus();
  await shown;
  assert.equal(opening.controller.workItemId, undefined, "the opened work item came back after the reset");
  assert.equal(opening.savedWorkItems.at(-1), undefined);
  assert.equal(opening.last().progress.state, "idle");

  // A refresh of the folder, mid-read.
  let releaseRead: () => void = () => {};
  let holdRead = false;
  const reading = harness({
    ...WITH_FILES,
    onReadFile: (file) =>
      holdRead && file.endsWith("retrieval.json") ? new Promise<void>((resolve) => (releaseRead = resolve)) : undefined,
  });
  await reading.controller.refreshEnvironment();
  await reading.controller.handle(next("run"));
  holdRead = true;
  const refresh = reading.controller.refreshActiveWorkItem();
  await tick();
  holdRead = false;
  await reading.controller.handle(RESET_KEEP);
  const pushes = reading.states.length;
  releaseRead();
  await refresh;
  // Not even a push: what it read is not projected anywhere, shown or not.
  assert.equal(reading.states.length, pushes, "a read from before the reset was projected");
  assertFresh(reading.last(), { ...DEFAULT_FORM });
});

test("reset 18: a second press while one is under way does nothing, and nothing else starts meanwhile", async () => {
  const { h, holdEnd, releaseEnd } = heldRun();
  await h.controller.refreshEnvironment();
  const running = h.controller.run(SESSION_FORM());
  await tick();
  holdEnd();
  const first = h.controller.handle(RESET_KEEP);
  await tick();
  assert.equal(h.last().sessionReset.busy, true);
  assert.equal(h.last().primary.busy, true, "something could be started under the reset");
  await h.controller.handle(RESET_DELETE);
  assert.ok(h.logged.includes("ERROR Refusing a second Reset Session while one is in progress."));
  // A run asked for meanwhile waits; it does not start.
  await h.controller.run(jiraForm({ issueKey: "JR-2" }));
  assert.equal(h.streamRuns.length, 1);
  releaseEnd();
  await first;
  await running;
  assertFresh(h.last());
  assert.equal(h.notices.filter((notice) => /^Session reset/.test(notice.message)).length, 1);
});

test("reset 19: the message carries one explicit choice, and nothing else", () => {
  assert.deepEqual(parsePanelMessage({ type: "resetSession", deleteGeneratedFiles: false }), RESET_KEEP);
  assert.deepEqual(parsePanelMessage({ type: "resetSession", deleteGeneratedFiles: true }), RESET_DELETE);
  // No choice, or one that is not a boolean, is no message: never read as Delete.
  for (const raw of [
    { type: "resetSession" },
    { type: "resetSession", deleteGeneratedFiles: "true" },
    { type: "resetSession", deleteGeneratedFiles: 1 },
    { type: "resetSession", deleteGeneratedFiles: null },
  ]) {
    assert.equal(parsePanelMessage(raw), undefined, JSON.stringify(raw));
  }
  // A path or a work item from the page is not carried.
  assert.deepEqual(parsePanelMessage({ type: "resetSession", deleteGeneratedFiles: true, workItemId: "JR-1", path: "/etc" }), RESET_DELETE);
});

test("reset 20: a run that finishes as Reset is pressed hands nothing to an agent", async () => {
  // The run completed — Fix with AI ticked, an agent on PATH — and is still
  // reading its folder when the reset arrives: no terminal, no clipboard.
  const { h, holdEnd, releaseEnd } = heldRun({ events: successfulRun, agentOnPath: true });
  await h.controller.refreshEnvironment();
  const running = h.controller.run(SESSION_FORM({ fixWithAI: true }));
  await tick();
  holdEnd();
  const resetting = h.controller.handle(RESET_KEEP);
  await tick();
  releaseEnd();
  await resetting;
  await running;
  assert.deepEqual(h.terminals, [], "an agent was started for a session being reset");
  assert.deepEqual(h.clipboard, []);
  assertFresh(h.last());
});

// --- Results: the one tree follows the controller (§37.106) ----------------------

/**
 * The Results tree as activation wires it, over this harness's controller:
 * Current from `controller.artifacts`, its row named by `controller.workItemId`.
 * History is `bugpilot list`, which the host runs, so here it lists `folders` —
 * the work item folders on disk, which a Delete reset takes one from.
 */
function resultsOver(h: Harness, folders: ReadonlySet<string>) {
  const sources: ResultsSources = {
    artifacts: () => h.controller.artifacts,
    history: async () =>
      historyFromPayload({ ok: true, work_items: [...folders].map((id) => ({ work_item_id: id, prepared: true })) }),
    diagnostics: () => h.controller.diagnostics,
    now: () => 0,
  };
  const label = (node: ResultsNode) => resultsItem(node, h.controller.workItemId).label;
  return {
    root: async () => (await resultsChildren(undefined, sources)).map(label),
    current: async () => (await resultsChildren(CURRENT_GROUP, sources)).map(label),
    currentRow: () => resultsItem(CURRENT_GROUP, h.controller.workItemId),
    history: async () => (await resultsChildren(HISTORY_GROUP, sources)).map(label),
    diagnostics: async () =>
      (await resultsChildren(DIAGNOSTICS_GROUP, sources)).map((node) => {
        const item = resultsItem(node, h.controller.workItemId);
        return `${item.label}: ${item.description}`;
      }),
  };
}

/** Two work items on disk; deleting one through the port takes its folder away. */
function resultsHarness() {
  const folders = new Set(["JR-12345", "JR-1"]);
  const deletes: string[] = [];
  const h = harness({
    ...WITH_FILES,
    fixModes: CATALOG,
    deleteArtifacts: async (_root, id) => {
      deletes.push(id);
      folders.delete(id);
      return { kind: "deleted" };
    },
  });
  return { h, folders, deletes, tree: resultsOver(h, folders) };
}

/** Every canonical file, as WITH_FILES's folder lists them, in the Artifacts order. */
const CURRENT_FILES = [
  "issue.json",
  "context.md",
  "task.md",
  "fix_report.md",
  "review_report.md",
  "verification_report.md",
  "retrieval.json",
  "run.json",
];
const NOTHING_OPEN = ["No work item selected yet."];

test("Results 1: nothing open, Current says so; a run fills it with the work item's files and names it", async () => {
  const { h, tree } = resultsHarness();
  await h.controller.refreshEnvironment();
  assert.deepEqual(await tree.root(), ["Current", "History", "Diagnostics"]);
  assert.deepEqual(await tree.current(), NOTHING_OPEN);
  assert.equal(tree.currentRow().description, undefined);

  const refreshes = h.refreshes.count;
  await h.controller.handle(next("run", SESSION_FORM()));

  assert.ok(h.refreshes.count > refreshes, "Results was not told the run changed .ai/");
  assert.deepEqual(await tree.current(), CURRENT_FILES);
  assert.equal(tree.currentRow().description, "JR-12345");
  assert.deepEqual(await tree.root(), ["Current", "History", "Diagnostics"]);
});

test("Results 2: Reset Keep empties Current and leaves History as it was", async () => {
  const { h, tree, deletes } = resultsHarness();
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  const history = await tree.history();
  const refreshes = h.refreshes.count;

  await h.controller.handle(RESET_KEEP);

  assert.ok(h.refreshes.count > refreshes, "Results was not refreshed after the reset");
  assert.deepEqual(await tree.current(), NOTHING_OPEN);
  assert.equal(tree.currentRow().description, undefined);
  assert.deepEqual(deletes, []);
  assert.deepEqual(await tree.history(), history);
  assert.ok(history.includes("JR-12345"), history.join());
});

test("Results 3: Reset Delete empties Current; History loses that work item and only that one", async () => {
  const { h, tree, deletes } = resultsHarness();
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  const refreshes = h.refreshes.count;

  await h.controller.handle(RESET_DELETE);

  assert.ok(h.refreshes.count > refreshes, "Results was not refreshed after the reset");
  assert.deepEqual(deletes, ["JR-12345"]);
  assert.deepEqual(await tree.current(), NOTHING_OPEN);
  assert.deepEqual(await tree.history(), ["JR-1"], "History was cleared beyond the deleted work item");
});

test("Results 4: reopening a work item from History fills Current again — once, and named for it", async () => {
  const { h, tree } = resultsHarness();
  await h.controller.refreshEnvironment();
  await h.controller.handle(next("run", SESSION_FORM()));
  await h.controller.handle(RESET_KEEP);
  const refreshes = h.refreshes.count;

  await h.controller.showWorkItem("JR-12345");

  assert.ok(h.refreshes.count > refreshes, "Results was not told about the work item just opened");
  assert.deepEqual(await tree.current(), CURRENT_FILES);
  assert.equal(tree.currentRow().description, "JR-12345");

  // Another one: Current follows it, and nothing of the first is left over.
  await h.controller.showWorkItem("JR-1");
  const current = await tree.current();
  assert.deepEqual(current, CURRENT_FILES);
  assert.equal(new Set(current).size, current.length, "a file is listed twice");
  assert.equal(tree.currentRow().description, "JR-1");
  assert.deepEqual(await tree.root(), ["Current", "History", "Diagnostics"]);
});
