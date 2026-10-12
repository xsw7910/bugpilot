/**
 * BugPilot's protected rules, as the host shows them (0.1.4).
 *
 * Read from `bugpilot protected-rules show --json` — the same rule objects the
 * CLI writes into every task — and never from a copy here: no rule text, id,
 * group or precedence layer is spelled in TypeScript. The viewer is
 * informational. It writes nothing and marks nothing stale.
 *
 * A CLI without the `protected-rules` capability simply has nothing to show;
 * that never blocks preparing a task.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";

/** The `doctor --json` capability of a CLI that answers `bugpilot protected-rules`. */
export const PROTECTED_RULES_CAPABILITY = "protected-rules";

export interface ProtectedRuleView {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** The task section that states it. */
  readonly section: string;
}

export interface ProtectedRuleGroupView {
  readonly id: string;
  readonly title: string;
  readonly rules: readonly ProtectedRuleView[];
}

/** What `bugpilot protected-rules show --json` said, as the viewer draws it. */
export interface ProtectedRulesSnapshot {
  readonly rulesVersion: number;
  /** What BugPilot does with the rules, and what it cannot do, in the CLI's words. */
  readonly contract: readonly string[];
  readonly groups: readonly ProtectedRuleGroupView[];
  /** The task's precedence layers, highest first. */
  readonly precedence: readonly string[];
}

export type ProtectedRulesOutcome =
  | { readonly kind: "loaded"; readonly snapshot: ProtectedRulesSnapshot }
  | { readonly kind: "outdated" }
  | { readonly kind: "failed"; readonly message: string };

export function protectedRulesArgs(): readonly string[] {
  return ["protected-rules", "show", "--json"];
}

export function readsProtectedRules(report: Readonly<Record<string, unknown>> | undefined): boolean {
  const capabilities = report?.["capabilities"];
  return Array.isArray(capabilities) && capabilities.includes(PROTECTED_RULES_CAPABILITY);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : undefined;
}

/** The snapshot, or `undefined` when the envelope is not one. Untrusted input: anything off is refused. */
export function protectedRulesFromEnvelope(envelope: unknown): ProtectedRulesSnapshot | undefined {
  const payload = record(envelope);
  if (!payload || payload["ok"] !== true || payload["editable"] !== false) return undefined;
  const rulesVersion = payload["rules_version"];
  if (typeof rulesVersion !== "number" || !Number.isInteger(rulesVersion) || rulesVersion < 1) return undefined;
  if (!Array.isArray(payload["rules"]) || !Array.isArray(payload["groups"])) return undefined;
  const rules = new Map<string, ProtectedRuleView & { readonly group: string }>();
  for (const raw of payload["rules"] as unknown[]) {
    const rule = record(raw);
    const id = text(rule?.["id"], 80);
    const group = text(rule?.["group"], 80);
    const title = text(rule?.["title"], 200);
    const body = text(rule?.["text"], 2000);
    const section = text(rule?.["section"], 200);
    if (!id || !group || !title || !body || !section) return undefined;
    rules.set(id, { id, group, title, text: body, section });
  }
  const groups: ProtectedRuleGroupView[] = [];
  for (const raw of payload["groups"] as unknown[]) {
    const group = record(raw);
    const id = text(group?.["id"], 80);
    const title = text(group?.["title"], 200);
    const ids = Array.isArray(group?.["rules"]) ? (group!["rules"] as unknown[]) : undefined;
    if (!id || !title || !ids) return undefined;
    const members: ProtectedRuleView[] = [];
    for (const ruleId of ids) {
      const rule = typeof ruleId === "string" ? rules.get(ruleId) : undefined;
      if (!rule || rule.group !== id) return undefined;
      members.push({ id: rule.id, title: rule.title, text: rule.text, section: rule.section });
    }
    groups.push({ id, title, rules: members });
  }
  const contract = Array.isArray(payload["contract"])
    ? (payload["contract"] as unknown[]).map((line) => text(line, 1000)).filter((line): line is string => line !== undefined)
    : [];
  const layers = record(payload["precedence"])?.["layers"];
  const precedence = Array.isArray(layers)
    ? (layers as unknown[]).map((layer) => text(record(layer)?.["name"], 200)).filter((name): name is string => name !== undefined)
    : [];
  return { rulesVersion, contract, groups, precedence };
}

export interface ProtectedRulesRunResult extends ProcessExit {
  readonly stdout: string;
}

/** Ask the CLI. An argparse rejection is an older CLI, said as such; anything else is a failure in one sentence. */
export async function runProtectedRules(run: (args: readonly string[]) => Promise<ProtectedRulesRunResult>): Promise<ProtectedRulesOutcome> {
  try {
    const result = await run(protectedRulesArgs());
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
    const snapshot = protectedRulesFromEnvelope(envelope);
    return snapshot ? { kind: "loaded", snapshot } : { kind: "failed", message: "bugpilot returned no protected rules." };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}
