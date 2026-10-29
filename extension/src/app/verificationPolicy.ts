/**
 * The repository's Verification Policy, as the panel holds it (0.1.3, §42.2,
 * §42.5).
 *
 * Since 0.1.3 the policy can be text, `settings/verification.md`, which
 * replaces BugPilot's default whole and wins over the Verification switches in
 * `settings/project_settings.json` (which older versions still read and write).
 * The CLI owns every part of that — the file, its front matter, which source is
 * effective, the policy's text and the lint — and this module only reads what
 * `bugpilot verification show --json` says, and asks the CLI to write: `set
 * --stdin` creates the file from text the CLI itself reported, and `reset`
 * removes it. Nothing here composes, migrates or judges a policy, and nothing
 * here writes the file.
 *
 * The hash joins the instructions' in the stale check, so a policy edited in an
 * editor tab, pulled with git or switched with a branch makes a prepared context
 * "Needs rebuild" the next time the host reads it — at an environment check, a
 * Run, Fix with AI, Start New Attempt, the window coming back to focus, or a
 * file in the repository's settings folder changing.
 *
 * A CLI too old to read the file would ignore it silently, so the host asks the
 * CLI first: `doctor --json` lists `verification-text` among its capabilities.
 * Without it, and with a `verification.md` in the repository, the CLI is out of
 * date; without the file, an older CLI still prepares what it always did.
 *
 * The policy's text and the lint's lines reach the page only for the settings
 * row's Preview, and never the log.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";
import { MAX_INSTRUCTION_CHARS } from "./instructions.ts";

/** The `doctor --json` capability a CLI reports when it reads `settings/verification.md`. */
export const VERIFICATION_TEXT_CAPABILITY = "verification-text";

/** The file, as a person names it. */
export const VERIFICATION_FILE = "settings/verification.md";

export const VERIFICATION_SOURCES = ["bugpilot-default", "legacy-project-settings", "verification-file"] as const;
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

/** Each source as the settings row and the Preview name it: never the CLI's enum. */
export const VERIFICATION_SOURCE_LABELS: Readonly<Record<VerificationSource, string>> = {
  "bugpilot-default": "BugPilot default",
  "legacy-project-settings": "Legacy project settings",
  "verification-file": "Repository verification.md",
};

/** The most lint lines kept for the Preview; the count is always the CLI's whole count. */
const MAX_LINT_LINES = 100;

/** What `bugpilot verification show` last said. */
export interface VerificationSnapshot {
  readonly source: VerificationSource;
  /** The CLI's hash of the effective policy, its source and any problem. */
  readonly sha256: string;
  /** Why the repository's file is not used; it exists, and the default applies. */
  readonly problem?: string;
  /** How many lint warnings the CLI gave. */
  readonly lintCount: number;
  /** The lint warnings in the CLI's words (line numbers, never the line), for the Preview. Never logged. */
  readonly lint: readonly string[];
  /** The effective policy's text: what a task carries, and what Edit seeds a new file with. Never logged. */
  readonly text: string;
  /** Whether `settings/verification.md` is there, usable or not. */
  readonly fileExists: boolean;
  /** The default's version the file was written from, while the file is the policy. */
  readonly basedOnVersion?: number;
  /** BugPilot's current default version. */
  readonly defaultVersion?: number;
  /** The file was written from an older default than the current one. */
  readonly defaultChanged: boolean;
  /** The effective text is not BugPilot's default. */
  readonly differsFromDefault: boolean;
}

export type VerificationOutcome =
  | { readonly kind: "loaded"; readonly snapshot: VerificationSnapshot }
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/** What the host asks the CLI: read the policy, create the file from text, or remove the file. */
export type VerificationCommand = { readonly kind: "show" } | { readonly kind: "set"; readonly text: string } | { readonly kind: "reset" };

/** `bugpilot verification show|set --stdin|reset --json`. The text of a `set` goes on stdin, never here. */
export function verificationArgs(command: VerificationCommand = { kind: "show" }): readonly string[] {
  switch (command.kind) {
    case "show":
      return ["verification", "show", "--json"];
    case "set":
      return ["verification", "set", "--stdin", "--json"];
    case "reset":
      return ["verification", "reset", "--json"];
  }
}

/** Whether the CLI behind a `doctor --json` report reads `settings/verification.md`. */
export function readsVerificationText(report: Readonly<Record<string, unknown>> | undefined): boolean {
  const capabilities = report?.["capabilities"];
  return Array.isArray(capabilities) && capabilities.includes(VERIFICATION_TEXT_CAPABILITY);
}

/** What a prepared context depends on, as one comparable string. */
export function verificationFingerprint(snapshot: VerificationSnapshot): string {
  return `${snapshot.source}:${snapshot.sha256}`;
}

/**
 * Whether two reads describe the same policy a task would follow: the same
 * effective text, and neither of them a file that could not be used. Only for
 * the panel's own Edit and Reset, which move the CLI's text between sources —
 * a prepared context made before either is not stale for that alone (§42.5).
 */
export function samePolicyText(before: VerificationSnapshot | undefined, after: VerificationSnapshot | undefined): boolean {
  return before !== undefined && after !== undefined && !before.problem && !after.problem && before.text === after.text;
}

/** "Source: BugPilot default"; for a file the CLI could not use, the default that applies instead — never the file. */
export function verificationSourceLine(snapshot: VerificationSnapshot): string {
  if (snapshot.problem) return `Source: ${VERIFICATION_SOURCE_LABELS["bugpilot-default"]} (${VERIFICATION_FILE} is not used)`;
  return `Source: ${VERIFICATION_SOURCE_LABELS[snapshot.source]}`;
}

/** The problem in a sentence that says what applies meanwhile and what can be done. */
export function verificationProblemLine(problem: string): string {
  return `${VERIFICATION_FILE} is not used: ${problem} BugPilot's default applies until it is fixed. Edit opens the file; Reset removes it.`;
}

/** "2 policy warnings": a count, never the lines. */
export function verificationLintLine(count: number): string {
  return `${count} policy ${count === 1 ? "warning" : "warnings"} · details in Preview`;
}

/** The note `default_changed` brings. */
export const VERIFICATION_DEFAULT_CHANGED = "BugPilot's default Verification Policy has changed since this file was created.";

/** What the settings row needs, as the host decided it. The page only shows it. */
export interface VerificationRowView {
  /** "Source: BugPilot default" — empty while nothing has been read. */
  readonly source: string;
  /** Why Edit, Reset and Preview are off when they are, said on the row. Empty otherwise. */
  readonly unavailable: string;
  readonly canEdit: boolean;
  readonly canReset: boolean;
  readonly canPreview: boolean;
  /** A file the CLI cannot use: the problem, in a sentence. */
  readonly problem: string;
  /** "2 policy warnings · details in Preview". */
  readonly lint: string;
  /** `default_changed`'s note. */
  readonly defaultChanged: string;
  /** The Verification Policy changed since the context on screen was prepared: "Needs rebuild". */
  readonly stale: boolean;
  /** Edit is creating the file, or Reset removing it. */
  readonly busy: boolean;
}

export const VERIFICATION_ROW_EMPTY: VerificationRowView = {
  source: "",
  unavailable: "",
  canEdit: false,
  canReset: false,
  canPreview: false,
  problem: "",
  lint: "",
  defaultChanged: "",
  stale: false,
  busy: false,
};

/**
 * The row from what the CLI last said. `undefined` is "not read": nothing to
 * say about the source, and the actions wait for a read (each one reads again
 * first, so they are offered whenever reading is possible at all).
 */
export function verificationRowView(
  snapshot: VerificationSnapshot | undefined,
  options: {
    /** BugPilot is ready in a repository and can ask its CLI. */
    readonly ready: boolean;
    /** The CLI's doctor report lists `verification-text`. */
    readonly readsText: boolean;
    /** A run, a handoff or an artifact write is in flight: no file is written meanwhile. */
    readonly writesHeld: boolean;
    readonly stale: boolean;
    readonly busy: boolean;
  },
): VerificationRowView {
  if (!options.ready) return VERIFICATION_ROW_EMPTY;
  if (!options.readsText) {
    return {
      ...VERIFICATION_ROW_EMPTY,
      unavailable: `The installed BugPilot CLI cannot read ${VERIFICATION_FILE}. Update it to edit the Verification Policy here.`,
    };
  }
  const exists = snapshot?.fileExists === true;
  const idle = !options.busy;
  return {
    source: snapshot === undefined ? "" : verificationSourceLine(snapshot),
    unavailable: "",
    // Opening a file that is there writes nothing; creating one waits for the
    // run or the write in flight, like Apply.
    canEdit: idle && (exists || !options.writesHeld),
    canReset: idle && exists && !options.writesHeld,
    canPreview: idle,
    problem: snapshot?.problem ? verificationProblemLine(snapshot.problem) : "",
    lint: snapshot && !snapshot.problem && snapshot.lintCount > 0 ? verificationLintLine(snapshot.lintCount) : "",
    defaultChanged: snapshot?.defaultChanged ? VERIFICATION_DEFAULT_CHANGED : "",
    stale: options.stale,
    busy: options.busy,
  };
}

/** One term and its value in the Preview's facts. */
export interface VerificationFact {
  readonly label: string;
  readonly value: string;
}

/** The read-only Preview: the effective policy and where it comes from, from `verification show --json`. */
export interface VerificationPreviewView {
  /** Bumped by every open, so the page moves focus once per open. */
  readonly token: number;
  readonly facts: readonly VerificationFact[];
  readonly problem: string;
  readonly defaultChanged: string;
  /** The lint warnings, in the CLI's words. */
  readonly lint: readonly string[];
  readonly lintCount: number;
  readonly text: string;
}

export function verificationPreviewView(snapshot: VerificationSnapshot, token: number): VerificationPreviewView {
  const facts: VerificationFact[] = [
    {
      label: "Source",
      value: snapshot.problem
        ? `${VERIFICATION_SOURCE_LABELS["bugpilot-default"]} — ${VERIFICATION_FILE} is not used`
        : VERIFICATION_SOURCE_LABELS[snapshot.source],
    },
    { label: "File", value: snapshot.fileExists ? VERIFICATION_FILE : `${VERIFICATION_FILE} (not created)` },
  ];
  if (snapshot.basedOnVersion !== undefined) facts.push({ label: "Based on default", value: `version ${snapshot.basedOnVersion}` });
  if (snapshot.defaultVersion !== undefined) facts.push({ label: "Current default", value: `version ${snapshot.defaultVersion}` });
  facts.push({ label: "Same as default", value: snapshot.differsFromDefault ? "No" : "Yes" });
  return {
    token,
    facts,
    problem: snapshot.problem ? verificationProblemLine(snapshot.problem) : "",
    defaultChanged: snapshot.defaultChanged ? VERIFICATION_DEFAULT_CHANGED : "",
    lint: snapshot.lint,
    lintCount: snapshot.lintCount,
    text: snapshot.text,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function version(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A snapshot from the CLI's envelope; `undefined` when it is not one. Untrusted input: anything off is refused, never guessed. */
export function verificationFromEnvelope(envelope: unknown): VerificationSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true) return undefined;
  const source = payload["source"];
  const sha256 = payload["sha256"];
  const text = payload["text"];
  if (typeof source !== "string" || !(VERIFICATION_SOURCES as readonly string[]).includes(source)) return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof text !== "string" || text.length > MAX_INSTRUCTION_CHARS) return undefined;
  const problem = typeof payload["problem"] === "string" && payload["problem"].trim() !== "" ? payload["problem"].trim().slice(0, 400) : undefined;
  const lintRaw = Array.isArray(payload["lint"]) ? (payload["lint"] as unknown[]) : [];
  const lint = lintRaw
    .filter((line): line is string => typeof line === "string")
    .slice(0, MAX_LINT_LINES)
    .map((line) => line.slice(0, 400));
  const file = record(payload["file"]);
  const basedOnVersion = version(payload["based_on_version"]);
  const defaultVersion = version(payload["default_version"]);
  return {
    source: source as VerificationSource,
    sha256,
    ...(problem === undefined ? {} : { problem }),
    lintCount: lintRaw.length,
    lint,
    text,
    fileExists: file?.["exists"] === true,
    ...(basedOnVersion === undefined ? {} : { basedOnVersion }),
    ...(defaultVersion === undefined ? {} : { defaultVersion }),
    defaultChanged: payload["default_changed"] === true,
    differsFromDefault: payload["differs_from_default"] === true,
  };
}

/** A finished `--json` command, as the policy port needs it. */
export interface VerificationRunResult extends ProcessExit {
  readonly stdout: string;
}

/**
 * Read the effective policy through the CLI, or have the CLI write or remove
 * the file and read it back. `set` and `reset` answer with the same payload as
 * `show`, so every outcome is the policy as it now stands.
 *
 * Run raw rather than through `runJson`, because the exit code is the evidence:
 * a CLI without `verification` exits 2 with argparse's complaint, and that is
 * an out-of-date CLI, not a broken file. A refusal — a link, the size limit —
 * is the CLI's sentence, passed on.
 */
export async function runVerificationPolicy(
  run: (args: readonly string[], input?: string) => Promise<VerificationRunResult>,
  command: VerificationCommand = { kind: "show" },
): Promise<VerificationOutcome> {
  try {
    const result = await run(verificationArgs(command), command.kind === "set" ? command.text : undefined);
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["verification"] };
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
    const snapshot = verificationFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no Verification Policy." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}
