/**
 * The Effective Context, as the panel shows it (0.1.4).
 *
 * Read from `bugpilot context-preview --json`: the context.md BugPilot last
 * generated for the work item — never a new one, which only retrieval can
 * produce — and the CLI's status for it. The panel adds the one thing the CLI
 * cannot see: whether the retrieval inputs and run settings in its own form
 * still describe the prepared package, and whether the policies changed since
 * by its own fingerprint. The two are merged here, without weakening either:
 *
 * - either says the context needs a rebuild → *Needs rebuild*, with every
 *   reason from both;
 * - the CLI's *current* is shown as current only when the panel agrees;
 * - an unknown stays unknown unless the panel knows it is stale;
 * - no context (not generated, missing, unreadable, no work item) is never
 *   called stale, and a stale context is never hidden.
 *
 * Context Quality and Search Confidence are the stored ones, as the CLI read
 * them; nothing here recomputes either. Previewing writes nothing and marks
 * nothing stale.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";

/** The `doctor --json` capability of a CLI that answers `bugpilot context-preview`. */
export const CONTEXT_PREVIEW_CAPABILITY = "context-preview";

export const CONTEXT_STATES = ["unavailable", "not-generated", "missing", "unreadable", "current", "stale", "unknown"] as const;
export type ContextState = (typeof CONTEXT_STATES)[number];

/** The words for a context that needs rebuilding — the CLI's label for its own stale state, and the workflow's. */
export const NEEDS_REBUILD_HEADLINE = "Context status: Needs rebuild";

export function contextPreviewArgs(workItemId?: string): readonly string[] {
  return ["context-preview", ...(workItemId ? [workItemId] : []), "--json"];
}

export function readsContextPreview(report: Readonly<Record<string, unknown>> | undefined): boolean {
  const capabilities = report?.["capabilities"];
  return Array.isArray(capabilities) && capabilities.includes(CONTEXT_PREVIEW_CAPABILITY);
}

export interface ContextReason {
  readonly code: string;
  readonly label: string;
}

export interface ContextQualityFacts {
  readonly overall: number;
  readonly issueCompleteness: number;
  readonly retrievalQuality: number;
  readonly repositoryContext: number;
  readonly cap?: number;
}

export interface ContextRetrievalFacts {
  readonly confidence: string;
  readonly reasons: readonly string[];
  readonly relatedFiles: number;
  readonly terms: number;
  readonly gitHistory?: { readonly status: string; readonly commits: number };
}

export interface ContextSourceFacts {
  readonly issue?: { readonly source: string; readonly mock: boolean };
  readonly hint?: boolean;
  readonly attachments?: number;
  readonly fixMode?: string;
  readonly codeSearch: boolean;
  readonly gitHistory?: string;
  readonly similarFixes?: boolean;
}

export interface ContextPreviewSnapshot {
  readonly state: ContextState;
  readonly label: string;
  readonly workItem?: string;
  readonly text?: string;
  readonly reasons: readonly ContextReason[];
  readonly unchecked: readonly ContextReason[];
  readonly quality?: ContextQualityFacts;
  readonly retrieval?: ContextRetrievalFacts;
  readonly sources?: ContextSourceFacts;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export type ContextPreviewOutcome =
  | { readonly kind: "loaded"; readonly snapshot: ContextPreviewSnapshot }
  | { readonly kind: "outdated" }
  | { readonly kind: "failed"; readonly message: string };

const MAX_CONTEXT_CHARS = 2_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function strings(value: unknown, max: number, count: number): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string").slice(0, count).map((item) => item.slice(0, max))
    : [];
}

function reasons(value: unknown): ContextReason[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => ({ code: str(item["code"], 80) ?? "", label: str(item["label"], 400) ?? "" }))
    .filter((item) => item.code !== "" && item.label !== "")
    .slice(0, 30);
}

/** The snapshot, or `undefined` when the envelope is not one. Untrusted input: anything off is refused, never guessed. */
export function contextPreviewFromEnvelope(envelope: unknown): ContextPreviewSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true) return undefined;
  const state = payload["state"];
  if (typeof state !== "string" || !(CONTEXT_STATES as readonly string[]).includes(state)) return undefined;
  const label = str(payload["label"], 400);
  if (!label) return undefined;
  const text = payload["text"] === null || payload["text"] === undefined ? undefined : str(payload["text"], MAX_CONTEXT_CHARS);
  if (payload["text"] !== null && payload["text"] !== undefined && text === undefined) return undefined;
  // A context is shown exactly when the CLI says there is one to show.
  const shows = state === "current" || state === "stale" || state === "unknown";
  if (shows !== (text !== undefined)) return undefined;
  const freshness = record(payload["freshness"]);
  const quality = record(payload["quality"]);
  const retrieval = record(payload["retrieval"]);
  const history = record(retrieval?.["git_history"]);
  const sources = record(payload["sources"]);
  const issue = record(sources?.["issue"]);
  const fixMode = record(sources?.["fix_mode"]);
  const overall = int(quality?.["overall"]);
  const workItem = str(payload["work_item"], 120);
  return {
    state: state as ContextState,
    label,
    ...(workItem ? { workItem } : {}),
    ...(text !== undefined ? { text } : {}),
    reasons: reasons(freshness?.["reasons"]),
    unchecked: reasons(freshness?.["unchecked"]),
    ...(quality && overall !== undefined
      ? {
          quality: {
            overall,
            issueCompleteness: int(quality["issue_completeness"]) ?? 0,
            retrievalQuality: int(quality["retrieval_quality"]) ?? 0,
            repositoryContext: int(quality["repository_context"]) ?? 0,
            ...(int(quality["cap"]) !== undefined ? { cap: int(quality["cap"])! } : {}),
          },
        }
      : {}),
    ...(retrieval && str(retrieval["confidence"], 20)
      ? {
          retrieval: {
            confidence: str(retrieval["confidence"], 20)!,
            reasons: strings(retrieval["reasons"], 300, 20),
            relatedFiles: int(retrieval["related_files"]) ?? 0,
            terms: int(retrieval["terms"]) ?? 0,
            ...(history && str(history["status"], 40) ? { gitHistory: { status: str(history["status"], 40)!, commits: int(history["commits"]) ?? 0 } } : {}),
          },
        }
      : {}),
    ...(sources
      ? {
          sources: {
            ...(issue && str(issue["source"], 20) ? { issue: { source: str(issue["source"], 20)!, mock: issue["mock"] === true } } : {}),
            ...(typeof sources["hint"] === "boolean" ? { hint: sources["hint"] as boolean } : {}),
            ...(int(sources["attachments"]) !== undefined ? { attachments: int(sources["attachments"])! } : {}),
            ...(str(fixMode?.["name"], 200) ? { fixMode: str(fixMode?.["name"], 200)! } : {}),
            codeSearch: sources["code_search"] === true,
            ...(str(sources["git_history"], 40) ? { gitHistory: str(sources["git_history"], 40)! } : {}),
            ...(typeof sources["similar_fixes"] === "boolean" ? { similarFixes: sources["similar_fixes"] as boolean } : {}),
          },
        }
      : {}),
    problems: strings(payload["problems"], 400, 20),
    warnings: strings(payload["warnings"], 400, 20),
  };
}

export interface ContextPreviewRunResult extends ProcessExit {
  readonly stdout: string;
}

export async function runContextPreview(
  run: (args: readonly string[]) => Promise<ContextPreviewRunResult>,
  workItemId?: string,
): Promise<ContextPreviewOutcome> {
  try {
    const result = await run(contextPreviewArgs(workItemId));
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
    const snapshot = contextPreviewFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no context status." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}

// --- merging with the panel's own freshness ------------------------------------------------------

/** What the panel knows about the package it prepared, from its existing fingerprints. */
export interface PanelFreshness {
  /** The panel prepared a package, and it is for the work item the CLI was asked about. */
  readonly preparedHere: boolean;
  /** Retrieval inputs or run settings in the form no longer describe the package. */
  readonly formChanged: boolean;
  /** The instructions, Verification Policy or AI Behavior changed since preparing, by the panel's fingerprint. */
  readonly policiesChanged: boolean;
}

export const PANEL_FORM_REASON: ContextReason = {
  code: "panel_inputs_changed",
  label: "Retrieval inputs or run settings (changed in the panel since this context was prepared)",
};
export const PANEL_POLICY_REASON: ContextReason = {
  code: "panel_policies_changed",
  label: "Instructions, Verification Policy or AI Behavior (changed since this context was prepared)",
};

/** The CLI's reason codes that already say a policy changed, so the panel's policy reason would only repeat them. */
const POLICY_REASON_CODES = new Set([
  "project_instructions_changed",
  "user_instructions_changed",
  "verification_changed",
  "ai_behavior_changed",
]);

export interface ContextFact {
  readonly label: string;
  readonly value: string;
}

export interface ContextStatusView {
  /** The merged state: the CLI's, or `stale` where the panel knows better. */
  readonly state: ContextState;
  readonly headline: string;
  readonly needsRebuild: boolean;
  readonly reasons: readonly ContextReason[];
  /** What neither the CLI nor the panel checked, said rather than assumed. */
  readonly notChecked: readonly string[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly facts: readonly ContextFact[];
  /** The last generated context, exactly as stored; absent when there is none to show. */
  readonly text?: string;
}

function factsOf(snapshot: ContextPreviewSnapshot): ContextFact[] {
  const facts: ContextFact[] = [];
  const quality = snapshot.quality;
  if (quality) {
    const capped = quality.cap !== undefined ? `; capped at ${quality.cap}` : "";
    facts.push({
      label: "Context quality",
      value: `${quality.overall}/100 (issue ${quality.issueCompleteness} · retrieval ${quality.retrievalQuality} · repository ${quality.repositoryContext}${capped})`,
    });
  }
  const retrieval = snapshot.retrieval;
  if (retrieval) {
    facts.push({ label: "Search confidence", value: retrieval.confidence });
    facts.push({ label: "Related files", value: String(retrieval.relatedFiles) });
    if (retrieval.gitHistory) {
      facts.push({ label: "Git history", value: `${retrieval.gitHistory.status} · ${retrieval.gitHistory.commits} commit${retrieval.gitHistory.commits === 1 ? "" : "s"}` });
    }
  }
  const sources = snapshot.sources;
  if (sources) {
    if (sources.issue) facts.push({ label: "Issue", value: `${sources.issue.source === "jira" ? "Jira issue" : "Hand-written description"}${sources.issue.mock ? " (mock data)" : ""}` });
    if (sources.similarFixes !== undefined) facts.push({ label: "Similar fixes", value: sources.similarFixes ? "Found" : "None found" });
    if (sources.hint !== undefined) facts.push({ label: "Developer hint", value: sources.hint ? "Yes" : "No" });
    if (sources.attachments !== undefined) facts.push({ label: "Attachments", value: String(sources.attachments) });
    if (sources.fixMode) facts.push({ label: "Fix Mode", value: sources.fixMode });
  }
  return facts;
}

/** The CLI's status merged with the panel's freshness, by the rules at the top of this file. */
export function contextStatusView(snapshot: ContextPreviewSnapshot, panel: PanelFreshness): ContextStatusView {
  const hasContext = snapshot.text !== undefined;
  const panelReasons: ContextReason[] = [];
  if (hasContext && panel.preparedHere) {
    if (panel.formChanged) panelReasons.push(PANEL_FORM_REASON);
    if (panel.policiesChanged && !snapshot.reasons.some((reason) => POLICY_REASON_CODES.has(reason.code))) {
      panelReasons.push(PANEL_POLICY_REASON);
    }
  }
  const reasons = [...snapshot.reasons, ...panelReasons];
  let state: ContextState = snapshot.state;
  if (hasContext && reasons.length > 0) state = "stale";
  const headline = state === "stale" ? NEEDS_REBUILD_HEADLINE : snapshot.label;
  // The panel compares its own retrieval inputs only for the package it prepared.
  const notChecked = snapshot.unchecked
    .filter((item) => !(panel.preparedHere && item.code === "retrieval_inputs"))
    .map((item) => item.label);
  return {
    state,
    headline,
    needsRebuild: state === "stale" || state === "missing" || state === "unreadable",
    reasons,
    notChecked: hasContext ? notChecked : [],
    problems: snapshot.problems,
    warnings: snapshot.warnings,
    facts: hasContext ? factsOf(snapshot) : [],
    ...(snapshot.text !== undefined ? { text: snapshot.text } : {}),
  };
}
