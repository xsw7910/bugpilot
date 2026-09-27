/**
 * What Fix result shows of `verification_report.md` (Batch 12): the counts of
 * recorded statuses, the scoped overall phrase, and up to five checks — and,
 * when the file is in BugPilot's own shape, every check, for Edit.
 *
 * The report is verification evidence somebody recorded — `bugpilot
 * record-verification` writes it, the developer may edit it. A status in it is
 * what the user recorded for one check; BugPilot ran nothing. So nothing here
 * produces a verdict: the overall phrase is generated from the counts, the same
 * four sentences `bugpilot/core/verification_report.py` writes, never read out
 * of the file (a hand-edited "Fix verified" stays in the file, not on screen).
 *
 * Two readings, as in the Python reader. Tolerant, for the preview: each
 * `### Check N: name` heading with the first `Status:` and `Type:` lines under
 * it. Strict, for Edit: the exact shape the writer produces, field text
 * unquoted — or nothing, so a hand-edited report is never turned into checks by
 * guesswork.
 */

/** The recorded statuses and types, as stored in JSON and sent by the page. */
export type CheckStatus = "passed" | "failed" | "not_run";
export type CheckType = "automated" | "manual" | "other";

export const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  passed: "Passed",
  failed: "Failed",
  not_run: "Not Run",
};
export const TYPE_LABELS: Readonly<Record<CheckType, string>> = {
  automated: "Automated",
  manual: "Manual",
  other: "Other",
};

/** One check, whole: what the editor holds and the CLI receives. */
export interface VerificationCheckEntry {
  readonly name: string;
  readonly status: CheckStatus;
  readonly type: CheckType;
  readonly procedure: string;
  readonly evidence: string;
  readonly notes: string;
}

/** One previewed check: its name and what was recorded, never its text. */
export interface CheckPreview {
  readonly name: string;
  readonly status?: CheckStatus;
  readonly type?: CheckType;
}

export interface VerificationReportPreview {
  /** Whether the file could be read. Listed but unreadable is still a report to open. */
  readonly readable: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  /** Up to `MAX_PREVIEWED_CHECKS`, in the report's order. */
  readonly preview: readonly CheckPreview[];
  /** How many checks the report holds beyond the preview. */
  readonly more: number;
  /** Every check, only when the report is in the canonical shape. */
  readonly checks?: readonly VerificationCheckEntry[];
}

/** The generated conclusions: scoped to recorded checks, never "verified". */
export const ALL_PASSED = "All recorded checks passed.";
export const INCLUDES_FAILURES = "Recorded checks include failures.";
export const NONE_RUN = "No recorded check has been run.";
export const MIXED = "Recorded checks have mixed or incomplete status.";

export const MAX_PREVIEWED_CHECKS = 5;

/** The writer's text for a field left empty. */
export const NOT_RECORDED = "Not recorded.";

/**
 * Only the start of a pathological file is parsed. Far above the largest report
 * the writer produces (25 checks, three 20,000-character fields, each line
 * quoted), so a canonical report is always read whole.
 */
const MAX_SCANNED_CHARS = 8 * 1024 * 1024;

const FIELDS: readonly (readonly ["procedure" | "evidence" | "notes", string])[] = [
  ["procedure", "Command / Procedure:"],
  ["evidence", "Evidence:"],
  ["notes", "Notes:"],
];
const CHECK_HEADING = /^### Check (\d+): (.*)$/;
const STATUS_LINE = /^Status: (.+)$/;
const TYPE_LINE = /^Type: (.+)$/;

const STATUS_OF = invert(STATUS_LABELS);
const TYPE_OF = invert(TYPE_LABELS);

/** The one phrase for these counts — the same rule the writer uses. */
export function overallPhrase(passed: number, failed: number, notRun: number): string {
  if (failed > 0) return INCLUDES_FAILURES;
  if (passed > 0 && notRun === 0) return ALL_PASSED;
  if (notRun > 0 && passed === 0) return NONE_RUN;
  return MIXED;
}

export function parseVerificationReport(text: string | undefined): VerificationReportPreview {
  if (text === undefined) return { readable: false, passed: 0, failed: 0, notRun: 0, preview: [], more: 0 };
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const block = checksBlock(scanned.split(/\r\n|\r|\n/));
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  for (const line of block) {
    const status = statusOf(STATUS_LINE.exec(line)?.[1]?.trim());
    if (status === "passed") passed += 1;
    else if (status === "failed") failed += 1;
    else if (status === "not_run") notRun += 1;
  }
  const previews = tolerantChecks(block);
  const checks = text.length > MAX_SCANNED_CHARS ? undefined : strictChecks(block);
  return {
    readable: true,
    passed,
    failed,
    notRun,
    preview: previews.slice(0, MAX_PREVIEWED_CHECKS),
    more: Math.max(0, previews.length - MAX_PREVIEWED_CHECKS),
    ...(checks === undefined ? {} : { checks }),
  };
}

/** The lines of `## Checks`, up to the next `## ` heading. */
function checksBlock(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((line) => line.trim() === "## Checks");
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    block.push(line);
  }
  return block;
}

/** Every check heading, with the first status and type under it. */
function tolerantChecks(block: readonly string[]): CheckPreview[] {
  const found: { name: string; status?: CheckStatus; type?: CheckType }[] = [];
  for (const line of block) {
    const heading = CHECK_HEADING.exec(line);
    if (heading) {
      found.push({ name: (heading[2] ?? "").trim() || "Unnamed check" });
      continue;
    }
    const current = found.at(-1);
    if (current === undefined) continue;
    const status = statusOf(STATUS_LINE.exec(line)?.[1]?.trim());
    if (status !== undefined && current.status === undefined) current.status = status;
    const kind = typeOf(TYPE_LINE.exec(line)?.[1]?.trim());
    if (kind !== undefined && current.type === undefined) current.type = kind;
  }
  return found;
}

/** The checks, if the block is exactly what the writer produces; else undefined. */
function strictChecks(block: readonly string[]): VerificationCheckEntry[] | undefined {
  let position = 0;
  const skipBlank = (): void => {
    while (position < block.length && block[position] === "") position += 1;
  };
  const checks: VerificationCheckEntry[] = [];
  skipBlank();
  while (position < block.length) {
    const heading = CHECK_HEADING.exec(block[position] ?? "");
    if (!heading || Number(heading[1]) !== checks.length + 1) return undefined;
    position += 1;
    skipBlank();
    const status = statusOf(STATUS_LINE.exec(block[position] ?? "")?.[1]);
    if (status === undefined) return undefined;
    position += 1;
    const kind = typeOf(TYPE_LINE.exec(block[position] ?? "")?.[1]);
    if (kind === undefined) return undefined;
    position += 1;
    const fields: Record<string, string> = {};
    for (const [key, label] of FIELDS) {
      skipBlank();
      if (block[position] !== label) return undefined;
      position += 1;
      skipBlank();
      if (block[position] === NOT_RECORDED) {
        fields[key] = "";
        position += 1;
        continue;
      }
      const quoted: string[] = [];
      while (position < block.length && (block[position] ?? "").startsWith(">")) {
        const line = block[position] ?? "";
        quoted.push(line.startsWith("> ") ? line.slice(2) : line.slice(1));
        position += 1;
      }
      if (quoted.length === 0) return undefined;
      fields[key] = quoted.join("\n");
    }
    checks.push({
      name: heading[2] ?? "",
      status,
      type: kind,
      procedure: fields["procedure"] ?? "",
      evidence: fields["evidence"] ?? "",
      notes: fields["notes"] ?? "",
    });
    skipBlank();
  }
  return checks.length === 0 ? undefined : checks;
}

function statusOf(label: string | undefined): CheckStatus | undefined {
  return label === undefined ? undefined : STATUS_OF.get(label);
}

function typeOf(label: string | undefined): CheckType | undefined {
  return label === undefined ? undefined : TYPE_OF.get(label);
}

function invert<K extends string>(labels: Readonly<Record<K, string>>): ReadonlyMap<string, K> {
  return new Map(Object.entries(labels).map(([key, label]) => [label as string, key as K]));
}
