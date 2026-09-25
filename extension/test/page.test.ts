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
import type { FixModeDraft } from "../src/app/fixModes.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { buildWorkflow, overallStatus } from "../src/app/workflow.ts";
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
  disabled = false;
  type = "";
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
    canRetry: false,
    fixModes: { kind: "loading" },
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
const step = (overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
  id: "codeSearch",
  label: "Code search",
  description: "Search relevant code in the repository",
  enabled: true,
  status: "idle",
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
  return state({ progress, workflow, workItemId: "JR-12345", workItemActions: ["openFolder"], ...overrides });
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
  p.byId("issue").value = "jr-1";
  p.byId("keywords").value = "save, crash";
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { type: string; form: Record<string, unknown> };
  assert.equal(message.type, "run");
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

test("Build context's actions appear only once its file exists", () => {
  const p = load();
  p.send(state());
  for (const id of ["open-context", "copy-context", "open-folder"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }

  // The step finished but wrote no context: nothing to open, so nothing
  // offered — a disabled icon invites a click that explains nothing.
  p.send(prepared({ artifacts: ["issue.json", "run.json"] }, { workItemActions: ["openFolder"] }));
  assert.equal(p.byId("description-buildContext").textContent, "Completed");
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

test("opening Advanced settings sizes the text already restored into it", () => {
  // The path a hidden webview takes: state is restored into fields that cannot
  // be measured, and the toggle is the first moment they can be.
  const p = load({ form: { ...DEFAULT_FORM, hint: "a paragraph that wrapped" } });
  assert.equal(p.byId("hint").style["height"], "auto", "nothing was measurable yet");

  sized(p, "hint", 48, 210);
  p.byId("advanced").dispatch("toggle");
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
  p.byId("issue").value = "JR-9";
  p.byId("add-attachment").dispatch("click");

  const sent = p.posted.at(-1) as { type: string; form: { issueKey: string } };
  assert.equal(sent.type, "addAttachments");
  // Carrying the form, so the host merges onto what is on screen rather than
  // onto its own copy from up to a debounce ago.
  assert.equal(sent.form.issueKey, "JR-9");
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

test("the run message carries the selected Fix Mode", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  page.byId("fixModeId").value = "investigate-first";
  page.byId("form").dispatch("submit");

  const run = page.posted.find((message) => message["type"] === "run");
  assert.equal((run?.["form"] as { fixModeId?: string } | undefined)?.fixModeId, "investigate-first");
});

// --- Batch 7: the selector lives in Advanced settings → Strategy ------------

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
  page.posted.filter((message) => message["type"] === "run").at(-1)?.["form"] as
    | { fixModeId?: string }
    | undefined;

test("Advanced settings starts closed, and the selector inside it is already filled in", () => {
  // Placement is visual. A closed section still holds the real selection and
  // its description, so opening it shows what Run will use.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));

  assert.equal(page.byId("advanced").open, false);
  assert.equal(page.byId("fixModeId").value, "investigate-first");
  assert.match(page.byId("fixModeId-description").textContent, /Investigation only/);
});

test("with nothing chosen, the closed selector holds the default the CLI declared, and Run sends it", () => {
  const page = load();
  page.send(state({ fixModes: MODES }));

  assert.equal(page.byId("advanced").open, false);
  assert.equal(page.byId("fixModeId").value, "standard");
  page.byId("form").dispatch("submit");
  assert.equal(lastRun(page)?.fixModeId, "standard");
});

test("a mode chosen and then folded away is still the one Run sends", () => {
  // The regression Batch 7 must not introduce: a section being closed says
  // nothing about the setting inside it.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  page.byId("advanced").open = true;
  page.byId("fixModeId").value = "investigate-first";
  page.byId("form").dispatch("change", { target: page.byId("fixModeId") });
  page.byId("advanced").open = false;
  page.byId("advanced").dispatch("toggle");

  // Pushes keep arriving while it is closed — every stream event is one — and
  // none of them may reset the choice: not a plain push, and not one that
  // carries the host's older copy of the form under the same revision.
  page.send(state({ fixModes: MODES }));
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.equal(page.byId("fixModeId").value, "investigate-first", "a same-revision push reset the choice");
  page.byId("form").dispatch("submit");

  assert.equal(lastRun(page)?.fixModeId, "investigate-first");
  // And it is what the page persisted, so a reloaded panel starts from it.
  const stored = page.stored.at(-1) as { form?: { fixModeId?: string } } | undefined;
  assert.equal(stored?.form?.fixModeId, "investigate-first");
});

test("Ctrl+Enter from the Issue field uses the folded-away mode too", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  page.byId("issue").value = "JR-12345";
  page.byId("form").dispatch("keydown", { key: "Enter", ctrlKey: true });

  assert.equal(page.byId("advanced").open, false);
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

test("a problem with the chosen mode opens Advanced settings once, to show it", () => {
  // The rule every field in the section already follows: a message in a
  // closed section is a message nobody sees.
  const problem = { field: "fixModeId" as const, message: '"bad id" is not a Fix Mode id. Pick one from the list.' };
  const withProblem = () =>
    state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" }, problems: [problem] });
  const page = load();
  page.send(withProblem());

  assert.equal(page.byId("advanced").open, true);
  // And lands on the selector, which also brings it into view.
  assert.equal(page.focused, "fixModeId");
  assert.equal(page.byId("fixModeId-description").textContent, problem.message);
  assert.ok(page.byId("field-fixModeId").classes.has("field-invalid"));
  assert.equal(page.byId("fixModeId").getAttribute("aria-invalid"), "true");

  // Once: closing it again is not overruled by the same problem pushed again,
  // and focus is not pulled back to the selector either.
  page.byId("advanced").open = false;
  page.byId("hint").focus();
  page.send(withProblem());
  assert.equal(page.byId("advanced").open, false);
  assert.equal(page.focused, "hint");
});

test("an unavailable catalog is explained inside the section, and does not force it open", () => {
  // Not a problem with anything the developer chose — Run still works on the
  // CLI's default — so it is said where Fix Mode lives, not pushed in their face.
  const page = load();
  page.send(state({ fixModes: { kind: "unavailable", detail: "AI Fix Modes could not be read." } }));

  assert.equal(page.byId("advanced").open, false);
  assert.equal(page.byId("fixModeId-description").textContent, "AI Fix Modes could not be read.");
  assert.equal(page.byId("run").disabled, false);
});

test("coming back from Manage Fix Modes lands on the gear, with its section open", () => {
  // The gear is inside Advanced settings. A reloaded panel can restore the
  // manager with the section closed, and focus cannot land inside a closed
  // disclosure — so the way back opens it.
  const page = load();
  page.send(state({ fixModes: MODES, manage: { catalog: MANAGED_READY } }));
  assert.equal(page.byId("advanced").open, false);

  page.send(state({ fixModes: MODES }));

  assert.equal(page.byId("advanced").open, true);
  assert.equal(page.focused, "manage-fix-modes");
});

test("opening the panel on the form does not open Advanced settings", () => {
  // Only the way back from Fix Mode management does; a panel that loads, or a
  // run that starts, leaves the section as it was.
  const page = load();
  page.send(state({ fixModes: MODES }));
  page.send(state({ fixModes: MODES, progress: { state: "running", rows: [], artifacts: [] } }));
  page.send(prepared({}, { fixModes: MODES }));

  assert.equal(page.byId("advanced").open, false);
});

/** What the collapsed Advanced settings summary says about the Fix Mode. */
const strategyLabel = (page: Page) => ({
  shown: !page.byId("advanced-strategy").hidden,
  name: page.byId("advanced-strategy-name").textContent,
  description: page.byId("advanced-strategy-description").textContent,
});

const NO_LABEL = { shown: false, name: "", description: "" };

test("Standard Fix adds nothing to the collapsed summary", () => {
  // The ordinary case stays exactly as quiet as it was: no label, no text.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.deepEqual(strategyLabel(page), NO_LABEL);

  // Nor does the default reached with nothing chosen.
  const fresh = load();
  fresh.send(state({ fixModes: MODES }));
  assert.deepEqual(strategyLabel(fresh), NO_LABEL);
});

test("a non-default built-in mode is named in the collapsed summary", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));

  assert.deepEqual(strategyLabel(page), {
    shown: true,
    name: "Investigate First",
    description: "Fix Mode: Investigate First",
  });
  // The full name on hover, for when a narrow sidebar cuts it short.
  assert.equal(page.byId("advanced-strategy").getAttribute("title"), "Fix Mode: Investigate First");
  // Said, not opened: the section stays as the developer left it.
  assert.equal(page.byId("advanced").open, false);
});

test("a custom mode is named by its display name", () => {
  const page = load();
  page.send(state({ fixModes: WITH_CUSTOM, form: { ...DEFAULT_FORM, fixModeId: "team-safe" } }));

  assert.equal(strategyLabel(page).name, "Team Safe Fix");
  assert.equal(strategyLabel(page).shown, true);
});

test("the label follows the selector the moment the developer changes it", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));

  page.byId("fixModeId").value = "investigate-first";
  page.byId("form").dispatch("change", { target: page.byId("fixModeId") });
  assert.equal(strategyLabel(page).name, "Investigate First");

  // And back to the default: the label goes, rather than lingering.
  page.byId("fixModeId").value = "standard";
  page.byId("form").dispatch("change", { target: page.byId("fixModeId") });
  assert.deepEqual(strategyLabel(page), NO_LABEL);
});

test("a reopened work item's restored mode is named before Run", () => {
  // The case the label exists for: the host restores the mode a work item was
  // prepared with — a new form revision, no click — while the section is closed.
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.deepEqual(strategyLabel(page), NO_LABEL);

  page.send(state({ revision: 2, fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  assert.equal(strategyLabel(page).name, "Investigate First");
  assert.equal(page.byId("advanced").open, false);
});

test("switching to a new work item that resets to the default clears a stale label", () => {
  const page = load();
  page.send(state({ fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
  assert.equal(strategyLabel(page).shown, true);

  page.send(state({ revision: 2, fixModes: MODES, form: { ...DEFAULT_FORM, fixModeId: "standard" } }));
  assert.deepEqual(strategyLabel(page), NO_LABEL);
});

test("a deleted custom mode falls back to the default, and takes its label with it", () => {
  // The page's own fallback when the catalog stops offering the chosen mode;
  // the host makes the same choice and pushes it as a new form.
  const page = load();
  page.send(state({ fixModes: WITH_CUSTOM, form: { ...DEFAULT_FORM, fixModeId: "team-safe" } }));
  assert.equal(strategyLabel(page).name, "Team Safe Fix");

  page.send(state({ fixModes: MODES }));
  assert.equal(page.byId("fixModeId").value, "standard");
  assert.deepEqual(strategyLabel(page), NO_LABEL);
});

test("no catalog, no label: Run would send no mode at all", () => {
  for (const fixModes of [
    { kind: "loading" as const },
    { kind: "unavailable" as const, detail: "AI Fix Modes could not be read." },
  ]) {
    const page = load();
    page.send(state({ fixModes, form: { ...DEFAULT_FORM, fixModeId: "investigate-first" } }));
    assert.deepEqual(strategyLabel(page), NO_LABEL, fixModes.kind);
  }
});

test("with the label showing, Run from the closed section is unchanged", () => {
  const page = load();
  page.send(state({ fixModes: WITH_CUSTOM, form: { ...DEFAULT_FORM, fixModeId: "team-safe" } }));
  assert.equal(strategyLabel(page).shown, true);

  page.byId("form").dispatch("submit");
  assert.equal(lastRun(page)?.fixModeId, "team-safe");
  assert.equal(page.byId("advanced").open, false);
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

test("an accepted suggestion arrives as an ordinary form update", () => {
  // Which is what keeps it editable: it lands in the field the developer was
  // already typing in, not in a mode of its own.
  const page = load();
  page.send(state({ revision: 1, form: { ...DEFAULT_FORM, hint: "maybe cache" } }));

  page.send(state({ revision: 2, form: { ...DEFAULT_FORM, hint: "Investigate cache invalidation." } }));

  assert.equal(page.byId("hint").value, "Investigate cache invalidation.");
  assert.equal(page.byId("hint-suggestion").hidden, true);
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
  assert.equal(p.byId("description-buildContext").textContent, "Context ready");
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
    ["fix-with-ai", "fixWithAI"],
  ] as const) {
    assert.equal(p.byId(id).hidden, false, id);
    p.byId(id).dispatch("click");
    assert.deepEqual(p.posted.at(-1), { type: "action", id: action });
  }
});

// --- UI-A2: the regrouped fields still carry their state -------------------

test("the regrouped fields round-trip through the form unchanged", () => {
  // UI-A2 moved markup, renamed two labels and added helper text. None of that
  // may reach the message: a keyword list and a focus path are parsed by the
  // host, and a field that arrived under a new name would simply stop working.
  const p = load();
  p.send(state());

  p.byId("keywords").value = "VolumeDescriptor, OpenVDS\noutputType";
  p.byId("focusFiles").value = "src/core/\nsrc/services/example.cpp";
  p.byId("hint").value = "check the output validation";
  p.byId("ignorePaths").value = "build/";
  p.byId("form").dispatch("submit");

  const message = p.posted.at(-1) as { type: string; form: Record<string, unknown> };
  assert.equal(message.type, "run");
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

test("a problem in a regrouped field still opens Advanced settings and lands", () => {
  // The messages are attached by field id, and the section they live in is now
  // one of three groups. A message in a closed section is a message nobody sees.
  const p = load();
  p.send(state({ problems: [{ field: "focusFiles", message: "outside the repository" }] }));

  assert.equal(p.byId("advanced").open, true);
  assert.equal(p.byId("focusFiles-error").textContent, "outside the repository");
  assert.equal(p.byId("focusFiles-error").hidden, false);
  assert.equal(p.focused, "focusFiles");
});

// --- Batch 6: the rows are the result ---------------------------------------

test("nothing about a result is shown before the first run", () => {
  // §19: no empty card, no zero counts, no artifact waiting to be filled.
  const p = load();
  p.send(state());

  for (const id of ["open-context", "copy-context", "open-folder", "fix-with-ai"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
  for (const id of ["relevant-files", "search-details", "strategy-fixWithAI", "actions-buildContext", "actions-fixWithAI"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
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
  assert.equal(p.byId("fix-with-ai").hidden, true, "a handoff was offered mid-run");
  assert.equal(p.byId("open-folder").hidden, true);
  assert.equal(p.byId("run-label").textContent, "Running…");
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
  // Git history and Similar fixes say only what is known.
  assert.equal(p.byId("description-gitHistory").textContent, "Completed");
  assert.equal(p.byId("artifact-gitHistory").hidden, true);
  // Build context: the context is ready, and its two actions are on its row.
  assert.equal(p.byId("description-buildContext").textContent, "Context ready");
  assert.equal(p.byId("actions-buildContext").hidden, false);
  assert.equal(p.byId("open-context").hidden, false);
  assert.equal(p.byId("copy-context").hidden, false);
  // Fix with AI: ready, with the mode the task was prepared with, and the button.
  assert.equal(p.byId("description-fixWithAI").textContent, "Ready");
  assert.equal(p.byId("strategy-fixWithAI-value").textContent, "Standard Fix");
  assert.equal(p.byId("strategy-fixWithAI").hidden, false);
  assert.equal(p.byId("fix-with-ai").hidden, false);
  // The work item's folder, at the foot of the workflow.
  assert.equal(p.byId("open-folder").hidden, false);
});

test("a ready task is not the green tick", () => {
  // The tick is reserved for a handoff that actually started.
  const p = load();
  p.send(prepared());

  assert.ok(p.byId("step-fixWithAI").classes.has("step-ready"));
  assert.equal(p.byId("status-fixWithAI").hidden, true, "a ready row wore a status glyph");
  assert.ok(p.byId("step-buildContext").classes.has("step-success"));
  // Unticked, but part of what happened: not greyed out as "not chosen".
  assert.equal(p.byId("step-fixWithAI").classes.has("step-off"), false);
});

test("a search whose retrieval could not be read says Completed rather than zero", () => {
  // "0 relevant files" about a run that found eight is how a panel stops being
  // believed; a row that says only that it finished is not.
  const p = load();
  p.send(prepared({ search: { content: { files: [], terms: [] } } }));

  assert.equal(p.byId("description-codeSearch").textContent, "Completed");
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

test("Fix with AI asks for the action the host has always handled", () => {
  const p = load();
  p.send(prepared());

  p.byId("fix-with-ai").dispatch("click");
  assert.deepEqual(p.posted.at(-1), { type: "action", id: "fixWithAI" });
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
  assert.equal(p.byId("fix-with-ai").hidden, true);
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
  for (const id of ["open-context", "copy-context", "open-folder", "fix-with-ai", "strategy-fixWithAI", "relevant-files", "search-details"]) {
    assert.equal(p.byId(id).hidden, true, id);
  }
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
  assert.equal(p.byId("description-buildContext").textContent, "Context ready");
  // Only Fix with AI failed: its line, the route the prompt took, its card.
  assert.ok(p.byId("step-fixWithAI").classes.has("step-failed"));
  assert.equal(p.byId("description-fixWithAI").textContent, "Did not start");
  assert.match(p.byId("detail-fixWithAI").textContent, /clipboard/);
  assert.equal(p.byId("error-fixWithAI").hidden, false);
  assert.equal(p.byId("error-fixWithAI-title").textContent, "AI agent unavailable");
  assert.equal(p.byId("error-fixWithAI-detail").textContent, "claude is not on PATH.");
  assert.equal(p.byId("failure").hidden, true, "a handoff failure claimed the run card");
  // And the button is back, because installing an agent and pressing again is
  // a real thing to do.
  assert.equal(p.byId("fix-with-ai").hidden, false);
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
  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");
});

// --- the successful handoff, on its row -------------------------------------

const STARTED = { fix: { status: "success" as const, detail: "Handed to Claude Code in a terminal." } };

test("before a handoff there is a button and no outcome", () => {
  const p = load();
  p.send(prepared());

  assert.equal(p.byId("fix-with-ai").hidden, false);
  assert.equal(p.byId("description-fixWithAI").textContent, "Ready");
  assert.equal(p.byId("detail-fixWithAI").hidden, true);
});

test("a successful handoff replaces the button with what actually happened", () => {
  const p = load();
  p.send(prepared({ ...STARTED, ...withSearch({ files: FOUND }) }));

  assert.ok(p.byId("step-fixWithAI").classes.has("step-success"));
  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");
  assert.equal(p.byId("detail-fixWithAI").textContent, "Handed to Claude Code in a terminal.");
  assert.equal(p.byId("fix-with-ai").hidden, true, "a second handoff was on offer");
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

  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");
  assert.equal(p.byId("detail-fixWithAI").hidden, true);
});

test("the row says it is working, and offers no second press meanwhile", () => {
  const p = load();
  p.send(prepared({ handoffBusy: true }));

  assert.equal(p.byId("description-fixWithAI").textContent, "Starting AI fix…");
  assert.match(p.byId("status-fixWithAI").className, /codicon-spin/);
  assert.equal(p.byId("fix-with-ai").hidden, true);
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
  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");

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

  assert.equal(p.byId("description-fixWithAI").textContent, "AI fix started");
  assert.match(p.byId("step-fixWithAI").getAttribute("aria-label") ?? "", /^Fix with AI: done$/);
});

// --- UI-V1: what rendering the page found ------------------------------------

test("the run hint stops explaining Run once Run has been pressed", () => {
  // Advice about a button, sitting directly above the proof of what that button
  // did. Visible in every post-run screenshot until UI-V1.
  const p = load();
  p.send(state());
  assert.equal(p.byId("run-hint").hidden, false);

  p.send(prepared());
  assert.equal(p.byId("run-hint").hidden, true);

  p.send(state({ runError: { kind: "run", title: "Run failed", message: "It stopped." } }));
  assert.equal(p.byId("run-hint").hidden, true);

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
