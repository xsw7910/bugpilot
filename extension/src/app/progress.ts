/**
 * What the progress checklist shows, derived from the event stream.
 *
 * Three findings from running the real CLI shaped this, none of them guessable
 * from the design doc:
 *
 *  1. **Not every step emits an event.** A run that reported `pass` for
 *     `memory_add` in `workflow_status.json` never emitted a `step_started` for
 *     it. So absence of an event is not absence of work, and the stream alone
 *     cannot be the source of truth after the fact.
 *  2. **Steps are not capabilities.** `keywords` belongs to two capabilities at
 *     once (code search and similar fixes), which is exactly why the UI shows
 *     the five capabilities of §3.3 and treats shared prerequisite steps as
 *     activity rather than as rows.
 *  3. **The stream carries no timings.** §5.4 asks for per-step duration, so it
 *     is measured here from event arrival, with an injected clock.
 *
 * The checklist therefore has two sources: the live stream while a process is
 * running, and `workflow_status.json` after a restart (which is the only one
 * that survives the process, per §5.1).
 */

import { diagnose } from "../errors.ts";
import type { StreamEvent } from "../protocol.ts";
import type { PlanState } from "./form.ts";

export type Capability =
  | "issue_details"
  | "code_search"
  | "git_history"
  | "similar_fixes"
  | "build_context";

/** Display order, matching the plan checkboxes so the two read as one list. */
export const CAPABILITIES: readonly Capability[] = [
  "issue_details",
  "code_search",
  "git_history",
  "similar_fixes",
  "build_context",
];

export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  issue_details: "Issue details",
  code_search: "Code search",
  git_history: "Git history",
  similar_fixes: "Similar fixes",
  build_context: "Build context",
};

/**
 * Which steps mark a capability as running.
 *
 * A subset of `CAPABILITY_STEPS` in `bugpilot/core/models.py`: steps shared by
 * more than one capability (`keywords`) are deliberately absent, because a
 * shared step cannot light up one row without lying about the other.
 * `test/progress.test.ts` reads the Python table and checks exactly that.
 */
export const CAPABILITY_MARKER_STEPS: Readonly<Record<Capability, readonly string[]>> = {
  issue_details: ["fetch", "parse"],
  code_search: ["code_search"],
  git_history: ["git_context"],
  similar_fixes: ["memory_search"],
  build_context: ["context", "prompt", "memory_add"],
};

/** Human labels for the steps, so the activity line says something specific. */
export const STEP_LABELS: Readonly<Record<string, string>> = {
  doctor: "Checking environment",
  fetch: "Fetching the Jira issue",
  parse: "Parsing bug details",
  keywords: "Extracting keywords",
  memory_search: "Searching memory for similar fixes",
  code_search: "Searching the codebase",
  git_context: "Collecting git history",
  context: "Building bug context",
  prompt: "Generating the agent task package",
  memory_add: "Recording this bug in memory",
};

export type RowState = "pending" | "running" | "done" | "skipped" | "failed";

export interface Row {
  readonly capability: Capability;
  readonly label: string;
  readonly state: RowState;
  /** Measured from event arrival; absent until the row finishes. */
  readonly durationMs?: number;
}

export type RunState = "idle" | "running" | "done" | "failed" | "stopped";

export interface ProgressView {
  readonly state: RunState;
  readonly rows: readonly Row[];
  /** The current step in words, for the line under the checklist. */
  readonly activity?: string;
  readonly workItemId?: string;
  readonly source?: string;
  readonly artifacts: readonly string[];
  readonly elapsedMs?: number;
  /** Present when the run failed, already translated for a human. */
  readonly failure?: {
    readonly code: string;
    readonly summary: string;
    readonly action?: string;
    readonly retryable: boolean;
    /** The capability that was in flight, when there was one. */
    readonly capability?: Capability;
  };
}

const STEP_TO_CAPABILITY = new Map<string, Capability>(
  CAPABILITIES.flatMap((capability) =>
    CAPABILITY_MARKER_STEPS[capability].map((step) => [step, capability] as const),
  ),
);

/**
 * Accumulates a live run's events into a view model.
 *
 * Deliberately not a reducer over the whole event list: the panel re-renders on
 * every event, and re-deriving timings from scratch each time would make
 * duration depend on when the render happened rather than when the step ran.
 */
export class ProgressTracker {
  readonly #now: () => number;
  readonly #rows = new Map<Capability, { state: RowState; startedAt?: number; durationMs?: number }>();
  readonly #artifacts: string[] = [];
  #state: RunState = "running";
  #activity: string | undefined;
  #openCapability: Capability | undefined;
  #openStep: string | undefined;
  #workItemId: string | undefined;
  #source: string | undefined;
  #startedAt: number;
  #finishedAt: number | undefined;
  #failure: ProgressView["failure"];

  /**
   * @param plan The plan that was submitted, so rows the run will never reach
   *   start as `skipped` instead of sitting at `pending` forever.
   */
  constructor(plan: PlanState, now: () => number = Date.now) {
    this.#now = now;
    this.#startedAt = now();
    const enabled: Record<Capability, boolean> = {
      issue_details: true,
      code_search: plan.codeSearch,
      git_history: plan.gitHistory,
      similar_fixes: plan.similarFixes,
      build_context: plan.buildContext,
    };
    for (const capability of CAPABILITIES) {
      this.#rows.set(capability, { state: enabled[capability] ? "pending" : "skipped" });
    }
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case "started":
        this.#workItemId = asString(event["work_item_id"]);
        this.#source = asString(event["source"]);
        return;
      case "phase":
        // Non-step activity: today only the clean phase.
        this.#activity = phaseLabel(asString(event["phase"]));
        return;
      case "step_skipped": {
        const capability = STEP_TO_CAPABILITY.get(asString(event["step"]) ?? "");
        if (capability) this.#set(capability, "skipped");
        return;
      }
      case "step_started": {
        const step = asString(event["step"]) ?? "";
        this.#openStep = step;
        this.#activity = STEP_LABELS[step] ?? step;
        const capability = STEP_TO_CAPABILITY.get(step);
        if (!capability) return;
        // A capability spans several steps and each one completes in turn, so
        // the row is "done" again by the time the next step starts. The clock
        // must key off startedAt, not off the state — keying off the state
        // restarts it on every step and reports only the last one's duration.
        const row = this.#rows.get(capability);
        this.#rows.set(capability, {
          state: "running",
          startedAt: row?.startedAt ?? this.#now(),
        });
        this.#openCapability = capability;
        return;
      }
      case "step_completed": {
        const step = asString(event["step"]) ?? "";
        if (this.#openStep === step) this.#openStep = undefined;
        const capability = STEP_TO_CAPABILITY.get(step);
        if (!capability) return;
        // The last marker step of a capability closes it. Steps arrive in
        // WORKFLOW_STEPS order, so a later capability starting is not needed as
        // a signal; each completion simply extends the measured duration.
        const row = this.#rows.get(capability);
        this.#rows.set(capability, {
          state: "done",
          ...(row?.startedAt === undefined
            ? {}
            : { startedAt: row.startedAt, durationMs: this.#now() - row.startedAt }),
        });
        if (this.#openCapability === capability) this.#openCapability = undefined;
        return;
      }
      case "artifact": {
        const artifact = asString(event["path"]);
        if (artifact) this.#artifacts.push(artifact);
        return;
      }
      case "completed": {
        this.#finishedAt = this.#now();
        this.#activity = undefined;
        if (event["ok"] === true) {
          this.#state = "done";
          // A capability left open by a run that reported success is finished:
          // not every step emits a completion (memory_add does not).
          for (const [capability, row] of this.#rows) {
            if (row.state === "running") this.#set(capability, "done");
          }
          return;
        }
        const error = asRecord(event["error"]);
        this.#markFailure(
          asString(error?.["code"]) ?? "INTERNAL_ERROR",
          asString(error?.["message"]) ?? "The run failed without saying why.",
        );
        return;
      }
    }
  }

  /**
   * The stream ended without a terminal event: the process crashed or was killed.
   *
   * Reported as a failure rather than left spinning — a checklist stuck on one
   * row is how a dead process looks like a slow one.
   */
  interrupted(reason: "stopped" | "crashed" | "timeout"): void {
    if (this.#state !== "running") return;
    this.#finishedAt = this.#now();
    this.#activity = undefined;
    if (reason === "stopped") {
      this.#state = "stopped";
      for (const [capability, row] of this.#rows) {
        if (row.state === "running") this.#set(capability, "pending");
      }
      return;
    }
    if (reason === "timeout") {
      // Not "stopped": nobody stopped it. Reporting a timeout as a cancel makes
      // the developer think they clicked something, and hides a run that is
      // genuinely too slow for this repository.
      this.#state = "failed";
      const capability = this.#openCapability;
      if (capability) this.#set(capability, "failed");
      this.#failure = {
        code: "TIMEOUT",
        summary: "bugpilot ran longer than BugPilot waits and was stopped.",
        action:
          "Narrow the search — ignore vendored or generated directories, or lower Max files — then try again.",
        retryable: true,
        ...(capability === undefined ? {} : { capability }),
      };
      return;
    }
    // Not routed through `diagnose()`: that translates the CLI's *own* codes,
    // and for a known code the table's wording deliberately wins over the
    // message. This failure is the extension's observation, not the CLI's
    // report, so its wording has to survive.
    this.#state = "failed";
    const capability = this.#openCapability;
    if (capability) this.#set(capability, "failed");
    this.#failure = {
      code: "INTERNAL_ERROR",
      summary: "bugpilot stopped before finishing and did not say why.",
      action: "Check the BugPilot output for what it printed before it stopped, then run it again.",
      retryable: true,
      ...(capability === undefined ? {} : { capability }),
    };
  }

  /** A version bump: every event was dropped, which must not read as a crash. */
  foreign(version: number): void {
    this.#finishedAt = this.#now();
    this.#state = "failed";
    this.#activity = undefined;
    this.#failure = {
      code: "SCHEMA_VERSION",
      summary: `bugpilot speaks event contract v${version}; this extension understands v1.`,
      action: "Update the BugPilot extension.",
      retryable: false,
    };
  }

  view(): ProgressView {
    const rows = CAPABILITIES.map((capability) => {
      const row = this.#rows.get(capability)!;
      return {
        capability,
        label: CAPABILITY_LABELS[capability],
        state: row.state,
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      };
    });
    return {
      state: this.#state,
      rows,
      ...(this.#activity === undefined ? {} : { activity: this.#activity }),
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
      ...(this.#source === undefined ? {} : { source: this.#source }),
      artifacts: [...this.#artifacts],
      elapsedMs: (this.#finishedAt ?? this.#now()) - this.#startedAt,
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }

  #markFailure(code: string, message: string): void {
    this.#state = "failed";
    const diagnosis = diagnose(code, message);
    // The step that raised is never closed by the CLI, which is what identifies
    // it — so whatever is still running is where the failure belongs (§5.4:
    // "失败步骤就地标红").
    const capability = this.#openCapability;
    if (capability) this.#set(capability, "failed");
    this.#failure = {
      code,
      summary: diagnosis.summary,
      ...(diagnosis.action === undefined ? {} : { action: diagnosis.action }),
      retryable: diagnosis.retryable,
      ...(capability === undefined ? {} : { capability }),
    };
  }

  #set(capability: Capability, state: RowState): void {
    const row = this.#rows.get(capability);
    this.#rows.set(capability, {
      state,
      ...(row?.startedAt === undefined ? {} : { startedAt: row.startedAt }),
      ...(row?.durationMs === undefined ? {} : { durationMs: row.durationMs }),
    });
  }
}

/**
 * Rebuild the checklist from `workflow_status.json` after a restart.
 *
 * The JSONL stream only exists while the process does, so this is the only way
 * a reopened window can show what the last run did. Timings are gone — the file
 * does not carry them — and showing none is better than inventing them.
 *
 * A capability counts as done when every one of its marker steps that the file
 * mentions passed; if any failed, the capability failed. Unknown or unreadable
 * input degrades to an idle checklist rather than throwing: §5.4 asks History
 * to degrade to an empty list rather than an error, and the same applies here.
 */
export function viewFromStatus(status: unknown): ProgressView {
  const steps = asRecord(asRecord(status)?.["steps"]) ?? {};
  const generated = asRecord(status)?.["generated_files"];
  const rows: Row[] = CAPABILITIES.map((capability) => {
    const marks = CAPABILITY_MARKER_STEPS[capability]
      .map((step) => steps[step])
      .filter((value): value is string => typeof value === "string");
    return {
      capability,
      label: CAPABILITY_LABELS[capability],
      state: rowStateFromMarks(marks),
    };
  });
  const anyKnown = rows.some((row) => row.state !== "pending");
  // A restored run that failed is not a run that finished. The file carries no
  // error details, so the red row is the whole story — but calling the run
  // "done" would contradict it.
  const failed = rows.some((row) => row.state === "failed");
  return {
    state: failed ? "failed" : anyKnown ? "done" : "idle",
    rows,
    artifacts: Array.isArray(generated) ? generated.filter((item) => typeof item === "string") : [],
  };
}

function rowStateFromMarks(marks: readonly string[]): RowState {
  if (marks.length === 0) return "pending";
  if (marks.includes("fail")) return "failed";
  if (marks.includes("pass")) return "done";
  // Every mark is `skipped`, which is a real outcome, not a missing one.
  return "skipped";
}

function phaseLabel(phase: string | undefined): string | undefined {
  if (phase === "clean_start") return "Removing previous artifacts";
  if (phase === "clean_done") return "Previous artifacts removed";
  return phase;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
