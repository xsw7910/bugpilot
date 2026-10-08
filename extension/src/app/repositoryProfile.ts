/**
 * The Repository Profile, as the panel holds it.
 *
 * The profile says what the repository is — Auto-detect (the default), Generic,
 * or Custom details — and `task.md` describes the repository from it. It is
 * repository configuration, not issue content: `bugpilot repository-profile`
 * reads and writes `<repo>/.bugpilot/repository_profile.json`, and every run,
 * from the CLI, the MCP server or this panel, reads that file. The panel never
 * sends the profile on a run's command line.
 *
 * The panel keeps a copy in the form, so the settings page's Apply, Cancel and
 * Back, the stale check and Reset Session treat it like any other setting; the
 * host loads it from the file when the environment resolves and writes it back
 * on Apply. Reset Session keeps it: it is the repository's, not the session's.
 *
 * The modes, labels, field keys and limits copy
 * `bugpilot/core/repository_profile.py`. `tests/fixtures/repository_profile_contract.json`
 * holds the same table and both test suites compare their copy with it.
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

export const REPOSITORY_PROFILE_MODES = ["auto", "generic", "custom"] as const;
export type RepositoryProfileMode = (typeof REPOSITORY_PROFILE_MODES)[number];

/** A mode from anywhere outside this module: an unknown value is the default, Auto-detect. */
export function repositoryProfileModeOf(value: unknown): RepositoryProfileMode {
  return (REPOSITORY_PROFILE_MODES as readonly unknown[]).includes(value) ? (value as RepositoryProfileMode) : "auto";
}

export const REPOSITORY_PROFILE_LABELS: Readonly<Record<RepositoryProfileMode, string>> = {
  auto: "Auto-detect",
  generic: "Generic",
  custom: "Custom",
};

/** The Custom fields: the form's name, the file's key, the label, the most characters one holds. */
export const REPOSITORY_FIELDS = [
  { field: "repositoryLanguages", key: "languages", label: "Languages", max: 200 },
  { field: "repositoryFrameworks", key: "frameworks", label: "Frameworks", max: 200 },
  { field: "repositoryApplicationType", key: "application_type", label: "Application type", max: 120 },
  { field: "repositoryBuildSystem", key: "build_system", label: "Build system", max: 120 },
  { field: "repositoryTestFramework", key: "test_framework", label: "Test framework", max: 120 },
  { field: "repositoryNotes", key: "notes", label: "Codebase notes", max: 1000 },
] as const;

export type RepositoryField = (typeof REPOSITORY_FIELDS)[number]["field"];
export type RepositoryFactKey = (typeof REPOSITORY_FIELDS)[number]["key"];

/**
 * One fact as the CLI stores it: one line, whitespace collapsed, control
 * characters gone — so a trailing space never makes a context look stale.
 */
export function cleanFact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim() : "";
}

/** The profile a form describes, in the shape `repository-profile set --from-file` takes. */
export interface RepositoryProfilePayload {
  readonly mode: RepositoryProfileMode;
  readonly custom: Readonly<Record<RepositoryFactKey, string>>;
}

export function repositoryProfileOfForm(form: FormState): RepositoryProfilePayload {
  const custom = {} as Record<RepositoryFactKey, string>;
  for (const entry of REPOSITORY_FIELDS) custom[entry.key] = cleanFact(form[entry.field]);
  return { mode: repositoryProfileModeOf(form.repositoryProfile), custom };
}

/** Whether the form and a saved profile say the same thing. */
export function sameRepositoryProfile(form: FormState, saved: RepositoryProfilePayload): boolean {
  return JSON.stringify(repositoryProfileOfForm(form)) === JSON.stringify(normalizedPayload(saved));
}

function normalizedPayload(payload: RepositoryProfilePayload): RepositoryProfilePayload {
  const custom = {} as Record<RepositoryFactKey, string>;
  for (const entry of REPOSITORY_FIELDS) custom[entry.key] = cleanFact(payload.custom[entry.key]);
  return { mode: repositoryProfileModeOf(payload.mode), custom };
}

/** The form with a saved profile in place of its own copy. */
export function formWithRepositoryProfile(form: FormState, saved: RepositoryProfilePayload): FormState {
  const next: Record<string, unknown> = { ...form, repositoryProfile: repositoryProfileModeOf(saved.mode) };
  for (const entry of REPOSITORY_FIELDS) next[entry.field] = cleanFact(saved.custom[entry.key]);
  return next as unknown as FormState;
}

/** The fingerprint's view: the mode and every detail, read the way the CLI stores them. */
export function repositoryProfileFingerprint(form: FormState): RepositoryProfilePayload {
  return repositoryProfileOfForm(form);
}

/** What `repository-profile --json` reported, as much as the panel uses. */
export interface RepositoryProfileSnapshot {
  readonly profile: RepositoryProfilePayload;
  /** Auto-detect's facts, joined for one line: "C++ · Qt · CMake". Empty when nothing was found. */
  readonly detected: string;
  /** Whether the file exists, or the profile is the default. */
  readonly saved: boolean;
  readonly warnings: readonly string[];
}

export type RepositoryProfileOutcome =
  | { readonly kind: "loaded"; readonly snapshot: RepositoryProfileSnapshot }
  /** The CLI predates the Repository Profile: it is too old for this extension. */
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The quiet line under the picker, per choice, composed here: the page shows
 * the one for whichever mode its draft holds and decides nothing about what a
 * detection means — the agent picker's status lines work the same way.
 */
export interface RepositoryProfileView {
  readonly lines: Readonly<Record<RepositoryProfileMode, string>>;
}

/** The lines for a profile that was read, or none when it could not be. */
export function repositoryProfileView(snapshot: RepositoryProfileSnapshot | undefined): RepositoryProfileView {
  const auto =
    snapshot === undefined
      ? ""
      : snapshot.detected !== ""
        ? `Detected: ${snapshot.detected}`
        : "Nothing detected with confidence. No assumptions are made.";
  return { lines: { auto, generic: "", custom: "" } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A snapshot from the CLI's envelope; `undefined` when it is not one. Untrusted input. */
export function snapshotFromEnvelope(envelope: unknown): RepositoryProfileSnapshot | undefined {
  const payload = record(envelope);
  const profile = record(payload?.["profile"]);
  if (!payload || payload["ok"] !== true || !profile) return undefined;
  const custom = record(profile["custom"]) ?? {};
  const facts = record(record(payload["detected"])?.["facts"]) ?? {};
  const detected = REPOSITORY_FIELDS.map((entry) => cleanFact(facts[entry.key]))
    .filter((value) => value !== "")
    .join(" · ");
  const customFacts = {} as Record<RepositoryFactKey, string>;
  for (const entry of REPOSITORY_FIELDS) customFacts[entry.key] = cleanFact(custom[entry.key]);
  const warnings = Array.isArray(payload["warnings"])
    ? (payload["warnings"] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  return {
    profile: { mode: repositoryProfileModeOf(profile["mode"]), custom: customFacts },
    detected,
    saved: payload["saved"] === true,
    warnings,
  };
}

/** `repository-profile show`, or `set` from a payload file. `--json` is the runner's to add. */
export function repositoryProfileArgs(payloadPath?: string): readonly string[] {
  return payloadPath === undefined
    ? ["repository-profile", "show"]
    : ["repository-profile", "set", `--from-file=${payloadPath}`];
}

/** A finished `--json` command, as the profile port needs it. */
export interface ProfileRunResult extends ProcessExit {
  readonly stdout: string;
}

/**
 * Read the profile, or save one and read it back, through the CLI.
 *
 * Run raw rather than through `runJson`, because the exit code is the evidence:
 * a CLI without `repository-profile` exits 2 with argparse's "invalid choice",
 * and that is reported as an out-of-date CLI, not as a broken profile. A saved
 * profile travels in a temporary file, never on the command line, and the file
 * is removed whatever happens.
 */
export async function runRepositoryProfile(
  run: (args: readonly string[]) => Promise<ProfileRunResult>,
  payload?: RepositoryProfilePayload,
): Promise<RepositoryProfileOutcome> {
  let file: string | undefined;
  try {
    if (payload !== undefined) {
      file = path.join(
        tmpdir(),
        `bugpilot-repository-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      await writeFile(file, `${JSON.stringify(normalizedPayload(payload), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const result = await run([...repositoryProfileArgs(file), "--json"]);
    // Named for what was asked, whatever argparse quoted: a CLI from before the
    // command reads `repository-profile` as an issue key for its default `bug`
    // command, and then rejects `show --json` as unrecognized arguments.
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["repository-profile"] };
    let envelope: unknown;
    try {
      envelope = parseEnvelope(result.stdout, result.stderr);
    } catch (error) {
      return { kind: "failed", message: error instanceof ProtocolError ? error.message : String(error) };
    }
    const failure = record(record(envelope)?.["error"]);
    if (failure) return { kind: "failed", message: cleanFact(failure["message"]) || "bugpilot gave no reason." };
    const snapshot = snapshotFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no repository profile." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  } finally {
    if (file !== undefined) await rm(file, { force: true }).catch(() => {});
  }
}
