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

  /**
   * The multi-line fields, which grow to fit what has been typed into them.
   *
   * Every textarea on the page, not a chosen few: they are the same control,
   * and a Hint that grows next to a Focus files that does not is a difference
   * the developer has to discover. `rows` in the markup is the height each one
   * starts at; `max-height` in `panel.css` is where growing stops.
   */
  const GROWING_FIELDS = ["description", "hint", "keywords", "focusFiles", "ignorePaths"];

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
  /** The catalog as it was last rendered, so options are not rebuilt per push. */
  let fixModeSignature;
  /** Whether a real mode can be chosen; the selector stays disabled until then. */
  let fixModesReady = false;
  /** The catalog as the host last described it, for the note under the select. */
  let fixModeCatalog;
  /** The coupled checkboxes as they were before Build context forced them off. */
  let planBeforeCoupling;

  // --- growing fields ------------------------------------------------------

  /**
   * Resize one field to its content.
   *
   * `height: auto` comes first for two reasons. It is what lets the field
   * shrink again — `scrollHeight` on a box already stretched to fit reports the
   * stretched height, so without it a field that grew to ten lines stays ten
   * lines after the text is deleted. And it puts the box back to the height
   * `rows` asks for, which is the floor: a textarea does not grow with its
   * content on its own, so that measurement is `rows` and nothing else.
   *
   * Measuring the floor here rather than once at load is what makes it right
   * for Hint and Keywords, which live inside Advanced settings: a field in a
   * closed `<details>` has no layout, and every height read from it is zero.
   * That case leaves `height: auto` in place — the right height for when the
   * section is opened — and waits to be called again.
   */
  function grow(element) {
    if (!element || !GROWING_FIELDS.includes(element.id)) return;
    element.style.height = "auto";
    const resting = element.clientHeight;
    if (!resting) return;
    element.style.height = `${Math.max(resting, element.scrollHeight)}px`;
  }

  function growAll() {
    for (const field of GROWING_FIELDS) grow(byId(field));
  }

  // --- reading the form ----------------------------------------------------

  function readForm() {
    const form = { source: byId("source-manual").checked ? "manual" : "jira", plan: {} };
    for (const field of TEXT_FIELDS) form[field] = byId(field).value;
    for (const field of PLAN_FIELDS) form.plan[field] = byId(`plan-${field}`).checked;
    form.plan.issueDetails = true;
    // Not part of the plan: it is what happens after the run, not a flag on it.
    form.fixWithAI = byId("plan-fixWithAI").checked;
    form.agent = byId("agent").value || "auto";
    form.fixModeId = byId("fixModeId").value || "";
    form.attachments = [...attachments];
    form.fresh = byId("fresh").checked;
    // Gates what the hint improver may read. Not a run flag.
    form.useIssueDetails = byId("useIssueDetails").checked;
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
    // After renderFixModes has put the options there — a value that is not one
    // of them is dropped by the element, which is why the order matters.
    byId("fixModeId").value = form.fixModeId ?? "";
    attachments = Array.isArray(form.attachments) ? [...form.attachments] : [];
    renderAttachments();
    byId("fresh").checked = form.fresh === true;
    byId("useIssueDetails").checked = form.useIssueDetails !== false;
    // The stored form is the new truth; forget any coupling snapshot from
    // before it was loaded.
    planBeforeCoupling = undefined;
    applySourceVisibility();
    applyAgentVisibility();
    applyPlanCoupling();
    // After the visibility pass, not before: a field the source just hid has no
    // height to measure, and one it just showed had none a moment ago.
    growAll();
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

    // Before the form is written: `writeForm` sets the select's value, and a
    // <select> silently drops a value that has no option yet.
    renderFixModeOptions(state);

    if (typeof state.revision === "number" && state.revision !== appliedRevision && state.form) {
      writeForm(state.form);
      appliedRevision = state.revision;
      persist(state.form);
    }

    renderReadiness(state.readiness);
    renderProblems(state.problems || []);
    // After the form: the note describes whichever mode the select ended on.
    renderFixModes(state);
    renderWorkflow(state);
    renderRun(state);
    renderNotices(state);
    renderManage(state);
    renderHintImprovement(state);
    renderFooter(state);
  }

  /**
   * The Fix Mode selector: its options, its description, and what it cannot do.
   *
   * The options come from the host, which got them from `bugpilot fix-mode
   * list --json`. Nothing here knows what a Fix Mode is called or which one is
   * the default — a list written into this file would go stale the moment the
   * registry grows, and would look right while doing so.
   *
   * Rebuilt only when the catalog itself changes, so a state push mid-typing
   * cannot reset the developer's choice.
   */
  function renderFixModeOptions(state) {
    const catalog = state.fixModes || { kind: "loading" };
    const select = byId("fixModeId");
    const signature =
      catalog.kind === "ready"
        ? catalog.modes.map((mode) => `${mode.id}:${mode.name}`).join("|")
        : `${catalog.kind}:${catalog.detail || ""}`;
    if (signature !== fixModeSignature) {
      fixModeSignature = signature;
      const chosen = select.value;
      select.replaceChildren();
      if (catalog.kind === "ready") {
        for (const mode of catalog.modes) {
          const option = document.createElement("option");
          option.value = mode.id;
          option.textContent = mode.name;
          select.append(option);
        }
        // Keep the developer's choice across a re-render; otherwise fall to the
        // default the CLI declared, never to a name spelled out here.
        select.value = catalog.modes.some((mode) => mode.id === chosen)
          ? chosen
          : catalog.defaultModeId || "";
      } else {
        const option = document.createElement("option");
        option.value = "";
        option.textContent =
          catalog.kind === "loading" ? "Loading Fix Modes…" : "Fix Modes unavailable";
        select.append(option);
        select.value = "";
      }
    }
    fixModesReady = catalog.kind === "ready";
    fixModeCatalog = catalog;
  }

  /** The note and the prepared line, once the form has settled on a selection. */
  function renderFixModes(state) {
    renderFixModeNote((state.problems || []).find((entry) => entry.field === "fixModeId"));
    renderPreparedFixMode(state);
  }

  /**
   * The line under the selector: what this mode does, or why there is none.
   *
   * Called on every render and again the moment the developer changes the
   * selection, so the description never lags a click behind the dropdown.
   */
  function renderFixModeNote(problem) {
    const select = byId("fixModeId");
    const note = byId("fixModeId-description");
    const catalog = fixModeCatalog || { kind: "loading" };
    const selected =
      catalog.kind === "ready"
        ? catalog.modes.find((mode) => mode.id === select.value)
        : undefined;
    // Spelled out in words rather than as a colour or an icon alone: this is
    // the difference between a pass that edits the repository and one that does
    // not, and it has to survive a screen reader and a monochrome theme.
    const investigation =
      selected && selected.executionKind === "investigate"
        ? "Investigation only — no source changes in this pass. "
        : "";
    note.textContent = problem
      ? problem.message
      : catalog.kind === "unavailable"
        ? catalog.detail || "AI Fix Modes could not be read."
        : selected
          ? `${investigation}${selected.description || ""}`.trim()
          : "";
    byId("field-fixModeId").classList.toggle(
      "field-invalid",
      Boolean(problem) || catalog.kind === "unavailable",
    );
    select.setAttribute("aria-invalid", problem ? "true" : "false");
  }

  /**
   * What the package on disk was prepared with — not what the dropdown says.
   *
   * They differ as soon as someone changes the selection without running, and
   * labelling an old package with a new choice would misreport what the agent
   * was actually told.
   */
  function renderPreparedFixMode(state) {
    const prepared = state.preparedFixMode;
    const line = byId("prepared-fix-mode");
    if (!prepared) {
      line.textContent = "";
      line.hidden = true;
      return;
    }
    const kind =
      prepared.executionKind === "investigate" ? " · investigation only" : "";
    // Three states, not two. "This mode is gone" and "BugPilot could not check"
    // look alike and mean opposite things: one needs a new mode chosen, the
    // other needs nothing at all.
    const suffix =
      prepared.availability === "unavailable"
        ? " (unavailable)"
        : prepared.availability === "unknown"
          ? " · availability unknown"
          : kind;
    line.textContent = `Prepared with Fix Mode: ${prepared.name}${suffix}`;
    line.hidden = false;
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
    // Disabled until the catalog is in: an enabled selector with nothing real
    // in it invites a choice that does not exist.
    byId("fixModeId").disabled = !enabled || !fixModesReady;
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


  // --- improving the hint ----------------------------------------------------

  /**
   * What the hint improver is doing, and what it has to show for it.
   *
   * The suggestion is rendered beside the field, never into it: replacing what
   * the developer wrote is something they do, by pressing a button, and this
   * function's whole job is to keep that true.
   */
  function renderHintImprovement(state) {
    const view = state.hintImprovement || {};
    const busy = view.busy === true;

    const label = byId("improve-hint-label");
    label.textContent = busy ? "Improving…" : "Improve with AI";
    // A spinner from the theme's own icon set rather than a word that moves.
    byId("improve-hint-icon").className = busy
      ? "codicon codicon-loading codicon-spin"
      : "codicon codicon-hubot";
    // The one control that must be disabled: a second press would spend another
    // model call on the same question. Everything else stays usable.
    byId("improve-hint").disabled = busy;

    const notice = byId("hint-improve-notice");
    notice.textContent = view.notice || "";
    notice.hidden = notice.textContent === "";

    const error = byId("hint-improve-error");
    error.textContent = view.error || "";
    error.hidden = error.textContent === "";

    const suggestion = typeof view.suggestion === "string" ? view.suggestion : "";
    byId("hint-suggestion-text").textContent = suggestion;
    const panel = byId("hint-suggestion");
    const appearing = suggestion !== "" && panel.hidden;
    panel.hidden = suggestion === "";
    if (appearing) {
      // Only when it arrives, and only once: a suggestion the developer has to
      // hunt for is one they will not read.
      scrollIntoView(panel, "nearest");
    }
  }

  byId("improve-hint").addEventListener("click", () =>
    // The form travels with it for the same reason a run carries one: the
    // host's copy can be a debounce interval stale, and the hint being improved
    // is whatever is on screen now.
    vscode.postMessage({ type: "improveHint", form: readForm() }),
  );
  byId("hint-use").addEventListener("click", () =>
    vscode.postMessage({ type: "useImprovedHint" }),
  );
  byId("hint-keep").addEventListener("click", () =>
    vscode.postMessage({ type: "dismissImprovedHint" }),
  );

  // --- panel views ---------------------------------------------------------

  /**
   * The three things this webview can be showing, and the section holding each.
   *
   * Still one webview: the host owns exactly one, and what changes is which
   * section is visible. Management used to be a section that unhid *below* the
   * form, which in a 300px sidebar put it past the fold — pressing the gear
   * looked like it had done nothing at all.
   */
  const PANEL_VIEWS = {
    main: "main-view",
    "fix-mode-manager": "fix-mode-manager-view",
    "fix-mode-preview": "fix-mode-preview-view",
    // New and Edit share one form — eleven fields with one set of ids, rather
    // than a second copy of them — but they are different views: different
    // title, different way back, different place to land after saving.
    "fix-mode-new": "fix-mode-editor-view",
    "fix-mode-edit": "fix-mode-editor-view",
  };

  const VIEW_SECTIONS = [...new Set(Object.values(PANEL_VIEWS))];

  /**
   * Where focus lands when a view opens.
   *
   * A heading for the two Fix Mode views, so assistive tech announces what the
   * panel has just become rather than leaving the caret on a button that is no
   * longer visible; the gear on the way back, because that is where the
   * developer left from.
   */
  const VIEW_FOCUS = {
    main: "manage-fix-modes",
    "fix-mode-manager": "manage-heading",
    "fix-mode-preview": "preview-heading",
    "fix-mode-new": "editor-title",
    "fix-mode-edit": "editor-title",
  };

  let activeView = "main";
  let mainScroll = 0;

  /**
   * Where a New Fix Mode was started from: the list, or a mode being read.
   *
   * Navigation context and nothing else. A duplicate can be started from two
   * places and has to come back to the one it came from, and neither the draft
   * nor the mode it was copied from can answer which — two developers reaching
   * the same New Fix Mode by different routes expect different Back buttons.
   * It never reaches the controller, the store or an artifact.
   */
  let duplicateOrigin;

  /** Set while leaving the editor should land on the preview, not the list. */
  let pendingReturn;

  /**
   * The mode the host last handed over to be read.
   *
   * Kept so returning from a duplicate can show it again without asking for it
   * a second time. It is the host's own object, not a second lookup: nothing
   * here resolves precedence or reads a file.
   */
  let previewMode;

  /** The preview's own duplicate button, to give focus back to on return. */
  let previewDuplicate;

  /** The row a create just wrote, once the list has been built with it in. */
  let createdRow;
  /** Which created mode has already been scrolled to, so it happens once. */
  let scrolledTo;

  /**
   * Which view the host's state means.
   *
   * Derived rather than stored: `manage` and `manage.editor` belong to the
   * controller, and a second copy of "which view is open" on this side would be
   * one more thing that can disagree. This is the only place that decides.
   */
  function viewFor(state, editor) {
    if (!state.manage) return "main";
    if (editor) {
      if (editor.intent === "view") return "fix-mode-preview";
      return editor.intent === "create" ? "fix-mode-new" : "fix-mode-edit";
    }
    // The editor closed — saved, cancelled or backed out of. A create that
    // started from a preview returns to it; everything else to the list.
    if (pendingReturn === "preview" && previewMode) return "fix-mode-preview";
    return "fix-mode-manager";
  }

  /** Show exactly one view, and move the developer with it. */
  function showView(view) {
    // `hidden`, not a class: it takes the whole section out of the tab order,
    // so Tab inside the manager cannot walk into the form behind it.
    const shown = PANEL_VIEWS[view];
    for (const id of VIEW_SECTIONS) byId(id).hidden = id !== shown;
    if (view === activeView) return;
    const previous = activeView;
    if (previous === "main") mainScroll = scrollPosition();
    activeView = view;
    // A view opens at its own top; coming back restores where the form was.
    scrollPanelTo(view === "main" ? mainScroll : 0);
    // The growing fields had no layout while the form was hidden, and every
    // height read from a hidden box is zero — the same case Advanced settings
    // has while it is closed. Returning is their first measurable moment.
    if (view === "main") growAll();
    // Coming back to a mode the developer was reading, put them back on the
    // button they left from rather than at the top of it again.
    const fromEditor = previous === "fix-mode-new" || previous === "fix-mode-edit";
    if (view === "fix-mode-preview" && fromEditor && previewDuplicate) {
      focusElement(previewDuplicate);
      return;
    }
    focusView(VIEW_FOCUS[view]);
  }

  function focusView(id) {
    focusElement(byId(id));
  }

  function focusElement(target) {
    if (target && typeof target.focus === "function") target.focus();
  }

  function scrollPosition() {
    return typeof window.scrollY === "number" ? window.scrollY : 0;
  }

  function scrollPanelTo(offset) {
    if (typeof window.scrollTo === "function") window.scrollTo(0, offset);
  }

  /** Bring one element into view, where the host's webview supports it. */
  function scrollIntoView(element, block) {
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: block || "center" });
    }
  }

  // --- managing custom Fix Modes -------------------------------------------

  /** The editor's fields, named exactly as the draft names them. */
  const EDITOR_SECTIONS = [
    "objective",
    "investigation",
    "implementation",
    "verification",
    "constraints",
    "completion",
  ];
  const EDITOR_TEXT = ["name", "id", "description", ...EDITOR_SECTIONS];
  /** How a mode's own scope reads in the preview's one-line summary. */
  const SOURCE_LABELS = {
    builtin: "Built-in",
    user: "User",
    project: "Project",
  };
  const SECTION_LABELS = {
    objective: "Objective",
    investigation: "Investigation",
    implementation: "Implementation",
    verification: "Verification",
    constraints: "Constraints",
    completion: "Completion Requirements",
  };

  /** The draft the editor was opened with, for the fields it does not edit. */
  let openDraft;

  /**
   * The management view: what is on disk, grouped by who owns it.
   *
   * Built from the host's state rather than from the selector's list, because
   * the two answer different questions — this one has to show a user mode that
   * a project mode currently shadows, which the selector never mentions.
   */
  function renderManage(state) {
    const manage = state.manage;
    const editor = manage ? manage.editor : undefined;
    // A mode the host has handed over to be read. Kept so a duplicate started
    // from here can come back to it without a second request.
    if (editor && editor.intent === "view") previewMode = editor;

    const view = viewFor(state, editor);

    // Written into every view that can raise one, because only one of them is
    // ever on screen and which one an error belongs to depends on where the
    // operation came from: a refused save keeps the editor open, a refused
    // delete keeps the list.
    const message = (manage && manage.error) || "";
    for (const id of ["manage-error", "editor-error", "preview-error"]) {
      const element = byId(id);
      element.textContent = message;
      element.hidden = message === "";
    }

    // What a create just wrote. Said in the view the developer lands on, rather
    // than only in a notification that is gone by the time they look.
    const created = manage ? manage.created : undefined;
    const confirmation = created ? `"${created.name}" was created successfully.` : "";
    byId("manage-success").textContent = confirmation;
    byId("manage-success").hidden = confirmation === "";
    // On the preview the new mode is not the one being read, so the line also
    // says where it went.
    byId("preview-success").textContent = confirmation
      ? `${confirmation} Back shows it in the Fix Mode list.`
      : "";
    byId("preview-success").hidden = confirmation === "";

    if (manage) {
      const catalog = manage.catalog || { kind: "loading" };
      const detail = byId("manage-detail");
      detail.textContent =
        catalog.kind === "loading"
          ? "Reading Fix Modes…"
          : catalog.kind === "unavailable"
            ? catalog.detail || "Fix Modes could not be read."
            : "";
      detail.hidden = detail.textContent === "";
      renderManageList(catalog, created);
    }

    renderEditor(editor && editor.intent !== "view" ? editor : undefined);
    if (view === "fix-mode-preview") renderPreviewView(previewMode);

    // Whatever the state meant has now been read, so the context that got us
    // here is spent: an editor left behind, and a preview left for the list.
    if (view !== "fix-mode-new" && view !== "fix-mode-edit") {
      duplicateOrigin = undefined;
      pendingReturn = undefined;
    }
    if (view === "fix-mode-manager" || view === "main") {
      previewMode = undefined;
      previewDuplicate = undefined;
    }

    // Last: the content each view holds is in place before one is shown and
    // takes focus.
    showView(view);

    // And only then the new row can be scrolled to: a row inside a hidden
    // section has no layout to scroll. Once per created mode, so a catalog
    // refresh does not drag the list back again.
    const key = created ? `${created.scope}/${created.id}` : undefined;
    if (!key) {
      scrolledTo = undefined;
    } else if (view === "fix-mode-manager" && createdRow && key !== scrolledTo) {
      scrolledTo = key;
      scrollIntoView(createdRow);
    }
  }

  /**
   * One Fix Mode, read rather than edited.
   *
   * Text, not a form full of disabled boxes: a greyed-out textarea reads as
   * something the developer is failing to type into. Everything shown comes
   * from the object the host supplied — no second lookup, no precedence rule.
   */
  function renderPreviewView(draft) {
    if (!draft) return;
    byId("preview-heading").textContent = draft.name || draft.id;
    const description = byId("preview-description");
    description.textContent = draft.description || "";
    description.hidden = description.textContent === "";

    const meta = [SOURCE_LABELS[draft.source] || draft.source || "", `v${draft.version}`];
    meta.push(draft.executionKind === "investigate" ? "investigation only" : "fix");
    if (draft.basedOn) {
      meta.push(
        `based on ${draft.basedOn}${draft.basedOnVersion ? ` v${draft.basedOnVersion}` : ""}`,
      );
    }
    byId("preview-meta").textContent = meta.filter(Boolean).join(" · ");

    const body = byId("preview-body");
    body.replaceChildren();
    for (const section of EDITOR_SECTIONS) {
      const heading = document.createElement("p");
      heading.className = "manage-name";
      heading.textContent = SECTION_LABELS[section] || section;
      const text = document.createElement("p");
      text.className = "preview-text";
      text.textContent = draft[section] || "";
      body.append(heading, text);
    }
    renderPreviewActions(draft);
  }

  /**
   * What can be done to the mode being read.
   *
   * The same permissions the list gives: a built-in is copied, never written.
   * Addressed by `source` — the scope that actually owns the definition —
   * because `scope` on a draft is where a *save* would go and is never
   * `builtin`.
   */
  function renderPreviewActions(draft) {
    const actions = byId("preview-actions");
    actions.replaceChildren();
    previewDuplicate = undefined;
    const scope = draft.source;
    const available =
      scope === "builtin"
        ? [["duplicate", "Duplicate & Customize"]]
        : [["edit", "Edit"], ["duplicate", "Duplicate"], ["delete", "Delete"]];
    for (const [action, label] of available) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        if (action === "duplicate") duplicateOrigin = "preview";
        vscode.postMessage({ type: "fixModeAction", action, id: draft.id, scope });
      });
      if (action === "duplicate") previewDuplicate = button;
      actions.append(button);
    }
  }

  function renderManageList(catalog, created) {
    const container = byId("manage-list");
    container.replaceChildren();
    createdRow = undefined;
    if (catalog.kind !== "ready") return;
    for (const [scope, label, hint] of [
      ["builtin", "Built-in", "Packaged with BugPilot. Read-only."],
      ["user", "User", "Yours, in your home directory."],
      ["project", "Project", "This repository's, shareable with the team."],
    ]) {
      const modes = catalog[scope] || [];
      const group = document.createElement("div");
      group.className = "manage-group";

      const heading = document.createElement("p");
      heading.className = "card-title";
      heading.textContent = `${label} (${modes.length})`;
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = modes.length === 0 ? `${hint} None yet.` : hint;
      group.append(heading, note);

      for (const mode of modes) group.append(manageRow(scope, mode, created));
      container.append(group);
    }
    for (const issue of catalog.issues || []) {
      const card = document.createElement("p");
      card.className = "error";
      // Path and reason both: the developer has to be able to find the file.
      card.textContent = `${issue.scope}: ${issue.path} — ${issue.message}`;
      container.append(card);
    }
  }

  function manageRow(scope, mode, created) {
    const row = document.createElement("div");
    row.className = "manage-row";
    // Id *and* scope: the same id can exist in both the user and the project
    // scope, and only the pair says which of the two rows is the new one.
    if (created && created.id === mode.id && created.scope === scope) {
      row.className = "manage-row recently-created";
      createdRow = row;
    }

    const text = document.createElement("div");
    const title = document.createElement("p");
    title.className = "manage-name";
    // Said in words, not by position or colour: two modes can share an id
    // across scopes, and which one runs is the thing that is easy to get wrong.
    const badges = [`v${mode.version}`];
    if (mode.executionKind === "investigate") badges.push("investigation only");
    if (!mode.effective) badges.push("overridden by project");
    title.textContent = `${mode.name} — ${mode.id} (${badges.join(", ")})`;
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent = mode.description || "";
    text.append(title, description);

    const actions = document.createElement("div");
    actions.className = "manage-actions";
    const available =
      scope === "builtin"
        ? [["view", "View"], ["duplicate", "Duplicate & Customize"]]
        : [["view", "View"], ["edit", "Edit"], ["duplicate", "Duplicate"], ["delete", "Delete"]];
    for (const [action, label] of available) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        // Remembered before the message goes out, so the New Fix Mode this
        // opens knows the list is what it has to come back to.
        if (action === "duplicate") duplicateOrigin = "manager";
        vscode.postMessage({ type: "fixModeAction", action, id: mode.id, scope });
      });
      actions.append(button);
    }

    row.append(text, actions);
    return row;
  }

  function renderEditor(draft) {
    byId("editor-preview-pane").hidden = true;
    if (!draft) {
      openDraft = undefined;
      return;
    }
    openDraft = draft;
    // Two views, one form: the title and the way back are what tell them apart,
    // so a New Fix Mode can never be mistaken for an edit of the mode it copied.
    const creating = draft.intent === "create";
    byId("editor-title").textContent = creating ? "New Fix Mode" : "Edit Fix Mode";
    byId("editor-back-label").textContent =
      duplicateOrigin === "preview" ? "Back to Fix Mode Preview" : "Back to Fix Mode Manager";

    const origin = [];
    if (!creating) origin.push(draft.name);
    if (draft.basedOn) {
      origin.push(
        `Based on ${draft.basedOn}${
          draft.basedOnVersion ? ` version ${draft.basedOnVersion}` : ""
        }`,
      );
    }
    if (!creating) origin.push(`Current version ${draft.version}`);
    byId("editor-origin").textContent = origin.join(" · ");

    for (const field of EDITOR_TEXT) byId(`editor-${field}`).value = draft[field] ?? "";
    byId("editor-executionKind").value = draft.executionKind || "fix";
    byId("editor-scope").value = draft.scope || "user";

    // An id names the mode every prepared work item recorded, and a scope is
    // which directory the file lives in. Both are fixed once the mode exists;
    // changing either is a new mode, which is what Duplicate is for.
    byId("editor-id").disabled = !creating;
    byId("editor-scope").disabled = !creating;
    byId("editor-save").textContent = creating ? "Create Fix Mode" : "Save Fix Mode";
  }

  /** What the editor currently holds, on top of the draft it was opened with. */
  function readDraft() {
    const draft = { ...(openDraft || {}) };
    for (const field of EDITOR_TEXT) draft[field] = byId(`editor-${field}`).value;
    draft.executionKind = byId("editor-executionKind").value || "fix";
    draft.scope = byId("editor-scope").value || "user";
    return draft;
  }

  /**
   * The instructions this mode gives an agent, and nothing else.
   *
   * Only the six sections the developer owns. BugPilot's precedence, delivery
   * safety, evidence and forbidden-action sections are added around them when a
   * task is generated, and showing them here would suggest they are editable.
   */
  function renderPreview() {
    const draft = readDraft();
    const body = byId("editor-preview-body");
    body.replaceChildren();
    for (const section of EDITOR_SECTIONS) {
      const heading = document.createElement("p");
      heading.className = "manage-name";
      heading.textContent = SECTION_LABELS[section] || section;
      const text = document.createElement("p");
      text.className = "muted";
      text.textContent = draft[section] || "";
      body.append(heading, text);
    }
    byId("editor-preview-pane").hidden = false;
    // After it is shown, never before: a box with no layout cannot be scrolled
    // to. This previews the unsaved editor — it is not the Fix Mode Preview
    // view, and nothing about the editor's state changes here.
    scrollIntoView(byId("editor-preview-pane"), "start");
    const heading = byId("editor-preview-heading");
    if (heading && typeof heading.focus === "function") heading.focus({ preventScroll: true });
  }

  byId("manage-fix-modes").addEventListener("click", () =>
    vscode.postMessage({ type: "manageFixModes" }),
  );
  /**
   * Leave the editor without saving, for whichever of Back and Cancel was used.
   *
   * Both ask the host to drop the draft — the panel cannot simply show another
   * view, because the host would still have an editor open and the next state
   * push would put it straight back. Where that lands is the origin's to say.
   */
  function leaveEditor() {
    if (duplicateOrigin === "preview") pendingReturn = "preview";
    vscode.postMessage({ type: "manageFixModes" });
  }

  // One step back from each view, which is why none of them needs a history
  // stack: the manager returns to the form, the preview to the manager, and the
  // editor to whichever of the two opened it.
  byId("manage-back").addEventListener("click", () =>
    vscode.postMessage({ type: "closeFixModes" }),
  );
  byId("preview-back").addEventListener("click", () =>
    vscode.postMessage({ type: "manageFixModes" }),
  );
  byId("editor-back").addEventListener("click", leaveEditor);
  byId("editor-cancel").addEventListener("click", leaveEditor);
  byId("editor-preview").addEventListener("click", renderPreview);
  byId("editor-save").addEventListener("click", () => {
    // Set before the save goes out: a successful one closes the editor, and by
    // then the only record of where this started is here.
    if (duplicateOrigin === "preview") pendingReturn = "preview";
    vscode.postMessage({ type: "saveFixMode", draft: readDraft() });
  });

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

  byId("form").addEventListener("input", (event) => {
    grow(event.target);
    formChanged();
  });

  // Advanced settings holds three of the five growing fields, and none of them
  // could be measured while it was closed. Opening it is the first moment they
  // have a height, so it is where restored text gets sized.
  byId("advanced").addEventListener("toggle", growAll);
  byId("form").addEventListener("change", (event) => {
    const target = event.target;
    if (target && (target.name === "source" || target.id === "plan-buildContext")) {
      applySourceVisibility();
      applyPlanCoupling();
    }
    if (target && target.id === "agent") applyAgentVisibility();
    if (target && target.id === "fixModeId") renderFixModeNote();
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
    growAll();
  }
  vscode.postMessage({ type: "ready" });
})();
