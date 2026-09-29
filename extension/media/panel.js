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

  /** The text fields on the Workflow Settings page; the Issue field is the form's own. */
  const SETTINGS_TEXT_FIELDS = TEXT_FIELDS.filter((field) => field !== "issue");

  /**
   * The Workflow Settings page's sections: the `FormState` fields each one
   * holds, and the controls a gear's arrival may focus, first visible one wins.
   *
   * Duplicated from `app/workflowSettings.ts` because a webview cannot import
   * it, and guarded like the other copies: `test/panel.test.ts` compares both.
   * A validation message about a field in a section opens the page there — a
   * message on a page nobody opened is a message nobody sees.
   */
  const SETTINGS_SECTIONS = {
    "issue-details": { fields: ["title", "attachments"], focus: ["title", "add-attachment"] },
    "code-search": {
      fields: ["keywords", "focusFiles", "ignorePaths", "maxFiles", "maxSearchLines"],
      focus: ["keywords"],
    },
    "build-context": { fields: ["fresh"], focus: ["fresh"] },
    "fix-with-ai": {
      fields: ["agent", "agentCommand", "fixModeId", "hint", "useIssueDetails"],
      focus: ["agent"],
    },
  };

  /** Which workflow row's gear opens which section; a row absent here has none. */
  const STEP_SETTINGS = {
    issueDetails: "issue-details",
    codeSearch: "code-search",
    buildContext: "build-context",
    fixWithAI: "fix-with-ai",
  };

  /** The section a form field is edited in, if it is a settings field at all. */
  function sectionOfField(field) {
    return Object.keys(SETTINGS_SECTIONS).find((section) => SETTINGS_SECTIONS[section].fields.includes(field));
  }

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
    // No glyph, on purpose: the green tick is for a handoff that started, and
    // the button on the row is what says there is something to press.
    ready: { icon: "", spin: false, word: "ready" },
    failed: { icon: "error", spin: false, word: "failed" },
    skipped: { icon: "circle-slash", spin: false, word: "skipped" },
  };

  const byId = (id) => document.getElementById(id);

  /** Every row, for wiring each row's artifact link once at load. */
  const STEP_IDS_FOR_ARTIFACTS = {
    issueDetails: true,
    codeSearch: true,
    gitHistory: true,
    similarFixes: true,
    buildContext: true,
    fixWithAI: true,
    fixResult: true,
  };

  let appliedRevision = -1;
  let running = false;
  /**
   * The settings as last applied — what the form means, whatever the Workflow
   * Settings page shows.
   *
   * The page's controls are a draft while it is open: nothing typed there is
   * read into a run, a form change or a press until Apply copies it here and
   * sends the whole form to the host. Cancel and Back write this back over the
   * draft. While the page is closed its controls hold exactly this.
   */
  let committed = {
    title: "",
    hint: "",
    keywords: "",
    focusFiles: "",
    ignorePaths: "",
    maxFiles: "",
    maxSearchLines: "",
    agentCommand: "",
    agent: "auto",
    fixModeId: "",
    attachments: [],
    fresh: false,
    useIssueDetails: true,
  };
  /** Whether the Workflow Settings page is the view on screen (or under a Fix Mode view). */
  let settingsOpen = false;
  /** The control that opened the page, where focus goes back to. */
  let settingsOrigin;
  let highlightTimer;
  /** The last attachment-dialog answer taken, so it is taken once. */
  let attachmentPickToken;
  /** The hint suggestion on screen, for Use Improved to put into the draft. */
  let hintSuggestion = "";
  /**
   * The attached paths the settings page shows — the draft's list.
   *
   * A list rather than an input, so it lives here and is rendered rather than
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
  /** The Fix Mode problem already revealed, so the section opens once per problem. */
  let shownFixModeProblem = "";
  /** The coupled checkboxes as they were before Build context forced them off. */
  let planBeforeCoupling;
  /**
   * Whether the last render saw a run in flight.
   *
   * Only used to notice the moment one *starts*, which is when the workflow
   * opens itself. It no longer folds when the run ends: since Batch 6 the rows
   * are the result, so folding them would hide what the run just produced.
   */
  let wasRunning = false;
  /**
   * Whether the last render had a failure card to show.
   *
   * Every card — the run's, a row's, the handoff's — lives inside the
   * workflow, so a card appearing opens it once, like a run starting: a Set
   * Jira Credentials button nobody can see is a button that does nothing.
   */
  let hadCard = false;
  /**
   * The work item the workflow last opened itself for.
   *
   * A different work item with results — one reopened from History, or the one
   * a reloaded panel restores — opens the workflow once, like a run starting.
   * Once, so a developer who collapses it is not overruled by the next push.
   */
  let shownWorkItem;
  /**
   * Each row's artifact, as the host last named it.
   *
   * The link sends a plain file name back and the host re-checks it — the same
   * constrained `openArtifact` path the artifact tree uses, never a path.
   */
  const rowArtifacts = {};
  /** The Validation checklist as last rendered, so opening it knows whether to ask. */
  let validationState;
  /** Which work item's checklist the disclosure belongs to. */
  let validationWorkItem;
  /** What the checklist body last showed, so an unchanged push leaves it alone. */
  let validationSignature = "";
  /** What Review with AI's status and card last showed, for the same reason. */
  let reviewSignature = "";
  // Record Review Result (Batch 11): which work item the form was opened for,
  // whether the host was recording at the last push, and what the Review Result
  // lines and the recording's status last said — so a push that changes nothing
  // rewrites nothing, and the live region does not repeat itself.
  let reviewEditorWorkItem;
  let wasRecorded = false;
  let reviewResultSignature = "";
  let captureStatus = "";
  let captureError = "";
  /** The form's four text areas, in the order they are written to the report. */
  const REVIEW_FIELDS = ["review-summary", "review-findings", "review-validation-notes", "review-recommendations"];
  // Paste Review Output: the last host answer the form was filled from, so a
  // later push does not fill it again, and the paste box's own controls, which
  // the panel's form handlers leave alone.
  let reviewPrefillToken;
  const PASTE_CONTROLS = ["review-paste-text", "parse-review-output", "cancel-review-paste"];
  /** Neutral about the source: BugPilot knows only that the text was pasted in the review's shape. */
  const PREFILL_NOTE = "Prefilled from structured review output — review before saving.";
  /** When BugPilot ran the reviewer and read its reply itself, it can say so. */
  const PREFILL_NOTE_AI = "Prefilled from AI review — review before saving.";
  const PREFILL_LEFT_OUT = " Text before the first section was left out.";
  const PREFILL_READY = "Review result ready to save.";
  // Verification Evidence (Batch 12): the same bookkeeping, and the form's rows.
  // Each row is the page's own — built here, read on Save — so what is typed
  // survives every push until Cancel, another work item or a recorded save.
  let verificationEditorWorkItem;
  let wasVerificationRecorded = false;
  let verificationResultSignature = "";
  let verificationStatus = "";
  let verificationError = "";
  /** Whether the open form replaces a recorded report (Edit) or records the first one. */
  let verificationMode = "record";
  /** The last Edit answer the form was filled from, so a later push does not refill it. */
  let verificationEditToken;
  /** One entry per check row: its group and its controls. */
  let verificationRows = [];
  /** Unique within the page, so each row's labels point at its own controls. */
  let verificationRowSerial = 0;
  /** The CLI's caps, so the form says so before a process starts. */
  const MAX_VERIFICATION_CHECKS = 25;
  const MAX_CHECK_NAME = 200;
  const CHECK_STATUSES = [
    ["not_run", "Not Run"],
    ["passed", "Passed"],
    ["failed", "Failed"],
  ];
  const CHECK_TYPES = [
    ["automated", "Automated"],
    ["manual", "Manual"],
    ["other", "Other"],
  ];
  const CHECK_TEXT_FIELDS = [
    ["procedure", "Command / Procedure"],
    ["evidence", "Evidence"],
    ["notes", "Notes"],
  ];
  /** One line under each field on what goes in it: what was done and seen, never a verdict. */
  const CHECK_HINTS = {
    name: "What was checked.",
    status: "The status you are recording for this check.",
    type: "Automated, Manual or Other.",
    procedure: "The command you ran or the manual steps you followed.",
    evidence: "The observed output or result supporting the recorded status.",
    notes: "Optional limitations or context.",
  };
  /** Examples as placeholders only: shown in an empty field, never saved. */
  const CHECK_PLACEHOLDERS = {
    name: "e.g. Targeted unit tests, or Original bug reproduction",
    procedure: "e.g. npm test, or Repeat the reported workflow manually",
    evidence: "e.g. 1285 passed, 0 failed, or The issue no longer reproduces",
  };
  /** The form's own buttons, which the panel's form handlers leave alone. */
  const VERIFICATION_CONTROLS = ["add-verification-check", "save-verification", "cancel-verification"];

  /**
   * The primary action as the host last described it (`app/nextAction.ts`).
   *
   * The page never works out what the button should say: it shows the host's
   * label and, when pressed, sends the host's action back with the form, and
   * the host acts only if its answer for that form is still the same. Before
   * the first push it is Run, which is what the markup says.
   */
  let primary = { action: "run", label: "Run", enabled: true, busy: false, hint: "", more: [] };
  /** The icon beside each primary label; busy is a spinner whatever the action. */
  const PRIMARY_ICONS = { run: "play", fixWithAI: "hubot", openSession: "terminal", rebuildContext: "refresh" };
  /** The ⋯ menu's items, in the markup's order. */
  const MORE_ITEMS = ["startNewAttempt", "rebuildContext", "openSession"];
  // Start New Attempt's form: which work item it was opened for, whether the
  // host was starting an attempt at the last push, the failure last shown and
  // the last helper answer taken — so a push that changes nothing rewrites
  // nothing, and a helper's text is added once.
  let attemptEditorWorkItem;
  let attemptWasStarting = false;
  let attemptError = "";
  let attemptDraftToken;
  /** The form's own controls, which the panel's form handlers leave alone. */
  const ATTEMPT_CONTROLS = [
    "attempt-feedback",
    "cancel-attempt",
    "start-attempt",
    "use-review-findings",
    "use-verification-evidence",
  ];

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
   * for Hint and Keywords, which live on the Workflow Settings page: a field in
   * a hidden view has no layout, and every height read from it is zero. That
   * case leaves `height: auto` in place — the right height for when the page is
   * opened — and waits to be called again.
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

  /** The form as it means now: the form's own controls, and the applied settings. */
  function readForm() {
    return formWith(committed);
  }

  /**
   * The form with the settings page's draft instead — what the page shows, for
   * the one question asked about a draft: improving the hint on screen.
   */
  function draftForm() {
    return formWith(readSettings());
  }

  function formWith(settings) {
    const issue = byId("issue").value;
    const source = issueSource();
    const form = { source, plan: {}, ...settings, attachments: [...settings.attachments] };
    // The one box, split into the two fields the host and the CLI expect. The
    // unused one is cleared rather than left behind: a stale description under
    // a Jira key would reach `--description` the moment the key was deleted.
    form.issueKey = source === "jira" ? issue.trim() : "";
    form.description = source === "manual" ? issue : "";
    for (const field of PLAN_FIELDS) form.plan[field] = byId(`plan-${field}`).checked;
    form.plan.issueDetails = true;
    // Not part of the plan: it is what happens after the run, not a flag on it.
    form.fixWithAI = byId("plan-fixWithAI").checked;
    return form;
  }

  /** The settings page's controls, as they stand. */
  function readSettings() {
    const settings = {};
    for (const field of SETTINGS_TEXT_FIELDS) settings[field] = byId(field).value;
    settings.agent = byId("agent").value || "auto";
    settings.fixModeId = byId("fixModeId").value || "";
    settings.attachments = [...attachments];
    settings.fresh = byId("fresh").checked;
    // Gates what the hint improver may read. Not a run flag.
    settings.useIssueDetails = byId("useIssueDetails").checked;
    return settings;
  }

  /** The applied settings, out of a whole form. */
  function settingsOf(form) {
    const settings = {};
    for (const field of SETTINGS_TEXT_FIELDS) settings[field] = form[field] ?? "";
    settings.agent = form.agent ?? "auto";
    settings.fixModeId = form.fixModeId ?? "";
    settings.attachments = Array.isArray(form.attachments) ? [...form.attachments] : [];
    settings.fresh = form.fresh === true;
    settings.useIssueDetails = form.useIssueDetails !== false;
    return settings;
  }

  /** Put settings into the page's controls: the applied ones, or back over a draft. */
  function writeSettings(settings) {
    for (const field of SETTINGS_TEXT_FIELDS) byId(field).value = settings[field] ?? "";
    byId("agent").value = settings.agent ?? "auto";
    // After renderFixModes has put the options there — a value that is not one
    // of them is dropped by the element, which is why the order matters.
    byId("fixModeId").value = settings.fixModeId ?? "";
    attachments = [...settings.attachments];
    renderAttachments();
    byId("fresh").checked = settings.fresh === true;
    byId("useIssueDetails").checked = settings.useIssueDetails !== false;
    applyAgentVisibility();
    renderFixModeNote();
  }

  function writeForm(form) {
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
    // The host's form is the applied settings now — and, if the settings page
    // is open, what it shows: a form the host replaced (another work item, a
    // mode it restored) supersedes a draft of the one before.
    committed = settingsOf(form);
    writeSettings(committed);
    // As the selector took it: a mode with no option yet (a catalog still
    // loading) is no mode, as it always was for a run.
    committed.fixModeId = byId("fixModeId").value || "";
    renderStrategySummary();
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
   * beside a ticket number is a field that does nothing. It lives on the
   * Workflow Settings page, which is why this can follow what is typed without
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
        // The draft's list: the form changes on Apply, not here.
        attachments = attachments.filter((entry) => entry !== path);
        renderAttachments();
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
    // The same for the primary action: Start New Attempt's form, rendered with
    // the workflow, asks whether a new attempt is on offer.
    primary = state.primary || {
      action: "run",
      label: running ? "Running…" : "Run",
      enabled: !running,
      busy: running,
      hint: "",
      more: [],
    };

    // Before the form is written: `writeForm` sets the select's value, and a
    // <select> silently drops a value that has no option yet.
    renderFixModeOptions(state);

    if (typeof state.revision === "number" && state.revision !== appliedRevision && state.form) {
      // The host's form supersedes a change still waiting on the debounce: sent
      // after this, that snapshot of the old form would overwrite the host's copy
      // and the two would disagree about which work item the field names.
      clearTimeout(changeTimer);
      writeForm(state.form);
      appliedRevision = state.revision;
      persist(state.form);
    }

    renderReadiness(state.readiness);
    renderProblems(state.problems || []);
    // After the form: the note describes whichever mode the select ended on.
    renderFixModes(state);
    renderStrategySummary();
    renderWorkflow(state);
    renderRun(state);
    renderRunHint(state);
    // Outside the result on purpose: whether this is the environment the
    // developer thinks it is has nothing to do with whether a run succeeded.
    renderDiagnostics(state);
    renderNotices(state);
    renderManage(state);
    renderSettings(state);
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
      // The selector fell back to what the catalog allows. While the settings
      // page is closed its controls are the applied settings, so the applied
      // mode follows — Run sends what the closed page would show. An open page's
      // draft is only a draft.
      if (!settingsOpen) committed.fixModeId = select.value || "";
    }
    fixModesReady = catalog.kind === "ready";
    fixModeCatalog = catalog;
  }

  /** The note under the selector, once the form has settled on a selection. */
  function renderFixModes(state) {
    const problem = (state.problems || []).find((entry) => entry.field === "fixModeId");
    renderFixModeNote(problem);
    // The selector is on the Workflow Settings page, which may be closed: a
    // problem with the chosen mode opens it once and lands on the selector, like
    // a problem in any field there.
    const signature = problem ? problem.message : "";
    if (signature && signature !== shownFixModeProblem) openSettings("fix-with-ai", undefined, "fixModeId");
    shownFixModeProblem = signature;
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
   * The line beside Workflow Settings that names a non-default Fix Mode.
   *
   * The applied mode, never the selector's draft: it says what Run will use.
   * Nothing for the default the CLI declared — the ordinary case adds no text —
   * and nothing when there is no catalog, because then Run sends no mode at all.
   */
  function renderStrategySummary() {
    const catalog = fixModeCatalog || { kind: "loading" };
    const selected =
      catalog.kind === "ready" ? catalog.modes.find((mode) => mode.id === committed.fixModeId) : undefined;
    const name =
      catalog.kind === "ready" && selected && selected.id !== catalog.defaultModeId
        ? selected.name || selected.id
        : "";
    const label = byId("settings-strategy");
    byId("settings-strategy-name").textContent = name;
    label.setAttribute("title", name ? `Fix Mode: ${name}` : "");
    label.hidden = name === "";
    byId("settings-strategy-description").textContent = name ? `Fix Mode: ${name}` : "";
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
      // A problem in a settings field is shown where that field is, so the page
      // opens there; one on the Issue field is on the form.
      const section = sectionOfField(first.field);
      if (section) openSettings(section, undefined, controlFor(first.field));
      else byId(controlFor(first.field)).focus();
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
      // "Not chosen" only greys a row that has not happened: a Fix with AI row
      // that is ready or was handed over is part of the run, ticked or not.
      const off = !step.enabled && step.status === "idle";
      row.className = `step step-${step.status}${off ? " step-off" : ""}`;
      row.setAttribute(
        "aria-label",
        `${step.label}: ${
          step.enabled || step.status !== "idle" ? step.statusLabel || meta.word : "not selected"
        }`,
      );

      const status = byId(`status-${step.id}`);
      status.hidden = meta.icon === "";
      status.className = meta.icon
        ? `step-status codicon codicon-${meta.icon}${meta.spin ? " codicon-spin" : ""}`
        : "step-status codicon";
      byId(`duration-${step.id}`).textContent =
        typeof step.durationMs === "number" ? formatDuration(step.durationMs) : "";

      // The secondary line, for the state the row is in: what it does while
      // pending, what it is doing while running, what it produced once done.
      byId(`description-${step.id}`).textContent = step.summary || step.description || "";
      // "Always runs" is plan information: once the row has run, it is noise.
      const note = document.getElementById(`note-${step.id}`);
      if (note) note.hidden = step.status !== "idle";

      const detail = byId(`detail-${step.id}`);
      detail.textContent = step.detail || "";
      detail.hidden = detail.textContent === "";

      // The artifact the row owns, as a quiet link — a file name, never a path.
      rowArtifacts[step.id] = step.artifact || "";
      byId(`artifact-${step.id}-name`).textContent = rowArtifacts[step.id];
      const artifact = byId(`artifact-${step.id}`);
      artifact.hidden = rowArtifacts[step.id] === "";
      artifact.setAttribute("title", rowArtifacts[step.id] ? `Open ${rowArtifacts[step.id]}` : "");

      // What the step's applied settings are, where it has settings: the host's
      // line, counts and names only.
      const settingsSummary = document.getElementById(`settings-summary-${step.id}`);
      if (settingsSummary) {
        settingsSummary.textContent = step.settingsSummary || "";
        settingsSummary.hidden = settingsSummary.textContent === "";
      }

      // Fix result has no card: a report that cannot be previewed is not a failure.
      if (document.getElementById(`error-${step.id}`)) renderError(`error-${step.id}`, step.error);
    }

    const byStep = Object.fromEntries(steps.map((step) => [step.id, step]));
    renderSearch(byStep.codeSearch);
    renderStepActions(byStep.buildContext, byStep.fixWithAI);
    renderAttempt(byStep.fixWithAI, state.workItemId);
    renderFixResult(byStep.fixResult, state.workItemId);

    const overall = state.overall || { kind: "idle", text: "" };
    const status = byId("workflow-status");
    status.textContent = overall.text;
    status.className = `workflow-status is-${overall.kind}`;
    byId("activity").textContent = (state.progress || {}).activity || "";

    // The work item's own action, at the foot of the workflow.
    const workItemActions = state.workItemActions || [];
    byId("open-folder").hidden = !workItemActions.includes("openFolder");

    // Opened when a run starts, and kept open when it ends: the rows are where
    // its results are now. Only on the transition, so a developer who collapses
    // it — during a run or after one — is not overruled by the next push.
    const runState = (state.progress || {}).state;
    const nowRunning = runState === "running";
    if (nowRunning && !wasRunning) byId("workflow").open = true;
    if (state.workItemId !== shownWorkItem) {
      // A different work item arriving with results: once, like a run starting.
      if (state.workItemId && !nowRunning && overall.kind !== "idle") byId("workflow").open = true;
      shownWorkItem = state.workItemId;
    }
    // Review with AI's card counts too: it answers a press made inside the
    // workflow, which may have been collapsed while the handoff started.
    const hasCard =
      Boolean(state.runError) ||
      steps.some((step) => Boolean(step.error) || Boolean(step.review && step.review.state === "failed"));
    if (hasCard && !hadCard) byId("workflow").open = true;
    wasRunning = nowRunning;
    hadCard = hasCard;
  }

  /**
   * What Build context offers, and the mode Fix with AI's task was prepared with.
   *
   * The buttons are the host's decision: each is shown only when its row lists
   * the action, which is only once the file it acts on exists. Fix with AI has
   * no button of its own any more — handing over is the primary action, at the
   * top — only its Strategy line and, once an attempt exists, the form below.
   */
  function renderStepActions(build, fix) {
    const buildActions = (build && build.actions) || [];
    let anyBuildAction = false;
    for (const [id, action] of Object.entries(RESULT_ACTIONS)) {
      if (id === "open-folder") continue;
      byId(id).hidden = !buildActions.includes(action);
      anyBuildAction = anyBuildAction || !byId(id).hidden;
    }
    // The containers hide with their contents, so an empty one adds no space.
    byId("actions-buildContext").hidden = !anyBuildAction;

    const strategy = byId("strategy-fixWithAI");
    byId("strategy-fixWithAI-value").textContent = (fix && fix.strategy) || "";
    strategy.hidden = !(fix && fix.strategy);
  }

  /**
   * Start New Attempt's form, under Fix with AI.
   *
   * The page's, like Record Review Result's: the ⋯ menu's Start New Attempt
   * opens it, and Cancel, an attempt the host answered, or another work item
   * closes it — the last two emptying it, so B never inherits feedback typed
   * for A. Start Attempt only asks; the host decides whether a new attempt may
   * start, writes user_feedback.md for typed feedback, and hands over.
   *
   * The helpers are shown only while the host lists them — a recorded review,
   * a recorded check that did not pass — and add text only when pressed.
   */
  function renderAttempt(step, workItemId) {
    const attempt = step ? step.attempt : undefined;
    const starting = Boolean(attempt && attempt.state === "starting");
    const failed = Boolean(attempt && attempt.state === "failed");
    const hadFocus = ATTEMPT_CONTROLS.some((id) => byId(id) === document.activeElement);

    if (workItemId !== attemptEditorWorkItem) {
      closeAttemptEditor(true);
      attemptWasStarting = false;
    }
    attemptEditorWorkItem = workItemId;
    // Closed and emptied only on the host's own word that the press was
    // answered — starting, then not, with an outcome on the row. A start that
    // stopped being tracked (a run began) may not have happened, and what was
    // typed is kept.
    const answered =
      attemptWasStarting && !starting && !failed && Boolean(step && (step.status === "success" || step.error));
    attemptWasStarting = starting;
    if (answered) {
      closeAttemptEditor(true);
      // The form a keyboard user was in has gone: the primary action — now Open
      // AI Session — is where the next step is.
      if (hadFocus) byId("run").focus({ preventScroll: true });
    }

    const offered = primary.enabled && (primary.more || []).includes("startNewAttempt");
    // `aria-disabled`, as on Save Review Result: a keyboard user who pressed
    // Start keeps the focus while the host works, and the handler refuses.
    const start = byId("start-attempt");
    start.setAttribute("aria-disabled", starting || !offered ? "true" : "false");
    start.setAttribute("aria-busy", starting ? "true" : "false");
    byId("start-attempt-label").textContent = starting ? "Starting…" : "Start Attempt";
    byId("cancel-attempt").setAttribute("aria-disabled", starting ? "true" : "false");

    const helpers = (step && step.feedbackHelpers) || [];
    byId("use-review-findings").hidden = !helpers.includes("useReviewFindings");
    byId("use-verification-evidence").hidden = !helpers.includes("useVerificationEvidence");
    byId("attempt-helpers").hidden = helpers.length === 0;

    // A helper's answer, taken once: added under what is already typed, never
    // in place of it.
    const draft = step ? step.attemptDraft : undefined;
    if (draft && draft.token !== attemptDraftToken && !byId("attempt-editor").hidden) {
      attemptDraftToken = draft.token;
      const field = byId("attempt-feedback");
      const typed = field.value.replace(/\s+$/, "");
      field.value = typed === "" ? draft.text : `${typed}\n\n${draft.text}`;
    }

    const message = failed ? attempt.message || "" : "";
    if (message !== attemptError) {
      attemptError = message;
      const error = byId("attempt-error");
      // Shown before it is filled, like the review form's failure.
      error.hidden = message === "";
      error.textContent = message;
    }
  }

  /** Open Start New Attempt's form, where it can be seen, at the feedback. */
  function openAttemptEditor() {
    // Inside the workflow, which may be collapsed.
    byId("workflow").open = true;
    byId("attempt-editor").hidden = false;
    byId("attempt-feedback").focus({ preventScroll: true });
    scrollIntoView(byId("attempt-editor"), "nearest");
  }

  /** Close the form; `clear` empties it too, and forgets its failure. */
  function closeAttemptEditor(clear) {
    byId("attempt-editor").hidden = true;
    if (!clear) return;
    byId("attempt-feedback").value = "";
    attemptError = "";
    byId("attempt-error").hidden = true;
    byId("attempt-error").textContent = "";
  }

  /** Start Attempt: the feedback as typed, and the form, for the host to judge. */
  function startAttempt() {
    const start = byId("start-attempt");
    if (byId("attempt-editor").hidden || start.getAttribute("aria-disabled") === "true") return;
    // The press carries the form, so the change waiting on the debounce is
    // not sent after it with an older snapshot.
    clearTimeout(changeTimer);
    const form = readForm();
    persist(form);
    vscode.postMessage({ type: "startAttempt", feedback: byId("attempt-feedback").value, form });
  }

  /**
   * The Fix result row, which exists only while the host's workflow has it.
   *
   * Absent, it is hidden and emptied — its link and button forget the file, so
   * a work item without a report can never open the last one's.
   */
  function renderFixResult(step, workItemId) {
    byId("step-fixResult").hidden = !step;
    const actions = (step && step.actions) || [];
    const opens = Boolean(step && actions.includes("openFixReport") && rowArtifacts.fixResult);
    const copies = Boolean(step && actions.includes("copyReviewPrompt"));
    // Review with AI: pressable when offered, shown but waiting while its
    // handoff starts, and gone once one started — a second press would be a
    // second reviewer for the same report.
    const review = step ? step.review : undefined;
    const reviewing = Boolean(review && review.state === "starting");
    const reviewButton = byId("review-with-ai");
    const hadFocus = document.activeElement === reviewButton;
    byId("open-fix-report").hidden = !opens;
    byId("copy-review-prompt").hidden = !copies;
    reviewButton.hidden = !(step && (actions.includes("reviewWithAI") || reviewing));
    renderReviewResult(step, workItemId);
    renderVerification(step, workItemId);
    byId("actions-fixResult").hidden =
      !opens &&
      !copies &&
      reviewButton.hidden &&
      byId("paste-review-output").hidden &&
      byId("record-review-result").hidden &&
      byId("record-verification").hidden;
    // Waiting for the CLI: one press at a time, and said in words.
    const copying = Boolean(step && step.copyingReviewPrompt);
    byId("copy-review-prompt").disabled = copying;
    byId("copy-review-prompt").setAttribute("aria-busy", copying ? "true" : "false");
    byId("copy-review-prompt-label").textContent = copying ? "Copying…" : "Copy Review Prompt";
    // `aria-disabled`, not `disabled`: Chromium moves the focus off a control
    // the moment it is disabled, so a keyboard user who pressed it would land
    // on the document before the reviewer even started. Announced as
    // unavailable all the same, and the click handler and the host both refuse.
    reviewButton.setAttribute("aria-disabled", reviewing ? "true" : "false");
    reviewButton.setAttribute("aria-busy", reviewing ? "true" : "false");
    byId("review-with-ai-label").textContent = reviewing ? "Starting AI review…" : "Review with AI";
    renderReview(step);
    // The button a keyboard user just pressed has gone, because the reviewer
    // started: the status saying so is the natural next place, rather than the
    // top of the document. Only then — never on an ordinary push.
    if (hadFocus && reviewButton.hidden && review && (review.state === "started" || review.state === "reviewing")) {
      byId("review-status").focus({ preventScroll: true });
    }
    // The lines are clamped on screen; the whole bounded line is the hover.
    byId("description-fixResult").setAttribute("title", step ? step.summary || "" : "");
    byId("detail-fixResult").setAttribute("title", step ? step.detail || "" : "");
    renderValidation(step, workItemId);
    if (step) return;
    rowArtifacts.fixResult = "";
    byId("artifact-fixResult").hidden = true;
    byId("artifact-fixResult-name").textContent = "";
    byId("description-fixResult").textContent = "";
    byId("detail-fixResult").textContent = "";
    byId("detail-fixResult").hidden = true;
  }

  /**
   * Fix result's Validation checklist: collapsed, loaded when first opened.
   *
   * Guidance the CLI builds from the report and retrieval.json — never a result,
   * so no item carries a tick or a colour. Every line is text. A different work
   * item closes it, so B never opens on A's list.
   */
  function renderValidation(step, workItemId) {
    const disclosure = byId("validation-checklist");
    disclosure.hidden = !step;
    if (!step || workItemId !== validationWorkItem) disclosure.open = false;
    validationWorkItem = step ? workItemId : undefined;
    validationState = step ? step.validation : undefined;

    // Rebuilt only when what it says changed. The body is a live region, so a
    // rebuild on every push — a Copy press, a progress event — would read the
    // whole list out again and take focus off Retry or Load.
    const signature = step ? JSON.stringify([workItemId, validationState || null]) : "";
    if (signature === validationSignature) return;
    validationSignature = signature;

    const body = byId("validation-body");
    body.replaceChildren();
    const view = validationState;
    if (!step) return;
    if (!view) {
      // Not asked for yet: opening the disclosure asks. Shown only if it is
      // open without a list — after the folder was read again, say.
      body.append(validationButton("Load checklist"));
      return;
    }
    if (view.state === "loading") {
      body.append(line("p", "muted", "Loading…"));
      return;
    }
    if (view.state === "failed") {
      body.append(line("p", "error", `Validation checklist unavailable: ${view.message}`));
      body.append(validationButton("Retry"));
      return;
    }
    const checklist = view.checklist || { steps: [], files: [], risks: [] };
    const steps = document.createElement("ol");
    steps.className = "validation-steps";
    for (const item of checklist.steps || []) steps.append(line("li", "", item));
    body.append(steps);
    const files = checklist.files || [];
    const risks = checklist.risks || [];
    if (files.length > 0 || risks.length > 0) {
      body.append(line("p", "validation-heading", "Regression areas"));
      const areas = document.createElement("ul");
      areas.className = "validation-areas";
      for (const file of files) areas.append(line("li", "validation-file", file));
      for (const risk of risks) areas.append(line("li", "", risk));
      body.append(areas);
    }
    if (checklist.moreRisks) {
      body.append(line("p", "muted", `${checklist.moreRisks} more in fix_report.md`));
    }
  }

  /**
   * What Review with AI did, under the row's actions: that a reviewer started
   * and with which agent, or the card saying why none did.
   *
   * Neutral words and no tick: a reviewer starting is not a review finishing,
   * let alone passing. Rebuilt only when what it says changed — the status is a
   * live region and the card an alert, so rewriting them on every push would
   * announce the same thing again on each progress event.
   */
  function renderReview(step) {
    const review = step ? step.review : undefined;
    const signature = review ? JSON.stringify(review) : "";
    if (signature === reviewSignature) return;
    reviewSignature = signature;
    const status = byId("review-status");
    status.replaceChildren();
    // Every state but starting and failed has the host's words: started (a
    // terminal), reviewing, captured, a capture that gave no draft, or an
    // attempt an earlier session made. Text only — never a tick or a verdict.
    const said = review && review.state !== "starting" && review.state !== "failed";
    status.setAttribute("aria-busy", review && review.state === "reviewing" ? "true" : "false");
    if (said) {
      status.append(line("p", "review-status-title", review.summary || ""));
      if (review.detail) status.append(line("p", "muted review-status-detail", review.detail));
      if (review.next) status.append(line("p", "muted review-status-detail", review.next));
    }
    renderError("review-error", review && review.state === "failed" ? review.error : undefined);
    // A capture that gave no draft but had a reply: put it where it can be fixed
    // and parsed — never over something already typed there.
    if (review && review.state === "captureFailed" && typeof review.reply === "string") {
      const box = byId("review-paste-text");
      if (box.value.trim() === "") box.value = review.reply;
      if (!byId("paste-review-output").hidden) {
        byId("review-paste").hidden = false;
        byId("paste-review-output").setAttribute("aria-expanded", "true");
      }
    }
  }

  /**
   * Review Result, its form and Paste Review Output (Batch 11).
   *
   * The lines are the host's: "Review result saved", then the reviewer's own
   * first lines — never a verdict, because none is known. The form is the page's:
   * Add (or Replace) opens it, and Cancel, a save that finished, or another work
   * item closes it — the last two emptying it, so B never inherits what was
   * typed for A. Paste Review Output's Parse asks the host to read the pasted
   * reply; its answer, once per token, either says why it could not be read or
   * fills the form and says so — prefilled is never saved. Save only asks; the
   * host decides whether a save may start, asks before replacing, and runs
   * record-review.
   */
  function renderReviewResult(step, workItemId) {
    const actions = (step && step.actions) || [];
    const result = step ? step.reviewResult : undefined;
    const capture = step ? step.reviewCapture : undefined;
    const recording = Boolean(capture && capture.state === "recording");
    const failed = Boolean(capture && capture.state === "failed");
    const recorded = Boolean(capture && capture.state === "recorded");
    const offered = actions.includes("recordReviewResult") || actions.includes("replaceReviewResult");
    const editor = byId("review-editor");
    // Checked by id rather than `contains`: the form's own controls are the only
    // places a keyboard user can be inside it.
    const hadFocus = [...REVIEW_FIELDS, "save-review-result", "cancel-review-result"].some(
      (id) => byId(id) === document.activeElement,
    );

    const anotherItem = !step || workItemId !== reviewEditorWorkItem;
    if (anotherItem) {
      closeReviewEditor(true);
      closeReviewPaste(true);
      captureStatus = "";
      captureError = "";
      byId("review-capture-status").textContent = "";
    }
    reviewEditorWorkItem = step ? workItemId : undefined;
    // Only the host's own word that it recorded closes and empties the form: a
    // recording that stopped being tracked — a run started — may have failed, and
    // what was typed is kept.
    const finished = !anotherItem && recorded && !wasRecorded;
    wasRecorded = recorded;
    if (finished) closeReviewEditor(true);

    // Paste Review Output's answer, acted on once: the reason it could not be
    // read, or the form filled from it — for the developer to check and save.
    const prefill = step ? step.reviewPrefill : undefined;
    if (step && prefill && prefill.token !== reviewPrefillToken) {
      reviewPrefillToken = prefill.token;
      applyReviewPrefill(prefill);
    }

    const pasting = !byId("review-paste").hidden;
    const paste = byId("paste-review-output");
    paste.hidden = !(step && (actions.includes("pasteReviewOutput") || pasting));
    paste.setAttribute("aria-expanded", pasting ? "true" : "false");
    // Not while a save is in flight: the form it would fill is being saved.
    byId("parse-review-output").setAttribute(
      "aria-disabled",
      recording || !actions.includes("pasteReviewOutput") ? "true" : "false",
    );

    const open = !editor.hidden;
    const record = byId("record-review-result");
    record.hidden = !(step && !result && (actions.includes("recordReviewResult") || open || recording));
    record.setAttribute("aria-expanded", open ? "true" : "false");
    const replace = byId("replace-review-result");
    replace.hidden = !(result && (actions.includes("replaceReviewResult") || open || recording));
    replace.setAttribute("aria-expanded", open ? "true" : "false");

    // `aria-disabled`, as on Review with AI: a keyboard user who pressed Save
    // keeps the focus while the host records, and the handler and host refuse.
    const save = byId("save-review-result");
    save.setAttribute("aria-disabled", recording || !offered ? "true" : "false");
    save.setAttribute("aria-busy", recording ? "true" : "false");
    byId("save-review-result-label").textContent = recording ? "Saving…" : "Save Review Result";
    byId("cancel-review-result").setAttribute("aria-disabled", recording ? "true" : "false");

    byId("review-result").hidden = !result;
    byId("open-review-report").hidden = !(result && actions.includes("openReviewReport"));
    const signature = result ? JSON.stringify([workItemId, result]) : "";
    if (signature !== reviewResultSignature) {
      reviewResultSignature = signature;
      byId("review-result-status").textContent = result ? result.status : "";
      const summary = byId("review-result-summary");
      summary.textContent = result ? result.summary : "";
      summary.setAttribute("title", result ? result.summary : "");
      const detail = byId("review-result-detail");
      detail.textContent = result && result.detail ? result.detail : "";
      detail.setAttribute("title", result && result.detail ? result.detail : "");
      detail.hidden = !(result && result.detail);
      const also = byId("review-result-also");
      also.textContent = result && result.alsoRecorded ? result.alsoRecorded : "";
      also.hidden = !(result && result.alsoRecorded);
    }

    // The saving's status, said once per change: saving, then saved — which
    // stays until something else happens — or, while the form holds a pasted
    // review not yet saved, that it is ready to save. Never "passed".
    let status = "";
    if (recording) status = "Saving review result…";
    else if (recorded) status = capture.replaced ? "Review result replaced." : "Review result saved.";
    else if (!byId("review-prefill-note").hidden) status = PREFILL_READY;
    if (status !== captureStatus) {
      captureStatus = status;
      byId("review-capture-status").textContent = status;
    }
    const message = failed ? capture.message || "" : "";
    if (message !== captureError) {
      captureError = message;
      const error = byId("review-capture-error");
      // Shown before it is filled: some screen readers announce an alert whose
      // text is inserted, not one that is merely revealed.
      error.hidden = message === "";
      error.textContent = message;
    }
    // The form a keyboard user was in has closed because the recording
    // finished: the status saying so is the natural next place (focusable, and
    // present before the re-read file brings the result's own lines).
    if (finished && hadFocus) byId("review-capture-status").focus({ preventScroll: true });
  }

  /** Close the form; `clear` empties it too, and forgets that it was prefilled. */
  function closeReviewEditor(clear) {
    byId("review-editor").hidden = true;
    if (!clear) return;
    for (const id of REVIEW_FIELDS) byId(id).value = "";
    const note = byId("review-prefill-note");
    note.hidden = true;
    note.textContent = "";
  }

  /** Close the paste box; `clear` empties it and its failure too. */
  function closeReviewPaste(clear) {
    byId("review-paste").hidden = true;
    byId("paste-review-output").setAttribute("aria-expanded", "false");
    if (!clear) return;
    byId("review-paste-text").value = "";
    const error = byId("review-paste-error");
    error.hidden = true;
    error.textContent = "";
  }

  /**
   * The host's reading of a paste. Unread: say why under the paste, which keeps
   * its text for a fix. Read: fill the four fields — replacing what they held,
   * since Parse was pressed to do exactly that — open the form at Summary, and
   * say it was prefilled. Nothing is sent: Save is still the developer's.
   */
  function applyReviewPrefill(prefill) {
    const error = byId("review-paste-error");
    if (typeof prefill.error === "string") {
      // Shown before it is filled, as the saving's failure is.
      error.hidden = false;
      error.textContent = prefill.error;
      return;
    }
    const entry = prefill.entry || {};
    byId("review-summary").value = entry.summary || "";
    byId("review-findings").value = entry.findings || "";
    byId("review-validation-notes").value = entry.validationNotes || "";
    byId("review-recommendations").value = entry.recommendations || "";
    closeReviewPaste(true);
    const note = byId("review-prefill-note");
    note.textContent = (prefill.source === "ai" ? PREFILL_NOTE_AI : PREFILL_NOTE) + (prefill.leftOut ? PREFILL_LEFT_OUT : "");
    note.hidden = false;
    byId("review-editor").hidden = false;
    // A paste was just parsed: the form is the next place. A captured review
    // arrives on its own, minutes later — the live status says so, and the
    // keyboard stays wherever the developer is.
    if (prefill.source !== "ai") byId("review-summary").focus({ preventScroll: true });
  }

  /** Paste Review Output pressed: open the paste box at its text, or close it again. */
  function toggleReviewPaste() {
    const button = byId("paste-review-output");
    if (button.hidden || button.getAttribute("aria-disabled") === "true") return;
    if (!byId("review-paste").hidden) {
      closeReviewPaste(false);
      return;
    }
    byId("review-paste").hidden = false;
    button.setAttribute("aria-expanded", "true");
    byId("review-paste-text").focus({ preventScroll: true });
  }

  /** Parse: the pasted text to the host, which reads it and answers once. */
  function parseReviewPaste() {
    const parse = byId("parse-review-output");
    if (byId("review-paste").hidden || parse.getAttribute("aria-disabled") === "true") return;
    vscode.postMessage({ type: "parseReviewOutput", text: byId("review-paste-text").value });
  }

  /** Record or Replace pressed: open the form at Summary, or close it again. */
  function toggleReviewEditor(button) {
    const editor = byId("review-editor");
    if (button.hidden || button.getAttribute("aria-disabled") === "true") return;
    editor.hidden = !editor.hidden;
    byId("record-review-result").setAttribute("aria-expanded", editor.hidden ? "false" : "true");
    byId("replace-review-result").setAttribute("aria-expanded", editor.hidden ? "false" : "true");
    if (!editor.hidden) byId("review-summary").focus({ preventScroll: true });
  }

  /**
   * Verification Evidence and its form (Batch 12).
   *
   * The lines are the host's: counts of recorded statuses, one generated phrase
   * scoped to the recorded checks, and up to five checks by name — never a badge
   * and never "verified". The form is the page's: Record opens it with one row,
   * Edit asks the host for the recorded checks and opens it when they arrive
   * (once per answer), and Cancel, a recorded save or another work item closes
   * it — the last two emptying it. Save only asks; the host decides whether a
   * recording may start and runs record-verification.
   */
  function renderVerification(step, workItemId) {
    const actions = (step && step.actions) || [];
    const result = step ? step.verificationResult : undefined;
    const capture = step ? step.verificationCapture : undefined;
    const edit = step ? step.verificationEdit : undefined;
    const recording = Boolean(capture && capture.state === "recording");
    const failed = Boolean(capture && capture.state === "failed");
    const recorded = Boolean(capture && capture.state === "recorded");
    const offered = actions.includes("recordVerification") || actions.includes("editVerification");
    const editor = byId("verification-editor");
    const hadFocus = verificationFocused();

    const anotherItem = !step || workItemId !== verificationEditorWorkItem;
    if (anotherItem) {
      closeVerificationEditor(true);
      verificationStatus = "";
      verificationError = "";
      byId("verification-capture-status").textContent = "";
    }
    verificationEditorWorkItem = step ? workItemId : undefined;
    // Only the host's own word that it recorded closes and empties the form.
    const finished = !anotherItem && recorded && !wasVerificationRecorded;
    wasVerificationRecorded = recorded;
    if (finished) closeVerificationEditor(true);

    // The recorded checks, sent once for Edit: fill the form and open it.
    if (step && edit && edit.token !== verificationEditToken) {
      verificationEditToken = edit.token;
      // Checks typed into a Record form that met a report recorded meanwhile are
      // kept, after the recorded ones — nothing typed is dropped by asking to Edit.
      const typed =
        verificationMode === "record" ? verificationRows.map(readVerificationRow).filter((check) => check.name.trim() !== "") : [];
      const checks = [...(edit.checks || []), ...typed].slice(0, MAX_VERIFICATION_CHECKS);
      openVerificationEditor("edit", checks, edit.structured ? "" : edit.unreadable ? "unreadable" : "format");
    }

    const open = !editor.hidden;
    // While the host records, neither toggle does anything — the form and what
    // was typed stay exactly as they are until the recording has answered.
    const record = byId("record-verification");
    record.hidden = !(step && !result && (actions.includes("recordVerification") || open || recording));
    record.setAttribute("aria-expanded", open ? "true" : "false");
    record.setAttribute("aria-disabled", recording ? "true" : "false");
    const editButton = byId("edit-verification");
    editButton.hidden = !(result && (actions.includes("editVerification") || open || recording));
    editButton.setAttribute("aria-expanded", open ? "true" : "false");
    const closesEdit = open && verificationMode === "edit";
    editButton.setAttribute("aria-disabled", recording || (!offered && !closesEdit) ? "true" : "false");

    // `aria-disabled`, as on Save Review Result: a keyboard user who pressed a
    // button keeps the focus while the host records; the handlers and host refuse.
    const busy = recording || !offered;
    const save = byId("save-verification");
    save.setAttribute("aria-disabled", busy ? "true" : "false");
    save.setAttribute("aria-busy", recording ? "true" : "false");
    byId("save-verification-label").textContent = recording ? "Recording…" : "Save Verification Evidence";
    byId("cancel-verification").setAttribute("aria-disabled", recording ? "true" : "false");
    renderVerificationRowState(recording);

    byId("verification-result").hidden = !result;
    byId("open-verification-report").hidden = !(result && actions.includes("openVerificationReport"));
    const signature = result ? JSON.stringify([workItemId, result]) : "";
    if (signature !== verificationResultSignature) {
      verificationResultSignature = signature;
      byId("verification-result-counts").textContent = result ? result.counts : "";
      const overall = byId("verification-result-overall");
      overall.textContent = result && result.overall ? result.overall : "";
      overall.hidden = !(result && result.overall);
      const list = byId("verification-result-checks");
      list.replaceChildren(
        ...(result ? result.checks : []).map((check) =>
          line("li", "", [check.name, check.status, check.type].filter(Boolean).join(" · ")),
        ),
      );
      const more = byId("verification-result-more");
      more.textContent = result && result.more ? result.more : "";
      more.hidden = !(result && result.more);
    }

    let status = "";
    if (recording) status = "Recording verification evidence…";
    else if (recorded) status = capture.replaced ? "Verification evidence replaced." : "Verification evidence recorded.";
    if (status !== verificationStatus) {
      verificationStatus = status;
      byId("verification-capture-status").textContent = status;
    }
    const message = failed ? capture.message || "" : "";
    if (message !== verificationError) {
      verificationError = message;
      const error = byId("verification-capture-error");
      // Shown before it is filled, as Review Result's is.
      error.hidden = message === "";
      error.textContent = message;
    }
    if (finished && hadFocus) byId("verification-capture-status").focus({ preventScroll: true });
  }

  /** Whether the keyboard is somewhere in the verification form. */
  function verificationFocused() {
    const active = document.activeElement;
    if (VERIFICATION_CONTROLS.some((id) => byId(id) === active)) return true;
    const focused = active && active.id;
    return Boolean(focused) && verificationRows.some((row) => row.controls.some((control) => control.id === focused));
  }

  /**
   * Open the form: `edit` with the recorded checks, `record` with one new row.
   * An Edit of a report that could not be read into checks starts with one new
   * row too, and says that saving replaces the report.
   */
  function openVerificationEditor(mode, checks, replaces) {
    verificationMode = mode;
    clearVerificationRows();
    const rows = checks.length > 0 ? checks : [undefined];
    for (const check of rows) addVerificationRow(check);
    const note = byId("verification-editor-replace-note");
    note.textContent =
      replaces === "unreadable"
        ? "This report could not be read, so its checks are not in the form. Saving replaces it with the checks below."
        : "This report is not in BugPilot's format, so its checks could not be read into the form. Saving replaces it with the checks below.";
    note.hidden = !replaces;
    showVerificationEditor();
  }

  /** Show the form as it is, at its first check. */
  function showVerificationEditor() {
    byId("verification-editor").hidden = false;
    setVerificationExpanded(true);
    const first = verificationRows[0];
    if (first) first.name.focus({ preventScroll: true });
  }

  /** One row, as the CLI receives it. */
  function readVerificationRow(row) {
    const check = { name: row.name.value, status: row.status.value, type: row.kind.value };
    for (const text of row.texts) check[text.field] = text.area.value;
    return check;
  }

  /** Close the form; `clear` empties it too. */
  function closeVerificationEditor(clear) {
    byId("verification-editor").hidden = true;
    setVerificationExpanded(false);
    if (!clear) return;
    clearVerificationRows();
    byId("verification-editor-replace-note").hidden = true;
    verificationMode = "record";
  }

  function setVerificationExpanded(open) {
    byId("record-verification").setAttribute("aria-expanded", open ? "true" : "false");
    byId("edit-verification").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function clearVerificationRows() {
    verificationRows = [];
    byId("verification-rows").replaceChildren();
  }

  /**
   * One check's group: a name, a recorded status (Not Run until the developer
   * says otherwise — never Passed), a type, three optional text fields and its
   * own Remove. Built with `textContent` and `value`, never markup: a check's
   * text is whatever was pasted, a command line included.
   */
  function addVerificationRow(check) {
    verificationRowSerial += 1;
    const key = `verification-check-${verificationRowSerial}`;
    const group = document.createElement("div");
    group.className = "verification-check";
    group.setAttribute("role", "group");
    const heading = line("p", "verification-check-heading", "");
    const name = document.createElement("input");
    name.type = "text";
    name.id = `${key}-name`;
    name.setAttribute("maxlength", String(MAX_CHECK_NAME));
    name.setAttribute("placeholder", CHECK_PLACEHOLDERS.name);
    name.value = check ? check.name : "";
    const status = choice(`${key}-status`, CHECK_STATUSES, check ? check.status : "not_run");
    const kind = choice(`${key}-type`, CHECK_TYPES, check ? check.type : "automated");
    const texts = CHECK_TEXT_FIELDS.map(([field, label]) => {
      const area = document.createElement("textarea");
      area.id = `${key}-${field}`;
      area.setAttribute("rows", field === "evidence" ? "3" : "2");
      if (CHECK_PLACEHOLDERS[field]) area.setAttribute("placeholder", CHECK_PLACEHOLDERS[field]);
      area.value = check ? check[field] || "" : "";
      return { field, label, area };
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.id = `${key}-remove`;
    remove.className = "result-link";
    remove.textContent = "Remove Check";
    const row = { group, heading, name, status, kind, texts, remove, controls: [] };
    row.controls = [name, status, kind, ...texts.map((text) => text.area), remove];
    for (const control of row.controls) control.setAttribute("data-editor", "verification");
    name.addEventListener("input", () => labelVerificationRows());
    remove.addEventListener("click", () => removeVerificationRow(row));

    const choices = document.createElement("div");
    choices.className = "verification-check-choices";
    choices.append(labelled("Status", status, "status"), labelled("Type", kind, "type"));
    group.append(heading, fieldLabel("Name", name), fieldHint(name, "name"), name, choices);
    for (const text of texts) group.append(fieldLabel(text.label, text.area), fieldHint(text.area, text.field), text.area);
    group.append(remove);
    verificationRows.push(row);
    byId("verification-rows").append(group);
    labelVerificationRows();
    return row;
  }

  function choice(id, options, selected) {
    const select = document.createElement("select");
    select.id = id;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = selected;
    return select;
  }

  function fieldLabel(text, control) {
    const label = line("label", "", text);
    label.setAttribute("for", control.id);
    return label;
  }

  function labelled(text, control, field) {
    const wrapper = document.createElement("div");
    wrapper.append(fieldLabel(text, control), fieldHint(control, field), control);
    return wrapper;
  }

  /** A field's one line of help, tied to it so a screen reader reads it with the field. */
  function fieldHint(control, field) {
    const hint = line("p", "hint", CHECK_HINTS[field] || "");
    hint.id = `${control.id}-hint`;
    control.setAttribute("aria-describedby", hint.id);
    return hint;
  }

  /**
   * Number the rows and name their controls: "Check 2", "Check 2 name",
   * "Remove check 2: Unit tests" — so a screen reader knows which check each
   * control belongs to after a row is added or removed.
   */
  function labelVerificationRows() {
    verificationRows.forEach((row, index) => {
      const number = index + 1;
      const name = row.name.value.trim();
      row.heading.textContent = `Check ${number}`;
      row.group.setAttribute("aria-label", `Check ${number}`);
      row.name.setAttribute("aria-label", `Check ${number} name`);
      row.status.setAttribute("aria-label", `Check ${number} recorded status`);
      row.kind.setAttribute("aria-label", `Check ${number} type`);
      for (const text of row.texts) text.area.setAttribute("aria-label", `Check ${number} ${text.label.toLowerCase()}`);
      row.remove.setAttribute("aria-label", name === "" ? `Remove check ${number}` : `Remove check ${number}: ${name}`);
    });
    const full = verificationRows.length >= MAX_VERIFICATION_CHECKS;
    const add = byId("add-verification-check");
    add.setAttribute("aria-disabled", full || verificationBusy() ? "true" : "false");
    add.setAttribute("title", full ? `At most ${MAX_VERIFICATION_CHECKS} checks can be recorded.` : "Add another check");
  }

  function verificationBusy() {
    return byId("save-verification").getAttribute("aria-busy") === "true";
  }

  /** While recording, nothing in the form changes: its buttons wait. */
  function renderVerificationRowState(recording) {
    for (const row of verificationRows) row.remove.setAttribute("aria-disabled", recording ? "true" : "false");
    labelVerificationRows();
  }

  function removeVerificationRow(row) {
    if (row.remove.getAttribute("aria-disabled") === "true") return;
    const index = verificationRows.indexOf(row);
    if (index < 0) return;
    verificationRows.splice(index, 1);
    byId("verification-rows").replaceChildren(...verificationRows.map((entry) => entry.group));
    labelVerificationRows();
    // The keyboard goes to the row that took this one's place, or to Add Check.
    const next = verificationRows[index] || verificationRows[index - 1];
    if (next) next.remove.focus({ preventScroll: true });
    else byId("add-verification-check").focus({ preventScroll: true });
  }

  /**
   * Record pressed: open the form with one new row, or close it again. Closing
   * keeps the rows, and opening again shows them as they were: only Cancel, a
   * recorded save or another work item empties the form.
   */
  function toggleVerificationRecord() {
    const button = byId("record-verification");
    if (button.hidden || button.getAttribute("aria-disabled") === "true") return;
    if (!byId("verification-editor").hidden) {
      closeVerificationEditor(false);
      return;
    }
    if (verificationMode === "record" && verificationRows.length > 0) showVerificationEditor();
    else openVerificationEditor("record", [], "");
  }

  /**
   * Edit pressed: close the open Edit form (keeping its rows), open it again as
   * it was, or ask the host for the recorded checks. A Record form still open
   * when a report appeared asks too; its typed checks are kept (renderVerification).
   */
  function toggleVerificationEdit() {
    const button = byId("edit-verification");
    if (button.hidden || button.getAttribute("aria-disabled") === "true") return;
    const open = !byId("verification-editor").hidden;
    if (open && verificationMode === "edit") {
      closeVerificationEditor(false);
      return;
    }
    if (!open && verificationMode === "edit" && verificationRows.length > 0) {
      showVerificationEditor();
      return;
    }
    vscode.postMessage({ type: "action", id: "editVerification" });
  }

  /** An element with nothing in it but text. */
  function line(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  /** The one control inside the disclosure: ask the host for the list. */
  function validationButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-link";
    button.textContent = label;
    button.addEventListener("click", () => vscode.postMessage({ type: "action", id: "loadValidation" }));
    return button;
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
    "copy-context": "copyContext",
    "open-folder": "openFolder",
  };

  /**
   * The sentence under Run.
   *
   * The Context Ready card that used to sit here is gone (Batch 6, §37.45):
   * everything it held is on the workflow row that owns it, and the workflow
   * header's status is the one global "Context ready".
   */
  function renderRunHint(state) {
    // The host's sentence for the button it labelled: what Run does until it
    // has been done, then why the button now says Fix with AI, Open AI Session
    // or Rebuild Context. None while a run is in flight, or after one that
    // left nothing to do next — advice about a press already made, sitting
    // above the proof of what it did.
    const hint = byId("run-hint");
    hint.textContent = state.runError ? "" : primary.hint || "";
    hint.hidden = hint.textContent === "";
  }

  /**
   * What BugPilot is configured with.
   *
   * A definition list, because that is what label-and-value is: the pairing is
   * in the markup rather than only in the layout, so it survives a screen
   * reader. Everything goes through `textContent` — a repository path and a
   * work item id are both text from outside this panel.
   *
   * The host decided every word. The page knows nothing about what "Configured"
   * means and cannot ask.
   */
  function renderDiagnostics(state) {
    const rows = (state.diagnostics || {}).rows || [];
    const list = byId("diagnostics-list");
    list.replaceChildren();
    byId("diagnostics").hidden = rows.length === 0;

    for (const row of rows) {
      const label = document.createElement("dt");
      label.className = "diagnostic-label";
      label.textContent = row.label;

      const value = document.createElement("dd");
      value.className = "diagnostic-value";
      value.textContent = row.value;
      list.append(label, value);

      // A path, or a qualifier. Quieter, and its own `dd` so the pairing stays
      // one label to one reading.
      if (row.detail) {
        const detail = document.createElement("dd");
        detail.className = "diagnostic-detail";
        detail.textContent = row.detail;
        list.append(detail);
      }
    }
  }

  /**
   * Code search's two disclosures, from its row.
   *
   * Present only while the row carries content — a finished search whose
   * retrieval.json could be read — so a running, failed or pending search never
   * shows the previous run's files.
   */
  function renderSearch(codeSearch) {
    const content = codeSearch && codeSearch.search;
    renderRelevantFiles(content);
    renderSearchDetails(content);
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
  function renderSearchDetails(content) {
    const terms = (content && content.terms) || [];
    const section = byId("search-details");
    const list = byId("search-details-list");
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
  function renderRelevantFiles(content) {
    const files = (content && content.files) || [];
    const section = byId("relevant-files");
    const list = byId("relevant-files-list");
    list.replaceChildren();
    // Hidden rather than shown empty: a "Relevant files / none" row is a line
    // to read and dismiss, and Code search's summary already said how many.
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
      content && typeof content.moreFiles === "number" && content.moreFiles > 0
        ? `${content.moreFiles} more in retrieval.json`
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
    // Only a failure no row owns; one while a step was in flight is on that
    // step's row, rendered by renderWorkflow.
    renderError("failure", state.runError);
    // Shown only when it is the thing to do, in the row beside Run.
    // Disabled-but-visible was worse than absent: a greyed Stop under an idle
    // panel is a control that has never once been usable when it was on screen.
    const canStop = running;
    byId("stop").hidden = !canStop;
    byId("stop").disabled = !canStop;

    // The button says what it will do, or what is under way. Disabled whenever
    // the host says so — a run, a handoff or an artifact write in flight — on
    // top of `renderReadiness`, and `submit()` refuses regardless: a greyed
    // button still reading "Run" says the click was ignored rather than that
    // something is happening.
    const button = byId("run");
    byId("run-label").textContent = primary.label;
    byId("run-icon").className = primary.busy
      ? "codicon codicon-loading codicon-spin"
      : `codicon codicon-${PRIMARY_ICONS[primary.action] || "play"}`;
    if (!primary.enabled) button.disabled = true;
    button.setAttribute("aria-busy", primary.busy ? "true" : "false");

    // The ⋯ menu holds what the host listed and nothing else; with nothing to
    // list, there is no menu button either.
    const more = primary.enabled ? primary.more || [] : [];
    for (const id of MORE_ITEMS) byId(`menu-${id}`).hidden = !more.includes(id);
    byId("more-actions").hidden = more.length === 0;
    if (more.length === 0) closeMoreMenu(false);
  }

  function openMoreMenu() {
    byId("more-menu").hidden = false;
    byId("more-actions").setAttribute("aria-expanded", "true");
    const first = menuItems()[0];
    if (first) first.focus();
  }

  function closeMoreMenu(returnFocus) {
    const wasOpen = !byId("more-menu").hidden;
    byId("more-menu").hidden = true;
    byId("more-actions").setAttribute("aria-expanded", "false");
    if (wasOpen && returnFocus) byId("more-actions").focus();
  }

  /** The menu's items that are on offer, in order. */
  function menuItems() {
    return MORE_ITEMS.map((id) => byId(`menu-${id}`)).filter((item) => !item.hidden);
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
    hintSuggestion = suggestion;
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
    // The hint being improved is the one on screen: the settings page's draft,
    // which the host does not hold until Apply — so it travels with the press.
    vscode.postMessage({ type: "improveHint", form: draftForm() }),
  );
  byId("hint-use").addEventListener("click", () => {
    // Into the draft, like typing it: the hint reaches the host, and can make a
    // context stale, only when the page is applied.
    if (hintSuggestion !== "") {
      byId("hint").value = hintSuggestion;
      grow(byId("hint"));
    }
    vscode.postMessage({ type: "useImprovedHint" });
  });
  byId("hint-keep").addEventListener("click", () =>
    vscode.postMessage({ type: "dismissImprovedHint" }),
  );

  // --- Workflow Settings ------------------------------------------------------

  /**
   * Open the settings page — at a section, when a row's gear asked for one.
   *
   * The view is shown first and the section scrolled to after, in the same
   * turn: un-hiding it lays it out, so the scroll lands on a section that has a
   * position rather than racing the render that gives it one. The section is
   * highlighted for a moment, and focus goes to its first control on screen — a
   * hand-written bug's Title, otherwise Attachments; Keywords; the Fresh box;
   * the AI agent — or to `focusId` when a problem names the field.
   */
  function openSettings(section, origin, focusId) {
    settingsOpen = true;
    if (origin !== undefined) settingsOrigin = origin;
    showView("settings", { focus: false });
    const target = section && SETTINGS_SECTIONS[section] ? byId(`settings-section-${section}`) : undefined;
    if (!target) {
      scrollIntoView(byId("settings-heading"), "start");
      byId("settings-heading").focus({ preventScroll: true });
      return;
    }
    scrollIntoView(target, "start");
    for (const other of Object.keys(SETTINGS_SECTIONS)) {
      byId(`settings-section-${other}`).classList.toggle("settings-section-target", other === section);
    }
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => target.classList.toggle("settings-section-target", false), 1600);
    const candidates = focusId ? [focusId] : SETTINGS_SECTIONS[section].focus;
    const control = candidates
      .map((id) => byId(id))
      .find((element) => {
        const container = document.getElementById(`field-${element.id}`);
        return !element.hidden && !element.disabled && !(container && container.hidden);
      });
    // A disabled control — a run in flight — cannot take focus; the section's
    // heading can, and says where the developer landed.
    (control || byId(`settings-title-${section}`)).focus({ preventScroll: true });
  }

  /** Leave the settings page for the form, where it was, focus back on what opened it. */
  function closeSettings() {
    settingsOpen = false;
    clearTimeout(highlightTimer);
    for (const section of Object.keys(SETTINGS_SECTIONS)) {
      byId(`settings-section-${section}`).classList.toggle("settings-section-target", false);
    }
    showView("main", { focus: false });
    renderStrategySummary();
    const origin = (settingsOrigin && document.getElementById(settingsOrigin)) || byId("open-settings");
    settingsOrigin = undefined;
    origin.focus({ preventScroll: true });
  }

  /** Cancel, or Back: the draft is discarded and the applied settings are put back. */
  function cancelSettings() {
    writeSettings(committed);
    closeSettings();
  }

  /**
   * Apply: the draft becomes the applied settings, and the host gets the whole
   * form — the one moment settings reach it, and so the one moment they can
   * make a prepared context stale, by the host's rules.
   */
  function applySettings() {
    if (byId("settings-apply").getAttribute("aria-disabled") === "true") return;
    committed = readSettings();
    // The press carries the whole form, so a change still waiting on the
    // debounce — an older snapshot, with the settings before this Apply — is
    // dropped rather than sent after it.
    clearTimeout(changeTimer);
    const form = readForm();
    persist(form);
    vscode.postMessage({ type: "applySettings", form });
    closeSettings();
  }

  /**
   * Apply waits while the host is busy — a run, a handoff, an artifact write —
   * and says why; the host refuses an Apply then too. The dialog's answer for
   * the draft's attachments is taken once, and only by an open page.
   */
  function renderSettings(state) {
    const busy = Boolean(primary.busy);
    byId("settings-apply").setAttribute("aria-disabled", busy ? "true" : "false");
    byId("settings-busy").hidden = !busy;
    const pick = state.attachmentPick;
    if (pick && pick.token !== attachmentPickToken) {
      attachmentPickToken = pick.token;
      if (settingsOpen && Array.isArray(pick.attachments)) {
        attachments = [...pick.attachments];
        renderAttachments();
      }
    }
  }

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
    settings: "workflow-settings-view",
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
    // Back on the form without the settings page — a reloaded panel that
    // restored the manager: the way into the settings the gear was part of.
    main: "open-settings",
    // Back from Manage Fix Modes: its gear, beside the selector.
    settings: "manage-fix-modes",
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
    if (!state.manage) return settingsOpen ? "settings" : "main";
    if (editor) {
      if (editor.intent === "view") return "fix-mode-preview";
      return editor.intent === "create" ? "fix-mode-new" : "fix-mode-edit";
    }
    // The editor closed — saved, cancelled or backed out of. A create that
    // started from a preview returns to it; everything else to the list.
    if (pendingReturn === "preview" && previewMode) return "fix-mode-preview";
    return "fix-mode-manager";
  }

  /** Show exactly one view, and move the developer with it — unless the caller will. */
  function showView(view, options) {
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
    // The growing fields had no layout while their view was hidden, and every
    // height read from a hidden box is zero. Arriving is their first
    // measurable moment.
    if (view === "main" || view === "settings") growAll();
    if (options && options.focus === false) return;
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

  /** The primary action — the button, or Ctrl+Enter. */
  function submit() {
    if (running || byId("run").disabled || !primary.enabled) return;
    pressAction(primary.action);
  }

  /** Ask the host for an action it offered, with the form as it is now. */
  function pressAction(action) {
    // The press carries the whole form, so a change still waiting on the
    // debounce is dropped rather than sent after it: arriving later, that older
    // snapshot would overwrite the host's copy and turn the button back.
    clearTimeout(changeTimer);
    const form = readForm();
    persist(form);
    // A new press is a new attempt: if the host refuses it for the same field
    // problem as the last one, that is news again, and the settings page opens
    // at the field again. Without this a second press looked ignored — the
    // problem is shown on the settings page, which the developer had left.
    shownProblems = "";
    shownFixModeProblem = "";
    vscode.postMessage({ type: "nextAction", action, form });
  }

  byId("form").addEventListener("submit", (event) => {
    event.preventDefault();
    // An implicit submission from inside a review or verification form — Enter
    // in a one-line field — is not a request to prepare the bug (Batch 12).
    if (fromReviewEditor({ target: document.activeElement })) return;
    submit();
  });

  /**
   * Whether an event came from the Review Result form or the paste box. They sit
   * inside the panel's form, with the workflow rows, but they are not the bug
   * being prepared: Ctrl+Enter there must not Run, and typing there is not a
   * form change.
   */
  function fromReviewEditor(event) {
    const target = event && event.target;
    const id = target && target.id;
    if (typeof id === "string" && (REVIEW_FIELDS.includes(id) || id === "save-review-result" || id === "cancel-review-result")) {
      return true;
    }
    if (typeof id === "string" && PASTE_CONTROLS.includes(id)) return true;
    // Start New Attempt's form: its feedback is not a preparation input, and
    // Ctrl+Enter there starts the attempt rather than pressing the primary action.
    if (typeof id === "string" && ATTEMPT_CONTROLS.includes(id)) return true;
    // The Verification Evidence form (Batch 12): its buttons by id, its rows by
    // the mark every row control carries.
    if (typeof id === "string" && VERIFICATION_CONTROLS.includes(id)) return true;
    return Boolean(target && target.getAttribute && target.getAttribute("data-editor") === "verification");
  }

  // Ctrl+Enter from anywhere in the form, which is what a multi-line
  // description needs: Enter alone belongs to the textarea.
  byId("form").addEventListener("keydown", (event) => {
    if (fromReviewEditor(event)) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  byId("form").addEventListener("input", (event) => {
    if (fromReviewEditor(event)) return;
    grow(event.target);
    // Since UI-A1 the input source is derived from the Issue field rather than
    // chosen with a radio, so it can change on a keystroke — which is why this
    // is here and not only in the `change` handler below.
    if (event.target && event.target.id === "issue") applySourceVisibility();
    formChanged();
  });

  // Workflow Settings: a gear on each row that has settings, the entry under
  // the workflow, and the page's own Back, Cancel and Apply. Opening it asks
  // the host nothing and starts nothing.
  for (const [step, section] of Object.entries(STEP_SETTINGS)) {
    byId(`settings-${step}`).addEventListener("click", () => openSettings(section, `settings-${step}`));
  }
  byId("open-settings").addEventListener("click", () => openSettings(undefined, "open-settings"));
  byId("settings-back").addEventListener("click", cancelSettings);
  byId("settings-cancel").addEventListener("click", cancelSettings);
  byId("settings-apply").addEventListener("click", applySettings);
  // Its fields are not the form's: typing there grows the box and updates what
  // depends on it on the page, and sends nothing until Apply.
  byId("workflow-settings-view").addEventListener("input", (event) => grow(event.target));
  byId("workflow-settings-view").addEventListener("change", (event) => {
    const target = event.target;
    if (target && target.id === "agent") applyAgentVisibility();
    if (target && target.id === "fixModeId") renderFixModeNote();
  });
  byId("workflow-settings-view").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applySettings();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelSettings();
    }
  });
  byId("form").addEventListener("change", (event) => {
    if (fromReviewEditor(event)) return;
    const target = event.target;
    if (target && target.id === "plan-buildContext") applyPlanCoupling();
    if (target && target.id === "agent") applyAgentVisibility();
    if (target && target.id === "fixModeId") renderFixModeNote();
    formChanged();
  });

  byId("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  for (const [id, action] of Object.entries(RESULT_ACTIONS)) {
    byId(id).addEventListener("click", () => vscode.postMessage({ type: "action", id: action }));
  }
  // The ⋯ menu: toggled by its button, closed by Escape or a choice. Arrow keys
  // move between the items, as in the editor's own menus.
  byId("more-actions").addEventListener("click", () => {
    if (byId("more-menu").hidden) openMoreMenu();
    else closeMoreMenu(false);
  });
  byId("more-menu").addEventListener("keydown", (event) => {
    const items = menuItems();
    const at = items.findIndex((item) => item === document.activeElement);
    let next;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMoreMenu(true);
      return;
    }
    if (event.key === "ArrowDown") next = items[(at + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(at - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  for (const id of MORE_ITEMS) {
    byId(`menu-${id}`).addEventListener("click", () => {
      // Only what the host listed: the stub, a stale frame or a fast double
      // press can reach a hidden item, and the host refuses it too.
      if (byId(`menu-${id}`).hidden || !primary.enabled || !(primary.more || []).includes(id)) return;
      closeMoreMenu(false);
      if (id === "startNewAttempt") openAttemptEditor();
      else pressAction(id);
    });
  }
  // Start New Attempt's form: Start asks the host; Cancel closes and empties it;
  // the helpers ask the host for text, which arrives once, in a push.
  byId("start-attempt").addEventListener("click", startAttempt);
  byId("cancel-attempt").addEventListener("click", () => {
    if (byId("cancel-attempt").getAttribute("aria-disabled") === "true") return;
    closeAttemptEditor(true);
    if (!byId("more-actions").hidden) byId("more-actions").focus({ preventScroll: true });
  });
  byId("attempt-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startAttempt();
    } else if (event.key === "Escape" && byId("cancel-attempt").getAttribute("aria-disabled") !== "true") {
      event.preventDefault();
      closeAttemptEditor(false);
      if (!byId("more-actions").hidden) byId("more-actions").focus({ preventScroll: true });
    }
  });
  byId("use-review-findings").addEventListener("click", () => {
    if (!byId("use-review-findings").hidden) vscode.postMessage({ type: "action", id: "useReviewFindings" });
  });
  byId("use-verification-evidence").addEventListener("click", () => {
    if (!byId("use-verification-evidence").hidden) {
      vscode.postMessage({ type: "action", id: "useVerificationEvidence" });
    }
  });
  // Each row's artifact link: a plain file name the host named, re-checked on
  // the host by the same path the artifact tree uses.
  for (const id of Object.keys(STEP_IDS_FOR_ARTIFACTS)) {
    byId(`artifact-${id}`).addEventListener("click", () => {
      if (rowArtifacts[id]) vscode.postMessage({ type: "openArtifact", name: rowArtifacts[id] });
    });
  }
  // Open Fix Report: the same message as the row's file link, with the name the
  // host put on the row — never one the page composed.
  byId("open-fix-report").addEventListener("click", () => {
    if (rowArtifacts.fixResult) {
      vscode.postMessage({ type: "openArtifact", name: rowArtifacts.fixResult });
    }
  });
  // Copy Review Prompt: the host prepares the prompt and copies it; the page
  // only asks, and the host refuses when no report is on screen.
  byId("copy-review-prompt").addEventListener("click", () => {
    if (!byId("copy-review-prompt").hidden && !byId("copy-review-prompt").disabled) {
      vscode.postMessage({ type: "action", id: "copyReviewPrompt" });
    }
  });
  // Review with AI: the page asks for the one action; the host builds the
  // prompt, picks the agent, and refuses unless the row is offering it.
  byId("review-with-ai").addEventListener("click", () => {
    const button = byId("review-with-ai");
    if (!button.hidden && button.getAttribute("aria-disabled") !== "true") {
      vscode.postMessage({ type: "action", id: "reviewWithAI" });
    }
  });
  // Paste Review Output opens the paste box; Parse asks the host to read it, and
  // its answer fills the form (renderReviewResult). Nothing is saved from here.
  byId("paste-review-output").addEventListener("click", toggleReviewPaste);
  byId("parse-review-output").addEventListener("click", parseReviewPaste);
  byId("cancel-review-paste").addEventListener("click", () => {
    closeReviewPaste(true);
    const button = byId("paste-review-output");
    if (!button.hidden) button.focus({ preventScroll: true });
  });
  // Ctrl+Enter in the paste box parses, as it saves in the form below.
  byId("review-paste").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      parseReviewPaste();
    }
  });
  // Add / Replace Review Result open the form; the host is asked nothing yet.
  byId("record-review-result").addEventListener("click", () => toggleReviewEditor(byId("record-review-result")));
  byId("replace-review-result").addEventListener("click", () => toggleReviewEditor(byId("replace-review-result")));
  byId("cancel-review-result").addEventListener("click", () => {
    if (byId("cancel-review-result").getAttribute("aria-disabled") === "true") return;
    // A prefilled form is the host's draft: Cancel discards it there too, so a
    // recreated panel does not fill the form with it again.
    if (!byId("review-prefill-note").hidden) vscode.postMessage({ type: "discardReviewDraft" });
    closeReviewEditor(true);
    // A failure about the text just discarded is not worth keeping on screen —
    // and forgotten, so the same failure after the next press is said again.
    byId("review-capture-error").hidden = true;
    captureError = "";
    // Nor is "ready to save" about a form just emptied.
    if (captureStatus === PREFILL_READY) {
      captureStatus = "";
      byId("review-capture-status").textContent = "";
    }
    const toggle = byId("record-review-result").hidden ? byId("replace-review-result") : byId("record-review-result");
    toggle.setAttribute("aria-expanded", "false");
    if (!toggle.hidden) toggle.focus({ preventScroll: true });
  });
  // Save sends the four sections and nothing else: no work item, no path, no
  // replace flag. The host knows which work item is on screen and asks itself
  // before replacing a recorded result.
  function saveReview() {
    const save = byId("save-review-result");
    if (byId("review-editor").hidden || save.getAttribute("aria-disabled") === "true") return;
    vscode.postMessage({
      type: "recordReview",
      review: {
        summary: byId("review-summary").value,
        findings: byId("review-findings").value,
        validationNotes: byId("review-validation-notes").value,
        recommendations: byId("review-recommendations").value,
      },
    });
  }
  byId("save-review-result").addEventListener("click", saveReview);
  // Ctrl+Enter in the form saves the review, as it runs the panel elsewhere;
  // the panel's own handlers below leave the review fields alone.
  byId("review-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveReview();
    }
  });
  // Open Review Report: an action, not a file name — the host opens the canonical
  // file of the work item on screen, and only while it is listed.
  byId("open-review-report").addEventListener("click", () => {
    if (!byId("open-review-report").hidden) vscode.postMessage({ type: "action", id: "openReviewReport" });
  });
  // Verification Evidence (Batch 12). Record opens the form with one row; Edit
  // asks the host for the recorded checks; Open is an action, not a file name.
  byId("record-verification").addEventListener("click", toggleVerificationRecord);
  byId("edit-verification").addEventListener("click", toggleVerificationEdit);
  byId("open-verification-report").addEventListener("click", () => {
    if (!byId("open-verification-report").hidden) {
      vscode.postMessage({ type: "action", id: "openVerificationReport" });
    }
  });
  byId("add-verification-check").addEventListener("click", () => {
    const add = byId("add-verification-check");
    if (byId("verification-editor").hidden || add.getAttribute("aria-disabled") === "true") return;
    const row = addVerificationRow(undefined);
    row.name.focus({ preventScroll: true });
  });
  byId("cancel-verification").addEventListener("click", () => {
    if (byId("cancel-verification").getAttribute("aria-disabled") === "true") return;
    const editing = verificationMode === "edit";
    closeVerificationEditor(true);
    byId("verification-capture-error").hidden = true;
    verificationError = "";
    const toggle = editing || byId("record-verification").hidden ? byId("edit-verification") : byId("record-verification");
    if (!toggle.hidden) toggle.focus({ preventScroll: true });
  });
  // Save sends the rows and whether the form was opened by Edit — no work item,
  // no path. Every status is the one chosen in the row; nothing is inferred.
  function saveVerification() {
    const save = byId("save-verification");
    if (byId("verification-editor").hidden || save.getAttribute("aria-disabled") === "true") return;
    const editing = verificationMode === "edit";
    vscode.postMessage({
      type: "recordVerification",
      replace: editing,
      // Which Edit answer the rows came from: the host replaces only the report
      // that answer was read from, never one that changed since.
      ...(editing && verificationEditToken !== undefined ? { basis: verificationEditToken } : {}),
      checks: verificationRows.map(readVerificationRow),
    });
  }
  byId("save-verification").addEventListener("click", saveVerification);
  byId("verification-editor").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      saveVerification();
      return;
    }
    // Plain Enter in a check's one-line name would submit the panel's form
    // implicitly — a Run. Text areas keep their Enter.
    if (event.target && event.target.type === "text") event.preventDefault();
  });
  // Opening the checklist is what asks for it — once, and never on a render.
  byId("validation-checklist").addEventListener("toggle", () => {
    const disclosure = byId("validation-checklist");
    if (disclosure.open && !disclosure.hidden && validationState === undefined) {
      vscode.postMessage({ type: "action", id: "loadValidation" });
    }
  });
  // The dialog can only be opened by the host, so this asks — with the draft's
  // list, for the host to add to. The answer comes back to the draft.
  byId("add-attachment").addEventListener("click", () =>
    vscode.postMessage({ type: "pickAttachments", attachments: [...attachments] }),
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
    committed = readSettings();
    renderAttachments();
    applySourceVisibility();
    applyAgentVisibility();
    applyPlanCoupling();
    growAll();
  }
  vscode.postMessage({ type: "ready" });
})();
