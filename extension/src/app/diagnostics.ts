/**
 * What BugPilot is configured with, for the developer who is not sure: the
 * rows of Results > Diagnostics (§37.110). They were a disclosure at the foot of
 * the Workflow panel, with a version-and-path footer under it; both moved here,
 * where reference information belongs, and Workflow kept only the Jira row —
 * the one fact here that is also something to act on.
 *
 * On a machine with a pipx copy of the CLI and a checkout of it, two
 * repositories open and an agent that may or may not be on PATH, "why did that
 * behave like that" is usually a configuration question. This answers it from
 * state the extension already holds.
 *
 * **Nothing here checks anything.** No request, no probe, no directory read, no
 * timer. That rule is why the wording is what it is: "Configured" means a
 * credential is stored, and if this said "Connected" it would be claiming
 * something nobody asked Jira about. The same goes for the agent — "Not
 * checked" until a handoff actually resolves one, because resolution costs a
 * process per candidate and opening a disclosure must not spend that.
 *
 * Read-only by construction: this module produces values, and the tree rows
 * that show them have no command and no menu. Jira is set from the Workflow
 * row; its line here says where.
 */

import type { CliSource } from "../executable.ts";
import type { RuntimeStatus } from "../managedRuntime.ts";
import { AGENT_LABELS } from "./agents.ts";
import type { Source } from "./form.ts";
import { jiraConnection } from "./jiraConnection.ts";

/** One label and its value, as a row. */
export interface DiagnosticsRow {
  readonly label: string;
  readonly value: string;
  /** More about the value, for the tooltip: a path, or a qualifier. */
  readonly detail?: string;
  /** What the detail is, when it is a path: "Path", "Executable". */
  readonly detailLabel?: string;
}

/** Everything the panel is told about the environment. Strings, and only strings. */
export interface DiagnosticsView {
  readonly rows: readonly DiagnosticsRow[];
}

/**
 * How the agent stands, as typed state rather than as a sentence.
 *
 * `undefined` is "nothing has tried yet", which is the honest answer before a
 * handoff and the reason opening Diagnostics never triggers one.
 */
export type ResolvedAgent =
  | { readonly kind: "resolved"; readonly label: string }
  | { readonly kind: "unavailable" };

export interface DiagnosticsInput {
  /** The repository BugPilot runs in, absolute, when one is settled. */
  readonly root?: string | undefined;
  /** Which bugpilot is being run, and its version, when the probe answered. */
  readonly executable?: string | undefined;
  readonly cliVersion?: string | undefined;
  /** Where the bugpilot in use came from; `undefined` when none is usable. */
  readonly cliSource?: CliSource | undefined;
  /** BugPilot's managed runtime as the last environment check saw it. */
  readonly runtime?: RuntimeStatus | undefined;
  /** This extension's own version, which is a different number. */
  readonly extensionVersion?: string | undefined;
  /** Whether a Jira credential is stored. Not whether Jira works. */
  readonly jiraConfigured: boolean;
  /** Whether the last run this session that asked Jira was turned away. */
  readonly jiraRejected?: boolean;
  /** What the developer chose in Workflow Settings. */
  readonly agent: string;
  /** What a handoff actually resolved, if one has run. */
  readonly resolvedAgent?: ResolvedAgent | undefined;
  readonly workItemId?: string | undefined;
  readonly source: Source;
}

/** The agent picker's options, in the words the picker uses. */
const AGENT_NAMES: Readonly<Record<string, string>> = AGENT_LABELS;

/**
 * The rows, in the order they are read.
 *
 * Nothing optional is filled with a placeholder: a row whose value is not known
 * says so in neutral words, or is left out entirely. "Unknown error" is not a
 * state, and neither is a blank where a fact should be.
 */
export function diagnostics(input: DiagnosticsInput): DiagnosticsView {
  const rows: DiagnosticsRow[] = [];

  // The repository, by the name a developer calls it, with the full path
  // underneath for the case this exists for — two checkouts of the same thing.
  rows.push(
    input.root
      ? { label: "Repository", value: basename(input.root), detail: input.root, detailLabel: "Path" }
      : { label: "Repository", value: "No repository open" },
  );

  // The Workflow row's own words (§37.110), so the two can never disagree:
  // a credential is in SecretStorage, or is not, or Jira turned it away on the
  // last run. Saying "Connected" would claim an exchange nobody has had.
  rows.push({
    label: "Jira",
    value: jiraConnection(input.jiraConfigured, input.jiraRejected === true).status,
    detail: "Set up from the Jira row in Workflow",
  });

  rows.push({
    label: "AI agent",
    value: AGENT_NAMES[input.agent] ?? input.agent,
    detail: describeResolved(input.resolvedAgent),
  } as DiagnosticsRow);

  // Only once a run has established one. A hand-written bug's whole description
  // is not an identity and is not shown; the CLI mints its id at run time, and
  // until then there is nothing truthful to print.
  if (input.workItemId) {
    rows.push({
      label: "Work item",
      value: input.workItemId,
      detail: input.source === "manual" ? "From a bug description" : "From a Jira issue",
    });
  }

  if (input.extensionVersion) {
    rows.push({ label: "Extension", value: input.extensionVersion });
  }

  // The one that matters on a machine with more than one install, which is the
  // common case once a pipx copy and a checkout exist. Version *and* path: the
  // number says which release, the path says which copy.
  if (input.cliVersion || input.executable) {
    rows.push({
      label: "BugPilot CLI",
      value: input.cliVersion ?? "Version not known",
      ...(input.executable ? { detail: input.executable, detailLabel: "Executable" } : {}),
    });
  }

  // Which of the three places the CLI came from — the question a machine with
  // a pipx copy, a configured path and a managed runtime genuinely raises.
  // Unknown is left out rather than guessed: only a usable CLI has a source,
  // and no usable CLI at all is a fact worth a row.
  if (input.cliSource !== undefined) rows.push({ label: "CLI source", value: CLI_SOURCE_NAMES[input.cliSource] });
  else if (!input.executable) rows.push({ label: "CLI source", value: "Unavailable" });

  // The managed runtime by its state and version, and the Python it was built
  // with. No path: the runtime lives in the extension's own storage, and the
  // CLI row above already names the executable when it is the one in use.
  if (input.runtime) {
    const described = describeRuntime(input.runtime);
    rows.push({ label: "BugPilot runtime", value: described.value, ...(described.detail === undefined ? {} : { detail: described.detail }) });
  }

  // `detail: undefined` is not a detail; drop the key rather than ship a row
  // with a hole in it.
  return { rows: rows.map(compact) };
}

const CLI_SOURCE_NAMES: Readonly<Record<CliSource, string>> = {
  configured: "Configured path",
  managed: "BugPilot runtime",
  path: "PATH",
};

function describeRuntime(runtime: RuntimeStatus): { value: string; detail?: string } {
  switch (runtime.kind) {
    case "ready":
      return { value: `Ready · ${runtime.version}`, detail: `Python ${runtime.pythonVersion}` };
    case "not-installed":
      return { value: "Not installed", detail: `Would install bugpilot ${runtime.version}` };
    case "installing":
      return { value: "Installing…", detail: `bugpilot ${runtime.version}` };
    case "broken":
      return { value: "Not working", detail: runtime.detail };
    case "no-python":
      return { value: "Needs Python 3.10 or later", detail: "No Python found" };
    case "unsupported-python":
      return { value: "Needs Python 3.10 or later", detail: `Found Python ${runtime.found}` };
    case "install-failed":
      return { value: "Setup failed", detail: runtime.detail };
  }
}

function describeResolved(resolved: ResolvedAgent | undefined): string | undefined {
  if (!resolved) return "Not checked yet";
  return resolved.kind === "resolved" ? `Resolved: ${resolved.label}` : "Resolved: none available";
}

function compact(row: DiagnosticsRow): DiagnosticsRow {
  return row.detail === undefined ? { label: row.label, value: row.value } : row;
}

/**
 * A row's tooltip: the row in words, then its detail — "Repository: bugpilot",
 * "Path: /work/bugpilot". The path lives here and not on the row, so a long one
 * never makes the tree wide.
 */
export function diagnosticTooltip(row: DiagnosticsRow): string {
  const lines = [`${row.label}: ${row.value}`];
  if (row.detail !== undefined) lines.push(row.detailLabel ? `${row.detailLabel}: ${row.detail}` : row.detail);
  return lines.join("\n");
}

/** The last segment of a path, whichever separator wrote it. */
function basename(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? value;
}
