/**
 * What BugPilot is configured with, for the developer who is not sure.
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
 * Read-only by construction: this module produces values, and the section that
 * renders them contains no control of any kind.
 */

import type { Source } from "./form.ts";

/** One label and its value, as a row. */
export interface DiagnosticsRow {
  readonly label: string;
  readonly value: string;
  /** Quieter text under the value: a path, or a qualifier. */
  readonly detail?: string;
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
  /** This extension's own version, which is a different number. */
  readonly extensionVersion?: string | undefined;
  /** Whether a Jira credential is stored. Not whether Jira works. */
  readonly jiraConfigured: boolean;
  /** What the developer chose in Workflow Settings. */
  readonly agent: string;
  /** What a handoff actually resolved, if one has run. */
  readonly resolvedAgent?: ResolvedAgent | undefined;
  readonly workItemId?: string | undefined;
  readonly source: Source;
}

/** The agent picker's options, in the words the picker uses. */
const AGENT_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto-detect",
  claude: "Claude Code",
  custom: "Custom command",
};

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
      ? { label: "Repository", value: basename(input.root), detail: input.root }
      : { label: "Repository", value: "No repository open" },
  );

  // Exactly what is known: a credential is in SecretStorage. Saying "Connected"
  // would claim an exchange nobody has had.
  rows.push({
    label: "Jira",
    value: input.jiraConfigured ? "Credentials configured" : "Credentials not configured",
  });

  rows.push({
    label: "AI agent",
    value: AGENT_LABELS[input.agent] ?? input.agent,
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

  // The one that matters on a machine with more than one install, which the
  // footer's own comment calls the common case. Version *and* path: the number
  // says which release, the path says which copy.
  if (input.cliVersion || input.executable) {
    rows.push({
      label: "BugPilot CLI",
      value: input.cliVersion ?? "Version not known",
      ...(input.executable ? { detail: input.executable } : {}),
    });
  }

  // `detail: undefined` is not a detail; drop the key rather than ship a row
  // with a hole in it.
  return { rows: rows.map(compact) };
}

function describeResolved(resolved: ResolvedAgent | undefined): string | undefined {
  if (!resolved) return "Not checked yet";
  return resolved.kind === "resolved" ? `Resolved: ${resolved.label}` : "Resolved: none available";
}

function compact(row: DiagnosticsRow): DiagnosticsRow {
  return row.detail === undefined ? { label: row.label, value: row.value } : row;
}

/** The last segment of a path, whichever separator wrote it. */
function basename(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? value;
}
