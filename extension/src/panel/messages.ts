/**
 * The messages that cross the webview boundary, and the validation of them.
 *
 * The panel is a separate JavaScript context that cannot import any of this
 * code, so the two sides communicate by `postMessage` only. That makes this a
 * real trust boundary, not an internal call: whatever arrives from the page is
 * untrusted input, and the host validates every field rather than casting.
 *
 * The division of labour follows from the same constraint. There is no bundler,
 * so the page cannot use `form.ts`, `progress.ts` or `artifacts.ts` — therefore
 * **the host computes and the page renders**. The page owns exactly one thing:
 * what the developer has typed but not yet run.
 */

import type { ProgressView } from "../app/progress.ts";
import type { FieldProblem, FormState, Source } from "../app/form.ts";
import { AGENT_CHOICES } from "../app/agents.ts";
import type { AgentChoice } from "../app/agents.ts";
import { WORKFLOW_STEP_IDS } from "../app/workflow.ts";
import type { OverallStatus, WorkflowStep } from "../app/workflow.ts";
import type { ArtifactList } from "../app/artifacts.ts";
import type { CommandAction } from "../app/environment.ts";
import { FIX_MODE_ID_RE } from "../app/form.ts";
import type { UserFacingError } from "../app/failures.ts";
import type { HandoffOutcome } from "../app/handoff.ts";
import { isSafeRelativePath } from "../app/contextSummary.ts";
import type { RelevantFile } from "../app/contextSummary.ts";
import { WRITABLE_SCOPES } from "../app/fixModes.ts";
import type {
  FixModeCatalog,
  FixModeDraft,
  ManagedFixModes,
  PreparedFixMode,
  WritableScope,
} from "../app/fixModes.ts";
import { FIX_MODE_ACTIONS } from "../app/controller.ts";
import type { FixModeActionId } from "../app/controller.ts";

/**
 * Upper bounds on incoming strings.
 *
 * Far above any legitimate input; they exist so a malformed or hostile message
 * cannot hand a multi-megabyte string to the argv builder or the state store.
 */
const CAPS: Readonly<Record<keyof FormTextFields, number>> = {
  issueKey: 128,
  title: 500,
  description: 200_000,
  hint: 20_000,
  keywords: 8_000,
  focusFiles: 16_000,
  ignorePaths: 16_000,
  maxFiles: 16,
  maxSearchLines: 16,
  agentCommand: 2_000,
  fixModeId: 64,
};

type FormTextFields = Omit<
  FormState,
  "source" | "plan" | "fresh" | "fixWithAI" | "agent" | "attachments" | "useIssueDetails"
>;

/**
 * The same ceiling `bugpilot/core/attachments.py` enforces.
 *
 * Duplicated rather than imported, like the Jira key pattern and the error
 * table: the two languages cannot share a constant, so a test reads the Python
 * source and compares.
 */
export const MAX_ATTACHMENTS = 10;

/** A plain file name: a letter or digit, then name characters. */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Host → page. One shape, so the page has a single render path. */
export interface PanelState {
  /**
   * Bumped whenever the host replaces the form.
   *
   * The page keeps ownership of the form while the developer types; without a
   * revision it could not tell "the host loaded a history item" from its own
   * echo, and would overwrite half-typed input on every state push.
   */
  readonly revision: number;
  readonly readiness: Readiness;
  /** Present only when the host is replacing what the page shows. */
  readonly form?: FormState;
  readonly problems: readonly FieldProblem[];
  readonly progress: ProgressView;
  /**
   * The six workflow rows, computed by the host.
   *
   * The page renders these into markup it already has — one static row per
   * step — rather than building the list itself. That keeps the checkbox in the
   * page's hands (it is form state) and the status in the host's (it is the
   * run's), which is the same division the rest of this file describes.
   */
  readonly workflow: readonly WorkflowStep[];
  /** The short line in the workflow header: "Ready to run", "Running 3/6…". */
  readonly overall: OverallStatus;
  readonly artifacts: ArtifactList;
  /**
   * Things worth saying before the first run, computed by the host.
   *
   * `doctor`'s report was carried into the controller from phase 5 and used for
   * nothing; this is what it is for. Not failures — the run will work — but
   * facts a developer would rather know now than after committing them.
   */
  readonly warnings: readonly Notice[];
  /** Whether a Jira credential is stored. Never the credential itself. */
  readonly jiraConfigured: boolean;
  /** Set when a previous attempt exists, which is what enables Retry. */
  readonly canRetry: boolean;
  readonly workItemId?: string;
  /**
   * The AI Fix Modes bugpilot offers, and whether they could be read at all.
   *
   * Computed by the host like everything else on this state: the page has no
   * way to spawn a process, and giving it one would make the webview the thing
   * that decides what a Fix Mode is.
   */
  readonly fixModes: FixModeCatalog;
  /**
   * What the *prepared* package was built with, when there is one.
   *
   * Separate from `form.fixModeId`, which is what the next run would use. The
   * two disagree the moment a developer changes the dropdown without running,
   * and reporting the new choice as though it had produced the package on disk
   * would misdescribe what the agent was told.
   */
  readonly preparedFixMode?: PreparedFixMode;
  /**
   * The Manage Fix Modes view, present only while it is open.
   *
   * Every physical definition rather than the effective list the selector uses:
   * a mode one scope shadows still has to be editable in the scope that owns it.
   */
  readonly manage?: ManageView;
  /** What the hint improver is doing, and what it has to show for it. */
  readonly hintImprovement?: HintImprovementView;
  /**
   * The finished package, when there is one to act on.
   *
   * Present is the whole signal: the page renders the result section when this
   * arrives and hides it when it does not, so "before the first run" needs no
   * empty card and no zero counts. The host decides — a run in flight and a run
   * that failed both leave it absent.
   */
  readonly contextReady?: ContextReadyView;
  /**
   * Why the last run did not finish, classified and worded for a human.
   *
   * Never present at the same time as `contextReady`: a run that failed did not
   * produce a package, and the two cards would be answering the same question
   * with opposite answers.
   */
  readonly runError?: UserFacingError;
  /**
   * Why the last handoff could not start.
   *
   * Deliberately *not* mutually exclusive with `contextReady`. The package is
   * built and every artifact action still works; only the agent would not
   * start. Clearing the result for that would make the developer rerun
   * retrieval to fix a PATH problem.
   */
  readonly handoffError?: UserFacingError;
}

/**
 * What a developer can do with a package that exists.
 *
 * Deliberately not the workflow rows in another arrangement. Those say what
 * each step did; this says what the run produced and what to press next, which
 * is the question a checklist could never answer.
 */
export interface ContextReadyView {
  /** One line of counts, or empty when neither artifact could be read. */
  readonly counts: string;
  /**
   * The mode the package on disk was prepared with, as one short line.
   *
   * The same string `preparedFixMode` produced before UI-A3 moved it here, for
   * the same reason: what the agent was actually told, never what the selector
   * happens to say now.
   */
  readonly strategy?: string;
  /** Which of the three artifact actions have their file. */
  readonly actions: readonly PanelAction[];
  /**
   * Whether pressing Fix with AI would do something that has not been done.
   *
   * False after a handoff that succeeded, which is what stops a second press
   * from producing a second terminal for the same run.
   */
  readonly canFix: boolean;
  /**
   * A handoff that started an agent, said out loud.
   *
   * Present only for a handoff that actually launched something. A skip is not
   * a quieter success: it is explained by `handoffError`, and the button stays.
   * The two are never both present, which a test pins.
   */
  readonly handoffOutcome?: HandoffOutcome;
  /** True while a handoff is being resolved, which spawns a probe. */
  readonly handoffBusy: boolean;
  /**
   * Which files the run found, in the order the artifact ranked them.
   *
   * Part of this view rather than a field of its own, which is what ties them
   * to one work item: a run in flight, a failed run and a freshly typed issue
   * all leave `contextReady` absent, so there is no path by which the previous
   * bug's files stay on screen.
   */
  readonly files: readonly RelevantFile[];
  /** How many the artifact held beyond `files`, when it held more. */
  readonly moreFiles?: number;
}

/**
 * A standing fact about this machine or repository, as its own card.
 *
 * Titled, because there is more than one of these and they are about different
 * things: joining them into one paragraph put a Jira misconfiguration under a
 * heading about repository files. The page renders one card per notice.
 */
export interface Notice {
  readonly title: string;
  readonly message: string;
}

export type Readiness =
  /**
   * The handshake is still running.
   *
   * A state of its own because §5.4 asks for it: rendering "checking" as a
   * warning card tells the developer something is wrong when nothing is, and
   * rendering it as ready would enable a Run that cannot work yet.
   */
  | { readonly kind: "checking" }
  | {
      readonly kind: "ready";
      readonly executable: string;
      readonly root: string;
      /** Shown with the path, so a machine with several installs is legible. */
      readonly version?: string;
    }
  | {
      readonly kind: "blocked";
      readonly summary: string;
      readonly action?: string;
      readonly actions: readonly CommandAction[];
    };

/**
 * The semantic actions the page may ask for.
 *
 * A fixed union rather than editor command ids: the page must not be able to
 * name a command in the editor, because a webview asking to run
 * `workbench.action.*` is a privilege it has no business having. The only
 * command ids it ever sends back are ones the host handed it in
 * `readiness.actions`, and those are re-checked against `COMMANDS` on arrival.
 */
export const PANEL_ACTIONS = [
  "openContext",
  "copyHandoff",
  "openFolder",
  "fixWithAI",
  "setCredentials",
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

/** Page → host, after validation. */
export type PanelMessage =
  | { readonly type: "ready" }
  | { readonly type: "run"; readonly form: FormState }
  | { readonly type: "stop" }
  | { readonly type: "retry" }
  | { readonly type: "formChanged"; readonly form: FormState }
  /**
   * "Open the file dialog and add what I choose."
   *
   * Carries the form for the same reason `run` does: the host's copy can be up
   * to one debounce interval stale, and merging onto a stale copy would
   * discard whatever was typed in that window.
   */
  | { readonly type: "addAttachments"; readonly form: FormState }
  | { readonly type: "action"; readonly id: PanelAction }
  | { readonly type: "command"; readonly id: string }
  | { readonly type: "openArtifact"; readonly name: string }
  /**
   * "Open this file from the Relevant Files list."
   *
   * A repository-relative path the *artifact* named, echoed back by the page.
   * Unlike `openArtifact`, whose names are plain files inside one directory,
   * this one has separators in it — so the host resolves it against the
   * repository root and refuses anything that lands outside, rather than
   * trusting a shape check made on the far side of the boundary.
   */
  | { readonly type: "openRelevantFile"; readonly path: string }
  | { readonly type: "improveHint"; readonly form: FormState }
  | { readonly type: "useImprovedHint" }
  | { readonly type: "dismissImprovedHint" }
  | { readonly type: "manageFixModes" }
  | { readonly type: "closeFixModes" }
  | {
      readonly type: "fixModeAction";
      readonly action: FixModeActionId;
      readonly id: string;
      readonly scope: string;
    }
  | { readonly type: "saveFixMode"; readonly draft: FixModeDraft };

/**
 * Validate a message from the page.
 *
 * Returns undefined for anything unrecognized — a dropped message is a
 * no-op, whereas trusting the shape means a missing field reaches the argv
 * builder as `undefined` and surfaces three layers away.
 */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
  const message = asRecord(raw);
  const type = message?.["type"];
  switch (type) {
    case "ready":
    case "stop":
    case "retry":
    case "improveHint": {
      // Carries the form for the same reason `run` does: the host's copy can be
      // one debounce interval stale, and the hint being improved is whatever is
      // on screen right now.
      const form = parseForm(message?.["form"]);
      return form ? { type: "improveHint", form } : undefined;
    }
    case "useImprovedHint":
    case "dismissImprovedHint":
    case "manageFixModes":
    case "closeFixModes":
      return { type };
    case "fixModeAction": {
      const action = message?.["action"];
      const id = asString(message?.["id"], 64);
      const scope = asString(message?.["scope"], 16);
      if (!(FIX_MODE_ACTIONS as readonly string[]).includes(action as string)) return undefined;
      if (id === undefined || !FIX_MODE_ID_RE.test(id)) return undefined;
      if (scope !== "builtin" && scope !== "user" && scope !== "project") return undefined;
      return { type, action: action as FixModeActionId, id, scope };
    }
    case "saveFixMode": {
      const draft = asDraft(message?.["draft"]);
      return draft ? { type, draft } : undefined;
    }
    case "run":
    case "formChanged":
    case "addAttachments": {
      const form = parseForm(message?.["form"]);
      return form ? { type, form } : undefined;
    }
    case "action": {
      const id = message?.["id"];
      return typeof id === "string" && (PANEL_ACTIONS as readonly string[]).includes(id)
        ? { type, id: id as PanelAction }
        : undefined;
    }
    case "command": {
      const id = asString(message?.["id"], 128);
      // Only ids the extension declares are ever executed; the host checks that
      // against COMMANDS, because a page could otherwise ask for any command in
      // the editor, including ones that write files.
      return id === undefined ? undefined : { type, id };
    }
    case "openRelevantFile": {
      const value = asString(message?.["path"], 1_024);
      // Shape here, boundary on the host: this says "a plausible relative
      // path", and the controller says "inside the repository", which is the
      // question only something that knows the root can answer.
      if (value === undefined || !isSafeRelativePath(value)) return undefined;
      return { type, path: value };
    }
    case "openArtifact": {
      const name = asString(message?.["name"], 256);
      // Artifact names are plain file names inside `.ai/<work_item>/`. Anything
      // else — a separator, `..`, an empty string, a bare `.` — either escapes
      // the directory or names the directory itself, and the host opens what it
      // is given.
      if (name === undefined || !ARTIFACT_NAME_RE.test(name)) return undefined;
      return { type, name };
    }
    default:
      return undefined;
  }
}

/**
 * The management view: what exists on disk, and the mode being looked at.
 *
 * Present only while the developer has it open, so the page has one thing to
 * check before rendering any of it.
 */
/**
 * The hint improver's whole visible state.
 *
 * `suggestion` is deliberately not the hint: it sits beside the field until the
 * developer takes it, so an improvement can never overwrite what they wrote.
 */
export interface HintImprovementView {
  readonly busy: boolean;
  readonly suggestion?: string;
  readonly error?: string;
  /** Said when the improvement ran without the issue text, and why. */
  readonly notice?: string;
}

export interface ManageView {
  readonly catalog: ManagedFixModes;
  /** The mode in the editor, if one is open. */
  readonly editor?: FixModeDraft;
  /** Why the last management command was refused. */
  readonly error?: string;
  /** The mode a create just wrote, for the page to confirm and point at. */
  readonly created?: CreatedFixMode;
}

/**
 * What a successful create wrote.
 *
 * Reported by the host from the draft it saved, rather than worked out by the
 * page from what happens to be selected or from a name: an id can exist in both
 * the user and the project scope, and only the pair says which row is the new
 * one.
 */
export interface CreatedFixMode {
  readonly id: string;
  readonly scope: string;
  readonly name: string;
}

/**
 * The upper bound on one section of a draft.
 *
 * Core enforces the real limit and is authoritative; this only stops a hostile
 * or broken page from handing megabytes to a temporary file. Deliberately the
 * same number, so a draft that passes here fails in core for a reason the
 * developer can act on rather than being silently truncated at a different one.
 */
export const MAX_FIX_MODE_SECTION = 12_000;

function asDraft(raw: unknown): FixModeDraft | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const intent = record["intent"];
  if (intent !== "create" && intent !== "edit" && intent !== "view") return undefined;
  const id = asString(record["id"], 64);
  // The same shape core accepts. Checked here because this value becomes a file
  // name in a directory BugPilot writes to, and a webview is untrusted input.
  if (id === undefined || !FIX_MODE_ID_RE.test(id)) return undefined;
  const scope = record["scope"];
  if (!(WRITABLE_SCOPES as readonly string[]).includes(scope as string)) return undefined;
  const executionKind = record["executionKind"];
  if (executionKind !== "fix" && executionKind !== "investigate") return undefined;
  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return undefined;
  const text = (field: string): string => asString(record[field], MAX_FIX_MODE_SECTION) ?? "";
  const basedOn = asString(record["basedOn"], 64);
  const basedOnVersion = record["basedOnVersion"];
  return {
    intent,
    id,
    name: text("name"),
    description: text("description"),
    executionKind,
    objective: text("objective"),
    investigation: text("investigation"),
    implementation: text("implementation"),
    verification: text("verification"),
    constraints: text("constraints"),
    completion: text("completion"),
    scope: scope as WritableScope,
    version,
    ...(basedOn && FIX_MODE_ID_RE.test(basedOn) ? { basedOn } : {}),
    ...(typeof basedOnVersion === "number" && Number.isInteger(basedOnVersion) && basedOnVersion > 0
      ? { basedOnVersion }
      : {}),
  };
}

function parseForm(raw: unknown): FormState | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const source = record["source"];
  if (source !== "jira" && source !== "manual") return undefined;

  const plan = asRecord(record["plan"]) ?? {};
  const text = (field: keyof FormTextFields): string =>
    asString(record[field], CAPS[field]) ?? "";

  const agent = record["agent"];
  return {
    source: source as Source,
    issueKey: text("issueKey"),
    title: text("title"),
    description: text("description"),
    hint: text("hint"),
    keywords: text("keywords"),
    focusFiles: text("focusFiles"),
    ignorePaths: text("ignorePaths"),
    maxFiles: text("maxFiles"),
    maxSearchLines: text("maxSearchLines"),
    agentCommand: text("agentCommand"),
    attachments: parseAttachments(record["attachments"]),
    // Shape-checked here rather than trusted: the page only offers ids the CLI
    // listed, but this is the untrusted side of the boundary and the value ends
    // up as a command-line flag. Anything else becomes "no selection", which
    // lets core apply its own default instead of failing the run.
    fixModeId: FIX_MODE_ID_RE.test(text("fixModeId")) ? text("fixModeId") : "",
    plan: {
      // Not negotiable: this is the input, and a page claiming otherwise is
      // either stale or lying.
      issueDetails: true,
      codeSearch: plan["codeSearch"] !== false,
      gitHistory: plan["gitHistory"] !== false,
      similarFixes: plan["similarFixes"] !== false,
      buildContext: plan["buildContext"] !== false,
    },
    // Opt-in, so an absent or malformed field means "do not involve a model" —
    // the safe reading of a message the host cannot vouch for.
    fixWithAI: record["fixWithAI"] === true,
    agent: (AGENT_CHOICES as readonly string[]).includes(agent as string)
      ? (agent as AgentChoice)
      : "auto",
    fresh: record["fresh"] === true,
    // Absent means on: the box ships ticked, and a page too old to send it
    // should not silently turn the issue context off.
    useIssueDetails: record["useIssueDetails"] !== false,
  };
}

/**
 * The checkbox ids the page uses, one per workflow step.
 *
 * A guard export: `test/panel.test.ts` compares these against the document, so
 * a step added to the model without a row in the markup fails a test instead of
 * silently never appearing.
 */
export const WORKFLOW_CHECKBOX_IDS: readonly string[] = WORKFLOW_STEP_IDS.map(
  (id) => `plan-${id}`,
);

/**
 * The attachment paths coming back from the page.
 *
 * The page only ever echoes paths the *host* put there — they originate in the
 * editor's file dialog, never in the webview — but this is still the untrusted
 * side of the boundary, so the list is bounded and every entry is a string.
 * The controller checks them again before they reach a command line.
 */
function parseAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .slice(0, MAX_ATTACHMENTS)
    .map((entry) => entry.slice(0, 4_096));
}

function asString(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Clamped rather than refused: the caps are far above real input, and
  // dropping a whole message because a paste was huge would look like the
  // panel had frozen.
  return value.length > cap ? value.slice(0, cap) : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
