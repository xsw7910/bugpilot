/**
 * The AI Fix Modes the panel offers, discovered from bugpilot.
 *
 * The one rule this file exists to hold: **the extension does not know what the
 * modes are.** `bugpilot fix-mode list --json` is the source of truth, because
 * the registry behind it grows — a later phase adds project- and user-scoped
 * modes — and a list hard-coded here would silently omit them while looking
 * perfectly correct. That also rules out parsing the human `fix-mode list`
 * table: a column layout is not an API.
 *
 * What crosses into TypeScript is display metadata only. The six instruction
 * sections that actually drive an agent stay in core, where they are rendered
 * into `agent_task.md`; nothing here needs them and copying them would make
 * this a second definition of a Fix Mode.
 *
 * Which mode is the default is likewise answered by the CLI (`default_mode_id`)
 * rather than by a `"standard"` constant on this side.
 */

/** The `--json` discovery call. One place, so no layer invents its own spelling. */
export const FIX_MODE_LIST_ARGS: readonly string[] = ["fix-mode", "list", "--json"];

/** What an agent does with the package: fix it, or investigate and stop. */
export type ExecutionKind = "fix" | "investigate";

/** One mode, as much of it as a picker needs. */
export interface FixModeSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly source: string;
  readonly executionKind: ExecutionKind;
}

/**
 * The state of mode discovery, as the page renders it.
 *
 * `unavailable` carries a reason and never a substitute list: an older bugpilot
 * that has no Fix Modes must say so, not be handed five invented ones that the
 * CLI would then reject.
 */
export type FixModeCatalog =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly modes: readonly FixModeSummary[];
      readonly defaultModeId: string;
    }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * Whether the mode a package was prepared with can still be run.
 *
 * Three answers, not two. "The catalog says this mode is gone" and "the catalog
 * could not be read" look the same from a distance and mean opposite things:
 * the first is a deleted mode the developer has to replace, the second is a
 * question nobody has answered yet. Collapsing them told people a mode was fine
 * because BugPilot had failed to check.
 */
export type FixModeAvailability = "available" | "unavailable" | "unknown";

/**
 * The mode a work item was actually prepared with.
 *
 * Deliberately a different thing from the form's current selection: one is what
 * ran, the other is what would run next. Labelling an old package with a
 * freshly picked mode would be a lie about what the agent was told.
 *
 * The name is the one the *status file* recorded, because that is what the
 * agent was actually handed. A custom mode can be renamed, and showing today's
 * name over a months-old package would rewrite history.
 */
export interface PreparedFixMode {
  readonly id: string;
  readonly name: string;
  readonly executionKind?: ExecutionKind;
  readonly availability: FixModeAvailability;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asExecutionKind(value: unknown): ExecutionKind | undefined {
  return value === "fix" || value === "investigate" ? value : undefined;
}

function asMode(value: unknown): FixModeSummary | undefined {
  const record = asRecord(value);
  const id = record?.["id"];
  const name = record?.["name"];
  const executionKind = asExecutionKind(record?.["execution_kind"]);
  if (typeof id !== "string" || id === "") return undefined;
  if (typeof name !== "string" || name === "") return undefined;
  // A mode whose kind this client does not understand is dropped rather than
  // guessed at: `executionKind` decides whether the page promises that no
  // source will change, and a wrong promise there is worse than a missing mode.
  if (!executionKind) return undefined;
  const description = record?.["description"];
  const version = record?.["version"];
  const source = record?.["source"];
  return {
    id,
    name,
    description: typeof description === "string" ? description : "",
    version: typeof version === "number" ? version : 0,
    source: typeof source === "string" ? source : "",
    executionKind,
  };
}

/** What the panel says when the installed bugpilot predates Fix Modes. */
export const FIX_MODES_UNSUPPORTED_DETAIL =
  "This BugPilot version does not expose AI Fix Modes. Update BugPilot to choose one.";

/**
 * A discovery command that threw, as an `unavailable` reason.
 *
 * One case is recognised: a bugpilot old enough to have no `fix-mode` command
 * rejects it at argument parsing, prints nothing on stdout, and says
 * `invalid choice: 'fix-mode'` on stderr. That is an upgrade, not a fault, so
 * it gets the same sentence as an envelope without modes. Every other failure —
 * a missing executable, a timeout, malformed output — keeps its own message:
 * mapping those to "update BugPilot" would send a developer to fix the wrong
 * thing.
 */
export function fixModeDiscoveryFailure(error: unknown): {
  readonly kind: "unavailable";
  readonly detail: string;
} {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === "string" && /invalid choice: '(fix-mode)'/.test(stderr)) {
    return { kind: "unavailable", detail: FIX_MODES_UNSUPPORTED_DETAIL };
  }
  return {
    kind: "unavailable",
    detail: `BugPilot could not list its AI Fix Modes: ${(error as Error).message}`,
  };
}

/**
 * Turn a `fix-mode list --json` envelope into a catalog.
 *
 * Every failure is `unavailable` with something a developer can act on. The one
 * thing it never does is fall back to a built-in list.
 */
export function fixModesFromPayload(payload: unknown): FixModeCatalog {
  const record = asRecord(payload);
  if (!record) {
    return { kind: "unavailable", detail: "BugPilot did not describe its AI Fix Modes." };
  }
  if (record["ok"] === false) {
    const error = asRecord(record["error"]);
    const message = error?.["message"];
    return {
      kind: "unavailable",
      detail:
        typeof message === "string" && message !== ""
          ? message
          : "BugPilot could not list its AI Fix Modes.",
    };
  }
  const raw = record["modes"];
  if (!Array.isArray(raw)) {
    // The shape an older bugpilot gives: a valid envelope for a command it does
    // not have, or one without this field.
    return { kind: "unavailable", detail: FIX_MODES_UNSUPPORTED_DETAIL };
  }
  const modes = raw.map(asMode).filter((mode): mode is FixModeSummary => mode !== undefined);
  if (modes.length === 0) {
    return { kind: "unavailable", detail: "BugPilot listed no usable AI Fix Modes." };
  }
  // Two modes with one id is malformed discovery data, not a choice to make on
  // the developer's behalf. Keeping either one would put two identical values
  // in the selector, where picking the second is impossible and the description
  // beside it belongs to the first.
  const duplicate = modes.find(
    (mode, index) => modes.findIndex((other) => other.id === mode.id) !== index,
  );
  if (duplicate) {
    return {
      kind: "unavailable",
      detail: `BugPilot listed two AI Fix Modes with the id "${duplicate.id}".`,
    };
  }
  const declared = record["default_mode_id"];
  const defaultModeId =
    typeof declared === "string" && modes.some((mode) => mode.id === declared)
      ? declared
      : modes[0]!.id;
  return { kind: "ready", modes, defaultModeId };
}

/** The mode with this id, if the catalog has one. */
export function findFixMode(
  catalog: FixModeCatalog,
  id: string | undefined,
): FixModeSummary | undefined {
  if (catalog.kind !== "ready" || !id) return undefined;
  return catalog.modes.find((mode) => mode.id === id);
}

/**
 * Which mode the form should show.
 *
 * The developer's own choice stands whenever the catalog still has it. Anything
 * else — nothing chosen yet, or a choice that is no longer offered — falls to
 * the CLI's declared default rather than to a name spelled out here.
 */
export function selectedFixModeId(catalog: FixModeCatalog, chosen: string | undefined): string {
  if (catalog.kind !== "ready") return chosen ?? "";
  if (findFixMode(catalog, chosen)) return chosen!;
  return catalog.defaultModeId;
}

/**
 * What `workflow_status.json` says the package was prepared with.
 *
 * Read from the status file rather than `fix_mode.json` directly: the status
 * file is what this extension already reads for a work item, and core puts the
 * same record in both. Nothing here writes either of them — persisting the
 * selection is the CLI's job, and a second writer would be a second opinion.
 */
export function preparedFixModeFromStatus(
  status: unknown,
  catalog: FixModeCatalog,
): PreparedFixMode | undefined {
  const record = asRecord(asRecord(status)?.["fix_mode"]);
  const id = record?.["id"];
  if (typeof id !== "string" || id === "") return undefined;
  const known = findFixMode(catalog, id);
  const recordedName = record?.["name"];
  const recordedKind = asExecutionKind(record?.["execution_kind"]);
  // Recorded first, catalog second: the status file is the historical record of
  // what ran, and the catalog only says whether that mode can still be run.
  const name =
    typeof recordedName === "string" && recordedName !== ""
      ? recordedName
      : (known?.name ?? id);
  const executionKind = recordedKind ?? known?.executionKind;
  const availability: FixModeAvailability =
    catalog.kind !== "ready" ? "unknown" : known ? "available" : "unavailable";
  return {
    id,
    name,
    ...(executionKind ? { executionKind } : {}),
    availability,
  };
}

// --- managing custom modes ---------------------------------------------------
//
// A second view of the same modes, and the distinction is the point. The
// selector needs one definition per id: what would run. Management needs every
// file on disk, including one that another scope currently shadows, because a
// shadowed mode still has to be editable and deletable. Deriving the second
// view from the first would make it unaddressable.

/** The scopes a custom mode can be written to. Built-ins are read-only. */
export const WRITABLE_SCOPES = ["user", "project"] as const;
export type WritableScope = (typeof WRITABLE_SCOPES)[number];

/** `fix-mode list --all-scopes --json`. */
export const FIX_MODE_MANAGED_ARGS: readonly string[] = [
  "fix-mode",
  "list",
  "--all-scopes",
  "--json",
];

/** One physical definition, and whether it is the one its id resolves to. */
export interface ManagedFixMode extends FixModeSummary {
  readonly scope: string;
  readonly effective: boolean;
  readonly basedOn?: string;
  readonly basedOnVersion?: number;
}

/** A custom file BugPilot could not read, as the panel reports it. */
export interface FixModeIssue {
  readonly scope: string;
  readonly path: string;
  readonly message: string;
}

export type ManagedFixModes =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly builtin: readonly ManagedFixMode[];
      readonly user: readonly ManagedFixMode[];
      readonly project: readonly ManagedFixMode[];
      readonly issues: readonly FixModeIssue[];
    }
  | { readonly kind: "unavailable"; readonly detail: string };

/** What the editor holds: one mode's editable text plus its read-only origin. */
export interface FixModeDraft {
  /** What saving it will do. `view` is a built-in: shown, never written. */
  readonly intent: "create" | "edit" | "view";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly executionKind: ExecutionKind;
  readonly objective: string;
  readonly investigation: string;
  readonly implementation: string;
  readonly verification: string;
  readonly constraints: string;
  readonly completion: string;
  readonly scope: WritableScope;
  /** The version this draft was opened at, sent back so a stale save is refused. */
  readonly version: number;
  readonly basedOn?: string;
  readonly basedOnVersion?: number;
}

/** The six sections, in the order core renders them. */
export const DRAFT_SECTIONS = [
  "objective",
  "investigation",
  "implementation",
  "verification",
  "constraints",
  "completion",
] as const;

function asManagedMode(value: unknown, scope: string): ManagedFixMode | undefined {
  const summary = asMode(value);
  const record = asRecord(value);
  if (!summary || !record) return undefined;
  const basedOn = record["based_on"];
  const basedOnVersion = record["based_on_version"];
  return {
    ...summary,
    scope,
    // A claim Core makes, not a default this side may assume: saying a mode is
    // effective when nothing said so would tell the developer the wrong one runs.
    effective: record["effective"] === true,
    ...(typeof basedOn === "string" && basedOn !== "" ? { basedOn } : {}),
    ...(typeof basedOnVersion === "number" ? { basedOnVersion } : {}),
  };
}

/** Turn `fix-mode list --all-scopes --json` into the management view. */
export function managedFixModesFromPayload(payload: unknown): ManagedFixModes {
  const record = asRecord(payload);
  if (!record) {
    return { kind: "unavailable", detail: "BugPilot did not describe its AI Fix Modes." };
  }
  if (record["ok"] === false) {
    const message = asRecord(record["error"])?.["message"];
    return {
      kind: "unavailable",
      detail:
        typeof message === "string" && message !== ""
          ? message
          : "BugPilot could not list its AI Fix Modes.",
    };
  }
  if (!Array.isArray(record["builtin"])) {
    return {
      kind: "unavailable",
      detail: "This BugPilot version cannot manage custom Fix Modes. Update BugPilot.",
    };
  }
  const scoped = (scope: string): ManagedFixMode[] => {
    const raw = record[scope];
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => asManagedMode(entry, scope))
      .filter((mode): mode is ManagedFixMode => mode !== undefined);
  };
  const issues = (Array.isArray(record["issues"]) ? record["issues"] : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      scope: String(entry["scope"] ?? ""),
      path: String(entry["path"] ?? ""),
      message: String(entry["message"] ?? ""),
    }));
  return {
    kind: "ready",
    builtin: scoped("builtin"),
    user: scoped("user"),
    project: scoped("project"),
    issues,
  };
}

/** The mode definition a `show --json` envelope carries, as a draft. */
export function draftFromDefinition(
  payload: unknown,
  intent: FixModeDraft["intent"],
  scope: WritableScope,
): FixModeDraft | undefined {
  const record = asRecord(asRecord(payload)?.["mode"]) ?? asRecord(payload);
  const summary = asMode(record);
  if (!record || !summary) return undefined;
  const text = (field: string): string => {
    const value = record[field];
    return typeof value === "string" ? value : "";
  };
  const basedOn = record["based_on"];
  const basedOnVersion = record["based_on_version"];
  return {
    intent,
    id: summary.id,
    name: summary.name,
    description: summary.description,
    executionKind: summary.executionKind,
    objective: text("objective"),
    investigation: text("investigation"),
    implementation: text("implementation"),
    verification: text("verification"),
    constraints: text("constraints"),
    completion: text("completion"),
    scope,
    version: summary.version,
    ...(typeof basedOn === "string" && basedOn !== "" ? { basedOn } : {}),
    ...(typeof basedOnVersion === "number" ? { basedOnVersion } : {}),
  };
}

/**
 * A draft as the CLI payload file spells it.
 *
 * `source` is never sent: a mode's scope comes from the directory core writes
 * it to, and a payload that could name a source could name `builtin`.
 */
export function payloadFromDraft(draft: FixModeDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema_version: 1,
    id: draft.id,
    name: draft.name,
    description: draft.description,
    execution_kind: draft.executionKind,
  };
  for (const section of DRAFT_SECTIONS) payload[section] = draft[section];
  if (draft.basedOn) {
    payload["based_on"] = draft.basedOn;
    if (draft.basedOnVersion !== undefined) payload["based_on_version"] = draft.basedOnVersion;
  }
  return payload;
}

/**
 * The command line a save becomes.
 *
 * A created mode carries its origin in the payload rather than going through
 * `duplicate` first, so "Duplicate & Customize" saves what the developer
 * actually edited instead of writing a copy and then editing it.
 */
export function saveArgsForDraft(draft: FixModeDraft, payloadPath: string): readonly string[] {
  if (draft.intent === "edit") {
    return [
      "fix-mode",
      "update",
      draft.id,
      `--scope=${draft.scope}`,
      `--expected-version=${draft.version}`,
      `--from-file=${payloadPath}`,
      "--json",
    ];
  }
  return [
    "fix-mode",
    "create",
    draft.id,
    `--scope=${draft.scope}`,
    `--from-file=${payloadPath}`,
    "--json",
  ];
}

/** The command line a delete becomes. */
export function deleteArgsFor(mode: ManagedFixMode): readonly string[] {
  return [
    "fix-mode",
    "delete",
    mode.id,
    `--scope=${mode.scope}`,
    `--expected-version=${mode.version}`,
    "--json",
  ];
}

/** An id that is free to use, suggested from the mode being copied. */
export function suggestedCopyId(sourceId: string, taken: readonly string[]): string {
  const base = `my-${sourceId}`.slice(0, 60);
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}
