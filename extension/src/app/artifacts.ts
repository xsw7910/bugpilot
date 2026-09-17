/**
 * What the two TreeViews show: a work item's artifacts, and the history list.
 *
 * bugpilot produces a dozen files per work item and they are not equally
 * interesting: `agent_task.md` is the one a developer opens, `workflow_status.json`
 * is bookkeeping. A flat alphabetical listing buries the first under the second,
 * so files are grouped and ordered by what they are for.
 *
 * The file names here were taken from a real run, not from the design doc — the
 * doc names `code_search_results.md`, the CLI writes `code_search.md`.
 *
 * Both models are pure: the host supplies directory names and `list --json`
 * output, and every state §5.4 requires (empty, loading, error) is a value
 * rather than a thrown exception.
 */

export type ArtifactKind = "markdown" | "json" | "log" | "other";

/**
 * Why a file exists, which decides where it sorts.
 *
 * `handoff` first because that is what the Run button was for; `state` last
 * because it is bookkeeping the developer rarely opens on purpose.
 */
export type ArtifactGroup = "handoff" | "retry" | "results" | "context" | "copilot" | "state";

export const GROUP_ORDER: readonly ArtifactGroup[] = [
  "handoff",
  "retry",
  "results",
  "context",
  // Near the end on purpose: a developer using Claude never opens these, and
  // they are five of the twenty-two files a Jira run produces.
  "copilot",
  "state",
];

export const GROUP_LABELS: Readonly<Record<ArtifactGroup, string>> = {
  handoff: "Hand off to an agent",
  retry: "Second attempt",
  results: "Agent results",
  context: "Investigation",
  copilot: "Copilot handoff",
  state: "Run state",
};

/**
 * The files an agent is expected to write back.
 *
 * Mirrors `REQUIRED_COPILOT_RESULT_FILES` in `bugpilot/core/workflow.py`, and
 * `test/artifacts.test.ts` reads that list to keep the two in step: a result
 * file added there but not here would silently stop being reported as missing.
 */
export const RESULT_FILES: readonly string[] = [
  "bug_analysis.md",
  "fix_summary.md",
  "test_result.md",
  "diff_summary.md",
  "review_notes.md",
];

/**
 * Where each artifact belongs.
 *
 * Built from a *manual* run's twelve files in phase 5, which turned out to be
 * the smaller half of the story: a Jira run writes twenty-two, and nine of them
 * — the five copilot prompts, the raw payload, the memory entry, the test plan
 * and the review prompt — had no entry here and fell into Investigation
 * alongside bug_context.md, which is the one file that matters there.
 * `test/artifacts.test.ts` now holds a real Jira listing so the gap cannot
 * reopen quietly.
 */
const GROUPS: Readonly<Record<string, ArtifactGroup>> = {
  "agent_task.md": "handoff",
  "agent_handoff.md": "handoff",
  "agent_team_instructions.md": "handoff",
  "test_plan.md": "handoff",
  "review_prompt.md": "handoff",
  "agent_retry_prompt.md": "retry",
  "user_feedback.md": "retry",
  "bug_context.md": "context",
  "code_search.md": "context",
  "git_context.md": "context",
  "jira_parsed.md": "context",
  "jira_summary.md": "context",
  "memory_search.md": "context",
  "extracted_keywords.json": "context",
  "related_files.json": "context",
  "search_quality.json": "context",
  "copilot_task.md": "copilot",
  "copilot_handoff.md": "copilot",
  "copilot_analysis_prompt.md": "copilot",
  "copilot_fix_prompt.md": "copilot",
  "copilot_team_instructions.md": "copilot",
  "bug_spec.json": "state",
  "workflow_status.json": "state",
  "execution.log": "state",
  // The raw fetched payload, not a reading of it: bookkeeping, and the file the
  // safety rules single out as never to be committed.
  "jira.json": "state",
  "memory_entry.md": "state",
};

/** Ordering inside a group: the file a developer reaches for comes first. */
const WITHIN_GROUP: readonly string[] = [
  "agent_task.md",
  "agent_handoff.md",
  "agent_retry_prompt.md",
  "user_feedback.md",
  "fix_summary.md",
  "bug_analysis.md",
  "bug_context.md",
  "code_search.md",
  "git_context.md",
];

export interface ArtifactEntry {
  readonly name: string;
  readonly group: ArtifactGroup;
  readonly kind: ArtifactKind;
  /** True for a result file the agent has not written yet. */
  readonly missing?: true;
}

export interface ArtifactSection {
  readonly group: ArtifactGroup;
  readonly label: string;
  readonly entries: readonly ArtifactEntry[];
}

export type ArtifactList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sections: readonly ArtifactSection[] }
  /** The directory exists but holds nothing worth showing. */
  | { readonly kind: "empty"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export function artifactKind(name: string): ArtifactKind {
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".log")) return "log";
  return "other";
}

export function artifactGroup(name: string): ArtifactGroup {
  const known = GROUPS[name];
  if (known) return known;
  if (RESULT_FILES.includes(name)) return "results";
  // An unrecognized file is more likely a new context artifact than run state,
  // and grouping it as context keeps it visible instead of hiding it at the end.
  return "context";
}

export interface ArtifactInput {
  /** File names directly inside `.ai/<work_item>/`. */
  readonly names: readonly string[];
  /**
   * Whether the run got far enough to expect agent results.
   *
   * Without `agent_task.md` there was nothing to hand over, so listing five
   * missing result files would be noise rather than information.
   */
  readonly expectResults?: boolean;
}

export function buildArtifactList(input: ArtifactInput): ArtifactList {
  const names = [...new Set(input.names.filter((name) => name.trim() !== ""))];
  const present = new Set(names);
  const expectResults = input.expectResults ?? present.has("agent_task.md");

  const entries: ArtifactEntry[] = names.map((name) => ({
    name,
    group: artifactGroup(name),
    kind: artifactKind(name),
  }));
  if (expectResults) {
    for (const name of RESULT_FILES) {
      if (!present.has(name)) {
        // Shown rather than omitted: "what is still missing" is the question
        // `check-results` answers, and the tree is where it is visible.
        entries.push({ name, group: "results", kind: "markdown", missing: true });
      }
    }
  }

  if (entries.length === 0) {
    return {
      kind: "empty",
      detail: "No artifacts yet. Run BugPilot on this work item to produce them.",
    };
  }

  const sections = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    entries: entries.filter((entry) => entry.group === group).sort(compareEntries),
  })).filter((section) => section.entries.length > 0);

  return { kind: "ready", sections };
}

function compareEntries(left: ArtifactEntry, right: ArtifactEntry): number {
  const rank = (entry: ArtifactEntry) => {
    const index = WITHIN_GROUP.indexOf(entry.name);
    return index === -1 ? WITHIN_GROUP.length : index;
  };
  // Present files before missing ones, then by curated rank, then by name.
  if ((left.missing ?? false) !== (right.missing ?? false)) return left.missing ? 1 : -1;
  const byRank = rank(left) - rank(right);
  return byRank !== 0 ? byRank : left.name.localeCompare(right.name);
}

// --- history ---------------------------------------------------------------

export interface HistoryItem {
  readonly workItemId: string;
  readonly source?: string | undefined;
  readonly title?: string | undefined;
  /** False for a directory whose run never wrote `workflow_status.json`. */
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
const FIX_SUMMARY = "fix_summary.md";
const USER_FEEDBACK = "user_feedback.md";
const RETRY_PROMPT = "agent_retry_prompt.md";
const STATUS_FILE = "workflow_status.json";

/** What the host read out of one work item's directory. */
export interface WorkItemProbe {
  /** File names directly inside `.ai/<work_item>/`. */
  readonly files: readonly string[];
  /** `workflow_status.json`, already parsed; undefined when absent or corrupt. */
  readonly status?: unknown;
}

export function historyOutcome(probe: WorkItemProbe): {
  outcome: HistoryOutcome;
  failedStep?: string;
} {
  const present = new Set(probe.files);
  // No status file means the run never got to the end of itself. Said first,
  // because everything below it reads that file.
  if (!present.has(STATUS_FILE)) return { outcome: "incomplete" };

  const steps = asRecord(asRecord(probe.status)?.["steps"]) ?? {};
  const failed = Object.entries(steps).find(([, mark]) => mark === "fail")?.[0];
  if (failed !== undefined) return { outcome: "failed", failedStep: failed };

  // The retry loop outranks the fix it followed: somebody read that fix summary
  // and said it was wrong, which is the newer fact of the two. Which half of
  // the loop matters — the second press builds the package, so its presence is
  // what separates "waiting for you" from "ready for an agent".
  if (present.has(RETRY_PROMPT)) return { outcome: "retried" };
  if (present.has(USER_FEEDBACK)) return { outcome: "retrying" };
  if (present.has(FIX_SUMMARY)) return { outcome: "fixed" };
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
  fixed: "verified",
  prepared: "bug",
};

/** One sentence per outcome, for the hover. */
function outcomeSentence(item: HistoryItem): string {
  switch (item.outcome) {
    case "incomplete":
      return "The run did not finish: there is no workflow_status.json.";
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
      return `An agent reported a fix in ${FIX_SUMMARY}.`;
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
 * Turn `bugpilot list --json` into the history view.
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
      if (workItemId === "") return [];
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
