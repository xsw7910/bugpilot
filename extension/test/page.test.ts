/**
 * Behavioural tests for `media/panel.js`.
 *
 * That file was the one part of the extension with no tests at all: it runs in
 * a webview, so `node --test` cannot load it as a module. The gap mattered —
 * three of the phase 5 review findings were in it, and all three were the kind
 * that fails silently in a webview (a stolen focus, a checkbox that stays
 * cleared, a duration rendered as "0.001s").
 *
 * So the page is loaded here with a small DOM stub. The elements come from the
 * real `panelHtml()` output — every `id` in the document becomes an element —
 * which means a renamed id fails these tests the same way it would fail the
 * page, rather than quietly returning null.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { panelHtml } from "../src/panel/html.ts";
import type { PanelState } from "../src/panel/messages.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { buildWorkflow, overallStatus } from "../src/app/workflow.ts";
import type { WorkflowStep } from "../src/app/workflow.ts";
import type { ProgressView } from "../src/app/progress.ts";

const PAGE_SOURCE = readFileSync(new URL("../media/panel.js", import.meta.url), "utf8");

const HTML = panelHtml({
  nonce: "N",
  cspSource: "vscode-webview://x",
  styleUri: "s.css",
  scriptUri: "p.js",
  codiconUri: "c.css",
});

/** Every element id the document declares, so the stub has all of them. */
const IDS = [...HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!);

/**
 * Ids whose markup carries `checked` or `hidden`.
 *
 * The stub starts from the document's own defaults rather than from all-false:
 * the plan checkboxes are ticked in the markup to match `DEFAULT_FORM`, and a
 * stub that ignored that would test a page state that never exists.
 */
const INITIAL = new Map<string, { checked: boolean; hidden: boolean }>(
  [...HTML.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)].map((match) => [
    match[1]!,
    { checked: / checked/.test(match[0]), hidden: / hidden/.test(match[0]) },
  ]),
);

interface Listener {
  (event: unknown): void;
}

class FakeElement {
  readonly id: string;
  name = "";
  hidden = false;
  /** `<details>`: the page opens Advanced settings when a problem is in it. */
  open = false;
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  type = "";
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  focused = false;

  constructor(id: string) {
    this.id = id;
  }

  readonly classList = {
    toggle: (name: string, on: boolean) => {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(" ").filter((item) => item !== "")) this.classes.add(name);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault: () => {}, target: this, ...event });
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  focus(): void {
    page!.focused = this.id;
    this.focused = true;
  }
}

interface Page {
  readonly elements: Map<string, FakeElement>;
  readonly posted: Record<string, unknown>[];
  readonly stored: unknown[];
  focused: string | undefined;
  readonly send: (state: PanelState) => void;
  readonly byId: (id: string) => FakeElement;
  readonly flush: () => void;
}

let page: Page | undefined;

/** Load `media/panel.js` against a fresh stub DOM. */
function load(savedState?: unknown): Page {
  const elements = new Map<string, FakeElement>();
  for (const id of IDS) {
    const element = new FakeElement(id);
    const initial = INITIAL.get(id);
    element.checked = initial?.checked ?? false;
    element.hidden = initial?.hidden ?? false;
    elements.set(id, element);
  }
  // Radios are read by `name` in the change handler.
  elements.get("source-jira")!.name = "source";
  elements.get("source-manual")!.name = "source";
  // The stub has no notion of <option>, so the select's default selection has
  // to be stated: in the real document the first option is selected, which is
  // what makes the auto-detect note visible on load.
  elements.get("agent")!.value = "auto";

  const posted: Record<string, unknown>[] = [];
  const stored: unknown[] = [];
  const messageListeners: Listener[] = [];
  const timers: (() => void)[] = [];

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (_tag: string) => new FakeElement(""),
  };
  const window = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") messageListeners.push(listener);
    },
  };
  const acquireVsCodeApi = () => ({
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    setState: (value: unknown) => stored.push(value),
    getState: () => savedState,
  });
  // The page debounces `formChanged`; the test decides when that timer runs.
  const setTimeout = (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  };
  const clearTimeout = (handle: number) => {
    if (typeof handle === "number" && handle > 0) timers[handle - 1] = () => {};
  };

  const current: Page = {
    elements,
    posted,
    stored,
    focused: undefined,
    byId: (id: string) => {
      const element = elements.get(id);
      assert.ok(element, `the document has no #${id}`);
      return element;
    },
    send: (state: PanelState) => {
      for (const listener of messageListeners) listener({ data: { type: "state", state } });
    },
    flush: () => {
      const pending = [...timers];
      timers.length = 0;
      for (const callback of pending) callback();
    },
  };
  page = current;

  // eslint-disable-next-line no-new-func -- loading the real page script is the point
  new Function("document", "window", "acquireVsCodeApi", "setTimeout", "clearTimeout", PAGE_SOURCE)(
    document,
    window,
    acquireVsCodeApi,
    setTimeout,
    clearTimeout,
  );
  return current;
}

/**
 * A state as the host would build it.
 *
 * The workflow rows go through the real `buildWorkflow`, so these tests fail if
 * the model and the page disagree about a status name — the kind of mismatch
 * that in a webview shows up as a row that never changes.
 */
const state = (overrides: Partial<PanelState> = {}, files: readonly string[] = []): PanelState => {
  const progress: ProgressView = overrides.progress ?? {
    state: "idle",
    rows: [],
    artifacts: [],
  };
  const workflow =
    overrides.workflow ??
    buildWorkflow({
      source: "jira",
      plan: DEFAULT_FORM.plan,
      fixWithAI: false,
      progress,
      // What the run wrote, which is what decides a row's icons.
      artifacts: files,
    });
  return {
    revision: 1,
    readiness: { kind: "ready", executable: "bugpilot", root: "/work/app" },
    problems: [],
    progress,
    workflow,
    overall: overrides.overall ?? overallStatus(workflow, progress),
    artifacts: { kind: "empty", detail: "nothing yet" },
    warnings: [],
    jiraConfigured: false,
    canRetry: false,
    ...overrides,
  };
};

/** One capability row of a `ProgressView`, for driving the model. */
const row = (capability: string, rowState: string, durationMs?: number) => ({
  capability: capability as "code_search",
  label: capability,
  state: rowState as "done",
  ...(durationMs === undefined ? {} : { durationMs }),
});

/** One workflow row, for the cases that are about rendering rather than derivation. */
const step = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: "codeSearch",
  label: "Code search",
  description: "Search relevant code in the repository",
  enabled: true,
  status: "idle",
  actions: [],
  ...overrides,
});

// --- start-up --------------------------------------------------------------

test("the page asks the host for state as soon as it loads", () => {
  const p = load();
  assert.deepEqual(p.posted, [{ type: "ready" }]);
});

test("a saved form is restored before the host answers", () => {
  // The webview is destroyed when hidden, so this is what makes half-typed
  // input survive a hide/show.
  const p = load({ form: { ...DEFAULT_FORM, issueKey: "JR-77", hint: "look here" } });
  assert.equal(p.byId("issueKey").value, "JR-77");
  assert.equal(p.byId("hint").value, "look here");
});

// --- readiness -------------------------------------------------------------

test("while checking, Run is disabled and no warning is shown", () => {
  const p = load();
  p.send(state({ readiness: { kind: "checking" } }));
  assert.equal(p.byId("checking").hidden, false);
  assert.equal(p.byId("blocked").hidden, true);
  assert.equal(p.byId("run").disabled, true);
});

test("a blocked readiness renders one button per offered action", () => {
  const p = load();
  p.send(
    state({
      readiness: {
        kind: "blocked",
        summary: "bugpilot is not on PATH.",
        action: "Install it.",
        actions: [
          { title: "Install Instructions", command: "bugpilot.showInstallInstructions" },
          { title: "Retry", command: "bugpilot.checkEnvironment" },
        ],
      },
    }),
  );

  assert.equal(p.byId("blocked").hidden, false);
  assert.equal(p.byId("blocked-summary").textContent, "bugpilot is not on PATH.");
  const buttons = p.byId("blocked-actions").children;
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["Install Instructions", "Retry"],
  );

  // Clicking one must actually ask for the command. This is the finding that
  // made the whole install wizard dead: the host dropped the message.
  buttons[0]!.dispatch("click");
  assert.deepEqual(p.posted.at(-1), {
    type: "command",
    id: "bugpilot.showInstallInstructions",
  });
});

test("a ready readiness enables the form and names the executable", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("run").disabled, false);
  assert.equal(p.byId("issueKey").disabled, false);
  assert.match(p.byId("environment").textContent, /bugpilot · \/work\/app/);
});

// --- field problems --------------------------------------------------------

test("a field problem is shown next to its field and focuses it once", () => {
  const p = load();
  const problems = [{ field: "issueKey" as const, message: "An issue key is required." }];
  p.send(state({ problems }));

  assert.equal(p.byId("issueKey-error").textContent, "An issue key is required.");
  assert.equal(p.byId("issueKey-error").hidden, false);
  assert.ok(p.byId("field-issueKey").classes.has("field-invalid"));
  assert.equal(p.byId("issueKey").getAttribute("aria-invalid"), "true");
  assert.equal(p.focused, "issueKey");

  // The developer moves to another field; further state pushes (a stream event,
  // an environment refresh) must not yank the cursor back.
  p.focused = "hint";
  p.send(state({ problems }));
  p.send(state({ problems }));
  assert.equal(p.focused, "hint");
});

test("a new problem does focus the field it belongs to", () => {
  const p = load();
  p.send(state({ problems: [{ field: "issueKey", message: "An issue key is required." }] }));
  p.focused = "hint";
  p.send(state({ problems: [{ field: "maxFiles", message: "Enter a whole number." }] }));
  assert.equal(p.focused, "maxFiles");
});

test("clearing the problems clears the message and the invalid styling", () => {
  const p = load();
  p.send(state({ problems: [{ field: "issueKey", message: "nope" }] }));
  p.send(state());
  assert.equal(p.byId("issueKey-error").hidden, true);
  assert.equal(p.byId("field-issueKey").classes.has("field-invalid"), false);
});

// --- the plan coupling -----------------------------------------------------

test("unticking Build context clears and disables everything below it", () => {
  // Including Fix with AI: with no package written, the handoff prompt would
  // point an agent at a file that does not exist.
  const p = load();
  p.send(state());
  p.byId("plan-fixWithAI").checked = true;
  p.byId("plan-buildContext").checked = false;
  p.byId("form").dispatch("change", { target: p.byId("plan-buildContext") });

  for (const field of [
    "plan-codeSearch",
    "plan-gitHistory",
    "plan-similarFixes",
    "plan-fixWithAI",
  ]) {
    assert.equal(p.byId(field).checked, false, field);
    assert.equal(p.byId(field).disabled, true, field);
  }
  assert.equal(p.byId("plan-note").hidden, false);
});

test("re-ticking Build context restores the selection it cleared", () => {
  // Otherwise the next run silently skips search, history and similar fixes —
  // a plan nobody chose, with three unticked boxes to explain it after the fact.
  const p = load();
  p.send(state());
  p.byId("plan-gitHistory").checked = false;
  p.byId("form").dispatch("change", { target: p.byId("plan-gitHistory") });

  p.byId("plan-buildContext").checked = false;
  p.byId("form").dispatch("change", { target: p.byId("plan-buildContext") });
  p.byId("plan-buildContext").checked = true;
  p.byId("form").dispatch("change", { target: p.byId("plan-buildContext") });

  assert.equal(p.byId("plan-codeSearch").checked, true);
  assert.equal(p.byId("plan-similarFixes").checked, true);
  // The one the developer had turned off stays off.
  assert.equal(p.byId("plan-gitHistory").checked, false);
  assert.equal(p.byId("plan-note").hidden, true);
});

// --- input source ----------------------------------------------------------

test("switching the input source shows only the fields it uses", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("field-issueKey").hidden, false);
  assert.equal(p.byId("field-description").hidden, true);

  p.byId("source-manual").checked = true;
  p.byId("form").dispatch("change", { target: p.byId("source-manual") });
  assert.equal(p.byId("field-issueKey").hidden, true);
  assert.equal(p.byId("field-description").hidden, false);
  assert.equal(p.byId("field-title").hidden, false);
});

test("the custom agent command appears only when a custom agent is chosen", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("field-agentCommand").hidden, true);

  p.byId("agent").value = "custom";
  p.byId("form").dispatch("change", { target: p.byId("agent") });
  assert.equal(p.byId("field-agentCommand").hidden, false);

  p.byId("agent").value = "auto";
  p.byId("form").dispatch("change", { target: p.byId("agent") });
  assert.equal(p.byId("field-agentCommand").hidden, true);
});

test("Ctrl+Enter runs without the button being clicked", () => {
  const p = load();
  p.send(state());
  p.byId("issueKey").value = "JR-12345";
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });

  const message = p.posted.at(-1) as { type: string; form: Record<string, unknown> };
  assert.equal(message.type, "run");
  assert.equal(message.form["issueKey"], "JR-12345");
});

test("Enter on its own does not run, because the description needs it", () => {
  const p = load();
  p.send(state());
  const before = p.posted.length;
  p.byId("form").dispatch("keydown", { key: "Enter" });
  assert.equal(p.posted.length, before);
});

test("Ctrl+Enter is ignored while Run is disabled", () => {
  // Otherwise the shortcut is a way around the readiness check that the button
  // itself enforces.
  const p = load();
  p.send(state({ readiness: { kind: "checking" } }));
  const before = p.posted.length;
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });
  assert.equal(p.posted.length, before);
});

// --- running ---------------------------------------------------------------

test("submitting sends the typed form", () => {
  const p = load();
  p.send(state());
  p.byId("issueKey").value = "jr-1";
  p.byId("keywords").value = "save, crash";
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { type: string; form: Record<string, unknown> };
  assert.equal(message.type, "run");
  assert.equal(message.form["issueKey"], "jr-1");
  assert.equal(message.form["keywords"], "save, crash");
  assert.equal((message.form["plan"] as Record<string, unknown>)["issueDetails"], true);
  // The AI step travels beside the plan, not inside it: `form.plan` becomes CLI
  // flags, and this must never be one.
  assert.equal(message.form["fixWithAI"], false);
  assert.equal("fixWithAI" in (message.form["plan"] as Record<string, unknown>), false);
  assert.equal(message.form["agent"], "auto");
});

test("ticking Fix with AI is what puts it in the message", () => {
  const p = load();
  p.send(state());
  p.byId("plan-fixWithAI").checked = true;
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { form: Record<string, unknown> };
  assert.equal(message.form["fixWithAI"], true);
});

test("a run in flight disables the form and enables Stop", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));

  assert.equal(p.byId("stop").disabled, false);
  assert.equal(p.byId("run").disabled, true);
  assert.equal(p.byId("issueKey").disabled, true);
});

test("submitting again while running does nothing", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  const before = p.posted.length;
  p.byId("form").dispatch("submit");
  assert.equal(p.posted.length, before);
});

test("Stop and Retry send their own messages", () => {
  const p = load();
  p.send(state({ canRetry: true, progress: { state: "running", rows: [], artifacts: [] } }));
  p.byId("stop").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "stop" });

  p.send(state({ canRetry: true }));
  p.byId("retry").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "retry" });
});

test("Retry is hidden until there is something to retry", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("retry").hidden, true);
  p.send(state({ canRetry: true }));
  assert.equal(p.byId("retry").hidden, false);
});

test("Stop is absent until there is a run to stop", () => {
  // Not greyed out: a disabled Stop under an idle panel is a control that has
  // never once been usable while it was on screen.
  const p = load();
  p.send(state());
  assert.equal(p.byId("stop").hidden, true);
  // Run is alone in the row, rather than sitting beside a button that cannot
  // be pressed.
  assert.equal(p.byId("run").hidden, false);

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  assert.equal(p.byId("stop").hidden, false);
  assert.equal(p.byId("stop").disabled, false);

  p.send(state({ progress: { state: "done", rows: [], artifacts: [] } }));
  assert.equal(p.byId("stop").hidden, true);
});

test("Retry is not offered while a run is in flight", () => {
  // `bug --retry` reads the artifacts of a finished attempt, so mid-run it
  // could only be greyed out — and the row already has Stop in it.
  const p = load();
  p.send(state({ canRetry: true, progress: { state: "running", rows: [], artifacts: [] } }));
  assert.equal(p.byId("retry").hidden, true);
  assert.equal(p.byId("stop").hidden, false);

  p.send(state({ canRetry: true }));
  assert.equal(p.byId("retry").hidden, false);
  assert.equal(p.byId("stop").hidden, true);
});

// --- the checklist ---------------------------------------------------------

test("each row carries an icon and its state in the accessible name", () => {
  // The accessible name is what makes the workflow readable without colour,
  // which is the §5.4 requirement a screen reader also depends on.
  const p = load();
  p.send(
    state({
      progress: {
        state: "running",
        rows: [row("issue_details", "done", 500), row("code_search", "running")],
        artifacts: [],
      },
    }),
  );

  assert.equal(p.byId("step-issueDetails").getAttribute("aria-label"), "Issue details: done");
  assert.equal(p.byId("step-codeSearch").getAttribute("aria-label"), "Code search: running");
  // A filled disc, not a tick: a tick beside a ticked checkbox was one check
  // mark too many, and this is the glyph the editor's Testing view uses.
  assert.ok(p.byId("status-issueDetails").classes.has("codicon-pass-filled"));
  assert.equal(p.byId("status-issueDetails").classes.has("codicon-check"), false);
  assert.ok(p.byId("status-codeSearch").classes.has("codicon-loading"));
  assert.ok(p.byId("status-codeSearch").classes.has("codicon-spin"), "the running row turns");
  assert.ok(p.byId("step-codeSearch").classes.has("step-running"));
  assert.equal(p.byId("duration-issueDetails").textContent, "0.5s");
});

test("a step that has not started shows no icon at all", () => {
  // The checkbox already says it is going to run; an outline circle on every
  // unstarted row is five glyphs saying nothing has happened yet.
  const p = load();
  p.send(state());
  for (const id of ["issueDetails", "codeSearch", "fixWithAI"]) {
    assert.equal(p.byId(`status-${id}`).hidden, true, id);
  }

  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));
  assert.equal(p.byId("status-codeSearch").hidden, false);
});

test("a step nobody chose says so instead of looking pending forever", () => {
  const p = load();
  p.send(
    state({
      workflow: [step({ id: "gitHistory", label: "Git history", enabled: false })],
    }),
  );
  assert.ok(p.byId("step-gitHistory").classes.has("step-off"));
  assert.equal(p.byId("step-gitHistory").getAttribute("aria-label"), "Git history: not selected");
});

test("the checkbox is never touched by a status push", () => {
  // The row is shared: the checkbox belongs to the page, everything else to the
  // host. A render that reset the box would undo a tick made mid-run.
  const p = load();
  p.send(state());
  p.byId("plan-fixWithAI").checked = true;
  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));
  assert.equal(p.byId("plan-fixWithAI").checked, true);
});

test("durations are readable rather than arithmetically honest", () => {
  const p = load();
  const durations = [30, 900, 65_000].map((ms) => {
    p.send(state({ workflow: [step({ status: "success", durationMs: ms })] }));
    return p.byId("duration-codeSearch").textContent;
  });
  // A step that took 30ms used to render as "0.001s".
  assert.deepEqual(durations, ["<0.1s", "0.9s", "1m 05s"]);
});

test("the Build context icons appear only once it has produced something", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("actions-buildContext").hidden, true);

  p.send(
    state(
      {
        workItemId: "JR-1",
        progress: { state: "done", rows: [row("build_context", "done")], artifacts: [] },
      },
      // The icons follow the files, so this is what puts them on screen.
      ["agent_task.md", "bug_context.md"],
    ),
  );
  assert.equal(p.byId("actions-buildContext").hidden, false);

  p.byId("open-context").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openContext" });
  p.byId("copy-context").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "copyHandoff" });
  p.byId("open-folder").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openFolder" });
});

test("what happened to the AI step is spelled out on its own row", () => {
  // "Handed over" against a tick, and a degraded handoff against a skip: the
  // icon alone cannot tell those apart, and neither can a notification that
  // has already been dismissed.
  const p = load();
  p.send(
    state({
      workflow: [
        step({
          id: "fixWithAI",
          label: "Fix with AI",
          description: "Run the prepared context with your AI coding agent",
          status: "success",
          detail: "Handed to Claude Code in a terminal.",
        }),
      ],
    }),
  );
  assert.equal(
    p.byId("description-fixWithAI").textContent,
    "Handed to Claude Code in a terminal.",
  );
  assert.ok(p.byId("step-fixWithAI").classes.has("step-success"));
});

test("the overall status is shown in the workflow header", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("workflow-status").textContent, "Ready to run");

  p.send(
    state({
      progress: {
        state: "running",
        rows: [row("issue_details", "done"), row("code_search", "running")],
        artifacts: [],
        activity: "Searching the codebase",
      },
    }),
  );
  assert.match(p.byId("workflow-status").textContent, /^Running \d\/\d…$/);
  assert.ok(p.byId("workflow-status").classes.has("is-running"));
  assert.equal(p.byId("activity").textContent, "Searching the codebase");
});

test("a failure is shown as an alert with its next step", () => {
  const p = load();
  p.send(
    state({
      progress: {
        state: "failed",
        rows: [row("issue_details", "failed")],
        artifacts: [],
        failure: {
          code: "JIRA_AUTH_FAILED",
          summary: "Jira rejected the credentials.",
          action: "Run BugPilot: Set Jira Credentials.",
          retryable: false,
        },
      },
    }),
  );

  assert.equal(p.byId("failure").hidden, false);
  assert.equal(p.byId("failure-summary").textContent, "Jira rejected the credentials.");
  assert.match(p.byId("failure-action").textContent, /Set Jira Credentials/);
  assert.equal(p.byId("workflow-status").textContent, "Run failed");
  assert.ok(p.byId("workflow-status").classes.has("is-failed"));
});

test("the credential status is shown, and the button asks the host to edit it", () => {
  // The page only ever learns whether a credential exists, never the token.
  const p = load();
  p.send(state({ jiraConfigured: true }));
  assert.equal(p.byId("jira-status").textContent, "Configured");
  assert.equal(p.byId("jira-ok").hidden, false, "the tick belongs with the word");
  p.byId("set-credentials").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "setCredentials" });

  p.send(state({ jiraConfigured: false }));
  assert.equal(p.byId("jira-status").textContent, "Not configured");
  assert.equal(p.byId("jira-ok").hidden, true);
  assert.equal(p.byId("set-credentials").textContent, "Set Jira credentials");
});

// --- persistence -----------------------------------------------------------

test("typing is persisted immediately and reported to the host once", () => {
  const p = load();
  p.send(state());
  p.byId("hint").value = "look in the parser";
  p.byId("form").dispatch("input", { target: p.byId("hint") });
  p.byId("hint").value = "look in the parser, near save()";
  p.byId("form").dispatch("input", { target: p.byId("hint") });

  // setState happens per keystroke so a hide/show loses nothing.
  assert.equal(p.stored.length >= 2, true);
  // The host hears about it once, after the debounce.
  const before = p.posted.length;
  p.flush();
  const sent = p.posted.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!["type"], "formChanged");
});

test("a state push does not overwrite the form unless the revision changed", () => {
  const p = load();
  p.send(state({ revision: 1, form: { ...DEFAULT_FORM, issueKey: "JR-1" } }));
  assert.equal(p.byId("issueKey").value, "JR-1");

  p.byId("issueKey").value = "JR-2-being-typed";
  p.send(state({ revision: 1, form: { ...DEFAULT_FORM, issueKey: "JR-1" } }));
  assert.equal(p.byId("issueKey").value, "JR-2-being-typed", "the host must not stomp on typing");

  p.send(state({ revision: 2, form: { ...DEFAULT_FORM, issueKey: "JR-9" } }));
  assert.equal(p.byId("issueKey").value, "JR-9", "a deliberate replacement must land");
});

test("the footer names the version when the CLI reports one", () => {
  // Which of the machine's several bugpilots is running is otherwise invisible.
  const p = load();
  p.send(
    state({
      readiness: {
        kind: "ready",
        executable: "C:/tools/bugpilot.exe",
        root: "/work/app",
        version: "0.1.0",
      },
    }),
  );
  assert.match(p.byId("environment").textContent, /BugPilot 0\.1\.0 · \/work\/app/);
});


test("a standing fact about the repository gets its own card", () => {
  // Host-computed from doctor's report: not a failure, but cheaper to hear now
  // than after committing the artifacts. A card rather than loose footer text,
  // because loose footer text is what nobody reads.
  const p = load();
  p.send(state());
  assert.equal(p.byId("notices").hidden, true);

  p.send(
    state({
      warnings: [
        {
          title: "Repository Files",
          message: "This repository does not ignore .ai/ and .ai_memory/.",
        },
      ],
    }),
  );
  assert.equal(p.byId("notices").hidden, false);
  const cards = p.byId("notices").children;
  assert.equal(cards.length, 1);
  // Icon, then title and message — and the text goes through textContent, so a
  // Jira title in a future notice cannot become markup.
  assert.ok(cards[0]!.children[0]!.classes.has("codicon-warning"));
  const body = cards[0]!.children[1]!;
  assert.equal(body.children[0]!.textContent, "Repository Files");
  assert.match(body.children[1]!.textContent, /does not ignore/);
});

test("each notice is a card of its own", () => {
  const p = load();
  p.send(
    state({
      warnings: [
        { title: "Jira Site", message: "No Jira site is configured." },
        { title: "Repository Files", message: "This repository does not ignore .ai/." },
      ],
    }),
  );
  const cards = p.byId("notices").children;
  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((card) => card.children[1]!.children[0]!.textContent),
    ["Jira Site", "Repository Files"],
  );
});

test("the command box belongs to the custom choice alone", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("field-agentCommand").hidden, true);

  p.byId("agent").value = "custom";
  p.byId("form").dispatch("change", { target: p.byId("agent") });
  assert.equal(p.byId("field-agentCommand").hidden, false);

  p.byId("agent").value = "claude";
  p.byId("form").dispatch("change", { target: p.byId("agent") });
  assert.equal(p.byId("field-agentCommand").hidden, true);
});

test("a validation problem inside Advanced settings opens it", () => {
  // The fields moved into a collapsed section; a message nobody can see is the
  // same as no message.
  const p = load();
  p.send(state({ problems: [{ field: "maxFiles", message: "Enter a whole number." }] }));
  assert.equal(p.byId("advanced").open, true);
  assert.equal(p.focused, "maxFiles");
});

test("attached files are listed by name, with the full path on hover", () => {
  const p = load();
  p.send(
    state({
      revision: 2,
      form: { ...DEFAULT_FORM, attachments: ["C:\\logs\\crash.log", "/home/me/shot.png"] },
    }),
  );

  const rows = p.byId("attachment-list").children;
  assert.equal(p.byId("attachment-list").hidden, false);
  assert.deepEqual(
    rows.map((row) => row.children[0]!.textContent),
    ["crash.log", "shot.png"],
    "a basename is what a developer recognises",
  );
  assert.equal(rows[0]!.children[0]!.getAttribute("title"), "C:\\logs\\crash.log");
});

test("removing one takes it out of the next form the page sends", () => {
  const p = load();
  p.send(
    state({ revision: 2, form: { ...DEFAULT_FORM, attachments: ["/a/one.log", "/b/two.log"] } }),
  );
  // The × on the first row.
  p.byId("attachment-list").children[0]!.children[1]!.dispatch("click");

  assert.deepEqual(
    p.byId("attachment-list").children.map((row) => row.children[0]!.textContent),
    ["two.log"],
  );
  p.flush();
  const sent = p.posted.at(-1) as { type: string; form: { attachments: string[] } };
  assert.equal(sent.type, "formChanged");
  assert.deepEqual(sent.form.attachments, ["/b/two.log"]);
});

test("the list is hidden while there is nothing attached", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("attachment-list").hidden, true);
});

test("Add files asks the host, because only the host can open a dialog", () => {
  const p = load();
  p.send(state());
  p.byId("issueKey").value = "JR-9";
  p.byId("add-attachment").dispatch("click");

  const sent = p.posted.at(-1) as { type: string; form: { issueKey: string } };
  assert.equal(sent.type, "addAttachments");
  // Carrying the form, so the host merges onto what is on screen rather than
  // onto its own copy from up to a debounce ago.
  assert.equal(sent.form.issueKey, "JR-9");
});
