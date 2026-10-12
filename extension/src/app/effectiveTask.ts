/**
 * The Effective AI Task, as the panel shows it (0.1.4).
 *
 * Read from `bugpilot task-preview --json`: the task BugPilot would hand an
 * agent now, rendered by the CLI through the same code a run uses. Nothing here
 * builds, edits or reorders a task. The page draws the CLI's text in blocks —
 * one per `## ` section, split at the line numbers the CLI gave — and joined
 * back they are the CLI's text byte for byte; each block carries the section's
 * class from the CLI (protected or editable, and from where).
 *
 * Two kinds, both the CLI's: a prepared work item's task with every policy
 * read again now, or — with no work item — the template, whose run settings
 * (Fix Mode, branch policy, Jira comment) the panel passes from its form, the
 * same flags `bug` takes. Previewing writes nothing and marks nothing stale.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";

/** The `doctor --json` capability of a CLI that answers `bugpilot task-preview`. */
export const TASK_PREVIEW_CAPABILITY = "task-preview";

/** What the panel asks to see: a prepared work item's task, or the template with the form's run settings. */
export type TaskPreviewRequest =
  | { readonly kind: "work-item"; readonly workItemId: string }
  | {
      readonly kind: "template";
      readonly fixModeId?: string;
      readonly branchPolicy?: string;
      readonly jiraComment: boolean;
    };

/** One comparable string per request, so a reply for an older request is recognised and dropped. */
export function taskPreviewRequestKey(request: TaskPreviewRequest): string {
  return request.kind === "work-item"
    ? `work-item:${request.workItemId}`
    : `template:${request.fixModeId ?? ""}:${request.branchPolicy ?? ""}:${request.jiraComment ? "jira" : ""}`;
}

/** `bugpilot task-preview [ID | --fix-mode … --branch-policy … --jira-comment] --json`. */
export function taskPreviewArgs(request: TaskPreviewRequest): readonly string[] {
  if (request.kind === "work-item") return ["task-preview", request.workItemId, "--json"];
  return [
    "task-preview",
    ...(request.fixModeId ? ["--fix-mode", request.fixModeId] : []),
    ...(request.branchPolicy ? ["--branch-policy", request.branchPolicy] : []),
    ...(request.jiraComment ? ["--jira-comment"] : []),
    "--json",
  ];
}

export function readsTaskPreview(report: Readonly<Record<string, unknown>> | undefined): boolean {
  const capabilities = report?.["capabilities"];
  return Array.isArray(capabilities) && capabilities.includes(TASK_PREVIEW_CAPABILITY);
}

export interface TaskPreviewSection {
  readonly heading: string;
  /** The CLI's class for it: `protected`, `project-instructions`, `verification-policy`, … */
  readonly kind: string;
  readonly protected: boolean;
  /** 1-based line of its heading in the text, and how many lines it spans. */
  readonly line: number;
  readonly lines: number;
  readonly placeholder: boolean;
}

/** The prepared files beside a work item's preview, as the CLI compared them. */
export interface TaskPreviewPrepared {
  readonly taskExists: boolean;
  readonly contextExists: boolean;
  readonly taskCurrent: boolean;
  readonly changedSections: readonly string[];
  readonly problem?: string;
}

/** Where each layer came from, as far as the panel shows it — the CLI's states, never their text. */
export interface TaskPreviewSources {
  readonly fixMode?: { readonly id: string; readonly name: string; readonly origin: string };
  readonly branchPolicy?: { readonly policy: string; readonly branch: string };
  readonly jiraComment: boolean;
  readonly protectedRulesVersion?: number;
  readonly repositoryProfile?: string;
  readonly verification?: { readonly source: string; readonly problem?: string };
  readonly aiBehavior?: { readonly source: string; readonly problem?: string; readonly hasProjectAdditions: boolean };
  readonly projectInstructions?: { readonly configured: boolean; readonly problem?: string };
  readonly userInstructions?: { readonly configured: boolean; readonly problem?: string };
}

export interface TaskPreviewSnapshot {
  readonly kind: "active-work-item" | "template";
  readonly label: string;
  readonly workItem?: string;
  readonly text: string;
  readonly sections: readonly TaskPreviewSection[];
  readonly placeholders: readonly string[];
  readonly sources: TaskPreviewSources;
  readonly prepared?: TaskPreviewPrepared;
  readonly warnings: readonly string[];
}

export type TaskPreviewOutcome =
  | { readonly kind: "loaded"; readonly snapshot: TaskPreviewSnapshot }
  | { readonly kind: "outdated" }
  | { readonly kind: "failed"; readonly message: string };

/** The largest task text taken from the CLI: far above a real one, so a runaway answer is refused rather than drawn. */
const MAX_TASK_CHARS = 400_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function strings(value: unknown, max: number, count: number): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string").slice(0, count).map((item) => item.slice(0, max))
    : [];
}

function problemOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 400) : undefined;
}

function sourcesFrom(raw: Record<string, unknown> | undefined): TaskPreviewSources {
  const fixMode = record(raw?.["fix_mode"]);
  const branch = record(raw?.["branch_policy"]);
  const protectedRules = record(raw?.["protected_rules"]);
  const repository = record(raw?.["repository_profile"]);
  const verification = record(raw?.["verification"]);
  const aiBehavior = record(raw?.["ai_behavior"]);
  const project = record(raw?.["project_instructions"]);
  const user = record(raw?.["user_instructions"]);
  const fixModeId = str(fixMode?.["id"], 120);
  const fixModeName = str(fixMode?.["name"], 200);
  const policy = str(branch?.["policy"], 40);
  const rulesVersion = protectedRules?.["rules_version"];
  const instruction = (value: Record<string, unknown> | undefined) =>
    value === undefined
      ? undefined
      : { configured: value["configured"] === true, ...(problemOf(value["problem"]) ? { problem: problemOf(value["problem"])! } : {}) };
  return {
    ...(fixModeId && fixModeName ? { fixMode: { id: fixModeId, name: fixModeName, origin: str(fixMode?.["origin"], 40) ?? "" } } : {}),
    ...(policy ? { branchPolicy: { policy, branch: str(branch?.["branch"], 300) ?? "" } } : {}),
    jiraComment: raw?.["jira_comment"] === true,
    ...(typeof rulesVersion === "number" && Number.isInteger(rulesVersion) ? { protectedRulesVersion: rulesVersion } : {}),
    ...(str(repository?.["mode"], 40) ? { repositoryProfile: str(repository?.["mode"], 40)! } : {}),
    ...(str(verification?.["source"], 60)
      ? { verification: { source: str(verification?.["source"], 60)!, ...(problemOf(verification?.["problem"]) ? { problem: problemOf(verification?.["problem"])! } : {}) } }
      : {}),
    ...(str(aiBehavior?.["source"], 60)
      ? {
          aiBehavior: {
            source: str(aiBehavior?.["source"], 60)!,
            hasProjectAdditions: aiBehavior?.["has_project_additions"] === true,
            ...(problemOf(aiBehavior?.["problem"]) ? { problem: problemOf(aiBehavior?.["problem"])! } : {}),
          },
        }
      : {}),
    ...(instruction(project) ? { projectInstructions: instruction(project)! } : {}),
    ...(instruction(user) ? { userInstructions: instruction(user)! } : {}),
  };
}

/** The snapshot, or `undefined` when the envelope is not one. Untrusted: a section the text does not hold is refused. */
export function taskPreviewFromEnvelope(envelope: unknown): TaskPreviewSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true) return undefined;
  const kind = payload["preview_kind"];
  if (kind !== "active-work-item" && kind !== "template") return undefined;
  const text = str(payload["text"], MAX_TASK_CHARS);
  const label = str(payload["label"], 300);
  if (text === undefined || text === "" || !label) return undefined;
  const lineCount = text.split("\n").length;
  const sections: TaskPreviewSection[] = [];
  for (const raw of Array.isArray(payload["sections"]) ? (payload["sections"] as unknown[]) : []) {
    const section = record(raw);
    const heading = str(section?.["heading"], 300);
    const sectionKind = str(section?.["class"], 60);
    const line = section?.["line"];
    const lines = section?.["lines"];
    if (!heading || !sectionKind || typeof line !== "number" || typeof lines !== "number") return undefined;
    if (!Number.isInteger(line) || !Number.isInteger(lines) || line < 1 || lines < 1 || line - 1 + lines > lineCount) return undefined;
    sections.push({ heading, kind: sectionKind, protected: section?.["protected"] === true, line, lines, placeholder: section?.["placeholder"] === true });
  }
  const prepared = record(payload["prepared"]);
  const workItem = str(payload["work_item"], 120);
  return {
    kind,
    label,
    ...(workItem ? { workItem } : {}),
    text,
    sections,
    placeholders: strings(payload["placeholders"], 200, 20),
    sources: sourcesFrom(record(payload["sources"])),
    ...(prepared
      ? {
          prepared: {
            taskExists: prepared["task_exists"] === true,
            contextExists: prepared["context_exists"] === true,
            taskCurrent: prepared["task_current"] === true,
            changedSections: strings(prepared["changed_sections"], 300, 50),
            ...(problemOf(prepared["problem"]) ? { problem: problemOf(prepared["problem"])! } : {}),
          },
        }
      : {}),
    warnings: strings(payload["warnings"], 400, 50),
  };
}

export interface TaskPreviewRunResult extends ProcessExit {
  readonly stdout: string;
}

export async function runTaskPreview(
  run: (args: readonly string[]) => Promise<TaskPreviewRunResult>,
  request: TaskPreviewRequest,
): Promise<TaskPreviewOutcome> {
  try {
    const result = await run(taskPreviewArgs(request));
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated" };
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
    const snapshot = taskPreviewFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no task preview." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}

// --- the view ---------------------------------------------------------------------------------

/** What each class of section is, in a reader's words. The class itself is the CLI's. */
export const SECTION_KIND_LABELS: Readonly<Record<string, string>> = {
  protected: "Protected · BugPilot",
  "generated-evidence": "Generated · Repository Profile",
  "project-instructions": "Editable · Project instructions",
  "verification-policy": "Editable · Verification Policy",
  "ai-behavior": "Editable · AI Behavior",
  "user-instructions": "Editable · User instructions",
  "fix-mode": "Selected · Fix Mode",
  "developer-hint": "Work item · hint and attachments",
};

/** Where an editable section is changed, for its block's tooltip. */
const SECTION_KIND_WHERE: Readonly<Record<string, string>> = {
  protected: "Built into BugPilot; not editable. See Advanced Settings › AI Behavior & Rules › Protected Rules.",
  "generated-evidence": "Read from the repository; set the profile in Advanced Settings › Repository.",
  "project-instructions": "Edit in Advanced Settings › Guidance & Verification › Project instructions.",
  "verification-policy": "Edit in Advanced Settings › Guidance & Verification › Verification policy.",
  "ai-behavior": "Edit in Advanced Settings › AI Behavior & Rules › AI Behavior.",
  "user-instructions": "Edit in Advanced Settings › Guidance & Verification › User instructions.",
  "fix-mode": "Choose the Fix Mode on the main page; manage modes with its gear.",
  "developer-hint": "The work item's hint and attached files, on the main page and in Advanced Settings › Issue details.",
};

/** One block of the task: a section (or the title before the first one), its text exactly. */
export interface TaskBlockView {
  readonly heading?: string;
  readonly kind: string;
  readonly protected: boolean;
  readonly label: string;
  readonly where: string;
  readonly placeholder: boolean;
  readonly text: string;
}

export interface TaskPreviewFact {
  readonly label: string;
  readonly value: string;
}

export interface TaskPreviewView {
  readonly label: string;
  readonly template: boolean;
  /** One line about the prepared task.md beside a work item's preview; empty for a template. */
  readonly prepared: string;
  readonly facts: readonly TaskPreviewFact[];
  readonly warnings: readonly string[];
  readonly blocks: readonly TaskBlockView[];
  readonly placeholderNote: string;
  readonly protectedCount: number;
  readonly editableCount: number;
}

/**
 * The text cut into blocks at the CLI's section lines. Joined, the blocks are
 * the text exactly — the title lines before the first section included — so
 * what the page shows is what the agent is handed.
 */
export function taskBlocks(snapshot: TaskPreviewSnapshot): TaskBlockView[] {
  const lines = snapshot.text.split("\n");
  const take = (start: number, end: number) => lines.slice(start, end).join("\n") + (end < lines.length ? "\n" : "");
  const blocks: TaskBlockView[] = [];
  const first = snapshot.sections[0]?.line ?? lines.length + 1;
  if (first > 1) {
    blocks.push({ kind: "title", protected: true, label: "Task title", where: "", placeholder: false, text: take(0, first - 1) });
  }
  snapshot.sections.forEach((section, index) => {
    const start = section.line - 1;
    const next = snapshot.sections[index + 1];
    const end = next ? next.line - 1 : lines.length;
    blocks.push({
      heading: section.heading,
      kind: section.kind,
      protected: section.protected,
      label: SECTION_KIND_LABELS[section.kind] ?? "Other",
      where: SECTION_KIND_WHERE[section.kind] ?? "",
      placeholder: section.placeholder,
      text: take(start, end),
    });
  });
  if (snapshot.sections.length === 0) {
    return [{ kind: "title", protected: true, label: "Task", where: "", placeholder: false, text: snapshot.text }];
  }
  return blocks;
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  "bugpilot-default": "BugPilot default",
  "legacy-project-settings": "Legacy project settings",
  "verification-file": "Repository verification.md",
  "ai-behavior-file": "Repository ai_behavior.md",
};

function instructionWords(state: { readonly configured: boolean; readonly problem?: string } | undefined): string {
  if (state === undefined) return "";
  if (state.problem) return "Not used (a problem)";
  return state.configured ? "Configured" : "None";
}

/** The view: label, the prepared task's state, where each layer came from, warnings and the blocks. */
export function taskPreviewView(snapshot: TaskPreviewSnapshot): TaskPreviewView {
  const template = snapshot.kind === "template";
  const sources = snapshot.sources;
  const facts: TaskPreviewFact[] = [];
  if (sources.fixMode) facts.push({ label: "Fix Mode", value: sources.fixMode.name });
  if (sources.branchPolicy) facts.push({ label: "Branch policy", value: sources.branchPolicy.policy });
  facts.push({ label: "Jira status comment", value: sources.jiraComment ? "On" : "Off" });
  if (sources.verification) {
    facts.push({
      label: "Verification Policy",
      value: sources.verification.problem ? "BugPilot default (the file is not used)" : SOURCE_WORDS[sources.verification.source] ?? sources.verification.source,
    });
  }
  if (sources.aiBehavior) {
    facts.push({
      label: "AI Behavior",
      value: sources.aiBehavior.problem
        ? "BugPilot default (the file is not used)"
        : sources.aiBehavior.hasProjectAdditions
          ? "BugPilot default + repository additions"
          : "BugPilot default",
    });
  }
  if (sources.projectInstructions) facts.push({ label: "Project instructions", value: instructionWords(sources.projectInstructions) });
  if (sources.userInstructions) facts.push({ label: "User instructions", value: instructionWords(sources.userInstructions) });
  if (sources.repositoryProfile) facts.push({ label: "Repository profile", value: sources.repositoryProfile });
  if (sources.protectedRulesVersion !== undefined) facts.push({ label: "Protected rules", value: `version ${sources.protectedRulesVersion}` });
  let prepared = "";
  const state = snapshot.prepared;
  if (!template && state) {
    if (state.problem) prepared = `Prepared task.md: not compared — ${state.problem}`;
    else if (!state.taskExists) prepared = "Prepared task.md: not written yet.";
    else if (state.taskCurrent) prepared = "Prepared task.md: the same as this preview.";
    else if (state.changedSections.length > 0) prepared = `Prepared task.md: differs in ${state.changedSections.join(", ")}.`;
    // Not the same text, though no section differs: its title, or the sections' order.
    else prepared = "Prepared task.md: differs from this preview outside its sections.";
  }
  const blocks = taskBlocks(snapshot);
  return {
    label: snapshot.label,
    template,
    prepared,
    facts,
    warnings: snapshot.warnings,
    blocks,
    placeholderNote: template ? "Placeholders in angle brackets stand for what only a work item has." : "",
    protectedCount: blocks.filter((block) => block.heading !== undefined && block.protected).length,
    editableCount: blocks.filter((block) => block.heading !== undefined && !block.protected).length,
  };
}
