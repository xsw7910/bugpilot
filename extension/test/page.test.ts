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
import { parsePanelMessage } from "../src/panel/messages.ts";
import { Controller } from "../src/app/controller.ts";
import type { ControllerPorts } from "../src/app/controller.ts";
import type { FixModeDraft } from "../src/app/fixModes.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { buildWorkflow, overallStatus } from "../src/app/workflow.ts";
import { primaryView } from "../src/app/nextAction.ts";
import type { NextActionInput } from "../src/app/nextAction.ts";
import type { SearchContent, WorkflowInput, WorkflowStepResult } from "../src/app/workflow.ts";
import type { UserFacingError } from "../src/app/failures.ts";
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
  type = "";
  #disabled = false;

  get disabled(): boolean {
    return this.#disabled;
  }

  /**
   * Chromium's focus fixup: a focused control that becomes disabled loses the
   * focus to the document. Modelled so a page test cannot pass on focus a real
   * webview would already have dropped.
   */
  set disabled(value: boolean) {
    this.#disabled = value;
    if (value && page?.focused === this.id) {
      page.focused = undefined;
      this.focused = false;
    }
  }
  /**
   * What layout would give, for the fields that resize themselves.
   *
   * There is no layout here, so a test that cares sets these two by hand:
   * `clientHeight` is the height `rows` asks for, `scrollHeight` the height the
   * text wants. Both default to 0 — which is exactly the case the page has to
   * survive, a field inside a closed `<details>`.
   */
  clientHeight = 0;
  scrollHeight = 0;
  readonly style: Record<string, string> = {};
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

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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

  /**
   * What the page asked to bring into view.
   *
   * There is no layout here and no smooth scrolling to wait for, so the test
   * reads the request rather than a pixel offset: what matters is that the page
   * asked for the right element, once it was visible.
   */
  scrolledIntoView: Record<string, unknown> | undefined;

  scrollIntoView(options?: Record<string, unknown>): void {
    this.scrolledIntoView = options ?? {};
  }
}

interface Page {
  /** The page's clock and its intervals: `advance` moves both. */
  readonly clock: { now: number };
  readonly intervals: Map<number, { callback: () => void; every: number; due: number }>;
  readonly advance: (ms: number) => void;
  readonly elements: Map<string, FakeElement>;
  readonly posted: Record<string, unknown>[];
  readonly stored: unknown[];
  focused: string | undefined;
  readonly send: (state: PanelState) => void;
  readonly byId: (id: string) => FakeElement;
  readonly flush: () => void;
  /** Fire every ResizeObserver the page made: its boxes changed size. */
  readonly resize: () => void;
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
  // The stub has no notion of <option>, so the select's default selection has
  // to be stated: in the real document the first option is selected, which is
  // what makes the auto-detect note visible on load.
  elements.get("agent")!.value = "auto";

  const posted: Record<string, unknown>[] = [];
  const stored: unknown[] = [];
  const messageListeners: Listener[] = [];
  const timers: (() => void)[] = [];

  // What the page builds at runtime (a notice's button), so focus on one of
  // them is reported like focus on anything in the markup.
  const created: FakeElement[] = [];
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (_tag: string) => {
      const element = new FakeElement("");
      created.push(element);
      return element;
    },
    /** The element the page last focused, as the real document would report it. */
    get activeElement() {
      if (current.focused === undefined) return null;
      return elements.get(current.focused) ?? created.find((element) => element.id === current.focused) ?? null;
    },
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
  // The elapsed clock's interval and the time it reads, both the test's.
  const clock = { now: 1_000_000 };
  const intervals = new Map<number, { callback: () => void; every: number; due: number }>();
  let nextInterval = 0;
  const setInterval = (callback: () => void, every: number) => {
    nextInterval += 1;
    intervals.set(nextInterval, { callback, every, due: clock.now + every });
    return nextInterval;
  };
  const clearInterval = (handle: number) => {
    intervals.delete(handle);
  };
  const FakeDate = class extends Date {
    static override now() {
      return clock.now;
    }
  };

  const observers: (() => void)[] = [];
  const FakeResizeObserver = class {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
      observers.push(() => this.#callback());
    }
    observe() {}
    disconnect() {}
  };

  const current: Page = {
    resize: () => {
      for (const fire of observers) fire();
    },
    clock,
    intervals,
    advance: (ms: number) => {
      const end = clock.now + ms;
      for (;;) {
        const next = [...intervals.values()].filter((entry) => entry.due <= end).sort((a, b) => a.due - b.due)[0];
        if (next === undefined) break;
        clock.now = next.due;
        next.due += next.every;
        next.callback();
      }
      clock.now = end;
    },
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
  new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
    "ResizeObserver",
    PAGE_SOURCE,
  )(document, window, acquireVsCodeApi, setTimeout, clearTimeout, setInterval, clearInterval, FakeDate, FakeResizeObserver);
  return current;
}

/**
 * The primary action as the host would compute it, through the real
 * `primaryView` — so a page test cannot pass on a label the model never gives.
 * Nothing prepared, nothing in flight, unless a test says otherwise.
 */
const primaryOf = (input: Partial<NextActionInput> = {}) =>
  primaryView({
    ready: true,
    busy: false,
    prepared: false,
    stale: false,
    attempted: false,
    sessionKnown: false,
    fresh: false,
    settled: false,
    ...input,
  });

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
    // Always present, like the readiness beside it: the question Diagnostics
    // answers is asked most urgently when nothing has run.
    diagnostics: { rows: [] },
    problems: [],
    progress,
    workflow,
    overall: overrides.overall ?? overallStatus(workflow, progress),
    workItemActions: [],
    artifacts: { kind: "empty", detail: "nothing yet" },
    warnings: [],
    jiraConfigured: false,
    primary: primaryOf({
      busy: progress.state === "running",
      settled: progress.state === "done" || progress.state === "failed",
    }),
    fixModes: { kind: "loading" },
    ...overrides,
  };
};

/**
 * Open Workflow Settings from its entry, change the draft, and press Apply —
 * the one way a setting reaches the form the page sends.
 */
const applyOnPage = (p: Page, edit: () => void) => {
  p.byId("open-settings").dispatch("click");
  edit();
  p.byId("settings-apply").dispatch("click");
};

/** The page pressing Run: the primary action, sent back with the form. */
const isRunPress = (message: Record<string, unknown>) => message["type"] === "nextAction" && message["action"] === "run";

/** One capability row of a `ProgressView`, for driving the model. */
const row = (capability: string, rowState: string, durationMs?: number) => ({
  capability: capability as "code_search",
  label: capability,
  state: rowState as "done",
  ...(durationMs === undefined ? {} : { durationMs }),
});

/** One workflow row, for the cases that are about rendering rather than derivation. */
const step = (overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
  id: "codeSearch",
  label: "Code search",
  description: "Search relevant code in the repository",
  enabled: true,
  status: "idle",
  statusText: "",
  summary: "Search relevant code in the repository",
  actions: [],
  ...overrides,
});

/** The six rows, top to bottom. */
const STEP_IDS = ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"] as const;

/** The five capabilities a full run finishes, in `progress.ts` terms. */
const CAPABILITY_IDS = ["issue_details", "code_search", "git_history", "similar_fixes", "build_context"];

/** What a prepared work item holds on disk. */
const PREPARED_FILES = ["issue.json", "retrieval.json", "context.md", "task.md", "run.json"];

/** `issue.json`, as the host parses it. */
const ISSUE = { id: "JR-12345", source: "jira", title: "WidgetController rejects the VDS output type" };

/** `retrieval.json`, as the host projects it: the counts, and no lists yet. */
const SEARCH = { relevantFiles: 8, searchTerms: 53, content: { files: [], terms: [] } };

/** The same search, carrying the lists Code search's disclosures render. */
const withSearch = (content: Partial<SearchContent>) => ({
  search: { ...SEARCH, content: { files: [], terms: [], ...content } },
});

/**
 * A finished run, as the host reports one.
 *
 * Every capability done, every artifact on disk and no handoff attempted yet,
 * which is the ordinary case a developer lands in after Run. The rows go
 * through the real `buildWorkflow`, so what each one says is the model's, not
 * this file's.
 */
const prepared = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}): PanelState => {
  const progress: ProgressView = {
    state: "done",
    rows: CAPABILITY_IDS.map((capability) => row(capability, "done")),
    artifacts: PREPARED_FILES,
  };
  const workflow = buildWorkflow({
    source: "jira",
    plan: DEFAULT_FORM.plan,
    fixWithAI: false,
    progress,
    artifacts: PREPARED_FILES,
    workItemId: "JR-12345",
    issue: ISSUE,
    search: SEARCH,
    ...extra,
  });
  const files = extra.artifacts ?? PREPARED_FILES;
  const started = extra.fix?.status === "success" || extra.session !== undefined;
  const primary = primaryOf({
    busy: extra.handoffBusy === true,
    prepared: files.includes("task.md"),
    attempted: started || files.includes("fix_report.md"),
    sessionKnown: started,
    settled: true,
  });
  return state({ progress, workflow, workItemId: "JR-12345", workItemActions: ["openFolder"], primary, ...overrides });
};

/**
 * A run that failed while `capability` was in flight, after `before` finished.
 *
 * The host gives that row the run's card, so `runError` is absent from the
 * state — which is how the controller keeps a failure from showing twice.
 */
const failedAt = (capability: string, error: UserFacingError, before: readonly string[] = []): PanelState => {
  const progress: ProgressView = {
    state: "failed",
    rows: [...before.map((done) => row(done, "done")), row(capability, "failed")],
    artifacts: [],
    failure: { code: "RUN_FAILED", summary: error.message, retryable: false, capability: capability as "code_search" },
  };
  const files = before.length > 0 ? ["issue.json", "retrieval.json"] : [];
  const workflow = buildWorkflow({
    source: "jira",
    plan: DEFAULT_FORM.plan,
    fixWithAI: false,
    progress,
    artifacts: files,
    workItemId: "JR-12345",
    issue: ISSUE,
    search: SEARCH,
    runError: error,
  });
  return state({
    progress,
    workflow,
    workItemId: "JR-12345",
    workItemActions: files.length > 0 ? ["openFolder"] : [],
  });
};

// --- start-up --------------------------------------------------------------

test("the page asks the host for state as soon as it loads", () => {
  const p = load();
  assert.deepEqual(p.posted, [{ type: "ready" }]);
});

test("a saved form is restored before the host answers", () => {
  // The webview is destroyed when hidden, so this is what makes half-typed
  // input survive a hide/show.
  const p = load({ form: { ...DEFAULT_FORM, issueKey: "JR-77", hint: "look here" } });
  assert.equal(p.byId("issue").value, "JR-77");
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
  assert.equal(p.byId("issue").disabled, false);
  assert.match(p.byId("environment").textContent, /bugpilot · \/work\/app/);
});

// --- field problems --------------------------------------------------------

test("a field problem is shown next to its field and focuses it once", () => {
  const p = load();
  // Reported against `issueKey`, shown on `#issue`: the host validates the
  // field a command line is built from, and the page has one box for both.
  const problems = [{ field: "issueKey" as const, message: "An issue key is required." }];
  p.send(state({ problems }));

  assert.equal(p.byId("issue-error").textContent, "An issue key is required.");
  assert.equal(p.byId("issue-error").hidden, false);
  assert.ok(p.byId("field-issue").classes.has("field-invalid"));
  assert.equal(p.byId("issue").getAttribute("aria-invalid"), "true");
  assert.equal(p.focused, "issue");

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
  assert.equal(p.byId("issue-error").hidden, true);
  assert.equal(p.byId("field-issue").classes.has("field-invalid"), false);
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

/** Type into the one Issue field, as the developer would. */
function type(p: Page, text: string): void {
  p.byId("issue").value = text;
  p.byId("form").dispatch("input", { target: p.byId("issue") });
}

test("the input source is derived from the Issue field, not chosen", () => {
  // UI-A1 removed the radio pair. The classification it asked for is in the
  // text: a Jira key matches the pattern and everything else is prose.
  const p = load();
  p.send(state());

  type(p, "JR-12345");
  p.flush();
  const jira = p.posted.at(-1) as { form: Record<string, unknown> };
  assert.equal(jira.form["source"], "jira");
  assert.equal(jira.form["issueKey"], "JR-12345");
  assert.equal(jira.form["description"], "", "a key must not also arrive as prose");

  type(p, "The export dialog crashes when nothing is selected.");
  p.flush();
  const manual = p.posted.at(-1) as { form: Record<string, unknown> };
  assert.equal(manual.form["source"], "manual");
  assert.equal(manual.form["description"], "The export dialog crashes when nothing is selected.");
  assert.equal(manual.form["issueKey"], "", "prose must not also arrive as a key");
});

test("an empty Issue field is not yet a hand-written bug", () => {
  // `workItemScopeOf` returns undefined for an empty Jira key and "manual" for
  // anything else, and the controller reads undefined as "no work item yet".
  // Reading an empty box as a blank description would make every clear look
  // like a move to another bug.
  const p = load();
  p.send(state());

  type(p, "");
  p.flush();
  const message = p.posted.at(-1) as { form: Record<string, unknown> };
  assert.equal(message.form["source"], "jira");
  assert.equal(message.form["issueKey"], "");
});

test("the Issue field says how it was read, once there is something to read", () => {
  // What the radio pair used to say out loud. Silent while the panel is
  // untouched, which is the state UI-A1 is about.
  const p = load();
  p.send(state());
  assert.equal(p.byId("issue-note").hidden, true);

  type(p, "jr-12345");
  assert.equal(p.byId("issue-note").hidden, false);
  assert.equal(p.byId("issue-note").textContent, "Jira issue JR-12345");

  type(p, "It crashes on export.");
  assert.equal(p.byId("issue-note").textContent, "Bug description");

  type(p, "  ");
  assert.equal(p.byId("issue-note").hidden, true);
});

test("Title appears only for a bug the developer is writing themselves", () => {
  // A Jira issue brings its own title, and `buildPrepareArgs` sends `--title`
  // on the manual path alone — so the box would do nothing beside a key.
  const p = load();
  p.send(state());
  assert.equal(p.byId("field-title").hidden, true);

  type(p, "Crash on export");
  assert.equal(p.byId("field-title").hidden, false);

  type(p, "JR-99");
  assert.equal(p.byId("field-title").hidden, true);
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
  p.byId("issue").value = "JR-12345";
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });

  const message = p.posted.at(-1) as { type: string; action?: string; form: Record<string, unknown> };
  assert.equal(message.type, "nextAction");
  assert.equal(message.action, "run");
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

test("submitting sends the typed form, with the applied settings", () => {
  const p = load();
  p.send(state());
  p.byId("issue").value = "jr-1";
  applyOnPage(p, () => {
    p.byId("keywords").value = "save, crash";
  });
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { type: string; action?: string; form: Record<string, unknown> };
  assert.equal(message.type, "nextAction");
  assert.equal(message.action, "run");
  // Not uppercased here: `buildPrepareArgs` owns that, and a box that rewrote
  // what was typed would fight the developer mid-word.
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
  assert.equal(p.byId("issue").disabled, true);
});

test("submitting again while running does nothing", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  const before = p.posted.length;
  p.byId("form").dispatch("submit");
  assert.equal(p.posted.length, before);
});

test("Stop and the ⋯ menu's items send their own messages", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  p.byId("stop").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "stop" });

  // Rebuild Context, from the menu: the next-action message, with the form.
  p.send(prepared(STARTED));
  p.byId("more-actions").dispatch("click");
  assert.equal(p.byId("more-menu").hidden, false);
  assert.equal(p.byId("more-actions").getAttribute("aria-expanded"), "true");
  p.byId("menu-rebuildContext").dispatch("click");
  const rebuild = p.posted.at(-1) as { type: string; action: string; form: unknown };
  assert.equal(rebuild.type, "nextAction");
  assert.equal(rebuild.action, "rebuildContext");
  assert.ok(rebuild.form, "Rebuild Context went out without the form");
  // Choosing closes the menu.
  assert.equal(p.byId("more-menu").hidden, true);
  assert.equal(p.byId("more-actions").getAttribute("aria-expanded"), "false");

  // Open AI Session, from the menu while the context is stale.
  p.send(prepared(STARTED, { primary: primaryOf({ prepared: true, stale: true, attempted: true, sessionKnown: true, settled: true }) }));
  assert.equal(p.byId("run-label").textContent, "Rebuild Context");
  assert.equal(p.byId("menu-openSession").hidden, false);
  assert.equal(p.byId("menu-startNewAttempt").hidden, true, "a new attempt was offered on a stale context");
  p.byId("menu-openSession").dispatch("click");
  assert.equal((p.posted.at(-1) as { action: string }).action, "openSession");
});

test("Start New Attempt is not offered before the first attempt, and is once one exists", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("more-actions").hidden, true);
  assert.equal(p.byId("menu-startNewAttempt").hidden, true);

  // Prepared, never handed over: Fix with AI, and nothing about attempts.
  p.send(prepared());
  assert.equal(p.byId("menu-startNewAttempt").hidden, true);
  // Pressing a hidden item — a stale frame, a fast double press — does nothing.
  const before = p.posted.length;
  p.byId("menu-startNewAttempt").dispatch("click");
  assert.equal(p.posted.length, before);
  assert.equal(p.byId("attempt-editor").hidden, true);

  // Started: offered, behind ⋯.
  p.send(prepared(STARTED));
  assert.equal(p.byId("menu-startNewAttempt").hidden, false);
});

test("the ⋯ menu closes on Escape and gives the focus back to its button", () => {
  const p = load();
  p.send(prepared(STARTED));
  p.byId("more-actions").dispatch("click");
  assert.equal(p.focused, "menu-startNewAttempt", "the menu opened without focusing its first item");
  p.byId("more-menu").dispatch("keydown", { key: "ArrowDown" });
  assert.equal(p.focused, "menu-rebuildContext");
  p.byId("more-menu").dispatch("keydown", { key: "Escape" });
  assert.equal(p.byId("more-menu").hidden, true);
  assert.equal(p.focused, "more-actions");
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

test("the ⋯ menu is not offered while anything is in flight, and an open one closes", () => {
  // Nothing in it may overlap a run, a handoff or an artifact write — and the
  // row already has Stop in it.
  const p = load();
  p.send(prepared(STARTED));
  p.byId("more-actions").dispatch("click");
  assert.equal(p.byId("more-menu").hidden, false);

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  assert.equal(p.byId("more-actions").hidden, true);
  assert.equal(p.byId("more-menu").hidden, true, "the menu stayed open over a run");
  assert.equal(p.byId("stop").hidden, false);

  // A handoff in flight: busy too, though no run is.
  p.send(prepared({ ...STARTED, handoffBusy: true }));
  assert.equal(p.byId("more-actions").hidden, true);
  assert.equal(p.byId("run-label").textContent, "Running…");

  p.send(prepared(STARTED));
  assert.equal(p.byId("more-actions").hidden, false);
  assert.equal(p.byId("stop").hidden, true);
});

// --- Start New Attempt's form -------------------------------------------------

/** A work item whose first attempt started, with the form opened from the menu. */
const withAttemptForm = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}) => {
  const p = load();
  p.send(prepared({ ...STARTED, ...extra }, overrides));
  p.byId("more-actions").dispatch("click");
  p.byId("menu-startNewAttempt").dispatch("click");
  return p;
};

test("Start New Attempt opens its form under Fix with AI, at the feedback", () => {
  const p = withAttemptForm();
  assert.equal(p.byId("attempt-editor").hidden, false);
  assert.equal(p.byId("workflow").open, true);
  assert.equal(p.focused, "attempt-feedback");
  assert.deepEqual(p.byId("attempt-editor").scrolledIntoView, { behavior: "smooth", block: "nearest" });
  // Opening it asks the host nothing.
  assert.equal(p.posted.some((message) => message["type"] === "startAttempt"), false);
});

test("Start Attempt sends the feedback as typed and the form; empty is allowed", () => {
  const p = withAttemptForm();
  p.byId("issue").value = "JR-12345";
  p.byId("start-attempt").dispatch("click");
  const empty = p.posted.at(-1) as { type: string; feedback: string; form: Record<string, unknown> };
  assert.equal(empty.type, "startAttempt");
  assert.equal(empty.feedback, "", "empty feedback is a choice, not an error the page decides");
  assert.equal(empty.form["issueKey"], "JR-12345");

  p.byId("attempt-feedback").value = "The previous fix changed the wrong class.";
  p.byId("attempt-editor").dispatch("keydown", { key: "Enter", ctrlKey: true });
  const typed = p.posted.at(-1) as { type: string; feedback: string };
  assert.equal(typed.type, "startAttempt", "Ctrl+Enter in the form pressed something else");
  assert.equal(typed.feedback, "The previous fix changed the wrong class.");
});

test("typing feedback is not a form change, and Ctrl+Enter there never presses the primary action", () => {
  const p = withAttemptForm();
  const before = p.posted.length;
  p.byId("attempt-feedback").value = "Keep the public API.";
  p.byId("form").dispatch("input", { target: p.byId("attempt-feedback") });
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("attempt-feedback") });
  p.flush();
  assert.deepEqual(p.posted.slice(before), [], "the feedback reached the run form");
});

test("Cancel closes and empties the form; another work item does too", () => {
  const p = withAttemptForm();
  p.byId("attempt-feedback").value = "Focus on WidgetController.cpp.";
  p.byId("cancel-attempt").dispatch("click");
  assert.equal(p.byId("attempt-editor").hidden, true);
  assert.equal(p.byId("attempt-feedback").value, "");

  p.byId("more-actions").dispatch("click");
  p.byId("menu-startNewAttempt").dispatch("click");
  p.byId("attempt-feedback").value = "For JR-12345 only.";
  p.send({ ...prepared(STARTED), workItemId: "JR-999" });
  assert.equal(p.byId("attempt-editor").hidden, true);
  assert.equal(p.byId("attempt-feedback").value, "", "JR-999 inherited feedback typed for JR-12345");
});

test("while an attempt starts, Start waits; once the host answers, the form closes and empties", () => {
  const p = withAttemptForm();
  p.byId("attempt-feedback").value = "Try the other overload.";
  p.byId("start-attempt").dispatch("click");

  p.send(prepared({ ...STARTED, handoffBusy: true, attempt: { state: "starting" } }));
  assert.equal(p.byId("start-attempt").getAttribute("aria-disabled"), "true");
  assert.equal(p.byId("start-attempt-label").textContent, "Starting…");
  assert.equal(p.byId("description-fixWithAI").textContent, "Starting a new attempt…");
  assert.equal(p.byId("attempt-editor").hidden, false);
  // A second press is refused on the page too.
  const before = p.posted.length;
  p.byId("start-attempt").dispatch("click");
  assert.equal(p.posted.length, before);

  p.send(prepared({ fix: { status: "success", detail: "New attempt, with your feedback, handed to Claude Code in a terminal." } }));
  assert.equal(p.byId("attempt-editor").hidden, true);
  assert.equal(p.byId("attempt-feedback").value, "");
  assert.equal(p.byId("detail-fixWithAI").textContent, "New attempt, with your feedback, handed to Claude Code in a terminal.");
});

test("an attempt that did not start keeps what was typed and says why", () => {
  const p = withAttemptForm();
  p.byId("attempt-feedback").value = "Try the other overload.";
  p.byId("start-attempt").dispatch("click");
  p.send(prepared({ ...STARTED, handoffBusy: true, attempt: { state: "starting" } }));
  p.send(prepared({ ...STARTED, attempt: { state: "failed", message: "Not started: bugpilot could not run." } }));

  assert.equal(p.byId("attempt-editor").hidden, false);
  assert.equal(p.byId("attempt-feedback").value, "Try the other overload.");
  assert.equal(p.byId("attempt-error").hidden, false);
  assert.equal(p.byId("attempt-error").textContent, "Not started: bugpilot could not run.");
  assert.equal(p.byId("start-attempt").getAttribute("aria-disabled"), "false", "Start did not come back for another try");
});

test("the feedback helpers appear only when the host lists them, and add text only when pressed", () => {
  const p = withAttemptForm();
  assert.equal(p.byId("attempt-helpers").hidden, true);
  assert.equal(p.byId("use-review-findings").hidden, true);
  assert.equal(p.byId("use-verification-evidence").hidden, true);

  p.send(prepared({ ...STARTED, feedbackHelpers: ["useReviewFindings"] }));
  assert.equal(p.byId("attempt-helpers").hidden, false);
  assert.equal(p.byId("use-review-findings").hidden, false);
  assert.equal(p.byId("use-verification-evidence").hidden, true);
  // Listing a helper puts nothing in the form.
  assert.equal(p.byId("attempt-feedback").value, "");

  p.byId("use-review-findings").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "useReviewFindings" });

  // The answer is added under what was typed, once — not again on the next push.
  p.byId("attempt-feedback").value = "Mine first.";
  const answer = { token: 1, text: "From review_report.md (a recorded review):\n\nFindings:\nDuplicate null check." };
  p.send(prepared({ ...STARTED, feedbackHelpers: ["useReviewFindings"], attemptDraft: answer }));
  assert.equal(p.byId("attempt-feedback").value, `Mine first.\n\n${answer.text}`);
  p.send(prepared({ ...STARTED, feedbackHelpers: ["useReviewFindings"], attemptDraft: answer }));
  assert.equal(p.byId("attempt-feedback").value, `Mine first.\n\n${answer.text}`, "one answer was added twice");

  p.send(prepared({ ...STARTED, feedbackHelpers: ["useReviewFindings", "useVerificationEvidence"] }));
  p.byId("use-verification-evidence").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "useVerificationEvidence" });
});

// --- the primary action and the debounce ---------------------------------------

test("pressing the primary action drops the form change still waiting on the debounce", () => {
  // The press carries the whole form. The older snapshot the timer holds,
  // arriving after it, would overwrite the host's copy — and the host would
  // put the button back to what it said before the press.
  const p = load();
  p.send(prepared());
  p.byId("issue").value = "JR-12345";
  p.byId("form").dispatch("input", { target: p.byId("issue") });
  p.byId("form").dispatch("submit");
  const press = p.posted.at(-1) as { type: string; form: Record<string, unknown> };
  assert.equal(press.type, "nextAction");
  assert.equal(press.form["issueKey"], "JR-12345");

  p.flush();
  assert.equal(p.posted.at(-1), press, "a form change was sent after the press that already carried it");
});

test("the page never labels the button itself: every push's label wins, in order", () => {
  // The label is the host's answer for the form it holds. A page that
  // remembered "Rebuild Context" once it had seen it, or worked a label out
  // from what was typed, would be a second opinion that can go stale.
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
  p.byId("hint").value = "changed";
  p.byId("form").dispatch("input", { target: p.byId("hint") });
  assert.equal(p.byId("run-label").textContent, "Fix with AI", "the page decided the context was stale");

  p.send(prepared({}, { primary: primaryOf({ prepared: true, stale: true, settled: true }) }));
  assert.equal(p.byId("run-label").textContent, "Rebuild Context");
  assert.match(p.byId("run-icon").className, /codicon-refresh/);
  assert.match(p.byId("run-hint").textContent, /The form changed since this context was prepared/);

  p.send(prepared());
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
});

test("a disabled primary action sends nothing, whichever way it is pressed", () => {
  const p = load();
  p.send(prepared({}, { primary: { ...primaryOf({ prepared: true }), enabled: false } }));
  assert.equal(p.byId("run").disabled, true);
  const before = p.posted.length;
  p.byId("form").dispatch("submit");
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });
  assert.equal(p.posted.length, before);
});

// --- the checklist ---------------------------------------------------------

/** A row's status as the first line shows it: its words, or null while hidden. */
const statusOf = (p: Page, id: string) => (p.byId(`status-${id}`).hidden ? null : p.byId(`status-text-${id}`).textContent);

test("each row carries its status in words, with a mark, and in the accessible name", () => {
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

  assert.equal(p.byId("step-issueDetails").getAttribute("aria-label"), "Issue details: Completed");
  assert.equal(p.byId("step-codeSearch").getAttribute("aria-label"), "Code search: Running");
  // The words, once, on the first line (§37.86)…
  assert.equal(statusOf(p, "issueDetails"), "Completed");
  assert.equal(statusOf(p, "codeSearch"), "Running");
  // …beside a small dot — never a tick or a filled check: the checkbox at the
  // left is the row's only check mark.
  const done = p.byId("mark-issueDetails");
  assert.ok(done.classes.has("step-dot"));
  for (const glyph of ["codicon", "codicon-pass-filled", "codicon-pass", "codicon-check"]) {
    assert.equal(done.classes.has(glyph), false, glyph);
  }
  assert.equal(done.getAttribute("aria-hidden"), undefined, "set in the markup, where it is checked");
  // Running: the spinner alone, no dot beside it.
  const running = p.byId("mark-codeSearch");
  assert.ok(running.classes.has("codicon-loading"));
  assert.ok(running.classes.has("codicon-spin"), "the running row turns");
  assert.equal(running.classes.has("step-dot"), false, "a dot and a spinner at once");
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

test("Build context's actions appear only once its file exists", () => {
  const p = load();
  p.send(state());
  for (const id of ["open-context", "copy-context", "open-folder"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }

  // The step finished but wrote no context: nothing to open, so nothing
  // offered — a disabled icon invites a click that explains nothing.
  p.send(prepared({ artifacts: ["issue.json", "run.json"] }, { workItemActions: ["openFolder"] }));
  assert.equal(statusOf(p, "buildContext"), "Completed");
  assert.equal(p.byId("description-buildContext").hidden, true, "Completed said twice");
  assert.equal(p.byId("actions-buildContext").hidden, true);
  assert.equal(p.byId("open-context").hidden, true);
  assert.equal(p.byId("copy-context").hidden, true);
  // The folder is the work item's, so it does not wait for Build context.
  assert.equal(p.byId("open-folder").hidden, false);

  p.send(prepared());
  assert.equal(p.byId("actions-buildContext").hidden, false);
  assert.equal(p.byId("open-context").hidden, false);
  assert.equal(p.byId("copy-context").hidden, false);
});

test("each artifact action still asks for exactly the action it always did", () => {
  const p = load();
  p.send(prepared());

  for (const [id, action] of [
    ["open-context", "openContext"],
    ["copy-context", "copyContext"],
    ["open-folder", "openFolder"],
  ] as const) {
    p.byId(id).dispatch("click");
    assert.deepEqual(p.posted.at(-1), { type: "action", id: action });
  }
});

test("what happened to the AI step is spelled out on its own row", () => {
  // "AI fix started" against a tick, and which agent on the line below: the
  // icon alone cannot tell a started handoff from a degraded one, and neither
  // can a notification that has already been dismissed.
  const p = load();
  p.send(
    state({
      workflow: [
        step({
          id: "fixWithAI",
          label: "Fix with AI",
          description: "Run the prepared context with your AI coding agent",
          status: "success",
          summary: "AI fix started",
          detail: "Handed to Claude Code in a terminal.",
        }),
      ],
    }),
  );
  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");
  assert.equal(p.byId("detail-fixWithAI").textContent, "Handed to Claude Code in a terminal.");
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
      runError: {
        kind: "jira-access",
        title: "Unable to access Jira",
        message: "Jira rejected the credentials. Run BugPilot: Set Jira Credentials.",
      },
    }),
  );

  assert.equal(p.byId("failure").hidden, false);
  // The card is the host's classification of that failure, not the page's
  // reading of `progress.failure` — which the page no longer looks at.
  assert.equal(p.byId("failure-title").textContent, "Unable to access Jira");
  assert.match(p.byId("failure-message").textContent, /Set Jira Credentials/);
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

// --- fields that grow ------------------------------------------------------

/** A field as layout would hand it over: `rows` height, then content height. */
function sized(p: Page, id: string, rows: number, content: number): FakeElement {
  const element = p.byId(id);
  element.clientHeight = rows;
  element.scrollHeight = content;
  return element;
}

test("a field grows to the height its text needs", () => {
  const p = load();
  const hint = sized(p, "hint", 48, 160);
  p.byId("form").dispatch("input", { target: hint });
  assert.equal(hint.style["height"], "160px");
});

test("a field never shrinks below the height its rows ask for", () => {
  // Deleting the text puts the box back where it started, not down to one line.
  const p = load();
  const keywords = sized(p, "keywords", 40, 18);
  p.byId("form").dispatch("input", { target: keywords });
  assert.equal(keywords.style["height"], "40px");
});

test("a field with no layout is left at auto rather than sized to zero", () => {
  // Hint and Keywords sit inside Advanced settings. While it is closed every
  // height reads 0, and a box pinned to 0px is one that opens up empty.
  const p = load();
  const hint = sized(p, "hint", 0, 0);
  p.byId("form").dispatch("input", { target: hint });
  assert.equal(hint.style["height"], "auto");
});

test("opening Workflow Settings sizes the text already restored into it", () => {
  // The path a hidden webview takes: state is restored into fields that cannot
  // be measured, and opening the page is the first moment they can be.
  const p = load({ form: { ...DEFAULT_FORM, hint: "a paragraph that wrapped" } });
  assert.equal(p.byId("hint").style["height"], "auto", "nothing was measurable yet");

  sized(p, "hint", 48, 210);
  p.byId("open-settings").dispatch("click");
  assert.equal(p.byId("hint").style["height"], "210px");
});

test("a single-line field is not resized", () => {
  const p = load();
  const title = sized(p, "title", 24, 24);
  p.byId("form").dispatch("input", { target: title });
  assert.equal(title.style["height"], undefined);
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
  assert.equal(p.byId("issue").value, "JR-1");

  p.byId("issue").value = "JR-2-being-typed";
  p.send(state({ revision: 1, form: { ...DEFAULT_FORM, issueKey: "JR-1" } }));
  assert.equal(p.byId("issue").value, "JR-2-being-typed", "the host must not stomp on typing");

  p.send(state({ revision: 2, form: { ...DEFAULT_FORM, issueKey: "JR-9" } }));
  assert.equal(p.byId("issue").value, "JR-9", "a deliberate replacement must land");
});

test("a form the host replaces is not overwritten by a change the page had not yet sent", () => {
  // Release stabilization, seen in a real window: the Fresh box ticked just before
  // a History reopen. The debounced formChanged carried the form as it was before
  // the reopen and landed after it, so the host's copy named the previous item
  // while the page showed the reopened one — and the next reopen of that item no
  // longer put its key in the Issue field.
  const p = load();
  p.send(state({ revision: 1, form: { ...DEFAULT_FORM, issueKey: "JR-23456" } }));
  p.byId("fresh").checked = true;
  p.byId("form").dispatch("change", { target: p.byId("fresh") });
  // The host replaces the form (a reopen) before the debounce fires.
  p.send(state({ revision: 2, form: { ...DEFAULT_FORM, issueKey: "JR-12345" } }));
  const before = p.posted.length;
  p.flush();
  const stale = p.posted.slice(before).filter((message) => message["type"] === "formChanged");
  assert.deepEqual(stale, [], "a change made before the host replaced the form was sent after it");
  assert.equal(p.byId("issue").value, "JR-12345");
  // A change made after the replacement is sent as usual.
  p.byId("form").dispatch("change", { target: p.byId("fresh") });
  p.flush();
  assert.equal((p.posted.at(-1)!["form"] as { issueKey: string }).issueKey, "JR-12345");
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

test("a second press refused for the same settings problem opens the page there again", () => {
  // Found in the real window: the problem lives on the settings page, so once
  // the developer had gone back, a second Rebuild Context refused for the same
  // field showed nothing at all — the press looked ignored.
  const refused = () => state({ problems: [{ field: "maxFiles", message: "Enter a whole number." }] });
  const p = load();
  p.send(refused());
  assert.equal(p.byId("workflow-settings-view").hidden, false);
  p.byId("settings-cancel").dispatch("click");

  // An unrelated push with the same problem does not reopen it…
  p.send(refused());
  assert.equal(p.byId("workflow-settings-view").hidden, true, "a push without a press reopened the page");
  // …but a new press that the host refuses again does, at the field.
  p.byId("form").dispatch("submit");
  p.send(refused());
  assert.equal(p.byId("workflow-settings-view").hidden, false, "the second refusal showed nothing");
  assert.equal(p.focused, "maxFiles");

  // The Fix Mode selector's problem, on the form: a second refusal lands on it again.
  const badMode = () => state({ fixModes: MODES, problems: [{ field: "fixModeId", message: '"x" is not a Fix Mode id.' }] });
  const q = load();
  q.send(badMode());
  q.byId("issue").focus();
  q.byId("form").dispatch("submit");
  q.send(badMode());
  assert.equal(q.byId("workflow-settings-view").hidden, true);
  assert.equal(q.focused, "fixModeId");
});

test("a validation problem in a settings field opens Workflow Settings there", () => {
  // A message nobody can see is the same as no message.
  const p = load();
  p.send(state({ problems: [{ field: "maxFiles", message: "Enter a whole number." }] }));
  assert.equal(p.byId("workflow-settings-view").hidden, false);
  assert.ok(p.byId("settings-section-code-search").classes.has("settings-section-target"));
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

test("removing one takes it out of the draft, and out of the form once applied", () => {
  const p = load();
  p.send(
    state({ revision: 2, form: { ...DEFAULT_FORM, attachments: ["/a/one.log", "/b/two.log"] } }),
  );
  p.byId("open-settings").dispatch("click");
  // The × on the first row.
  p.byId("attachment-list").children[0]!.children[1]!.dispatch("click");

  assert.deepEqual(
    p.byId("attachment-list").children.map((row) => row.children[0]!.textContent),
    ["two.log"],
  );
  // A draft: nothing goes to the host until Apply.
  p.flush();
  assert.equal(p.posted.some((message) => message["type"] === "formChanged"), false);
  p.byId("settings-apply").dispatch("click");
  const sent = p.posted.at(-1) as { type: string; form: { attachments: string[] } };
  assert.equal(sent.type, "applySettings");
  assert.deepEqual(sent.form.attachments, ["/b/two.log"]);
});

test("the list is hidden while there is nothing attached", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("attachment-list").hidden, true);
});

test("Add files asks the host for the dialog with the draft's list, and takes the answer once", () => {
  const p = load();
  p.send(state({ revision: 2, form: { ...DEFAULT_FORM, attachments: ["/a/one.log"] } }));
  p.byId("open-settings").dispatch("click");
  p.byId("add-attachment").dispatch("click");
  // Only the host can open a dialog; it gets the list on screen to add to.
  assert.deepEqual(p.posted.at(-1), { type: "pickAttachments", attachments: ["/a/one.log"] });

  const names = () => p.byId("attachment-list").children.map((row) => row.children[0]!.textContent);
  p.send(state({ attachmentPick: { token: 1, attachments: ["/a/one.log", "/b/two.log"] } }));
  assert.deepEqual(names(), ["one.log", "two.log"]);
  // The draft's, not the form's: a press now still sends the applied list.
  p.byId("form").dispatch("submit");
  assert.deepEqual((p.posted.at(-1)!["form"] as { attachments: string[] }).attachments, ["/a/one.log"]);
  // Taken once: the same answer pushed again adds nothing back.
  p.byId("attachment-list").children[1]!.children[1]!.dispatch("click");
  p.send(state({ attachmentPick: { token: 1, attachments: ["/a/one.log", "/b/two.log"] } }));
  assert.deepEqual(names(), ["one.log"]);
});

test("an attachment answer that arrives after the page closed changes nothing", () => {
  const p = load();
  p.send(state({ revision: 2, form: { ...DEFAULT_FORM, attachments: ["/a/one.log"] } }));
  p.byId("open-settings").dispatch("click");
  p.byId("add-attachment").dispatch("click");
  p.byId("settings-cancel").dispatch("click");
  p.send(state({ attachmentPick: { token: 1, attachments: ["/a/one.log", "/b/two.log"] } }));
  p.byId("form").dispatch("submit");
  assert.deepEqual((p.posted.at(-1)!["form"] as { attachments: string[] }).attachments, ["/a/one.log"]);
  p.byId("open-settings").dispatch("click");
  assert.equal(p.byId("attachment-list").children.length, 1);
});

// --- fix mode --------------------------------------------------------------

const MODES = {
  kind: "ready" as const,
  defaultModeId: "standard",
  modes: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default workflow for most bugs.",
      version: 1,
      source: "builtin",
      executionKind: "fix" as const,
    },
    {
      id: "investigate-first",
      name: "Investigate First",
      description: "Diagnose and propose a fix plan.",
      version: 1,
      source: "builtin",
      executionKind: "investigate" as const,
    },
  ],
};

test("the Fix Mode options come from the host, not from the page", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  const select = page.byId("fixModeId");
  assert.deepEqual(
    select.children.map((option) => option.value),
    ["standard", "investigate-first"],
  );
  assert.deepEqual(
    select.children.map((option) => option.textContent),
    ["Standard Fix", "Investigate First"],
  );
  assert.equal(select.disabled, false);
});

test("the selected mode's description is shown under the selector", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));

  assert.equal(page.byId("fixModeId-description").textContent, "Default workflow for most bugs.");
});

test("an investigation mode says so before anything runs", () => {
  const page = load();
  page.send(
    state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }),
  );

  const note = page.byId("fixModeId-description").textContent;
  assert.match(note, /Investigation only/);
  assert.match(note, /no source changes in this pass/);
  // Said in words, not by colour alone.
  assert.match(note, /Diagnose and propose a fix plan/);
});

test("changing the selection updates the description immediately", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));

  page.byId("fixModeId").value = "investigate-first";
  page.byId("form").dispatch("change", { target: page.byId("fixModeId") });

  assert.match(page.byId("fixModeId-description").textContent, /Investigation only/);
});

test("the selector is disabled until the catalog arrives", () => {
  const page = load();
  page.send(state({ fixModes: { kind: "loading" } }));

  assert.equal(page.byId("fixModeId").disabled, true);
  assert.equal(page.byId("fixModeId").children[0]?.textContent, "Loading Fix Modes…");
});

test("a bugpilot without Fix Modes explains itself instead of offering a list", () => {
  const page = load();
  page.send(
    state({
      fixModes: {
        kind: "unavailable",
        detail: "This BugPilot version does not expose AI Fix Modes. Update BugPilot to choose one.",
      },
    }),
  );

  assert.equal(page.byId("fixModeId").disabled, true);
  assert.match(page.byId("fixModeId-description").textContent, /does not expose AI Fix Modes/);
  assert.ok(page.byId("field-fixModeId").classes.has("field-invalid"));
  // And the page still lets the developer run: Standard is the CLI's default.
  assert.equal(page.byId("run").disabled, false);
});

test("the run message carries the applied Fix Mode", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  applyOnPage(page, () => {
    page.byId("fixModeId").value = "investigate-first";
  });
  page.byId("form").dispatch("submit");

  const run = page.posted.find((message) => isRunPress(message));
  assert.equal((run?.["form"] as { fixModeId?: string } | undefined)?.fixModeId, "investigate-first");
});

// --- Batch 7, and Workflow Settings: where the Fix Mode selector lives -----

/** The same catalog with a project custom mode in it, as `fix-mode list --json` reports one. */
const WITH_CUSTOM = {
  ...MODES,
  modes: [
    ...MODES.modes,
    {
      id: "team-safe",
      name: "Team Safe Fix",
      description: "Our conservative variant.",
      version: 1,
      source: "project",
      executionKind: "fix" as const,
    },
  ],
};

/** The form of the last run message the page sent. */
const lastRun = (page: Page) =>
  page.posted.filter((message) => isRunPress(message)).at(-1)?.["form"] as
    | { fixModeId?: string }
    | undefined;

test("Workflow Settings starts closed, and the selector on it is already filled in", () => {
  // Placement is visual. A closed page still holds the real selection and its
  // description, so opening it shows what Run will use.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));

  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.match(page.byId("fixModeId-description").textContent, /Investigation only/);
});

test("with nothing chosen, the closed selector holds the default the CLI declared, and Run sends it", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.byId("fixModeId").value, "standard");
  page.byId("form").dispatch("submit");
  assert.equal(lastRun(page)?.fixModeId, "standard");
});

test("a mode applied on the settings page is the one Run sends, whatever pushes arrive after", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  applyOnPage(page, () => {
    page.byId("fixModeId").value = "investigate-first";
    page.byId("workflow-settings-view").dispatch("change", { target: page.byId("fixModeId") });
  });

  // Pushes keep arriving — every stream event is one — and none of them may
  // reset the choice: not a plain push, and not one that carries the host's
  // older copy of the form under the same revision.
  page.send(state({ fixModes: MODES }));
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.equal(page.byId("fixModeId").value, "investigate-first", "a same-revision push reset the choice");
  page.byId("form").dispatch("submit");

  assert.equal(lastRun(page)?.fixModeId, "investigate-first");
  // And it is what the page persisted, so a reloaded panel starts from it.
  const stored = page.stored.at(-1) as { form?: { fixModeId?: string } } | undefined;
  assert.equal(stored?.form?.fixModeId, "investigate-first");
});

test("Ctrl+Enter from the Issue field uses the applied mode too", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  page.byId("issue").value = "JR-12345";
  page.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });

  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(lastRun(page)?.fixModeId, "investigate-first");
});

test("a restored custom mode is what the closed section holds, and what Run sends", () => {
  const page = load();
  page.send(state({ fixModes: WITH_CUSTOM, form: { ...DEFAULT_FORM, fixModeId: "team-safe" } }));

  assert.deepEqual(
    page.byId("fixModeId").children.map((option) => option.value),
    ["standard", "investigate-first", "team-safe"],
  );
  assert.equal(page.byId("fixModeId").value, "team-safe");
  assert.equal(page.byId("fixModeId-description").textContent, "Our conservative variant.");
  page.byId("form").dispatch("submit");
  assert.equal(lastRun(page)?.fixModeId, "team-safe");
});

test("a problem with the chosen mode lands on the selector on the form, once", () => {
  const problem = { field: "fixModeId" as const, message: '"bad id" is not a Fix Mode id. Pick one from the list.' };
  const withProblem = () =>
    state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" }, problems: [problem] });
  const page = load();
  page.send(withProblem());

  // On the form, where the selector is: the settings page stays shut.
  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.focused, "fixModeId");
  assert.equal(page.byId("fixModeId-description").textContent, problem.message);
  assert.ok(page.byId("field-fixModeId").classes.has("field-invalid"));
  assert.equal(page.byId("fixModeId").getAttribute("aria-invalid"), "true");

  // Once: the same problem pushed again does not pull the focus back.
  page.byId("issue").focus();
  page.send(withProblem());
  assert.equal(page.focused, "issue");
});

test("an unavailable catalog is explained on the settings page, and does not force it open", () => {
  // Not a problem with anything the developer chose — Run still works on the
  // CLI's default — so it is said where Fix Mode lives, not pushed in their face.
  const page = load();
  page.send(state({ fixModes: { kind: "unavailable", detail: "AI Fix Modes could not be read." } }));

  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.byId("fixModeId-description").textContent, "AI Fix Modes could not be read.");
  assert.equal(page.byId("run").disabled, false);
});

test("coming back from Manage Fix Modes returns to the form, on the gear, with the Hint as it was", () => {
  // The gear is beside the selector on the form, so that is where the way back goes.
  const page = load();
  page.send(state({ fixModes: MODES }));
  page.byId("hint").value = "typed before managing modes";
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  assert.equal(page.byId("main-view").hidden, true);

  page.send(state({ fixModes: MODES }));
  assert.equal(page.byId("main-view").hidden, false);
  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.focused, "manage-fix-modes");
  assert.equal(page.byId("hint").value, "typed before managing modes");
});

test("a manager a reloaded panel restored goes back to the form, on the Fix Mode gear", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  page.send(state({ fixModes: MODES }));
  assert.equal(page.byId("main-view").hidden, false);
  assert.equal(page.focused, "manage-fix-modes");
});

test("opening the panel on the form does not open Workflow Settings", () => {
  // Only a gear, the entry or a problem in a settings field does; a panel that
  // loads, or a run that starts, leaves the form on screen.
  const page = load();
  page.send(state({ fixModes: MODES }));
  page.send(state({ fixModes: MODES, progress: { state: "running", rows: [], artifacts: [] } }));
  page.send(prepared({}, { fixModes: MODES }));

  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(page.byId("main-view").hidden, false);
});

/** What Run would send, pressed now. */
const runMode = (page: Page) => {
  page.byId("form").dispatch("submit");
  return lastRun(page)?.fixModeId;
};

test("Fix Mode on the form: a restored mode shows in the selector, and Run sends it", () => {
  // The host restores the mode a work item was prepared with — a new form
  // revision, no click. The selector on the form is where it shows (§37.84).
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.equal(page.byId("fixModeId").value, "standard");

  page.send(state({ revision: 2, fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.equal(page.byId("workflow-settings-view").hidden, true);
  assert.equal(runMode(page), "investigate-first");

  // Another work item that resets to the default: the selector follows.
  page.send(state({ revision: 3, fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.equal(page.byId("fixModeId").value, "standard");
});

test("Fix Mode on the form: a custom mode is chosen by its display name; a deleted one falls back to the default", () => {
  const page = load();
  page.send(state({ fixModes: WITH_CUSTOM, form: { ...DEFAULT_FORM, fixModeId: "team-safe" } }));
  assert.equal(page.byId("fixModeId").value, "team-safe");
  assert.equal(runMode(page), "team-safe");
  page.send(state({ fixModes: MODES }));
  assert.equal(page.byId("fixModeId").value, "standard");
  assert.equal(runMode(page), "standard");
});

test("Fix Mode on the form: no catalog, no mode — the selector waits, and Run sends none", () => {
  for (const fixModes of [
    { kind: "loading" as const },
    { kind: "unavailable" as const, detail: "AI Fix Modes could not be read." },
  ]) {
    const page = load();
    page.send(state({ fixModes, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
    assert.equal(page.byId("fixModeId").disabled, true, fixModes.kind);
    assert.equal(runMode(page), "", fixModes.kind);
  }
});

test("Fix Mode and Hint are form fields: an edit reaches the host as a form change — no Apply, no run", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, issueKey: "JR-12345", fixModeId: "standard" } }));
  const before = page.posted.length;

  page.byId("fixModeId").value = "investigate-first";
  page.byId("form").dispatch("change", { target: page.byId("fixModeId") });
  page.byId("hint").value = "look at the reader";
  page.byId("form").dispatch("input", { target: page.byId("hint") });
  page.byId("useIssueDetails").checked = false;
  page.byId("form").dispatch("change", { target: page.byId("useIssueDetails") });
  page.flush();

  const changes = page.posted.slice(before).filter((message) => message["type"] === "formChanged");
  const form = changes.at(-1)!["form"] as { fixModeId: string; hint: string; useIssueDetails: boolean };
  assert.equal(form.fixModeId, "investigate-first");
  assert.equal(form.hint, "look at the reader");
  assert.equal(form.useIssueDetails, false);
  // The mode's description follows the selector at once.
  assert.match(page.byId("fixModeId-description").textContent, /Investigation only/);
  // Nothing started, and the settings page never opened.
  assert.equal(page.posted.slice(before).some((message) => isRunPress(message) || message["type"] === "applySettings"), false);
  assert.equal(page.byId("workflow-settings-view").hidden, true);
});

test("an applied settings change keeps the Fix Mode and Hint as they are on the form", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  page.byId("fixModeId").value = "investigate-first";
  page.byId("hint").value = "typed on the form";
  applyOnPage(page, () => {
    page.byId("keywords").value = "cache";
  });
  const applied = page.posted.filter((message) => message["type"] === "applySettings").at(-1)!["form"] as {
    fixModeId: string;
    hint: string;
    keywords: string;
  };
  assert.deepEqual([applied.fixModeId, applied.hint, applied.keywords], ["investigate-first", "typed on the form", "cache"]);
  // Cancel on the settings page does not touch them either.
  page.byId("open-settings").dispatch("click");
  page.byId("settings-cancel").dispatch("click");
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.equal(page.byId("hint").value, "typed on the form");
});

test("the Strategy line reports the package, not the selector", () => {
  // They differ the moment somebody changes the dropdown without running, and
  // labelling an old package with a new choice would misdescribe what the agent
  // was told. The host composes the line; the page shows it on the Fix with AI
  // row, whose task carries the mode.
  const page = load();
  page.send(
    prepared(
      { strategy: "Investigate First · investigation only" },
      { fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } },
    ),
  );

  assert.equal(page.byId("strategy-fixWithAI").hidden, false);
  assert.equal(
    page.byId("strategy-fixWithAI-value").textContent,
    "Investigate First · investigation only",
  );
  // The selector still shows what the *next* run would use.
  assert.equal(page.byId("fixModeId").value, "standard");
});

test("a package with no recorded mode shows no Strategy line", () => {
  const page = load();
  page.send(prepared({}, { fixModes: MODES }));

  assert.equal(page.byId("strategy-fixWithAI").hidden, true);
});

test("a Strategy line waits for the task it describes", () => {
  // Mid-run, the task on disk is the last run's; naming its mode beside a row
  // still waiting for the new one would describe the wrong package.
  const progress: ProgressView = { state: "running", rows: [row("code_search", "running")], artifacts: [] };
  const page = load();
  page.send(
    state({
      progress,
      workflow: buildWorkflow({
        source: "jira",
        plan: DEFAULT_FORM.plan,
        fixWithAI: false,
        progress,
        artifacts: PREPARED_FILES,
        strategy: "Standard Fix",
      }),
    }),
  );
  assert.equal(page.byId("strategy-fixWithAI").hidden, true);
  assert.equal(page.byId("artifact-fixWithAI").hidden, true, "the last run's task was offered");
});

// --- the management view -----------------------------------------------------

const MANAGED_READY = {
  kind: "ready" as const,
  builtin: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default.",
      version: 1,
      source: "builtin",
      executionKind: "fix" as const,
      scope: "builtin",
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
      executionKind: "fix" as const,
      scope: "user",
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
      executionKind: "investigate" as const,
      scope: "project",
      effective: true,
    },
  ],
  issues: [],
};

const DRAFT = {
  intent: "edit" as const,
  id: "my-safe",
  name: "My Safe Fix",
  description: "Mine.",
  executionKind: "fix" as const,
  objective: "Objective.",
  investigation: "Investigation.",
  implementation: "Implementation.",
  verification: "Verification.",
  constraints: "Constraints.",
  completion: "Completion.",
  scope: "user" as const,
  source: "user",
  version: 3,
  basedOn: "standard",
  basedOnVersion: 1,
};

test("the management view is hidden until the host opens it", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  assert.equal(page.byId("fix-mode-manager-view").hidden, true);

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  assert.equal(page.byId("fix-mode-manager-view").hidden, false);
});

test("the gear asks the host to open it", () => {
  const page = load();
  page.byId("manage-fix-modes").dispatch("click");

  assert.ok(page.posted.some((message) => message["type"] === "manageFixModes"));
});

test("both definitions of a shadowed id are listed, and which one runs is said in words", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));

  const text = JSON.stringify(page.byId("manage-list"));
  assert.ok(text.includes("My Safe Fix"), "the user's own copy is missing");
  assert.ok(text.includes("Team Safe Fix"), "the project copy is missing");
  assert.ok(text.includes("overridden by project"), "nothing says which one runs");
  assert.ok(text.includes("investigation only"), "the investigation kind is not shown");
});

test("a built-in offers view and duplicate, a custom mode offers edit and delete", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));

  const labels = JSON.stringify(page.byId("manage-list"));
  assert.ok(labels.includes("Duplicate & Customize"));
  assert.ok(labels.includes("Edit"));
  assert.ok(labels.includes("Delete"));
});

test("the editor fills every section and fixes what may not change", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));

  assert.equal(page.byId("fix-mode-editor-view").hidden, false);
  assert.equal(page.byId("editor-objective").value, "Objective.");
  assert.equal(page.byId("editor-completion").value, "Completion.");
  assert.equal(page.byId("editor-name").value, "My Safe Fix");
  // An id names what every prepared work item recorded; a scope is the
  // directory the file lives in. Neither moves on an existing mode.
  assert.equal(page.byId("editor-id").disabled, true);
  assert.equal(page.byId("editor-scope").disabled, true);
  assert.equal(page.byId("editor-name").disabled, false);
  assert.match(page.byId("editor-origin").textContent, /Based on standard version 1/);
  assert.match(page.byId("editor-origin").textContent, /Current version 3/);
});

test("a new mode may choose its id and scope", () => {
  const page = load();
  page.send(
    state({
      fixModes: MODES,
      manage: { catalog: MANAGED_READY, editor: { ...DRAFT, intent: "create", version: 0 } },
    }),
  );

  assert.equal(page.byId("editor-id").disabled, false);
  assert.equal(page.byId("editor-scope").disabled, false);
  assert.equal(page.byId("editor-save").textContent, "Create Fix Mode");
});

test("a built-in is shown as something to read, not a form to fail to type into", () => {
  // It used to open the editor with every box disabled, which reads as an edit
  // the developer is being refused. Reading a mode is now its own view.
  const page = load();
  page.send(
    state({
      fixModes: MODES,
      manage: {
        catalog: MANAGED_READY,
        editor: { ...DRAFT, intent: "view", source: "builtin", name: "Standard Fix" },
      },
    }),
  );

  assert.equal(page.byId("fix-mode-preview-view").hidden, false);
  assert.equal(page.byId("fix-mode-editor-view").hidden, true);
  assert.equal(page.byId("preview-heading").textContent, "Standard Fix");
  assert.match(page.byId("preview-meta").textContent, /Built-in/);
  const body = JSON.stringify(page.byId("preview-body"));
  assert.ok(body.includes("Objective"), "the preview does not show the instructions");
  assert.ok(body.includes("Objective."), "the preview does not show the mode's own text");

  // A built-in is copied, never written.
  const actions = JSON.stringify(page.byId("preview-actions"));
  assert.ok(actions.includes("Duplicate & Customize"));
  assert.ok(!actions.includes("Edit"), "a built-in offers an edit");
  assert.ok(!actions.includes("Delete"), "a built-in offers a delete");
});

test("saving sends what the editor holds, not what it was opened with", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));
  page.byId("editor-objective").value = "Edited objective.";
  page.byId("editor-save").dispatch("click");

  const save = page.posted.find((message) => message["type"] === "saveFixMode");
  const draft = save?.["draft"] as Record<string, unknown>;
  assert.equal(draft["objective"], "Edited objective.");
  assert.equal(draft["version"], 3, "the version it was opened at must come back");
  assert.equal(draft["intent"], "edit");
});

test("the preview shows the mode's own instructions and says so", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));

  page.byId("editor-preview").dispatch("click");

  assert.equal(page.byId("editor-preview-pane").hidden, false);
  const preview = JSON.stringify(page.byId("editor-preview-body"));
  assert.ok(preview.includes("Objective."));
  assert.ok(preview.includes("Completion Requirements"));
  // BugPilot's own sections are not the developer's to edit, so they are not
  // shown here as though they were.
  assert.ok(!preview.includes("Forbidden Actions"));
  assert.ok(!preview.includes("Delivery Safety"));
});

test("an unreadable custom file is reported without emptying the list", () => {
  const page = load();
  page.send(
    state({
      fixModes: MODES,
      manage: {
        catalog: {
          ...MANAGED_READY,
          issues: [{ scope: "project", path: "/repo/.bugpilot/fix_modes/x.json", message: "bad" }],
        },
      },
    }),
  );

  const text = JSON.stringify(page.byId("manage-list"));
  assert.ok(text.includes("x.json"), "the path a developer has to open is missing");
  assert.ok(text.includes("My Safe Fix"), "one broken file emptied the list");
});

test("a refused command is shown beside the editor", () => {
  // On the editor's own view: the editor is what stays open when a save is
  // refused, so a reason left on the manager would be on a hidden page.
  const page = load();
  page.send(
    state({
      fixModes: MODES,
      manage: { catalog: MANAGED_READY, editor: DRAFT, error: "Reload it before saving." },
    }),
  );

  assert.equal(page.byId("editor-error").hidden, false);
  assert.match(page.byId("editor-error").textContent, /Reload it before saving/);
});

test("whatever the host says about the mode is what the line shows", () => {
  // The three states — available, gone, not checked — are the host's to tell
  // apart; UI-A3 moved that sentence out of the page along with the line. The
  // page must not edit it, which is what this pins.
  for (const strategy of [
    "My Safe Fix · availability unknown",
    "Team Safe Fix (unavailable)",
    "Standard Fix",
  ]) {
    const page = load();
    page.send(prepared({ strategy }, { fixModes: MODES }));
    assert.equal(page.byId("strategy-fixWithAI-value").textContent, strategy);
  }
});

// --- moving between the panel's three views ---------------------------------

/**
 * The views, and the rule that holds for all of them: exactly one is on screen.
 *
 * Asserted as a list rather than three `hidden` checks, because the failure
 * worth catching is two of them being visible at once — which reads as the old
 * behaviour, a manager appended below the form.
 */
const VIEWS = [
  "main-view",
  "fix-mode-manager-view",
  "fix-mode-preview-view",
  // New and Edit share this one; the title is what tells them apart.
  "fix-mode-editor-view",
];

function visible(page: Page): string[] {
  return VIEWS.filter((id) => !page.byId(id).hidden);
}

test("the panel starts on the form, with both Fix Mode views out of the way", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  assert.deepEqual(visible(page), ["main-view"]);
});

test("opening the manager replaces the form instead of appearing under it", () => {
  // The whole point of the change: the catalogue used to unhide *below* the
  // form, which in a 300px sidebar is off-screen — pressing the gear looked
  // like it had done nothing.
  const page = load();
  page.send(state({ fixModes: MODES }));

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
});

test("opening a mode replaces the manager with the editor", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));

  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
});

test("every state the host can push shows exactly one view", () => {
  const page = load();
  for (const manage of [
    undefined,
    { catalog: { kind: "loading" as const } },
    { catalog: MANAGED_READY },
    { catalog: MANAGED_READY, editor: DRAFT },
    { catalog: MANAGED_READY, editor: DRAFT, error: "refused" },
    { catalog: { kind: "unavailable" as const, detail: "no" }, error: "refused" },
  ]) {
    page.send(state({ fixModes: MODES, ...(manage ? { manage } : {}) }));
    assert.equal(visible(page).length, 1, JSON.stringify(manage));
  }
});

test("each of the five views hides all three of the others", () => {
  // Spelled out per view rather than counted, because the regression manual
  // testing found was not "two views visible" in the abstract — it was the
  // manager, the preview and the editor all laid out under the form at once,
  // before anything had been clicked.
  const page = load();
  const shows = (expected: string) => {
    for (const id of VIEWS) {
      assert.equal(
        page.byId(id).hidden,
        id !== expected,
        `${id} should be ${id === expected ? "visible" : "hidden"} while showing ${expected}`,
      );
    }
  };

  page.send(state({ fixModes: MODES }));
  shows("main-view");

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  shows("fix-mode-manager-view");

  page.send(opened({ ...DRAFT, intent: "view", source: "builtin" }));
  shows("fix-mode-preview-view");

  page.send(opened({ ...DRAFT, intent: "create", version: 0 }));
  shows("fix-mode-editor-view");

  page.send(opened(DRAFT)); // intent: edit
  shows("fix-mode-editor-view");

  page.send(state({ fixModes: MODES }));
  shows("main-view");
});

test("the back controls ask for one step each, never for a reset", () => {
  // Editor to manager, manager to form. Two destinations, so no history stack.
  const page = load();
  const before = page.posted.length; // the page says "ready" when it loads

  page.byId("editor-back").dispatch("click");
  page.byId("manage-back").dispatch("click");

  assert.deepEqual(
    page.posted.slice(before).map((message) => message["type"]),
    ["manageFixModes", "closeFixModes"],
  );
});

test("each view takes focus as it opens, and the gear gets it back", () => {
  // Otherwise the caret stays on a control that is no longer on screen, and a
  // screen reader never hears that the panel became something else.
  const page = load();
  page.send(state({ fixModes: MODES }));

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  assert.equal(page.focused, "manage-heading");

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));
  assert.equal(page.focused, "editor-title");

  // From the form, where the gear is, and back to it.
  page.send(state({ fixModes: MODES }));
  assert.equal(page.focused, "manage-fix-modes");
});

test("going to the manager and back leaves the form exactly as it was", () => {
  // Navigation is a view change and nothing else: it must not re-write the
  // form, reset the chosen mode, or tell the host anything happened.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  const before = page.posted.length;

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  page.send(state({ fixModes: MODES }));

  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.deepEqual(page.posted.slice(before), [], "navigation told the host something");
});

test("the manager opens on its own loading line rather than leaving the form up", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  page.send(state({ fixModes: MODES, manage: { catalog: { kind: "loading" } } }));

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
  assert.match(page.byId("manage-detail").textContent, /Reading Fix Modes/);
});

test("a refused save keeps the editor up, with what was typed still in it", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));

  page.send(
    state({
      fixModes: MODES,
      manage: { catalog: MANAGED_READY, editor: DRAFT, error: "Version 3 was expected." },
    }),
  );

  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.match(page.byId("editor-error").textContent, /Version 3 was expected/);
  assert.equal(page.byId("editor-name").value, "My Safe Fix");
  assert.equal(page.byId("editor-objective").value, "Objective.");
});

test("a failed management command does not drop the developer back on the form", () => {
  const page = load();
  page.send(
    state({
      fixModes: MODES,
      manage: { catalog: MANAGED_READY, error: "Fix Mode storage is not writable." },
    }),
  );

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
  assert.equal(page.byId("manage-error").hidden, false);
  assert.match(page.byId("manage-error").textContent, /not writable/);
});

test("a saved mode lands back on the manager, with the catalogue it refreshed", () => {
  // The round trip every CRUD action makes: the manager opens the editor, and
  // the host closing the editor is what brings the manager back. The page does
  // not decide that — it follows the state it is given.
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, editor: DRAFT } }));
  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);

  const saved = {
    ...MANAGED_READY,
    user: [{ ...MANAGED_READY.user[0]!, name: "Renamed Fix", version: 4 }],
  };
  page.send(state({ fixModes: MODES, manage: { catalog: saved } }));

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
  assert.match(JSON.stringify(page.byId("manage-list")), /Renamed Fix/);
});

// --- reading a mode, and copying it from either place ------------------------

function flatten(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** The button a developer would press on the row for `mode`. */
function rowAction(page: Page, mode: string, label: string): FakeElement {
  const rows = flatten(page.byId("manage-list")).filter((node) => node.classes.has("manage-row"));
  const row = rows.find((candidate) =>
    flatten(candidate).some((node) => node.textContent.includes(mode)),
  );
  assert.ok(row, `the manager has no row for ${mode}`);
  const button = flatten(row).find((node) => node.textContent === label);
  assert.ok(button, `the row for ${mode} has no ${label}`);
  return button;
}

function previewAction(page: Page, label: string): FakeElement {
  const button = flatten(page.byId("preview-actions")).find((node) => node.textContent === label);
  assert.ok(button, `the preview has no ${label}`);
  return button;
}

const manager = () => state({ fixModes: MODES, manage: { catalog: MANAGED_READY } });
const opened = (editor: FixModeDraft, error?: string) =>
  state({
    fixModes: MODES,
    manage: { catalog: MANAGED_READY, editor, ...(error === undefined ? {} : { error }) },
  });

const BUILTIN_VIEW = {
  ...DRAFT,
  intent: "view" as const,
  id: "standard",
  name: "Standard Fix",
  source: "builtin",
};
const CUSTOM_VIEW = { ...DRAFT, intent: "view" as const, source: "user" };
/** What the controller builds for Duplicate & Customize on a built-in. */
const COPY = {
  ...DRAFT,
  intent: "create" as const,
  id: "my-standard",
  name: "Standard Fix (copy)",
  version: 0,
  basedOn: "standard",
  basedOnVersion: 1,
  source: "builtin",
};

test("the manager opens with no preview and no editor behind it", () => {
  const page = load();
  page.send(manager());

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
});

test("a built-in row offers reading and copying; a custom row offers all four", () => {
  const page = load();
  page.send(manager());

  for (const label of ["View", "Duplicate & Customize"]) rowAction(page, "Standard Fix", label);
  for (const label of ["View", "Edit", "Duplicate", "Delete"]) {
    rowAction(page, "My Safe Fix", label);
  }
});

test("View opens the preview on its own", () => {
  const page = load();
  page.send(manager());

  rowAction(page, "Standard Fix", "View").dispatch("click");
  assert.deepEqual(page.posted.at(-1), {
    type: "fixModeAction",
    action: "view",
    id: "standard",
    scope: "builtin",
  });

  page.send(opened(BUILTIN_VIEW));
  assert.deepEqual(visible(page), ["fix-mode-preview-view"]);
  assert.equal(page.focused, "preview-heading");
});

test("a custom mode's preview offers edit, duplicate and delete", () => {
  const page = load();
  page.send(opened(CUSTOM_VIEW));

  const actions = JSON.stringify(page.byId("preview-actions"));
  for (const label of ["Edit", "Duplicate", "Delete"]) {
    assert.ok(actions.includes(label), `the custom preview has no ${label}`);
  }
  // Addressed by the scope that owns it, which on a draft is `source`: `scope`
  // is where a save would go and is never "builtin".
  previewAction(page, "Edit").dispatch("click");
  assert.deepEqual(page.posted.at(-1), {
    type: "fixModeAction",
    action: "edit",
    id: "my-safe",
    scope: "user",
  });
});

test("duplicating from the manager opens New Fix Mode and comes back to the manager", () => {
  const page = load();
  page.send(manager());
  rowAction(page, "Standard Fix", "Duplicate & Customize").dispatch("click");

  page.send(opened(COPY));
  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-title").textContent, "New Fix Mode");
  assert.equal(page.byId("editor-back-label").textContent, "Back to Fix Mode Manager");

  page.byId("editor-cancel").dispatch("click");
  page.send(manager()); // the host dropped the draft
  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
});

test("duplicating from a preview comes back to the preview, not the list", () => {
  // The distinction the origin exists for: one editor, reached two ways, has to
  // return to whichever place opened it.
  const page = load();
  page.send(manager());
  rowAction(page, "Standard Fix", "View").dispatch("click");
  page.send(opened(BUILTIN_VIEW));

  previewAction(page, "Duplicate & Customize").dispatch("click");
  page.send(opened(COPY));
  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-back-label").textContent, "Back to Fix Mode Preview");

  page.byId("editor-save").dispatch("click");
  page.send(manager()); // a successful create closes the editor
  assert.deepEqual(visible(page), ["fix-mode-preview-view"]);
  assert.equal(page.byId("preview-heading").textContent, "Standard Fix");
});

test("Back out of a preview-born duplicate also returns to the preview", () => {
  const page = load();
  page.send(opened(BUILTIN_VIEW));
  previewAction(page, "Duplicate & Customize").dispatch("click");
  page.send(opened(COPY));

  page.byId("editor-back").dispatch("click");
  page.send(manager());

  assert.deepEqual(visible(page), ["fix-mode-preview-view"]);
});

test("both ways into New Fix Mode are the same editor", () => {
  // One editor, or the two routes drift and only one of them keeps based_on.
  const fromManager = load();
  fromManager.send(manager());
  rowAction(fromManager, "Standard Fix", "Duplicate & Customize").dispatch("click");
  fromManager.send(opened(COPY));
  fromManager.byId("editor-save").dispatch("click");

  const fromPreview = load();
  fromPreview.send(opened(BUILTIN_VIEW));
  previewAction(fromPreview, "Duplicate & Customize").dispatch("click");
  fromPreview.send(opened(COPY));
  fromPreview.byId("editor-save").dispatch("click");

  const saved = (page: Page) => page.posted.find((message) => message["type"] === "saveFixMode");
  assert.deepEqual(saved(fromManager), saved(fromPreview));
});

test("Edit opens Edit Fix Mode, and never New", () => {
  const page = load();
  page.send(manager());
  rowAction(page, "My Safe Fix", "Edit").dispatch("click");

  page.send(opened(DRAFT));
  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-title").textContent, "Edit Fix Mode");
  assert.equal(page.byId("editor-back-label").textContent, "Back to Fix Mode Manager");
  assert.match(page.byId("editor-origin").textContent, /My Safe Fix/);

  page.byId("editor-save").dispatch("click");
  page.send(manager());
  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
});

test("a refused create keeps New Fix Mode up, and still remembers the preview", () => {
  const page = load();
  page.send(opened(BUILTIN_VIEW));
  previewAction(page, "Duplicate & Customize").dispatch("click");
  page.send(opened(COPY));

  page.byId("editor-objective").value = "Edited before saving.";
  page.byId("editor-save").dispatch("click");
  // The host keeps the draft it was sent, and says why it was refused.
  page.send(opened({ ...COPY, objective: "Edited before saving." }, "That id is already taken."));

  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-error").hidden, false);
  assert.match(page.byId("editor-error").textContent, /already taken/);
  assert.equal(page.byId("editor-objective").value, "Edited before saving.");

  page.byId("editor-cancel").dispatch("click");
  page.send(manager());
  assert.deepEqual(visible(page), ["fix-mode-preview-view"], "the origin was forgotten");
});

test("the chosen Fix Mode survives the whole management walk", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  const before = page.posted.length;

  page.send(manager());
  page.send(opened(BUILTIN_VIEW));
  page.send(opened(COPY));
  page.send(manager());
  page.send(state({ fixModes: MODES }));

  assert.deepEqual(visible(page), ["main-view"]);
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.deepEqual(page.posted.slice(before), [], "navigation told the host something");
});

// --- confirming a create, and finding what it wrote --------------------------

function rowFor(page: Page, name: string): FakeElement {
  const rows = flatten(page.byId("manage-list")).filter((node) => node.classes.has("manage-row"));
  const row = rows.find((candidate) =>
    flatten(candidate).some((node) => node.textContent.includes(name)),
  );
  assert.ok(row, `the manager has no row for ${name}`);
  return row;
}

const CREATED = { id: "my-safe", scope: "project", name: "Team Safe Fix" };

test("a created mode is confirmed in words, not only in a notification", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, created: CREATED } }));

  assert.deepEqual(visible(page), ["fix-mode-manager-view"]);
  assert.equal(page.byId("manage-success").hidden, false);
  assert.match(page.byId("manage-success").textContent, /Team Safe Fix/);
  assert.match(page.byId("manage-success").textContent, /created successfully/);
  // And it is not dressed as a failure.
  assert.equal(page.byId("manage-error").hidden, true);
});

test("the created row is the one with that id in that scope", () => {
  // `my-safe` exists in both the user and the project scope. A create that
  // wrote the project one must not light up the user's.
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, created: CREATED } }));

  assert.ok(
    rowFor(page, "Team Safe Fix").classes.has("recently-created"),
    "the project row was not marked",
  );
  assert.ok(
    !rowFor(page, "My Safe Fix").classes.has("recently-created"),
    "the user's row of the same id was marked instead",
  );
});

test("the created row is brought into view, once", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, created: CREATED } }));

  const row = rowFor(page, "Team Safe Fix");
  assert.ok(row.scrolledIntoView, "the new row was never scrolled to");
  assert.equal(row.scrolledIntoView["block"], "center");

  // A catalog refresh pushes state again; the list must not keep dragging
  // itself back while the developer is reading it.
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, created: CREATED } }));
  assert.equal(rowFor(page, "Team Safe Fix").scrolledIntoView, undefined, "it scrolled again");
});

test("nothing is marked or scrolled when no mode was created", () => {
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));

  assert.equal(page.byId("manage-success").hidden, true);
  for (const name of ["Team Safe Fix", "My Safe Fix", "Standard Fix"]) {
    assert.ok(!rowFor(page, name).classes.has("recently-created"), `${name} was marked`);
  }
});

test("a refused create says nothing about success", () => {
  const page = load();
  page.send(opened(BUILTIN_VIEW));
  previewAction(page, "Duplicate & Customize").dispatch("click");
  page.send(opened(COPY));
  page.byId("editor-objective").value = "Typed before the refusal.";
  page.byId("editor-save").dispatch("click");

  page.send(opened({ ...COPY, objective: "Typed before the refusal." }, "That id is taken."));

  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-error").hidden, false);
  assert.equal(page.byId("manage-success").hidden, true);
  assert.equal(page.byId("preview-success").hidden, true);
  assert.equal(page.byId("editor-objective").value, "Typed before the refusal.");
});

test("a create made from a preview is confirmed there, and says where it went", () => {
  // The navigation stays as agreed — a preview-born create returns to the
  // preview — so the confirmation has to carry the route to the new mode.
  const page = load();
  page.send(opened(BUILTIN_VIEW));
  previewAction(page, "Duplicate & Customize").dispatch("click");
  page.send(opened(COPY));
  page.byId("editor-save").dispatch("click");

  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY, created: CREATED } }));

  assert.deepEqual(visible(page), ["fix-mode-preview-view"]);
  assert.equal(page.byId("preview-success").hidden, false);
  assert.match(page.byId("preview-success").textContent, /created successfully/);
  assert.match(page.byId("preview-success").textContent, /Fix Mode list/);
});

// --- previewing what the editor holds ---------------------------------------

test("Preview Generated Instructions brings its own output into view", () => {
  const page = load();
  page.send(opened(DRAFT));
  assert.equal(page.byId("editor-preview-pane").hidden, true);

  page.byId("editor-preview").dispatch("click");

  assert.equal(page.byId("editor-preview-pane").hidden, false);
  const pane = page.byId("editor-preview-pane");
  assert.ok(pane.scrolledIntoView, "the preview was shown but never scrolled to");
  assert.equal(pane.scrolledIntoView["block"], "start");
  assert.equal(page.focused, "editor-preview-heading");
});

test("previewing the instructions changes nothing about the editor", () => {
  // It reads the unsaved fields and shows them. It does not save, navigate, or
  // touch what the developer typed.
  const page = load();
  page.send(opened(COPY));
  page.byId("editor-objective").value = "Unsaved text.";
  const before = page.posted.length;

  page.byId("editor-preview").dispatch("click");

  assert.deepEqual(visible(page), ["fix-mode-editor-view"]);
  assert.equal(page.byId("editor-title").textContent, "New Fix Mode");
  assert.equal(page.byId("editor-objective").value, "Unsaved text.");
  assert.deepEqual(page.posted.slice(before), [], "previewing told the host something");
  // And it previews what is in the boxes now, not what was loaded.
  assert.match(JSON.stringify(page.byId("editor-preview-body")), /Unsaved text\./);
});

// --- improving the hint ------------------------------------------------------

test("the improve button carries the hint that is on screen now", () => {
  const page = load();
  page.send(state({ form: { ...DEFAULT_FORM, hint: "maybe cache" } }));
  const before = page.posted.length;

  page.byId("improve-hint").dispatch("click");

  const sent = page.posted.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!["type"], "improveHint");
  assert.equal((sent[0]!["form"] as Record<string, unknown>)["hint"], "maybe cache");
});

test("the issue-details box travels with the form, and starts on", () => {
  const page = load();
  page.send(state({ form: DEFAULT_FORM }));
  assert.equal(page.byId("useIssueDetails").checked, true);

  page.byId("useIssueDetails").checked = false;
  page.byId("improve-hint").dispatch("click");

  const sent = page.posted.at(-1) as Record<string, unknown>;
  assert.equal((sent["form"] as Record<string, unknown>)["useIssueDetails"], false);
});

test("a request in flight says so, and cannot be started twice", () => {
  const page = load();

  page.send(state({ hintImprovement: { busy: true } }));

  assert.equal(page.byId("improve-hint-label").textContent, "Improving…");
  assert.equal(page.byId("improve-hint").disabled, true);
  // The theme's own spinner, not a word that jumps.
  assert.match(page.byId("improve-hint-icon").className, /codicon-loading/);

  page.send(state({ hintImprovement: { busy: false } }));
  assert.equal(page.byId("improve-hint-label").textContent, "Improve");
  assert.equal(page.byId("improve-hint").disabled, false);
});

test("a suggestion is shown beside the hint, never written into it", () => {
  const page = load();
  page.send(state({ form: { ...DEFAULT_FORM, hint: "maybe cache" } }));

  page.send(
    state({
      form: { ...DEFAULT_FORM, hint: "maybe cache" },
      hintImprovement: { busy: false, suggestion: "Investigate cache invalidation." },
    }),
  );

  assert.equal(page.byId("hint-suggestion").hidden, false);
  assert.equal(page.byId("hint-suggestion-text").textContent, "Investigate cache invalidation.");
  assert.equal(page.byId("hint").value, "maybe cache", "the hint was replaced without being accepted");
});

test("the two answers to a suggestion are the two messages", () => {
  const page = load();
  page.send(state({ hintImprovement: { busy: false, suggestion: "Investigate." } }));
  const before = page.posted.length;

  page.byId("hint-use").dispatch("click");
  page.byId("hint-keep").dispatch("click");

  assert.deepEqual(
    page.posted.slice(before).map((message) => message["type"]),
    ["useImprovedHint", "dismissImprovedHint"],
  );
});

test("an accepted suggestion goes into the Hint on the form, and reaches the host as an edit would", () => {
  // It lands in the field, so it stays editable; and it is a change like typing
  // it — the host decides whether the prepared context is now stale.
  const page = load();
  page.send(state({ revision: 2, form: { ...DEFAULT_FORM, hint: "maybe cache" } }));
  page.send(state({ hintImprovement: { busy: false, suggestion: "Investigate cache invalidation." } }));
  const before = page.posted.length;
  page.byId("hint-use").dispatch("click");
  assert.equal(page.byId("hint").value, "Investigate cache invalidation.");
  assert.equal(page.posted[before]!["type"], "useImprovedHint");
  page.flush();
  const change = page.posted.slice(before).find((message) => message["type"] === "formChanged");
  assert.equal((change!["form"] as { hint: string }).hint, "Investigate cache invalidation.");
  page.byId("form").dispatch("submit");
  assert.equal((page.posted.at(-1)!["form"] as { hint: string }).hint, "Investigate cache invalidation.");
});

test("a fallback is said quietly and a failure is said loudly", () => {
  const page = load();

  page.send(state({ hintImprovement: { busy: false, notice: "Issue details unavailable — improving from hint only." } }));
  assert.equal(page.byId("hint-improve-notice").hidden, false);
  assert.equal(page.byId("hint-improve-error").hidden, true);

  page.send(state({ hintImprovement: { busy: false, error: "claude was not found on PATH." } }));
  assert.equal(page.byId("hint-improve-error").hidden, false);
  assert.match(page.byId("hint-improve-error").textContent, /not found on PATH/);
});

test("improving a hint never asks for a run", () => {
  // The separation the whole feature rests on: this is a text rewrite, and Run
  // is what builds context. Pressing one must never start the other.
  const page = load();
  page.send(state({ form: { ...DEFAULT_FORM, hint: "maybe cache" } }));
  const before = page.posted.length;

  page.byId("improve-hint").dispatch("click");
  page.send(state({ hintImprovement: { busy: false, suggestion: "Investigate." } }));
  page.byId("hint-use").dispatch("click");

  const types = page.posted.slice(before).map((message) => message["type"]);
  assert.ok(!types.includes("run"), "improving a hint asked for a run");
});

// --- UI-A1: the workflow disclosure ----------------------------------------

test("the workflow stays closed until there is a run to watch", () => {
  // Collapsed is the default in the markup; this is the page agreeing with it.
  // An untouched panel showing six checked rows was the largest thing on it and
  // said nothing a developer who has not typed an issue yet needs.
  const p = load();
  p.send(state());
  assert.equal(p.byId("workflow").open, false);
});

test("a run opens the workflow, and it stays open as the run finishes", () => {
  // Since Batch 6 the rows are the result: folding them away as the run ends
  // would hide the very thing it produced. (Through UI-V1 the checklist folded
  // because a Context Ready card above it repeated its contents; that card is
  // gone.)
  const p = load();
  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));
  assert.equal(p.byId("workflow").open, true);

  p.send(prepared());
  assert.equal(p.byId("workflow").open, true);
  assert.equal(statusOf(p, "buildContext"), "Context ready");
});

test("a developer who collapses the workflow is not overruled", () => {
  // It opens on the transition and only there. The host pushes state for
  // every stream event and every refresh, and a rule that reopened it on each
  // of those would fight anybody trying to get it out of the way.
  // A Jira run knows its work item from the start, so every push carries it.
  const running = (rows: ProgressView["rows"]) =>
    state({ progress: { state: "running", rows, artifacts: [] }, workItemId: "JR-12345" });
  const p = load();
  p.send(running([]));
  assert.equal(p.byId("workflow").open, true);

  p.byId("workflow").open = false;
  p.send(running([row("code_search", "running")]));
  assert.equal(p.byId("workflow").open, false, "a mid-run push reopened it");

  p.send(prepared());
  p.send(prepared());
  assert.equal(p.byId("workflow").open, false, "a finished run reopened it");

  // The next run is a new thing to watch, so it opens again.
  p.send(running([]));
  assert.equal(p.byId("workflow").open, true);
});

test("a failure opens a collapsed workflow once, so its card can be acted on", () => {
  // Every card lives inside the workflow now. A run collapsed mid-way that then
  // failed would otherwise say "Run failed" in the header and hide the button
  // that fixes it.
  const p = load();
  p.send(
    state({
      progress: { state: "running", rows: [row("issue_details", "running")], artifacts: [] },
      workItemId: "JR-12345",
    }),
  );
  p.byId("workflow").open = false;

  p.send(failedAt("issue_details", JIRA_ERROR));
  assert.equal(p.byId("workflow").open, true, "the row's card stayed folded away");

  // Once: the developer may fold it again, and the same failure pushed again
  // does not overrule that.
  p.byId("workflow").open = false;
  p.send(failedAt("issue_details", JIRA_ERROR));
  assert.equal(p.byId("workflow").open, false);
});

test("a failure no row owns opens the workflow too, even on a panel that just loaded", () => {
  const p = load();
  p.send(state({ progress: { state: "failed", rows: [], artifacts: [] }, runError: JIRA_ERROR }));
  assert.equal(p.byId("workflow").open, true);
  assert.equal(p.byId("failure").hidden, false);
});

test("a handoff that could not start opens the workflow to its card", () => {
  const p = load();
  p.send(prepared());
  p.byId("workflow").open = false;

  p.send(prepared(AGENT_FAILED));
  assert.equal(p.byId("workflow").open, true);
  assert.equal(p.byId("error-fixWithAI").hidden, false);
});

test("a reopened work item opens the workflow once, to show its results", () => {
  // A work item from History, or the one a reloaded panel restores, arrives
  // finished: there is no run starting to open it, and its results are on the
  // rows.
  const p = load();
  p.send(state());
  assert.equal(p.byId("workflow").open, false);

  p.send(prepared());
  assert.equal(p.byId("workflow").open, true);

  // Once: collapsing it and receiving the same work item again keeps it shut.
  p.byId("workflow").open = false;
  p.send(prepared());
  assert.equal(p.byId("workflow").open, false);

  // A work item with nothing to show does not open it.
  const fresh = load();
  fresh.send(state({ workItemId: "JR-12345" }));
  assert.equal(fresh.byId("workflow").open, false);
});

test("Run says it is running, and cannot be pressed again while it is", () => {
  const p = load();
  p.send(state());
  assert.equal(p.byId("run-label").textContent, "Run");

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  assert.equal(p.byId("run-label").textContent, "Running…");
  assert.match(p.byId("run-icon").className, /codicon-spin/);
  assert.equal(p.byId("run").disabled, true);

  // Disabled is not the guard — a keyboard shortcut does not go through the
  // button at all, so `submit()` refuses on its own.
  const before = p.posted.length;
  p.byId("form").dispatch("submit");
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });
  assert.equal(p.posted.length, before, "a second run was started");

  p.send(state({ progress: { state: "done", rows: [], artifacts: [] } }));
  assert.equal(p.byId("run-label").textContent, "Run");
  assert.match(p.byId("run-icon").className, /codicon-play/);
});

test("the post-run actions are on the rows a finished run leaves open", () => {
  // UI-A1 simplified the initial state; Batch 6 moved every action onto the
  // row that owns it. Neither may make a finished run harder to act on.
  const p = load();
  p.send(prepared());

  assert.equal(p.byId("workflow").open, true);
  for (const [id, action] of [
    ["open-context", "openContext"],
    ["copy-context", "copyContext"],
    ["open-folder", "openFolder"],
  ] as const) {
    assert.equal(p.byId(id).hidden, false, id);
    p.byId(id).dispatch("click");
    assert.deepEqual(p.posted.at(-1), { type: "action", id: action });
  }
  // And the next step is the button at the top, which never scrolled away.
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
});

// --- UI-A2: the regrouped fields still carry their state -------------------

test("the regrouped fields round-trip through the form unchanged", () => {
  // The fields moved onto the settings page. None of that may reach the
  // message: a keyword list and a focus path are parsed by the host, and a
  // field that arrived under a new name would simply stop working.
  const p = load();
  p.send(state());

  applyOnPage(p, () => {
    p.byId("keywords").value = "VolumeDescriptor, OpenVDS\noutputType";
    p.byId("focusFiles").value = "src/core/\nsrc/services/example.cpp";
    p.byId("hint").value = "check the output validation";
    p.byId("ignorePaths").value = "build/";
  });
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { type: string; action?: string; form: Record<string, unknown> };
  assert.equal(message.type, "nextAction");
  assert.equal(message.action, "run");
  assert.equal(message.form["keywords"], "VolumeDescriptor, OpenVDS\noutputType");
  assert.equal(message.form["focusFiles"], "src/core/\nsrc/services/example.cpp");
  assert.equal(message.form["hint"], "check the output validation");
  assert.equal(message.form["ignorePaths"], "build/");
});

test("a restored form still fills every regrouped field", () => {
  const p = load({
    form: {
      ...DEFAULT_FORM,
      keywords: "outputType",
      focusFiles: "src/a.cpp",
      hint: "look here",
      title: "Crash on export",
      ignorePaths: "build/",
      maxFiles: "5",
    },
  });
  assert.equal(p.byId("keywords").value, "outputType");
  assert.equal(p.byId("focusFiles").value, "src/a.cpp");
  assert.equal(p.byId("hint").value, "look here");
  assert.equal(p.byId("title").value, "Crash on export");
  assert.equal(p.byId("ignorePaths").value, "build/");
  assert.equal(p.byId("maxFiles").value, "5");
});

test("a problem in a regrouped field still opens Workflow Settings and lands", () => {
  // The messages are attached by field id, whichever section the field is in.
  const p = load();
  p.send(state({ problems: [{ field: "focusFiles", message: "outside the repository" }] }));

  assert.equal(p.byId("workflow-settings-view").hidden, false);
  assert.equal(p.byId("focusFiles-error").textContent, "outside the repository");
  assert.equal(p.byId("focusFiles-error").hidden, false);
  assert.equal(p.focused, "focusFiles");
});

// --- Batch 6: the rows are the result ---------------------------------------

test("nothing about a result is shown before the first run", () => {
  // §19: no empty card, no zero counts, no artifact waiting to be filled.
  const p = load();
  p.send(state());

  for (const id of ["open-context", "copy-context", "open-folder", "more-actions"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
  for (const id of ["relevant-files", "search-details", "strategy-fixWithAI", "actions-buildContext", "attempt-editor"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
  // The one thing to press is Run.
  assert.equal(p.byId("run-label").textContent, "Run");
  for (const id of STEP_IDS) {
    assert.equal(p.byId(`detail-${id}`).hidden, true, id);
    assert.equal(p.byId(`artifact-${id}`).hidden, true, id);
  }
  // Each row says what it will do, not what it did.
  assert.equal(p.byId("description-codeSearch").textContent, "Search relevant code in the repository");
  // And the workflow is still the place the plan is chosen.
  assert.equal(p.byId("plan-buildContext").checked, true);
  assert.equal(p.byId("plan-fixWithAI").checked, false);
});

test("a run in flight shows progress on its rows, and offers nothing to press", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));

  assert.equal(p.byId("description-codeSearch").textContent, "Searching repository…");
  assert.equal(p.byId("more-actions").hidden, true, "something else was offered mid-run");
  assert.equal(p.byId("open-folder").hidden, true);
  assert.equal(p.byId("run-label").textContent, "Running…");
  assert.equal(p.byId("run").disabled, true);
  assert.equal(p.byId("workflow").open, true);
});

test("a finished run reads as results on the rows, and one next action", () => {
  const p = load();
  p.send(prepared({ strategy: "Standard Fix" }));

  // Issue details: which issue, and its title on the line below.
  assert.equal(p.byId("description-issueDetails").textContent, "JR-12345 · Jira issue");
  assert.equal(p.byId("detail-issueDetails").textContent, "WidgetController rejects the VDS output type");
  assert.equal(p.byId("detail-issueDetails").hidden, false);
  assert.equal(p.byId("artifact-issueDetails-name").textContent, "issue.json");
  assert.equal(p.byId("artifact-issueDetails").hidden, false);
  // Code search: what was searched and what it found, from retrieval.json.
  assert.equal(p.byId("description-codeSearch").textContent, "53 terms · 8 relevant files");
  assert.equal(p.byId("artifact-codeSearch-name").textContent, "retrieval.json");
  // Git history and Similar fixes say only what is known: Completed, once.
  for (const id of ["gitHistory", "similarFixes"]) {
    assert.equal(statusOf(p, id), "Completed", id);
    assert.equal(p.byId(`description-${id}`).hidden, true, `${id}: a second line that says Completed again`);
    assert.equal(p.byId(`foot-${id}`).hidden, true, `${id}: an empty second line`);
  }
  assert.equal(p.byId("artifact-gitHistory").hidden, true);
  // Build context: the context is ready — once — and its two actions are on its row.
  assert.equal(statusOf(p, "buildContext"), "Context ready");
  assert.equal(p.byId("description-buildContext").hidden, true, "Context ready said twice");
  assert.equal(p.byId("actions-buildContext").hidden, false);
  assert.equal(p.byId("open-context").hidden, false);
  assert.equal(p.byId("copy-context").hidden, false);
  // Fix with AI: ready, with the mode the task was prepared with — and the one
  // next action is the top button's, which now says so.
  assert.equal(statusOf(p, "fixWithAI"), "Ready");
  assert.equal(p.byId("strategy-fixWithAI-value").textContent, "Standard Fix");
  assert.equal(p.byId("strategy-fixWithAI").hidden, false);
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
  assert.match(p.byId("run-icon").className, /codicon-hubot/);
  assert.equal(p.byId("run").disabled, false);
  // Short, and no file names in the instruction (§37.86).
  assert.equal(p.byId("run-hint").textContent, "Context ready. Next: Fix with AI.");
  // Behind ⋯, rebuilding it — and not yet a new attempt: none has started.
  assert.equal(p.byId("more-actions").hidden, false);
  assert.equal(p.byId("menu-rebuildContext").hidden, false);
  assert.equal(p.byId("menu-startNewAttempt").hidden, true);
  // The work item's folder, at the foot of the workflow.
  assert.equal(p.byId("open-folder").hidden, false);
});

test("a ready task says Ready, once, with a dot — no tick", () => {
  const p = load();
  p.send(prepared());

  assert.ok(p.byId("step-fixWithAI").classes.has("step-ready"));
  assert.equal(statusOf(p, "fixWithAI"), "Ready");
  assert.ok(p.byId("mark-fixWithAI").classes.has("step-dot"));
  assert.equal(p.byId("description-fixWithAI").hidden, true, "Ready said twice");
  assert.ok(p.byId("step-buildContext").classes.has("step-success"));
  // Unticked, but part of what happened: not greyed out as "not chosen".
  assert.equal(p.byId("step-fixWithAI").classes.has("step-off"), false);
});

test("a search whose retrieval could not be read says Completed rather than zero", () => {
  // "0 relevant files" about a run that found eight is how a panel stops being
  // believed; a row that says only that it finished is not.
  const p = load();
  p.send(prepared({ search: { content: { files: [], terms: [] } } }));

  assert.equal(statusOf(p, "codeSearch"), "Completed");
  assert.equal(p.byId("description-codeSearch").hidden, true);
  assert.equal(p.byId("relevant-files").hidden, true);
  assert.equal(p.byId("search-details").hidden, true);
});

test("a row's artifact link asks for exactly the file the host named", () => {
  const p = load();
  p.send(prepared());

  p.byId("artifact-issueDetails").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "openArtifact", name: "issue.json" });
  p.byId("artifact-buildContext").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "openArtifact", name: "context.md" });

  // A row with no artifact sends nothing, even if its hidden link is clicked.
  const before = p.posted.length;
  p.byId("artifact-gitHistory").dispatch("click");
  assert.equal(p.posted.length, before);
});

test("an issue title renders as text", () => {
  const hostile = "<img src=x onerror=1> & <b>bold</b>";
  const p = load();
  p.send(prepared({ issue: { id: "JR-12345", source: "jira", title: hostile } }));

  assert.equal(p.byId("detail-issueDetails").textContent, hostile);
  assert.equal(p.byId("detail-issueDetails").children.length, 0, "the title became markup");
});

test("Fix with AI, the top button, asks the host for exactly that — with the form", () => {
  const p = load();
  p.send(prepared());
  p.byId("issue").value = "JR-12345";

  p.byId("form").dispatch("submit");
  const message = p.posted.at(-1) as { type: string; action: string; form: Record<string, unknown> };
  assert.equal(message.type, "nextAction");
  assert.equal(message.action, "fixWithAI");
  // The form rides along so the host can check the context is still current.
  assert.equal(message.form["issueKey"], "JR-12345");
  // And Ctrl+Enter presses the same button.
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });
  assert.equal((p.posted.at(-1) as { action: string }).action, "fixWithAI");
});

test("a failed run keeps its failure on the row that failed, and claims no result", () => {
  const p = load();
  p.send(failedAt("issue_details", JIRA_ERROR));

  assert.equal(p.byId("error-issueDetails").hidden, false);
  assert.equal(p.byId("error-issueDetails-title").textContent, "Unable to access Jira");
  assert.ok(p.byId("step-issueDetails").classes.has("step-failed"));
  // Owned by the row, so not repeated as a card of its own.
  assert.equal(p.byId("failure").hidden, true);
  assert.equal(p.byId("open-context").hidden, true);
  assert.equal(p.byId("run-label").textContent, "Run", "a failed run offered something other than running again");
  assert.equal(p.byId("workflow-status").textContent, "Run failed");
  // And the plan is still there to change before trying again.
  assert.equal(p.byId("plan-buildContext").disabled, false);
  assert.equal(p.byId("plan-buildContext").checked, true);
});

test("a later failure never erases the rows that finished before it", () => {
  const p = load();
  p.send(failedAt("build_context", { kind: "run", title: "Run failed", message: "It stopped." }, ["issue_details", "code_search"]));

  assert.equal(p.byId("description-issueDetails").textContent, "JR-12345 · Jira issue");
  assert.equal(p.byId("description-codeSearch").textContent, "53 terms · 8 relevant files");
  assert.equal(p.byId("error-buildContext").hidden, false);
  assert.equal(p.byId("error-issueDetails").hidden, true);
  assert.equal(p.byId("error-codeSearch").hidden, true);
});

test("a failure no row owns has its own card at the top of the workflow", () => {
  const p = load();
  p.send(state({ progress: { state: "failed", rows: [], artifacts: [] }, runError: JIRA_ERROR }));

  assert.equal(p.byId("failure").hidden, false);
  for (const id of STEP_IDS) assert.equal(p.byId(`error-${id}`).hidden, true, id);
});

test("a result from one run does not survive into the next", () => {
  // Every slot is cleared as the next run starts, so a run that reads nothing
  // cannot inherit the previous one's result for a frame.
  const p = load();
  p.send(prepared({ strategy: "Standard Fix", ...withSearch({ files: FOUND, terms: TERMS }) }));
  assert.equal(p.byId("detail-issueDetails").hidden, false);

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  for (const id of STEP_IDS) {
    assert.equal(p.byId(`detail-${id}`).hidden, true, id);
    assert.equal(p.byId(`artifact-${id}`).hidden, true, id);
  }
  for (const id of ["open-context", "copy-context", "open-folder", "more-actions", "strategy-fixWithAI", "relevant-files", "search-details"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
  assert.equal(p.byId("run-label").textContent, "Running…");
});

// --- Fix result (Batch 8) ---------------------------------------------------

/** A finished work item whose agent left a report. */
const reported = (
  fixReport: { readable: boolean; summary?: string; tests?: string },
  extra: Partial<WorkflowInput> = {},
  overrides: Partial<PanelState> = {},
) => prepared({ artifacts: [...PREPARED_FILES, "fix_report.md"], fixReport, ...extra }, overrides);

test("no report, no Fix result row", () => {
  const p = load();
  p.send(prepared());

  assert.equal(p.byId("step-fixResult").hidden, true);
  assert.equal(p.byId("open-fix-report").hidden, true);
  assert.equal(p.byId("artifact-fixResult").hidden, true);
  assert.equal(p.byId("workflow-status").textContent, "Context ready");
});

test("a report is one row: the agent's summary, its tests line, the file and one button", () => {
  const p = load();
  p.send(reported({ readable: true, summary: "Fixed the output-type validation regression.", tests: "24 passed." }));

  assert.equal(p.byId("step-fixResult").hidden, false);
  assert.equal(p.byId("description-fixResult").textContent, "Fixed the output-type validation regression.");
  assert.equal(p.byId("detail-fixResult").textContent, "Tests: 24 passed.");
  assert.equal(p.byId("detail-fixResult").hidden, false);
  assert.equal(p.byId("artifact-fixResult-name").textContent, "fix_report.md");
  assert.equal(p.byId("artifact-fixResult").hidden, false);
  assert.equal(p.byId("open-fix-report").hidden, false);
  assert.equal(p.byId("actions-fixResult").hidden, false);
  assert.equal(p.byId("workflow-status").textContent, "Fix report available");
  // Clamped on screen; the whole line is the hover.
  assert.equal(p.byId("description-fixResult").getAttribute("title"), "Fixed the output-type validation regression.");
  assert.equal(p.byId("detail-fixResult").getAttribute("title"), "Tests: 24 passed.");
});

test("the row reads as a report to look at, not as a fix", () => {
  // No tick: the glyph is reserved for a handoff that started, and nothing
  // here knows whether the bug is fixed. The words carry the state.
  const p = load();
  p.send(reported({ readable: true, summary: "Attempted fix; validation still fails.", tests: "pytest: 2 failed, 18 passed." }));

  assert.ok(p.byId("step-fixResult").classes.has("step-ready"));
  assert.equal(p.byId("step-fixResult").classes.has("step-success"), false);
  // A report to read, said once — never Completed, never a tick.
  assert.equal(statusOf(p, "fixResult"), "Report available");
  assert.ok(p.byId("mark-fixResult").classes.has("step-dot"));
  assert.equal(p.byId("step-fixResult").getAttribute("aria-label"), "Fix result: Report available");
  assert.equal(p.byId("description-fixResult").textContent, "Attempted fix; validation still fails.");
  assert.equal(p.byId("detail-fixResult").textContent, "Tests: pytest: 2 failed, 18 passed.");
});

test("Open Fix Report and the file link ask for the file the host named, through openArtifact", () => {
  const p = load();
  p.send(reported({ readable: true, summary: "Fixed it." }));

  p.byId("open-fix-report").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "openArtifact", name: "fix_report.md" });
  p.byId("artifact-fixResult").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "openArtifact", name: "fix_report.md" });
});

test("a work item without a report forgets the last one's row, text and file", () => {
  const p = load();
  p.send(reported({ readable: true, summary: "Fixed it.", tests: "3 passed." }));
  assert.equal(p.byId("step-fixResult").hidden, false);

  p.send(prepared({}, { workItemId: "JR-2" }));
  assert.equal(p.byId("step-fixResult").hidden, true);
  assert.equal(p.byId("description-fixResult").textContent, "");
  assert.equal(p.byId("detail-fixResult").textContent, "");
  assert.equal(p.byId("detail-fixResult").hidden, true);
  assert.equal(p.byId("artifact-fixResult-name").textContent, "");
  assert.equal(p.byId("description-fixResult").getAttribute("title"), "");
  assert.equal(p.byId("open-fix-report").hidden, true);

  // And a click on the hidden controls sends nothing.
  const before = p.posted.length;
  p.byId("open-fix-report").dispatch("click");
  p.byId("artifact-fixResult").dispatch("click");
  assert.equal(p.posted.length, before);
});

test("a report with no summary, or one that could not be read, is still a row to open", () => {
  const p = load();
  p.send(reported({ readable: true }));
  assert.equal(statusOf(p, "fixResult"), "Report available");
  assert.equal(p.byId("description-fixResult").hidden, true, "the status said again as a second line");
  assert.equal(p.byId("detail-fixResult").hidden, true, "a Tests line appeared from nowhere");
  assert.equal(p.byId("open-fix-report").hidden, false);

  p.send(reported({ readable: false }));
  assert.equal(statusOf(p, "fixResult"), "Report available");
  assert.equal(p.byId("detail-fixResult").textContent, "Preview unavailable");
  assert.equal(p.byId("open-fix-report").hidden, false);
  // Not a failure: no card, and the header is not "Run failed".
  assert.equal(p.byId("failure").hidden, true);
  assert.equal(p.byId("workflow-status").textContent, "Fix report available");
});

test("report text renders as text", () => {
  const hostile = '<img src=x onerror=alert(1)> <script>alert("x")</script>';
  const p = load();
  p.send(reported({ readable: true, summary: hostile, tests: hostile }));

  assert.equal(p.byId("description-fixResult").textContent, hostile);
  assert.equal(p.byId("description-fixResult").children.length, 0, "the summary became markup");
  assert.equal(p.byId("detail-fixResult").textContent, `Tests: ${hostile}`);
  assert.equal(p.byId("detail-fixResult").children.length, 0, "the tests line became markup");
});

test("Fix with AI keeps its own state beside a report", () => {
  // A reopened work item: task.md is there, and an agent has written its
  // report — so an attempt exists, even though this panel did not see it start.
  // Fix with AI says the report is there, not that anything started; Fix result
  // shows it; the next step is the earlier session, or a new attempt.
  const p = load();
  p.send(reported({ readable: true, summary: "Fixed it." }));

  assert.equal(p.byId("description-fixWithAI").textContent, "Fix report available");
  assert.equal(p.byId("step-fixWithAI").classes.has("step-success"), false, "a start nobody saw wore the tick");
  assert.equal(p.byId("run-label").textContent, "Open AI Session");
  assert.equal(p.byId("run-hint").textContent, "An earlier AI attempt wrote fix_report.md. Open its session, or start a new attempt from ⋯.");
  assert.equal(p.byId("menu-startNewAttempt").hidden, false);
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");

  // And a handoff this session saw keeps the header, the report its row.
  p.send(reported({ readable: true, summary: "Fixed it." }, { fix: { status: "success", detail: "Handed to Claude Code in a terminal." } }));
  assert.equal(p.byId("workflow-status").textContent, "AI fix started");
  assert.equal(p.byId("step-fixResult").hidden, false);
});

test("a report is a result: it alone makes a work item one worth opening the workflow for", () => {
  // Idle rows — no run state to read — and a report on disk. Without the
  // report this work item arrives "Ready to run" and the workflow stays shut;
  // with it the header says "Fix report available" and the workflow opens.
  const idle: ProgressView = { state: "idle", rows: [], artifacts: [] };
  const arrive = (files: readonly string[], fixReport?: { readable: boolean; summary?: string }) =>
    state({
      progress: idle,
      workItemId: "JR-12345",
      workflow: buildWorkflow({
        source: "jira",
        plan: DEFAULT_FORM.plan,
        fixWithAI: false,
        progress: idle,
        artifacts: files,
        ...(fixReport ? { fixReport } : {}),
      }),
    });

  const without = load();
  without.send(arrive(PREPARED_FILES));
  assert.equal(without.byId("workflow").open, false);
  assert.equal(without.byId("step-fixResult").hidden, true);

  const withReport = load();
  withReport.send(arrive([...PREPARED_FILES, "fix_report.md"], { readable: true, summary: "Fixed it." }));
  assert.equal(withReport.byId("workflow-status").textContent, "Fix report available");
  assert.equal(withReport.byId("workflow").open, true);
  assert.equal(withReport.byId("description-fixResult").textContent, "Fixed it.");
});

// --- Fix result's review aids (Batch 9) --------------------------------------

const CHECKLIST = {
  steps: ["Reproduce the original issue if possible.", "Confirm the failure no longer occurs."],
  files: ["src/widgets/WidgetController.cpp"],
  risks: ["The legacy VDS path is untested."],
};

const REPORT = { readable: true, summary: "Fixed it.", tests: "3 passed." };

/** The texts of the Validation checklist body's elements, in order, one level down. */
const validationTexts = (p: Page) =>
  p.byId("validation-body").children.map((child) =>
    child.children.length > 0 ? child.children.map((item) => item.textContent) : child.textContent,
  );

test("no report, no review aids", () => {
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("copy-review-prompt").hidden, true);
  assert.equal(p.byId("validation-checklist").hidden, true);
});

test("a report offers Copy Review Prompt beside Open Fix Report, and a closed checklist", () => {
  const p = load();
  p.send(reported(REPORT));

  assert.equal(p.byId("copy-review-prompt").hidden, false);
  assert.equal(p.byId("copy-review-prompt-label").textContent, "Copy Review Prompt");
  assert.equal(p.byId("copy-review-prompt").disabled, false);
  assert.equal(p.byId("validation-checklist").hidden, false);
  assert.equal(p.byId("validation-checklist").open, false, "the checklist opened by itself");
  // Nothing was asked for by rendering.
  assert.equal(p.posted.some((message) => message["id"] === "loadValidation" || message["id"] === "copyReviewPrompt"), false);

  p.byId("copy-review-prompt").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "copyReviewPrompt" });
});

test("while the prompt is prepared the button says so and takes no second press", () => {
  const p = load();
  p.send(reported(REPORT, { copyingReviewPrompt: true }));

  assert.equal(p.byId("copy-review-prompt").disabled, true);
  assert.equal(p.byId("copy-review-prompt").getAttribute("aria-busy"), "true");
  assert.equal(p.byId("copy-review-prompt-label").textContent, "Copying…");
  const before = p.posted.length;
  p.byId("copy-review-prompt").dispatch("click");
  assert.equal(p.posted.length, before);

  // And back to itself, with nothing on the row saying "reviewed".
  p.send(reported(REPORT));
  assert.equal(p.byId("copy-review-prompt-label").textContent, "Copy Review Prompt");
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");
});

test("opening the checklist asks for it once; opening it again after it came does not", () => {
  const p = load();
  p.send(reported(REPORT));
  const disclosure = p.byId("validation-checklist");

  disclosure.open = true;
  disclosure.dispatch("toggle");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "loadValidation" });

  p.send(reported(REPORT, { validation: { state: "ready", checklist: CHECKLIST } }));
  const before = p.posted.length;
  disclosure.open = false;
  disclosure.dispatch("toggle");
  disclosure.open = true;
  disclosure.dispatch("toggle");
  assert.equal(p.posted.length, before, "a loaded checklist was asked for again");
});

test("loading, then the checklist as text: steps, then regression areas", () => {
  const p = load();
  p.send(reported(REPORT, { validation: { state: "loading" } }));
  assert.deepEqual(validationTexts(p), ["Loading…"]);

  p.send(reported(REPORT, { validation: { state: "ready", checklist: { ...CHECKLIST, moreRisks: 2 } } }));
  assert.deepEqual(validationTexts(p), [
    ["Reproduce the original issue if possible.", "Confirm the failure no longer occurs."],
    "Regression areas",
    ["src/widgets/WidgetController.cpp", "The legacy VDS path is untested."],
    "2 more in fix_report.md",
  ]);
  // A numbered list of steps: guidance, with nothing marked done.
  assert.equal(p.byId("validation-body").children[0]!.className, "validation-steps");
});

test("a checklist with nothing to list around its steps shows only the steps", () => {
  const p = load();
  p.send(reported(REPORT, { validation: { state: "ready", checklist: { steps: ["Reproduce."], files: [], risks: [] } } }));
  assert.deepEqual(validationTexts(p), [["Reproduce."]]);
});

test("a checklist that could not be had says why, and offers Retry", () => {
  const p = load();
  p.send(reported(REPORT, { validation: { state: "failed", message: "retrieval.json could not be read" } }));

  const [message, retry] = p.byId("validation-body").children;
  assert.equal(message!.textContent, "Validation checklist unavailable: retrieval.json could not be read");
  assert.equal(retry!.textContent, "Retry");
  retry!.dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "loadValidation" });
  // The row itself is untouched.
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");
  assert.equal(p.byId("failure").hidden, true);
});

test("open with nothing loaded — the folder was read again — offers to load it", () => {
  const p = load();
  p.send(reported(REPORT));
  const [load_] = p.byId("validation-body").children;
  assert.equal(load_!.textContent, "Load checklist");
  load_!.dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "loadValidation" });
});

test("checklist text renders as text", () => {
  const hostile = '<img src=x onerror=alert(1)> <script>alert("x")</script>';
  const p = load();
  p.send(reported(REPORT, { validation: { state: "ready", checklist: { steps: [hostile], files: [hostile], risks: [hostile] } } }));
  const [steps, , areas] = p.byId("validation-body").children;
  assert.equal(steps!.children[0]!.textContent, hostile);
  assert.equal(steps!.children[0]!.children.length, 0, "a step became markup");
  assert.equal(areas!.children[1]!.textContent, hostile);
  assert.equal(areas!.children[1]!.children.length, 0, "a risk became markup");
});

test("a push that changes nothing about the checklist leaves its nodes alone", () => {
  // The body is a live region: rebuilding it on every push — a Copy press, a
  // progress event — would read the list out again and take focus off Retry.
  const p = load();
  p.send(reported(REPORT, { validation: { state: "failed", message: "x" } }));
  const retry = p.byId("validation-body").children[1]!;

  p.send(reported(REPORT, { validation: { state: "failed", message: "x" }, copyingReviewPrompt: true }));
  p.send(reported(REPORT, { validation: { state: "failed", message: "x" } }));
  assert.equal(p.byId("validation-body").children[1], retry, "the body was rebuilt by an unrelated push");

  // A different checklist is a different body.
  p.send(reported(REPORT, { validation: { state: "ready", checklist: CHECKLIST } }));
  assert.notEqual(p.byId("validation-body").children[1], retry);
});

test("another work item closes the checklist; no report hides and empties it", () => {
  const p = load();
  p.send(reported(REPORT, { validation: { state: "ready", checklist: CHECKLIST } }));
  p.byId("validation-checklist").open = true;

  p.send(reported(REPORT, {}, { workItemId: "JR-2" }));
  assert.equal(p.byId("validation-checklist").open, false, "B opened on A's checklist");

  p.send(prepared({}, { workItemId: "JR-3" }));
  assert.equal(p.byId("validation-checklist").hidden, true);
  assert.equal(p.byId("validation-body").children.length, 0);
  assert.equal(p.byId("copy-review-prompt").hidden, true);
});

// --- Relevant files, under Code search --------------------------------------

/** Two files, as the host hands them over: implementation first, then prose. */
const FOUND = [
  {
    path: "src/widgets/WidgetController.cpp",
    name: "WidgetController.cpp",
    documentation: false,
    matched: ["Output", "outputType"],
  },
  { path: "README.md", name: "README.md", documentation: true, matched: ["restored"] },
];

test("Relevant files does not exist before a run", () => {
  const p = load();
  p.send(state());

  assert.equal(p.byId("relevant-files").hidden, true);
  assert.equal(p.byId("relevant-files-list").children.length, 0);
});

test("a search with no files hides the section rather than saying none", () => {
  // §17: an empty-state line is a line to read and dismiss, and Code search's
  // summary line already said how many there were.
  const p = load();
  p.send(prepared(withSearch({ files: [], terms: TERMS })));

  assert.equal(p.byId("relevant-files").hidden, true);
  assert.equal(p.byId("search-details").hidden, false);
});

test("each file is a row with a name, a path and what matched it", () => {
  const p = load();
  p.send(prepared(withSearch({ files: FOUND })));

  assert.equal(p.byId("relevant-files").hidden, false);
  const rows = p.byId("relevant-files-list").children;
  // Two group headings and two rows, because both groups have something in them.
  assert.deepEqual(
    rows.map((child) => child.className),
    ["files-group", "file-row", "files-group", "file-row"],
  );
  assert.deepEqual(
    rows.filter((child) => child.className === "files-group").map((child) => child.textContent),
    ["Implementation", "Supporting"],
  );

  const [button, matched] = rows[1]!.children;
  assert.equal(button!.className, "file-open");
  assert.deepEqual(
    button!.children.map((span) => span.textContent),
    ["WidgetController.cpp", "src/widgets/WidgetController.cpp"],
  );
  // The name is the accessible label; the path is the tooltip, not the name.
  assert.equal(button!.getAttribute("aria-label"), "Open WidgetController.cpp");
  assert.equal(button!.getAttribute("title"), "src/widgets/WidgetController.cpp");
  assert.equal(matched!.textContent, "Matched: Output · outputType");
});

test("one kind of file needs no heading to separate it from the other", () => {
  const p = load();
  p.send(prepared(withSearch({ files: [FOUND[0]!] })));

  assert.deepEqual(
    p.byId("relevant-files-list").children.map((child) => child.className),
    ["file-row"],
  );
});

test("a file with nothing recorded against it shows no Matched line", () => {
  const p = load();
  p.send(prepared(withSearch({ files: [{ path: "src/a.cpp", name: "a.cpp", documentation: false, matched: [] }] })));

  const row = p.byId("relevant-files-list").children[0]!;
  assert.equal(row.children.length, 1, "an empty Matched line was rendered");
});

test("the order is the host's, and grouping keeps it inside each group", () => {
  // Ranking is Python's. A sort here would mean the list and the context
  // disagree about which file matters most.
  const p = load();
  p.send(
    prepared(
      withSearch({
        files: [
          { path: "z.cpp", name: "z.cpp", documentation: false, matched: [] },
          { path: "readme.md", name: "readme.md", documentation: true, matched: [] },
          { path: "a.cpp", name: "a.cpp", documentation: false, matched: [] },
          { path: "design.md", name: "design.md", documentation: true, matched: [] },
        ],
      }),
    ),
  );

  const names = p
    .byId("relevant-files-list")
    .children.filter((child) => child.className === "file-row")
    .map((row) => row.children[0]!.children[0]!.textContent);
  // z before a, readme before design: the artifact's order, partitioned.
  assert.deepEqual(names, ["z.cpp", "a.cpp", "readme.md", "design.md"]);
});

test("a click asks the host to open exactly the path the artifact gave", () => {
  const p = load();
  p.send(prepared(withSearch({ files: FOUND })));

  const row = p.byId("relevant-files-list").children[1]!;
  row.children[0]!.dispatch("click");

  assert.deepEqual(p.posted.at(-1), {
    type: "openRelevantFile",
    path: "src/widgets/WidgetController.cpp",
  });
});

test("a longer list says how many it is not showing", () => {
  const p = load();
  p.send(prepared(withSearch({ files: FOUND, moreFiles: 7 })));

  assert.equal(p.byId("relevant-files-more").hidden, false);
  assert.equal(p.byId("relevant-files-more").textContent, "7 more in retrieval.json");
});

test("a list that shows everything says nothing about more", () => {
  const p = load();
  p.send(prepared(withSearch({ files: FOUND })));

  assert.equal(p.byId("relevant-files-more").hidden, true);
});

test("one bug's files never outlive the search they belonged to", () => {
  // The list is Code search's content, so a run in flight, a failure and
  // another work item each take it away with the rest of the row's result.
  const p = load();
  p.send(prepared(withSearch({ files: FOUND, moreFiles: 3 })));
  assert.equal(p.byId("relevant-files-list").children.length, 4);

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  assert.equal(p.byId("relevant-files").hidden, true);
  assert.equal(p.byId("relevant-files-list").children.length, 0, "stale rows survived");
  assert.equal(p.byId("relevant-files-more").hidden, true);
});

// --- the failure cards ------------------------------------------------------

/** A classified error, as the host hands one over. */
const JIRA_ERROR = {
  kind: "jira-access" as const,
  title: "Unable to access Jira",
  message: "Jira rejected the stored credentials. Set them again.",
  detail: "HTTP 401 Unauthorized",
  action: { title: "Set Jira Credentials", command: "bugpilot.setCredentials" },
};

const AGENT_ERROR = {
  kind: "agent" as const,
  title: "AI agent unavailable",
  message: "BugPilot couldn't start the selected AI agent.",
  detail: "claude is not on PATH.",
  action: { title: "Open Settings", command: "bugpilot.openSettings" },
};

/** A handoff that could not start, as the host reports it on the row. */
const AGENT_FAILED = {
  fix: { status: "skipped" as const, detail: "claude is not on PATH. The handoff prompt is on the clipboard instead." },
  handoffError: AGENT_ERROR,
};

test("no failure means no card, on any surface", () => {
  const p = load();
  p.send(state());

  assert.equal(p.byId("failure").hidden, true);
  for (const id of STEP_IDS) assert.equal(p.byId(`error-${id}`).hidden, true, id);
});

test("a run failure is a title, a sentence, a button and the original underneath", () => {
  const p = load();
  p.send(state({ runError: JIRA_ERROR }));

  assert.equal(p.byId("failure").hidden, false);
  assert.equal(p.byId("failure-title").textContent, "Unable to access Jira");
  assert.equal(p.byId("failure-message").textContent, JIRA_ERROR.message);
  // Collapsed, and holding exactly what the CLI said.
  assert.equal(p.byId("failure-details").hidden, false);
  assert.equal(p.byId("failure-detail").textContent, "HTTP 401 Unauthorized");
  assert.equal(p.byId("failure-details").open, false);

  const actions = p.byId("failure-actions").children;
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.textContent, "Set Jira Credentials");
});

test("the action button asks the host to run the command the host named", () => {
  const p = load();
  p.send(state({ runError: JIRA_ERROR }));

  p.byId("failure-actions").children[0]!.dispatch("click");

  assert.deepEqual(p.posted.at(-1), { type: "command", id: "bugpilot.setCredentials" });
});

test("a row's card button takes the same path as the standalone card's", () => {
  const p = load();
  p.send(failedAt("issue_details", JIRA_ERROR));

  p.byId("error-issueDetails-actions").children[0]!.dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "command", id: "bugpilot.setCredentials" });
});

test("a failure with nothing technical to add shows no Details control", () => {
  const p = load();
  p.send(state({ runError: { kind: "run", title: "Run failed", message: "It stopped." } }));

  assert.equal(p.byId("failure").hidden, false);
  assert.equal(p.byId("failure-details").hidden, true);
  assert.equal(p.byId("failure-actions").children.length, 0);
});

test("technical detail arrives as text, whatever it contains", () => {
  // It is a CLI's stderr and a Jira response — which is exactly where a script
  // tag would come from. The page writes it with textContent and nothing else.
  const hostile = '<script>alert("x")</script> & <img src=x onerror=1>';
  const p = load();
  p.send(state({ runError: { kind: "run", title: "Run failed", message: "x", detail: hostile } }));

  assert.equal(p.byId("failure-detail").textContent, hostile);
  assert.equal(p.byId("failure-detail").children.length, 0, "the detail became markup");
});

test("a multi-line traceback keeps its lines", () => {
  const traceback = "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: x";
  const p = load();
  p.send(state({ runError: { kind: "run", title: "Run failed", message: "x", detail: traceback } }));

  assert.equal(p.byId("failure-detail").textContent, traceback);
});

test("a handoff failure is Fix with AI's own card, beside results that stay", () => {
  const p = load();
  p.send(prepared({ ...AGENT_FAILED, ...withSearch({ files: FOUND }) }));

  // Every earlier result is untouched.
  assert.equal(p.byId("description-codeSearch").textContent, "53 terms · 8 relevant files");
  assert.equal(p.byId("relevant-files").hidden, false);
  assert.equal(p.byId("open-context").hidden, false);
  assert.equal(statusOf(p, "buildContext"), "Context ready");
  // Only Fix with AI failed: Failed once, then the reason, the route the prompt
  // took, and its card.
  assert.ok(p.byId("step-fixWithAI").classes.has("step-failed"));
  assert.equal(statusOf(p, "fixWithAI"), "Failed");
  assert.equal(p.byId("description-fixWithAI").textContent, "Did not start");
  assert.match(p.byId("detail-fixWithAI").textContent, /clipboard/);
  assert.equal(p.byId("error-fixWithAI").hidden, false);
  assert.equal(p.byId("error-fixWithAI-title").textContent, "AI agent unavailable");
  assert.equal(p.byId("error-fixWithAI-detail").textContent, "claude is not on PATH.");
  assert.equal(p.byId("failure").hidden, true, "a handoff failure claimed the run card");
  // And the top button is still Fix with AI, because installing an agent and
  // pressing again is a real thing to do.
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
  assert.equal(p.byId("run").disabled, false);
  assert.equal(p.byId("workflow-status").textContent, "AI fix did not start");
});

test("the handoff card's button takes the same path as the run card's", () => {
  const p = load();
  p.send(prepared(AGENT_FAILED));

  p.byId("error-fixWithAI-actions").children[0]!.dispatch("click");

  assert.deepEqual(p.posted.at(-1), { type: "command", id: "bugpilot.openSettings" });
});

test("a failed run shows its card and neither results nor files", () => {
  const p = load();
  p.send(state({ progress: { state: "failed", rows: [], artifacts: [] }, runError: JIRA_ERROR }));

  assert.equal(p.byId("failure").hidden, false);
  assert.equal(p.byId("relevant-files").hidden, true);
  assert.equal(p.byId("error-fixWithAI").hidden, true);
  assert.equal(p.byId("open-context").hidden, true);
  // The plan is still there to change before trying again.
  assert.equal(p.byId("plan-buildContext").disabled, false);
  assert.equal(p.byId("run").disabled, false);
});

test("a card is emptied as well as hidden when its failure goes away", () => {
  // Otherwise the previous reason flashes into view for a frame if the next
  // render sets `hidden` before it sets the text.
  const p = load();
  p.send(prepared(AGENT_FAILED, { runError: JIRA_ERROR }));
  assert.equal(p.byId("failure-title").textContent, "Unable to access Jira");
  assert.equal(p.byId("error-fixWithAI-title").textContent, "AI agent unavailable");

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));

  for (const id of ["failure", "error-fixWithAI"]) {
    assert.equal(p.byId(id).hidden, true, id);
    assert.equal(p.byId(`${id}-title`).textContent, "", id);
    assert.equal(p.byId(`${id}-message`).textContent, "", id);
    assert.equal(p.byId(`${id}-detail`).textContent, "", id);
    assert.equal(p.byId(`${id}-actions`).children.length, 0, id);
    assert.equal(p.byId(`${id}-details`).hidden, true, id);
  }
});

test("a handoff error disappears when the next attempt works", () => {
  const p = load();
  p.send(prepared(AGENT_FAILED));
  assert.equal(p.byId("error-fixWithAI").hidden, false);

  p.send(prepared({ fix: { status: "success", detail: "Handed to Claude Code in a terminal." } }));

  assert.equal(p.byId("error-fixWithAI").hidden, true);
  assert.equal(statusOf(p, "fixWithAI"), "Started");
});

// --- the successful handoff, on its row -------------------------------------

const STARTED = { fix: { status: "success" as const, detail: "Handed to Claude Code in a terminal." } };

test("before a handoff the top button is Fix with AI, and there is no outcome", () => {
  const p = load();
  p.send(prepared());

  assert.equal(p.byId("run-label").textContent, "Fix with AI");
  assert.equal(statusOf(p, "fixWithAI"), "Ready");
  assert.equal(p.byId("description-fixWithAI").hidden, true);
  assert.equal(p.byId("detail-fixWithAI").hidden, true);
});

test("a successful handoff turns the top button into Open AI Session, and says what happened", () => {
  const p = load();
  p.send(prepared({ ...STARTED, ...withSearch({ files: FOUND }) }));

  assert.ok(p.byId("step-fixWithAI").classes.has("step-success"));
  // Started, once, on the first line; the second says who has it.
  assert.equal(statusOf(p, "fixWithAI"), "Started");
  assert.equal(p.byId("description-fixWithAI").hidden, true);
  assert.equal(p.byId("detail-fixWithAI").textContent, "Handed to Claude Code in a terminal.");
  assert.equal(p.byId("run-label").textContent, "Open AI Session", "a second handoff was the next step");
  assert.match(p.byId("run-icon").className, /codicon-terminal/);
  assert.equal(p.byId("run-hint").textContent, "An AI session was started for this work item. Continue the conversation there.");
  // A new attempt is there, but behind ⋯ — not a competing button.
  assert.equal(p.byId("menu-startNewAttempt").hidden, false);
  assert.equal(p.byId("menu-rebuildContext").hidden, false);
  assert.equal(p.byId("workflow-status").textContent, "AI fix started");

  // And nothing the run produced moved.
  assert.equal(p.byId("description-codeSearch").textContent, "53 terms · 8 relevant files");
  assert.equal(p.byId("relevant-files").hidden, false);
  for (const id of ["open-context", "copy-context", "open-folder"]) {
    assert.equal(p.byId(id).hidden, false, id);
  }
  assert.equal(p.byId("error-fixWithAI").hidden, true);
  assert.equal(p.byId("failure").hidden, true);
});

test("the context actions still work after a handoff", () => {
  const p = load();
  p.send(prepared(STARTED));

  p.byId("open-context").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openContext" });
});

test("a handoff with nothing to say about the agent shows one line, not two", () => {
  const p = load();
  p.send(prepared({ fix: { status: "success" } }));

  // Nothing but the status, which is on the first line: no second line at all.
  assert.equal(statusOf(p, "fixWithAI"), "Started");
  assert.equal(p.byId("foot-fixWithAI").hidden, true);
  assert.equal(p.byId("detail-fixWithAI").hidden, true);
});

test("the row says it is working, and offers no second press meanwhile", () => {
  const p = load();
  p.send(prepared({ handoffBusy: true }));

  assert.equal(p.byId("description-fixWithAI").textContent, "Starting AI fix…");
  assert.equal(statusOf(p, "fixWithAI"), "Running");
  assert.match(p.byId("mark-fixWithAI").className, /codicon-spin/);
  assert.equal(p.byId("run-label").textContent, "Running…");
  assert.equal(p.byId("run").disabled, true);
  assert.equal(p.byId("more-actions").hidden, true);
  // Busy is not an outcome.
  assert.equal(p.byId("step-fixWithAI").classes.has("step-success"), false);
});

test("a handoff that failed shows the card, not the outcome", () => {
  const p = load();
  p.send(prepared({ ...AGENT_FAILED, ...withSearch({ files: FOUND }) }));

  assert.equal(p.byId("step-fixWithAI").classes.has("step-success"), false, "a failure was reported as a success");
  assert.notEqual(p.byId("description-fixWithAI").textContent, "AI fix started");
  assert.equal(p.byId("error-fixWithAI").hidden, false);
  assert.equal(p.byId("relevant-files").hidden, false);
});

test("the outcome goes away with the run it belonged to", () => {
  const p = load();
  p.send(prepared(STARTED));
  assert.equal(statusOf(p, "fixWithAI"), "Started");

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));

  assert.equal(p.byId("description-fixWithAI").textContent, "Waiting for task…");
  assert.equal(p.byId("detail-fixWithAI").hidden, true);
  assert.equal(p.byId("step-fixWithAI").classes.has("step-success"), false);
});

test("the outcome is announced as text, not as a tick", () => {
  // The status has to survive a screen reader and a monochrome theme, so the
  // words carry it and the icon is decoration.
  const p = load();
  p.send(prepared(STARTED));

  assert.equal(statusOf(p, "fixWithAI"), "Started");
  assert.match(p.byId("step-fixWithAI").getAttribute("aria-label") ?? "", /^Fix with AI: Started$/);
  // The mark is decoration, never the only carrier.
  assert.equal(p.byId("mark-fixWithAI").textContent, "");
});

// --- UI-V1: what rendering the page found ------------------------------------

test("the run hint stops explaining Run once Run has been pressed", () => {
  // Advice about a button, sitting directly above the proof of what that button
  // did. Visible in every post-run screenshot until UI-V1. Since the button
  // follows the work item, the line explains whatever it now says instead.
  const p = load();
  p.send(state());
  assert.equal(p.byId("run-hint").hidden, false);
  assert.equal(p.byId("run-hint").textContent, "Run prepares the issue context for AI-assisted fixing.");

  p.send(prepared());
  assert.equal(p.byId("run-hint").hidden, false);
  assert.doesNotMatch(p.byId("run-hint").textContent, /Run prepares/);

  p.send(state({ runError: { kind: "run", title: "Run failed", message: "It stopped." } }));
  assert.equal(p.byId("run-hint").hidden, true);

  p.send(state({ progress: { state: "done", rows: [], artifacts: [] } }));
  assert.equal(p.byId("run-hint").hidden, true, "Run was explained again after it had run");

  // And it comes back for the next untouched state.
  p.send(state());
  assert.equal(p.byId("run-hint").hidden, false);
});

// --- Search details, under Code search ---------------------------------------

/** Terms as the host hands them over: an ordinary one, a shape, a broad one. */
const TERMS = [
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
  { term: "reload", source: "Issue text", lines: 0, broad: false, empty: true },
];

test("Search details does not exist before a run", () => {
  const p = load();
  p.send(state());

  assert.equal(p.byId("search-details").hidden, true);
  assert.equal(p.byId("search-details-list").children.length, 0);
});

test("a search with no terms hides the section rather than saying none", () => {
  const p = load();
  p.send(prepared(withSearch({ files: FOUND, terms: [] })));

  assert.equal(p.byId("search-details").hidden, true);
  assert.equal(p.byId("relevant-files").hidden, false);
});

test("each term shows what it was, what it found, and where it came from", () => {
  const p = load();
  p.send(prepared(withSearch({ terms: TERMS })));

  assert.equal(p.byId("search-details").hidden, false);
  const rows = p.byId("search-details-list").children;
  assert.equal(rows.length, 4);

  // An ordinary term: name, then source and what it matched.
  assert.deepEqual(
    rows[0]!.children.map((child) => child.textContent),
    ["WidgetController", "User keyword · 18 lines"],
  );

  // A generated shape, which is the one a developer never typed.
  assert.deepEqual(
    rows[1]!.children.map((child) => child.textContent),
    ["outputType", "Shape expansion · 7 lines", "From: output type"],
  );

  // Broad said in a word, not a colour.
  assert.equal(rows[2]!.children[1]!.textContent, "Hint · 821 lines · Broad");

  // And one that found nothing says so rather than "0 lines".
  assert.equal(rows[3]!.children[1]!.textContent, "Issue text · no matches");
});

test("one line is one line", () => {
  // Caught by running the parser over a real artifact, where most terms match
  // once or twice: "1 lines" is the kind of detail that makes a panel look
  // unfinished.
  const p = load();
  p.send(prepared(withSearch({ terms: [{ term: "WidgetController", source: "User keyword", lines: 1, broad: false, empty: false }] })));

  assert.equal(
    p.byId("search-details-list").children[0]!.children[1]!.textContent,
    "User keyword · 1 line",
  );
});

test("the count is labelled lines, because that is what the artifact counts", () => {
  // `total_match_count` in search.py is incremented once per matching ripgrep
  // line. "18 matches" would be a quiet lie about a number a developer might
  // act on.
  const p = load();
  p.send(prepared(withSearch({ terms: TERMS })));

  const meta = p.byId("search-details-list").children[0]!.children[1]!.textContent;
  assert.match(meta, /18 lines/);
  assert.equal(/18 matches|18 files|18 hits/.test(meta), false);
});

test("the order is the artifact's, not the alphabet's", () => {
  const p = load();
  p.send(prepared(withSearch({ terms: TERMS })));

  assert.deepEqual(
    p.byId("search-details-list").children.map((row) => row.children[0]!.textContent),
    ["WidgetController", "outputType", "validation", "reload"],
  );
});

test("a term with nothing recorded against it is still listed", () => {
  const p = load();
  p.send(prepared(withSearch({ terms: [{ term: "bare", broad: false, empty: false }] })));

  const row = p.byId("search-details-list").children[0]!;
  assert.equal(row.children.length, 1, "an empty metadata line was rendered");
  assert.equal(row.children[0]!.textContent, "bare");
});

test("a hostile term renders as text", () => {
  // It came out of a Jira description by way of a JSON file.
  const hostile = '<script>alert(1)</script>';
  const p = load();
  p.send(prepared(withSearch({ terms: [{ term: hostile, broad: false, empty: false, derivedFrom: hostile }] })));

  const row = p.byId("search-details-list").children[0]!;
  assert.equal(row.children[0]!.textContent, hostile);
  assert.equal(row.children[0]!.children.length, 0, "the term became markup");
  assert.equal(row.children[1]!.textContent, `From: ${hostile}`);
});

test("the terms go away with the search they belonged to", () => {
  const p = load();
  p.send(prepared(withSearch({ terms: TERMS })));
  assert.equal(p.byId("search-details-list").children.length, 4);

  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));

  assert.equal(p.byId("search-details").hidden, true);
  assert.equal(p.byId("search-details-list").children.length, 0, "stale rows survived");
});

test("a handoff leaves the search story exactly where it was", () => {
  // Retrieval describes preparing the context, not what an agent did with it.
  const p = load();
  for (const handoff of [{}, { handoffBusy: true }, STARTED, AGENT_FAILED]) {
    p.send(prepared({ ...withSearch({ terms: TERMS }), ...handoff }));
    assert.equal(p.byId("search-details").hidden, false, JSON.stringify(handoff));
    assert.equal(p.byId("search-details-list").children.length, 4);
  }
});

test("a failed run shows no search story", () => {
  const p = load();
  p.send(
    state({
      progress: { state: "failed", rows: [], artifacts: [] },
      runError: { kind: "run", title: "Run failed", message: "It stopped." },
    }),
  );

  assert.equal(p.byId("search-details").hidden, true);
  assert.equal(p.byId("relevant-files").hidden, true);
});

// --- UI-C2: Diagnostics ------------------------------------------------------

const DIAGNOSTICS = {
  rows: [
    { label: "Repository", value: "sample-repo", detail: "/work/sample-repo" },
    { label: "Jira", value: "Credentials configured" },
    { label: "AI agent", value: "Auto-detect", detail: "Not checked yet" },
    { label: "Work item", value: "JR-12345", detail: "From a Jira issue" },
    { label: "Extension", value: "0.1.0" },
  ],
};

test("Diagnostics is empty until the host has something to say", () => {
  const p = load();
  p.send(state());

  assert.equal(p.byId("diagnostics").hidden, true);
  assert.equal(p.byId("diagnostics-list").children.length, 0);
});

test("each diagnostic is a label, a value, and sometimes a quieter line", () => {
  const p = load();
  p.send(state({ diagnostics: DIAGNOSTICS }));

  assert.equal(p.byId("diagnostics").hidden, false);
  const items = p.byId("diagnostics-list").children;

  // A definition list: the pairing is in the markup, not only in the layout.
  assert.deepEqual(
    items.map((child) => `${child.className}=${child.textContent}`),
    [
      "diagnostic-label=Repository",
      "diagnostic-value=sample-repo",
      "diagnostic-detail=/work/sample-repo",
      "diagnostic-label=Jira",
      "diagnostic-value=Credentials configured",
      "diagnostic-label=AI agent",
      "diagnostic-value=Auto-detect",
      "diagnostic-detail=Not checked yet",
      "diagnostic-label=Work item",
      "diagnostic-value=JR-12345",
      "diagnostic-detail=From a Jira issue",
      "diagnostic-label=Extension",
      "diagnostic-value=0.1.0",
    ],
  );
});

test("Diagnostics is there whether or not a run has happened", () => {
  // The question it answers — is this the environment I think it is — is asked
  // most urgently when nothing has run, or when a run has just failed.
  const p = load();

  p.send(state({ diagnostics: DIAGNOSTICS }));
  assert.equal(p.byId("diagnostics").hidden, false);
  assert.equal(p.byId("open-context").hidden, true, "no run has happened");

  p.send(
    state({
      progress: { state: "failed", rows: [], artifacts: [] },
      runError: { kind: "run", title: "Run failed", message: "It stopped." },
      diagnostics: DIAGNOSTICS,
    }),
  );
  assert.equal(p.byId("diagnostics").hidden, false, "a failed run took Diagnostics with it");

  p.send(prepared({}, { diagnostics: DIAGNOSTICS }));
  assert.equal(p.byId("diagnostics").hidden, false);
});

test("the rows are replaced rather than appended as state arrives", () => {
  const p = load();
  p.send(state({ diagnostics: DIAGNOSTICS }));
  p.send(state({ diagnostics: DIAGNOSTICS }));

  assert.equal(p.byId("diagnostics-list").children.length, 13);
});

test("a diagnostic changes when the state behind it does", () => {
  const p = load();
  p.send(state({ diagnostics: { rows: [{ label: "Jira", value: "Credentials not configured" }] } }));
  assert.equal(p.byId("diagnostics-list").children[1]!.textContent, "Credentials not configured");

  p.send(state({ diagnostics: { rows: [{ label: "Jira", value: "Credentials configured" }] } }));
  assert.equal(p.byId("diagnostics-list").children[1]!.textContent, "Credentials configured");
});

test("a hostile diagnostic renders as text", () => {
  // A repository path and a work item id both come from outside this panel.
  const hostile = "<script>alert(1)</script>";
  const p = load();
  p.send(state({ diagnostics: { rows: [{ label: "Repository", value: hostile, detail: hostile }] } }));

  const items = p.byId("diagnostics-list").children;
  assert.equal(items[1]!.textContent, hostile);
  assert.equal(items[1]!.children.length, 0, "the value became markup");
  assert.equal(items[2]!.textContent, hostile);
});

// --- Review with AI, under Fix result (Batch 10) ------------------------------

const REVIEW_FAILED = {
  kind: "agent" as const,
  title: "AI review did not start",
  message: "BugPilot couldn't start the selected AI agent.",
  detail: "claude is not on PATH.",
  action: { title: "Open Settings", command: "bugpilot.openSettings" },
};

/** The status's lines, as text. */
/** An element's text as a browser reads it: its own, then its children's. */
const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join("");
const reviewStatus = (p: Page) => p.byId("review-status").children.map(textOf);

test("a report offers Review with AI after Copy Review Prompt; no report, no button", () => {
  const without = load();
  without.send(prepared());
  assert.equal(without.byId("review-with-ai").hidden, true);

  const p = load();
  p.send(reported(REPORT));
  assert.equal(p.byId("review-with-ai").hidden, false);
  assert.equal(p.byId("review-with-ai").disabled, false);
  assert.equal(p.byId("review-with-ai-label").textContent, "Review with AI");
  assert.deepEqual(reviewStatus(p), []);
  assert.equal(p.byId("review-error").hidden, true);
  // Nothing was asked for by rendering.
  assert.equal(p.posted.some((message) => message["id"] === "reviewWithAI"), false);

  p.byId("review-with-ai").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "reviewWithAI" });
});

test("while a review starts the button says so, waits, and takes no second press", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "starting" } }));

  const button = p.byId("review-with-ai");
  assert.equal(button.hidden, false);
  // Unavailable to assistive technology and to the click, but not `disabled`:
  // Chromium would take the focus off a disabled control.
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(p.byId("review-with-ai-label").textContent, "Starting AI review…");
  const before = p.posted.length;
  button.dispatch("click");
  assert.equal(p.posted.length, before);
});

test("once started, the button goes and the row says what happened, in plain words", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" } }));

  assert.equal(p.byId("review-with-ai").hidden, true, "a second reviewer was offered");
  assert.deepEqual(reviewStatus(p), [
    "AI review started",
    "Handed to Claude Code in a terminal.",
    "When the reviewer replies, use Paste Review Output to fill in the review result, then check it and save it.",
  ]);
  assert.equal(p.byId("review-error").hidden, true);
  // The report's own actions stay, and the row is still the report's.
  assert.equal(p.byId("open-fix-report").hidden, false);
  assert.equal(p.byId("copy-review-prompt").hidden, false);
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");
  assert.equal(p.byId("workflow-status").textContent, "Fix report available");
  // The row's own status is unchanged by the review: still a report to read.
  assert.equal(statusOf(p, "fixResult"), "Report available");
});

test("a review that did not start shows its card under the row, and the button for a retry", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED } }));

  assert.equal(p.byId("review-error").hidden, false);
  assert.equal(p.byId("review-error-title").textContent, "AI review did not start");
  assert.equal(p.byId("review-error-message").textContent, "BugPilot couldn't start the selected AI agent.");
  assert.equal(p.byId("review-error-detail").textContent, "claude is not on PATH.");
  assert.equal(p.byId("review-error-details").hidden, false);
  const [settings] = p.byId("review-error-actions").children;
  assert.equal(settings!.textContent, "Open Settings");
  settings!.dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "command", id: "bugpilot.openSettings" });
  // The retry, and nothing else on the page claiming a failure.
  assert.equal(p.byId("review-with-ai").hidden, false);
  assert.equal(p.byId("review-with-ai").disabled, false);
  assert.deepEqual(reviewStatus(p), []);
  assert.equal(p.byId("failure").hidden, true, "the review's failure became the run's");
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");
});

test("a push that changes nothing about the review leaves its status and card alone", () => {
  // Both are announced: rewriting them on every push — a Copy press, a
  // progress event — would say the same thing again.
  const p = load();
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" } }));
  const [title] = p.byId("review-status").children;
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" }, copyingReviewPrompt: true }));
  assert.equal(p.byId("review-status").children[0], title, "the status was rebuilt by an unrelated push");

  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED } }));
  const [button] = p.byId("review-error-actions").children;
  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED }, copyingReviewPrompt: true }));
  assert.equal(p.byId("review-error-actions").children[0], button, "the card was rebuilt by an unrelated push");
});

test("focus follows the pressed button to the status once the reviewer started, and only then", () => {
  const p = load();
  p.send(reported(REPORT));
  p.byId("review-with-ai").focus();

  // Waiting: the button is still there, so the focus stays.
  p.send(reported(REPORT, { review: { state: "starting" } }));
  assert.equal(p.focused, "review-with-ai");
  // Started: the button has gone, so the status takes the focus.
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" } }));
  assert.equal(p.focused, "review-status");
  // An ordinary push after that moves nothing.
  p.byId("open-fix-report").focus();
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" }, copyingReviewPrompt: true }));
  assert.equal(p.focused, "open-fix-report");
});

test("a started review never takes a focus that was elsewhere", () => {
  const p = load();
  p.send(reported(REPORT));
  p.byId("copy-review-prompt").focus();
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" } }));
  assert.equal(p.focused, "copy-review-prompt");
});

test("review text renders as text, whatever the agent is called", () => {
  const hostile = '<img src=x onerror=alert(1)> <script>alert("x")</script>';
  const p = load();
  p.send(reported(REPORT, { review: { state: "started", agent: hostile } }));
  const [, detail] = p.byId("review-status").children;
  assert.equal(detail!.textContent, `Handed to ${hostile} in a terminal.`);
  assert.equal(detail!.children.length, 0, "the agent's name became markup");
});

test("another work item, or no report, empties the review status and card", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "started", agent: "Claude Code" } }));
  p.send(prepared({}, { workItemId: "JR-3" }));
  assert.deepEqual(reviewStatus(p), []);
  assert.equal(p.byId("review-with-ai").hidden, true);

  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED } }));
  p.send(prepared({}, { workItemId: "JR-4" }));
  assert.equal(p.byId("review-error").hidden, true);
  assert.equal(p.byId("review-error-title").textContent, "");
});

test("a review that did not start opens a workflow collapsed while it was starting", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "starting" } }));
  p.byId("workflow").open = false;

  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED } }));
  assert.equal(p.byId("workflow").open, true, "the card is inside a closed disclosure");
  // Once: collapsed again, the same card does not reopen it.
  p.byId("workflow").open = false;
  p.send(reported(REPORT, { review: { state: "failed", error: REVIEW_FAILED }, copyingReviewPrompt: true }));
  assert.equal(p.byId("workflow").open, false);
});

// --- The panel contract: page → parser → controller (§37.70) -----------------
//
// The tests above check what the page posts; the controller's tests call
// `handle()` directly. Neither crossed the parser in between, which is how the
// panel's Stop and Retry did nothing for a release while every test passed.
// Here the three are one loop: the controller renders into the real page, and
// whatever the page posts goes through the real `parsePanelMessage` into
// `controller.handle`. A message the parser drops fails the test that sent it.

const LOOP_RUN_JSON = JSON.stringify({
  schema_version: 1,
  work_item_id: "JR-12345",
  status: "prepared",
  steps: {
    doctor: "pass", fetch: "pass", parse: "pass", keywords: "pass", memory_search: "pass",
    code_search: "pass", git_context: "pass", context: "pass", prompt: "pass", memory_add: "pass",
  },
  generated_files: [],
});

const LOOP_REVIEW_PROMPT = "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n";

interface Loop {
  readonly page: Page;
  readonly controller: Controller;
  /** Every message that reached `controller.handle`, as `type` or `action:<id>`. */
  readonly routed: string[];
  readonly states: PanelState[];
  readonly terminals: string[];
  readonly clipboard: string[];
  readonly opened: string[];
  readonly jsonArgs: string[][];
  readonly hintPrompts: string[];
  readonly folders: string[];
  /** Every file the controller wrote, by path, as written. */
  readonly written: { path: string; contents: string }[];
  /** Every terminal Open AI Session brought forward. */
  readonly revealed: string[];
  readonly aborted: { value: boolean };
  /** Deliver everything the page has posted, in order: parser, then controller. */
  readonly drain: () => Promise<void>;
}

function loop(options: { holdRun?: boolean } = {}): Loop {
  const page = load();
  const routed: string[] = [];
  const states: PanelState[] = [];
  const terminals: string[] = [];
  const clipboard: string[] = [];
  const opened: string[] = [];
  const jsonArgs: string[][] = [];
  const hintPrompts: string[] = [];
  const folders: string[] = [];
  const written: { path: string; contents: string }[] = [];
  const revealed: string[] = [];
  const terminalNames: string[] = [];
  const aborted = { value: false };
  const files: Record<string, string> = {
    "run.json": LOOP_RUN_JSON,
    "context.md": "# Bug Context\n",
    "fix_report.md": "# Fix Report: JR-12345\n\n## Summary\n\nInvestigated.\n",
  };
  const ports: ControllerPorts = {
    runner: {
      runStreaming: async (_args, runOptions, onEvent) => {
        onEvent({ type: "started", work_item_id: "JR-12345", source: "jira" });
        if (options.holdRun && runOptions.signal?.aborted) aborted.value = true;
        else if (options.holdRun) {
          await new Promise<void>((resolve) => {
            runOptions.signal?.addEventListener("abort", () => { aborted.value = true; resolve(); }, { once: true });
          });
        }
        return {
          result: { code: 0, stdout: "", stderr: "", aborted: runOptions.signal?.aborted ?? false },
          terminated: !(runOptions.signal?.aborted ?? false),
          events: [],
        };
      },
      runJson: async (args) => {
        jsonArgs.push([...args]);
        if (args[0] === "review-package") {
          return {
            ok: true, command: "review-package", warnings: [], work_item_id: "JR-12345",
            prompt: LOOP_REVIEW_PROMPT,
            validation: { steps: ["Reproduce the original issue if possible."], regression_files: [], review_risks: [] },
          };
        }
        if (args.includes("--retry")) {
          return { ok: true, command: "bug", warnings: [], retry: true, feedback_created: false };
        }
        return { ok: true, command: String(args[0]), warnings: [] };
      },
    },
    files: {
      listDirectory: async () => ({ kind: "ok", names: [...PREPARED_FILES, "fix_report.md"] }),
      readFile: async (file) => {
        const key = Object.keys(files).find((name) => file.replaceAll("\\", "/").endsWith(`/${name}`));
        return key ? files[key] : undefined;
      },
      writeFile: async (path, contents) => {
        written.push({ path: path.replaceAll("\\", "/"), contents });
      },
    },
    ui: {
      render: (state) => {
        states.push(state);
        page.send(state);
      },
      openFile: async (file) => { opened.push(file.replaceAll("\\", "/")); },
      copyToClipboard: async (text) => { clipboard.push(text); },
      confirm: async () => true,
      notify: () => {},
      refreshViews: () => {},
      editCredentials: async () => {},
      runInTerminal: (name, _cwd, commandLine) => {
        terminals.push(commandLine);
        terminalNames.push(name);
      },
      revealTerminal: (matches) => {
        const name = [...terminalNames].reverse().find((candidate) => matches(candidate));
        if (name !== undefined) revealed.push(name);
        return name !== undefined;
      },
      openFolder: async (directory) => { folders.push(directory.replaceAll("\\", "/")); },
      pickFiles: async () => [],
      revealAgentPanel: async () => false,
      runCommand: async () => {},
    },
    log: { info: () => {}, error: () => {} },
    environment: async () => ({ kind: "ready", root: "/work/app", executable: "bugpilot", report: { python_ok: true } }),
    credentials: async () => ({ configured: true, environment: {} }),
    descriptionFilePath: () => "/tmp/bugpilot-description.md",
    canRun: async () => true,
    improveHint: async (request) => {
      hintPrompts.push(request.prompt);
      return { ok: true, text: "Look in the widget controller." };
    },
    loadIssueDetails: async () => ({ title: "Widget rejects the output type", description: "After reload." }),
  };
  const controller = new Controller(ports, { ...DEFAULT_FORM, issueKey: "JR-12345", hint: "look in the widget" });
  const drain = async () => {
    while (page.posted.length > 0) {
      const raw = page.posted.shift()!;
      const message = parsePanelMessage(raw);
      assert.ok(message, `the host dropped a message the page sent: ${JSON.stringify(raw)}`);
      routed.push(message.type === "action" ? `action:${message.id}` : message.type);
      await controller.handle(message);
    }
  };
  return { page, controller, routed, states, terminals, clipboard, opened, jsonArgs, hintPrompts, folders, written, revealed, aborted, drain };
}

/** Let every pending promise callback run. */
const loopSettle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("ready reaches the controller, and the page adopts the state it answers with", async () => {
  const l = loop();
  // Posted by the page as it loads, before anything else.
  assert.deepEqual(l.page.posted, [{ type: "ready" }]);
  await l.drain();
  assert.deepEqual(l.routed, ["ready"]);
  assert.equal(l.states.length, 1, "the controller did not answer ready with a state");
  // The answer carried a new revision, so the page took the host's form.
  assert.equal(l.page.byId("issue").value, "JR-12345");
});

test("Run and then Stop, pressed on the page, reach the controller; Stop cancels the preparation", async () => {
  const l = loop({ holdRun: true });
  await l.drain();
  await l.controller.refreshEnvironment();

  l.page.byId("form").dispatch("submit");
  const posted = l.page.posted.splice(0);
  assert.equal(posted.length, 1);
  const run = parsePanelMessage(posted[0]);
  assert.ok(run, "the host dropped the page's run message");
  assert.equal(run.type, "nextAction");
  assert.equal(run.type === "nextAction" && run.action, "run");
  const running = l.controller.handle(run);
  await loopSettle();
  assert.equal(l.page.byId("stop").hidden, false, "Stop is not offered while the run is in flight");

  l.page.byId("stop").dispatch("click");
  await l.drain();
  await running;

  assert.ok(l.routed.includes("stop"), "Stop never reached the controller");
  assert.equal(l.aborted.value, true, "the running preparation was not cancelled");
  assert.equal(l.states.at(-1)!.progress.state, "stopped");
});

test("Start New Attempt, pressed on the page, writes the feedback and hands over the retry package", async () => {
  // A reopened work item whose agent wrote fix_report.md: an attempt exists, so
  // the menu offers a new one. Everything below goes through the real parser.
  const l = loop();
  await l.drain();
  await l.controller.refreshEnvironment();
  await l.controller.showWorkItem("JR-12345");
  assert.equal(l.page.byId("run-label").textContent, "Open AI Session");
  assert.equal(l.page.byId("menu-startNewAttempt").hidden, false, "Start New Attempt is not offered after an attempt");

  l.page.byId("more-actions").dispatch("click");
  l.page.byId("menu-startNewAttempt").dispatch("click");
  l.page.byId("attempt-feedback").value = "The previous fix changed the wrong class.";
  l.page.byId("start-attempt").dispatch("click");
  await l.drain();

  assert.ok(l.routed.includes("startAttempt"), "Start Attempt never reached the controller");
  assert.deepEqual(l.written.map((file) => file.path), ["/work/app/.ai/JR-12345/user_feedback.md"]);
  assert.match(l.written[0]!.contents, /The previous fix changed the wrong class\./);
  // The CLI's own retry loop builds the package from it…
  assert.deepEqual(l.jsonArgs.at(-1), ["bug", "JR-12345", "--retry", "--prepare-only", "--json"]);
  // …and that package is what the new session is told to read.
  assert.deepEqual(l.terminals, [`claude ${JSON.stringify("Read .ai/JR-12345/agent_retry_prompt.md and continue the workflow.")}`]);
  assert.equal(l.page.byId("attempt-editor").hidden, true, "the form stayed open after the host started the attempt");
  assert.equal(l.page.byId("run-label").textContent, "Open AI Session");

  // Open AI Session goes back to that terminal.
  l.page.byId("form").dispatch("submit");
  await l.drain();
  assert.deepEqual(l.revealed, ["Fix with AI · JR-12345"]);
});

test("every row action and Improve, pressed on the page, reach the controller through the parser", async () => {
  const l = loop();
  await l.drain();
  await l.controller.refreshEnvironment();
  await l.controller.showWorkItem("JR-12345");
  await l.drain();

  // Only what the page is offering: the stub dispatches a click whatever the
  // button's state, so reachability is asserted here, not assumed.
  const press = async (id: string) => {
    assert.equal(l.page.byId(id).hidden, false, `${id} is not offered`);
    assert.equal(l.page.byId(id).disabled, false, `${id} is disabled`);
    l.page.byId(id).dispatch("click");
    await l.drain();
  };
  await press("open-context");
  await press("copy-context");
  await press("open-fix-report");
  await press("copy-review-prompt");
  const disclosure = l.page.byId("validation-checklist");
  disclosure.open = true;
  disclosure.dispatch("toggle");
  await l.drain();
  await press("review-with-ai");
  // A report on disk means an attempt exists: a new one is behind ⋯, and with
  // no feedback it is the same task.md handoff Fix with AI makes.
  await press("more-actions");
  await press("menu-startNewAttempt");
  await press("start-attempt");
  await press("improve-hint");
  await press("open-folder");

  // Each reached the controller as itself, in order…
  assert.deepEqual(
    l.routed.filter((type) => type !== "ready" && type !== "formChanged"),
    [
      "action:openContext",
      "action:copyContext",
      "openArtifact",
      "action:copyReviewPrompt",
      "action:loadValidation",
      "action:reviewWithAI",
      "startAttempt",
      "improveHint",
      "action:openFolder",
    ],
  );
  // Empty feedback wrote nothing.
  assert.deepEqual(l.written, []);
  assert.deepEqual(l.folders, ["/work/app/.ai/JR-12345"]);
  // …and did what that action does.
  assert.deepEqual(l.opened, ["/work/app/.ai/JR-12345/context.md", "/work/app/.ai/JR-12345/fix_report.md"]);
  assert.deepEqual(l.clipboard, ["# Bug Context\n", LOOP_REVIEW_PROMPT]);
  assert.equal(l.jsonArgs.filter((args) => args[0] === "review-package").length, 3);
  assert.deepEqual(l.terminals, [
    `claude ${JSON.stringify("# Final Review Request Review the BugPilot result for work item JR-12345.")}`,
    `claude ${JSON.stringify("Read .ai/JR-12345/task.md and complete the workflow.")}`,
  ]);
  assert.equal(l.hintPrompts.length, 1, "Improve never reached the hint improver");
});

// --- Add Review Result and Review Result, under Fix result (Batch 11) -----------

const REVIEW_PREVIEW = {
  readable: true,
  summary: "The change reads correctly.",
  findings: "One duplicate null check.",
  validationNotes: true,
  recommendations: false,
} as const;

/** A report on screen, recording allowed, and whatever else the test adds. */
const recordable = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}) =>
  reported(REPORT, { canRecordReview: true, ...extra }, overrides);

/** A report with a recorded review on screen. */
const reviewed = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}) =>
  prepared(
    {
      artifacts: [...PREPARED_FILES, "fix_report.md", "review_report.md"],
      fixReport: REPORT,
      reviewReport: REVIEW_PREVIEW,
      canRecordReview: true,
      ...extra,
    },
    overrides,
  );

const typeReview = (p: Page, fields: Partial<Record<"summary" | "findings" | "validation-notes" | "recommendations", string>>) => {
  for (const [field, value] of Object.entries(fields)) p.byId(`review-${field}`).value = value ?? "";
};

test("no report, no Add Review Result, no Review Result, no form", () => {
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("record-review-result").hidden, true);
  assert.equal(p.byId("review-result").hidden, true);
  assert.equal(p.byId("review-editor").hidden, true);
});

test("a report offers Add Review Result, which opens the form at Summary and asks the host nothing", () => {
  const p = load();
  p.send(recordable());
  const record = p.byId("record-review-result");
  assert.equal(record.hidden, false);
  assert.equal(record.getAttribute("aria-expanded"), "false");
  assert.equal(p.byId("review-result").hidden, true);
  const before = p.posted.length;

  record.dispatch("click");

  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(record.getAttribute("aria-expanded"), "true");
  assert.equal(p.focused, "review-summary");
  assert.equal(p.posted.length, before);
});

test("Save sends the four sections and nothing else, in a message the host parses", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Reads correctly.", findings: "## Minor\n- one", "validation-notes": "", recommendations: "Drop it." });

  p.byId("save-review-result").dispatch("click");

  const message = p.posted.at(-1)!;
  assert.deepEqual(message, {
    type: "recordReview",
    review: { summary: "Reads correctly.", findings: "## Minor\n- one", validationNotes: "", recommendations: "Drop it." },
  });
  assert.deepEqual(parsePanelMessage(message), message);
});

test("while the host records, Save waits and says so, and the status is announced once", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Reads correctly." });
  p.byId("save-review-result").dispatch("click");
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));

  const save = p.byId("save-review-result");
  assert.equal(save.getAttribute("aria-disabled"), "true");
  assert.equal(save.getAttribute("aria-busy"), "true");
  assert.equal(save.disabled, false, "disabled would take the focus away");
  assert.equal(p.byId("save-review-result-label").textContent, "Saving…");
  assert.equal(p.byId("review-capture-status").textContent, "Saving review result…");
  assert.equal(p.byId("review-editor").hidden, false);
  const before = p.posted.length;
  save.dispatch("click");
  assert.equal(p.posted.length, before, "a second recording was asked for");
});

test("a recording that finished closes and empties the form, shows the result, and moves focus to it", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Reads correctly." });
  p.byId("save-review-result").dispatch("click");
  p.byId("save-review-result").focus();
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));

  // The host's own word, first with the listing still being read, then with the
  // result it read back — the order the controller pushes them in.
  p.send(recordable({ reviewCapture: { state: "recorded", replaced: false } }));
  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.focused, "review-capture-status", "the focus was dropped with the form");
  p.send(reviewed({ reviewCapture: { state: "recorded", replaced: false } }));

  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-summary").value, "");
  assert.equal(p.byId("review-capture-status").textContent, "Review result saved.");
  assert.equal(p.byId("review-result").hidden, false);
  assert.equal(p.byId("review-result-status").textContent, "Review result saved");
  assert.equal(p.byId("review-result-summary").textContent, "The change reads correctly.");
  assert.equal(p.byId("review-result-detail").textContent, "Findings: One duplicate null check.");
  assert.equal(p.byId("review-result-also").textContent, "Also recorded: validation notes");
  assert.equal(p.focused, "review-capture-status");
  // Record gives way to Open and Replace.
  assert.equal(p.byId("record-review-result").hidden, true);
  assert.equal(p.byId("open-review-report").hidden, false);
  assert.equal(p.byId("replace-review-result").hidden, false);
});

test("a recording that failed keeps the form and its text, and says so in the recording's own words", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Reads correctly." });
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));

  p.send(recordable({ reviewCapture: { state: "failed", message: "Review result was not saved: disk full." } }));

  const error = p.byId("review-capture-error");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Review result was not saved: disk full.");
  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(p.byId("review-summary").value, "Reads correctly.");
  assert.equal(p.byId("review-capture-status").textContent, "");
  assert.equal(p.byId("save-review-result").getAttribute("aria-disabled"), "false");
  // Not the row's card, not the run's.
  assert.equal(p.byId("review-error").hidden, true);
  assert.equal(p.byId("failure").hidden, true);
});

test("Open Review Report asks for the one action, and names no file", () => {
  const p = load();
  p.send(reviewed());
  p.byId("open-review-report").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openReviewReport" });
});

test("Replace Review Result opens the same form, and the host is the one to ask before replacing", () => {
  const p = load();
  p.send(reviewed());
  const replace = p.byId("replace-review-result");
  replace.dispatch("click");
  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(replace.getAttribute("aria-expanded"), "true");
  typeReview(p, { summary: "A second review." });
  p.byId("save-review-result").dispatch("click");
  // No replace flag: the page does not decide that.
  assert.deepEqual(Object.keys(p.posted.at(-1)!).sort(), ["review", "type"]);
});

test("another work item closes the form and forgets what was typed for the last one", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "For JR-12345." });

  p.send(recordable({ workItemId: "JR-77777" }, { workItemId: "JR-77777" }));

  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-summary").value, "");
  assert.equal(p.byId("record-review-result").getAttribute("aria-expanded"), "false");
});

test("typing a review is not the bug being prepared: Ctrl+Enter there saves the review, never Runs", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Reads correctly." });
  const before = p.posted.length;

  // The panel's form sees the event with the review field as its target.
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("review-summary") });
  p.byId("form").dispatch("input", { target: p.byId("review-summary") });
  p.flush();
  assert.equal(p.posted.slice(before).some((message) => isRunPress(message) || message["type"] === "formChanged"), false);

  p.byId("review-editor").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("review-summary") });
  assert.equal(p.posted.at(-1)!["type"], "recordReview");
});

test("with no recording allowed, Save stays but does nothing", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  p.send(recordable({ canRecordReview: false }));
  assert.equal(p.byId("save-review-result").getAttribute("aria-disabled"), "true");
  const before = p.posted.length;
  p.byId("save-review-result").dispatch("click");
  assert.equal(p.posted.length, before);
});

test("a push that changes nothing about the review result leaves its lines and status alone", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));
  p.send(reviewed());
  const status = p.byId("review-capture-status").textContent;
  p.send(reviewed({ copyingReviewPrompt: true }));
  assert.equal(p.byId("review-capture-status").textContent, status);
  assert.equal(p.byId("review-result-summary").textContent, "The change reads correctly.");
});

test("a hostile recorded line renders as text", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const p = load();
  p.send(reviewed({ reviewReport: { ...REVIEW_PREVIEW, summary: hostile } }));
  assert.equal(p.byId("review-result-summary").textContent, hostile);
  assert.equal(p.byId("review-result-summary").children.length, 0);
});

test("a recording the host stopped tracking is not a success: the form and its text stay", () => {
  // A run started mid-recording drops the capture while Fix result stays.
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Keep me." });
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));

  p.send(recordable({ canRecordReview: false }));

  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(p.byId("review-summary").value, "Keep me.");
  assert.equal(p.byId("review-capture-status").textContent, "");
});

test("Cancel takes a failure about the discarded text off the screen", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  p.send(recordable({ reviewCapture: { state: "failed", message: "Review result was not saved: x." } }));
  assert.equal(p.byId("review-capture-error").hidden, false);
  p.byId("cancel-review-result").dispatch("click");
  assert.equal(p.byId("review-capture-error").hidden, true);
});

test("the same failure after Cancel and a new press is said again", () => {
  const failed = { state: "failed", message: "Review result was not saved: enter at least one section." } as const;
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  p.send(recordable({ reviewCapture: failed }));
  p.byId("cancel-review-result").dispatch("click");
  p.byId("record-review-result").dispatch("click");
  // The host clears its capture on the new press, then says the same thing.
  p.send(recordable());
  p.send(recordable({ reviewCapture: failed }));
  assert.equal(p.byId("review-capture-error").hidden, false);
  assert.equal(p.byId("review-capture-error").textContent, failed.message);
});

// --- Paste Review Output: a pasted review fills the form, never saves it -------

const PREFILL_ENTRY = {
  summary: "Main fix addresses the issue.",
  findings: "Missing null handling in WidgetController.",
  validationNotes: "Reviewed the diff. No tests were run.",
  recommendations: "Add a regression test.",
};
const PREFILL_NOTE = "Prefilled from structured review output — review before saving.";
const openPaste = (p: Page) => p.byId("paste-review-output").dispatch("click");
const reviewValues = (p: Page) => ({
  summary: p.byId("review-summary").value,
  findings: p.byId("review-findings").value,
  validationNotes: p.byId("review-validation-notes").value,
  recommendations: p.byId("review-recommendations").value,
});

test("Paste Review Output is offered beside Add Review Result, and only when the host offers it", () => {
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("paste-review-output").hidden, true);
  p.send(recordable());
  assert.equal(p.byId("paste-review-output").hidden, false);
  assert.equal(p.byId("paste-review-output").getAttribute("aria-expanded"), "false");
  p.send(reviewed());
  assert.equal(p.byId("paste-review-output").hidden, false, "a saved review can be replaced from a paste too");
  p.send(recordable({ canRecordReview: false }));
  assert.equal(p.byId("paste-review-output").hidden, true);
});

test("the paste box opens at its text area, and Parse sends only the pasted text — never a save", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  assert.equal(p.byId("review-paste").hidden, false);
  assert.equal(p.byId("paste-review-output").getAttribute("aria-expanded"), "true");
  assert.equal(p.focused, "review-paste-text");
  p.byId("review-paste-text").value = "## Summary\nA.\n";

  p.byId("parse-review-output").dispatch("click");

  const message = p.posted.at(-1)!;
  assert.deepEqual(message, { type: "parseReviewOutput", text: "## Summary\nA.\n" });
  assert.deepEqual(parsePanelMessage(message), message);
  assert.equal(p.posted.some((sent) => sent["type"] === "recordReview"), false);
});

test("the host's reading fills the form, says it was prefilled and is ready to save, and saves nothing", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  p.byId("review-paste-text").value = "pasted";
  p.byId("parse-review-output").dispatch("click");
  const before = p.posted.length;

  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY } }));

  assert.deepEqual(reviewValues(p), PREFILL_ENTRY);
  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(p.byId("record-review-result").getAttribute("aria-expanded"), "true");
  assert.equal(p.byId("review-prefill-note").hidden, false);
  assert.equal(p.byId("review-prefill-note").textContent, PREFILL_NOTE);
  assert.equal(p.byId("review-capture-status").textContent, "Review result ready to save.");
  assert.equal(p.focused, "review-summary");
  // The paste box has done its job and is emptied.
  assert.equal(p.byId("review-paste").hidden, true);
  assert.equal(p.byId("review-paste-text").value, "");
  // Nothing sent: Save is still the developer's.
  assert.equal(p.posted.length, before);
  // Never a verdict, and never said as one.
  for (const word of ["Passed", "Approved", "Verified", "PASS"]) {
    assert.equal(p.byId("review-capture-status").textContent.includes(word), false, word);
    assert.equal(p.byId("review-prefill-note").textContent.includes(word), false, word);
  }
});

test("a prefilled review stays editable: the next push does not refill it, and Save sends the edits", () => {
  const p = load();
  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY } }));
  p.byId("review-findings").value = "Edited findings.";
  // The same answer again — a push that repeats it — changes nothing.
  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY } }));
  p.send(recordable({ copyingReviewPrompt: true }));
  assert.equal(p.byId("review-findings").value, "Edited findings.");

  p.byId("save-review-result").dispatch("click");

  assert.deepEqual(p.posted.at(-1), {
    type: "recordReview",
    review: { ...PREFILL_ENTRY, findings: "Edited findings." },
  });
});

test("a paste with a lead-in says the lead-in was left out", () => {
  const p = load();
  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY, leftOut: true } }));
  assert.equal(p.byId("review-prefill-note").textContent, `${PREFILL_NOTE} Text before the first section was left out.`);
});

test("a paste that could not be read is said under the paste, which keeps its text, and the form stays shut", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  p.byId("review-paste-text").value = "Verdict: PASS";
  p.byId("parse-review-output").dispatch("click");
  const message = "Review output was not read: these sections are missing: ## Summary, ## Findings.";

  p.send(recordable({ reviewPrefill: { token: 1, error: message } }));

  const error = p.byId("review-paste-error");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, message);
  assert.equal(p.byId("review-paste").hidden, false);
  assert.equal(p.byId("review-paste-text").value, "Verdict: PASS");
  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-capture-status").textContent, "");
  // The saving's alert is not where a parse failure goes.
  assert.equal(p.byId("review-capture-error").hidden, true);
});

test("a save of the prefilled form that finished closes it and forgets it was prefilled", () => {
  const p = load();
  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY } }));
  p.byId("save-review-result").dispatch("click");
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));
  assert.equal(p.byId("review-capture-status").textContent, "Saving review result…");
  p.send(reviewed({ reviewCapture: { state: "recorded", replaced: false } }));

  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-prefill-note").hidden, true);
  assert.equal(p.byId("review-summary").value, "");
  assert.equal(p.byId("review-capture-status").textContent, "Review result saved.");
  assert.equal(p.byId("review-result-status").textContent, "Review result saved");
});

test("Cancel on a prefilled form empties it and takes back ready to save", () => {
  const p = load();
  p.send(recordable({ reviewPrefill: { token: 1, entry: PREFILL_ENTRY } }));
  p.byId("cancel-review-result").dispatch("click");
  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-prefill-note").hidden, true);
  assert.equal(p.byId("review-summary").value, "");
  assert.equal(p.byId("review-capture-status").textContent, "");
  // Typing a review by hand afterwards is plain manual entry, with no prefill note.
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  assert.equal(p.byId("review-prefill-note").hidden, true);
  assert.equal(p.byId("review-capture-status").textContent, "");
});

test("Cancel on the paste box empties it and returns to Paste Review Output", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  p.byId("review-paste-text").value = "draft";
  p.byId("cancel-review-paste").dispatch("click");
  assert.equal(p.byId("review-paste").hidden, true);
  assert.equal(p.byId("review-paste-text").value, "");
  assert.equal(p.byId("paste-review-output").getAttribute("aria-expanded"), "false");
  assert.equal(p.focused, "paste-review-output");
});

test("pasting is not the bug being prepared: Ctrl+Enter there parses, never Runs", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  p.byId("review-paste-text").value = "## Summary\nA.";
  const before = p.posted.length;
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("review-paste-text") });
  p.byId("form").dispatch("input", { target: p.byId("review-paste-text") });
  p.flush();
  assert.equal(p.posted.slice(before).some((message) => isRunPress(message) || message["type"] === "formChanged"), false);

  p.byId("review-paste").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("review-paste-text") });
  assert.equal(p.posted.at(-1)!["type"], "parseReviewOutput");
});

test("while a save is in flight Parse waits, and another work item empties the paste box", () => {
  const p = load();
  p.send(recordable());
  openPaste(p);
  p.byId("review-paste-text").value = "draft";
  p.send(recordable({ canRecordReview: false, reviewCapture: { state: "recording" } }));
  assert.equal(p.byId("parse-review-output").getAttribute("aria-disabled"), "true");
  const before = p.posted.length;
  p.byId("parse-review-output").dispatch("click");
  assert.equal(p.posted.length, before);

  p.send(recordable({ workItemId: "JR-77777" }, { workItemId: "JR-77777" }));
  assert.equal(p.byId("review-paste").hidden, true);
  assert.equal(p.byId("review-paste-text").value, "");
});

test("the form says what belongs in each section, tied to its field", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  const hints: Record<string, string> = {
    "review-summary": "Overall review conclusion in the reviewer's own words.",
    "review-findings": "Specific problems, risks, omissions, or observations.",
    "review-validation-notes": "What the reviewer actually inspected or ran. Do not imply tests ran if they did not.",
    "review-recommendations": "Suggested next actions.",
  };
  for (const [field, text] of Object.entries(hints)) {
    assert.ok(HTML.includes(`<p class="hint" id="${field}-hint">${text}</p>`), field);
    assert.ok(HTML.includes(`id="${field}" rows="`) && HTML.includes(`aria-describedby="${field}-hint"`), field);
  }
});

// --- Verification Evidence, under Fix result (Batch 12) ------------------------

const VERIFICATION_PREVIEW = {
  readable: true,
  passed: 1,
  failed: 1,
  notRun: 0,
  preview: [
    { name: "Unit tests", status: "passed", type: "automated" },
    { name: "Open the dialog", status: "failed", type: "manual" },
  ],
  more: 0,
} as const;

/** A report on screen, verification recording allowed, and whatever else the test adds. */
const verifiablePage = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}) =>
  reported(REPORT, { canRecordVerification: true, ...extra }, overrides);

/** A report with recorded evidence on screen. */
const evidenced = (extra: Partial<WorkflowInput> = {}, overrides: Partial<PanelState> = {}) =>
  prepared(
    {
      artifacts: [...PREPARED_FILES, "fix_report.md", "verification_report.md"],
      fixReport: REPORT,
      verificationReport: VERIFICATION_PREVIEW,
      canRecordVerification: true,
      ...extra,
    },
    overrides,
  );

/** The form's rows, by what each control is. */
function checkRows(p: Page) {
  return p.byId("verification-rows").children.map((group) => {
    const all = flatten(group);
    const find = (suffix: string) => {
      const found = all.find((element) => element.id.endsWith(suffix));
      assert.ok(found, `a check row has no control ending ${suffix}`);
      return found;
    };
    return {
      group,
      heading: group.children[0]!,
      name: find("-name"),
      status: find("-status"),
      type: find("-type"),
      procedure: find("-procedure"),
      evidence: find("-evidence"),
      notes: find("-notes"),
      remove: find("-remove"),
    };
  });
}

const openRecord = (p: Page) => p.byId("record-verification").dispatch("click");

test("no report, no Add Verification Evidence, no evidence, no form", () => {
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("record-verification").hidden, true);
  assert.equal(p.byId("verification-result").hidden, true);
  assert.equal(p.byId("verification-editor").hidden, true);
});

test("Record opens the form with one check — Not Run and Automated, never Passed — and asks the host nothing", () => {
  const p = load();
  p.send(verifiablePage());
  const record = p.byId("record-verification");
  assert.equal(record.hidden, false);
  assert.equal(p.byId("actions-fixResult").hidden, false);
  const before = p.posted.length;

  openRecord(p);

  assert.equal(p.byId("verification-editor").hidden, false);
  assert.equal(record.getAttribute("aria-expanded"), "true");
  const rows = checkRows(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status.value, "not_run");
  assert.equal(rows[0]!.type.value, "automated");
  assert.equal(rows[0]!.name.value, "");
  assert.deepEqual(rows[0]!.status.children.map((option) => option.value), ["not_run", "passed", "failed"]);
  assert.deepEqual(rows[0]!.type.children.map((option) => option.value), ["automated", "manual", "other"]);
  assert.equal(p.focused, rows[0]!.name.id);
  assert.equal(p.posted.length, before);
});

test("each row and control is named for its check, and renumbered when one goes", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  p.byId("add-verification-check").dispatch("click");
  p.byId("add-verification-check").dispatch("click");
  let rows = checkRows(p);
  rows[1]!.name.value = "Unit tests";
  rows[1]!.name.dispatch("input");
  assert.deepEqual(rows.map((row) => row.heading.textContent), ["Check 1", "Check 2", "Check 3"]);
  assert.equal(rows[1]!.group.getAttribute("aria-label"), "Check 2");
  assert.equal(rows[1]!.name.getAttribute("aria-label"), "Check 2 name");
  assert.equal(rows[1]!.status.getAttribute("aria-label"), "Check 2 recorded status");
  assert.equal(rows[1]!.evidence.getAttribute("aria-label"), "Check 2 evidence");
  assert.equal(rows[1]!.remove.getAttribute("aria-label"), "Remove check 2: Unit tests");
  assert.equal(p.focused, rows[2]!.name.id, "Add Check did not move to the new row");

  rows[0]!.remove.dispatch("click");

  rows = checkRows(p);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name.value, "Unit tests");
  assert.equal(rows[0]!.remove.getAttribute("aria-label"), "Remove check 1: Unit tests");
  assert.equal(p.focused, rows[0]!.remove.id, "the focus was lost with the removed row");
  rows[1]!.remove.dispatch("click");
  checkRows(p)[0]!.remove.dispatch("click");
  assert.equal(checkRows(p).length, 0);
  assert.equal(p.focused, "add-verification-check");
});

test("the form says it is for checks actually performed, and that BugPilot infers nothing", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  const note = HTML.match(/<p class="muted verification-editor-note" id="verification-editor-note">([^<]*)<\/p>/)?.[1] ?? "";
  assert.match(note, /^Record checks you actually performed and what you observed\./);
  assert.match(note, /BugPilot does not run these checks or infer the result\./);
  assert.match(note, /belongs in Review Result/, "review observations are not verification evidence");
  assert.equal(/verified/i.test(note), false);
});

test("each field has one line on what goes in it, and examples only as placeholders", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  const row = checkRows(p)[0]!;
  const all = flatten(row.group);
  const hintFor = (control: FakeElement) => all.find((element) => element.id === control.getAttribute("aria-describedby"))?.textContent;
  assert.equal(hintFor(row.name), "What was checked.");
  assert.equal(hintFor(row.status), "The status you are recording for this check.");
  assert.equal(hintFor(row.type), "Automated, Manual or Other.");
  assert.equal(hintFor(row.procedure), "The command you ran or the manual steps you followed.");
  assert.equal(hintFor(row.evidence), "The observed output or result supporting the recorded status.");
  assert.equal(hintFor(row.notes), "Optional limitations or context.");
  assert.match(row.name.getAttribute("placeholder") ?? "", /Targeted unit tests.*Original bug reproduction/);
  assert.match(row.procedure.getAttribute("placeholder") ?? "", /npm test.*Repeat the reported workflow manually/);
  assert.match(row.evidence.getAttribute("placeholder") ?? "", /1285 passed, 0 failed.*The issue no longer reproduces/);
  // A placeholder is not a value: an untouched check saves nothing of the examples.
  row.name.value = "Unit tests";
  row.name.dispatch("input");
  const sent = p.posted.at(-1)! as { checks: Record<string, string>[] };
  assert.deepEqual(sent.checks[0], {
    name: "Unit tests",
    status: "not_run",
    type: "automated",
    procedure: "",
    evidence: "",
    notes: "",
  });
});

test("Add Check stops at the CLI's 25, and says why", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  for (let index = 0; index < 30; index += 1) p.byId("add-verification-check").dispatch("click");
  assert.equal(checkRows(p).length, 25);
  assert.equal(p.byId("add-verification-check").getAttribute("aria-disabled"), "true");
  assert.match(p.byId("add-verification-check").getAttribute("title") ?? "", /At most 25/);
});

test("the preview is bounded: five checks, then how many more are in the file", () => {
  const p = load();
  const preview = Array.from({ length: 5 }, (_, index) => ({ name: `Check ${index + 1}`, status: "not_run", type: "other" }) as const);
  p.send(evidenced({ verificationReport: { readable: true, passed: 0, failed: 0, notRun: 9, preview, more: 4 } }));
  assert.equal(p.byId("verification-result-checks").children.length, 5);
  assert.equal(p.byId("verification-result-more").hidden, false);
  assert.equal(p.byId("verification-result-more").textContent, "+4 more in verification_report.md");
  assert.equal(p.byId("verification-result-overall").textContent, "No recorded check has been run.");
});

test("Edit of a report BugPilot could not read into checks starts with one new row and says saving replaces it", () => {
  const p = load();
  p.send(evidenced({ verificationEdit: { token: 7, checks: [], structured: false, unreadable: false } }));
  assert.equal(p.byId("verification-editor").hidden, false);
  assert.equal(p.byId("verification-editor-replace-note").hidden, false);
  assert.equal(checkRows(p).length, 1);
  assert.equal(checkRows(p)[0]!.status.value, "not_run");
});

test("Open Verification Report asks for the one action, and names no file", () => {
  const p = load();
  p.send(evidenced());
  p.byId("open-verification-report").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openVerificationReport" });
});

test("another work item closes the form and forgets the rows typed for the last one", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  checkRows(p)[0]!.name.value = "For JR-12345.";
  p.send(verifiablePage({ workItemId: "JR-77777" }, { workItemId: "JR-77777" }));
  assert.equal(p.byId("verification-editor").hidden, true);
  assert.equal(checkRows(p).length, 0);
  assert.equal(p.byId("record-verification").getAttribute("aria-expanded"), "false");
});

test("Cancel closes and empties the form, and returns to the button that opened it", () => {
  const p = load();
  p.send(recordable());
  p.byId("record-review-result").dispatch("click");
  typeReview(p, { summary: "Draft." });
  p.byId("cancel-review-result").dispatch("click");
  assert.equal(p.byId("review-editor").hidden, true);
  assert.equal(p.byId("review-summary").value, "");
  assert.equal(p.focused, "record-review-result");
});

test("recorded lines render as text, and the page adds no verdict of its own", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const p = load();
  p.send(
    evidenced({
      verificationReport: { ...VERIFICATION_PREVIEW, preview: [{ name: hostile, status: "passed", type: "automated" }] },
    }),
  );
  const item = p.byId("verification-result-checks").children[0]!;
  assert.equal(item.textContent, `${hostile} · Passed · Automated`);
  assert.equal(item.children.length, 0);
  const shown = [
    p.byId("verification-result-counts").textContent,
    p.byId("verification-result-overall").textContent,
    item.textContent,
  ].join(" ");
  assert.doesNotMatch(shown, /Verified|Approved|Correct|Safe to merge|Fix verified/);
});

test("plain Enter in a check's name never runs the panel: the implicit submit is ignored, the key is held", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  const [row] = checkRows(p);
  row!.name.value = "Unit tests";
  // The document knows the row's controls, as a real one would.
  p.elements.set(row!.name.id, row!.name);
  row!.name.focus();
  const before = p.posted.length;
  let prevented = false;

  p.byId("verification-editor").dispatch("keydown", { key: "Enter", target: row!.name, preventDefault: () => (prevented = true) });
  // Should the browser submit anyway, the form's own handler still refuses.
  p.byId("form").dispatch("submit", { target: p.byId("form") });

  assert.equal(prevented, true, "plain Enter in the name was left to submit the form");
  assert.equal(p.posted.slice(before).some((message) => isRunPress(message)), false);
  // A text area keeps its Enter.
  let areaPrevented = false;
  p.byId("verification-editor").dispatch("keydown", { key: "Enter", target: row!.evidence, preventDefault: () => (areaPrevented = true) });
  assert.equal(areaPrevented, false);
  // And outside the editor, submitting still runs.
  p.focused = undefined;
  p.byId("form").dispatch("submit", { target: p.byId("form") });
  // (The primary action, whatever it says: here a report exists, so it is
  // Open AI Session.)
  assert.equal(p.posted.at(-1)!["type"], "nextAction", "submitting outside the editor did not press the primary action");
});

test("closing and reopening the form keeps what was typed; only Cancel, a save or another item empties it", () => {
  const p = load();
  p.send(verifiablePage());
  openRecord(p);
  p.byId("add-verification-check").dispatch("click");
  checkRows(p)[0]!.name.value = "Unit tests";
  checkRows(p)[1]!.name.value = "Open the dialog";

  openRecord(p);
  assert.equal(p.byId("verification-editor").hidden, true);
  openRecord(p);
  assert.equal(p.byId("verification-editor").hidden, false);
  assert.deepEqual(checkRows(p).map((row) => row.name.value), ["Unit tests", "Open the dialog"]);
});

test("Edit of a listed report that could not be read says so, not that it is in another format", () => {
  const p = load();
  p.send(evidenced({ verificationEdit: { token: 2, checks: [], structured: false, unreadable: true } }));
  assert.match(p.byId("verification-editor-replace-note").textContent, /could not be read/);
  const q = load();
  q.send(evidenced({ verificationEdit: { token: 2, checks: [], structured: false, unreadable: false } }));
  assert.match(q.byId("verification-editor-replace-note").textContent, /not in BugPilot's format/);
});

// --- Workflow Settings: navigation, draft, Apply --------------------------------

/** A panel with a prepared work item and an applied set of search settings. */
const settingsPage = (overrides: Partial<PanelState> = {}) => {
  const p = load();
  p.send({ ...prepared(), revision: 2, form: { ...DEFAULT_FORM, issueKey: "JR-12345", keywords: "applied" }, ...overrides });
  return p;
};

test("settings 3: Code search's gear opens Workflow Settings at Code search, highlighted, on Keywords", () => {
  const p = settingsPage();
  const before = p.posted.length;
  p.byId("settings-codeSearch").dispatch("click");

  assert.equal(p.byId("workflow-settings-view").hidden, false);
  assert.equal(p.byId("main-view").hidden, true);
  const section = p.byId("settings-section-code-search");
  assert.deepEqual(section.scrolledIntoView, { behavior: "smooth", block: "start" });
  assert.ok(section.classes.has("settings-section-target"));
  assert.equal(p.byId("settings-section-fix-with-ai").classes.has("settings-section-target"), false);
  assert.equal(p.focused, "keywords");
  // Opening the page asks the host nothing, and starts nothing.
  assert.deepEqual(p.posted.slice(before), []);
  // The emphasis is brief.
  p.flush();
  assert.equal(section.classes.has("settings-section-target"), false);
});

test("settings 4: Fix with AI's gear lands on Fix with AI, at the AI agent", () => {
  const p = settingsPage();
  p.byId("settings-fixWithAI").dispatch("click");
  assert.ok(p.byId("settings-section-fix-with-ai").classes.has("settings-section-target"));
  assert.deepEqual(p.byId("settings-section-fix-with-ai").scrolledIntoView, { behavior: "smooth", block: "start" });
  assert.equal(p.focused, "agent");
});

test("settings 12: each gear focuses its section's first control on screen", () => {
  const p = settingsPage();
  // A Jira issue: Title is for a hand-written bug and is hidden, so Attachments.
  p.byId("settings-issueDetails").dispatch("click");
  assert.equal(p.focused, "add-attachment");
  p.byId("settings-back").dispatch("click");
  p.byId("issue").value = "The dialog crashes on save.";
  p.byId("form").dispatch("input", { target: p.byId("issue") });
  p.byId("settings-issueDetails").dispatch("click");
  assert.equal(p.focused, "title");
  p.byId("settings-back").dispatch("click");
  p.byId("settings-buildContext").dispatch("click");
  assert.equal(p.focused, "fresh");
  p.byId("settings-back").dispatch("click");
  // The entry opens the page at its top.
  p.byId("open-settings").dispatch("click");
  assert.equal(p.focused, "settings-heading");
  assert.deepEqual(p.byId("settings-heading").scrolledIntoView, { behavior: "smooth", block: "start" });
});

test("settings 12: during a run the fields are read-only, so the section's heading takes focus", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [], artifacts: [] } }));
  p.byId("settings-codeSearch").dispatch("click");
  assert.equal(p.byId("keywords").disabled, true);
  assert.equal(p.focused, "settings-title-code-search");
});

test("settings 5 and 6: Back returns to the form, on the gear, with everything on the form as it was", () => {
  const p = settingsPage();
  p.byId("issue").value = "JR-777";
  p.byId("plan-gitHistory").checked = false;
  p.byId("plan-fixWithAI").checked = true;
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "a draft";
  p.byId("settings-back").dispatch("click");

  assert.equal(p.byId("main-view").hidden, false);
  assert.equal(p.byId("workflow-settings-view").hidden, true);
  assert.equal(p.focused, "settings-codeSearch");
  assert.equal(p.byId("issue").value, "JR-777");
  assert.equal(p.byId("plan-gitHistory").checked, false);
  assert.equal(p.byId("plan-fixWithAI").checked, true);
  // Back discards, like Cancel.
  assert.equal(p.byId("keywords").value, "applied");
});

test("settings 7: Cancel discards the draft, and a press after it sends the applied settings", () => {
  const p = settingsPage();
  p.byId("settings-fixWithAI").dispatch("click");
  p.byId("agent").value = "custom";
  p.byId("workflow-settings-view").dispatch("change", { target: p.byId("agent") });
  assert.equal(p.byId("field-agentCommand").hidden, false);
  p.byId("keywords").value = "draft";
  p.byId("fresh").checked = true;
  const before = p.posted.length;
  p.byId("settings-cancel").dispatch("click");

  assert.deepEqual(p.posted.slice(before), [], "Cancel told the host something");
  assert.equal(p.byId("agent").value, "auto");
  assert.equal(p.byId("field-agentCommand").hidden, true);
  assert.equal(p.byId("keywords").value, "applied");
  assert.equal(p.byId("fresh").checked, false);
  p.byId("form").dispatch("submit");
  const form = p.posted.at(-1)!["form"] as FormState;
  assert.equal(form.agent, "auto");
  assert.equal(form.keywords, "applied");
  assert.equal(form.fresh, false);
});

test("settings 7: Escape cancels and Ctrl+Enter applies, from anywhere on the page", () => {
  const p = settingsPage();
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "draft";
  p.byId("workflow-settings-view").dispatch("keydown", { key: "Escape", target: p.byId("keywords") });
  assert.equal(p.byId("workflow-settings-view").hidden, true);
  assert.equal(p.byId("keywords").value, "applied");

  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "applied by keyboard";
  p.byId("workflow-settings-view").dispatch("keydown", { key: "Enter", ctrlKey: true, target: p.byId("keywords") });
  assert.equal(p.posted.at(-1)!["type"], "applySettings");
  assert.equal((p.posted.at(-1)!["form"] as FormState).keywords, "applied by keyboard");
});

test("settings 8: Apply sends the whole form with the draft once, returns to the form, and a press then carries it", () => {
  const p = settingsPage();
  p.byId("issue").value = "JR-12345";
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "VolumeDescriptor";
  p.byId("maxFiles").value = "10";
  p.byId("settings-apply").dispatch("click");

  const applied = p.posted.at(-1) as { type: string; form: FormState };
  assert.equal(applied.type, "applySettings");
  assert.equal(applied.form.keywords, "VolumeDescriptor");
  assert.equal(applied.form.maxFiles, "10");
  // The form's own fields ride along unchanged.
  assert.equal(applied.form.issueKey, "JR-12345");
  assert.equal(p.posted.filter((message) => message["type"] === "applySettings").length, 1);
  assert.equal(p.byId("workflow-settings-view").hidden, true);
  assert.equal(p.focused, "settings-codeSearch");
  p.byId("form").dispatch("submit");
  assert.equal((p.posted.at(-1)!["form"] as FormState).keywords, "VolumeDescriptor");
});

test("settings 17: a form change waiting on the debounce cannot overwrite what was just applied", () => {
  const p = settingsPage();
  // Typed on the form a moment ago: its snapshot holds the settings before Apply.
  p.byId("issue").value = "JR-12345";
  p.byId("form").dispatch("input", { target: p.byId("issue") });
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "newly applied";
  p.byId("settings-apply").dispatch("click");
  p.flush();

  const changes = p.posted.filter((message) => message["type"] === "formChanged");
  assert.deepEqual(changes, [], "the older snapshot went out after Apply");
  // And a later change on the form carries the applied settings, not the old ones.
  p.byId("plan-gitHistory").checked = false;
  p.byId("form").dispatch("change", { target: p.byId("plan-gitHistory") });
  p.flush();
  assert.equal((p.posted.at(-1)!["form"] as FormState).keywords, "newly applied");
});

test("settings 18: while the host is busy Apply waits and says why; the page is still readable", () => {
  const p = settingsPage();
  p.send({ ...prepared({ handoffBusy: true }) });
  p.byId("settings-fixWithAI").dispatch("click");
  assert.equal(p.byId("settings-apply").getAttribute("aria-disabled"), "true");
  assert.equal(p.byId("settings-busy").hidden, false);
  p.byId("hint").value = "typed while busy";
  const before = p.posted.length;
  p.byId("settings-apply").dispatch("click");
  assert.deepEqual(p.posted.slice(before), [], "Apply went out over an operation in flight");
  assert.equal(p.byId("workflow-settings-view").hidden, false, "the page closed as if applied");

  // Free again: Apply works, with what was typed.
  p.send(prepared());
  assert.equal(p.byId("settings-apply").getAttribute("aria-disabled"), "false");
  assert.equal(p.byId("settings-busy").hidden, true);
  p.byId("settings-apply").dispatch("click");
  assert.equal((p.posted.at(-1)!["form"] as FormState).hint, "typed while busy");
});

test("settings: a form the host replaces while the page is open replaces the draft too", () => {
  // Another work item opened from History, or a mode the host restored: the
  // host's form supersedes a draft of the one before, and a push is never a
  // silent partial merge.
  const p = settingsPage();
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "a draft for the old item";
  p.send({ ...prepared(), revision: 3, form: { ...DEFAULT_FORM, issueKey: "JR-2", keywords: "the host's" } });
  assert.equal(p.byId("keywords").value, "the host's");
  p.byId("settings-cancel").dispatch("click");
  assert.equal(p.byId("keywords").value, "the host's");
});

test("settings 13: each row's summary is the host's line, and absent when there is none", () => {
  const p = load();
  const workflow = buildWorkflow({
    source: "jira",
    plan: DEFAULT_FORM.plan,
    fixWithAI: false,
    progress: { state: "idle", rows: [], artifacts: [] },
    artifacts: [],
    settingsSummaries: { codeSearch: "4 keywords · 2 focus paths · max 10 files", fixWithAI: "Claude Code · Standard Fix" },
  });
  p.send(state({ workflow }));
  assert.equal(p.byId("settings-summary-codeSearch").textContent, "4 keywords · 2 focus paths · max 10 files");
  assert.equal(p.byId("settings-summary-codeSearch").hidden, false);
  assert.equal(p.byId("settings-summary-fixWithAI").textContent, "Claude Code · Standard Fix");
  assert.equal(p.byId("settings-summary-issueDetails").hidden, true);
  assert.equal(p.byId("settings-summary-buildContext").hidden, true);
  // And the row still says what it does.
  assert.equal(p.byId("description-codeSearch").textContent, "Search relevant code in the repository");

  p.send(state());
  assert.equal(p.byId("settings-summary-codeSearch").hidden, true, "a summary outlived the settings it described");
});

test("settings 16: a gear works while the row is running, and never ticks its checkbox", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [row("code_search", "running")], artifacts: [] } }));
  const checked = p.byId("plan-codeSearch").checked;
  p.byId("settings-codeSearch").dispatch("click");
  assert.equal(p.byId("plan-codeSearch").checked, checked);
  assert.equal(p.byId("workflow-settings-view").hidden, false);
});

// --- Review with AI, captured: Reviewing…, the draft, and the fallback --------

const CAPTURED = {
  summary: "Handles the null input.",
  findings: "Nothing to report.",
  validationNotes: "Ran git diff. No tests were run.",
  recommendations: "Add a regression test.",
};

// --- The captured review's progress card (§37.82) -----------------------------

/** A report on screen with a captured review running, started `ago` ms before the page's clock. */
const running = (p: Page, ago = 0, extra: Partial<WorkflowInput> = {}) =>
  reported(REPORT, {
    review: { state: "reviewing", agent: "Claude Code", startedAt: p.clock.now - ago },
    reviewedCurrentFix: true,
    ...extra,
  });

test("while the reviewer runs: the button is gone, the agent is named, a spinner, the read-only line, the clock", () => {
  const p = load();
  p.send(running(p));
  assert.equal(p.byId("review-with-ai").hidden, true);
  assert.deepEqual(reviewStatus(p), [
    "Reviewing with Claude Code…",
    "BugPilot is running a read-only AI review in the background. This may take a minute.",
  ]);
  const title = p.byId("review-status").children[0]!;
  assert.ok(title.children[0]!.classes.has("codicon-spin"), "no spinner");
  assert.equal(title.children[0]!.getAttribute("aria-hidden"), "true");
  assert.equal(p.byId("review-progress").hidden, false);
  assert.equal(p.byId("review-progress").getAttribute("aria-busy"), "true");
  assert.equal(p.byId("review-elapsed").textContent, "00:00");
  assert.equal(p.byId("review-editor").hidden, true, "a form opened before there was a reply");
  // No percentage anywhere.
  assert.equal(/\d+%/.test(JSON.stringify(reviewStatus(p))), false);
});

test("the agent's name is the host's: none given, and it reads Reviewing with AI…", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "reviewing", agent: "", startedAt: p.clock.now }, reviewedCurrentFix: true }));
  assert.equal(reviewStatus(p)[0], "Reviewing with AI…");
});

test("the elapsed clock ticks once a second from the host's start, and one interval however many pushes", () => {
  const p = load();
  p.send(running(p, 18_000));
  assert.equal(p.byId("review-elapsed").textContent, "00:18");
  for (let i = 0; i < 5; i += 1) p.send(running(p, 18_000));
  assert.equal(p.intervals.size, 1, "a push started a second interval");
  p.advance(1_000);
  assert.equal(p.byId("review-elapsed").textContent, "00:19");
  p.advance(42_000);
  assert.equal(p.byId("review-elapsed").textContent, "01:01");
  p.advance(3_600_000);
  assert.equal(p.byId("review-elapsed").textContent, "1:01:01");
});

test("a recreated panel resumes the clock from the host's start time, not from 00:00", () => {
  const first = load();
  const startedAt = first.clock.now - 75_000;
  const state = reported(REPORT, { review: { state: "reviewing", agent: "Claude Code", startedAt }, reviewedCurrentFix: true });
  first.send(state);
  const again = load();
  again.clock.now = startedAt + 75_000;
  again.send(state);
  assert.equal(again.byId("review-elapsed").textContent, "01:15");
});

test("the clock is not read out: it ticks outside the status live region, which stays as it was", () => {
  const p = load();
  p.send(running(p));
  const before = JSON.stringify(reviewStatus(p));
  const statusNodes = p.byId("review-status").children.length;
  p.advance(5_000);
  assert.equal(JSON.stringify(reviewStatus(p)), before);
  assert.equal(p.byId("review-status").children.length, statusNodes);
  assert.equal(p.byId("review-elapsed").textContent, "00:05");
  assert.equal(p.byId("review-progress").getAttribute("role"), undefined, "the clock's container is a live region");
  assert.equal(p.byId("review-progress").getAttribute("aria-live"), undefined);
});

test("the clock stops when the review finishes, fails or is cancelled", () => {
  for (const next of [
    { state: "captured", agent: "Claude Code" },
    { state: "captureFailed", agent: "Claude Code", title: "AI review did not finish within the allowed time.", detail: "d" },
    { state: "cancelled", agent: "Claude Code" },
  ] as const) {
    const p = load();
    p.send(running(p));
    assert.equal(p.intervals.size, 1);
    p.send(reported(REPORT, { review: next, reviewedCurrentFix: next.state !== "cancelled" }));
    assert.equal(p.intervals.size, 0, `the clock kept running after ${next.state}`);
    assert.equal(p.byId("review-progress").hidden, true);
    assert.equal(p.byId("review-progress").getAttribute("aria-busy"), "false");
  }
});

test("Show details opens the details in place, a tick keeps them open, Hide details closes them", () => {
  const p = load();
  p.send(running(p));
  const toggle = p.byId("review-details-toggle");
  assert.equal(p.byId("review-details").hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(p.byId("review-details-toggle-label").textContent, "Show details");

  toggle.dispatch("click");

  assert.equal(p.byId("review-details").hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(p.byId("review-details-toggle-label").textContent, "Hide details");
  const terms = p.byId("review-details").children.map((child) => child.textContent);
  assert.deepEqual(terms.filter((_, index) => index % 2 === 0), ["Agent", "Mode", "Status", "Started", "Output format"]);
  assert.equal(terms[1], "Claude Code");
  assert.equal(terms[3], "Read-only background review");
  assert.equal(terms[5], "Running");
  assert.equal(terms[9], "Summary, Findings, Validation Notes, Recommendations");
  // Nothing about the prompt, a command or the environment.
  assert.equal(/prompt|--|PATH|claude -p|token/i.test(terms.join(" ")), false, terms.join(" | "));
  p.advance(3_000);
  p.send(running(p, 3_000));
  assert.equal(p.byId("review-details").hidden, false, "a tick or a push closed the details");

  toggle.dispatch("click");
  assert.equal(p.byId("review-details").hidden, true);
  // A finished review takes the card and its details with it; the next one starts closed.
  toggle.dispatch("click");
  p.send(reported(REPORT, { review: { state: "captured", agent: "Claude Code" }, reviewedCurrentFix: true }));
  p.send(running(p));
  assert.equal(p.byId("review-details").hidden, true);
});

test("Cancel Review is offered only while the host offers it, and asks the host — which asks the developer", () => {
  const p = load();
  p.send(reported(REPORT));
  assert.equal(p.byId("cancel-review").hidden, true);
  p.send(running(p));
  assert.equal(p.byId("cancel-review").hidden, false);
  const before = p.posted.length;
  p.byId("cancel-review").dispatch("click");
  assert.deepEqual(p.posted.slice(before), [{ type: "action", id: "cancelReview" }]);
  // Nothing changes on the page until the host answers.
  assert.equal(p.byId("review-progress").hidden, false);
  p.send(reported(REPORT, { review: { state: "captured", agent: "Claude Code" }, reviewedCurrentFix: true }));
  assert.equal(p.byId("cancel-review").hidden, true);
});

test("cancelled: said neutrally, and Review with AI is back for the same fix", () => {
  const p = load();
  p.send(running(p));
  p.send(reported(REPORT, { review: { state: "cancelled", agent: "Claude Code" }, reviewedCurrentFix: false }));
  assert.deepEqual(reviewStatus(p), [
    "Review cancelled",
    "The review was stopped before it finished. Nothing it printed was kept, and nothing was saved.",
    "Review with AI can review this fix again.",
  ]);
  assert.equal(p.byId("review-with-ai").hidden, false);
  assert.equal(p.byId("review-error").hidden, true, "a cancellation shown as a failure");
  assert.equal(p.byId("review-editor").hidden, true);
});

test("starting: the button says so and waits; no clock, no Cancel yet", () => {
  const p = load();
  p.send(reported(REPORT, { review: { state: "starting" } }));
  assert.equal(p.byId("review-with-ai").hidden, false);
  assert.equal(p.byId("review-with-ai-label").textContent, "Starting AI review…");
  assert.equal(p.byId("review-with-ai").getAttribute("aria-disabled"), "true");
  assert.equal(p.byId("review-progress").hidden, true);
  assert.equal(p.intervals.size, 0);
});

test("a captured reply opens the form filled in, marked as from the AI review, ready to save — and leaves the keyboard alone", () => {
  const p = load();
  p.send(recordable({ review: { state: "reviewing", agent: "Claude Code", startedAt: 1_000 }, reviewedCurrentFix: true }));
  p.byId("copy-review-prompt").focus();
  const before = p.posted.length;

  p.send(recordable({ review: { state: "captured", agent: "Claude Code" }, reviewedCurrentFix: true, reviewPrefill: { token: 4, entry: CAPTURED, source: "ai" } }));

  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(p.byId("review-summary").value, CAPTURED.summary);
  assert.equal(p.byId("review-findings").value, CAPTURED.findings);
  assert.equal(p.byId("review-validation-notes").value, CAPTURED.validationNotes);
  assert.equal(p.byId("review-recommendations").value, CAPTURED.recommendations);
  assert.equal(p.byId("review-prefill-note").textContent, "Prefilled from AI review — review before saving.");
  assert.equal(p.byId("review-capture-status").textContent, "Review result ready to save.");
  assert.equal(reviewStatus(p)[0], "AI review finished");
  assert.equal(p.focused, "copy-review-prompt", "a reply that arrived on its own took the focus");
  assert.equal(p.byId("review-with-ai").hidden, true);
  assert.equal(p.posted.length, before, "the page saved or asked for something by itself");
  // Editable, and Save is still the one act.
  p.byId("review-findings").value = "One nit.";
  p.byId("save-review-result").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "recordReview", review: { ...CAPTURED, findings: "One nit." } });
});

test("a recreated panel fills its form again from the host's draft", () => {
  const state = recordable({ review: { state: "captured", agent: "Claude Code" }, reviewedCurrentFix: true, reviewPrefill: { token: 4, entry: CAPTURED, source: "ai" } });
  const first = load();
  first.send(state);
  const again = load();
  again.send(state);
  assert.equal(again.byId("review-editor").hidden, false);
  assert.equal(again.byId("review-summary").value, CAPTURED.summary);
});

test("Cancel on a captured draft discards it at the host too", () => {
  const p = load();
  p.send(recordable({ reviewedCurrentFix: true, reviewPrefill: { token: 4, entry: CAPTURED, source: "ai" } }));
  p.byId("cancel-review-result").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "discardReviewDraft" });
  assert.equal(p.byId("review-editor").hidden, true);
  // Cancel on a form typed by hand has no draft to discard.
  p.byId("record-review-result").dispatch("click");
  const before = p.posted.length;
  p.byId("cancel-review-result").dispatch("click");
  assert.equal(p.posted.slice(before).some((message) => message["type"] === "discardReviewDraft"), false);
});

test("a capture with no draft says so, keeps Review with AI hidden, and puts the reply in Paste Review Output", () => {
  const p = load();
  p.send(
    recordable({
      reviewedCurrentFix: true,
      review: {
        state: "captureFailed",
        agent: "Claude Code",
        title: "Review result could not be captured automatically.",
        detail: "Review output was not read: this section is missing: ## Findings.",
        reply: "## Summary\nA.\n",
      },
    }),
  );
  assert.equal(p.byId("review-with-ai").hidden, true);
  assert.deepEqual(reviewStatus(p), [
    "Review result could not be captured automatically.",
    "Review output was not read: this section is missing: ## Findings.",
    "The reply is in Paste Review Output: fix its sections and Parse, or add the review yourself.",
  ]);
  assert.equal(p.byId("review-error").hidden, true, "a capture with no draft is not a launch failure");
  assert.equal(p.byId("paste-review-output").hidden, false);
  assert.equal(p.byId("review-paste").hidden, false);
  assert.equal(p.byId("review-paste-text").value, "## Summary\nA.\n");
  assert.equal(p.byId("review-editor").hidden, true, "a blank draft was opened");
});

test("a fix already reviewed in an earlier session: no Review with AI, and the row says why", () => {
  const p = load();
  p.send(recordable({ reviewedCurrentFix: true }));
  assert.equal(p.byId("review-with-ai").hidden, true);
  assert.equal(reviewStatus(p)[0], "AI review already started for this fix");
  assert.equal(p.byId("paste-review-output").hidden, false);
  // A new fix on the same work item offers it again.
  p.send(recordable({ reviewedCurrentFix: false }));
  assert.equal(p.byId("review-with-ai").hidden, false);
  assert.deepEqual(reviewStatus(p), []);
});

// --- Automatic refresh keeps what is being typed (§37.81) --------------------

test("a refresh push — even one that lists a newly written report — keeps every draft on the page", () => {
  const entry = { summary: "Captured summary.", findings: "F.", validationNotes: "V.", recommendations: "R." };
  const base = {
    canRecordReview: true,
    canRecordVerification: true,
    ...STARTED,
    reviewedCurrentFix: true,
    review: { state: "captured", agent: "Claude Code" },
    reviewPrefill: { token: 7, entry, source: "ai" },
  } as const;
  const p = load();
  p.send(reported(REPORT, base));

  // A prefilled Review Result, edited and not saved.
  p.byId("review-summary").value = "Captured summary, edited.";
  // Paste Review Output, half typed.
  p.byId("paste-review-output").dispatch("click");
  p.byId("review-paste-text").value = "## Summary\nHalf";
  // A verification check being entered.
  p.byId("record-verification").dispatch("click");
  const row = p.byId("verification-rows").children[0]!;
  const name = flatten(row).find((element) => element.id.endsWith("-name"))!;
  name.value = "Targeted unit tests";
  // Start New Attempt's feedback.
  p.byId("more-actions").dispatch("click");
  p.byId("menu-startNewAttempt").dispatch("click");
  p.byId("attempt-feedback").value = "Try the caller instead.";

  // The watcher saw review_report.md appear: the host re-read and pushed.
  p.send(
    reported(REPORT, {
      ...base,
      artifacts: [...PREPARED_FILES, "fix_report.md", "review_report.md"],
      reviewReport: REVIEW_PREVIEW,
    }),
  );
  p.send(reported(REPORT, { ...base, artifacts: [...PREPARED_FILES, "fix_report.md", "review_report.md"], reviewReport: REVIEW_PREVIEW }));

  assert.equal(p.byId("review-editor").hidden, false);
  assert.equal(p.byId("review-summary").value, "Captured summary, edited.", "the edited draft was refilled");
  assert.equal(p.byId("review-paste").hidden, false);
  assert.equal(p.byId("review-paste-text").value, "## Summary\nHalf");
  assert.equal(p.byId("verification-editor").hidden, false);
  assert.equal(name.value, "Targeted unit tests");
  assert.equal(p.byId("verification-rows").children.length, 1);
  assert.equal(p.byId("attempt-editor").hidden, false);
  assert.equal(p.byId("attempt-feedback").value, "Try the caller instead.");
  // And the new report is shown.
  assert.equal(p.byId("review-result").hidden, false);
});

test("a refresh push keeps an unapplied Workflow Settings draft", () => {
  const p = load();
  p.send(reported(REPORT));
  p.byId("settings-codeSearch").dispatch("click");
  p.byId("keywords").value = "cache, loader";
  p.byId("keywords").dispatch("input");
  p.send(reported(REPORT, { artifacts: [...PREPARED_FILES, "fix_report.md", "review_report.md"], reviewReport: REVIEW_PREVIEW }));
  assert.equal(p.byId("keywords").value, "cache, loader", "a refresh overwrote the settings draft");
});

// --- Verification Evidence auto-save (§37.83) ---------------------------------

/** The form open with one row, on a report with no evidence yet. */
function openedEvidence(extra: Partial<WorkflowInput> = {}) {
  const p = load();
  p.send(verifiablePage(extra));
  openRecord(p);
  return p;
}
const saveState = (p: Page) => ({
  status: p.byId("verification-save-status").textContent,
  live: p.byId("verification-capture-status").textContent,
  alert: p.byId("verification-capture-error").hidden ? "" : p.byId("verification-capture-error").textContent,
});
const drafts = (p: Page) => p.posted.filter((message) => message["type"] === "verificationDraft");

test("auto-save: there is no Save button; the form says it saves itself, and has Done", () => {
  assert.equal(HTML.includes('id="save-verification"'), false);
  assert.equal(HTML.includes(">Save Verification Evidence<"), false);
  assert.match(HTML, /<p class="muted verification-editor-note" id="verification-autosave-note">Changes are saved automatically\.<\/p>/);
  const p = openedEvidence();
  assert.equal(p.byId("done-verification").hidden, false);
  assert.match(HTML, /id="done-verification"[^>]*>Done<\/button>/);
  // Opening the form writes nothing and asks for nothing.
  assert.equal(drafts(p).length, 0);
});

test("auto-save: every edit sends the rows as they stand — shell-looking text included — and nothing else", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  const hostile = 'npm test -- --grep "a|b" && echo $(whoami) `id` %PATH% > out.txt';
  row!.name.value = "Unit tests";
  row!.name.dispatch("input");
  row!.procedure.value = hostile;
  row!.procedure.dispatch("input");
  row!.status.value = "passed";
  row!.status.dispatch("change");
  const last = drafts(p).at(-1)!;
  assert.equal(drafts(p).length, 3, "an edit did not reach the host");
  assert.deepEqual(last, {
    type: "verificationDraft",
    checks: [{ name: "Unit tests", status: "passed", type: "automated", procedure: hostile, evidence: "", notes: "" }],
  });
  assert.deepEqual(parsePanelMessage(last), last);
  // No replace flag, no basis, no work item: the host decides.
  assert.deepEqual(Object.keys(last).sort(), ["checks", "type"]);
});

test("auto-save: removing a check sends the rows that are left", () => {
  const p = openedEvidence();
  p.byId("add-verification-check").dispatch("click");
  const rows = checkRows(p);
  rows[0]!.name.value = "Keep";
  rows[1]!.name.value = "Drop";
  rows[1]!.remove.dispatch("click");
  assert.deepEqual((drafts(p).at(-1) as { checks: { name: string }[] }).checks.map((check) => check.name), ["Keep"]);
});

test("auto-save: Unsaved changes, Saving…, Saved — the live region says only saved, and the form and focus stay", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  row!.name.value = "Unit tests";
  row!.name.dispatch("input");
  row!.name.focus();
  const at = (autosave: NonNullable<WorkflowInput["verificationAutosave"]>) => p.send(verifiablePage({ verificationAutosave: autosave }));

  at({ state: "dirty" });
  assert.deepEqual(saveState(p), { status: "Unsaved changes", live: "", alert: "" });
  at({ state: "saving" });
  assert.deepEqual(saveState(p), { status: "Saving…", live: "", alert: "" });
  // Saved: the report is listed now.
  p.send(evidenced({ verificationAutosave: { state: "saved" } }));
  assert.deepEqual(saveState(p), { status: "Saved", live: "Verification evidence saved.", alert: "" });
  assert.equal(p.byId("verification-editor").hidden, false, "a save closed the form");
  assert.equal(checkRows(p)[0]!.name.value, "Unit tests", "a save reset the rows");
  assert.equal(p.focused, row!.name.id, "a save moved the keyboard");
  // The saved report is what the form edits now.
  assert.equal(p.byId("edit-verification").hidden, false);
  assert.equal(p.byId("edit-verification").getAttribute("aria-expanded"), "true");
});

test("auto-save: an incomplete form is said, not saved, and keeps every row", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  row!.evidence.value = "It passed";
  row!.evidence.dispatch("input");
  p.send(verifiablePage({ verificationAutosave: { state: "incomplete", message: "Not saved yet: check 1 needs a name." } }));
  assert.equal(saveState(p).status, "Not saved yet: check 1 needs a name.");
  assert.equal(saveState(p).alert, "", "an incomplete form was shown as a failure");
  assert.equal(checkRows(p)[0]!.evidence.value, "It passed");
});

test("auto-save: a failed save says so, keeps the rows, and Retry Save asks again; a later save clears it", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  row!.name.value = "Unit tests";
  row!.name.dispatch("input");
  p.send(verifiablePage({ verificationAutosave: { state: "error", message: "Verification evidence was not recorded: disk full." } }));
  assert.deepEqual(saveState(p), {
    status: "Could not save verification evidence",
    live: "Verification evidence could not be saved.",
    alert: "Verification evidence was not recorded: disk full.",
  });
  assert.equal(p.byId("retry-verification-save").hidden, false);
  assert.equal(checkRows(p)[0]!.name.value, "Unit tests");
  assert.equal(p.byId("verification-save-status").textContent.includes("Saved"), false, "a false Saved");
  p.byId("retry-verification-save").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "flushVerification" });
  p.send(evidenced({ verificationAutosave: { state: "saved" } }));
  assert.deepEqual(saveState(p), { status: "Saved", live: "Verification evidence saved.", alert: "" });
  assert.equal(p.byId("retry-verification-save").hidden, true);
});

test("auto-save: a conflict stops and asks — Reload Saved Version or Overwrite Saved Version — with the rows kept", () => {
  const p = load();
  p.send(evidenced());
  p.byId("edit-verification").dispatch("click");
  p.send(evidenced({ verificationEdit: { token: 3, checks: [{ name: "Unit tests", status: "passed", type: "automated", procedure: "", evidence: "", notes: "" }], structured: true, unreadable: false } }));
  checkRows(p)[0]!.notes.value = "mine";
  checkRows(p)[0]!.notes.dispatch("input");
  p.send(evidenced({ verificationAutosave: { state: "conflict", message: "verification_report.md changed outside this form, so your changes were not saved over it." } }));
  assert.equal(saveState(p).status, "Not saved: the report changed outside this form");
  assert.match(saveState(p).alert, /changed outside this form/);
  assert.equal(p.byId("retry-verification-save").hidden, true);
  assert.equal(checkRows(p)[0]!.notes.value, "mine");
  p.byId("reload-verification").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "editVerification" });
  p.byId("overwrite-verification").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "overwriteVerification" });
});

test("auto-save: Done saves what is waiting and closes once saved; after a failure it stays open", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  row!.name.value = "Unit tests";
  row!.name.dispatch("input");
  const dirty: Partial<WorkflowInput> = { verificationAutosave: { state: "dirty" } };
  p.send(verifiablePage(dirty));
  p.byId("done-verification").focus();
  p.byId("done-verification").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "flushVerification" });
  assert.equal(p.byId("verification-editor").hidden, false, "Done closed before the save");
  p.send(evidenced({ verificationAutosave: { state: "saved" } }));
  assert.equal(p.byId("verification-editor").hidden, true);
  assert.equal(p.focused, "edit-verification", "the keyboard was not given back to the form's button");

  // A save that fails keeps the form open.
  const q = openedEvidence();
  checkRows(q)[0]!.name.value = "Unit tests";
  checkRows(q)[0]!.name.dispatch("input");
  q.send(verifiablePage(dirty));
  q.byId("done-verification").dispatch("click");
  q.send(verifiablePage({ verificationAutosave: { state: "error", message: "x" } }));
  assert.equal(q.byId("verification-editor").hidden, false);

  // Nothing typed: Done closes, and the host drops the empty draft.
  const r = openedEvidence();
  r.byId("done-verification").dispatch("click");
  assert.equal(r.byId("verification-editor").hidden, true);
  assert.deepEqual(r.posted.at(-1), { type: "discardVerificationDraft" });
});

test("auto-save: Ctrl+Enter in the form saves now, never Runs; plain Enter in a name is held", () => {
  const p = openedEvidence();
  const [row] = checkRows(p);
  row!.name.value = "Unit tests";
  const before = p.posted.length;
  p.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true, target: row!.name });
  p.byId("verification-editor").dispatch("keydown", { key: "Enter", ctrlKey: true, target: row!.name });
  const sent = p.posted.slice(before);
  assert.equal(sent.some((message) => isRunPress(message)), false);
  assert.deepEqual(sent.at(-1), { type: "flushVerification" });
});

test("auto-save: Edit fills the form from the host's answer, and the next edit is a draft of that report", () => {
  const p = load();
  p.send(evidenced());
  p.byId("edit-verification").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "editVerification" });
  const checks = [{ name: "Unit tests", status: "passed", type: "automated", procedure: "npm test", evidence: "12 passed", notes: "" }] as const;
  p.send(evidenced({ verificationEdit: { token: 5, checks, structured: true, unreadable: false } }));
  assert.equal(checkRows(p)[0]!.name.value, "Unit tests");
  assert.equal(drafts(p).length, 0, "loading the report sent it back as a change");
  checkRows(p)[0]!.evidence.value = "13 passed";
  checkRows(p)[0]!.evidence.dispatch("input");
  assert.deepEqual((drafts(p).at(-1) as { checks: object[] }).checks, [{ ...checks[0], evidence: "13 passed" }]);
});

test("auto-save: a Record form that met a report written meanwhile keeps its checks when Edit loads the report", () => {
  const p = openedEvidence();
  checkRows(p)[0]!.name.value = "Typed here";
  checkRows(p)[0]!.name.dispatch("input");
  p.send(evidenced());
  p.byId("edit-verification").dispatch("click");
  p.send(evidenced({ verificationEdit: { token: 9, checks: [{ name: "Recorded there", status: "failed", type: "manual", procedure: "", evidence: "", notes: "" }], structured: true, unreadable: false } }));
  assert.deepEqual(checkRows(p).map((row) => row.name.value), ["Recorded there", "Typed here"]);
  // Both are the draft now, so neither is lost.
  assert.deepEqual((drafts(p).at(-1) as { checks: { name: string }[] }).checks.map((check) => check.name), ["Recorded there", "Typed here"]);
});

test("auto-save: another work item closes the form; its host flushed or asked first", () => {
  const p = openedEvidence();
  checkRows(p)[0]!.name.value = "For JR-12345";
  p.send(verifiablePage({ workItemId: "JR-77777" }, { workItemId: "JR-77777" }));
  assert.equal(p.byId("verification-editor").hidden, true);
  assert.equal(p.byId("verification-rows").children.length, 0);
});

// --- Repository Files' quick fix (§37.85) -----------------------------------

const REPOSITORY_FILES = {
  title: "Repository Files",
  message:
    "This repository does not ignore .ai/ and .ai_memory/. Add both to .gitignore, or generated artifacts — including fetched Jira content — may appear in your commits.",
};
const GITIGNORE_ACTION = {
  id: "addArtifactsToGitignore" as const,
  label: "Add to .gitignore",
  accessibleName: "Add .ai and .ai_memory to .gitignore",
};

/** Every element under this one, depth first. */
function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}
const noticeButton = (page: Page) =>
  descendants(page.byId("notices")).find((element) => element.getAttribute("data-notice-action") === "addArtifactsToGitignore");

test("the Repository Files card draws its quick fix as a button, with its accessible name", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }] }));
  assert.equal(page.byId("notices").hidden, false);
  const button = noticeButton(page);
  assert.ok(button, "no Add to .gitignore button");
  assert.equal(button.textContent, "Add to .gitignore");
  assert.equal(button.getAttribute("aria-label"), "Add .ai and .ai_memory to .gitignore");
  assert.equal(button.type, "button", "a submit button would run the form");
  // The default (secondary) button style, not the primary one.
  assert.equal(button.classes.has("primary"), false);
  assert.ok(button.classes.has("notice-action"));
  // The warning's own text is on the card as before.
  const texts = descendants(page.byId("notices")).map((element) => element.textContent);
  assert.ok(texts.includes(REPOSITORY_FILES.message));
});

test("no quick fix offered, no button — and a card without one is drawn as before", () => {
  const page = load();
  page.send(state({ warnings: [REPOSITORY_FILES] }));
  assert.equal(noticeButton(page), undefined);
  page.send(state({ warnings: [] }));
  assert.equal(page.byId("notices").hidden, true);
});

test("pressing it sends the intent, and nothing about which file or which rules", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }] }));
  const before = page.posted.length;
  noticeButton(page)!.dispatch("click");
  assert.deepEqual(page.posted.slice(before), [{ type: "action", id: "addArtifactsToGitignore" }]);
});

test("busy, the button stays focusable and does nothing; the focus survives the redraw", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }] }));
  noticeButton(page)!.focus();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: { ...GITIGNORE_ACTION, label: "Adding to .gitignore…", busy: true } }] }));
  const busy = noticeButton(page)!;
  assert.equal(busy.getAttribute("aria-disabled"), "true");
  assert.equal(busy.disabled, false, "a disabled button would drop the focus");
  assert.equal(page.focused, busy.id, "the focus was dropped by the redraw");
  const before = page.posted.length;
  busy.dispatch("click");
  assert.equal(page.posted.length, before);
});

test("a render that changes nothing keeps the card's DOM, so a focused button stays focused", () => {
  const page = load();
  const warnings = [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }];
  page.send(state({ warnings }));
  const button = noticeButton(page)!;
  button.focus();
  page.send(state({ warnings, revision: 5 }));
  assert.equal(noticeButton(page), button);
  assert.equal(page.focused, button.id);
});

test("the fix worked: the card goes, the line that says so appears, and the focus lands on it — not on a card that is gone", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }] }));
  noticeButton(page)!.focus();
  page.send(state({ warnings: [], noticeStatus: "Added .ai/ and .ai_memory/ to .gitignore. Git now ignores .ai/ and .ai_memory/." }));
  assert.equal(page.byId("notices").hidden, true);
  assert.equal(page.byId("notice-status").hidden, false);
  assert.match(page.byId("notice-status").textContent, /Git now ignores/);
  assert.equal(page.focused, "notice-status");
  // Next check of the environment: the line goes.
  page.send(state({ warnings: [] }));
  assert.equal(page.byId("notice-status").hidden, true);
});

test("the focus is only moved for someone who was on the button", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION }] }));
  page.byId("issue").focus();
  page.send(state({ warnings: [], noticeStatus: "Git now ignores .ai/ and .ai_memory/." }));
  assert.equal(page.focused, "issue");
});

test("what the last press came to is on the card, under the warning", () => {
  const page = load();
  page.send(state({ warnings: [{ ...REPOSITORY_FILES, action: GITIGNORE_ACTION, status: "Could not update .gitignore. The BugPilot output has the details." }] }));
  const status = descendants(page.byId("notices")).find((element) => element.classes.has("notice-status"));
  assert.equal(status?.textContent, "Could not update .gitignore. The BugPilot output has the details.");
  // A retry is still offered.
  assert.ok(noticeButton(page));
});

// --- Investigation & AI Fix: one status per row (§37.86) --------------------

/** Every text a row shows, visible or not, as the page left it. */
function rowTexts(p: Page, id: string): { text: string; hidden: boolean }[] {
  const ids = [`status-text-${id}`, `description-${id}`, `detail-${id}`, `note-${id}`, `settings-summary-${id}`, `artifact-${id}-name`];
  return ids
    .filter((slot) => p.elements.has(slot))
    .map((slot) => {
      const element = p.byId(slot);
      // A slot inside a hidden container is hidden too.
      const container =
        slot.startsWith("status-text-") ? p.byId(`status-${id}`) : slot.startsWith("artifact-") ? p.byId(`artifact-${id}`) : element;
      return { text: element.textContent, hidden: element.hidden || container.hidden };
    });
}
const shownTimes = (p: Page, id: string, words: string) =>
  rowTexts(p, id).filter((entry) => !entry.hidden && entry.text === words).length;

/** A finished run with Code search unticked: skipped, as the CLI reports it. */
const skippedSearch = () => {
  const progress: ProgressView = {
    state: "done",
    rows: CAPABILITY_IDS.map((capability) => row(capability, capability === "code_search" ? "skipped" : "done", 60)),
    artifacts: PREPARED_FILES,
  };
  const plan = { ...DEFAULT_FORM.plan, codeSearch: false };
  return state({
    progress,
    form: { ...DEFAULT_FORM, plan },
    revision: 2,
    workflow: buildWorkflow({
      source: "manual",
      plan,
      fixWithAI: false,
      progress,
      artifacts: PREPARED_FILES,
      workItemId: "local_1",
      issue: { id: "local_1", source: "manual", title: "" },
    }),
  });
};

test("a completed workflow: each row says Completed or Context ready once, and no row wears a tick", () => {
  const p = load();
  p.send(prepared());
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes"]) {
    assert.equal(shownTimes(p, id, "Completed"), 1, `${id}: Completed not exactly once`);
  }
  assert.equal(shownTimes(p, "buildContext", "Context ready"), 1);
  assert.equal(shownTimes(p, "buildContext", "Completed"), 0);
  // No status glyph that is a check mark, anywhere in the workflow's rows.
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"]) {
    const mark = p.byId(`mark-${id}`);
    assert.equal([...mark.classes].some((name) => /pass|check/.test(name)), false, `${id}: ${mark.className}`);
    // The checkbox is still the row's one check-mark control, untouched.
    const box = p.byId(`plan-${id}`);
    assert.equal(box.classes.size, 0, `${id}: the checkbox was restyled`);
  }
});

test("a skipped Code search: unticked, Skipped once, a muted dot, no prohibition icon, no second line", () => {
  const p = load();
  p.send(skippedSearch());
  assert.equal(p.byId("plan-codeSearch").checked, false);
  assert.ok(p.byId("step-codeSearch").classes.has("step-skipped"));
  assert.equal(statusOf(p, "codeSearch"), "Skipped");
  assert.equal(shownTimes(p, "codeSearch", "Skipped"), 1);
  assert.equal(p.byId("foot-codeSearch").hidden, true, "a second line under Skipped");
  const mark = p.byId("mark-codeSearch");
  assert.ok(mark.classes.has("step-dot"));
  assert.equal([...mark.classes].some((name) => name.startsWith("codicon")), false, "a glyph beside Skipped");
  // Still a checkbox a developer can tick for the next run.
  p.byId("plan-codeSearch").checked = true;
  p.byId("form").dispatch("change", { target: p.byId("plan-codeSearch") });
  p.flush();
  const change = p.posted.filter((message) => message["type"] === "formChanged").at(-1);
  assert.equal((change?.["form"] as { plan: { codeSearch: boolean } }).plan.codeSearch, true);
});

test("Issue details keeps what it adds: the source line and issue.json, under one Completed", () => {
  const p = load();
  p.send(skippedSearch());
  assert.equal(statusOf(p, "issueDetails"), "Completed");
  assert.equal(p.byId("description-issueDetails").textContent, "Manual bug description");
  assert.equal(p.byId("description-issueDetails").hidden, false);
  assert.equal(p.byId("artifact-issueDetails").hidden, false);
  assert.equal(p.byId("artifact-issueDetails-name").textContent, "issue.json");
  assert.equal(shownTimes(p, "issueDetails", "Completed"), 1);
  // The file opens through the constrained message, as before.
  p.byId("artifact-issueDetails").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "openArtifact", name: "issue.json" });
});

test("Build context: Context ready once, context.md under it, and Open Context and Copy still work", () => {
  const p = load();
  p.send(prepared());
  assert.equal(shownTimes(p, "buildContext", "Context ready"), 1);
  assert.equal(p.byId("artifact-buildContext-name").textContent, "context.md");
  assert.equal(p.byId("artifact-buildContext").hidden, false);
  p.byId("open-context").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "openContext" });
  p.byId("copy-context").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "copyContext" });
});

test("a running step has one indicator: the spinner and Running, never a dot as well", () => {
  const p = load();
  p.send(state({ progress: { state: "running", rows: [row("issue_details", "done", 40), row("code_search", "running")], artifacts: [] } }));
  assert.equal(statusOf(p, "codeSearch"), "Running");
  const mark = p.byId("mark-codeSearch");
  assert.ok(mark.classes.has("codicon-loading") && mark.classes.has("codicon-spin"));
  assert.equal(mark.classes.has("step-dot"), false);
  // What it is doing is the second line; Running is not repeated there.
  assert.equal(p.byId("description-codeSearch").textContent, "Searching repository…");
  assert.equal(shownTimes(p, "codeSearch", "Running"), 1);
  // A pending row states no status at all, and keeps its description.
  assert.equal(statusOf(p, "gitHistory"), null);
  assert.equal(p.byId("description-gitHistory").hidden, false);
});

test("a failed step: Failed once, then the reason — the card still under it", () => {
  const p = load();
  p.send(prepared(AGENT_FAILED));
  assert.equal(statusOf(p, "fixWithAI"), "Failed");
  assert.equal(shownTimes(p, "fixWithAI", "Failed"), 1);
  assert.equal(p.byId("description-fixWithAI").textContent, "Did not start");
  assert.equal(p.byId("error-fixWithAI").hidden, false);
  assert.ok(p.byId("mark-fixWithAI").classes.has("step-dot"));
});

test("the status words reach a screen reader; the mark does not", () => {
  const p = load();
  p.send(prepared());
  // The words are ordinary text on the row, and the row's name carries them too.
  assert.equal(p.byId("status-text-gitHistory").getAttribute("aria-hidden"), undefined);
  assert.equal(p.byId("step-gitHistory").getAttribute("aria-label"), "Git history: Completed");
  assert.equal(p.byId("step-buildContext").getAttribute("aria-label"), "Build context: Context ready");
  // A pending row, and one nobody chose, say which.
  p.send(state({ workflow: [step({ id: "gitHistory", label: "Git history", enabled: false })] }));
  assert.equal(p.byId("step-gitHistory").getAttribute("aria-label"), "Git history: not selected");
  p.send(state({ workflow: [step({ id: "gitHistory", label: "Git history", enabled: true })] }));
  assert.equal(p.byId("step-gitHistory").getAttribute("aria-label"), "Git history: not started");
});

// --- Open AI Session acknowledgement (§37.87) --------------------------------

const sessionOpened = (feedback?: PanelState["sessionFeedback"]) =>
  prepared({ fix: { status: "success", detail: "Handed to Claude Code in a terminal." } }, feedback === undefined ? {} : { sessionFeedback: feedback });

test("Open AI Session's answer appears under the button, in the host's words, and the focus stays put", () => {
  const p = load();
  p.send(sessionOpened());
  assert.equal(p.byId("run-label").textContent, "Open AI Session");
  assert.equal(p.byId("session-feedback").textContent, "");
  p.byId("run").focus();

  p.send(sessionOpened({ kind: "focused", message: "AI session focused", seq: 1 }));
  assert.equal(p.byId("session-feedback").textContent, "AI session focused");
  assert.ok(p.byId("session-feedback").classes.has("is-focused"));
  assert.equal(p.focused, "run", "the acknowledgement moved the keyboard focus");
  assert.equal(p.byId("run").disabled, false);

  // Gone when the host drops it.
  p.send(sessionOpened());
  assert.equal(p.byId("session-feedback").textContent, "");
});

test("a redraw with the same answer changes nothing, so it is not announced again", () => {
  const p = load();
  p.send(sessionOpened({ kind: "focused", message: "AI session focused", seq: 4 }));
  // Something else on the page changes the element's text, to see whether a
  // redraw writes it again: it must not.
  p.byId("session-feedback").textContent = "untouched";
  p.send(sessionOpened({ kind: "focused", message: "AI session focused", seq: 4 }));
  assert.equal(p.byId("session-feedback").textContent, "untouched");
  // A new press is written.
  p.send(sessionOpened({ kind: "unavailable", message: "AI session is no longer available in this window. To continue, use ⋯ → Start New Attempt.", seq: 5 }));
  assert.match(p.byId("session-feedback").textContent, /^AI session is no longer available/);
  assert.ok(p.byId("session-feedback").classes.has("is-unavailable"));
});

test("the page sends only the intent: which terminal, and whether it is there, are the host's", () => {
  const p = load();
  p.send(sessionOpened());
  const before = p.posted.length;
  p.byId("form").dispatch("submit");
  const sent = p.posted.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!["type"], "nextAction");
  assert.equal(sent[0]!["action"], "openSession");
  // No feedback until the host answers.
  assert.equal(p.byId("session-feedback").textContent, "");
});

// --- Fix result: Show more / Show less (§37.89) ------------------------------

const LONG_SUMMARY =
  "No-op: no code change was applied. The task carries no usable bug information — the issue text is a placeholder, so there was nothing to reproduce, and changing code on a guess would do more harm than leaving it.";

/** Lay the summary out as a narrow or a wide panel would: how tall it wants to be, against the clamp's three lines. */
const layOut = (p: Page, lines: number, detailLines = 1) => {
  const line = 16;
  p.byId("description-fixResult").scrollHeight = lines * line;
  p.byId("description-fixResult").clientHeight = Math.min(lines, 3) * line;
  p.byId("detail-fixResult").scrollHeight = detailLines * line;
  p.byId("detail-fixResult").clientHeight = Math.min(detailLines, 2) * line;
};
const toggleOf = (p: Page) => p.byId("fix-summary-toggle");
const clamped = (p: Page) => p.byId("description-fixResult").classes.has("is-clamped");

test("a short Fix result is shown whole, with no Show more", () => {
  const p = load();
  layOut(p, 1);
  p.send(reported({ readable: true, summary: "Fixed it.", tests: "3 passed." }));
  assert.equal(p.byId("description-fixResult").textContent, "Fixed it.");
  assert.equal(toggleOf(p).hidden, true);
});

test("a long Fix result is collapsed to three lines with Show more — the whole text still in the element", () => {
  const p = load();
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY, tests: "Not run." }));
  assert.ok(clamped(p));
  assert.equal(toggleOf(p).hidden, false, "text cut short with no way to read the rest");
  assert.equal(toggleOf(p).textContent, "Show more");
  assert.equal(toggleOf(p).getAttribute("aria-label"), "Show full Fix result");
  assert.equal(toggleOf(p).getAttribute("aria-expanded"), "false");
  // A screen reader reads the element's text, which is all of it; the clamp is visual.
  assert.equal(p.byId("description-fixResult").textContent, LONG_SUMMARY);
  assert.equal(p.byId("description-fixResult").getAttribute("title"), LONG_SUMMARY);
});

test("Show more expands it, Show less collapses it again — with the keyboard's Enter as with a click", () => {
  const p = load();
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  const before = p.posted.length;
  toggleOf(p).focus();
  toggleOf(p).dispatch("click"); // a button's Enter and Space are its click
  assert.equal(clamped(p), false);
  assert.equal(p.byId("detail-fixResult").classes.has("is-clamped"), false);
  assert.equal(toggleOf(p).hidden, false);
  assert.equal(toggleOf(p).textContent, "Show less");
  assert.equal(toggleOf(p).getAttribute("aria-label"), "Collapse Fix result");
  assert.equal(toggleOf(p).getAttribute("aria-expanded"), "true");
  assert.equal(p.focused, "fix-summary-toggle", "the focus left the control it pressed");

  toggleOf(p).dispatch("click");
  assert.ok(clamped(p));
  assert.equal(toggleOf(p).textContent, "Show more");
  assert.ok(toggleOf(p).scrolledIntoView, "collapsing left the button out of view");
  // Nothing reached the host, and no file was opened.
  assert.equal(p.posted.length, before);
});

test("the Tests line counts too: cut short, it brings Show more even under a short summary", () => {
  const p = load();
  layOut(p, 1, 4);
  p.send(reported({ readable: true, summary: "Fixed it.", tests: "pytest: 2 failed, 18 passed — a very long list of failures follows here" }));
  assert.equal(toggleOf(p).hidden, false);
});

test("an unrelated update keeps it expanded; a new result collapses it", () => {
  const p = load();
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  toggleOf(p).dispatch("click");
  // A push about something else — a review being prepared, a redraw.
  p.send(reported({ readable: true, summary: LONG_SUMMARY }, { copyingReviewPrompt: true }));
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  assert.equal(clamped(p), false, "an unrelated update collapsed the result");
  assert.equal(toggleOf(p).textContent, "Show less");
  // The agent wrote a new report: a new result, shown collapsed.
  p.send(reported({ readable: true, summary: `${LONG_SUMMARY} Second attempt.` }));
  assert.ok(clamped(p));
  assert.equal(toggleOf(p).textContent, "Show more");
});

test("the width decides: Show more appears when the text no longer fits, and an expanded result stays expanded", () => {
  const p = load();
  layOut(p, 3);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  assert.equal(toggleOf(p).hidden, true, "wide enough: nothing is cut");
  layOut(p, 7);
  p.resize();
  assert.equal(toggleOf(p).hidden, false, "narrower: cut short with no Show more");
  toggleOf(p).dispatch("click");
  layOut(p, 2);
  p.resize();
  assert.equal(clamped(p), false, "a width change collapsed it");
  assert.equal(toggleOf(p).textContent, "Show less");
});

test("no report, no toggle — and another work item starts collapsed", () => {
  const p = load();
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  toggleOf(p).dispatch("click");
  p.send(prepared());
  assert.equal(toggleOf(p).hidden, true);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }, {}, { workItemId: "JR-2" }));
  assert.ok(clamped(p));
});

test("the expansion is the page's alone: never sent, never saved", () => {
  const p = load();
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  const stored = p.stored.length;
  const posted = p.posted.length;
  toggleOf(p).dispatch("click");
  toggleOf(p).dispatch("click");
  assert.equal(p.posted.length, posted);
  assert.equal(JSON.stringify(p.stored.slice(stored)).includes("fixSummary"), false);
});

// --- Tooltip audit (§37.90) --------------------------------------------------

test("the primary button's tooltip follows its action: only where the label hides what it means", () => {
  const p = load();
  p.send(prepared());
  assert.equal(p.byId("run-label").textContent, "Fix with AI");
  assert.equal(p.byId("run").getAttribute("title"), undefined, "Fix with AI already says it");
  p.send(prepared({ fix: { status: "success", detail: "Handed to Claude Code in a terminal." } }));
  assert.equal(p.byId("run-label").textContent, "Open AI Session");
  assert.equal(p.byId("run").getAttribute("title"), "Focus the existing BugPilot AI terminal");
  p.send(state());
  assert.equal(p.byId("run-label").textContent, "Run");
  assert.equal(p.byId("run").getAttribute("title"), undefined, "a stale tooltip outlived its action");
});

test("the compact controls the page builds get specific tooltips that match their names", () => {
  const p = load();
  // The attachment's remove icon names the file, as its accessible name does.
  p.send(state({ form: { ...DEFAULT_FORM, attachments: ["C:/work/logs/crash.log"] }, revision: 2 }));
  const remove = descendants(p.byId("attachment-list")).find((element) => element.classes.has("icon"));
  assert.ok(remove, "no remove icon for the attachment");
  assert.equal(remove.getAttribute("title"), "Remove crash.log");
  assert.equal(remove.getAttribute("aria-label"), "Remove crash.log");

  // Show more / Show less: the tooltip is the accessible name.
  layOut(p, 6);
  p.send(reported({ readable: true, summary: LONG_SUMMARY }));
  assert.equal(toggleOf(p).getAttribute("title"), "Show full Fix result");
  toggleOf(p).dispatch("click");
  assert.equal(toggleOf(p).getAttribute("title"), "Collapse Fix result");
});

test("a settings summary, which is cut with an ellipsis, is whole on hover", () => {
  const p = load();
  p.send(prepared({ settingsSummaries: { codeSearch: "4 keywords · 2 focus paths · max 10 files" } }));
  assert.equal(p.byId("settings-summary-codeSearch").getAttribute("title"), "4 keywords · 2 focus paths · max 10 files");
});
