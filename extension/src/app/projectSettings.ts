/**
 * Project settings, as the panel holds them (pre-release Batch 3): the
 * repository's Verification Policy and its branch naming template.
 *
 * Both are repository configuration, like the Repository Profile:
 * `bugpilot project-settings` reads and writes
 * `<repo>/.bugpilot/project_settings.json`, every run — CLI, MCP or this panel —
 * reads that file, and the panel never sends them on a run's command line.
 *
 * The panel keeps a copy in the form, so the settings page's Apply, Cancel and
 * Back, the stale check and Reset Session treat them like any other setting:
 * the host loads them when the environment resolves and writes them back on
 * Apply. Reset Session keeps them. The CLI is the one judge of a template: a
 * template it refuses is said, and the form goes back to the file's.
 *
 * Node-only: no `vscode` import.
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";
import type { FormState } from "./form.ts";

/** The four switches: the form's name, the file's key, the default — `VERIFICATION_KEYS` in the CLI. */
export const VERIFICATION_FIELDS = [
  { field: "verifyRelevantTests", key: "relevant_tests", label: "Relevant tests", default: true },
  { field: "verifyStaticChecks", key: "static_checks", label: "Static checks", default: true },
  { field: "verifyFullSuite", key: "full_suite", label: "Full test suite", default: false },
  { field: "verifyReportNotRun", key: "report_not_run", label: "Report tests not run", default: true },
] as const;

export type VerificationField = (typeof VERIFICATION_FIELDS)[number]["field"];
export type VerificationKey = (typeof VERIFICATION_FIELDS)[number]["key"];

/** Branch naming: the default name, or the repository's own template. */
export const BRANCH_NAMINGS = ["default", "custom"] as const;
export type BranchNaming = (typeof BRANCH_NAMINGS)[number];

export function branchNamingOf(value: unknown): BranchNaming {
  return value === "custom" ? "custom" : "default";
}

/** The name a branch gets with no template — `DEFAULT_BRANCH_TEMPLATE_LABEL` in the CLI. */
export const DEFAULT_BRANCH_TEMPLATE = "feature/{issue}-{slug}";

/** The most characters a template may hold — `MAX_BRANCH_TEMPLATE_CHARS` in the CLI. */
export const MAX_BRANCH_TEMPLATE_CHARS = 80;

/** The settings in the shape `project-settings set --from-file` takes. */
export interface ProjectSettingsPayload {
  readonly verification: Readonly<Record<VerificationKey, boolean>>;
  readonly branch_naming: { readonly template: string };
}

export function projectSettingsOfForm(form: FormState): ProjectSettingsPayload {
  const verification = {} as Record<VerificationKey, boolean>;
  for (const entry of VERIFICATION_FIELDS) verification[entry.key] = form[entry.field] === true;
  const template = branchNamingOf(form.branchNaming) === "custom" ? form.branchTemplate.trim() : "";
  return { verification, branch_naming: { template } };
}

/** Whether the form and saved settings say the same thing. */
export function sameProjectSettings(form: FormState, saved: ProjectSettingsPayload): boolean {
  return JSON.stringify(projectSettingsOfForm(form)) === JSON.stringify(normalizedPayload(saved));
}

function normalizedPayload(payload: ProjectSettingsPayload): ProjectSettingsPayload {
  const verification = {} as Record<VerificationKey, boolean>;
  for (const entry of VERIFICATION_FIELDS) {
    const value = payload.verification?.[entry.key];
    verification[entry.key] = typeof value === "boolean" ? value : entry.default;
  }
  const template = typeof payload.branch_naming?.template === "string" ? payload.branch_naming.template.trim() : "";
  return { verification, branch_naming: { template } };
}

/**
 * The form with saved settings in place of its own copy. A default name keeps
 * whatever template text the form held, so switching to Custom and back on
 * the page loses nothing; it is not part of the settings while Default is chosen.
 */
export function formWithProjectSettings(form: FormState, saved: ProjectSettingsPayload): FormState {
  const settings = normalizedPayload(saved);
  const next: Record<string, unknown> = { ...form };
  for (const entry of VERIFICATION_FIELDS) next[entry.field] = settings.verification[entry.key];
  const template = settings.branch_naming.template;
  next["branchNaming"] = template === "" ? "default" : "custom";
  next["branchTemplate"] = template === "" ? form.branchTemplate : template;
  return next as unknown as FormState;
}

/** The fingerprint's view: what a run would read from the file. */
export function projectSettingsFingerprint(form: FormState): ProjectSettingsPayload {
  return projectSettingsOfForm(form);
}

/** What `project-settings --json` reported, as much as the panel uses. */
export interface ProjectSettingsSnapshot {
  readonly settings: ProjectSettingsPayload;
  readonly saved: boolean;
  readonly warnings: readonly string[];
}

export type ProjectSettingsOutcome =
  | { readonly kind: "loaded"; readonly snapshot: ProjectSettingsSnapshot }
  /** The CLI predates project settings: it is too old for this extension. */
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A snapshot from the CLI's envelope; `undefined` when it is not one. Untrusted input. */
export function projectSettingsFromEnvelope(envelope: unknown): ProjectSettingsSnapshot | undefined {
  const payload = record(envelope);
  const settings = record(payload?.["settings"]);
  if (!payload || payload["ok"] !== true || !settings) return undefined;
  const verification = record(settings["verification"]) ?? {};
  const naming = record(settings["branch_naming"]) ?? {};
  const template = typeof naming["template"] === "string" ? naming["template"].trim().slice(0, MAX_BRANCH_TEMPLATE_CHARS) : "";
  const warnings = Array.isArray(payload["warnings"])
    ? (payload["warnings"] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  return {
    settings: normalizedPayload({
      verification: verification as Record<VerificationKey, boolean>,
      branch_naming: { template },
    }),
    saved: payload["saved"] === true,
    warnings,
  };
}

/** `project-settings show`, or `set` from a payload file. `--json` is the runner's to add. */
export function projectSettingsArgs(payloadPath?: string): readonly string[] {
  return payloadPath === undefined
    ? ["project-settings", "show"]
    : ["project-settings", "set", `--from-file=${payloadPath}`];
}

/** A finished `--json` command, as the settings port needs it. */
export interface ProjectSettingsRunResult extends ProcessExit {
  readonly stdout: string;
}

/**
 * Read the settings, or save them and read them back, through the CLI.
 *
 * Run raw rather than through `runJson`, because the exit code is the evidence:
 * a CLI without `project-settings` exits 2 with argparse's complaint, and that
 * is an out-of-date CLI. A save travels in a temporary file, never on the
 * command line, and the file is removed whatever happens. Nothing in it is
 * secret; the file only keeps the template off a command line a shell parses.
 */
export async function runProjectSettings(
  run: (args: readonly string[]) => Promise<ProjectSettingsRunResult>,
  payload?: ProjectSettingsPayload,
): Promise<ProjectSettingsOutcome> {
  let file: string | undefined;
  try {
    if (payload !== undefined) {
      file = path.join(
        tmpdir(),
        `bugpilot-project-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      await writeFile(file, `${JSON.stringify(normalizedPayload(payload), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const result = await run([...projectSettingsArgs(file), "--json"]);
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["project-settings"] };
    let envelope: unknown;
    try {
      envelope = parseEnvelope(result.stdout, result.stderr);
    } catch (error) {
      return { kind: "failed", message: error instanceof ProtocolError ? error.message : String(error) };
    }
    const failure = record(record(envelope)?.["error"]);
    if (failure) {
      const message = typeof failure["message"] === "string" ? failure["message"].trim() : "";
      return { kind: "failed", message: message || "bugpilot gave no reason." };
    }
    const snapshot = projectSettingsFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no project settings." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  } finally {
    if (file !== undefined) await rm(file, { force: true }).catch(() => {});
  }
}
