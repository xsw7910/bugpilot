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

  /**
   * The text controls the document has, which is not quite `FormState`.
   *
   * `issue` is the exception and the only one: it carries `issueKey` *or*
   * `description`, decided by what is in it. Everything after it matches a
   * `FormState` key exactly.
   */
  const TEXT_FIELDS = [
    "issue",
    "title",
    "hint",
    "keywords",
    "focusFiles",
    "ignorePaths",
    "maxFiles",
    "maxSearchLines",
    "agentCommand",
  ];

  /**
   * A Jira issue key, as `form.ts` and `bugpilot/core/identity.py` spell it.
   *
   * Duplicated because a webview cannot import the extension's modules, and
   * guarded the same way the other two copies are: `test/panel.test.ts` compares
   * this literal against `JIRA_ISSUE_KEY_RE`. It is what decides, on every
   * keystroke, whether the one Issue field is naming a ticket or describing a
   * bug — the question the removed radio pair used to ask out loud.
   */
  const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

  /**
   * Which `FormState` field a host-reported problem belongs to on screen.
   *
   * The host validates `issueKey` and `description`, because those are what a
   * command line is built from; the page has one box for both, and a message
   * attached to a field with no control would be a message nobody sees.
   */
  const PROBLEM_CONTROLS = { issueKey: "issue", description: "issue" };

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

  /**
   * The multi-line fields, which grow to fit what has been typed into them.
   *
   * Every textarea on the page, not a chosen few: they are the same control,
   * and a Hint that grows next to a Focus files that does not is a difference
   * the developer has to discover. `rows` in the markup is the height each one
   * starts at; `max-height` in `panel.css` is where growing stops.
   */
  const GROWING_FIELDS = ["issue", "hint", "keywords", "focusFiles", "ignorePaths"];

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
  /**
   * Whether the last render saw a run in flight.
   *
   * Only used to notice the moment one finishes, which is when the checklist
   * stops being the thing to look at and the result above it starts.
   */
  let wasRunning = false;

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

  /**
   * What the one Issue field is naming: a ticket, prose, or nothing yet.
   *
   * Empty reads as `jira` rather than as an empty description, which keeps
   * `workItemScopeOf` returning `undefined` — "not yet any work item, so not yet
   * a reason to conclude the developer moved to another one". Reading it as a
   * blank manual bug would make every cleared field look like a new work item.
   */
  function issueSource() {
    const typed = byId("issue").value.trim();
    if (typed === "") return "jira";
    return JIRA_ISSUE_KEY_RE.test(typed.toUpperCase()) ? "jira" : "manual";
  }

  function readForm() {
    const issue = byId("issue").value;
    const source = issueSource();
    const form = { source, plan: {} };
    for (const field of TEXT_FIELDS) form[field] = byId(field).value;
    // The one box, split into the two fields the host and the CLI expect. The
    // unused one is cleared rather than left behind: a stale description under
    // a Jira key would reach `--description` the moment the key was deleted.
    delete form.issue;
    form.issueKey = source === "jira" ? issue.trim() : "";
    form.description = source === "manual" ? issue : "";
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
    for (const field of TEXT_FIELDS) byId(field).value = form[field] ?? "";
    // Whichever of the two the stored form actually used, which is also what
    // makes a form saved before the switch was removed restore correctly.
    byId("issue").value = (form.source === "manual" ? form.description : form.issueKey) ?? "";
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

  /**
   * What the Issue field is taken to mean, and the one setting that depends on
   * it.
   *
   * Title is for a hand-written bug only — a Jira issue brings its own, and
   * `buildPrepareArgs` sends `--title` on the manual path alone — so a Title box
   * beside a ticket number is a field that does nothing. It lives inside
   * Advanced settings, which is why this can follow what is typed without
   * anything moving under the developer's hands.
   *
   * The note is what the radio pair used to say. It appears only once there is
   * something to classify, so an untouched panel stays as quiet as UI-A1 asks.
   */
  function applySourceVisibility() {
    const typed = byId("issue").value.trim();
    const manual = issueSource() === "manual";
    byId("field-title").hidden = !manual;

    const note = byId("issue-note");
    note.textContent =
      typed === "" ? "" : manual ? "Bug description" : `Jira issue ${typed.toUpperCase()}`;
    note.hidden = note.textContent === "";
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
    renderContextReady(state);
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

  /** The note under the selector, once the form has settled on a selection. */
  function renderFixModes(state) {
    renderFixModeNote((state.problems || []).find((entry) => entry.field === "fixModeId"));
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

  /** The control a problem is shown on, which is not always its own name. */
  function controlFor(field) {
    return PROBLEM_CONTROLS[field] || field;
  }

  function renderProblems(problems) {
    for (const field of TEXT_FIELDS) {
      const problem = problems.find((entry) => controlFor(entry.field) === field);
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
    const first = problems.find((entry) => TEXT_FIELDS.includes(controlFor(entry.field)));
    if (first && signature !== shownProblems) {
      // A problem in a collapsed section is a problem nobody can see.
      if (ADVANCED_FIELDS.includes(first.field)) byId("advanced").open = true;
      byId(controlFor(first.field)).focus();
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
    }

    const overall = state.overall || { kind: "idle", text: "" };
    const status = byId("workflow-status");
    status.textContent = overall.text;
    status.className = `workflow-status is-${overall.kind}`;
    byId("activity").textContent = (state.progress || {}).activity || "";

    // Open while a run is in flight, and folded away once as it finishes.
    //
    // UI-A3 left it open afterwards because the artifact icons lived on the
    // Build context row — and UI-B1 moved them into the result section, which
    // took that reason away. What a screenshot then showed was 314px of
    // checklist under a 412px result, its summary reading "Context ready"
    // directly below a block reading "Context Ready", and a "Fix with AI" row
    // directly below the "Fix with AI" button.
    //
    // Only on the transition, so a developer who opens it again is not
    // overruled by the next state push.
    const runState = (state.progress || {}).state;
    if (runState === "running") byId("workflow").open = true;
    else if (wasRunning) byId("workflow").open = false;
    wasRunning = runState === "running";
  }

  /**
   * Which artifact action each secondary button asks for.
   *
   * The ids are the page's and the actions are the protocol's, and the two are
   * not the same word. Keeping the map here rather than deriving one from the
   * other is what lets `PANEL_ACTIONS` be a closed list the host re-checks.
   */
  const RESULT_ACTIONS = {
    "open-context": "openContext",
    "copy-context": "copyHandoff",
    "open-folder": "openFolder",
  };

  /**
   * The finished package: what it holds, and the one thing to press.
   *
   * Entirely host-decided. `state.contextReady` arriving *is* the signal — a
   * run in flight, a run that failed, and a panel that has never run all leave
   * it absent, so there is no zero-count card and no tick over a failure. The
   * page's whole job here is to fill four lines and show the right buttons.
   */
  function renderContextReady(state) {
    const ready = state.contextReady;
    // What Run does, said until it has been done. Once there is a result or a
    // failure on screen the sentence is advice about a button the developer has
    // already pressed, sitting directly above the proof of what it did.
    byId("run-hint").hidden = Boolean(ready) || Boolean(state.runError);
    byId("context-ready").hidden = !ready;
    if (!ready) {
      // Hidden with it, so a later run that reads no counts cannot inherit the
      // previous one's numbers for a frame.
      for (const id of ["result-counts", "result-strategy", "result-handoff"]) {
        byId(id).hidden = true;
      }
      for (const id of Object.keys(RESULT_ACTIONS)) byId(id).hidden = true;
      // And the files with them, so the previous bug's list cannot outlive the
      // result it belonged to.
      byId("relevant-files").hidden = true;
      byId("relevant-files-list").replaceChildren();
      byId("relevant-files-more").hidden = true;
      byId("retrieval-details").hidden = true;
      byId("retrieval-details-list").replaceChildren();
      return;
    }

    const counts = byId("result-counts");
    counts.textContent = ready.counts || "";
    // Omitted rather than shown empty: neither artifact being readable is not
    // a fact worth a line, and "Context Ready" already said the useful thing.
    counts.hidden = counts.textContent === "";

    const strategy = byId("result-strategy");
    byId("result-strategy-value").textContent = ready.strategy || "";
    strategy.hidden = !ready.strategy;

    // A handoff that started an agent. Present only for that — a skip is
    // explained by the error card, and the button stays for it.
    const outcome = ready.handoffOutcome;
    byId("result-handoff").hidden = !outcome;
    byId("result-handoff-title").textContent = outcome ? outcome.title || "" : "";
    byId("result-handoff-message").textContent = outcome ? outcome.message || "" : "";
    const detail = byId("result-handoff-detail");
    // Which agent, from the host's own record of the launch. The two lines
    // above it name no vendor, and this one is the answer to the obvious next
    // question rather than a claim about what the agent did.
    detail.textContent = outcome && outcome.detail ? outcome.detail : "";
    detail.hidden = detail.textContent === "";

    // Absent after a handoff that worked: a second press would only open a
    // second terminal for the same package.
    byId("fix-with-ai").hidden = ready.canFix !== true;
    // Resolving an agent spawns a probe, so the press is not instant.
    const busy = ready.handoffBusy === true;
    byId("fix-with-ai").disabled = busy;
    byId("fix-with-ai-label").textContent = busy ? "Starting AI fix…" : "Fix with AI";
    byId("fix-with-ai-icon").className = busy
      ? "codicon codicon-loading codicon-spin"
      : "codicon codicon-hubot";

    const available = ready.actions || [];
    for (const [id, action] of Object.entries(RESULT_ACTIONS)) {
      byId(id).hidden = !available.includes(action);
    }

    renderRelevantFiles(ready);
    renderRetrievalDetails(ready);
  }

  /**
   * Which terms the run searched, and how each behaved.
   *
   * Built through `textContent` like every other list here: a search term comes
   * out of a Jira description by way of a JSON file, which is exactly the path
   * a `<script>` would take.
   *
   * The order is the artifact's — strongest term first, as the weighting left
   * them — so nothing sorts or regroups. Nothing here decides anything either:
   * whether a term is broad, what its source is called and where a shape came
   * from were all settled by the host from the artifact's own fields.
   */
  function renderRetrievalDetails(ready) {
    const terms = (ready && ready.terms) || [];
    const section = byId("retrieval-details");
    const list = byId("retrieval-details-list");
    list.replaceChildren();
    section.hidden = terms.length === 0;

    for (const term of terms) {
      const row = document.createElement("div");
      row.className = "term-row";

      const name = document.createElement("p");
      name.className = "term-name";
      name.textContent = term.term;
      row.append(name);

      // Source, then what it found, then whether that was everything. Joined
      // into one line so twenty-eight terms stay scannable.
      const facts = [];
      if (term.source) facts.push(term.source);
      if (term.empty) facts.push("no matches");
      else if (typeof term.lines === "number") {
        // "1 lines" is the kind of detail that makes a panel look unfinished.
        facts.push(`${term.lines} line${term.lines === 1 ? "" : "s"}`);
      }
      // Said plainly rather than coloured: "broad" is not a warning, it is what
      // the repository had to say about the term.
      if (term.broad) facts.push("Broad");
      if (facts.length > 0) {
        const meta = document.createElement("p");
        meta.className = "term-meta";
        meta.textContent = facts.join(" · ");
        row.append(meta);
      }

      // The whole reason this section is worth having: it explains a term the
      // developer never typed.
      if (term.derivedFrom) {
        const origin = document.createElement("p");
        origin.className = "term-origin";
        origin.textContent = `From: ${term.derivedFrom}`;
        row.append(origin);
      }

      list.append(row);
    }
  }

  /**
   * Which files the run found, in the order the artifact ranked them.
   *
   * Built rather than templated, like the notices and the manage list, and
   * every string goes through `textContent`: a path comes off the developer's
   * disk by way of a JSON file, and has no business becoming markup.
   *
   * The order is the artifact's. Nothing here sorts, and the one partition —
   * implementation before prose — keeps each group's relative ranking, because
   * re-ranking in the panel would mean the list and the context disagree about
   * which file matters most.
   */
  function renderRelevantFiles(ready) {
    const files = ready.files || [];
    const section = byId("relevant-files");
    const list = byId("relevant-files-list");
    list.replaceChildren();
    // Hidden rather than shown empty: a "Relevant Files / none" row is a line
    // to read and dismiss, and Context Ready already said how many there were.
    section.hidden = files.length === 0;

    const implementation = files.filter((file) => file.documentation !== true);
    const supporting = files.filter((file) => file.documentation === true);
    // Headings only when there is something to separate. One heading over one
    // group is a label for a distinction the list does not make.
    const grouped = implementation.length > 0 && supporting.length > 0;
    for (const [label, group] of [
      ["Implementation", implementation],
      ["Supporting", supporting],
    ]) {
      if (group.length === 0) continue;
      if (grouped) {
        const heading = document.createElement("p");
        heading.className = "files-group";
        heading.textContent = label;
        list.append(heading);
      }
      for (const file of group) list.append(fileRow(file));
    }

    const more = byId("relevant-files-more");
    more.textContent =
      typeof ready.moreFiles === "number" && ready.moreFiles > 0
        ? `${ready.moreFiles} more in related_files.json`
        : "";
    more.hidden = more.textContent === "";
  }

  /**
   * One file: its name as a button, its path under it, what matched it.
   *
   * The name is the control and the path is description, which is what makes
   * the row usable at 200px — the accessible name is "Open <file>" rather than
   * a path read out character by character, and the full path is the tooltip.
   * Matched terms sit outside the button so they do not lengthen that name.
   */
  function fileRow(file) {
    const row = document.createElement("div");
    row.className = "file-row";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "file-open";
    open.setAttribute("aria-label", `Open ${file.name}`);
    open.setAttribute("title", file.path);

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    const location = document.createElement("span");
    location.className = "file-path";
    location.textContent = file.path;
    open.append(name, location);
    // The path travels back as the host gave it; the host resolves it against
    // the repository and refuses anything that lands outside.
    open.addEventListener("click", () =>
      vscode.postMessage({ type: "openRelevantFile", path: file.path }),
    );

    row.append(open);
    const matched = Array.isArray(file.matched) ? file.matched : [];
    if (matched.length > 0) {
      const terms = document.createElement("p");
      terms.className = "file-matched";
      // Which terms, never how strongly: a weight is how the ranking works.
      terms.textContent = `Matched: ${matched.join(" · ")}`;
      row.append(terms);
    }
    return row;
  }

  /**
   * One failure card, from one host-classified error.
   *
   * Data in, DOM out, and no decisions: which category this is, what it should
   * be called and whether it deserves a button were all settled on the host,
   * where the error code and the operation that produced it are known. A
   * webview asking "does this message contain 401" would be guessing from the
   * least informed position in the system.
   *
   * Every string goes through `textContent`, including the technical detail —
   * that text is a CLI's stderr and a Jira response, which is exactly where a
   * `<script>` would arrive from.
   */
  function renderError(id, error) {
    byId(id).hidden = !error;
    if (!error) {
      // Emptied as well as hidden, so nothing of the previous failure is left
      // to flash into view if the next one renders a frame before its text.
      byId(`${id}-title`).textContent = "";
      byId(`${id}-message`).textContent = "";
      byId(`${id}-detail`).textContent = "";
      byId(`${id}-actions`).replaceChildren();
      byId(`${id}-details`).hidden = true;
      return;
    }

    byId(`${id}-title`).textContent = error.title || "";
    byId(`${id}-message`).textContent = error.message || "";

    const details = byId(`${id}-details`);
    const detail = typeof error.detail === "string" ? error.detail : "";
    byId(`${id}-detail`).textContent = detail;
    details.hidden = detail === "";

    const actions = byId(`${id}-actions`);
    actions.replaceChildren();
    if (error.action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = error.action.title;
      // The command id came from the host, and the host re-checks it against
      // its own table before executing — the same path the blocked card uses.
      button.addEventListener("click", () =>
        vscode.postMessage({ type: "command", id: error.action.command }),
      );
      actions.append(button);
    }
  }

  function renderRun(state) {
    const progress = state.progress || {};
    renderError("failure", state.runError);
    renderError("handoff-error", state.handoffError);
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

    // The button says what it is doing. It is already disabled while a run is
    // in flight — `renderReadiness` does that, and `submit()` refuses a second
    // one regardless — but a greyed button still reading "Run" says the click
    // was ignored rather than that the run is under way.
    byId("run-label").textContent = running ? "Running…" : "Run";
    byId("run-icon").className = running
      ? "codicon codicon-loading codicon-spin"
      : "codicon codicon-play";
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
    // "Improve", not "Improve with AI": it sits under a Guidance heading next
    // to a robot icon, and the third mention of AI in one row was noise. The
    // button's `title` says what it does and with what.
    label.textContent = busy ? "Improving…" : "Improve";
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
    // Since UI-A1 the input source is derived from the Issue field rather than
    // chosen with a radio, so it can change on a keystroke — which is why this
    // is here and not only in the `change` handler below.
    if (event.target && event.target.id === "issue") applySourceVisibility();
    formChanged();
  });

  // Advanced settings holds three of the five growing fields, and none of them
  // could be measured while it was closed. Opening it is the first moment they
  // have a height, so it is where restored text gets sized.
  byId("advanced").addEventListener("toggle", growAll);
  byId("form").addEventListener("change", (event) => {
    const target = event.target;
    if (target && target.id === "plan-buildContext") applyPlanCoupling();
    if (target && target.id === "agent") applyAgentVisibility();
    if (target && target.id === "fixModeId") renderFixModeNote();
    formChanged();
  });

  byId("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  byId("retry").addEventListener("click", () => vscode.postMessage({ type: "retry" }));
  for (const [id, action] of Object.entries(RESULT_ACTIONS)) {
    byId(id).addEventListener("click", () => vscode.postMessage({ type: "action", id: action }));
  }
  // The action the host has handled since phase 5 and nothing on the page ever
  // sent. Hidden until there is a package, so a press can never reach a work
  // item that has nothing to hand over.
  byId("fix-with-ai").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "fixWithAI" }),
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
