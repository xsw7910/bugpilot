/**
 * User Instructions and Project / Team Instructions, as the panel holds them.
 *
 * Two optional Markdown files: `~/.bugpilot/instructions.md` (the developer's,
 * for every repository) and `<repo>/.bugpilot/instructions.md` (the
 * repository's, meant to be committed). `task.md` carries each as a section
 * below BugPilot's safety rules; every run — CLI, MCP or this panel — reads the
 * same two files. The panel never sends them on a run's command line.
 *
 * Unlike the Repository Profile they are not mirrored in the form: they are
 * documents, edited on their own page and saved with their own Save, not
 * settings applied with the rest. The host holds what `bugpilot instructions
 * show --json` last said — each scope's state and a hash of its content — and
 * the stale check compares that hash, so an edit made outside BugPilot is
 * noticed at the next environment check or Run. Reset Session keeps them.
 *
 * Reads and writes go through the CLI, which owns the paths, the limits and the
 * link checks: the page names a scope, never a path, and the text travels to
 * the CLI on stdin — never on a command line, never in a temporary file. None
 * of it is ever logged.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";

export const INSTRUCTION_SCOPES = ["user", "project"] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

export function isInstructionScope(value: unknown): value is InstructionScope {
  return (INSTRUCTION_SCOPES as readonly unknown[]).includes(value);
}

/** The most characters one file may hold — `MAX_INSTRUCTION_CHARS` in `bugpilot/core/instructions.py`. */
export const MAX_INSTRUCTION_CHARS = 20_000;

/** What the page says about each scope: its name, whom it applies to, and its empty state. */
export const INSTRUCTION_TEXT: Readonly<
  Record<InstructionScope, { readonly title: string; readonly scopeLine: string; readonly empty: string; readonly editLabel: string }>
> = {
  user: {
    title: "User instructions",
    scopeLine: "Applies to all repositories for this user.",
    empty: "No user instructions configured.",
    editLabel: "Edit user instructions",
  },
  project: {
    title: "Project instructions",
    scopeLine: "Shared with this repository.",
    empty: "No project instructions configured.",
    editLabel: "Edit project instructions",
  },
};

/** One scope as the CLI reported it. `text` is what a task would carry; empty for none. */
export interface InstructionScopeState {
  readonly configured: boolean;
  readonly characters: number;
  /** A hash of what a task would carry — the content, or the problem; empty for none. */
  readonly sha256: string;
  /** Why a file that is there is left out of the task, when it is. */
  readonly problem?: string;
  readonly text: string;
}

export interface InstructionsSnapshot {
  readonly user: InstructionScopeState;
  readonly project: InstructionScopeState;
  readonly maxCharacters: number;
}

export type InstructionsOutcome =
  | { readonly kind: "loaded"; readonly snapshot: InstructionsSnapshot }
  /** The CLI predates `bugpilot instructions`: it is too old for this extension. */
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/**
 * What a prepared context depends on, in one string: both scopes' hashes. Two
 * snapshots of the same content give the same string whatever the file times.
 */
export function instructionsFingerprint(snapshot: InstructionsSnapshot): string {
  return `${snapshot.user.sha256}|${snapshot.project.sha256}`;
}

/** The settings page's line under a scope's name. Empty while nothing has been read. */
export function instructionsStatusLine(scope: InstructionScope, state: InstructionScopeState | undefined): string {
  if (state === undefined) return "";
  if (state.problem) return `Not used: ${state.problem}`;
  if (!state.configured) return INSTRUCTION_TEXT[scope].empty;
  return `Configured · ${state.characters.toLocaleString("en-US")} ${state.characters === 1 ? "character" : "characters"}`;
}

/** `instructions show`, or `set` for one scope — from stdin, or `--clear` for empty text. `--json` is added here. */
export function instructionsArgs(save?: { readonly scope: InstructionScope; readonly clear: boolean }): readonly string[] {
  if (save === undefined) return ["instructions", "show", "--json"];
  return ["instructions", "set", "--scope", save.scope, save.clear ? "--clear" : "--stdin", "--json"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scopeState(value: unknown): InstructionScopeState | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const text = typeof entry["text"] === "string" ? entry["text"] : "";
  const sha256 = typeof entry["sha256"] === "string" && /^[0-9a-f]{0,64}$/.test(entry["sha256"]) ? entry["sha256"] : undefined;
  if (sha256 === undefined || text.length > MAX_INSTRUCTION_CHARS) return undefined;
  const problem = typeof entry["problem"] === "string" && entry["problem"].trim() !== "" ? entry["problem"].trim().slice(0, 400) : undefined;
  return {
    configured: entry["configured"] === true && text !== "",
    characters: text.length,
    sha256,
    ...(problem === undefined ? {} : { problem }),
    text,
  };
}

/** A snapshot from the CLI's envelope; `undefined` when it is not one. Untrusted input. */
export function snapshotFromEnvelope(envelope: unknown): InstructionsSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true) return undefined;
  const user = scopeState(payload["user"]);
  const project = scopeState(payload["project"]);
  if (!user || !project) return undefined;
  const max = payload["max_characters"];
  return { user, project, maxCharacters: typeof max === "number" && max > 0 ? Math.min(max, MAX_INSTRUCTION_CHARS) : MAX_INSTRUCTION_CHARS };
}

/** A finished `--json` command, as the instructions port needs it. */
export interface InstructionsRunResult extends ProcessExit {
  readonly stdout: string;
}

/**
 * Read both scopes, or save one and read both back, through the CLI.
 *
 * Run raw rather than through `runJson`, because the exit code is the evidence:
 * a CLI without `instructions` exits 2 with argparse's complaint, and that is
 * an out-of-date CLI, not a broken file. A save sends the text on stdin; empty
 * text is `--clear`, which removes the file.
 */
export async function runInstructions(
  run: (args: readonly string[], input?: string) => Promise<InstructionsRunResult>,
  save?: { readonly scope: InstructionScope; readonly text: string },
): Promise<InstructionsOutcome> {
  try {
    const clear = save !== undefined && save.text.trim() === "";
    const result = await run(
      instructionsArgs(save === undefined ? undefined : { scope: save.scope, clear }),
      save === undefined || clear ? undefined : save.text,
    );
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["instructions"] };
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
    const snapshot = snapshotFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no instructions." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}
