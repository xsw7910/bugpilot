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
    "gitKeywords",
    "gitFiles",
    "gitMaxCommits",
    "similarKeywords",
    "similarMaxFixes",
    "repositoryLanguages",
    "repositoryFrameworks",
    "repositoryApplicationType",
    "repositoryBuildSystem",
    "repositoryTestFramework",
    "repositoryNotes",
    "branchTemplate",
  ];

  /**
   * The settings page's switches — Git History Settings' four and Similar Fixes
   * Settings' one — which all ship ticked: an absent value is on, as
   * `restoreForm` and the host's `parseForm` read it.
   */
  const SETTINGS_SWITCHES = [
    "gitUseSharedKeywords",
    "gitUseSharedFocusFiles",
    "gitSearchMessages",
    "gitSearchFileHistory",
    "similarUseSharedKeywords",
  ];

  /**
   * The Verification Policy's switches and their defaults,
   * as `VERIFICATION_FIELDS` in `projectSettings.ts` lists them. Not in
   * `SETTINGS_SWITCHES`: one of them ships off, so absent is each one's own
   * default rather than on.
   */
  const VERIFICATION_SWITCHES = {
    verifyRelevantTests: true,
    verifyStaticChecks: true,
    verifyFullSuite: false,
    verifyReportNotRun: true,
  };
  /** Branch naming's choices, as `BRANCH_NAMINGS` in `projectSettings.ts`; the first is the default. */
  const BRANCH_NAMINGS = ["default", "custom"];

  /** History Depth's options, as `GIT_HISTORY_DEPTHS` in `form.ts` lists them. */
  const GIT_HISTORY_DEPTHS = ["recent", "broader"];
  /** The branch policies, as `BRANCH_POLICIES` in `form.ts` lists them; the first is the default. */
  const BRANCH_POLICIES = ["current", "per-issue", "ask"];
  /**
   * The Repository Profile's modes, as `REPOSITORY_PROFILE_MODES` in
   * `repositoryProfile.ts` lists them; the first is the default. Custom shows
   * the details below the picker; the others hide them.
   */
  const REPOSITORY_PROFILES = ["auto", "generic", "custom"];
  const REPOSITORY_DETAILS = [
    "repositoryLanguages",
    "repositoryFrameworks",
    "repositoryApplicationType",
    "repositoryBuildSystem",
    "repositoryTestFramework",
    "repositoryNotes",
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
   * How the Issue field was read, in words, by `issueKind()`: nothing while it
   * is empty. The note under the field adds the key after a dot; the screen
   * reader hears these alone.
   */
  const ISSUE_KIND_WORDS = { "": "", jira: "Jira issue", manual: "Bug description" };

  /** How long typing has to pause before the Issue's kind is said aloud. */
  const ISSUE_KIND_PAUSE_MS = 1000;

  /**
   * Which `FormState` field a host-reported problem belongs to on screen.
   *
   * The host validates `issueKey` and `description`, because those are what a
   * command line is built from; the page has one box for both, and a message
   * attached to a field with no control would be a message nobody sees.
   */
  const PROBLEM_CONTROLS = { issueKey: "issue", description: "issue" };

  /**
   * The text fields on the Workflow Settings page. The Issue and the Hint are
   * the form's own, above Run with Fix Mode (§37.84): read from their controls
   * like the plan's checkboxes, never through the settings page's draft.
   */
  const SETTINGS_TEXT_FIELDS = TEXT_FIELDS.filter((field) => field !== "issue" && field !== "hint");

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
    "issue-details": { fields: ["title", "attachments", "attachmentDescriptions"], focus: ["title", "add-attachment"] },
    "retrieval-inputs": { fields: ["keywords", "focusFiles"], focus: ["keywords"] },
    "code-search": { fields: ["ignorePaths", "maxFiles", "maxSearchLines"], focus: ["ignorePaths"] },
    "git-history": {
      fields: [
        "gitUseSharedKeywords",
        "gitUseSharedFocusFiles",
        "gitKeywords",
        "gitFiles",
        "gitSearchMessages",
        "gitSearchFileHistory",
        "gitHistoryDepth",
        "gitMaxCommits",
      ],
      focus: ["gitUseSharedKeywords"],
    },
    "similar-fixes": {
      fields: ["similarUseSharedKeywords", "similarKeywords", "similarMaxFixes"],
      focus: ["similarUseSharedKeywords"],
    },
    repository: {
      fields: [
        "repositoryProfile",
        "repositoryLanguages",
        "repositoryFrameworks",
        "repositoryApplicationType",
        "repositoryBuildSystem",
        "repositoryTestFramework",
        "repositoryNotes",
      ],
      focus: ["repositoryProfile"],
    },
    "ai-instructions": {
      fields: ["verifyRelevantTests", "verifyStaticChecks", "verifyFullSuite", "verifyReportNotRun"],
      focus: ["user-instructions-edit"],
    },
    "build-context": { fields: ["fresh"], focus: ["fresh"] },
    "fix-with-ai": { fields: ["agent", "agentCommand"], focus: ["agent"] },
    branch: { fields: ["branchPolicy", "branchNaming", "branchTemplate"], focus: ["branchPolicy"] },
  };

  /** Which workflow row's gear opens which section; a row absent here has none. */
  const STEP_SETTINGS = {
    issueDetails: "issue-details",
    codeSearch: "code-search",
    gitHistory: "git-history",
    similarFixes: "similar-fixes",
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
  const GROWING_FIELDS = ["issue", "hint", "keywords", "focusFiles", "ignorePaths", "gitKeywords", "gitFiles", "similarKeywords", "repositoryNotes"];

  /** The Fix Mode editor's six instruction sections, named exactly as the draft names them. */
  const EDITOR_SECTIONS = [
    "objective",
    "investigation",
    "implementation",
    "verification",
    "constraints",
    "completion",
  ];
  const EDITOR_TEXT = ["name", "id", "description", ...EDITOR_SECTIONS];

  /**
   * The editor's instruction boxes grow too (§37.118), but by their own
   * listener on the editor view, never through GROWING_FIELDS: those are
   * resized by the run form's `input` listener and by `growAll`, which runs
   * while the editor is hidden. Here, so `grow` can name them during start-up.
   */
  const EDITOR_GROWING = EDITOR_SECTIONS.map((section) => `editor-${section}`);

  /**
   * The plan's boxes: the optional steps the CLI runs, which go into
   * `form.plan`. Issue details and Build context have no box — they run on
   * every run (§37.107) — and `readForm` says so.
   */
  const PLAN_FIELDS = [
    "codeSearch",
    "gitHistory",
    "similarFixes",
  ];

  /** Every box on the workflow's rows: the plan's, and Fix with AI's. */
  const STEP_BOXES = [...PLAN_FIELDS, "fixWithAI"];

  /**
   * The mark beside a row's status words (§37.86): a small dot in the status's
   * tone, or the spinner while it runs — one indicator, never both, and never a
   * tick: the checkbox at the left is the row's only check mark. The words are
   * the host's `statusText`; the mark only echoes them.
   *
   * `idle` has none: a step that has not started has no status to state.
   */
  const STEP_MARKS = {
    idle: "",
    running: "codicon codicon-loading codicon-spin",
    success: "step-dot",
    ready: "step-dot",
    failed: "step-dot",
    skipped: "step-dot",
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
  /** The Issue's kind as last said to a screen reader, and the pause before the next. */
  let issueKindSaid = "";
  let issueKindTimer;
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
    keywords: "",
    focusFiles: "",
    ignorePaths: "",
    maxFiles: "",
    maxSearchLines: "",
    agentCommand: "",
    agent: "auto",
    attachments: [],
    attachmentDescriptions: {},
    fresh: false,
    gitKeywords: "",
    gitFiles: "",
    gitMaxCommits: "",
    gitUseSharedKeywords: true,
    gitUseSharedFocusFiles: true,
    gitSearchMessages: true,
    gitSearchFileHistory: true,
    gitHistoryDepth: "recent",
    similarKeywords: "",
    similarMaxFixes: "",
    similarUseSharedKeywords: true,
    branchPolicy: "current",
    repositoryProfile: "auto",
    repositoryLanguages: "",
    repositoryFrameworks: "",
    repositoryApplicationType: "",
    repositoryBuildSystem: "",
    repositoryTestFramework: "",
    repositoryNotes: "",
    verifyRelevantTests: true,
    verifyStaticChecks: true,
    verifyFullSuite: false,
    verifyReportNotRun: true,
    branchNaming: "default",
    branchTemplate: "",
  };
  /**
   * The line under the AI Agent picker per choice, from the host's detection
   * (`PanelState.agents`). The page only shows it; it never detects.
   */
  let agentLines = {};
  /**
   * The line under the Repository Profile picker per choice, from the host
   * (`PanelState.repositoryProfile`): what Auto-detect finds in this repository.
   * The page only shows it.
   */
  let repositoryLines = {};
  /**
   * Agent values an older page or saved form may hold, and what they meant:
   * `claude` ran the claude CLI. A <select> would silently drop a value that
   * has no option, and `|| "auto"` would then pick a different agent.
   */
  const LEGACY_AGENTS = { claude: "claude-cli" };
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
  /** The draft's description per attachment path; only non-blank ones are kept. */
  let attachmentDescriptions = {};

  /**
   * The same ceilings `messages.ts` and `bugpilot/core/attachments.py` hold,
   * duplicated because a webview imports nothing; `test/panel.test.ts`
   * compares them. A file over the size is refused here, before its bytes
   * cross to the host.
   */
  const MAX_ATTACHMENTS = 10;
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const MAX_ATTACHMENT_DESCRIPTION = 500;
  let shownProblems = "";
  /** The catalog as it was last rendered, so options are not rebuilt per push. */
  let fixModeSignature;
  /** Whether a real mode can be chosen; the selector stays disabled until then. */
  let fixModesReady = false;
  /** The catalog as the host last described it, for the note under the select. */
  let fixModeCatalog;
  /** The Fix Mode problem already revealed, so the section opens once per problem. */
  let shownFixModeProblem = "";
  /**
   * Whether the last render saw a run in flight.
   *
   * Only used to notice the moment one *starts*, which is when the workflow
   * opens itself. It does not fold when the run ends: the rows
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
  // The captured review's progress card (§37.82). The clock is presentation
  // only — the host says whether a review is running — and there is only ever
  // one interval, started when the host says "reviewing" and cleared when it
  // says anything else.
  let reviewClock;
  let reviewStartedAt = 0;
  let reviewDetailsOpen = false;
  let reviewDetailsSignature = "";
  // Record Review Result: which work item the form was opened for,
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
  // Verification Evidence: the same bookkeeping, and the form's rows.
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
  const VERIFICATION_CONTROLS = [
    "add-verification-check",
    "done-verification",
    "retry-verification-save",
    "reload-verification",
    "overwrite-verification",
  ];
  // Auto-save (§37.83): Done waits for the host's word that the form is saved,
  // and the live region says only the transitions that matter.
  let verificationClosing = false;
  let verificationAnnounced = "";
  /** The Fix result step as last rendered, for Done to read the save state from. */
  let lastFixResult;

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
  /** The ⋯ More menu's next-action items, in the markup's order, below Reset Session. */
  const MORE_ITEMS = ["startNewAttempt", "rebuildContext", "openSession"];
  /** The next-action items the menu last offered, so a change under an open menu closes it. */
  let moreOffered = "";
  // Reset Session (§37.103): the host's view of its dialog, the session the
  // page last drew, the last refusal shown, and a press not yet answered — a
  // second is never sent.
  let sessionReset = { epoch: 0, busy: false, notes: [] };
  let sessionEpoch;
  let resetErrorToken;
  let resetRequested = false;
  let resetNotesDrawn = "";
  // Jira Setup (§37.124): the request the dialog was opened for, the one a
  // Cancel answered (a push still carrying it does not reopen the dialog), the
  // last refusal shown, and the control to give the focus back to.
  let jiraSetupOpenFor;
  let jiraSetupDismissed;
  let jiraSetupErrorToken;
  let jiraSetupReturnFocus;
  /** The dialog the host has open, as last drawn: whether a token is stored, whether the site is the environment's. */
  let jiraSetupView;
  /**
   * The host's rules for a field Save cannot store, said the host's way — the
   * page checks first so a missing field is said at once, and the host checks
   * again. The same three sentences as `JIRA_SETUP_PROBLEMS` (a test compares).
   */
  const JIRA_SETUP_PROBLEMS = {
    siteMissing: "Enter your Jira site, such as https://your-company.atlassian.net.",
    emailMissing: "Enter your Atlassian account email.",
    emailInvalid: "Enter a valid email address.",
    tokenMissing: "Enter an API token.",
  };
  const JIRA_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  /** The disclosures a fresh session starts with closed. */
  const SESSION_DISCLOSURES = [
    "workflow",
    "relevant-files",
    "search-details",
    "related-commits",
    "supporting-files",
    "validation-checklist",
  ];
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
    // The fixed fields by id; an attachment's description by its class, since
    // those are built per row and have none.
    const describing = Boolean(element) && String(element.className || "").split(/\s+/).includes("attachment-description");
    if (!element || !(GROWING_FIELDS.includes(element.id) || EDITOR_GROWING.includes(element.id) || describing)) return;
    element.style.height = "auto";
    const resting = element.clientHeight;
    if (!resting) return;
    // Every box here is border-box, so its border has to be added back, or the
    // text sits 2px short and a scrollbar shows. Seen in the real window three
    // times: an attachment's description, the Issue's one resting row, and
    // Focus files and Ignore paths, whose four-line placeholders fill their
    // four rows exactly and showed a scrollbar while empty.
    const border = Math.max(0, Number(element.offsetHeight) - element.clientHeight || 0);
    element.style.height = `${Math.max(resting, element.scrollHeight + border)}px`;
  }

  function growAll() {
    for (const field of GROWING_FIELDS) grow(byId(field));
    // The descriptions too: drawn while the settings page was hidden, they had
    // no layout to grow to until it opened.
    for (const item of byId("attachment-list").children) grow(item.children && item.children[1]);
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

  function formWith(settings) {
    const issue = byId("issue").value;
    const source = issueSource();
    const form = {
      source,
      plan: {},
      ...settings,
      attachments: [...settings.attachments],
      attachmentDescriptions: { ...(settings.attachmentDescriptions || {}) },
    };
    // The one box, split into the two fields the host and the CLI expect. The
    // unused one is cleared rather than left behind: a stale description under
    // a Jira key would reach `--description` the moment the key was deleted.
    form.issueKey = source === "jira" ? issue.trim() : "";
    form.description = source === "manual" ? issue : "";
    for (const field of PLAN_FIELDS) form.plan[field] = byId(`plan-${field}`).checked;
    form.plan.issueDetails = true;
    form.plan.buildContext = true;
    // Not part of the plan: it is what happens after the run, not a flag on it.
    form.fixWithAI = byId("plan-fixWithAI").checked;
    // The problem's definition beside the issue: how the AI approaches it and
    // the hint it carries, straight from the controls on the form.
    form.fixModeId = byId("fixModeId").value || "";
    form.hint = byId("hint").value;
    // Gates what the hint improver may read. Not a run flag.
    form.useIssueDetails = byId("useIssueDetails").checked;
    return form;
  }

  /** The settings page's controls, as they stand. */
  function readSettings() {
    const settings = {};
    for (const field of SETTINGS_TEXT_FIELDS) settings[field] = byId(field).value;
    settings.agent = byId("agent").value || "auto";
    settings.attachments = [...attachments];
    settings.attachmentDescriptions = describedOnly(attachments, attachmentDescriptions);
    settings.fresh = byId("fresh").checked;
    for (const field of SETTINGS_SWITCHES) settings[field] = byId(field).checked;
    settings.gitHistoryDepth = gitHistoryDepthOf(byId("gitHistoryDepth").value);
    settings.branchPolicy = branchPolicyOf(byId("branchPolicy").value);
    settings.repositoryProfile = repositoryProfileOf(byId("repositoryProfile").value);
    for (const field of Object.keys(VERIFICATION_SWITCHES)) settings[field] = byId(field).checked;
    settings.branchNaming = branchNamingOf(byId("branchNaming").value);
    return settings;
  }

  /** A branch naming this page offers, else the default. */
  function branchNamingOf(value) {
    return BRANCH_NAMINGS.includes(value) ? value : BRANCH_NAMINGS[0];
  }

  /** A History Depth this page offers, else `recent` — never a blank select. */
  function gitHistoryDepthOf(value) {
    return GIT_HISTORY_DEPTHS.includes(value) ? value : "recent";
  }

  /** A branch policy this page offers, else the default — never a blank select. */
  function branchPolicyOf(value) {
    return BRANCH_POLICIES.includes(value) ? value : BRANCH_POLICIES[0];
  }

  /** A Repository Profile mode this page offers, else Auto-detect. */
  function repositoryProfileOf(value) {
    return REPOSITORY_PROFILES.includes(value) ? value : REPOSITORY_PROFILES[0];
  }

  /** The applied settings, out of a whole form. */
  function settingsOf(form) {
    const settings = {};
    for (const field of SETTINGS_TEXT_FIELDS) settings[field] = form[field] ?? "";
    settings.agent = LEGACY_AGENTS[form.agent] ?? form.agent ?? "auto";
    settings.attachments = Array.isArray(form.attachments) ? [...form.attachments] : [];
    settings.attachmentDescriptions = describedOnly(settings.attachments, form.attachmentDescriptions || {});
    settings.fresh = form.fresh === true;
    for (const field of SETTINGS_SWITCHES) settings[field] = form[field] !== false;
    settings.gitHistoryDepth = gitHistoryDepthOf(form.gitHistoryDepth);
    settings.branchPolicy = branchPolicyOf(form.branchPolicy);
    settings.repositoryProfile = repositoryProfileOf(form.repositoryProfile);
    for (const [field, fallback] of Object.entries(VERIFICATION_SWITCHES)) {
      settings[field] = typeof form[field] === "boolean" ? form[field] : fallback;
    }
    settings.branchNaming = branchNamingOf(form.branchNaming);
    return settings;
  }

  /** Put settings into the page's controls: the applied ones, or back over a draft. */
  function writeSettings(settings) {
    for (const field of SETTINGS_TEXT_FIELDS) byId(field).value = settings[field] ?? "";
    byId("agent").value = LEGACY_AGENTS[settings.agent] ?? settings.agent ?? "auto";
    // An agent this page has no option for is Auto-detect, said as such rather
    // than left as a blank select.
    if (byId("agent").value === "") byId("agent").value = "auto";
    attachments = [...settings.attachments];
    attachmentDescriptions = { ...(settings.attachmentDescriptions || {}) };
    renderAttachments();
    byId("fresh").checked = settings.fresh === true;
    for (const field of SETTINGS_SWITCHES) byId(field).checked = settings[field] !== false;
    byId("gitHistoryDepth").value = gitHistoryDepthOf(settings.gitHistoryDepth);
    byId("branchPolicy").value = branchPolicyOf(settings.branchPolicy);
    byId("repositoryProfile").value = repositoryProfileOf(settings.repositoryProfile);
    for (const [field, fallback] of Object.entries(VERIFICATION_SWITCHES)) {
      byId(field).checked = typeof settings[field] === "boolean" ? settings[field] : fallback;
    }
    byId("branchNaming").value = branchNamingOf(settings.branchNaming);
    applyAgentVisibility();
    applyRepositoryVisibility();
    applyBranchNamingVisibility();
  }

  /** The template is on screen only while Custom is chosen: one that is not used is not shown. */
  function applyBranchNamingVisibility() {
    byId("field-branchTemplate").hidden = byId("branchNaming").value !== "custom";
  }

  function writeForm(form) {
    // Whichever of the two the stored form actually used, which is also what
    // makes a form saved before the switch was removed restore correctly.
    byId("issue").value = (form.source === "manual" ? form.description : form.issueKey) ?? "";
    settleIssueKind();
    for (const field of PLAN_FIELDS) {
      byId(`plan-${field}`).checked = form.plan?.[field] !== false;
    }
    // Opt-in, so an absent field means off — unlike the plan, where absent
    // means the default of on.
    byId("plan-fixWithAI").checked = form.fixWithAI === true;
    // The host's form is the applied settings now — and, if the settings page
    // is open, what it shows: a form the host replaced (another work item, a
    // mode it restored) supersedes a draft of the one before.
    committed = settingsOf(form);
    writeSettings(committed);
    // The problem's own fields, on the form. The mode after renderFixModes has
    // put the options there — a value that is not one of them is dropped by the
    // element, which is why the order matters; a mode with no option yet (a
    // catalog still loading) is no mode, as it always was for a run.
    const mode = form.fixModeId ?? "";
    const select = byId("fixModeId");
    // Said outright rather than left to the element: no option, no mode.
    select.value = [...select.children].some((option) => option.value === mode) ? mode : "";
    byId("hint").value = form.hint ?? "";
    grow(byId("hint"));
    byId("useIssueDetails").checked = form.useIssueDetails !== false;
    renderFixModeNote();
    applySourceVisibility();
    applyAgentVisibility();
    applyStepBoxes();
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
   * A key is shown as a run will send it, uppercased; a description is never
   * repeated — the box already holds it.
   */
  function applySourceVisibility() {
    const typed = byId("issue").value.trim();
    const manual = issueSource() === "manual";
    byId("field-title").hidden = !manual;

    const note = byId("issue-note");
    const kind = issueKind();
    note.textContent = kind === "jira" ? `${ISSUE_KIND_WORDS.jira} · ${typed.toUpperCase()}` : ISSUE_KIND_WORDS[kind];
    note.hidden = note.textContent === "";
  }

  /** What the Issue field holds: `jira`, `manual`, or `""` while it is empty. */
  function issueKind() {
    return byId("issue").value.trim() === "" ? "" : issueSource();
  }

  /**
   * The kind, said once to a screen reader while the Issue is being typed in.
   *
   * The note above is the field's description, so how it was read is heard
   * whenever the field is reached; this is for the moment it changes. Only the
   * kind — never the key or the text, which the developer has just typed — only
   * when it differs from what was last said, and only once typing pauses:
   * "JR-12345" passes through "Bug description" on its way to being a key, and
   * nobody needs to hear that.
   */
  function sayIssueKindLater() {
    clearTimeout(issueKindTimer);
    issueKindTimer = setTimeout(() => {
      const kind = issueKind();
      if (kind === issueKindSaid) return;
      issueKindSaid = kind;
      byId("issue-kind").textContent = ISSUE_KIND_WORDS[kind];
    }, ISSUE_KIND_PAUSE_MS);
  }

  /**
   * The form was written rather than typed — restored, reopened or reset — so
   * nothing is said: what the field holds now is simply what was last said.
   */
  function settleIssueKind() {
    clearTimeout(issueKindTimer);
    issueKindSaid = issueKind();
    byId("issue-kind").textContent = "";
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

      const row = document.createElement("div");
      row.className = "attachment-row";
      const icon = document.createElement("span");
      icon.className = "codicon codicon-file attachment-icon";
      icon.setAttribute("aria-hidden", "true");

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
      remove.setAttribute("title", `Remove ${name.textContent}`);
      const glyph = document.createElement("span");
      glyph.className = "codicon codicon-close";
      glyph.setAttribute("aria-hidden", "true");
      remove.append(glyph);
      remove.addEventListener("click", () => {
        // The draft's list: the form changes on Apply, not here.
        attachments = attachments.filter((entry) => entry !== path);
        delete attachmentDescriptions[path];
        renderAttachments();
      });

      // Why this file matters, optional: one line under it in task.md. A
      // textarea so a sentence wraps in a narrow sidebar; typed into the draft
      // without re-rendering, so the caret stays where it is.
      const description = document.createElement("textarea");
      description.className = "attachment-description";
      description.rows = 1;
      description.maxLength = MAX_ATTACHMENT_DESCRIPTION;
      description.placeholder = "Add a description…";
      description.setAttribute("aria-label", `Description of ${name.textContent}`);
      description.value = attachmentDescriptions[path] || "";
      description.disabled = byId("add-attachment").disabled;
      description.addEventListener("input", () => {
        if (description.value.trim() === "") delete attachmentDescriptions[path];
        else attachmentDescriptions[path] = description.value;
        grow(description);
      });

      row.append(icon, name, remove);
      item.append(row, description);
      list.append(item);
      grow(description);
    }
    list.hidden = attachments.length === 0;
  }

  /** Only the descriptions of files still in `list`, and only non-blank ones. */
  function describedOnly(list, descriptions) {
    const kept = {};
    for (const path of list) {
      const text = descriptions[path];
      if (typeof text === "string" && text.trim() !== "") kept[path] = text.slice(0, MAX_ATTACHMENT_DESCRIPTION);
    }
    return kept;
  }

  /** The files a paste or a drop carries; plain text carries none. */
  function filesOf(transfer) {
    if (!transfer) return [];
    const files = [...(transfer.files || [])];
    if (files.length === 0 && transfer.items) {
      for (const item of transfer.items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    return files;
  }

  /** Where a paste is the field's own: a text box keeps its normal paste. */
  function editable(target) {
    return Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
  }

  /** Bytes as base64, in chunks: one String.fromCharCode over 10 MB overflows the stack. */
  function toBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function attachmentStatus(text) {
    const status = byId("attachment-status");
    status.textContent = text;
    status.hidden = text === "";
  }

  /**
   * Hand pasted or dropped files to the host: bytes, never a path. All of one
   * paste or drop in one message, with the draft's list for the host to add
   * to; the answer comes back like the file dialog's.
   */
  async function attachFiles(files, origin) {
    if (byId("add-attachment").disabled) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    const refused = [];
    const payload = [];
    for (const [index, file] of files.entries()) {
      const label = file.name || "The pasted image";
      if (index >= room) {
        refused.push(`BugPilot attaches at most ${MAX_ATTACHMENTS} files`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        refused.push(`${label} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
        continue;
      }
      payload.push({ name: file.name || "", type: file.type || "", data: toBase64(new Uint8Array(await file.arrayBuffer())) });
    }
    attachmentStatus(refused.length === 0 ? "" : `Not attached: ${refused.join("; ")}.`);
    if (payload.length > 0) {
      vscode.postMessage({ type: "addAttachmentData", origin, files: payload, attachments: [...attachments] });
    }
  }

  /**
   * The custom command box belongs to exactly one choice.
   *
   * Auto-detect used to have a note beside it explaining what it would look
   * for; the option's own text says that, so it is gone and this only has one
   * thing left to decide.
   */
  function applyAgentVisibility() {
    const agent = byId("agent");
    byId("field-agentCommand").hidden = agent.value !== "custom";
    // The agent's name, never its custom command line.
    const option = agent.options ? agent.options[agent.selectedIndex] : undefined;
    agent.setAttribute("title", option ? option.text : "");
    renderAgentStatus();
  }

  /**
   * The Custom details belong to the Custom profile: shown while it is chosen —
   * the draft's choice, while Advanced Settings is open — and hidden otherwise,
   * with what they hold kept for a switch back.
   */
  function applyRepositoryVisibility() {
    const custom = byId("repositoryProfile").value === "custom";
    for (const field of REPOSITORY_DETAILS) byId(`field-${field}`).hidden = !custom;
    renderRepositoryDetected();
  }

  /**
   * The quiet line under the Repository Profile picker, for whichever choice it
   * shows — the draft's while Advanced Settings is open. Hidden when the host
   * has nothing to say for it.
   */
  function renderRepositoryDetected() {
    const line = repositoryLines[byId("repositoryProfile").value];
    const status = byId("repositoryProfile-detected");
    status.textContent = typeof line === "string" ? line : "";
    status.hidden = typeof line !== "string" || line === "";
  }

  /**
   * The quiet line under the picker, for whichever choice it shows — the draft's
   * while Advanced Settings is open: "Detected: Codex CLI" for Auto-detect, how
   * an explicit agent stands otherwise. Hidden when the host has nothing to say.
   */
  function renderAgentStatus() {
    const line = agentLines[byId("agent").value];
    const status = byId("agent-status");
    status.textContent = typeof line === "string" ? line : "";
    status.hidden = typeof line !== "string" || line === "";
  }

  /**
   * The boxes on the workflow's rows can be changed except while a run is in
   * flight: it has already read them. Not tied to anything else any more —
   * unticking Build context used to clear and disable the other four, and
   * Build context always runs since §37.107.
   */
  function applyStepBoxes() {
    for (const field of STEP_BOXES) byId(`plan-${field}`).disabled = running;
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
    renderWorkflow(state);
    renderRun(state);
    renderRunHint(state);
    renderSessionFeedback(state);
    agentLines = (state.agents && state.agents.lines) || {};
    renderAgentStatus();
    repositoryLines = (state.repositoryProfile && state.repositoryProfile.lines) || {};
    renderRepositoryDetected();
    renderNotices(state);
    // Before the views are switched: the editor's content is in place before it
    // is shown and takes focus.
    renderInstructions(state);
    renderManage(state);
    renderSettings(state);
    renderHintImprovement(state);
    renderJira(state);
    // Last: a reset done closes what the renders above may have drawn for the
    // old session's last moment.
    renderSessionReset(state);
    renderJiraSetup(state.jiraSetup);
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
      // The selector fell back to what the catalog allows; Run reads the
      // selector, so it sends what is shown.
    }
    fixModesReady = catalog.kind === "ready";
    fixModeCatalog = catalog;
  }

  /** The note under the selector, once the form has settled on a selection. */
  function renderFixModes(state) {
    const problem = (state.problems || []).find((entry) => entry.field === "fixModeId");
    renderFixModeNote(problem);
    // On the form, under the Issue: a problem with the chosen mode brings the
    // selector into view and lands on it, once per problem.
    const signature = problem ? problem.message : "";
    if (signature && signature !== shownFixModeProblem && activeView === "main") {
      scrollIntoView(byId("field-fixModeId"), "nearest");
      byId("fixModeId").focus({ preventScroll: true });
    }
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
    // The mode's name — which a narrow panel cuts — and what it does, on hover.
    const about = selected ? selected.description || "" : "";
    const name = selected ? selected.name || selected.id : "";
    select.setAttribute("title", about === "" ? name : `${name} — ${about}`);
    note.textContent = problem
      ? problem.message
      : catalog.kind === "unavailable"
        ? catalog.detail || "AI Fix Modes could not be read."
        : selected
          ? `${investigation}${about}`.trim()
          : "";
    // On the panel only when it changes what happens (§37.104): a problem with
    // the choice, no catalog, or a pass that changes no source. Otherwise the
    // line is the selector's accessible description and its tooltip, and takes
    // no room.
    const shown = Boolean(problem) || catalog.kind === "unavailable" || investigation !== "";
    note.classList.toggle("visually-hidden", !shown);
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
    const attachLocked = blocked || checking || running;
    if (byId("add-attachment").disabled !== attachLocked) {
      byId("add-attachment").disabled = attachLocked;
      // The descriptions follow the button: built with the list, so redrawn.
      renderAttachments();
    }
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
      const row = byId(`step-${step.id}`);
      // "Not chosen" only greys a row that has not happened: a Fix with AI row
      // that is ready or was handed over is part of the run, ticked or not.
      const off = !step.enabled && step.status === "idle";
      row.className = `step step-${step.status}${off ? " step-off" : ""}`;
      const statusText = step.statusText || "";
      row.setAttribute(
        "aria-label",
        `${step.label}: ${statusText || (step.enabled ? "not started" : "not selected")}`,
      );

      // First line: the status once, in words, with its mark.
      const mark = STEP_MARKS[step.status] || "";
      byId(`status-${step.id}`).hidden = statusText === "";
      byId(`status-text-${step.id}`).textContent = statusText;
      byId(`mark-${step.id}`).className = mark === "" ? "step-mark" : `step-mark ${mark}`;
      byId(`duration-${step.id}`).textContent =
        typeof step.durationMs === "number" ? formatDuration(step.durationMs) : "";

      // The second line is state, and only what the status does not say: what
      // it is doing while running, what it produced once done. A row with
      // nothing to say has no second line — what the step does is its name's
      // tooltip, never this line (§37.107).
      const secondLine = step.summary || "";
      const description = byId(`description-${step.id}`);
      description.textContent = secondLine;
      description.hidden = secondLine === "";
      byId(`foot-${step.id}`).hidden = description.hidden;

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
        settingsSummary.setAttribute("title", settingsSummary.textContent);
      }

      // Fix result has no card: a report that cannot be previewed is not a failure.
      if (document.getElementById(`error-${step.id}`)) renderError(`error-${step.id}`, step.error);
    }

    const byStep = Object.fromEntries(steps.map((step) => [step.id, step]));
    renderSearch(byStep.codeSearch);
    renderRelatedCommits(byStep.gitHistory);
    renderSupportingFiles(byStep.gitHistory);
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
    renderReviewProgress(step);
    // The button a keyboard user just pressed has gone, because the reviewer
    // started: the status saying so is the natural next place, rather than the
    // top of the document. Only then — never on an ordinary push.
    if (hadFocus && reviewButton.hidden && review && (review.state === "started" || review.state === "reviewing")) {
      byId("review-status").focus({ preventScroll: true });
    }
    // The lines are clamped on screen; the whole bounded line is the hover.
    byId("description-fixResult").setAttribute("title", step ? step.summary || "" : "");
    byId("detail-fixResult").setAttribute("title", step ? step.detail || "" : "");
    renderFixSummary(step, workItemId);
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
   * Fix result's Show more / Show less (§37.89).
   *
   * Presentation only, and the page's: which result is expanded is never sent
   * to the host or saved. It is keyed by the work item and the report's own
   * lines, so a push that changes neither — any other workflow update, an
   * artifact refresh — keeps it, and a new result starts collapsed.
   */
  let fixSummaryKey = "";
  let fixSummaryExpanded = false;
  const FIX_SUMMARY_LINES = ["description-fixResult", "detail-fixResult"];

  function renderFixSummary(step, workItemId) {
    const key = step ? `${workItemId || ""}\n${step.summary || ""}\n${step.detail || ""}` : "";
    if (key !== fixSummaryKey) {
      fixSummaryKey = key;
      fixSummaryExpanded = false;
    }
    applyFixSummary();
  }

  /**
   * Clamp or not, then decide whether the toggle is needed.
   *
   * Collapsed, the lines are clamped and measured: the toggle shows only when
   * one of them is actually cut short, so a clamp never cuts text without it.
   * Expanded, it stays (as Show less) until pressed — a width change does not
   * collapse what the developer opened.
   */
  function applyFixSummary() {
    const toggle = byId("fix-summary-toggle");
    const lines = FIX_SUMMARY_LINES.map(byId);
    for (const line of lines) line.classList.toggle("is-clamped", !fixSummaryExpanded);
    const cut = !fixSummaryExpanded && lines.some((line) => !line.hidden && line.scrollHeight > line.clientHeight + 1);
    toggle.hidden = fixSummaryKey === "" || !(fixSummaryExpanded || cut);
    toggle.textContent = fixSummaryExpanded ? "Show less" : "Show more";
    toggle.setAttribute("aria-label", fixSummaryExpanded ? "Collapse Fix result" : "Show full Fix result");
    toggle.setAttribute("title", fixSummaryExpanded ? "Collapse Fix result" : "Show full Fix result");
    toggle.setAttribute("aria-expanded", fixSummaryExpanded ? "true" : "false");
  }

  byId("fix-summary-toggle").addEventListener("click", () => {
    fixSummaryExpanded = !fixSummaryExpanded;
    applyFixSummary();
    // Collapsing shortens the row above the button: keep the button — which
    // keeps the focus — in view rather than leaving the reader somewhere below.
    if (!fixSummaryExpanded) scrollIntoView(byId("fix-summary-toggle"), "nearest");
  });

  // A row that was hidden when it rendered measures nothing, and the same text
  // can fit at one width and not another: re-check when the lines' boxes change
  // size. Only while collapsed does it matter, and only the toggle changes — so
  // the observed boxes do not, and there is no loop.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!fixSummaryExpanded) applyFixSummary();
    });
    for (const id of FIX_SUMMARY_LINES) observer.observe(byId(id));
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
    if (said) {
      const title = line("p", "review-status-title", "");
      // An indeterminate spinner while it runs: no percentage, because the
      // agent reports none.
      if (review.state === "reviewing") {
        const spinner = document.createElement("span");
        spinner.className = "codicon codicon-loading codicon-spin review-spinner";
        spinner.setAttribute("aria-hidden", "true");
        title.append(spinner);
      }
      title.append(line("span", "", review.summary || ""));
      status.append(title);
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
   * The captured review's progress card: elapsed time from the host's start
   * time — so a recreated panel resumes rather than restarting at 00:00 — Show
   * details, and Cancel Review while the host offers it. Only the "reviewing"
   * state shows it; any other stops the clock and closes the details.
   */
  function renderReviewProgress(step) {
    const review = step ? step.review : undefined;
    const running = Boolean(review && review.state === "reviewing" && typeof review.startedAt === "number");
    const card = byId("review-progress");
    card.hidden = !running;
    card.setAttribute("aria-busy", running ? "true" : "false");
    const actions = (step && step.actions) || [];
    byId("cancel-review").hidden = !(running && actions.includes("cancelReview"));
    if (!running) {
      stopReviewClock();
      reviewDetailsOpen = false;
      reviewDetailsSignature = "";
      byId("review-details").replaceChildren();
      renderReviewDetailsToggle();
      return;
    }
    reviewStartedAt = review.startedAt;
    const signature = JSON.stringify([review.startedAt, review.details || null]);
    if (signature !== reviewDetailsSignature) {
      reviewDetailsSignature = signature;
      const details = review.details || {};
      const rows = [
        ["Agent", details.agent || "AI"],
        ["Mode", details.mode || ""],
        ["Status", details.status || ""],
        ["Started", new Date(review.startedAt).toLocaleTimeString()],
        ["Output format", (details.outputFormat || []).join(", ")],
      ];
      const list = byId("review-details");
      list.replaceChildren();
      for (const [term, value] of rows) list.append(line("dt", "", term), line("dd", "", value));
    }
    renderReviewDetailsToggle();
    updateReviewElapsed();
    if (reviewClock === undefined) reviewClock = setInterval(updateReviewElapsed, 1000);
  }

  function renderReviewDetailsToggle() {
    byId("review-details").hidden = !reviewDetailsOpen;
    byId("review-details-toggle").setAttribute("aria-expanded", reviewDetailsOpen ? "true" : "false");
    byId("review-details-toggle-label").textContent = reviewDetailsOpen ? "Hide details" : "Show details";
    byId("review-details-toggle").setAttribute("title", reviewDetailsOpen ? "Hide AI review details" : "Show AI review details");
  }

  function stopReviewClock() {
    if (reviewClock === undefined) return;
    clearInterval(reviewClock);
    reviewClock = undefined;
  }

  function updateReviewElapsed() {
    byId("review-elapsed").textContent = formatElapsed(Date.now() - reviewStartedAt);
  }

  /** 00:18, then 1:02:14 past an hour. */
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  /**
   * Review Result, its form and Paste Review Output.
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
   * Verification Evidence and its form.
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
    lastFixResult = step;
    const actions = (step && step.actions) || [];
    const result = step ? step.verificationResult : undefined;
    const capture = step ? step.verificationCapture : undefined;
    const edit = step ? step.verificationEdit : undefined;
    const autosave = step ? step.verificationAutosave : undefined;
    const recording = Boolean(capture && capture.state === "recording");
    const offered = actions.includes("recordVerification") || actions.includes("editVerification");
    const editor = byId("verification-editor");

    const anotherItem = !step || workItemId !== verificationEditorWorkItem;
    if (anotherItem) {
      // The host saved the last work item's form, or asked, before switching.
      closeVerificationEditor(true);
      verificationStatus = "";
      verificationError = "";
      verificationAnnounced = "";
      verificationClosing = false;
      byId("verification-capture-status").textContent = "";
    }
    verificationEditorWorkItem = step ? workItemId : undefined;

    // The recorded checks, sent once for Edit: fill the form and open it.
    if (step && edit && edit.token !== verificationEditToken) {
      verificationEditToken = edit.token;
      // Checks typed into a Record form that met a report recorded meanwhile are
      // kept, after the recorded ones — nothing typed is dropped by asking to Edit.
      const typed =
        verificationMode === "record" ? verificationRows.map(readVerificationRow).filter((check) => check.name.trim() !== "") : [];
      const checks = [...(edit.checks || []), ...typed].slice(0, MAX_VERIFICATION_CHECKS);
      openVerificationEditor("edit", checks, edit.structured ? "" : edit.unreadable ? "unreadable" : "format");
      if (typed.length > 0) sendVerificationDraft();
    }

    const open = !editor.hidden;
    // Saved for the first time — by this form, as the host says: the open form
    // now edits that report. A report written elsewhere meanwhile is not the
    // form's, and Edit keeps what was typed beside it.
    if (open && result && verificationMode === "record" && autosave && autosave.state === "saved") verificationMode = "edit";
    const record = byId("record-verification");
    record.hidden = !(step && !result && (actions.includes("recordVerification") || open || recording));
    record.setAttribute("aria-expanded", open ? "true" : "false");
    record.setAttribute("aria-disabled", recording ? "true" : "false");
    const editButton = byId("edit-verification");
    editButton.hidden = !(result && (actions.includes("editVerification") || open || recording));
    editButton.setAttribute("aria-expanded", open ? "true" : "false");
    const closesEdit = open && verificationMode === "edit";
    editButton.setAttribute("aria-disabled", recording || (!offered && !closesEdit) ? "true" : "false");
    renderVerificationRowState();

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
    renderVerificationSave(autosave, step);
  }

  /**
   * The form's save status, from the host's auto-save state: a compact line —
   * Unsaved changes, Saving…, Saved, or why nothing was saved — and after a
   * failure or a conflict the choices that resolve it. The live region says
   * only "saved" and "could not be saved", once each; the alert carries the
   * reason. Done closes the form once the host says it is saved.
   */
  function renderVerificationSave(autosave, step) {
    const state = autosave ? autosave.state : "";
    const labels = {
      dirty: "Unsaved changes",
      saving: "Saving…",
      saved: "Saved",
      incomplete: autosave && autosave.message ? autosave.message : "",
      error: "Could not save verification evidence",
      conflict: "Not saved: the report changed outside this form",
    };
    const status = byId("verification-save-status");
    status.textContent = labels[state] || "";
    status.hidden = status.textContent === "";
    const problem = state === "error" || state === "conflict";
    byId("verification-save-problem").hidden = !problem;
    byId("retry-verification-save").hidden = state !== "error";
    byId("reload-verification").hidden = state !== "conflict";
    byId("overwrite-verification").hidden = state !== "conflict";

    const message = problem && autosave.message ? autosave.message : "";
    if (message !== verificationError) {
      verificationError = message;
      const error = byId("verification-capture-error");
      // Shown before it is filled, as Review Result's is.
      error.hidden = message === "";
      error.textContent = message;
    }
    const announce = state === "saved" ? "Verification evidence saved." : problem ? "Verification evidence could not be saved." : "";
    if (announce !== verificationAnnounced) {
      // "Saving…" and "Unsaved changes" are never read out; a new edit clears
      // the last announcement so the next save is said again.
      if (announce !== "" || state === "dirty") {
        verificationAnnounced = announce;
        byId("verification-capture-status").textContent = announce;
      }
    }
    if (verificationClosing) {
      if (state === "saved" || state === "") {
        verificationClosing = false;
        finishVerificationEditing(step);
      } else if (state !== "dirty" && state !== "saving") {
        // Could not save: the form stays open, with the reason.
        verificationClosing = false;
      }
    }
  }

  /** Done, once nothing is unsaved: close the form and give the keyboard its button back. */
  function finishVerificationEditing() {
    const hadFocus = verificationFocused();
    closeVerificationEditor(true);
    const toggle = byId("record-verification").hidden ? byId("edit-verification") : byId("record-verification");
    toggle.setAttribute("aria-expanded", "false");
    if (hadFocus && !toggle.hidden) toggle.focus({ preventScroll: true });
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
    remove.setAttribute("title", "Remove this verification check");
    const row = { group, heading, name, status, kind, texts, remove, controls: [] };
    row.controls = [name, status, kind, ...texts.map((text) => text.area), remove];
    for (const control of row.controls) control.setAttribute("data-editor", "verification");
    name.addEventListener("input", () => {
      labelVerificationRows();
      sendVerificationDraft();
    });
    for (const control of [status, kind]) control.addEventListener("change", sendVerificationDraft);
    for (const text of texts) text.area.addEventListener("input", sendVerificationDraft);
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
    return false;
  }

  /**
   * Every edit goes to the host as the rows now stand; the host debounces,
   * validates and saves. The page writes nothing and decides nothing about
   * whether the rows can be saved.
   */
  function sendVerificationDraft() {
    if (byId("verification-editor").hidden) return;
    vscode.postMessage({ type: "verificationDraft", checks: verificationRows.map(readVerificationRow) });
  }

  /** Rows stay editable while a save is written: the host saves the newer ones after. */
  function renderVerificationRowState() {
    for (const row of verificationRows) row.remove.setAttribute("aria-disabled", "false");
    labelVerificationRows();
  }

  function removeVerificationRow(row) {
    if (row.remove.getAttribute("aria-disabled") === "true") return;
    const index = verificationRows.indexOf(row);
    if (index < 0) return;
    verificationRows.splice(index, 1);
    byId("verification-rows").replaceChildren(...verificationRows.map((entry) => entry.group));
    labelVerificationRows();
    sendVerificationDraft();
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

  /** The press last acknowledged, so a redraw neither repeats nor re-announces it. */
  let shownSessionFeedback = 0;

  /**
   * Open AI Session's acknowledgement (§37.87), under the button: the host's
   * words for what the press came to. Text changes only when a new press is
   * answered or the answer goes away; the focus is never moved.
   */
  function renderSessionFeedback(state) {
    const feedback = state.sessionFeedback;
    const line = byId("session-feedback");
    const seq = feedback ? feedback.seq : 0;
    if (seq === shownSessionFeedback) return;
    shownSessionFeedback = seq;
    line.textContent = feedback ? feedback.message : "";
    line.className = feedback ? `session-feedback is-${feedback.kind}` : "session-feedback";
  }

  function renderRunHint(state) {
    // The one short line under the button (§37.105), and only when the host
    // has a state the button and the header do not say — "Settings changed",
    // "AI session started". None for Run or Fix with AI, while a run is in
    // flight, or beside a failure card, which says it better. The button names
    // it as its description, so it is heard with the button; hidden, it is
    // also empty, so nothing stale is.
    const hint = byId("run-hint");
    hint.textContent = state.runError ? "" : primary.hint || "";
    hint.hidden = hint.textContent === "";
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
   * Git history's Related commits: the record's commits, in the record's order.
   *
   * Present only while the row carries them — a finished Git history whose
   * structured record could be read and listed at least one commit — so a
   * running, failed, skipped or pending row, or a work item prepared before the
   * record existed, never shows a list. Every string is repository text (a
   * commit subject, a path) or a developer's keyword, and goes in through
   * `textContent`; nothing here ranks, filters or reorders.
   */
  function renderRelatedCommits(gitHistory) {
    const commits = (gitHistory && gitHistory.gitHistory && gitHistory.gitHistory.commits) || [];
    const section = byId("related-commits");
    const list = byId("related-commits-list");
    list.replaceChildren();
    section.hidden = commits.length === 0;

    for (const commit of commits) {
      const row = document.createElement("div");
      row.className = "commit-row";

      const title = document.createElement("p");
      title.className = "commit-title";
      const hash = document.createElement("span");
      hash.className = "commit-hash";
      hash.textContent = commit.shortHash;
      const subject = document.createElement("span");
      subject.className = "commit-subject";
      subject.textContent = commit.subject;
      title.append(hash, subject);
      row.append(title);

      // The lines the host chose to send, in a fixed order: what matched, which
      // known files it changed (every path in the tooltip), and why it counts.
      for (const [key, className] of [
        ["matched", "commit-meta"],
        ["changed", "commit-meta"],
        ["why", "commit-meta"],
      ]) {
        if (!commit[key]) continue;
        const line = document.createElement("p");
        line.className = className;
        line.textContent = commit[key];
        if (key === "changed" && commit.changedPaths) line.setAttribute("title", commit.changedPaths);
        row.append(line);
      }
      list.append(row);
    }
  }

  /**
   * Git history's Supporting files: what the related commits also changed that
   * Code search did not return.
   *
   * The same row as a Relevant file — the name opens it — and a line saying how
   * history found it, so it is never mistaken for a search result. Present only
   * while the row carries some. Its open is its own message: the host checks
   * the file is still in the checkout first, since the list is the run's
   * evidence and the checkout may have moved on. Nothing here asks the disk.
   */
  function renderSupportingFiles(gitHistory) {
    const files = (gitHistory && gitHistory.gitHistory && gitHistory.gitHistory.supportingFiles) || [];
    const section = byId("supporting-files");
    const list = byId("supporting-files-list");
    list.replaceChildren();
    section.hidden = files.length === 0;
    for (const file of files) {
      const row = fileRow({ name: file.name, path: file.path, matched: [] }, { supporting: true });
      const detail = document.createElement("p");
      detail.className = "file-matched";
      detail.textContent = file.detail;
      row.append(detail);
      list.append(row);
    }
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
   * `options.supporting` marks a Git history Supporting file, whose open has
   * its own message.
   */
  function fileRow(file, options = {}) {
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
    open.addEventListener("click", () => {
      if (options.supporting) vscode.postMessage({ type: "openSupportingFile", path: file.path });
      else vscode.postMessage({ type: "openRelevantFile", path: file.path });
    });

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
    // Open AI Session and Rebuild Context are shorter than what they mean
    // (§37.90); Run's and Fix with AI's explanations moved here from a line
    // under them (§37.104, §37.105), and so did the shortcut.
    const title = PRIMARY_TITLES[primary.action] || "";
    if (title) button.setAttribute("title", `${title} (${PRIMARY_SHORTCUT})`);
    else button.removeAttribute("title");
    byId("run-icon").className = primary.busy
      ? "codicon codicon-loading codicon-spin"
      : `codicon codicon-${PRIMARY_ICONS[primary.action] || "play"}`;
    if (!primary.enabled) button.disabled = true;
    button.setAttribute("aria-busy", primary.busy ? "true" : "false");

    // ⋯ More is always there: Reset Session is always on offer (§37.103). Below
    // it, the next steps the host listed and nothing else — none while anything
    // is in flight — after a separator only when there are any.
    const more = primary.enabled ? primary.more || [] : [];
    for (const id of MORE_ITEMS) byId(`menu-${id}`).hidden = !more.includes(id);
    byId("menu-separator").hidden = more.length === 0;
    byId("more-actions").hidden = false;
    // What it offers changed under an open menu — a run started, the context went
    // stale: closed, as it always was, rather than left open on items that went.
    const offered = more.join(",");
    if (offered !== moreOffered) {
      moreOffered = offered;
      const inMenu = ["resetSession", ...MORE_ITEMS].some((id) => byId(`menu-${id}`) === document.activeElement);
      closeMoreMenu(inMenu);
    }
  }

  /**
   * What the button does, as its tooltip (§37.104, §37.105): `PRIMARY_TOOLTIPS`
   * in `app/nextAction.ts`, which a test compares this copy with, and the same
   * words as the ⋯ menu's items. The button's adds its shortcut, which is
   * nowhere on screen.
   */
  const PRIMARY_TITLES = {
    run: "Prepare the issue context for AI-assisted fixing",
    fixWithAI: "Open the prepared work item in the selected AI agent",
    openSession: "Focus the existing BugPilot AI terminal",
    rebuildContext: "Rebuild the prepared context using the current settings",
  };
  const PRIMARY_SHORTCUT = "Ctrl+Enter";

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

  /** The menu's items that are on offer, in order: Reset Session, then the next steps. */
  function menuItems() {
    return ["resetSession", ...MORE_ITEMS].map((id) => byId(`menu-${id}`)).filter((item) => !item.hidden);
  }

  // --- Reset Session (§37.103) ----------------------------------------------

  /**
   * Open the question. Every opening starts at Keep: deleting is chosen each
   * time, never remembered. A form change still waiting on the debounce goes
   * now, so the host holds what is on screen should the reset not happen.
   */
  function openResetDialog() {
    const dialog = byId("reset-dialog");
    if (dialog.open) return;
    clearTimeout(changeTimer);
    vscode.postMessage({ type: "formChanged", form: readForm() });
    byId("reset-keep").checked = true;
    byId("reset-delete").checked = false;
    resetRequested = false;
    showResetError("");
    renderResetDialog();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    // The chosen option, never the button that resets.
    byId("reset-keep").focus();
  }

  /** Close it; the focus goes to `focusId`, if given — ⋯ More after a Cancel. */
  function closeResetDialog(focusId) {
    const dialog = byId("reset-dialog");
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.open = false;
    resetRequested = false;
    showResetError("");
    if (focusId) byId(focusId).focus();
  }

  function showResetError(message) {
    const error = byId("reset-error");
    // Shown before it is filled, so the alert is announced.
    error.hidden = message === "";
    error.textContent = message;
  }

  /** The question as it stands: the choice, its helper, the host's notes, the button. */
  function renderResetDialog() {
    const view = sessionReset;
    const keep = byId("reset-keep");
    const remove = byId("reset-delete");
    // Delete has nothing to act on without a work item: there, but unavailable, and why.
    const hasFiles = typeof view.workItemId === "string" && view.workItemId !== "";
    if (!hasFiles && remove.checked) {
      remove.checked = false;
      keep.checked = true;
    }
    keep.disabled = view.busy;
    remove.disabled = view.busy || !hasFiles;
    remove.setAttribute("aria-describedby", hasFiles ? "reset-delete-hint reset-delete-history" : "reset-no-files");
    const deleting = hasFiles && remove.checked;
    byId("reset-keep-hint").hidden = deleting;
    byId("reset-delete-hint").hidden = !deleting;
    byId("reset-delete-history").hidden = !deleting;
    byId("reset-no-files").hidden = hasFiles;

    const notes = view.notes || [];
    const drawn = JSON.stringify(notes);
    if (drawn !== resetNotesDrawn) {
      resetNotesDrawn = drawn;
      const list = byId("reset-notes");
      list.replaceChildren();
      for (const note of notes) {
        const item = document.createElement("li");
        item.textContent = note;
        list.append(item);
      }
    }
    byId("reset-notes").hidden = notes.length === 0;
    const blocked = byId("reset-blocked");
    blocked.textContent = view.blocked || "";
    blocked.hidden = !view.blocked;

    // `aria-disabled`, so a keyboard user who pressed it keeps the focus while
    // the host works; the handler refuses.
    const waiting = view.busy || resetRequested;
    const confirm = byId("reset-confirm");
    confirm.setAttribute("aria-disabled", waiting || Boolean(view.blocked) ? "true" : "false");
    confirm.setAttribute("aria-busy", waiting ? "true" : "false");
    confirm.setAttribute("aria-describedby", deleting ? "reset-delete-hint" : "reset-keep-hint");
    byId("reset-confirm-keep").hidden = waiting || deleting;
    byId("reset-confirm-delete").hidden = waiting || !deleting;
    byId("reset-confirm-busy").hidden = !waiting;
    byId("reset-cancel").setAttribute("aria-disabled", view.busy ? "true" : "false");
    byId("reset-status").textContent = view.busy
      ? view.deleting
        ? "Deleting generated files…"
        : "Resetting the session…"
      : "";
  }

  /** Reset Session or Reset and Delete: one press, the one choice, to the host. */
  function confirmReset() {
    const confirm = byId("reset-confirm");
    if (!byId("reset-dialog").open || confirm.getAttribute("aria-disabled") === "true") return;
    const remove = byId("reset-delete");
    const deleteGeneratedFiles = remove.checked && !remove.disabled;
    // A form change typed before the dialog opened must not arrive after the
    // reset and bring the old session back.
    clearTimeout(changeTimer);
    resetRequested = true;
    showResetError("");
    renderResetDialog();
    vscode.postMessage({ type: "resetSession", deleteGeneratedFiles });
  }

  /**
   * What the host says about Reset Session, every push. A new epoch is a reset
   * done: the page lets go of what it held about the old session. A refusal is
   * shown once, in the open dialog.
   */
  function renderSessionReset(state) {
    const view = state.sessionReset || { epoch: 0, busy: false, notes: [] };
    sessionReset = view;
    const fresh = sessionEpoch !== undefined && view.epoch !== sessionEpoch;
    sessionEpoch = view.epoch;
    if (fresh) freshSession();
    const error = view.error;
    if (error && error.token !== resetErrorToken) {
      resetErrorToken = error.token;
      resetRequested = false;
      if (byId("reset-dialog").open) showResetError(error.message || "");
    }
    renderResetDialog();
  }

  // --- Jira Setup (§37.124) -------------------------------------------------

  /**
   * The dialog follows the host: open while the push carries `jiraSetup`,
   * closed when it does not — every way in (the Jira row, a failed run's card,
   * the palette) opens it there, and a save closes it there, only once the
   * credentials are stored. Opened afresh it starts with the stored email and
   * an empty token field; while open, a push only updates Saving and errors.
   */
  function renderJiraSetup(view) {
    const dialog = byId("jira-dialog");
    if (!view) {
      // The host closed it (saved, or answered a Cancel): nothing to tell it.
      jiraSetupDismissed = undefined;
      jiraSetupOpenFor = undefined;
      if (dialog.open) closeJiraDialog();
      return;
    }
    if (!dialog.open) {
      if (view.request === jiraSetupDismissed) return;
      openJiraDialog(view);
    }
    const saving = view.saving === true;
    const save = byId("jira-save");
    save.setAttribute("aria-disabled", String(saving));
    byId("jira-save-label").textContent = saving ? "Saving…" : "Save";
    byId("jira-cancel").setAttribute("aria-disabled", String(saving));
    byId("jira-dialog").setAttribute("aria-busy", String(saving));
    const error = view.error;
    if (error && error.token !== jiraSetupErrorToken) {
      jiraSetupErrorToken = error.token;
      showJiraError(error.field, error.message || "");
    }
  }

  function openJiraDialog(view) {
    const dialog = byId("jira-dialog");
    jiraSetupOpenFor = view.request;
    jiraSetupView = view;
    // The site and the email are prefilled; the token never arrives — the field
    // starts empty and hidden every time. A site the environment sets is shown,
    // read-only, with the reason: it is not this dialog's to change.
    const site = byId("jira-site");
    const email = byId("jira-email");
    const token = byId("jira-token");
    site.value = view.site || "";
    site.readOnly = view.siteFromEnvironment === true;
    byId("jira-site-environment").hidden = view.siteFromEnvironment !== true;
    email.value = view.email || "";
    token.value = "";
    showJiraToken(false);
    byId("jira-token-stored").hidden = view.tokenStored !== true;
    byId("jira-steps").open = false;
    jiraSetupErrorToken = view.error ? view.error.token : undefined;
    showJiraError(undefined, "");
    // Back to whatever opened it, else the Jira row's button.
    const active = document.activeElement;
    jiraSetupReturnFocus = active && active.id && active.id !== "jira-dialog" ? active.id : "set-credentials";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    // The first thing still to fill: the site, the email, else the token.
    (site.value.trim() === "" && !site.readOnly ? site : email.value.trim() === "" ? email : token).focus();
  }

  /** Close it, the token field cleared — the page keeps no draft of a credential. */
  function closeJiraDialog() {
    const dialog = byId("jira-dialog");
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.open = false;
    clearJiraFields();
    const back = jiraSetupReturnFocus && byId(jiraSetupReturnFocus);
    jiraSetupReturnFocus = undefined;
    if (back && !back.hidden && typeof back.focus === "function") back.focus();
  }

  function clearJiraFields() {
    byId("jira-token").value = "";
    byId("jira-email").value = "";
    byId("jira-site").value = "";
    showJiraToken(false);
    showJiraError(undefined, "");
  }

  /** Cancel, Escape: close and store nothing — not while a save is under way. */
  function cancelJiraSetup() {
    if (byId("jira-cancel").getAttribute("aria-disabled") === "true") return;
    jiraSetupDismissed = jiraSetupOpenFor;
    closeJiraDialog();
    vscode.postMessage({ type: "closeJiraSetup" });
  }

  /** Save: the page's check first, so a missing field is said at once; then the host's. */
  function saveJiraSetup() {
    if (!byId("jira-dialog").open || byId("jira-save").getAttribute("aria-disabled") === "true") return;
    const site = byId("jira-site").value;
    const email = byId("jira-email").value;
    const token = byId("jira-token").value;
    const problem = jiraSetupProblem(site, email, token, jiraSetupView || {});
    if (problem) {
      showJiraError(problem.field, problem.message);
      return;
    }
    showJiraError(undefined, "");
    vscode.postMessage({ type: "saveJiraCredentials", site, email, token });
  }

  /**
   * `jiraSetupProblem` in `jiraConnection.ts`, word for word (a test compares):
   * the site unless the environment sets it, the email, and a token only when
   * none is stored. Whether the site is a usable address is the CLI's to say.
   */
  function jiraSetupProblem(site, email, token, view) {
    if (view.siteFromEnvironment !== true && site.trim() === "") return { field: "site", message: JIRA_SETUP_PROBLEMS.siteMissing };
    const address = email.trim();
    if (address === "") return { field: "email", message: JIRA_SETUP_PROBLEMS.emailMissing };
    if (!JIRA_EMAIL_SHAPE.test(address)) return { field: "email", message: JIRA_SETUP_PROBLEMS.emailInvalid };
    if (view.tokenStored !== true && token.trim() === "") return { field: "token", message: JIRA_SETUP_PROBLEMS.tokenMissing };
    return undefined;
  }

  /**
   * One message at a time: under the field it names, marked invalid and given
   * the focus, or — a refusal that names no field — above the actions.
   */
  function showJiraError(field, message) {
    for (const [name, id] of [["site", "jira-site"], ["email", "jira-email"], ["token", "jira-token"]]) {
      const here = message !== "" && field === name;
      const text = byId(`${id}-error`);
      text.hidden = !here;
      text.textContent = here ? message : "";
      byId(id).setAttribute("aria-invalid", String(here));
    }
    const general = byId("jira-error");
    const elsewhere = message !== "" && field !== "site" && field !== "email" && field !== "token";
    general.hidden = !elsewhere;
    general.textContent = elsewhere ? message : "";
    if (message !== "" && (field === "site" || field === "email" || field === "token")) byId(`jira-${field}`).focus();
  }

  /** Show or hide what was typed in the token field — never anything stored. */
  function showJiraToken(shown) {
    byId("jira-token").type = shown ? "text" : "password";
    const reveal = byId("jira-token-reveal");
    const label = shown ? "Hide API token" : "Show API token";
    // The name says what pressing does now, so no aria-pressed beside it.
    reveal.setAttribute("aria-label", label);
    reveal.title = label;
    const icon = byId("jira-token-reveal-icon");
    icon.classList.toggle("codicon-eye", !shown);
    icon.classList.toggle("codicon-eye-closed", shown);
  }

  /**
   * The host reset the session: its disclosures, editors, menu and dialog go —
   * the fresh form arrives the usual way, with a new revision, and no field is
   * cleared here. The focus, if it was in the question, goes to the Issue field:
   * where a fresh session starts.
   */
  function freshSession() {
    const answered = byId("reset-dialog").open === true;
    closeResetDialog();
    closeMoreMenu(false);
    closeAttemptEditor(true);
    for (const id of SESSION_DISCLOSURES) byId(id).open = false;
    attachmentStatus("");
    if (activeView === "main") scrollPanelTo(0);
    if (answered) byId("issue").focus();
  }

  /**
   * The standing facts, one card each.
   *
   * Host-computed and titled there: these are different subjects — a Jira
   * misconfiguration and an unignored artifact directory — and joining them
   * into one line put the first under a heading about the second.
   */
  /** The notices last drawn, so a render that changes nothing keeps their DOM — and the focus in it. */
  let noticesDrawn = "";
  /** The quick-fix buttons on the cards now, by action id. */
  let noticeButtons = new Map();

  function renderNotices(state) {
    const warnings = state.warnings || [];
    const container = byId("notices");
    // What a quick fix did, once its card is gone: set first, so focus can land on it.
    const done = byId("notice-status");
    const doneText = state.noticeStatus || "";
    done.textContent = doneText;
    done.hidden = doneText === "";

    const drawn = JSON.stringify(warnings);
    if (drawn === noticesDrawn) return;
    noticesDrawn = drawn;
    // A quick fix's button that had the focus: back on it after the redraw, or —
    // its card gone — on the line that says what it did, never on nothing.
    const active = document.activeElement;
    const focusedAction =
      active && typeof active.getAttribute === "function" ? active.getAttribute("data-notice-action") : null;

    container.replaceChildren();
    noticeButtons = new Map();
    for (const warning of warnings) {
      const card = document.createElement("section");
      card.className = "notice";

      const icon = document.createElement("span");
      // Orange, from the shared palette; the card's text keeps its own colours.
      icon.className = "codicon codicon-warning icon-warning";
      icon.setAttribute("aria-hidden", "true");

      const body = document.createElement("div");
      body.className = "notice-body";
      const title = document.createElement("p");
      title.className = "notice-title";
      title.textContent = warning.title || "";
      const message = document.createElement("p");
      message.className = "notice-message";
      message.textContent = warning.message || "";
      body.append(title, message);

      if (warning.status) {
        const status = document.createElement("p");
        status.className = "notice-status";
        status.textContent = warning.status;
        body.append(status);
      }
      const action = warning.action;
      if (action && action.id) {
        // Intent only: the host knows which file, which rules, and whether the
        // offer still stands.
        const row = document.createElement("div");
        row.className = "notice-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "notice-action";
        button.id = `notice-action-${action.id}`;
        button.setAttribute("data-notice-action", action.id);
        button.setAttribute("aria-label", action.accessibleName || action.label || "");
        button.setAttribute("title", action.accessibleName || action.label || "");
        button.textContent = action.label || "";
        // aria-disabled, not disabled: a disabled button drops the focus.
        if (action.busy) button.setAttribute("aria-disabled", "true");
        button.addEventListener("click", () => {
          if (button.getAttribute("aria-disabled") === "true") return;
          vscode.postMessage({ type: "action", id: action.id });
        });
        row.append(button);
        body.append(row);
        noticeButtons.set(action.id, button);
      }

      card.append(icon, body);
      container.append(card);
    }
    container.hidden = warnings.length === 0;

    if (focusedAction) {
      const again = noticeButtons.get(focusedAction);
      if (again) again.focus({ preventScroll: true });
      else if (doneText !== "") done.focus({ preventScroll: true });
      else byId("issue").focus({ preventScroll: true });
    }
  }

  /**
   * The Jira row under Advanced Settings (§37.110): the host's words, as they
   * are. A tick beside Configured and an error mark beside Authentication
   * failed echo the words; they never replace them. The button stays the one
   * `setCredentials` action, worded Configure or Replace.
   */
  function renderJira(state) {
    const jira = state.jira;
    if (!jira) return;
    const row = byId("jira-row");
    row.className = `jira-row jira-${jira.state}`;
    row.setAttribute("title", jira.tooltip);
    byId("jira-status-text").textContent = jira.status;
    const mark = byId("jira-state-icon");
    mark.className =
      jira.state === "configured"
        ? "codicon codicon-check jira-state-icon icon-success"
        : jira.state === "authFailed"
          ? "codicon codicon-error jira-state-icon icon-danger"
          : "codicon jira-state-icon";
    mark.hidden = jira.state === "notConfigured";
    const action = byId("set-credentials");
    action.textContent = jira.action;
    action.setAttribute("aria-label", jira.actionLabel);
    byId("jira-row-description").textContent = jira.tooltip;
  }

  function setFormEnabled(enabled) {
    for (const field of TEXT_FIELDS) byId(field).disabled = !enabled;
    byId("agent").disabled = !enabled;
    // Disabled until the catalog is in: an enabled selector with nothing real
    // in it invites a choice that does not exist.
    byId("fixModeId").disabled = !enabled || !fixModesReady;
    byId("fresh").disabled = !enabled;
    for (const field of SETTINGS_SWITCHES) byId(field).disabled = !enabled;
    byId("gitHistoryDepth").disabled = !enabled;
    byId("branchPolicy").disabled = !enabled;
    byId("repositoryProfile").disabled = !enabled;
    for (const field of Object.keys(VERIFICATION_SWITCHES)) byId(field).disabled = !enabled;
    byId("branchNaming").disabled = !enabled;
    applyStepBoxes();
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
    // Says the AI does it (§37.92): "Improve" alone read as a vague edit.
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
    // The hint being improved is the one on screen, which may be a keystroke
    // ahead of the host's copy — so it travels with the press.
    vscode.postMessage({ type: "improveHint", form: readForm() }),
  );
  byId("hint-use").addEventListener("click", () => {
    // Into the Hint, like typing it: the host gets the form, and decides —
    // as for any edit of the Hint — whether the prepared context is now stale.
    if (hintSuggestion !== "") {
      byId("hint").value = hintSuggestion;
      grow(byId("hint"));
    }
    vscode.postMessage({ type: "useImprovedHint" });
    formChanged();
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
   * hand-written bug's Title, otherwise Attachments; Ignore paths; a step's
   * first switch; the Fresh box; the AI agent — or to `focusId` when a problem
   * names the field (Keywords, say, in Retrieval inputs, which no gear opens).
   */
  function openSettings(section, origin, focusId) {
    settingsOpen = true;
    // The picker's status line is about this machine now: the host answers
    // from its cache, or detects once, and says so in the next state.
    vscode.postMessage({ type: "detectAgents" });
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
    // User or Project instructions: one page, reached
    // from the settings page and returning to it.
    instructions: "instructions-editor-view",
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
    // Back on the form from Manage Fix Modes: its gear, beside the selector
    // under the Issue.
    main: "manage-fix-modes",
    // Back on the settings page, which no longer holds the Fix Mode gear: its heading.
    settings: "settings-heading",
    "fix-mode-manager": "manage-heading",
    "fix-mode-preview": "preview-heading",
    "fix-mode-new": "editor-title",
    "fix-mode-edit": "editor-title",
    instructions: "instructions-title",
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
    // The instruction editor is the host's, like the Fix Mode one, and is only
    // ever reached from the settings page.
    if (!state.manage) return settingsOpen ? (state.instructionsEditor ? "instructions" : "settings") : "main";
    if (editor) {
      if (editor.intent === "view") return "fix-mode-preview";
      return editor.intent === "create" ? "fix-mode-new" : "fix-mode-edit";
    }
    // The editor closed — saved, cancelled or backed out of. A create that
    // started from a preview returns to it — while the mode is still there to
    // read; everything else to the list.
    if (pendingReturn === "preview" && previewMode && stillListed(state.manage.catalog, previewMode)) return "fix-mode-preview";
    return "fix-mode-manager";
  }

  /** Whether the mode a preview shows is still on disk, as far as the catalog has said. */
  function stillListed(catalog, draft) {
    if (!catalog || catalog.kind !== "ready") return true;
    return (catalog[draft.source] || []).some((mode) => mode.id === draft.id);
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
    if (view === "fix-mode-new" || view === "fix-mode-edit") growEditor();
    if (options && options.focus === false) return;
    // Back on the settings page from an instruction editor: on the Edit that
    // opened it, not at the top of a long page.
    if (view === "settings" && previous === "instructions") {
      const back = instructionsReturn && document.getElementById(instructionsReturn);
      instructionsReturn = undefined;
      if (back) {
        focusElement(back);
        return;
      }
    }
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

  // --- User and Project instructions ------------------

  /** The editor the host has open, as last drawn: its token, scope and limit. */
  let instructionsEditor;
  /** The Edit that opened the editor, to land on again when it closes. */
  let instructionsReturn;
  let instructionsErrorToken;

  /**
   * The settings page's two rows — one line of state each, from the host — and
   * the editor while the host has one open. The editor's box is filled once per
   * open (its `token`), never by a later push, so typing is never overwritten.
   */
  function renderInstructions(state) {
    const rows = state.instructions || {};
    for (const scope of ["user", "project"]) {
      const row = rows[scope] || { status: "", editable: false };
      const status = byId(`${scope}-instructions-status`);
      status.textContent = row.status || "";
      status.hidden = !row.status;
      byId(`${scope}-instructions-edit`).disabled = !row.editable;
    }
    const editor = state.instructionsEditor;
    if (!editor) {
      instructionsEditor = undefined;
      return;
    }
    const text = byId("instructions-text");
    if (!instructionsEditor || editor.token !== instructionsEditor.token) {
      byId("instructions-title").textContent = editor.title;
      byId("instructions-text-label").textContent = editor.title;
      byId("instructions-scope").textContent = editor.scopeLine;
      text.value = editor.text;
      const empty = byId("instructions-empty");
      empty.textContent = editor.text === "" ? editor.empty : "";
      empty.hidden = editor.text !== "";
      showInstructionsError("");
      instructionsErrorToken = undefined;
    }
    instructionsEditor = editor;
    renderInstructionsCount();
    const problem = byId("instructions-problem");
    problem.textContent = editor.problem || "";
    problem.hidden = !editor.problem;
    const save = byId("instructions-save");
    save.setAttribute("aria-disabled", editor.saving ? "true" : "false");
    save.textContent = editor.saving ? "Saving…" : "Save";
    text.readOnly = Boolean(editor.saving);
    if (editor.error && editor.error.token !== instructionsErrorToken) {
      instructionsErrorToken = editor.error.token;
      showInstructionsError(editor.error.message);
    }
  }

  /** How much is typed against the limit the CLI enforces — said before Save, not after. */
  function renderInstructionsCount() {
    const length = byId("instructions-text").value.length;
    const max = (instructionsEditor && instructionsEditor.maxCharacters) || 20000;
    const count = byId("instructions-count");
    count.textContent = `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} characters`;
    count.classList.toggle("over-limit", length > max);
  }

  function showInstructionsError(message) {
    const error = byId("instructions-error");
    error.textContent = message;
    error.hidden = message === "";
  }

  function closeInstructionsEditor() {
    vscode.postMessage({ type: "closeInstructions" });
  }

  /** Save: too long is said here and sent nowhere; the host checks again and the CLI a third time. */
  function saveInstructionsEditor() {
    const save = byId("instructions-save");
    if (!instructionsEditor || save.getAttribute("aria-disabled") === "true") return;
    const text = byId("instructions-text").value;
    const max = instructionsEditor.maxCharacters || 20000;
    if (text.length > max) {
      showInstructionsError(
        `${instructionsEditor.title} are ${text.length.toLocaleString("en-US")} characters; the most BugPilot includes is ${max.toLocaleString("en-US")}. Shorten them to save.`,
      );
      byId("instructions-text").focus();
      return;
    }
    showInstructionsError("");
    vscode.postMessage({ type: "saveInstructions", scope: instructionsEditor.scope, text });
  }

  // --- managing custom Fix Modes -------------------------------------------

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

    // Arriving in the editor from anywhere else is a fresh visit: its sections
    // start as they do. A push while it is open — a refused save — keeps them.
    const editing = activeView === "fix-mode-new" || activeView === "fix-mode-edit";
    renderEditor(editor && editor.intent !== "view" ? editor : undefined, {
      catalog: manage ? manage.catalog : undefined,
      message,
      fresh: !editing,
    });
    if (view === "fix-mode-preview") renderPreviewView(previewMode, manage && manage.catalog);

    // Whatever the state meant has now been read, so the context that got us
    // here is spent: an editor left behind, and a preview left for the list.
    // The way back to a preview holds until the preview is left, not for one
    // push: the host answers a closed editor twice — the list loading, then
    // the list — and the second push used to land on the list (seen in the
    // real window, §37.115).
    if (view !== "fix-mode-new" && view !== "fix-mode-edit") duplicateOrigin = undefined;
    if (view === "fix-mode-manager" || view === "main") pendingReturn = undefined;
    if (view === "fix-mode-manager" || view === "main") {
      previewMode = undefined;
      previewDuplicate = undefined;
      // The next mode read is drawn afresh, its sections at their defaults.
      previewSignature = undefined;
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
   * One Fix Mode, read rather than edited (§37.115).
   *
   * A header — the mode's glyph, its name, its source, its description, and
   * its action at the right — then its six sections, each a disclosure with a
   * glyph of its own: the four that say how the work goes open, Constraints
   * and Completion requirements closed to one line. Text, not a form full of
   * disabled boxes: a greyed-out textarea reads as something the developer is
   * failing to type into. Everything comes from the object the host supplied —
   * no second lookup, no precedence rule — and every word of it is shown as
   * written. The id, the version and the type are in Details, closed.
   */
  const PREVIEW_SECTIONS = [
    { id: "objective", title: "Objective", glyph: "codicon-target", tone: "cyan", open: true },
    { id: "investigation", title: "Investigation", glyph: "codicon-search", tone: "purple", open: true },
    { id: "implementation", title: "Implementation", glyph: "codicon-tools", tone: "green", open: true },
    { id: "verification", title: "Verification", glyph: "codicon-check-all", tone: "blue", open: true },
    { id: "constraints", title: "Constraints", glyph: "codicon-warning", tone: "amber", open: false, list: true },
    { id: "completion", title: "Completion requirements", glyph: "codicon-checklist", tone: "purple", open: false, list: true },
  ];

  /** The draft on screen, as last drawn: a push of the same one changes nothing. */
  let previewSignature;
  /** Sections the developer opened or closed, for the mode being read. */
  let previewSectionsOpen = {};

  function renderPreviewView(draft, catalog) {
    if (!draft) return;
    // The list's glyph for the same mode (§37.116). Outside the signature: a
    // copy's comes from its origin, which a catalog refresh can bring.
    byId("preview-icon").className = `codicon ${modeIcon(draft, draft.source, catalog)} preview-icon mode-icon`;
    const signature = JSON.stringify(draft);
    if (signature === previewSignature) return;
    const sameMode = previewSignature !== undefined && JSON.parse(previewSignature).id === draft.id && JSON.parse(previewSignature).source === draft.source;
    if (!sameMode) previewSectionsOpen = {};
    previewSignature = signature;

    byId("preview-heading").textContent = draft.name || draft.id;
    // The header holds the name to one line; the whole of it on hover.
    byId("preview-heading").title = draft.name || draft.id;
    // Who it belongs to, in a word beside the name: the only fact about it on
    // the page's face. A built-in is read-only, and its action says so.
    byId("preview-source").textContent = SOURCE_LABELS[draft.source] || draft.source || "";
    const description = byId("preview-description");
    description.textContent = draft.description || "";
    description.hidden = description.textContent === "";

    // What the page leaves out, closed at its foot: the id every prepared work
    // item records, the version a save is checked against, the type of work it
    // asks for, where the definition lives, and what it was copied from.
    const facts = [
      ["ID", draft.id],
      ["Version", draft.version === undefined ? "" : String(draft.version)],
      ["Type", draft.executionKind === "investigate" ? "Investigation only" : "Fix"],
      ["Source", SOURCE_LABELS[draft.source] || draft.source || ""],
    ];
    if (draft.basedOn) {
      facts.push([
        "Based on",
        `${draft.basedOn}${draft.basedOnVersion ? `, version ${draft.basedOnVersion}` : ""}`,
      ]);
    }
    const meta = byId("preview-meta");
    meta.replaceChildren();
    for (const [term, value] of facts) {
      if (!value) continue;
      const name = document.createElement("dt");
      name.textContent = term;
      const text = document.createElement("dd");
      text.textContent = value;
      meta.append(name, text);
    }
    if (!sameMode) byId("preview-details").open = false;

    const body = byId("preview-body");
    body.replaceChildren();
    for (const spec of PREVIEW_SECTIONS) body.append(previewSection(spec, draft[spec.id] || ""));
    renderPreviewActions(draft);
  }

  /**
   * One section: a disclosure whose summary is its glyph, its title (a heading)
   * and a chevron — and, while closed, one line of what it says. Opening it
   * shows all of it, exactly as written.
   */
  function previewSection(spec, text) {
    const section = document.createElement("details");
    section.className = "preview-section";
    section.id = `preview-section-${spec.id}`;
    section.open = spec.id in previewSectionsOpen ? previewSectionsOpen[spec.id] : spec.open;

    const summary = document.createElement("summary");
    summary.className = "preview-section-head";
    summary.id = `preview-section-head-${spec.id}`;
    const glyph = document.createElement("span");
    glyph.className = `codicon ${spec.glyph} preview-section-icon preview-tone-${spec.tone}`;
    glyph.setAttribute("aria-hidden", "true");
    const title = document.createElement("h3");
    title.className = "preview-section-title";
    title.textContent = spec.title;
    const chevron = document.createElement("span");
    chevron.className = "codicon codicon-chevron-down preview-chevron";
    chevron.setAttribute("aria-hidden", "true");
    // One line of a closed section, for the eye: a screen reader hears the
    // heading and "collapsed", and reads the whole text once it is opened.
    const snippet = document.createElement("span");
    snippet.className = "preview-snippet";
    snippet.setAttribute("aria-hidden", "true");
    snippet.textContent = firstLine(text);
    summary.append(glyph, title, chevron, snippet);
    // Toggled here, so the choice is remembered across a refresh of the same
    // mode; Enter and Space reach the summary as a click.
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      section.open = !section.open;
      previewSectionsOpen[spec.id] = section.open;
    });

    const content = document.createElement("div");
    content.className = "preview-section-body";
    const items = spec.list ? requirementItems(text) : [];
    if (items.length > 1) {
      const list = document.createElement("ul");
      list.className = "preview-list";
      for (const item of items) {
        const entry = document.createElement("li");
        entry.textContent = item;
        list.append(entry);
      }
      content.append(list);
    } else {
      const prose = document.createElement("p");
      prose.className = "preview-text";
      prose.textContent = text;
      content.append(prose);
    }
    section.append(summary, content);
    return section;
  }

  /** The start of a text, for a closed section's one line: its first line, cut by the stylesheet. */
  function firstLine(text) {
    const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "") || "";
    return line.length > 240 ? line.slice(0, 240) : line;
  }

  /**
   * A requirements text as its separate requirements, without changing a word:
   * its own lines when it has several (a leading "-", "*" or "•" dropped, as a
   * list item's mark), else its sentences when there are several, else nothing
   * — one sentence stays prose. Joined back, the items are the text.
   */
  function requirementItems(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length > 1) return lines.map((line) => line.replace(/^[-*•]\s+/, ""));
    const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
    return sentences.length > 1 ? sentences : [];
  }

  /**
   * What can be done to the mode being read, in the header at its right.
   *
   * The list row's actions, all on the page — no ⋯ (§37.116): a built-in is
   * copied, never written — Customize copy; a custom mode is edited,
   * duplicated or deleted. Addressed by `source` — the scope that actually
   * owns the definition — because `scope` on a draft is where a *save* would
   * go and is never `builtin`.
   */
  function renderPreviewActions(draft) {
    const actions = byId("preview-actions");
    actions.replaceChildren();
    previewDuplicate = undefined;
    const scope = draft.source;
    const name = draft.name || draft.id;
    // The page is already the view, so View is the one action it leaves out.
    for (const action of modeActions(scope).filter((entry) => entry !== "view")) {
      const element = document.createElement("button");
      element.type = "button";
      element.id = action === "duplicate" && scope === "builtin" ? "preview-customize" : `preview-${action}`;
      element.className = action === "delete" ? "preview-primary preview-danger" : "preview-primary";
      element.title = modeActionName(action, scope, name);
      element.setAttribute("aria-label", modeActionName(action, scope, name));
      // Destructive, and said so to a screen reader as well as by its glyph.
      if (action === "delete") element.setAttribute("aria-describedby", "manage-delete-help");
      const icon = document.createElement("span");
      icon.className = `codicon ${MODE_ACTION_ICONS[action]}`;
      icon.setAttribute("aria-hidden", "true");
      const words = document.createElement("span");
      words.textContent = modeActionLabel(action, scope);
      element.append(icon, words);
      element.addEventListener("click", () => runModeAction(action, scope, draft.id, "preview"));
      // Back from a copy made here lands on the action that made it.
      if (action === "duplicate") previewDuplicate = element;
      actions.append(element);
    }
  }

  /**
   * The list's three groups, in order (§37.114). The note is a word on the
   * group's own line; the sentence it stands for is the heading's tooltip.
   */
  const MANAGE_GROUPS = [
    { scope: "builtin", label: "Built-in", note: "Read-only", help: "Packaged with BugPilot. Read-only.", empty: "No built-in Fix Modes." },
    { scope: "user", label: "User", note: "Personal", help: "Yours, in your home directory.", empty: "No user Fix Modes yet." },
    { scope: "project", label: "Project", note: "Shared", help: "This repository's, shareable with the team.", empty: "No project Fix Modes yet." },
  ];

  /**
   * Each built-in mode's glyph, by its id (§37.116) — the one place the
   * extension names built-in modes, and only to draw them. A value here is a
   * codicon and nothing else, so the table can mark a row but never decide
   * what a mode does or which modes exist. A mode it does not know — a
   * project's own, or a built-in added later — gets its kind's glyph, which is
   * the worst an omission can do. test/fixModes.test.ts allows this table and
   * no other list of ids. Each glyph's tint is the stylesheet's.
   */
  const BUILTIN_MODE_ICONS = {
    "standard": "codicon-tasklist",
    "conservative": "codicon-shield",
    "investigate-first": "codicon-search",
    "test-driven": "codicon-beaker",
    "deep-analysis": "codicon-graph",
  };

  /**
   * A mode with no known origin: its kind's glyph — the search an
   * investigation shares with Investigate First, a lightbulb for any other.
   * Full class names, so the declared-glyphs test sees each one.
   */
  const MODE_KIND_ICONS = { fix: "codicon-lightbulb", investigate: "codicon-search" };

  /**
   * A mode's glyph: a built-in's own; a copy's, its origin's — through copies
   * of copies, as far as the catalog knows them; otherwise its kind's. Nothing
   * is guessed from a name. `basedOn` is an id without a scope, so an origin is
   * looked for among the built-ins first: a copy of Conservative Fix keeps the
   * shield even where a user mode reuses that id.
   */
  function modeIcon(mode, scope, catalog) {
    const seen = new Set();
    let at = { mode, scope };
    while (at && !seen.has(`${at.scope}/${at.mode.id}`)) {
      seen.add(`${at.scope}/${at.mode.id}`);
      if (at.scope === "builtin") {
        if (Object.prototype.hasOwnProperty.call(BUILTIN_MODE_ICONS, at.mode.id)) return BUILTIN_MODE_ICONS[at.mode.id];
        break;
      }
      at = modeOrigin(at.mode.basedOn, catalog);
    }
    return MODE_KIND_ICONS[mode.executionKind] || MODE_KIND_ICONS.fix;
  }

  /** The mode a copy was made from, if the catalog still has one with that id. */
  function modeOrigin(id, catalog) {
    if (!id || !catalog || catalog.kind !== "ready") return undefined;
    for (const scope of ["builtin", "project", "user"]) {
      const mode = (catalog[scope] || []).find((entry) => entry.id === id);
      if (mode) return { mode, scope };
    }
    return undefined;
  }

  /**
   * What each row offers, every action on the row itself (§37.116): a built-in
   * is read and copied; a custom mode — user or project, the same permissions —
   * is edited, copied and deleted. A custom mode is read through Edit, which
   * shows every field, and Cancel leaves it as it was.
   */
  const MODE_ACTIONS = { builtin: ["view", "duplicate"], custom: ["edit", "duplicate", "delete"] };

  function modeActions(scope) {
    return MODE_ACTIONS[scope === "builtin" ? "builtin" : "custom"];
  }

  /** The glyph an action keeps when a narrow row drops its word, and has on a mode's page. */
  const MODE_ACTION_ICONS = { edit: "codicon-edit", duplicate: "codicon-copy", delete: "codicon-trash" };

  /**
   * An action's weight on the row: Customize copy and Edit are what a row is
   * for; View and Duplicate are quieter; Delete is destructive, and no larger.
   */
  function modeActionTone(action, scope) {
    if (action === "delete") return "danger";
    if (action === "edit" || (action === "duplicate" && scope === "builtin")) return "strong";
    return "quiet";
  }

  function modeActionLabel(action, scope) {
    // A built-in is never changed, only copied: the copy is what is customized (§37.115).
    if (action === "duplicate") return scope === "builtin" ? "Customize copy" : "Duplicate";
    return { view: "View", edit: "Edit", delete: "Delete" }[action];
  }

  /** An action's name for a screen reader and its tooltip: what it does, to which mode. */
  function modeActionName(action, scope, name) {
    if (action === "duplicate" && scope === "builtin") return `Customize a copy of ${name}`;
    return `${modeActionLabel(action, scope)} ${name}`;
  }

  /**
   * Which groups are open, by scope — only once the developer has opened or
   * closed one. Until then a group's default holds: Built-in open, User and
   * Project open while they have modes. Kept while the page lives, like the
   * Workflow Steps fold, so a catalog refresh does not undo it.
   */
  const manageGroupOpen = {};
  /** The list's own controls by key, for putting focus back after a rebuild. */
  let manageFocusables = new Map();

  function renderManageList(catalog, created) {
    const container = byId("manage-list");
    // A rebuild replaces every control, so whichever one had the focus is
    // found again by its key once the new one exists.
    const active = document.activeElement;
    const focusKey = active && active.getAttribute ? active.getAttribute("data-focus-key") : undefined;
    container.replaceChildren();
    createdRow = undefined;
    manageFocusables = new Map();
    if (catalog.kind !== "ready") return;
    const current = byId("fixModeId").value || "";
    for (const group of MANAGE_GROUPS) {
      const modes = catalog[group.scope] || [];
      const holdsCreated = Boolean(created && created.scope === group.scope && modes.some((mode) => mode.id === created.id));
      // A created mode's group opens, or the row it lands on could not be shown.
      if (holdsCreated) manageGroupOpen[group.scope] = true;
      const section = document.createElement("details");
      section.className = "manage-group";
      section.id = `manage-group-${group.scope}`;
      section.open =
        group.scope in manageGroupOpen ? manageGroupOpen[group.scope] : group.scope === "builtin" || modes.length > 0;

      const summary = document.createElement("summary");
      summary.className = "manage-group-head";
      summary.id = `manage-group-head-${group.scope}`;
      summary.title = group.help;
      summary.setAttribute("data-focus-key", `group:${group.scope}`);
      manageFocusables.set(`group:${group.scope}`, summary);
      const title = document.createElement("span");
      title.className = "manage-group-title";
      title.textContent = `${group.label} (${modes.length})`;
      const note = document.createElement("span");
      note.className = "manage-group-note";
      note.textContent = group.note;
      summary.append(title, note);
      // Toggled here rather than left to the element, so the state that is
      // remembered is the one that was chosen, never one a render set.
      summary.addEventListener("click", (event) => {
        event.preventDefault();
        section.open = !section.open;
        manageGroupOpen[group.scope] = section.open;
      });
      section.append(summary);

      if (modes.length === 0) {
        const empty = document.createElement("p");
        empty.className = "manage-empty";
        empty.textContent = group.empty;
        section.append(empty);
      } else {
        const list = document.createElement("div");
        list.className = "manage-rows";
        list.setAttribute("role", "list");
        list.setAttribute("aria-labelledby", `manage-group-head-${group.scope}`);
        for (const mode of modes) list.append(manageRow(group.scope, mode, created, current, catalog));
        section.append(list);
      }
      container.append(section);
    }
    for (const issue of catalog.issues || []) {
      const card = document.createElement("p");
      card.className = "error";
      // Path and reason both: the developer has to be able to find the file.
      card.textContent = `${issue.scope}: ${issue.path} — ${issue.message}`;
      container.append(card);
    }
    if (focusKey && manageFocusables.has(focusKey)) focusElement(manageFocusables.get(focusKey));
  }

  /**
   * Which scope's definition of `mode.id` runs instead of this one: the
   * project's over the user's over a built-in, as the registry resolves them.
   */
  function overriddenBy(scope, mode, catalog) {
    if (mode.effective) return undefined;
    for (const other of ["project", "user"]) {
      if (other === scope) break;
      if ((catalog[other] || []).some((entry) => entry.id === mode.id && entry.effective)) return other;
    }
    return undefined;
  }

  /**
   * One mode (§37.116): its glyph; its name, with Current or Overridden beside
   * it; one line of what it is for with the row's actions at its right — under
   * it, still at the right, when the row is too narrow for both; then
   * Investigation only, when it is.
   *
   * The name is the row's label. The id and the version are not on the row —
   * neither helps choose a mode, and both are in the preview.
   */
  function manageRow(scope, mode, created, current, catalog) {
    const key = `${scope}/${mode.id}`;
    const row = document.createElement("div");
    row.className = "manage-row";
    row.setAttribute("role", "listitem");
    // Id *and* scope: the same id can exist in both the user and the project
    // scope, and only the pair says which of the two rows is the new one.
    if (created && created.id === mode.id && created.scope === scope) {
      row.className = "manage-row recently-created";
      createdRow = row;
    }
    const nameId = `manage-name-${scope}-${mode.id}`;
    row.setAttribute("aria-labelledby", nameId);

    const icon = document.createElement("span");
    icon.className = `codicon ${modeIcon(mode, scope, catalog)} manage-icon mode-icon`;
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("div");
    text.className = "manage-text";
    const head = document.createElement("div");
    head.className = "manage-title";
    const title = document.createElement("p");
    title.className = "manage-name";
    title.id = nameId;
    title.textContent = mode.name || mode.id;
    head.append(title);
    // Words, not colour or position: which mode runs is the thing that is
    // easy to get wrong when two scopes share an id. Beside the name, away
    // from the actions, so neither competes with the other.
    if (current && mode.id === current && mode.effective) {
      const badge = manageBadge("Current");
      badge.id = `manage-current-${scope}-${mode.id}`;
      head.append(badge);
      // Announced with the row, not only read inside it: in its name, and as
      // its state for a reader that knows aria-current.
      row.setAttribute("aria-labelledby", `${nameId} ${badge.id}`);
      row.setAttribute("aria-current", "true");
    }
    const winner = overriddenBy(scope, mode, catalog);
    if (winner) head.append(manageBadge(`Overridden by ${winner}`));

    const line = document.createElement("div");
    line.className = "manage-line";
    const description = document.createElement("p");
    description.className = "manage-description";
    // The mode's own words, built-in or the developer's, never rewritten: one
    // line here, whole on hover and in the preview.
    description.textContent = mode.description || "";
    if (mode.description) description.title = mode.description;
    line.append(description, manageActions(scope, mode, key));
    text.append(head, line);
    // A kind that changes what the agent may do gets a line of its own, under
    // what the mode is for: on the row, never only in a tooltip.
    if (mode.executionKind === "investigate") {
      const kind = document.createElement("div");
      kind.className = "manage-kind";
      kind.append(manageBadge("Investigation only"));
      text.append(kind);
    }

    row.append(icon, text);
    return row;
  }

  function manageBadge(words) {
    const badge = document.createElement("span");
    badge.className = "manage-badge";
    badge.textContent = words;
    return badge;
  }

  /**
   * A row's actions, each a button of its own in the tab order — no menu to
   * open first (§37.116). Each is named with its mode. Duplicate and Delete
   * carry a glyph that a narrow row shows in place of the word.
   */
  function manageActions(scope, mode, key) {
    const actions = document.createElement("div");
    actions.className = "manage-actions";
    const name = mode.name || mode.id;
    for (const action of modeActions(scope)) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `manage-${action}-${scope}-${mode.id}`;
      button.className = `manage-action manage-action-${modeActionTone(action, scope)}`;
      button.setAttribute("data-action", action);
      button.setAttribute("aria-label", modeActionName(action, scope, name));
      button.title = modeActionName(action, scope, name);
      // Destructive, and said so to a screen reader as well as in colour.
      if (action === "delete") button.setAttribute("aria-describedby", "manage-delete-help");
      button.setAttribute("data-focus-key", `${key}:${action}`);
      manageFocusables.set(`${key}:${action}`, button);
      if (action === "duplicate" || action === "delete") {
        const glyph = document.createElement("span");
        glyph.className = `codicon ${MODE_ACTION_ICONS[action]} manage-action-glyph`;
        glyph.setAttribute("aria-hidden", "true");
        button.append(glyph);
      }
      const label = document.createElement("span");
      label.className = "manage-action-label";
      label.textContent = modeActionLabel(action, scope);
      button.append(label);
      button.addEventListener("click", () => runModeAction(action, scope, mode.id, "manager"));
      actions.append(button);
    }
    return actions;
  }

  /** What an action asks the host for: the same message from the list and from a mode's page. */
  function runModeAction(action, scope, id, origin) {
    // Remembered before the message goes out, so the New Fix Mode this opens
    // knows which of the two places it has to come back to.
    if (action === "duplicate") duplicateOrigin = origin;
    vscode.postMessage({ type: "fixModeAction", action, id, scope });
  }

  /**
   * Which instruction sections the developer opened or closed, for the mode
   * being edited — kept through a refused save's push, dropped on the next
   * visit, which starts from the markup's defaults (§37.118).
   */
  let editorSectionsOpen = {};
  /** The refused save's message last brought into view, so a re-push does not move the page again. */
  let shownEditorError;

  /**
   * New Fix Mode and Edit Fix Mode (§37.118): one form, written for what is
   * being done. The title, the line under it, the helpers, which fields are
   * fixed and the primary action's words are the only differences; everything
   * else — the sections, the glyphs, the folds, the footer — is the same
   * markup. `fresh` is a visit's first render; later pushes keep its folds.
   */
  function renderEditor(draft, options) {
    byId("editor-preview-pane").hidden = true;
    if (!draft) {
      openDraft = undefined;
      shownEditorError = undefined;
      return;
    }
    const { catalog, message, fresh } = options || {};
    if (fresh) {
      editorSectionsOpen = {};
      shownEditorError = undefined;
    }
    openDraft = draft;
    // Two views, one form: the title and the way back are what tell them apart,
    // so a New Fix Mode can never be mistaken for an edit of the mode it copied.
    const creating = draft.intent === "create";
    byId("editor-title").textContent = creating ? "New Fix Mode" : "Edit Fix Mode";
    // Back's words are always "Back" (§37.120); where it goes — the list, or
    // the mode a copy was started from — is its tooltip and description.
    byId("editor-back").title =
      duplicateOrigin === "preview" ? "Back to Fix Mode Preview" : "Back to Fix Mode Manager";

    // What is being edited — or, for a new mode, what the page is for — and
    // where it came from, by name. The ids and the versions a save is checked
    // against stay in the model and are the lines' tooltips, not their text.
    const subject = byId("editor-subject");
    subject.textContent = creating ? "Create a custom AI fixing workflow." : draft.name;
    subject.classList.toggle("editor-subject-lede", creating);
    subject.title = creating ? "" : `${draft.id}, version ${draft.version}`;
    const origin = byId("editor-origin");
    const from = draft.basedOn ? modeOrigin(draft.basedOn, catalog) : undefined;
    origin.textContent = draft.basedOn ? `Based on ${(from && from.mode.name) || draft.basedOn}` : "";
    origin.title = draft.basedOn
      ? `${draft.basedOn}${draft.basedOnVersion ? `, version ${draft.basedOnVersion}` : ""}`
      : "";
    origin.hidden = !draft.basedOn;

    for (const field of EDITOR_TEXT) byId(`editor-${field}`).value = draft[field] ?? "";
    byId("editor-executionKind").value = draft.executionKind || "fix";
    byId("editor-scope").value = draft.scope || "user";

    // An id names the mode every prepared work item recorded, and a scope is
    // which directory the file lives in. Both are fixed once the mode exists;
    // changing either is a new mode, which is what Duplicate is for. A new
    // mode is not fixed yet, so its helpers say what to type and, as a
    // tooltip, what will become fixed — never that it already is.
    byId("editor-id").disabled = !creating;
    byId("editor-scope").disabled = !creating;
    const idHint = byId("editor-id-hint");
    idHint.textContent = creating ? "Lowercase letters, digits and hyphens." : "Fixed once the mode exists.";
    idHint.title = creating
      ? "The ID can't be changed after the Fix Mode is created."
      : "Lowercase letters, digits and hyphens. Duplicate the mode to use another ID.";
    const scopeNote = creating
      ? "Scope can't be changed after creation. Duplicate the mode to move it later."
      : "Fixed once the mode exists. Duplicate it to move it.";
    const scopeHint = byId("editor-scope-hint");
    scopeHint.textContent = scopeNote;
    // Still the select's description when hidden; only an edit shows it.
    scopeHint.hidden = creating;
    byId("editor-scope").title = creating ? scopeNote : "";
    byId("editor-save-label").textContent = creating ? "Create Fix Mode" : "Save Fix Mode";
    byId("editor-save-icon").className = `codicon ${creating ? "codicon-add" : "codicon-save"}`;

    for (const section of EDITOR_SECTIONS) {
      byId(`field-editor-${section}`).open =
        section in editorSectionsOpen ? editorSectionsOpen[section] : EDITOR_OPEN_DEFAULTS[section];
      editorSnippet(section);
    }
    renderEditorError(message || "");
    growEditor();
  }

  /** Whether each section starts open, as the markup says (§37.118). */
  const EDITOR_OPEN_DEFAULTS = Object.fromEntries(
    EDITOR_SECTIONS.map((section) => [section, Boolean(byId(`field-editor-${section}`).open)]),
  );

  /**
   * A closed section's one line: the start of what it says, cut by the
   * stylesheet — or, empty, that it is empty, so a closed section never looks
   * like a header with nothing behind it and never shows text it does not have.
   */
  function editorSnippet(section) {
    const snippet = byId(`editor-${section}-snippet`);
    const line = firstLine(byId(`editor-${section}`).value || "");
    snippet.textContent = line || `No ${SECTION_LABELS[section].toLowerCase()} yet`;
    snippet.classList.toggle("editor-snippet-empty", !line);
  }

  function growEditor() {
    for (const id of EDITOR_GROWING) grow(byId(id));
  }

  /**
   * The field a refused save was about, when core's message names one —
   * "Fix Mode field 'constraints' must not be empty.", "Invalid Fix Mode id
   * …", "A user Fix Mode 'x' already exists". Read, never rewritten: the
   * message is shown as core wrote it.
   */
  function editorFieldOf(message) {
    const named = /Fix Mode field '([A-Za-z_]+)'/.exec(message);
    if (named && EDITOR_TEXT.includes(named[1])) return named[1];
    if (/Fix Mode id\b|Fix Mode '[^']*' already exists/.test(message)) return "id";
    return undefined;
  }

  /**
   * A refused save, where the developer can act on it (§37.118): under the
   * field it names — marked invalid, its section opened if it was folded, the
   * focus on it and the page scrolled to it once per new message — or, naming
   * none, at the top as before. Validation itself is core's, unchanged.
   */
  function renderEditorError(message) {
    const field = message ? editorFieldOf(message) : undefined;
    for (const id of [...EDITOR_TEXT, "executionKind", "scope"]) {
      const mine = id === field;
      const error = byId(`editor-${id}-error`);
      error.textContent = mine ? message : "";
      error.hidden = !mine;
      byId(`field-editor-${id}`).classList.toggle("field-invalid", mine);
      byId(`editor-${id}`).setAttribute("aria-invalid", mine ? "true" : "false");
    }
    if (field) byId("editor-error").hidden = true;
    if (field && EDITOR_SECTIONS.includes(field)) {
      byId(`field-editor-${field}`).open = true;
      editorSectionsOpen[field] = true;
    }
    if (message && message !== shownEditorError) {
      if (field) {
        const control = byId(`editor-${field}`);
        if (typeof control.focus === "function") control.focus({ preventScroll: true });
        scrollIntoView(byId(`editor-${field}-error`), "center");
      } else {
        scrollIntoView(byId("editor-error"), "center");
      }
    }
    shownEditorError = message || undefined;
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
  byId("preview-back").addEventListener("click", () => {
    // The same message an editor's Cancel sends; this one means the list.
    pendingReturn = undefined;
    vscode.postMessage({ type: "manageFixModes" });
  });
  byId("editor-back").addEventListener("click", leaveEditor);
  byId("editor-cancel").addEventListener("click", leaveEditor);
  byId("editor-preview").addEventListener("click", renderPreview);
  byId("editor-save").addEventListener("click", () => {
    // Set before the save goes out: a successful one closes the editor, and by
    // then the only record of where this started is here.
    if (duplicateOrigin === "preview") pendingReturn = "preview";
    vscode.postMessage({ type: "saveFixMode", draft: readDraft() });
  });
  // A section folds from its header, Enter and Space included (they reach the
  // summary as a click). Toggled here, not by the element, so the choice is the
  // one remembered; folding is presentation only — the box keeps its text, and
  // Save and Preview read every section whether open or not.
  for (const section of EDITOR_SECTIONS) {
    const details = byId(`field-editor-${section}`);
    byId(`editor-${section}-head`).addEventListener("click", (event) => {
      event.preventDefault();
      details.open = !details.open;
      editorSectionsOpen[section] = details.open;
      // Opened, the box has a layout to grow to at last; closed, its one line
      // says what it now holds.
      if (details.open) grow(byId(`editor-${section}`));
      else editorSnippet(section);
    });
  }
  byId("fix-mode-editor-view").addEventListener("input", (event) => grow(event.target));

  /**
   * Keyboard focus that lands behind a page's sticky header or footer is
   * brought clear of both (§37.120). Chromium scrolls a focused control into
   * view only when it is off screen; one under a sticky bar is on screen to it,
   * and the scroll padding that keeps `scrollIntoView` clear of the bars is not
   * consulted (measured: Implementation focused with its top 35px under the
   * header, no scroll). So after a Tab the page does it — the nearest edge, or
   * the control's top, where the caret is, when it is taller than the room
   * between the bars. Only for Tab: a click lands where the pointer is, and
   * moving the page under it would be the opposite of help.
   */
  let tabbing = false;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") tabbing = true;
  }, true);
  document.addEventListener("pointerdown", () => {
    tabbing = false;
  }, true);
  document.addEventListener("focusin", (event) => {
    if (!tabbing) return;
    tabbing = false;
    keepClearOfBars(event.target);
  });

  function keepClearOfBars(element) {
    if (!element || typeof element.closest !== "function" || typeof element.getBoundingClientRect !== "function") return;
    const view = element.closest(".view");
    const header = view && view.querySelector(".page-header");
    if (!header || header.contains(element)) return;
    const footer = view.querySelector(".editor-footer, .settings-actions");
    if (footer && footer.contains(element)) return;
    const top = header.getBoundingClientRect().bottom;
    const bottom = footer ? footer.getBoundingClientRect().top : window.innerHeight;
    const box = element.getBoundingClientRect();
    if (box.top >= top && box.bottom <= bottom) return;
    element.scrollIntoView({ block: box.height > bottom - top ? "start" : "nearest" });
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
    // in a one-line field — is not a request to prepare the bug.
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
    // The Verification Evidence form: its buttons by id, its rows by
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
    if (event.target && event.target.id === "issue") {
      applySourceVisibility();
      sayIssueKindLater();
    }
    formChanged();
  });

  // The Issue's height follows its text, and its text wraps by width: dragging
  // the sidebar narrower can turn one line into three, with nothing typed to
  // re-measure it. So a change of width re-measures — never a change of height,
  // which is what `grow` itself makes, and a frame later where frames exist, so
  // the resize this causes is not one the observer is still delivering.
  if (typeof ResizeObserver === "function") {
    let issueWidth = byId("issue").clientWidth;
    new ResizeObserver(() => {
      const width = byId("issue").clientWidth;
      if (width === issueWidth) return;
      issueWidth = width;
      const regrow = () => grow(byId("issue"));
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(regrow);
      else regrow();
    }).observe(byId("issue"));
  }

  // The same for the Fix Mode editor's boxes (§37.118): dragging the sidebar
  // with the editor open left them sized for the old width — text hidden
  // behind a box's own scrollbar when narrower, blank lines when wider
  // (measured in the real window). One observer on the view, by width alone.
  if (typeof ResizeObserver === "function") {
    let editorWidth = byId("fix-mode-editor-view").clientWidth;
    new ResizeObserver(() => {
      const width = byId("fix-mode-editor-view").clientWidth;
      if (width === editorWidth) return;
      editorWidth = width;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(growEditor);
      else growEditor();
    }).observe(byId("fix-mode-editor-view"));
  }

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
  // An instruction row's Edit asks the host, which reads the file and opens the
  // editor; the page names the scope, never a path.
  for (const scope of ["user", "project"]) {
    byId(`${scope}-instructions-edit`).addEventListener("click", () => {
      instructionsReturn = `${scope}-instructions-edit`;
      vscode.postMessage({ type: "openInstructions", scope });
    });
  }
  byId("instructions-back").addEventListener("click", closeInstructionsEditor);
  byId("instructions-cancel").addEventListener("click", closeInstructionsEditor);
  byId("instructions-save").addEventListener("click", saveInstructionsEditor);
  byId("instructions-text").addEventListener("input", renderInstructionsCount);
  byId("instructions-editor-view").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveInstructionsEditor();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeInstructionsEditor();
    }
  });
  // Its fields are not the form's: typing there grows the box and updates what
  // depends on it on the page, and sends nothing until Apply.
  byId("workflow-settings-view").addEventListener("input", (event) => grow(event.target));
  byId("workflow-settings-view").addEventListener("change", (event) => {
    const target = event.target;
    if (target && target.id === "agent") applyAgentVisibility();
    if (target && target.id === "repositoryProfile") applyRepositoryVisibility();
    if (target && target.id === "branchNaming") applyBranchNamingVisibility();
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
  // Reset Session: always on offer; it only opens the question.
  byId("menu-resetSession").addEventListener("click", () => {
    closeMoreMenu(false);
    openResetDialog();
  });
  byId("reset-confirm").addEventListener("click", confirmReset);
  byId("reset-cancel").addEventListener("click", () => {
    if (byId("reset-cancel").getAttribute("aria-disabled") === "true") return;
    closeResetDialog("more-actions");
  });
  for (const id of ["reset-keep", "reset-delete"]) byId(id).addEventListener("change", renderResetDialog);
  // Escape is Cancel — not while the host is resetting, which cannot be undone
  // half-way. Both the key and the browser's own close request, one path.
  const cancelReset = (event) => {
    event.preventDefault();
    if (!sessionReset.busy) closeResetDialog("more-actions");
  };
  byId("reset-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelReset(event);
  });
  byId("reset-dialog").addEventListener("cancel", cancelReset);
  // Closed by the browser anyway (it may insist on a second Escape): in step.
  byId("reset-dialog").addEventListener("close", () => {
    resetRequested = false;
  });

  // Jira Setup (§37.124).
  byId("jira-save").addEventListener("click", saveJiraSetup);
  byId("jira-cancel").addEventListener("click", cancelJiraSetup);
  byId("jira-token-reveal").addEventListener("click", () => {
    showJiraToken(byId("jira-token").type === "password");
  });
  // A fixed page of the host's: the page names no address.
  byId("jira-token-page").addEventListener("click", () =>
    vscode.postMessage({ type: "action", id: "openJiraTokenPage" }),
  );
  // Enter in the site goes on to the email, Enter in the email to the token;
  // Enter in the token saves, through the same check as the button. Nothing
  // else in the dialog saves on Enter.
  byId("jira-site").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    byId("jira-email").focus();
  });
  byId("jira-email").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    byId("jira-token").focus();
  });
  byId("jira-token").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    saveJiraSetup();
  });
  // Escape is Cancel — not while saving. The key and the browser's own close
  // request, one path; the focus stays in the dialog while it is open: Tab
  // from Save comes back to the email, Shift+Tab from the email goes to Save.
  const cancelJira = (event) => {
    event.preventDefault();
    cancelJiraSetup();
  };
  byId("jira-dialog").addEventListener("cancel", cancelJira);
  byId("jira-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cancelJira(event);
      return;
    }
    if (event.key !== "Tab") return;
    const stops = [...byId("jira-dialog").querySelectorAll("input, button, summary")].filter(
      (element) => element.getClientRects().length > 0 && !element.disabled,
    );
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  // Closed by the browser anyway (a second Escape it insists on): the host is
  // told, as for Cancel, and nothing typed survives.
  byId("jira-dialog").addEventListener("close", () => {
    if (byId("jira-dialog").open) return;
    clearJiraFields();
    if (jiraSetupOpenFor !== undefined && jiraSetupDismissed !== jiraSetupOpenFor) {
      jiraSetupDismissed = jiraSetupOpenFor;
      vscode.postMessage({ type: "closeJiraSetup" });
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
  // The progress card: details open and close in place; Cancel Review asks the
  // host, which asks the developer before it ends anything.
  byId("review-details-toggle").addEventListener("click", () => {
    if (byId("review-progress").hidden) return;
    reviewDetailsOpen = !reviewDetailsOpen;
    renderReviewDetailsToggle();
  });
  byId("cancel-review").addEventListener("click", () => {
    if (!byId("cancel-review").hidden) vscode.postMessage({ type: "action", id: "cancelReview" });
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
  // Verification Evidence. Record opens the form with one row; Edit
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
  // Done closes the form. Nothing is saved by it that auto-save would not
  // save: a change still waiting is saved now, and the form closes once the
  // host says it is saved — or stays open, with the reason, if it could not be.
  byId("done-verification").addEventListener("click", () => {
    if (byId("verification-editor").hidden) return;
    const step = lastFixResult;
    const state = step && step.verificationAutosave ? step.verificationAutosave.state : "";
    const typed = verificationRows.some((row) => {
      const check = readVerificationRow(row);
      return [check.name, check.procedure, check.evidence, check.notes].some((field) => field.trim() !== "");
    });
    if (!typed) {
      // Nothing was entered: nothing to keep, no report to write.
      vscode.postMessage({ type: "discardVerificationDraft" });
      finishVerificationEditing(step);
      return;
    }
    if (state === "dirty" || state === "saving") {
      verificationClosing = true;
      if (state === "dirty") vscode.postMessage({ type: "flushVerification" });
      return;
    }
    if (state === "" || state === "saved") finishVerificationEditing(step);
    // Incomplete, failed or in conflict: the form stays, and the status says why.
  });
  byId("retry-verification-save").addEventListener("click", () => {
    if (!byId("retry-verification-save").hidden) vscode.postMessage({ type: "flushVerification" });
  });
  byId("reload-verification").addEventListener("click", () => {
    if (!byId("reload-verification").hidden) vscode.postMessage({ type: "action", id: "editVerification" });
  });
  byId("overwrite-verification").addEventListener("click", () => {
    if (!byId("overwrite-verification").hidden) vscode.postMessage({ type: "overwriteVerification" });
  });
  byId("verification-editor").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      // Save now, rather than after the pause.
      event.preventDefault();
      vscode.postMessage({ type: "flushVerification" });
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
  // Ctrl+V / Cmd+V on the settings page: an image or a file on the clipboard
  // becomes an attachment. Not inside a text box — there it is that box's own
  // paste — and plain text is never an attachment.
  document.addEventListener("paste", (event) => {
    // On the settings page itself: not behind an instruction editor laid over it.
    if (!settingsOpen || activeView !== "settings" || editable(event.target)) return;
    const files = filesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attachFiles(files, "paste");
  });
  const dropZone = byId("field-attachments");
  const carriesFiles = (event) => Boolean(event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files"));
  dropZone.addEventListener("dragover", (event) => {
    if (!carriesFiles(event) || byId("add-attachment").disabled) return;
    event.preventDefault();
    dropZone.classList.toggle("drop-target", true);
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.toggle("drop-target", false));
  dropZone.addEventListener("drop", (event) => {
    dropZone.classList.toggle("drop-target", false);
    const files = filesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void attachFiles(files, "drop");
  });
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
    applyStepBoxes();
    growAll();
  }
  vscode.postMessage({ type: "ready" });
})();
