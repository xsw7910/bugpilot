/**
 * The panel's form, and the command line it means.
 *
 * This is where the extension earns its keep: everything the developer types
 * becomes one `bugpilot bug ...` invocation, and every rule about what is
 * allowed lives here rather than in the webview — a webview can be reloaded,
 * bypassed, or driven by a keyboard shortcut, and validation that only exists
 * in the page is not validation.
 *
 * Three constraints shaped this file, all of them checked against the CLI
 * rather than assumed:
 *
 *  1. **`--json-lines` never launches an agent**, and neither does `--json`.
 *     The extension prepares artifacts; handing them to an agent stays a human
 *     act (R5). Every argument list built here carries one of those flags.
 *  2. **`--retry` ignores `--json-lines`** — only `--json` is honoured on that
 *     path, and without either flag it launches an agent in a terminal. So a
 *     retry is a `--json` run, and a test pins that down.
 *  3. **The CLI cannot express every plan.** There is no `--skip-build-context`:
 *     dropping the context step means `--only-issue-details`, which also drops
 *     search, history and similar fixes. The form models that coupling instead
 *     of offering five independent checkboxes that would silently lie.
 */

import path from "node:path";

import { isWithin } from "../workspace.ts";
import type { AgentChoice } from "./agents.ts";

export type Source = "jira" | "manual";

/** The five logical capabilities of §3.3, as the panel shows them. */
export interface PlanState {
  /** Always on: this is the input, not an option. Kept for display. */
  readonly issueDetails: true;
  readonly codeSearch: boolean;
  readonly gitHistory: boolean;
  readonly similarFixes: boolean;
  readonly buildContext: boolean;
}

export interface FormState {
  readonly source: Source;
  readonly issueKey: string;
  readonly title: string;
  readonly description: string;
  readonly hint: string;
  /** Free text; comma- or newline-separated. */
  readonly keywords: string;
  /** Free text; newline-separated, because a path may contain a comma. */
  readonly focusFiles: string;
  readonly ignorePaths: string;
  readonly maxFiles: string;
  readonly maxSearchLines: string;
  /**
   * Files outside the repository to copy in for the agent: a crash log, a
   * screenshot of the broken dialog, a config that reproduces it.
   *
   * Absolute paths, and they come from the editor's own file dialog rather
   * than from the webview — the page never names a path the host did not pick.
   * Unlike `focusFiles`, which only ranks paths the search already walks,
   * these are copied into the work item and named in the agent's task file.
   */
  readonly attachments: readonly string[];
  /**
   * Which AI Fix Mode the next run uses, by id.
   *
   * An id and nothing else: what the modes are, what they instruct and which
   * one is the default all belong to bugpilot's registry, and the page fills
   * this from `fix-mode list --json`. Empty means the catalog has not been read
   * yet, and the run then omits the flag so core applies its own default rather
   * than this file guessing at one.
   */
  readonly fixModeId: string;
  readonly plan: PlanState;
  /**
   * Hand the finished package to a coding agent, as the last workflow step.
   *
   * Deliberately **not** part of `PlanState`: the plan is the set of things the
   * CLI does, and every field there becomes a flag. This one is an action the
   * extension takes afterwards, and a test asserts it contributes no argument —
   * `--prepare-only` has to stay true of every run the panel starts.
   *
   * Off by default. R5 asks that involving a model be a decision of its own;
   * a box the developer ticks is that decision, a box that arrives ticked is
   * not.
   */
  readonly fixWithAI: boolean;
  /** Which agent the last step hands over to. */
  readonly agent: AgentChoice;
  /** The command line for `agent: "custom"`, with a `{prompt}` placeholder. */
  readonly agentCommand: string;
  /**
   * Delete `.ai/<work_item>/` before running.
   *
   * The CLI's default, and off here. Phase 3 learned this the hard way: a
   * re-prepare with fresh=True deleted an agent's `fix_summary.md`. The
   * extension asks for it explicitly or does not do it.
   */
  readonly fresh: boolean;
}

export const DEFAULT_FORM: FormState = {
  source: "jira",
  issueKey: "",
  title: "",
  description: "",
  hint: "",
  keywords: "",
  focusFiles: "",
  ignorePaths: "",
  maxFiles: "",
  maxSearchLines: "",
  attachments: [],
  fixModeId: "",
  plan: {
    issueDetails: true,
    codeSearch: true,
    gitHistory: true,
    similarFixes: true,
    buildContext: true,
  },
  fixWithAI: false,
  agent: "auto",
  agentCommand: "",
  fresh: false,
};

export type FormField =
  | "issueKey"
  | "title"
  | "description"
  | "hint"
  | "keywords"
  | "focusFiles"
  | "ignorePaths"
  | "maxFiles"
  | "maxSearchLines"
  | "agentCommand"
  | "fixModeId";

/** A problem attached to the field that caused it, so the UI can show it there. */
export interface FieldProblem {
  readonly field: FormField;
  readonly message: string;
}

/** A file the caller must write before spawning, for text too big for argv. */
export interface PendingFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * A value-carrying flag, always written as `--flag=value`.
 *
 * Not cosmetic. argparse treats a separate token that starts with `-` as an
 * option, so `--keywords -Wall` produces a usage error: exit 2, no envelope,
 * and under `--json-lines` not even a terminal event — which the extension can
 * only report as "bugpilot stopped without saying why", for a keyword the
 * developer was right to type. (argparse spares values containing a space,
 * which is why a description starting with a dash survives and a single-token
 * keyword does not.) The `=` form has no such ambiguity.
 */
function flag(name: string, value: string): string {
  return `${name}=${value}`;
}

export type BuildResult =
  | { readonly ok: true; readonly args: readonly string[]; readonly files: readonly PendingFile[] }
  | { readonly ok: false; readonly problems: readonly FieldProblem[] };

export interface BuildOptions {
  /** The repository bugpilot will run in; absolute paths are checked against it. */
  readonly root: string;
  /** Where a description too long for a command line may be written. */
  readonly descriptionFilePath?: string | undefined;
  readonly platform?: string | undefined;
}

/**
 * A Jira issue key, matching `bugpilot/core/identity.py`.
 *
 * The duplication is deliberate and guarded: `test/form.test.ts` reads the
 * Python source and compares the pattern, the same way the error-code table is
 * kept honest. Validating here means a typo is caught before spawning anything.
 */
export const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * A Fix Mode id, matching `_MODE_ID_RE` in `bugpilot/core/fix_modes.py`.
 *
 * Checked before it reaches a command line even though the page only offers ids
 * the CLI itself listed: a webview message is untrusted input, and this is the
 * one field of it that becomes a flag naming something on disk in a later phase.
 * `test/form.test.ts` compares the pattern against the Python source.
 */
export const FIX_MODE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Which work item a form is about, named the way a run would name it.
 *
 * One identity rule, shared: the same `trim().toUpperCase()` a Jira run applies
 * before it touches `.ai/<work item>/`, so nothing downstream has to invent a
 * second notion of "the same bug".
 *
 * Three answers, and the difference between them matters:
 *
 *  - a work item id, when the form names a complete Jira key;
 *  - `"manual"` for a hand-written bug, whose real id is minted by the CLI at
 *    run time — every hand-written bug is *a* new work item even though this
 *    cannot say which one;
 *  - `undefined` while a key is half-typed, which is not yet any work item and
 *    so is not a reason to conclude the developer switched to another bug.
 */
export const MANUAL_WORK_ITEM_SCOPE = "manual";

export function workItemScopeOf(form: FormState): string | undefined {
  if (form.source !== "jira") return MANUAL_WORK_ITEM_SCOPE;
  const key = form.issueKey.trim().toUpperCase();
  return JIRA_ISSUE_KEY_RE.test(key) ? key : undefined;
}

/**
 * How much text may ride on the command line.
 *
 * Windows caps a command line at 32,767 characters and a description pasted
 * from a bug report can exceed that on its own, so anything long goes to a file
 * and `--description-file` instead. The limit is well under the cap because
 * every other argument shares the budget.
 */
export const ARGV_TEXT_LIMIT = 4_000;

/** A hint is a pointer, not a document; the CLI has no file form for it. */
export const HINT_LIMIT = 2_000;

/** Split keywords: commas or newlines, blanks dropped, duplicates removed. */
export function parseKeywords(text: string): string[] {
  return unique(
    text
      .split(/[,\n\r]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );
}

/**
 * Split paths: newlines only.
 *
 * A path can legitimately contain a comma, and silently splitting
 * `src/a,b/file.ts` into two nonexistent paths would produce a search that
 * quietly finds nothing.
 */
export function parsePaths(text: string): string[] {
  return unique(
    text
      .split(/[\n\r]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * The plan as the CLI can actually express it.
 *
 * Turning off the context step means `--only-issue-details`, and that flag also
 * turns off the other three. The panel greys them out for the same reason: a
 * checkbox that stays ticked while the run ignores it is a lie about what ran.
 */
export function effectivePlan(plan: PlanState): PlanState {
  if (plan.buildContext) return plan;
  return {
    issueDetails: true,
    codeSearch: false,
    gitHistory: false,
    similarFixes: false,
    buildContext: false,
  };
}

/**
 * Whether the AI step can run at all.
 *
 * It needs a package to hand over, and `--only-issue-details` never writes
 * one — so the last row is coupled to Build context exactly as the middle three
 * are. Offering it anyway would hand an agent a prompt pointing at a file that
 * does not exist.
 */
export function canFixWithAI(form: FormState): boolean {
  return form.fixWithAI && form.plan.buildContext;
}

/** The flags for a plan. Empty for the full plan. */
export function planFlags(plan: PlanState): string[] {
  const effective = effectivePlan(plan);
  if (!effective.buildContext) return ["--only-issue-details"];
  const flags: string[] = [];
  if (!effective.codeSearch) flags.push("--skip-code-search");
  if (!effective.gitHistory) flags.push("--skip-git-history");
  if (!effective.similarFixes) flags.push("--skip-similar-fixes");
  return flags;
}

/**
 * Build the streaming `bug` invocation for a form, or say what is wrong with it.
 *
 * Problems are returned per field rather than as one message: §5.4 requires a
 * failure to be readable where it happened, and "Issue key is required" next to
 * an empty box beats a notification that covers the form.
 */
export function buildPrepareArgs(form: FormState, options: BuildOptions): BuildResult {
  const problems: FieldProblem[] = [];
  const args: string[] = ["bug"];
  const files: PendingFile[] = [];

  if (form.source === "jira") {
    const key = form.issueKey.trim().toUpperCase();
    if (key === "") {
      problems.push({ field: "issueKey", message: "An issue key is required, for example JR-12345." });
    } else if (!JIRA_ISSUE_KEY_RE.test(key)) {
      problems.push({
        field: "issueKey",
        message: `"${form.issueKey.trim()}" is not a Jira issue key. Expected a project prefix, a dash and digits, like JR-12345.`,
      });
    } else {
      // Uppercased on the way out: bugpilot's identity check requires it, and
      // rejecting a lowercase paste would be pedantry rather than validation.
      args.push(key);
    }
  } else {
    const description = form.description.trim();
    if (description === "") {
      problems.push({
        field: "description",
        message: "Describe the bug, or switch the input source to a Jira issue.",
      });
    } else if (description.length <= ARGV_TEXT_LIMIT) {
      args.push(flag("--description", description));
    } else if (options.descriptionFilePath) {
      // Too long for a command line on Windows, where the whole line is capped.
      files.push({ path: options.descriptionFilePath, contents: `${description}\n` });
      args.push(flag("--description-file", options.descriptionFilePath));
    } else {
      problems.push({
        field: "description",
        message: `This description is ${description.length} characters, too long to pass on a command line, and no temporary file location was provided.`,
      });
    }
    const title = form.title.trim();
    if (title !== "") args.push(flag("--title", title));
  }

  const hint = form.hint.trim();
  if (hint.length > HINT_LIMIT) {
    problems.push({
      field: "hint",
      message: `A hint points at where the fix belongs; keep it under ${HINT_LIMIT} characters and put the detail in the description.`,
    });
  } else if (hint !== "") {
    args.push(flag("--hint", hint));
  }

  for (const keyword of parseKeywords(form.keywords)) args.push(flag("--keywords", keyword));

  for (const [field, name, text] of [
    ["focusFiles", "--focus-file", form.focusFiles],
    ["ignorePaths", "--ignore-path", form.ignorePaths],
  ] as const) {
    for (const entry of parsePaths(text)) {
      if (path.isAbsolute(entry) && !isWithin(options.root, entry, options.platform)) {
        // bugpilot searches the repository it runs in; an absolute path outside
        // it would silently match nothing.
        problems.push({
          field,
          message: `${entry} is outside the repository BugPilot is working on.`,
        });
        continue;
      }
      args.push(flag(name, entry));
    }
  }

  pushNumber(form.maxFiles, "maxFiles", "--max-files", problems, args);
  pushNumber(form.maxSearchLines, "maxSearchLines", "--max-search-lines", problems, args);

  // One flag per file. Not validated for existence here: the file was chosen
  // from the editor's own dialog moments ago, and the CLI reports anything
  // that vanished in between as a warning rather than a failure — which is the
  // right place for it, since the same race exists for a CLI user.
  for (const attachment of form.attachments) {
    if (attachment.trim() !== "") args.push(flag("--attach", attachment));
  }

  // Always explicit when the panel has a selection. The CLI's own precedence is
  // explicit > persisted > Standard, and letting the persisted value win here
  // would let the panel show Conservative while the run quietly did something
  // else — the selector on screen is the promise.
  const fixModeId = form.fixModeId.trim();
  if (fixModeId !== "") {
    if (!FIX_MODE_ID_RE.test(fixModeId)) {
      problems.push({
        field: "fixModeId",
        message: `"${fixModeId}" is not a Fix Mode id. Pick one from the list.`,
      });
    } else {
      args.push(flag("--fix-mode", fixModeId));
    }
  }

  args.push(...planFlags(form.plan));

  // `fixWithAI`, `agent` and `agentCommand` deliberately contribute nothing.
  // They describe what the extension does *after* this process exits; a flag
  // here would make the run itself launch an agent, which is the thing
  // `--prepare-only` exists to prevent. `test/form.test.ts` pins that down.

  // Preserve artifacts unless the developer asked otherwise. The CLI's default
  // is the destructive one; phase 3 already lost an agent's fix_summary.md to it.
  args.push(form.fresh ? "--fresh" : "--resume");
  // Streaming implies prepare-only in the CLI, but saying it costs nothing and
  // makes the intent legible in the log line the panel shows.
  args.push("--prepare-only", "--json-lines");

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, args, files };
}

function pushNumber(
  raw: string,
  field: FormField,
  name: string,
  problems: FieldProblem[],
  args: string[],
): void {
  const text = raw.trim();
  if (text === "") return;
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    problems.push({ field, message: "Enter a whole number of at least 1, or leave it empty." });
    return;
  }
  args.push(flag(name, text));
}

/**
 * The retry invocation for a work item.
 *
 * `--json` rather than `--json-lines` on purpose: the CLI's retry path only
 * honours `--json`, and without it the run launches an agent in a terminal —
 * which is the one thing the extension must not do behind the developer's back.
 */
export function buildRetryArgs(workItemId: string): readonly string[] {
  return ["bug", workItemId, "--retry", "--prepare-only", "--json"];
}
