/**
 * The one reader of `issue.json`, for the Issue details row.
 *
 * The row needs three facts after a run — which work item, where it came from,
 * and what it is called — and all three are fields of the normalized issue
 * BugPilot already wrote. So they are read here, once, on the host; the page is
 * handed the finished sentence and never sees the schema.
 *
 * Shallow and strict like `retrieval.ts`: version 1 only, and a missing file,
 * invalid JSON, a wrong `schema_version` or a field of the wrong type is "not
 * known" rather than a guess. A row that says "Completed" is better than one
 * that names the wrong issue.
 */

import { isRecord } from "./retrieval.ts";

/** Written by `bugpilot/core/artifacts.py` as `ISSUE_ARTIFACT`. */
export const ISSUE_ARTIFACT = "issue.json";

const SCHEMA_VERSION = 1;

export interface IssueSummary {
  readonly id: string;
  /** `jira` or `manual`, as `issue.json` records it. */
  readonly source: string;
  /** Empty when the issue has none: a Jira stub, or a description with no title. */
  readonly title: string;
}

export function parseIssue(text: string | undefined): IssueSummary | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["schema_version"] !== SCHEMA_VERSION) return undefined;
  const id = value["id"];
  const source = value["source"];
  const title = value["title"];
  if (typeof id !== "string" || id.trim() === "" || typeof source !== "string") return undefined;
  return {
    id: id.trim(),
    source,
    title: typeof title === "string" ? title.trim() : "",
  };
}
