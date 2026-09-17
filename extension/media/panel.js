// @ts-check
/**
 * The panel's page script.
 *
 * Deliberately small. There is no bundler, so this file cannot import the
 * extension's models — which is why the host computes every derived value
 * (validation, the workflow rows, artifact grouping) and this file only renders
 * a state object and reports what the developer did.
 *
 * Two rules hold throughout:
 *
 *  - **Never assign HTML.** Bug titles and error messages come from Jira and
 *    from a CLI's stderr. Everything here goes through `textContent`, so there
 *    is no path from that text to markup. `test/panel.test.ts` greps this file
 *    for `innerHTML` and friends and fails if one appears.
 *  - **The page owns the form; the host owns everything else.** The host only
 *    replaces the form when it bumps `revision`, so a state push cannot wipe
 *    out half-typed input. On a workflow row that split runs down the middle:
 *    the checkbox is the page's, the icon, duration and description are the
 *    host's.
 */

(() => {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** Ids that match `FormState` keys exactly. */
  const TEXT_FIELDS = [
    "issueKey",
    "title",
    "description",
    "hint",
    "keywords",
    "focusFiles",
    "ignorePaths",
    "maxFiles",
    "maxSearchLines",
    "agentCommand",
  ];

  /**
   * Fields that live inside Advanced settings, which starts collapsed.
   *
   * A validation message in a collapsed section is a message nobody can see,
   * so a problem in one of these opens it.
   */
  const ADVANCED_FIELDS = [
    "title",
    "hint",
    "keywords",
    "focusFiles",
    "ignorePaths",
    "maxFiles",
    "maxSearchLines",
    "agentCommand",
  ];

  /** Which fields belong to which input source. */
  const JIRA_ONLY = ["issueKey"];
  const MANUAL_ONLY = ["title", "description"];

  /** The five the CLI runs, which are the ones that go into `form.plan`. */
  const PLAN_FIELDS = [
    "issueDetails",
    "codeSearch",
    "gitHistory",
    "similarFixes",
    "buildContext",
  ];

  /**
   * The three the CLI cannot skip on their own.
   *
   * Turning off Build context means `--only-issue-details`, which drops these
   * as well — and drops the AI fix with them, since there would be no package
   * to hand over.
   */
  const COUPLED_TO_CONTEXT = ["codeSearch", "gitHistory", "similarFixes", "fixWithAI"];

  /**
   * Icon plus the word used in the accessible name, so state is not colour.
   *
   * `idle` has no icon: the checkbox at the other end of the row already says
   * the step is going to run, and an outline circle for every unstarted step
   * is five glyphs saying nothing has happened yet. The rest are round —
   * a bare tick here read as a second checkbox.
   */
  const STEP_STATES = {
    idle: { icon: "", spin: false, word: "not started" },
    running: { icon: "loading", spin: true, word: "running" },
    success: { icon: "pass-filled", spin: false, word: "done" },
    failed: { icon: "error", spin: false, word: "failed" },
    skipped: { icon: "circle-slash", spin: false, word: "skipped" },
  };

  const byId = (id) => document.getElementById(id);
  /** For ids only some rows have, such as a row's action icons. */
  const maybe = (id) => document.getElementById(id);

  let appliedRevision = -1;
  let running = false;
  /**
   * The attached paths, as the page holds them.
   *
   * Part of the form, so the page owns it like every other field — but it is a
   * list rather than an input, so it lives here and is rendered rather than
   * read out of the DOM. Paths only ever *enter* it from the host, which got
   * them from the editor's file dialog; the page can remove one, never invent
   * one.
   */
  let attachments = [];
  let shownProblems = "";
  /** The coupled checkboxes as they were before Build context forced them off. */
  let planBeforeCoupling;

  // --- reading the form ----------------------------------------------------

  function readForm() {
    const form = { source: byId("source-manual").checked ? "manual" : "jira", plan: {} };
    for (const field of TEXT_FIELDS) form[field] = byId(field).value;
    for (const field of PLAN_FIELDS) form.plan[field] = byId(`plan-${field}`).checked;
    form.plan.issueDetails = true;
    // Not part of the plan: it is what happens after the run, not a flag on it.
    form.fixWithAI = byId("plan-fixWithAI").checked;
    form.agent = byId("agent").value || "auto";
    form.attachments = [...attachments];
    form.fresh = byId("fresh").checked;
    return form;
  }

  function writeForm(form) {
    byId("source-jira").checked = form.source !== "manual";
    byId("source-manual").checked = form.source === "manual";
    for (const field of TEXT_FIELDS) byId(field).value = form[field] ?? "";
    for (const field of PLAN_FIELDS) {
      byId(`plan-${field}`).checked = form.plan?.[field] !== false;
    }
    byId("plan-issueDetails").checked = true;
    // Opt-in, so an absent field means off — unlike the plan, where absent
    // means the default of on.
    byId("plan-fixWithAI").checked = form.fixWithAI === true;
    byId("agent").value = form.agent ?? "auto";
    attachments = Array.isArray(form.attachments) ? [...form.attachments] : [];
    renderAttachments();
    byId("fresh").checked = form.fresh === true;
    // The stored form is the new truth; forget any coupling snapshot from
    // before it was loaded.
    planBeforeCoupling = undefined;
    applySourceVisibility();
    applyAgentVisibility();
    applyPlanCoupling();
  }

  /** Show only the fields the chosen input source uses. */
  function applySourceVisibility() {
    const manual = byId("source-manual").checked;
    for (const field of JIRA_ONLY) byId(`field-${field}`).hidden = manual;
    for (const field of MANUAL_ONLY) byId(`field-${field}`).hidden = !manual;
  }

  /**
   * One row per attached file: its name, and the way to take it back off.
   *
   * Built rather than templated, like the notices and the blocked actions,
   * and every string goes through `textContent` — a file name is text from
   * the developer's disk and has no business becoming markup.
   */
  function renderAttachments() {
    const list = byId("attachment-list");
    list.replaceChildren();
    for (const path of attachments) {
      const item = document.createElement("li");
      item.className = "attachment";

      const name = document.createElement("span");
      name.className = "attachment-name";
      // The basename is what a developer recognises; the full path is the
      // tooltip, because a sidebar has no room for one.
      name.textContent = path.split(/[\\/]/).pop() || path;
      name.setAttribute("title", path);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon";
      remove.setAttribute("aria-label", `Remove ${name.textContent}`);
      remove.setAttribute("title", "Remove");
      const glyph = document.createElement("span");
      glyph.className = "codicon codicon-close";
      glyph.setAttribute("aria-hidden", "true");
      remove.append(glyph);
      remove.addEventListener("click", () => {
        attachments = attachments.filter((entry) => entry !== path);
        renderAttachments();
        formChanged();
      });

      item.append(name, remove);
      list.append(item);
    }
    list.hidden = attachments.length === 0;
  }

  /**
   * The custom command box belongs to exactly one choice.
   *
   * Auto-detect used to have a note beside it explaining what it would look
   * for; the option's own text says that, so it is gone and this only has one
   * thing left to decide.
   */
  function applyAgentVisibility() {
    byId("field-agentCommand").hidden = byId("agent").value !== "custom";
  }

  /**
   * Build context off means `--only-issue-details`, which also skips search,
   * history, similar fixes and — with no package to hand over — the AI fix.
   * Leaving those ticked would show a workflow that never ran, so they are
   * disabled and unticked with the reason spelled out.
   */
  function applyPlanCoupling() {
    const contextOff = !byId("plan-buildContext").checked;
    if (contextOff) {
      // Remember the selection before clearing it. Without this, re-ticking
      // Build context leaves all of them off, and the next run silently skips
      // search, history and similar fixes — a plan nobody chose.
      if (!planBeforeCoupling) {
        planBeforeCoupling = COUPLED_TO_CONTEXT.map((field) => byId(`plan-${field}`).checked);
      }
      for (const field of COUPLED_TO_CONTEXT) {
        const box = byId(`plan-${field}`);
        box.checked = false;
        box.disabled = true;
      }
    } else {
      COUPLED_TO_CONTEXT.forEach((field, index) => {
        const box = byId(`plan-${field}`);
        if (planBeforeCoupling) box.checked = planBeforeCoupling[index];
        box.disabled = running;
      });
      planBeforeCoupling = undefined;
    }
    byId("plan-note").hidden = !contextOff;
  }

  // --- rendering -----------------------------------------------------------

  function render(state) {
    // Derived before anything renders: renderReadiness decides whether Run is
    // clickable, and reading the previous render's `running` left the button
    // enabled for the whole first frame of a run.
    running = (state.progress || {}).state === "running";

    if (typeof state.revision === "number" && state.revision !== appliedRevision && state.form) {
      writeForm(state.form);
      appliedRevision = state.revision;
      persist(state.form);
    }

    renderReadiness(state.readiness);
    renderProblems(state.problems || []);
    renderWorkflow(state);
    renderRun(state);
    renderNotices(state);
    renderFooter(state);
  }

  function renderReadiness(readiness) {
    const checking = !readiness || readiness.kind === "checking";
    const blocked = Boolean(readiness) && readiness.kind === "blocked";
    // Three distinct states, because they need three different reactions:
    // wait, fix something, or go ahead.
    byId("checking").hidden = !checking;
    byId("blocked").hidden = !blocked;
    if (blocked) {
      byId("blocked-summary").textContent = readiness.summary || "";
      byId("blocked-action").textContent = readiness.action || "";
      const container = byId("blocked-actions");
      container.replaceChildren();
      for (const action of readiness.actions || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.title;
        // The command id came from the host, and the host re-checks it against
        // its own table before executing.
        button.addEventListener("click", () =>
          vscode.postMessage({ type: "command", id: action.command }),
        );
        container.append(button);
      }
    }
    setFormEnabled(!blocked && !checking && !running);
    byId("run").disabled = blocked || checking || running;
    byId("add-attachment").disabled = blocked || checking || running;
  }

  function renderProblems(problems) {
    for (const field of TEXT_FIELDS) {
      const problem = problems.find((entry) => entry.field === field);
      const error = byId(`${field}-error`);
      error.textContent = problem ? problem.message : "";
      error.hidden = !problem;
      byId(`field-${field}`).classList.toggle("field-invalid", Boolean(problem));
      byId(field).setAttribute("aria-invalid", problem ? "true" : "false");
    }
    // Focus moves only when the problems themselves changed. The host pushes
    // state for every stream event and every environment refresh, and focusing
    // on each of those yanks the cursor out of whatever field the developer
    // moved to after reading the message.
    const signature = problems.map((entry) => `${entry.field}:${entry.message}`).join("|");
    const first = problems.find((entry) => TEXT_FIELDS.includes(entry.field));
    if (first && signature !== shownProblems) {
      // A problem in a collapsed section is a problem nobody can see.
      if (ADVANCED_FIELDS.includes(first.field)) byId("advanced").open = true;
      byId(first.field).focus();
    }
    shownProblems = signature;
  }


  /**
   * One row per step: the icon, the duration, the description, the actions.
   *
   * The checkbox is untouched here on purpose — it is form state, and the host
   * only replaces that through `writeForm` when the revision changes.
   */
  function renderWorkflow(state) {
    const steps = state.workflow || [];
    for (const step of steps) {
      const meta = STEP_STATES[step.status] || STEP_STATES.idle;
      const row = byId(`step-${step.id}`);
      row.className = `step step-${step.status}${step.enabled ? "" : " step-off"}`;
      row.setAttribute(
        "aria-label",
        `${step.label}: ${step.enabled ? meta.word : "not selected"}`,
      );

      const status = byId(`status-${step.id}`);
      status.hidden = meta.icon === "";
      status.className = meta.icon
        ? `step-status codicon codicon-${meta.icon}${meta.spin ? " codicon-spin" : ""}`
        : "step-status codicon";
      byId(`duration-${step.id}`).textContent =
        typeof step.durationMs === "number" ? formatDuration(step.durationMs) : "";
      // `detail` is what actually happened, when the icon alone would be
      // ambiguous — "handed to Claude Code in a terminal" against a tick.
      byId(`description-${step.id}`).textContent = step.detail || step.description || "";

      const actions = maybe(`actions-${step.id}`);
      if (actions) actions.hidden = (step.actions || []).length === 0;
    }

    const overall = state.overall || { kind: "idle", text: "" };
    const status = byId("workflow-status");
    status.textContent = overall.text;
    status.className = `workflow-status is-${overall.kind}`;
    byId("activity").textContent = (state.progress || {}).activity || "";
  }

  function renderRun(state) {
    const progress = state.progress || {};
    const failure = progress.failure;
    byId("failure").hidden = !failure;
    if (failure) {
      byId("failure-summary").textContent = failure.summary || "";
      byId("failure-action").textContent = failure.action || "";
    }
    // Shown only when it is the thing to do, in the row beside Run.
    // Disabled-but-visible was worse than absent: a greyed Stop under an idle
    // panel is a control that has never once been usable when it was on screen.
    const canStop = running;
    // Not offered mid-run: `bug --retry` reads the artifacts of a finished
    // attempt, so during one it could only be greyed out anyway.
    const canRetry = Boolean(state.canRetry) && !running;
    byId("stop").hidden = !canStop;
    byId("stop").disabled = !canStop;
    byId("retry").hidden = !canRetry;
    byId("retry").disabled = !canRetry;
  }

  /**
   * The standing facts, one card each.
   *
   * Host-computed and titled there: these are different subjects — a Jira
   * misconfiguration and an unignored artifact directory — and joining them
   * into one line put the first under a heading about the second.
   */
  function renderNotices(state) {
    const warnings = state.warnings || [];
    const container = byId("notices");
    container.replaceChildren();
    for (const warning of warnings) {
      const card = document.createElement("section");
      card.className = "notice";

      const icon = document.createElement("span");
      // Orange, from the shared palette; the card's text keeps its own colours.
      icon.className = "codicon codicon-warning icon-warning";
      icon.setAttribute("aria-hidden", "true");

      const body = document.createElement("div");
      const title = document.createElement("p");
      title.className = "notice-title";
      title.textContent = warning.title || "";
      const message = document.createElement("p");
      message.className = "notice-message";
      message.textContent = warning.message || "";
      body.append(title, message);

      card.append(icon, body);
      container.append(card);
    }
    container.hidden = warnings.length === 0;
  }

  function renderFooter(state) {
    const readiness = state.readiness || {};
    // The version answers "which bugpilot is this?" on a machine that has more
    // than one, which is the common case once a pipx copy and a checkout exist.
    byId("environment").textContent =
      readiness.kind === "ready"
        ? [
            readiness.version ? `BugPilot ${readiness.version}` : readiness.executable,
            readiness.root,
          ].join(" · ")
        : "";
    // A tick and one word, rather than a sentence: this is status, and it sits
    // below every control in the panel.
    byId("jira-status").textContent = state.jiraConfigured ? "Configured" : "Not configured";
    byId("jira-status").className = state.jiraConfigured ? "ok" : "muted";
    byId("jira-ok").hidden = !state.jiraConfigured;
    byId("set-credentials").textContent = state.jiraConfigured ? "Replace" : "Set Jira credentials";
  }

  function setFormEnabled(enabled) {
    for (const field of TEXT_FIELDS) byId(field).disabled = !enabled;
    byId("source-jira").disabled = !enabled;
    byId("source-manual").disabled = !enabled;
    byId("agent").disabled = !enabled;
    byId("fresh").disabled = !enabled;
    byId("plan-buildContext").disabled = !enabled;
    applyPlanCoupling();
  }

  function formatDuration(ms) {
    // Anything faster than a tenth of a second is reported as such rather than
    // rounded into a made-up figure like "0.001s".
    if (ms < 50) return "<0.1s";
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
  }

  // --- persistence ---------------------------------------------------------

  /**
   * Keep the typed form across hide/show and reload.
   *
   * `setState` rather than `retainContextWhenHidden`: the panel is cheap to
   * rebuild and keeping a hidden webview resident costs memory for the whole
   * session (§5.4).
   */
  function persist(form) {
    vscode.setState({ form });
  }

  // --- wiring --------------------------------------------------------------

  let changeTimer;
  function formChanged() {
    const form = readForm();
    persist(form);
    clearTimeout(changeTimer);
    // Debounced: the host persists this into workspace state, and a message per
    // keystroke would be a lot of traffic for no benefit.
    changeTimer = setTimeout(() => vscode.postMessage({ type: "formChanged", form }), 400);
  }

  function submit() {
    if (running || byId("run").disabled) return;
    vscode.postMessage({ type: "run", form: readForm() });
  }

  byId("form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  // Ctrl+Enter from anywhere in the form, which is what a multi-line
  // description needs: Enter alone belongs to the textarea.
  byId("form").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  byId("form").addEventListener("input", formChanged);
  byId("form").addEventListener("change", (event) => {
    const target = event.target;
    if (target && (target.name === "source" || target.id === "plan-buildContext")) {
      applySourceVisibility();
      applyPlanCoupling();
    }
    if (target && target.id === "agent") applyAgentVisibility();
    formChanged();
  });

  byId("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  byId("retry").addEventListener("click", () => vscode.postMessage({ type: "retry" }));
  byId("open-context").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "openContext" }),
  );
  byId("copy-context").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "copyHandoff" }),
  );
  byId("open-folder").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "openFolder" }),
  );
  // The dialog can only be opened by the host, so this asks — and carries the
  // form, because the host's copy can be a debounce interval stale.
  byId("add-attachment").addEventListener("click", () =>
    vscode.postMessage({ type: "addAttachments", form: readForm() }),
  );
  byId("set-credentials").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "setCredentials" }),
  );

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "state") render(message.state);
  });

  // Restore what was typed before the page was rebuilt, then ask the host for
  // the rest. The host's first push carries a revision that only replaces the
  // form if it has something newer.
  const saved = vscode.getState();
  if (saved && saved.form) writeForm(saved.form);
  else {
    renderAttachments();
    applySourceVisibility();
    applyAgentVisibility();
    applyPlanCoupling();
  }
  vscode.postMessage({ type: "ready" });
})();
