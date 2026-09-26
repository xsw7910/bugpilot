import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { COMMANDS } from "../src/commands.ts";

import { Controller } from "../src/app/controller.ts";
import type { ControllerPorts, RunOptions } from "../src/app/controller.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import type { Environment } from "../src/app/environment.ts";
import type { Envelope, StreamEvent } from "../src/protocol.ts";
import type { PanelMessage, PanelState } from "../src/panel/messages.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";
import { fixModesFromPayload, managedFixModesFromPayload } from "../src/app/fixModes.ts";
import type { FixModeCatalog, ManagedFixModes } from "../src/app/fixModes.ts";
import type { FixModeRequest } from "../src/app/controller.ts";

import type { WorkflowStepId, WorkflowStepResult } from "../src/app/workflow.ts";
import type { UserFacingError } from "../src/app/failures.ts";

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
const reportsContext = (state: PanelState) => buildRow(state).summary === "Context ready";
/** Fix with AI offers its button. */
const canFix = (state: PanelState) => fixRow(state).actions.includes("fixWithAI");
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
  readonly ranCommands: string[];
  readonly terminals: { name: string; cwd: string; commandLine: string }[];
  readonly folders: string[];
  /** Which executables `canRun` was asked about, in order. */
  readonly probed: string[];
  readonly saved: FormState[];
  readonly savedWorkItems: string[];
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
  readonly environment?: Environment;
  readonly files?: Record<string, string>;
  readonly directory?: readonly string[];
  /** Make the artifact directory unreadable rather than absent. */
  readonly directoryError?: string;
  /** Called for every file the controller reads, so a test can count them — or, returning a promise, hold a read open. */
  readonly onReadFile?: (file: string) => unknown;
  /** Whether a Jira credential is stored. Configured unless a test says not. */
  readonly credentialsConfigured?: boolean;
  /** This extension's own version, which is not the CLI's. */
  readonly extensionVersion?: string;
  readonly confirm?: boolean;
  readonly form?: FormState;
  /** Hold the stream open so a Stop can be observed mid-run. */
  readonly hold?: boolean;
  /** Whether an agent CLI can be started, and whether an agent panel can be revealed. */
  readonly agentOnPath?: boolean;
  readonly agentPanel?: boolean;
  /** What the file dialog returns when the panel asks for attachments. */
  readonly pickFiles?: readonly string[];
  /** The Fix Mode catalog discovery returns; absent means no discovery port. */
  readonly fixModes?: FixModeCatalog;
  /** Every physical definition, for the management view. */
  readonly managed?: ManagedFixModes;
  /** What a Fix Mode management command does, and what it answers. */
  readonly runFixMode?: (request: FixModeRequest) => Promise<Envelope>;
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
  /** Answer `revealAgentPanel` instead of `agentPanel`: a function may answer later. */
  readonly revealAgent?: () => Promise<boolean>;
  /** Hold a clipboard write open until the promise settles. */
  readonly clipboardHold?: () => Promise<void>;
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
  const saved: FormState[] = [];
  const savedWorkItems: string[] = [];
  const ranCommands: string[] = [];
  const terminals: { name: string; cwd: string; commandLine: string }[] = [];
  const folders: string[] = [];
  const probed: string[] = [];
  const fixModeCalls = { count: 0 };
  const files: Record<string, string> = { ...(options.files ?? {}) };
  let release = () => {};

  const hintPrompts: string[] = [];
  const issueLookups: string[] = [];
  const ports: ControllerPorts = {
    runner: {
      runStreaming: async (args, runOptions, onEvent) => {
        streamRuns.push({ args, options: runOptions });
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
      confirm: async () => options.confirm ?? true,
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
      },
      openFolder: async (directory) => {
        folders.push(directory);
      },
      pickFiles: async () => options.pickFiles ?? [],
      revealAgentPanel: async () => (options.revealAgent ? options.revealAgent() : (options.agentPanel ?? false)),
    },
    log: {
      info: (message) => logged.push(message),
      error: (message) => logged.push(`ERROR ${message}`),
    },
    environment: async () => options.environment ?? READY,
    credentials: async () => ({
      configured: options.credentialsConfigured ?? true,
      environment: { JIRA_EMAIL: "me@example.com", JIRA_TOKEN: TOKEN },
    }),
    descriptionFilePath: () => "/tmp/bugpilot-description.md",
    ...(options.extensionVersion === undefined
      ? {}
      : { extensionVersion: options.extensionVersion }),
    canRun: async (command) => {
      probed.push(command);
      if (options.agentProbe) return options.agentProbe(command);
      return options.agentOnPath ?? false;
    },
    now: () => 1_000,
    saveForm: (form) => saved.push(form),
    saveWorkItem: (workItemId) => savedWorkItems.push(workItemId),
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
    states,
    streamRuns,
    jsonRuns,
    written,
    opened,
    clipboard,
    notices,
    logged,
    refreshes,
    ranCommands,
    terminals,
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
  await h.controller.run(jiraForm());

  assert.equal(h.streamRuns.length, 1);
  assert.deepEqual(h.streamRuns[0]!.args.slice(0, 2), ["bug", "JR-12345"]);
  assert.equal(h.streamRuns[0]!.options.cwd, ROOT);
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().artifacts.kind, "ready");
  assert.equal(h.refreshes.count, 1, "the trees must be re-read after a run changes .ai/");
  assert.equal(h.last().canRetry, true);
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
      openFolder: async () => {},
      pickFiles: async () => [],
      revealAgentPanel: async () => false,
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

test("Retry is offered only when there is a package to retry", async () => {
  // `bug --retry` reads the prepared artifacts. After a run that was stopped
  // before producing any, offering Retry sends the developer into
  // WORK_ITEM_NOT_FOUND.
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
  assert.equal(stopped.last().canRetry, false);

  const finished = harness({ events: successfulRun, directory: ["task.md"] });
  await finished.controller.refreshEnvironment();
  await finished.controller.run(jiraForm());
  assert.equal(finished.last().canRetry, true);
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
      openFolder: async () => {},
      pickFiles: async () => [],
      revealAgentPanel: async () => false,
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
  assert.match(fix?.detail ?? "", /Handed to Claude Code in a terminal/);
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
  assert.equal(h.last().overall.text, "Context ready");
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

test("with Build context off, the AI step is not offered at all", async () => {
  // `--only-issue-details` writes no package, so there is nothing to hand over.
  const h = harness({ events: successfulRun, directory: ["task.md"], agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(
    withFix({ plan: { ...DEFAULT_FORM.plan, buildContext: false } }),
  );

  assert.deepEqual(h.terminals, []);
  assert.equal(h.last().workflow.find((step) => step.id === "fixWithAI")?.enabled, false);
});

test("without an agent on PATH it copies and points at the panel instead", async () => {
  // A terminal printing "command not found" reads as our bug, not a missing
  // tool, so the fallback never opens one.
  const h = harness({
    events: successfulRun,
    directory: ["task.md"],
    agentOnPath: false,
    agentPanel: true,
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
  assert.match(fix?.detail ?? "", /not on PATH/);
  assert.match(fix?.detail ?? "", /clipboard/);
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
  // --only-issue-details writes a context and no task. A prompt naming a missing
  // file would send the agent looking for it.
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

test("Use Improved takes the suggestion into the hint; Keep Original does not", async () => {
  const h = hintHarness({ improveHint: async () => ({ ok: true, text: "Investigate validation." }) });
  await h.controller.refreshEnvironment();
  await h.controller.handle({ type: "improveHint", form: HINTED });

  await h.controller.handle({ type: "useImprovedHint" });
  assert.equal(h.last().form?.hint, "Investigate validation.");
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
    assert.equal(codeRow(state).summary, "Completed", "a number was invented");
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

  assert.equal(codeRow(h.last()).summary, "Completed");
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
  assert.equal(fixRow(h.last()).summary, "AI fix started");
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
  assert.match(fixRow(after).error?.detail ?? "", /not on PATH/);
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
  assert.equal(fixRow(after).summary, "AI fix started");
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
  assert.equal(fixRow(after).summary, "AI fix started");
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

test("a new run clears the outcome the previous one reached", async () => {
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
  }
  // And the finished run is a fresh package with nothing handed over yet.
  assert.notEqual(fixRow(h.last()).status, "success");
  assert.equal(canFix(h.last()), true);
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

const rowOf = (h: Harness, label: string) =>
  h.last().diagnostics.rows.find((row) => row.label === label);

test("a ready environment reports itself without being asked anything", async () => {
  const h = harness({ extensionVersion: "0.1.0" });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Repository")?.value, "app");
  assert.equal(rowOf(h, "Repository")?.detail, ROOT);
  assert.equal(rowOf(h, "Jira")?.value, "Credentials configured");
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

  assert.ok(h.last().diagnostics.rows.length > 0, "Diagnostics reported nothing");
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
  const text = JSON.stringify(h.last().diagnostics);
  assert.equal(text.includes("abc123"), false, "a custom command reached Diagnostics");
  assert.equal(text.includes("my-agent"), false);
});

test("the resolved agent appears only once a handoff has resolved one", async () => {
  const h = harness({ ...WITH_FILES, agentOnPath: true });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  assert.equal(rowOf(h, "AI agent")?.detail, "Not checked yet");

  await h.controller.handle({ type: "action", id: "fixWithAI" });

  assert.equal(rowOf(h, "AI agent")?.detail, "Resolved: Claude Code");
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
    JSON.stringify(h.last().diagnostics).includes("export dialog"),
    false,
    "the bug's own text reached Diagnostics",
  );
});

test("Jira follows the credential, and claims nothing more", async () => {
  const h = harness({ credentialsConfigured: false });
  await h.controller.refreshEnvironment();

  assert.equal(rowOf(h, "Jira")?.value, "Credentials not configured");
  // Never a claim about Jira itself, which nobody has contacted.
  const text = JSON.stringify(h.last().diagnostics);
  for (const claim of ["Connected", "Healthy", "Online", "Verified"]) {
    assert.equal(text.includes(claim), false, `Diagnostics claims "${claim}"`);
  }
});

test("no credential material is anywhere in the model", async () => {
  const h = harness();
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const text = JSON.stringify(h.last().diagnostics);
  for (const secret of [TOKEN, "JIRA_TOKEN", "JIRA_EMAIL", "me@example.com", "Bearer"]) {
    assert.equal(text.includes(secret), false, `Diagnostics carries ${secret}`);
  }
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
    code.summary !== "Completed"
  );
};

test("a reopened work item's rows name that work item", async () => {
  const { h } = twoWorkItems();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  assert.equal(stepOf(h.last(), "issueDetails").summary, "JR-1 · Jira issue");
  assert.equal(stepOf(h.last(), "issueDetails").detail, "Title of one");
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
  assert.equal(stepOf(h.last(), "issueDetails").summary, "JR-2 · Jira issue");
  assert.equal(stepOf(h.last(), "issueDetails").detail, "Title of two");
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
  assert.equal(row.summary, "Fix report available");
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
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);
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
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);
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

test("reading the folder again forgets a checklist the report may no longer match", async () => {
  const h = reviewable();
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-12345");
  await h.controller.handle({ type: "action", id: "loadValidation" });
  assert.equal(fixResultOf(h.last())?.validation?.state, "ready");

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
  await h.controller.refreshArtifacts();
  answer(REVIEW_PACKAGE);
  await loading;

  // The report may have changed: the list built before the re-read is not shown.
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
  // The agent the form selects (auto: Claude Code), in one terminal, in the
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
    detail: "Handed to Claude Code in a terminal.",
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
  assert.deepEqual(reviewOf(h.last()), { state: "started", summary: "AI review started", detail: "Handed to codex in a terminal." });
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
  const h = await openedForReview(reviewOptions({ agentOnPath: false, agentPanel: true }));
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
  assert.equal(review.error.detail, "claude is not on PATH.");
  assert.deepEqual(review.error.action, { title: "Open Settings", command: COMMANDS.openSettings });
  // No pretend start, no clipboard fallback, no agent panel pushed forward.
  assert.deepEqual(h.clipboard, []);
  assert.equal(h.notices.length, noticesBefore);
  // The row, Fix with AI and the run stand; the button stays for a retry.
  assert.deepEqual([...fixResultOf(h.last())!.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);
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

test("reopened, a work item offers Review with AI again; the last start is not restored", async () => {
  const h = await openedForReview();
  await h.controller.handle(REVIEW);
  assert.equal(reviewOf(h.last())?.state, "started");

  await h.controller.showWorkItem("JR-12345");
  assert.equal(reviewOf(h.last()), undefined, "a transient start came back");
  assert.equal(offersReview(h.last()), true);
  // A second review is an explicit second press, after the reset.
  await h.controller.handle(REVIEW);
  assert.equal(h.terminals.length, 2);
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
  assert.equal(fixRow(h.last()).summary, "AI fix started");
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
  options.directory = [...PREPARED_FILES, "fix_report.md"];
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

test("an agent probe that throws is a failure on the row, not a button left waiting", async () => {
  const h = await openedForReview(reviewOptions({ agentProbe: () => Promise.reject(new Error("spawn EPERM")) }));

  await h.controller.handle(REVIEW);

  const review = reviewOf(h.last());
  assert.equal(review?.state, "failed");
  if (review?.state !== "failed") return;
  assert.equal(review.error.title, "AI review did not start");
  assert.equal(review.error.detail, "spawn EPERM");
  assert.deepEqual(review.error.action, { title: "Open Settings", command: COMMANDS.openSettings });
  assert.equal(offersReview(h.last()), true, "the button did not come back");
  assert.deepEqual(h.terminals, []);
});

// --- Stabilization (§37.70): Fix with AI's stale and double-press guards ---------

const FIX: PanelMessage = { type: "action", id: "fixWithAI" };

/** A probe that answers when the test says so, one resolver per call. */
const heldProbe = () => {
  const answers: ((found: boolean) => void)[] = [];
  return { agentProbe: () => new Promise<boolean>((resolve) => { answers.push(resolve); }), answers };
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
  const h = harness(twoReports(REVIEW_PACKAGE, { agentProbe: probe.agentProbe, agentPanel: true }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  await h.controller.showWorkItem("JR-2");
  const noticesOnB = h.notices.length;
  for (const answer of probe.answers) answer(false);
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
  assert.equal(fixRow(h.last()).summary, "AI fix started");
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

test("with no agent, a switch while the agent panel is being revealed leaves the new work item alone", async () => {
  // The prompt was copied for A — A was on screen then — but by the time the
  // reveal answers, B is: no outcome, card or notice of A's may land on B.
  let reveal: (shown: boolean) => void = () => {};
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentOnPath: false,
    revealAgent: () => new Promise<boolean>((resolve) => { reveal = resolve; }),
  }));
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-1");

  const pressing = h.controller.handle(FIX);
  await settle();
  assert.equal(h.clipboard.length, 1, "the no-agent branch was not reached");
  await h.controller.showWorkItem("JR-2");
  const rowOnB = fixRow(h.last());
  const noticesOnB = h.notices.length;
  reveal(true);
  await pressing;

  assert.deepEqual(fixRow(h.last()), rowOnB, "A's no-agent outcome landed on B");
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

test("with no agent, a switch while the prompt is being copied brings no agent panel forward for it", async () => {
  let release: () => void = () => {};
  const reveals: string[] = [];
  const h = harness(twoReports(REVIEW_PACKAGE, {
    agentOnPath: false,
    clipboardHold: () => new Promise<void>((resolve) => { release = resolve; }),
    revealAgent: async () => {
      reveals.push("revealed");
      return true;
    },
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

  assert.deepEqual(reveals, [], "an agent panel was brought forward for A with B on screen");
  assert.deepEqual(fixRow(h.last()), rowOnB);
  assert.equal(h.notices.length, noticesOnB);
});
