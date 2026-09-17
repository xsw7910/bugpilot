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
};

type FormTextFields = Omit<
  FormState,
  "source" | "plan" | "fresh" | "fixWithAI" | "agent" | "attachments"
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
  | { readonly type: "openArtifact"; readonly name: string };

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
      return { type };
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
