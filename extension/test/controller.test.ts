import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Controller } from "../src/app/controller.ts";
import type { ControllerPorts, RunOptions } from "../src/app/controller.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import type { Environment } from "../src/app/environment.ts";
import type { Envelope, StreamEvent } from "../src/protocol.ts";
import type { PanelState } from "../src/panel/messages.ts";

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
  readonly last: () => PanelState;
}

interface HarnessOptions {
  readonly events?: readonly StreamEvent[];
  readonly terminated?: boolean;
  readonly aborted?: boolean;
  readonly foreignVersion?: number;
  readonly stderr?: string;
  readonly streamThrows?: Error;
  readonly json?: Envelope | (() => Envelope);
  readonly jsonThrows?: Error;
  readonly environment?: Environment;
  readonly files?: Record<string, string>;
  readonly directory?: readonly string[];
  /** Make the artifact directory unreadable rather than absent. */
  readonly directoryError?: string;
  readonly confirm?: boolean;
  readonly form?: FormState;
  /** Hold the stream open so a Stop can be observed mid-run. */
  readonly hold?: boolean;
  /** Whether an agent CLI can be started, and whether an agent panel can be revealed. */
  readonly agentOnPath?: boolean;
  readonly agentPanel?: boolean;
  /** What the file dialog returns when the panel asks for attachments. */
  readonly pickFiles?: readonly string[];
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
  let release = () => {};

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
        const key = Object.keys(options.files ?? {}).find((name) => file.endsWith(name));
        return key ? options.files![key] : undefined;
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
        terminals.push({ name, cwd, commandLine });
      },
      openFolder: async (directory) => {
        folders.push(directory);
      },
      pickFiles: async () => options.pickFiles ?? [],
      revealAgentPanel: async () => options.agentPanel ?? false,
    },
    log: {
      info: (message) => logged.push(message),
      error: (message) => logged.push(`ERROR ${message}`),
    },
    environment: async () => options.environment ?? READY,
    credentials: async () => ({
      configured: true,
      environment: { JIRA_EMAIL: "me@co.com", JIRA_TOKEN: TOKEN },
    }),
    descriptionFilePath: () => "/tmp/bugpilot-description.md",
    canRun: async (command) => {
      probed.push(command);
      return options.agentOnPath ?? false;
    },
    now: () => 1_000,
    saveForm: (form) => saved.push(form),
    saveWorkItem: (workItemId) => savedWorkItems.push(workItemId),
  };

  const controller = new Controller(ports, options.form ?? DEFAULT_FORM);
  return {
    controller,
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

const successfulRun: readonly StreamEvent[] = [
  { type: "started", work_item_id: "JR-12345", source: "jira" },
  { type: "step_started", step: "fetch" },
  { type: "step_completed", step: "fetch" },
  { type: "step_started", step: "code_search" },
  { type: "step_completed", step: "code_search" },
  { type: "artifact", path: ".ai/JR-12345/agent_task.md" },
  { type: "completed", ok: true },
];

// --- running ---------------------------------------------------------------

test("a valid run streams, finishes, and refreshes what the editor shows", async () => {
  const h = harness({ events: successfulRun, directory: ["agent_task.md", "bug_context.md"] });
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
    directory: ["agent_task.md"],
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
  const h = harness({ events: successfulRun, directory: ["agent_task.md"] });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.openArtifact("agent_task.md");

  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0]!, /JR-12345[\\/]agent_task\.md$/);
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
  await h.controller.openArtifact("agent_task.md");
  assert.equal(h.opened.length, 0);
  assert.equal(h.notices.at(-1)?.kind, "warning");
});

test("the handoff prompt comes from the artifact, or from a fallback that works", async () => {
  const withFile = harness({
    events: successfulRun,
    files: { "agent_handoff.md": "Read .ai/JR-12345/agent_task.md and fix the bug.\n" },
  });
  await withFile.controller.refreshEnvironment();
  await withFile.controller.run(jiraForm());
  await withFile.controller.copyHandoff();
  assert.equal(withFile.clipboard[0], "Read .ai/JR-12345/agent_task.md and fix the bug.");

  const without = harness({ events: successfulRun });
  await without.controller.refreshEnvironment();
  await without.controller.run(jiraForm());
  await without.controller.copyHandoff();
  // Copying nothing would look like the button was broken.
  assert.match(without.clipboard[0] ?? "", /agent_task\.md/);
});

// --- reopening a past work item -------------------------------------------

test("a past work item is restored from workflow_status.json", async () => {
  const h = harness({
    files: {
      "workflow_status.json": JSON.stringify({
        steps: { parse: "pass", code_search: "pass", git_context: "skipped" },
      }),
    },
    directory: ["agent_task.md", "workflow_status.json"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.showWorkItem("JR-999");

  assert.equal(h.last().workItemId, "JR-999");
  assert.equal(h.last().progress.state, "done");
  assert.equal(h.last().artifacts.kind, "ready");
});

test("a corrupt status file still lists the artifacts", async () => {
  const h = harness({
    files: { "workflow_status.json": "{ truncated" },
    directory: ["agent_task.md"],
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
  const h = harness({ events: successfulRun, directory: ["agent_task.md"] });
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
  // The event stream dies with the process; workflow_status.json is the only
  // record that survives it, and reading that needs the id.
  const h = harness({
    events: [
      { type: "started", work_item_id: "local_20260904160612", source: "manual" },
      { type: "completed", ok: true },
    ],
    directory: ["agent_task.md"],
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
  const h = harness({ events: successfulRun, directory: ["agent_task.md"] });
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

  const finished = harness({ events: successfulRun, directory: ["agent_task.md"] });
  await finished.controller.refreshEnvironment();
  await finished.controller.run(jiraForm());
  assert.equal(finished.last().canRetry, true);
});

test("starting a hand-written run drops the previous item's artifact list", async () => {
  // The new id only arrives with the `started` event. Leaving the old list on
  // screen offers files that openArtifact then refuses to open.
  const h = harness({ hold: true, events: [], directory: ["agent_task.md"] });
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
    directory: ["agent_task.md"],
    json: { ok: true, command: "bug", warnings: [], retry: true, feedback_created: false },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.retry();

  assert.ok(h.opened.at(-1)?.endsWith("agent_retry_prompt.md"), h.opened.at(-1));
});

test("clicking a history item during a run says why nothing happened", async () => {
  const h = harness({ hold: true, events: successfulRun, directory: ["agent_task.md"] });
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
  // Four places tell an agent to read agent_task.md: the CLI's launch prompt,
  // the MCP prompt, the Claude Code skill, and this fallback. The first three
  // are rendered from bugpilot/core/handoff.py; this one is a TypeScript
  // string, so it is compared against that source the same way the error-code
  // table is.
  const source = readFileSync(new URL("../../bugpilot/core/handoff.py", import.meta.url), "utf8");
  const template = /return f"(Read \.ai\/\{issue_key\}\/[^"]+)"/.exec(source);
  assert.ok(template, "could not find handoff_prompt's text in handoff.py");
  const expected = template[1]!.replace("{issue_key}", "JR-12345");

  const h = harness({ events: successfulRun, directory: ["agent_task.md"] });
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
  // agent_task.md insists on this: "Do not run your AI agent from the bugpilot
  // tool source directory". The cwd is the whole point of the terminal.
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md"],
    agentOnPath: true,
    files: { "agent_handoff.md": "Read .ai/JR-12345/agent_task.md and complete the workflow.\n" },
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
    'claude "Read .ai/JR-12345/agent_task.md and complete the workflow."',
  );
});

test("ticking Fix with AI runs it as the last step, without a second click", async () => {
  // The whole point of the row: Run means run everything that is ticked.
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md"],
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
    directory: ["agent_task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  assert.deepEqual(h.terminals, [], "no agent may start without being asked for");
  // And nothing was even probed: asking "is claude installed" when the answer
  // cannot be used is a spawn for nothing.
  assert.deepEqual(h.probed, []);
  assert.equal(h.last().overall.text, "Context ready");
  assert.equal(h.last().workflow.find((step) => step.id === "fixWithAI")?.status, "idle");
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
  assert.match(fix?.detail ?? "", /did not finish/);
});

test("with Build context off, the AI step is not offered at all", async () => {
  // `--only-issue-details` writes no package, so there is nothing to hand over.
  const h = harness({ events: successfulRun, directory: ["agent_task.md"], agentOnPath: true });
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
    directory: ["agent_task.md"],
    agentOnPath: false,
    agentPanel: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.fixWithAI();

  assert.deepEqual(h.terminals, []);
  assert.match(h.clipboard[0] ?? "", /agent_task\.md/);
  assert.match(h.notices.at(-1)?.message ?? "", /clipboard/);
  const fix = h.last().workflow.find((step) => step.id === "fixWithAI");
  // Skipped, not failed: nothing went wrong, the handoff just took another
  // route — and the row has to say which.
  assert.equal(fix?.status, "skipped");
  assert.match(fix?.detail ?? "", /not on PATH/);
  assert.match(fix?.detail ?? "", /clipboard/);
});

test("a custom agent command is used verbatim, with the prompt substituted", async () => {
  // The escape hatch for Codex, Gemini or an in-house CLI: nobody here knows
  // their flags, and a guessed command line fails in a terminal.
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md"],
    agentOnPath: true,
    files: { "agent_handoff.md": "Fix JR-12345.\n" },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(
    withFix({ agent: "custom", agentCommand: "my-agent --yolo --prompt {prompt}" }),
  );

  assert.equal(h.terminals[0]!.commandLine, 'my-agent --yolo --prompt "Fix JR-12345."');
  // Probed by its own first word, not by "claude".
  assert.deepEqual(h.probed, ["my-agent"]);
});

test("a custom choice with no command explains itself instead of running nothing", async () => {
  const h = harness({ events: successfulRun, directory: ["agent_task.md"], agentOnPath: true });
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

test("the handed-over sentence is the same one Copy puts on the clipboard", async () => {
  // Four entry points say this; a fifth wording would be a fifth thing to drift.
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md"],
    agentOnPath: true,
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.copyHandoff();
  await h.controller.fixWithAI();

  assert.equal(h.terminals[0]!.commandLine, `claude ${JSON.stringify(h.clipboard[0])}`);
});

test("a multi-line handoff still reaches the agent as one argument", async () => {
  // A raw newline inside a quoted argument is submitted by the terminal as a
  // second command, which turns a handoff prompt into a shell invocation.
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md"],
    agentOnPath: true,
    files: { "agent_handoff.md": "Read the task.\n\nThen fix it.\n" },
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());
  await h.controller.fixWithAI();

  assert.equal(h.terminals[0]!.commandLine, 'claude "Read the task. Then fix it."');
  assert.equal(h.terminals[0]!.commandLine.includes("\n"), false);
});

// --- the row actions --------------------------------------------------------

test("the Build context icons open the context, copy the prompt and reveal the folder", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md", "bug_context.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  await h.controller.handle({ type: "action", id: "openContext" });
  assert.match(h.opened.at(-1) ?? "", /bug_context\.md$/);

  await h.controller.handle({ type: "action", id: "copyHandoff" });
  assert.match(h.clipboard.at(-1) ?? "", /agent_task\.md/);

  await h.controller.handle({ type: "action", id: "openFolder" });
  assert.match(h.folders.at(-1) ?? "", /JR-12345$/);
});

test("the icons are offered only once the files they open exist", async () => {
  const h = harness({
    events: successfulRun,
    directory: ["agent_task.md", "bug_context.md"],
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
    "copyHandoff",
    "openFolder",
  ]);
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
  // The case this exists for: three files picked, two copied. Without this the
  // only record is execution.log, which is not where anybody looks.
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
    directory: ["agent_task.md"],
  });
  await h.controller.refreshEnvironment();
  await h.controller.run(jiraForm());

  const warning = h.notices.find((notice) => notice.kind === "warning");
  assert.ok(warning, "the run warning was swallowed");
  assert.match(warning.message, /Attachment not added/);
});
