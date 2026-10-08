/**
 * The Jira site, for Jira Setup.
 *
 * The site is not a secret, so it is not kept with the email and token in
 * SecretStorage: it lives where the CLI reads it, `~/.bugpilot/config.toml`,
 * written through `bugpilot jira-site set`. One site for the CLI and the panel,
 * never two that can disagree. `JIRA_BASE_URL` in the environment wins over the
 * file — for the CLI and for every run this panel starts — so when it is set
 * the dialog shows it and does not offer to change it.
 *
 * The CLI validates (`jira.normalize_jira_site`, the one check every Jira
 * request uses); this module only carries the answer. The typed site goes on
 * stdin: a mistyped one with a password in it never reaches a command line.
 *
 * Node-only: no `vscode` import.
 */

import { parseEnvelope, ProtocolError } from "../protocol.ts";
import type { ProcessExit } from "./cliCompatibility.ts";
import { rejectedByOutdatedCli } from "./cliCompatibility.ts";

/** The longest site the panel sends; far above any real address. */
export const JIRA_SITE_CAP = 2048;

export type JiraSiteOutcome =
  | {
      readonly kind: "loaded";
      /** The site Jira requests would use, or undefined when none is usable. */
      readonly site?: string;
      /** `JIRA_BASE_URL` is set: it is the site, and the file's is not used. */
      readonly fromEnvironment: boolean;
      /** Why a configured site is not usable — never the value itself. */
      readonly problem?: string;
    }
  | { readonly kind: "outdated"; readonly rejected: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

export function jiraSiteArgs(save: boolean): readonly string[] {
  return save ? ["jira-site", "set", "--stdin", "--json"] : ["jira-site", "show", "--json"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface JiraSiteRunResult extends ProcessExit {
  readonly stdout: string;
}

/** Read the site, or save one and read it back, through the CLI. */
export async function runJiraSite(
  run: (args: readonly string[], input?: string) => Promise<JiraSiteRunResult>,
  site?: string,
): Promise<JiraSiteOutcome> {
  try {
    const result = await run(jiraSiteArgs(site !== undefined), site === undefined ? undefined : `${site}\n`);
    if (rejectedByOutdatedCli(result) !== undefined) return { kind: "outdated", rejected: ["jira-site"] };
    let envelope: unknown;
    try {
      envelope = parseEnvelope(result.stdout, result.stderr);
    } catch (error) {
      return { kind: "failed", message: error instanceof ProtocolError ? error.message : String(error) };
    }
    const payload = record(envelope);
    const failure = record(payload?.["error"]);
    if (failure) {
      const message = typeof failure["message"] === "string" ? failure["message"].trim() : "";
      return { kind: "failed", message: message || "bugpilot gave no reason." };
    }
    if (!payload || payload["ok"] !== true) return { kind: "failed", message: "bugpilot returned no Jira site." };
    const value = payload["site"];
    const usable = typeof value === "string" && value.startsWith("https://") && value.length <= JIRA_SITE_CAP ? value : undefined;
    const problem = typeof payload["problem"] === "string" && payload["problem"].trim() !== "" ? payload["problem"].trim().slice(0, 300) : undefined;
    return {
      kind: "loaded",
      ...(usable === undefined ? {} : { site: usable }),
      fromEnvironment: payload["source"] === "environment",
      ...(problem === undefined ? {} : { problem }),
    };
  } catch (error) {
    return { kind: "failed", message: (error as Error).message };
  }
}
