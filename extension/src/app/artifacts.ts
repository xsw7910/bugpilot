/**
 * What the Results tree shows (§37.106): a work item's artifacts, under
 * Current, and the history list, under History.
 *
 * bugpilot produces a handful of files per work item and they are not equally
 * interesting: `task.md` is the one a developer opens, `run.json` is
 * bookkeeping. So the list is one flat list (§37.88) in the order the workflow
 * produces them — the issue, the context, the task, the fix, its review and its
 * verification, then the technical files, then side-band outputs — each with a
 * plain sentence saying what it is for, and whether it has been written.
 *
 * The file names here were taken from a real run, not from the design doc, and
 * follow the artifact contract in `bugpilot/core/artifacts.py`.
 *
 * Both models are pure: the host supplies directory names and `list --json`
 * output, and every state §5.4 requires (empty, loading, error) is a value
 * rather than a thrown exception.
 */

import { isWorkItemId } from "./form.ts";

/**
 * The context and task artifacts, as `bugpilot/core/artifacts.py` names them.
 *
 * Spelled once here so the controller, the workflow rows and this grouping
 * cannot disagree about which file a button needs. There is no constant for any
 * earlier name: a work item prepared before these files existed is re-prepared.
 */
export const CONTEXT_ARTIFACT = "context.md";

/** The one runtime-state artifact: overall status, step marks, generated files. */
export const RUN_ARTIFACT = "run.json";
export const TASK_ARTIFACT = "task.md";

/** The one post-agent report (Batch 5), written by the agent, never by a prepare run. */
export const FIX_REPORT_ARTIFACT = "fix_report.md";

/**
 * A review's result, as somebody recorded it (Batch 11) — only `record-review`
 * writes it. Not a result file the agent owes: never listed as missing.
 */
export const REVIEW_REPORT_ARTIFACT = "review_report.md";

/**
 * Verification evidence, as somebody recorded it (Batch 12) — only
 * `record-verification` writes it. Optional like the review report: never listed
 * as missing, and its presence changes no outcome.
 */
export const VERIFICATION_REPORT_ARTIFACT = "verification_report.md";

export type ArtifactKind = "markdown" | "json" | "mail" | "log" | "other";

/**
 * Every artifact BugPilot knows, in the one place that says what each is for.
 *
 * `order` is the workflow's, not the alphabet's: input and context, the AI's
 * task, its result, the review, the verification, the technical files, then
 * side-band outputs. `canonical` files — the artifact contract in
 * `bugpilot/core/artifacts.py`, which `test/artifacts.test.ts` compares this
 * against — are always listed, written or not, so a developer can see what is
 * still to come; the others only once they exist. `writtenWhen` is for the
 * tooltip of a file not written yet.
 */
export interface ArtifactInfo {
  readonly order: number;
  readonly description: string;
  readonly canonical: boolean;
  readonly writtenWhen?: string;
}

export const ARTIFACTS: Readonly<Record<string, ArtifactInfo>> = {
  "issue.json": {
    order: 10,
    description: "Issue details or manual bug description",
    canonical: true,
    writtenWhen: "Written when a run reads the Jira issue or your description.",
  },
  "context.md": {
    order: 20,
    description: "Prepared context used by the AI",
    canonical: true,
    writtenWhen: "Written when Build context finishes.",
  },
  "task.md": {
    order: 30,
    description: "AI task and fix instructions",
    canonical: true,
    writtenWhen: "Written with the context, for Fix with AI to hand over.",
  },
  "fix_report.md": {
    order: 40,
    description: "Summary of the AI fix and changes",
    canonical: true,
    writtenWhen: "Written by the AI agent when it finishes an attempt.",
  },
  "review_report.md": {
    order: 50,
    description: "Saved review findings",
    canonical: true,
    writtenWhen: "Written when a review result is saved.",
  },
  "verification_report.md": {
    order: 60,
    description: "Recorded verification checks",
    canonical: true,
    writtenWhen: "Written when verification evidence is recorded.",
  },
  "retrieval.json": {
    order: 70,
    description: "Investigation and retrieval details",
    canonical: true,
    writtenWhen: "Written when Code search finishes.",
  },
  "run.json": {
    order: 80,
    description: "Workflow execution metadata",
    canonical: true,
    writtenWhen: "Written when a run starts.",
  },
  "user_feedback.md": { order: 110, description: "Feedback provided for a new AI attempt", canonical: false },
  "agent_retry_prompt.md": { order: 120, description: "Instructions prepared for the next AI attempt", canonical: false },
  "jira_comment_draft.md": { order: 130, description: "Draft Jira comment prepared by BugPilot", canonical: false },
  "jira_comment_post_result.json": { order: 140, description: "Result of the Jira comment posting action", canonical: false },
  "email_draft.md": { order: 150, description: "Draft email prepared by BugPilot", canonical: false },
  "notification.eml": { order: 160, description: "Generated email notification", canonical: false },
  "jira_field_report.md": { order: 170, description: "Jira field inspection report", canonical: false },
};

/** What a file BugPilot does not know is said to be — never a guessed purpose. */
export const UNKNOWN_ARTIFACT_DESCRIPTION = "Additional BugPilot artifact";

export const ARTIFACT_WRITTEN = "Written";
export const ARTIFACT_NOT_WRITTEN = "Not written yet";

export interface ArtifactEntry {
  readonly name: string;
  readonly kind: ArtifactKind;
  /** What the file is for, in plain words. */
  readonly description: string;
  /** On disk now. A canonical file not written yet is listed, and opens nothing. */
  readonly written: boolean;
  /** For a file not written yet: what writes it. */
  readonly writtenWhen?: string;
}

export type ArtifactList =
  | { readonly kind: "loading" }
  /** One flat list, in workflow order: no groups between Artifacts and the files. */
  | { readonly kind: "ready"; readonly entries: readonly ArtifactEntry[] }
  /** The directory exists but holds nothing worth showing. */
  | { readonly kind: "empty"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export function artifactKind(name: string): ArtifactKind {
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".eml")) return "mail";
  if (name.endsWith(".log")) return "log";
  return "other";
}

/** Written, or not yet — the one availability word a row carries. */
export function artifactStatus(entry: Pick<ArtifactEntry, "written">): string {
  return entry.written ? ARTIFACT_WRITTEN : ARTIFACT_NOT_WRITTEN;
}

export interface ArtifactInput {
  /** File names directly inside `.ai/<work_item>/`. */
  readonly names: readonly string[];
}

/**
 * The flat list for a work item's directory.
 *
 * Every canonical artifact, written or not; every other file that is there —
 * side-band outputs in their place, then files BugPilot does not know, by
 * name, after all of them. Nothing at all on disk is the empty state: there is
 * no run yet to list the files of.
 */
export function buildArtifactList(input: ArtifactInput): ArtifactList {
  const present = new Set(input.names.filter((name) => name.trim() !== ""));
  if (present.size === 0) {
    return {
      kind: "empty",
      detail: "No artifacts yet. Run BugPilot on this work item to produce them.",
    };
  }
  const names = new Set([
    ...Object.keys(ARTIFACTS).filter((name) => ARTIFACTS[name]!.canonical),
    ...present,
  ]);
  const entries = [...names].map((name): ArtifactEntry => {
    const info = ARTIFACTS[name];
    const written = present.has(name);
    return {
      name,
      kind: artifactKind(name),
      description: info?.description ?? UNKNOWN_ARTIFACT_DESCRIPTION,
      written,
      ...(!written && info?.writtenWhen !== undefined ? { writtenWhen: info.writtenWhen } : {}),
    };
  });
  return { kind: "ready", entries: entries.sort(compareEntries) };
}

/**
 * One tree row, as Current draws it (§37.90): the file name and its
 * availability — nothing else on the line, so a narrow sidebar stays readable.
 * What the file is for is in the tooltip, with the full name (which a narrow
 * sidebar may cut) and the status, and in the accessible name, so a screen
 * reader loses nothing. Only a written file opens; the file's own type is its
 * icon, and no status glyph repeats what the word says.
 */
export interface ArtifactRow {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly accessibleName: string;
  readonly icon: "markdown" | "json" | "mail" | "output" | "file";
  readonly opens: boolean;
}

export function artifactRow(entry: ArtifactEntry): ArtifactRow {
  const status = artifactStatus(entry);
  return {
    label: entry.name,
    description: status,
    // Names and fixed sentences only: never the file's contents.
    tooltip: [entry.name, entry.description, `Status: ${status}`, ...(entry.writtenWhen ? [entry.writtenWhen] : [])].join("\n"),
    accessibleName: `${entry.name} — ${entry.description} — ${status}`,
    icon:
      entry.kind === "markdown"
        ? "markdown"
        : entry.kind === "json"
          ? "json"
          : entry.kind === "mail"
            ? "mail"
            : entry.kind === "log"
              ? "output"
              : "file",
    opens: entry.written,
  };
}

/** Known files by workflow order; unknown ones after them all, by name. */
function compareEntries(left: ArtifactEntry, right: ArtifactEntry): number {
  const rank = (entry: ArtifactEntry) => ARTIFACTS[entry.name]?.order ?? Number.MAX_SAFE_INTEGER;
  const byRank = rank(left) - rank(right);
  return byRank !== 0 ? byRank : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// --- history ---------------------------------------------------------------

export interface HistoryItem {
  readonly workItemId: string;
  readonly source?: string | undefined;
  readonly title?: string | undefined;
  /** False for a directory whose run never wrote `run.json`. */
  readonly prepared: boolean;
  readonly modifiedMs?: number | undefined;
  /**
   * How far this work item got, when the host was able to look.
   *
   * Absent means "not probed", which is different from `prepared`: a row can be
   * listed before its directory has been read.
   */
  readonly outcome?: HistoryOutcome | undefined;
  /** The step named in the status file as having failed, when one is. */
  readonly failedStep?: string | undefined;
}

/**
 * What became of a work item, most actionable first.
 *
 * Every row used to carry the same bug icon and the same one line, so a
 * successful investigation, a failed one, and a directory whose run died
 * halfway all looked identical. These are the answers worth telling apart, and
 * the order below is the precedence: a run that never finished cannot also be
 * reported as prepared, and anything from the retry loop says more than the fix
 * summary it came after.
 *
 * `retrying` and `retried` are separate because the next move is different, and
 * that difference was invisible until this ran against the author's real `.ai/`:
 * two work items reported "a retry is open" while both already had
 * `agent_retry_prompt.md`, so nothing was waiting on anybody — the package was
 * built and needed handing over.
 */
export type HistoryOutcome =
  | "incomplete"
  | "failed"
  | "retried"
  | "retrying"
  | "fixed"
  | "prepared";

/**
 * The files whose mere presence answers the question.
 *
 * All written by something other than the prepare run — which is why they are
 * the interesting ones: they say whether anybody acted on the package.
 */
const FIX_REPORT = FIX_REPORT_ARTIFACT;
const USER_FEEDBACK = "user_feedback.md";
const RETRY_PROMPT = "agent_retry_prompt.md";
const STATUS_FILE = RUN_ARTIFACT;

/** What the host read out of one work item's directory. */
export interface WorkItemProbe {
  /** File names directly inside `.ai/<work_item>/`. */
  readonly files: readonly string[];
  /** `run.json`, already parsed; undefined when absent or corrupt. */
  readonly status?: unknown;
}

export function historyOutcome(probe: WorkItemProbe): {
  outcome: HistoryOutcome;
  failedStep?: string;
} {
  const present = new Set(probe.files);
  // No run state means the run never got to the end of itself. Said first,
  // because everything below it reads that file.
  if (!present.has(STATUS_FILE)) return { outcome: "incomplete" };

  // The authoritative lifecycle outranks the per-step marks: a run that failed
  // outside any step is still failed, and one still `running` has no outcome
  // to report yet.
  const record = asRecord(probe.status);
  const steps = asRecord(record?.["steps"]) ?? {};
  const failed = Object.entries(steps).find(([, mark]) => mark === "fail")?.[0];
  const state = record?.["status"];
  if (state === "failed") {
    return failed !== undefined ? { outcome: "failed", failedStep: failed } : { outcome: "failed" };
  }
  if (state === "running") return { outcome: "incomplete" };
  if (failed !== undefined) return { outcome: "failed", failedStep: failed };

  // The retry loop outranks the fix it followed: somebody read that fix summary
  // and said it was wrong, which is the newer fact of the two. Which half of
  // the loop matters — the second press builds the package, so its presence is
  // what separates "waiting for you" from "ready for an agent".
  if (present.has(RETRY_PROMPT)) return { outcome: "retried" };
  if (present.has(USER_FEEDBACK)) return { outcome: "retrying" };
  if (present.has(FIX_REPORT)) return { outcome: "fixed" };
  return { outcome: "prepared" };
}

/**
 * The codicon for each outcome.
 *
 * These are the editor's own icons rather than the panel's vendored subset — a
 * `TreeItem` takes any name the installed VS Code knows, which is why the tree
 * gets them free. Each was checked against @vscode/codicons rather than
 * remembered, because a name VS Code does not know renders as nothing at all.
 */
export const OUTCOME_ICONS: Readonly<Record<HistoryOutcome, string>> = {
  incomplete: "circle-outline",
  failed: "error",
  retried: "debug-restart",
  retrying: "comment",
  // A report file, and no more: an agent writes fix_report.md after an
  // investigation-only pass or a failed attempt too. Not the check-badge
  // "verified" it used to be — release stabilization, seen in a real window —
  // since nothing here knows the fix was verified.
  fixed: "file-text",
  prepared: "bug",
};

/** One sentence per outcome, for the hover. */
function outcomeSentence(item: HistoryItem): string {
  switch (item.outcome) {
    case "incomplete":
      return "The run did not finish: run.json never reached a terminal state.";
    case "failed":
      return item.failedStep
        ? `The run failed at the ${item.failedStep} step.`
        : "The run recorded a failure.";
    case "retried":
      return `A second attempt is prepared in ${RETRY_PROMPT}.`;
    case "retrying":
      // Deliberately not "you described what went wrong": the first Retry press
      // only creates the template, so its existence does not prove it was filled in.
      return `A retry is waiting on you — describe the miss in ${USER_FEEDBACK}.`;
    case "fixed":
      return `An agent wrote its report in ${FIX_REPORT}.`;
    case "prepared":
      return "Context is ready; nothing has acted on it yet.";
    default:
      return "";
  }
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  jira: "Jira issue",
  manual: "Bug description",
};

/**
 * How long ago, in words.
 *
 * Coarse on purpose. The timestamp is the *directory's*, so it moves whenever
 * anything writes into the work item — "3 days ago" is a fact, "14:07:32" would
 * imply a precision about what happened that this number does not have.
 */
export function describeAge(modifiedMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - modifiedMs) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? "last month" : `${months} months ago`;
}

/** Everything the tree needs to draw one row. Computed here so it can be tested. */
export interface HistoryRow {
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  /** Several lines; the tree renders them as one hover. */
  readonly tooltip: readonly string[];
}

export function historyRow(item: HistoryItem, nowMs: number): HistoryRow {
  const title = item.title?.trim();
  const source = item.source ? SOURCE_LABELS[item.source] : undefined;
  const sentence = outcomeSentence(item);

  const tooltip = [
    source ? `${item.workItemId} · ${source}` : item.workItemId,
    ...(title && title !== "" ? [title] : []),
    ...(item.modifiedMs === undefined
      ? []
      : [`Last changed ${describeAge(item.modifiedMs, nowMs)}`]),
    ...(sentence === "" ? [] : [sentence]),
    "Click to reopen it in the panel.",
  ];

  return {
    label: item.workItemId,
    // The title when there is one. "incomplete run" stays as the fallback for a
    // work item whose spec never got written — without it the row would be a
    // bare id with nothing to say what it is.
    description: title && title !== "" ? title : item.prepared ? "" : "incomplete run",
    icon: OUTCOME_ICONS[item.outcome ?? (item.prepared ? "prepared" : "incomplete")],
    tooltip,
  };
}

export type HistoryList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly HistoryItem[] }
  | { readonly kind: "empty"; readonly detail: string };

/**
 * Turn `bugpilot list --json` into the History group.
 *
 * There is no error state on purpose: §5.4 requires a corrupt `.ai/` to degrade
 * to an empty list rather than an error, and the CLI already degrades the same
 * way — an unreadable entry is reported with null fields, not as a failure.
 * Anything unrecognized in the payload is dropped for the same reason.
 */
export function historyFromPayload(
  payload: unknown,
  modifiedMs: (workItemId: string) => number | undefined = () => undefined,
  probe: (workItemId: string) => WorkItemProbe | undefined = () => undefined,
): HistoryList {
  const raw = asRecord(payload)?.["work_items"];
  const items: HistoryItem[] = (Array.isArray(raw) ? raw : [])
    .map((entry) => asRecord(entry))
    .flatMap((entry) => {
      const workItemId = typeof entry?.["work_item_id"] === "string" ? entry["work_item_id"] : "";
      // Only a name that is a work item id becomes a row: a row can be reopened,
      // and reopening leads to a handoff's command line. Checked before the
      // probe too, which reads files under `.ai/<id>/` (§37.70).
      if (!isWorkItemId(workItemId)) return [];
      const probed = probe(workItemId);
      const outcome = probed ? historyOutcome(probed) : undefined;
      return [
        {
          workItemId,
          source: asString(entry?.["source"]),
          title: asString(entry?.["title"]),
          prepared: entry?.["prepared"] === true,
          modifiedMs: modifiedMs(workItemId),
          ...(outcome === undefined ? {} : { outcome: outcome.outcome }),
          ...(outcome?.failedStep === undefined ? {} : { failedStep: outcome.failedStep }),
        },
      ];
    });

  if (items.length === 0) {
    return { kind: "empty", detail: "No work items yet. The first run creates one." };
  }
  // Most recent first. Falling back to the id keeps the order stable when no
  // timestamps are available, and local ids sort chronologically anyway.
  items.sort((left, right) => {
    const byTime = (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0);
    return byTime !== 0 ? byTime : right.workItemId.localeCompare(left.workItemId);
  });
  return { kind: "ready", items };
}

/**
 * What to show for a history row's description.
 *
 * A local id carries no readable slug by design (§3.4), so without the title a
 * row would read `local_20260904160612` and nothing else.
 */


function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
