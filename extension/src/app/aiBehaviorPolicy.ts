/**
 * The repository's AI Behavior, as the host holds it (0.1.4).
 *
 * BugPilot's default AI Behavior plus the repository's additions in
 * `.bugpilot/ai_behavior.md`. The CLI owns every part of it — the file, its
 * front matter, the defaults, what a task carries, the lint, the template a
 * new file starts from — and this module only reads what `bugpilot
 * ai-behavior show --json` says, and asks the CLI to write: `set --stdin`
 * creates the file from the template the CLI itself reported (its three
 * sections, empty, which add nothing until written under), and `reset`
 * removes it. Nothing here composes or judges AI Behavior.
 *
 * The hash joins the instructions' and the Verification Policy's in the stale
 * check, so additions edited in an editor tab, pulled with git or switched with
 * a branch make a prepared context "Needs rebuild" the next time the host reads
 * them — at an environment check, a Run, Rebuild Context, Fix with AI, Start
 * New Attempt, the window coming back to focus, or a `.bugpilot/` file
 * changing. A file that adds nothing hashes as no file, so creating one from
 * the template is not a change.
 *
 * A CLI too old to read the file would ignore it silently, so the host asks the
 * CLI first: `doctor --json` lists `ai-behavior-text` among its capabilities.
 * Without it, and with an `ai_behavior.md` in the repository, the CLI is out of
 * date — the same state as any other out-of-date CLI; without the file, an
 * older CLI still prepares what it always did.
 *
 * The text and the lint's lines reach the page only for the settings row's
 * Preview, and never the log.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";
import { MAX_INSTRUCTION_CHARS } from "./instructions.ts";

/** The `doctor --json` capability a CLI reports when it reads `.bugpilot/ai_behavior.md`. */
export const AI_BEHAVIOR_TEXT_CAPABILITY = "ai-behavior-text";

/** The file, as a person names it. */
export const AI_BEHAVIOR_FILE = ".bugpilot/ai_behavior.md";

export const AI_BEHAVIOR_SOURCES = ["bugpilot-default", "ai-behavior-file"] as const;
export type AiBehaviorSource = (typeof AI_BEHAVIOR_SOURCES)[number];

/** The most lint lines kept for the Preview; the count is always the CLI's whole count. */
const MAX_LINT_LINES = 100;

/** What `bugpilot ai-behavior show` last said. */
export interface AiBehaviorSnapshot {
  readonly source: AiBehaviorSource;
  /** The CLI's hash of what a task carries: text, problem, version — and the source, when the file adds something. */
  readonly sha256: string;
  /** Why the repository's file is not used; it exists, and the defaults apply. */
  readonly problem?: string;
  /** How many lint warnings the CLI gave. */
  readonly lintCount: number;
  /** The lint warnings in the CLI's words (line numbers, never the line), for the Preview. Never logged. */
  readonly lint: readonly string[];
  /** The effective AI Behavior: BugPilot's defaults, then any additions. For the Preview only; never logged. */
  readonly text: string;
  /** What a new file is created with: the three sections, empty. */
  readonly template?: string;
  /** Whether `.bugpilot/ai_behavior.md` is there, usable or not. */
  readonly fileExists: boolean;
  /** The task carries the repository's additions beside BugPilot's defaults. */
  readonly hasProjectAdditions: boolean;
  /** The default's version the additions were written against. */
  readonly basedOnVersion?: number;
  /** BugPilot's current default version. */
  readonly defaultVersion?: number;
  /** The additions were written against an older default than the current one. */
  readonly defaultChanged: boolean;
}

export type AiBehaviorOutcome =
  | { readonly kind: "loaded"; readonly snapshot: AiBehaviorSnapshot }
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/** What the host asks the CLI: read AI Behavior, create the file from text, or remove the file. */
export type AiBehaviorCommand = { readonly kind: "show" } | { readonly kind: "set"; readonly text: string } | { readonly kind: "reset" };

/** `bugpilot ai-behavior show|set --stdin|reset --json`. The text of a `set` goes on stdin, never here. */
export function aiBehaviorArgs(command: AiBehaviorCommand = { kind: "show" }): readonly string[] {
  switch (command.kind) {
    case "show":
      return ["ai-behavior", "show", "--json"];
    case "set":
      return ["ai-behavior", "set", "--stdin", "--json"];
    case "reset":
      return ["ai-behavior", "reset", "--json"];
  }
}

/** Whether the CLI behind a `doctor --json` report reads `.bugpilot/ai_behavior.md`. */
export function readsAiBehaviorText(report: Readonly<Record<string, unknown>> | undefined): boolean {
  const capabilities = report?.["capabilities"];
  return Array.isArray(capabilities) && capabilities.includes(AI_BEHAVIOR_TEXT_CAPABILITY);
}

/**
 * What a prepared context depends on, as one comparable string: the CLI's hash,
 * which covers the source whenever the file adds something. A file that adds
 * nothing yet reads the same as no file, because the task is the same.
 */
export function aiBehaviorFingerprint(snapshot: AiBehaviorSnapshot): string {
  return snapshot.sha256;
}

/** "Source: BugPilot default"; with additions, or a file that cannot be used, said so. */
export function aiBehaviorSourceLine(snapshot: AiBehaviorSnapshot): string {
  if (snapshot.problem) return `Source: BugPilot default (${AI_BEHAVIOR_FILE} is not used)`;
  if (snapshot.hasProjectAdditions) return "Source: BugPilot default + repository additions";
  if (snapshot.fileExists) return `Source: BugPilot default (${AI_BEHAVIOR_FILE} has no additions yet)`;
  return "Source: BugPilot default";
}

/** The problem in a sentence that says what applies meanwhile and what can be done. */
export function aiBehaviorProblemLine(problem: string): string {
  return `${AI_BEHAVIOR_FILE} is not used: ${problem} BugPilot's default applies until it is fixed. Edit opens the file; Reset removes it.`;
}

/** "2 AI Behavior warnings": a count, never the lines. */
export function aiBehaviorLintLine(count: number): string {
  return `${count} AI Behavior ${count === 1 ? "warning" : "warnings"} · details in Preview`;
}

/** The note `default_changed` brings. */
export const AI_BEHAVIOR_DEFAULT_CHANGED = "BugPilot's default AI Behavior has changed since these additions were written.";

/** What the settings row needs, as the host decided it. The page only shows it. */
export interface AiBehaviorRowView {
  readonly source: string;
  readonly unavailable: string;
  readonly canEdit: boolean;
  readonly canReset: boolean;
  readonly canPreview: boolean;
  readonly problem: string;
  readonly lint: string;
  readonly defaultChanged: string;
  /** AI Behavior changed since the context on screen was prepared: "Needs rebuild". */
  readonly stale: boolean;
  /** Edit is creating the file, or Reset removing it. */
  readonly busy: boolean;
}

export const AI_BEHAVIOR_ROW_EMPTY: AiBehaviorRowView = {
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

/** The row from what the CLI last said; `undefined` is "not read". */
export function aiBehaviorRowView(
  snapshot: AiBehaviorSnapshot | undefined,
  options: {
    readonly ready: boolean;
    readonly readsText: boolean;
    readonly writesHeld: boolean;
    readonly stale: boolean;
    readonly busy: boolean;
  },
): AiBehaviorRowView {
  if (!options.ready) return AI_BEHAVIOR_ROW_EMPTY;
  if (!options.readsText) {
    return {
      ...AI_BEHAVIOR_ROW_EMPTY,
      unavailable: `The installed BugPilot CLI cannot read ${AI_BEHAVIOR_FILE}. Update it to edit AI Behavior here.`,
    };
  }
  const exists = snapshot?.fileExists === true;
  const idle = !options.busy;
  return {
    source: snapshot === undefined ? "" : aiBehaviorSourceLine(snapshot),
    unavailable: "",
    canEdit: idle && (exists || !options.writesHeld),
    canReset: idle && exists && !options.writesHeld,
    canPreview: idle,
    problem: snapshot?.problem ? aiBehaviorProblemLine(snapshot.problem) : "",
    lint: snapshot && !snapshot.problem && snapshot.lintCount > 0 ? aiBehaviorLintLine(snapshot.lintCount) : "",
    defaultChanged: snapshot?.defaultChanged ? AI_BEHAVIOR_DEFAULT_CHANGED : "",
    stale: options.stale,
    busy: options.busy,
  };
}

/** One term and its value in the Preview's facts. */
export interface AiBehaviorFact {
  readonly label: string;
  readonly value: string;
}

/** The read-only Preview: the effective AI Behavior and where it comes from. */
export interface AiBehaviorPreviewView {
  readonly token: number;
  readonly facts: readonly AiBehaviorFact[];
  readonly problem: string;
  readonly defaultChanged: string;
  readonly lint: readonly string[];
  readonly lintCount: number;
  readonly text: string;
}

export function aiBehaviorPreviewView(snapshot: AiBehaviorSnapshot, token: number): AiBehaviorPreviewView {
  const facts: AiBehaviorFact[] = [
    { label: "Source", value: aiBehaviorSourceLine(snapshot).replace(/^Source: /, "") },
    { label: "File", value: snapshot.fileExists ? AI_BEHAVIOR_FILE : `${AI_BEHAVIOR_FILE} (not created)` },
    { label: "Repository additions", value: snapshot.hasProjectAdditions ? "Yes" : "No" },
  ];
  if (snapshot.basedOnVersion !== undefined) facts.push({ label: "Based on default", value: `version ${snapshot.basedOnVersion}` });
  if (snapshot.defaultVersion !== undefined) facts.push({ label: "Current default", value: `version ${snapshot.defaultVersion}` });
  return {
    token,
    facts,
    problem: snapshot.problem ? aiBehaviorProblemLine(snapshot.problem) : "",
    defaultChanged: snapshot.defaultChanged ? AI_BEHAVIOR_DEFAULT_CHANGED : "",
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
export function aiBehaviorFromEnvelope(envelope: unknown): AiBehaviorSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true) return undefined;
  const source = payload["source"];
  const sha256 = payload["sha256"];
  if (typeof source !== "string" || !(AI_BEHAVIOR_SOURCES as readonly string[]).includes(source)) return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  // The effective behavior: every CLI with the capability sends it.
  const textValue = payload["text"];
  const text = typeof textValue === "string" && textValue.length <= MAX_INSTRUCTION_CHARS * 2 ? textValue : "";
  const problem = typeof payload["problem"] === "string" && payload["problem"].trim() !== "" ? payload["problem"].trim().slice(0, 400) : undefined;
  const lintRaw = Array.isArray(payload["lint"]) ? (payload["lint"] as unknown[]) : [];
  const lint = lintRaw
    .filter((line): line is string => typeof line === "string")
    .slice(0, MAX_LINT_LINES)
    .map((line) => line.slice(0, 400));
  const templateValue = payload["template"];
  const template = typeof templateValue === "string" && templateValue.trim() !== "" && templateValue.length <= 2000 ? templateValue : undefined;
  const file = record(payload["file"]);
  const basedOnVersion = version(payload["based_on_version"]);
  const defaultVersion = version(payload["default_version"]);
  return {
    source: source as AiBehaviorSource,
    sha256,
    ...(problem === undefined ? {} : { problem }),
    lintCount: lintRaw.length,
    lint,
    text,
    ...(template === undefined ? {} : { template }),
    fileExists: file?.["exists"] === true,
    hasProjectAdditions: payload["has_project_additions"] === true,
    ...(basedOnVersion === undefined ? {} : { basedOnVersion }),
    ...(defaultVersion === undefined ? {} : { defaultVersion }),
    defaultChanged: payload["default_changed"] === true,
  };
}

/** A finished `--json` command, as the port needs it. */
export interface AiBehaviorRunResult extends ProcessExit {
  readonly stdout: string;
}

/**
 * Read the effective AI Behavior through the CLI, or have the CLI write or
 * remove the file and read it back. `set` and `reset` answer with the same
 * payload as `show`.
 *
 * Run raw rather than through `runJson`, because the exit code is the evidence:
 * a CLI without `ai-behavior` exits 2 with argparse's complaint, and that is an
 * out-of-date CLI, not a broken file.
 */
export async function runAiBehaviorPolicy(
  run: (args: readonly string[], input?: string) => Promise<AiBehaviorRunResult>,
  command: AiBehaviorCommand = { kind: "show" },
): Promise<AiBehaviorOutcome> {
  try {
    const result = await run(aiBehaviorArgs(command), command.kind === "set" ? command.text : undefined);
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["ai-behavior"] };
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
    const snapshot = aiBehaviorFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no AI Behavior." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}
