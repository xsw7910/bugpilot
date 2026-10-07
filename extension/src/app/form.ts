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
 *  3. **Build context always runs.** The CLI has no `--skip-build-context`:
 *     dropping the context step meant `--only-issue-details`, which also dropped
 *     search, history, similar fixes and the AI fix. The panel offered that as
 *     a Build context checkbox with the other four coupled to it; since §37.107
 *     the row has no checkbox and the panel never sends the flag. It is still
 *     the CLI's.
 */

import path from "node:path";

import { isWithin } from "../workspace.ts";
import { migrateAgentChoice } from "./agents.ts";
import type { AgentChoice } from "./agents.ts";

export type Source = "jira" | "manual";

/**
 * History Depth's options, as `GIT_HISTORY_DEPTHS` in `bugpilot/core/models.py`
 * spells them (`test/gitHistorySettings.test.ts` compares the two). `recent` is Batch 1's
 * bounds; `broader` reads three times as far back per file.
 */
export const GIT_HISTORY_DEPTHS = ["recent", "broader"] as const;
export type GitHistoryDepth = (typeof GIT_HISTORY_DEPTHS)[number];

/** Max Related Commits' range, as `MAX_RELATED_COMMITS_LIMIT` in `models.py`. */
export const GIT_MAX_COMMITS_LIMIT = 25;

/**
 * Max Similar Fixes' range and default, as `MAX_SIMILAR_FIXES_LIMIT` and
 * `DEFAULT_MAX_SIMILAR_FIXES` in `models.py` (`test/similarFixesSettings.test.ts`
 * compares them). Five is what the step always kept.
 */
export const SIMILAR_MAX_FIXES_LIMIT = 20;
export const SIMILAR_MAX_FIXES_DEFAULT = 5;

/** The five logical capabilities of §3.3, as the panel shows them. */
export interface PlanState {
  /** Always on: this is the input, not an option. Kept for display. */
  readonly issueDetails: true;
  readonly codeSearch: boolean;
  readonly gitHistory: boolean;
  readonly similarFixes: boolean;
  /**
   * Always on (§37.107): the package is what every later step and the AI fix
   * work from. Turning it off was `--only-issue-details`, and the panel no
   * longer offers that.
   */
  readonly buildContext: true;
}

export interface FormState {
  readonly source: Source;
  readonly issueKey: string;
  readonly title: string;
  readonly description: string;
  readonly hint: string;
  /**
   * Whether improving the hint may read the issue's own title and description.
   *
   * On by default: the issue text is what makes a two-word hint improvable at
   * all. It gates only the hint improver — it is not a run option and
   * contributes no flag — and it never reaches the repository, the history or
   * the files.
   */
  readonly useIssueDetails: boolean;
  /**
   * The shared Keywords (Retrieval inputs): free text, comma- or
   * newline-separated. Code Search always uses them; Git history and Similar
   * fixes use them too unless their own *Use shared keywords* is off. One list,
   * sent once as `--keywords` — each step's opt-out acts inside that step.
   */
  readonly keywords: string;
  /**
   * The shared Focus files (Retrieval inputs): newline-separated, because a
   * path may contain a comma. Code Search always uses them; Git history unless
   * *Use shared focus files* is off; Similar fixes never.
   */
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
   *
   * A pasted screenshot or a dropped file is no exception: the page hands the
   * host its bytes, and the path is the one the host stored them under.
   */
  readonly attachments: readonly string[];
  /**
   * Why an attachment matters, by its path in `attachments`: optional, one
   * line each under the file in task.md. Part of the prepared context, like
   * the hint — so changing one makes a prepared context stale. An entry for a
   * path no longer attached is ignored.
   */
  readonly attachmentDescriptions: Readonly<Record<string, string>>;
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
  // Git History Settings: how the Git history step searches. Git history's
  // alone — Code Search reads `keywords` and `focusFiles` above, and none of
  // these. Every default is Batch 1's behaviour, and a form at the defaults
  // sends no flag for them, so its command line is the one it always was.

  /** Git history also searches commits for `keywords`. */
  readonly gitUseSharedKeywords: boolean;
  /** Git history also reads the history of `focusFiles`. */
  readonly gitUseSharedFocusFiles: boolean;
  /** Additional Commit Keywords: comma- or newline-separated, like `keywords`. */
  readonly gitKeywords: string;
  /** Additional Files: newline-separated, like `focusFiles`. */
  readonly gitFiles: string;
  /** Search commit messages for the issue key and keywords. */
  readonly gitSearchMessages: boolean;
  /** Read the history of the related files. */
  readonly gitSearchFileHistory: boolean;
  readonly gitHistoryDepth: GitHistoryDepth;
  /** Max Related Commits; empty means the CLI's default, as Max files does. */
  readonly gitMaxCommits: string;
  // Similar Fixes Settings: how the Similar fixes step searches past fixes.
  // Similar fixes' alone — neither Code Search nor Git history reads them, and
  // Similar fixes never reads `focusFiles`. Each default is the step's
  // behaviour before they existed, and a form at the defaults sends no flag for
  // them. Kept, like Git history's, while the step's box is unticked.

  /** Similar fixes also scores past fixes against `keywords`. */
  readonly similarUseSharedKeywords: boolean;
  /** Additional Keywords: comma- or newline-separated, like `keywords`. */
  readonly similarKeywords: string;
  /** Max Similar Fixes; empty means the CLI's default, five. */
  readonly similarMaxFixes: string;
  /**
   * Delete `.ai/<work_item>/` before running.
   *
   * The CLI's default, and off here. Phase 3 learned this the hard way: a
   * re-prepare with fresh=True deleted an agent's `fix_report.md`. The
   * extension asks for it explicitly or does not do it.
   */
  readonly fresh: boolean;
  /**
   * Which branch the agent works on, written into task.md: the checked-out
   * one (the default — a feature branch only from main/master or a detached
   * HEAD, and only if the developer agrees), one branch per work item created
   * once and reused, or ask first. main/master is never edited under any of
   * them, and preparing again never calls for a new branch.
   */
  readonly branchPolicy: BranchPolicy;
}

/** The CLI's `--branch-policy` values, in the order the settings page lists them. */
export const BRANCH_POLICIES = ["current", "per-issue", "ask"] as const;
export type BranchPolicy = (typeof BRANCH_POLICIES)[number];

/** A branch policy from anywhere outside this module: an unknown value is `current`. */
export function branchPolicyOf(value: unknown): BranchPolicy {
  return (BRANCH_POLICIES as readonly unknown[]).includes(value) ? (value as BranchPolicy) : "current";
}

export const DEFAULT_FORM: FormState = {
  source: "jira",
  issueKey: "",
  title: "",
  description: "",
  hint: "",
  useIssueDetails: true,
  keywords: "",
  focusFiles: "",
  ignorePaths: "",
  maxFiles: "",
  maxSearchLines: "",
  attachments: [],
  attachmentDescriptions: {},
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
  gitUseSharedKeywords: true,
  gitUseSharedFocusFiles: true,
  gitKeywords: "",
  gitFiles: "",
  gitSearchMessages: true,
  gitSearchFileHistory: true,
  gitHistoryDepth: "recent",
  gitMaxCommits: "",
  similarUseSharedKeywords: true,
  similarKeywords: "",
  similarMaxFixes: "",
  fresh: false,
  branchPolicy: "current",
};

/** A History Depth from anywhere outside this module: an unknown value is `recent`. */
export function gitHistoryDepthOf(value: unknown): GitHistoryDepth {
  return (GIT_HISTORY_DEPTHS as readonly unknown[]).includes(value) ? (value as GitHistoryDepth) : "recent";
}

/**
 * A form saved by an earlier session, as this version reads it.
 *
 * Kept whole — every field the developer set comes back — with the one value
 * whose meaning moved translated: `agent: "claude"` from before §37.94 is Claude
 * CLI, which is what it ran.
 */
export function restoreForm(saved: FormState | undefined): FormState {
  if (saved === undefined) return DEFAULT_FORM;
  return {
    ...saved,
    agent: migrateAgentChoice(saved.agent),
    // A form saved before descriptions existed has none.
    attachmentDescriptions: saved.attachmentDescriptions ?? {},
    // A form saved before the Git History Settings existed gets their
    // defaults — which are what that form's runs did. Absent means on for the
    // four switches: reading a missing `true` as off would quietly turn a
    // search route off for everyone who upgraded.
    gitUseSharedKeywords: saved.gitUseSharedKeywords !== false,
    gitUseSharedFocusFiles: saved.gitUseSharedFocusFiles !== false,
    gitKeywords: typeof saved.gitKeywords === "string" ? saved.gitKeywords : "",
    gitFiles: typeof saved.gitFiles === "string" ? saved.gitFiles : "",
    gitSearchMessages: saved.gitSearchMessages !== false,
    gitSearchFileHistory: saved.gitSearchFileHistory !== false,
    gitHistoryDepth: gitHistoryDepthOf(saved.gitHistoryDepth),
    gitMaxCommits: typeof saved.gitMaxCommits === "string" ? saved.gitMaxCommits : "",
    // Likewise the Similar Fixes Settings: absent is the default, and the
    // default is on for the switch.
    similarUseSharedKeywords: saved.similarUseSharedKeywords !== false,
    similarKeywords: typeof saved.similarKeywords === "string" ? saved.similarKeywords : "",
    similarMaxFixes: typeof saved.similarMaxFixes === "string" ? saved.similarMaxFixes : "",
    // A form saved before the branch policy existed gets the default.
    branchPolicy: branchPolicyOf(saved.branchPolicy),
    // A form saved while Build context could be unticked may say it was: the
    // two fixed steps are on whatever it says (§37.107). The three optional
    // ones keep what was saved — unticking Build context had cleared them, and
    // ticking them again was never this form's to decide.
    plan: { ...DEFAULT_FORM.plan, ...saved.plan, issueDetails: true, buildContext: true },
  };
}

/**
 * One attachment's description as a run sends it: whitespace collapsed, as the
 * CLI records it — so a trailing space never makes a context look stale.
 */
export function attachmentDescriptionOf(form: FormState, path: string): string {
  return (form.attachmentDescriptions?.[path] ?? "").replace(/\s+/g, " ").trim();
}

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
  | "fixModeId"
  | "gitKeywords"
  | "gitFiles"
  | "gitMaxCommits"
  | "similarKeywords"
  | "similarMaxFixes";

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
 * A work item id — a `.ai/<work_item>/` directory name — matching
 * `WORK_ITEM_ID_RE` in `bugpilot/core/identity.py`.
 *
 * Letters, digits, `_` and `-`, a letter first and `-<digits>` or `_<digits>`
 * last: `JR-12345` and `local_20260926010922` both fit, and so does nothing a
 * path or a shell could act on. Checked wherever an id enters the extension
 * from outside a form — History, the saved work item, a command argument — and
 * again before a handoff builds a prompt from it (§37.70). Guarded like the
 * patterns above: `test/form.test.ts` compares it with the Python source and
 * runs the shared cases in `tests/fixtures/work_item_ids.json` through both.
 */
export const WORK_ITEM_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*[-_][0-9]+$/;

/** Whether `value` is exactly a work item id: no trimming, since the id is a directory name. */
export function isWorkItemId(value: string): boolean {
  return WORK_ITEM_ID_RE.test(value);
}

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
 * The flags for a plan. Empty for the full plan.
 *
 * Never `--only-issue-details`: Build context always runs (§37.107), so only the
 * three optional steps can be skipped.
 */
export function planFlags(plan: PlanState): string[] {
  const flags: string[] = [];
  if (!plan.codeSearch) flags.push("--skip-code-search");
  if (!plan.gitHistory) flags.push("--skip-git-history");
  if (!plan.similarFixes) flags.push("--skip-similar-fixes");
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
      // The panel has one Issue box for both paths since §34's UI-A1, and an
      // empty one is read as the Jira path — so this message has to offer both
      // ways out rather than name a switch that no longer exists.
      problems.push({
        field: "issueKey",
        message: "Enter a Jira issue key like JR-12345, or describe the bug.",
      });
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
        message: "Describe the bug, or enter a Jira issue key like JR-12345.",
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
    // Git history's own files: the same rule as a Focus File, since they are
    // the same kind of path read the same way.
    ["gitFiles", "--git-file", form.gitFiles],
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

  args.push(...gitHistoryFlags(form, problems));
  args.push(...similarFixesFlags(form, problems));

  // One flag per file. Not validated for existence here: the file was chosen
  // from the editor's own dialog moments ago, and the CLI reports anything
  // that vanished in between as a warning rather than a failure — which is the
  // right place for it, since the same race exists for a CLI user.
  const attached = form.attachments.filter((attachment) => attachment.trim() !== "");
  for (const attachment of attached) args.push(flag("--attach", attachment));
  // Paired by position, one per --attach, and only when one is described: a
  // run without descriptions is exactly the command line it always was.
  const described = attached.map((attachment) => attachmentDescriptionOf(form, attachment));
  if (described.some((text) => text !== "")) {
    for (const text of described) args.push(flag("--attach-description", text));
  }
  // The panel's list is the whole selection, not an addition to the last run's
  // (§37.99): a file removed here leaves the work item — its copy, its
  // description and its place in task.md — on a resume too. Always sent,
  // because "none selected" has no --attach to say it with.
  args.push("--replace-attachments");

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

  // Always explicit, for the Fix Mode's reason: a run is a --resume, the CLI's
  // precedence is explicit > recorded > default, and a choice left unsent
  // would let the work item's last policy win over the one on screen.
  args.push(flag("--branch-policy", branchPolicyOf(form.branchPolicy)));

  args.push(...planFlags(form.plan));

  // `fixWithAI`, `agent` and `agentCommand` deliberately contribute nothing.
  // They describe what the extension does *after* this process exits; a flag
  // here would make the run itself launch an agent, which is the thing
  // `--prepare-only` exists to prevent. `test/form.test.ts` pins that down.

  // Preserve artifacts unless the developer asked otherwise. The CLI's default
  // is the destructive one; phase 3 already lost an agent's fix_report.md to it.
  args.push(form.fresh ? "--fresh" : "--resume");
  // Streaming implies prepare-only in the CLI, but saying it costs nothing and
  // makes the intent legible in the log line the panel shows.
  args.push("--prepare-only", "--json-lines");

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, args, files };
}

/**
 * The Git History Settings as flags: only what differs from the defaults, so a
 * form nobody configured sends the command line Batch 1 sent. Off-switches
 * rather than on-switches for the same reason. `--git-file` is pushed with the
 * other paths, above, through their one path rule.
 */
function gitHistoryFlags(form: FormState, problems: FieldProblem[]): string[] {
  const flags: string[] = [];
  for (const keyword of parseKeywords(form.gitKeywords)) flags.push(flag("--git-keyword", keyword));
  if (!form.gitUseSharedKeywords) flags.push("--git-no-shared-keywords");
  if (!form.gitUseSharedFocusFiles) flags.push("--git-no-shared-focus-files");
  if (!form.gitSearchMessages) flags.push("--git-no-commit-search");
  if (!form.gitSearchFileHistory) flags.push("--git-no-file-history");
  const depth = gitHistoryDepthOf(form.gitHistoryDepth);
  if (depth !== "recent") flags.push(flag("--git-history-depth", depth));
  const count = form.gitMaxCommits.trim();
  if (count !== "") {
    if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > GIT_MAX_COMMITS_LIMIT) {
      problems.push({
        field: "gitMaxCommits",
        message: `Enter a whole number from 1 to ${GIT_MAX_COMMITS_LIMIT}, or leave it empty.`,
      });
    } else {
      flags.push(flag("--git-max-commits", String(Number(count))));
    }
  }
  return flags;
}

/**
 * The Similar Fixes Settings as flags, the same way: only what differs from the
 * defaults, an off-switch for the shared Keywords — which still go out once, as
 * `--keywords`, for Code Search and Git history. Sent whether or not the step's
 * box is ticked, like Git history's; `--skip-similar-fixes` is what decides
 * whether it runs.
 */
function similarFixesFlags(form: FormState, problems: FieldProblem[]): string[] {
  const flags: string[] = [];
  for (const keyword of parseKeywords(form.similarKeywords)) flags.push(flag("--similar-fixes-keyword", keyword));
  if (!form.similarUseSharedKeywords) flags.push("--similar-fixes-no-shared-keywords");
  const count = form.similarMaxFixes.trim();
  if (count !== "") {
    if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > SIMILAR_MAX_FIXES_LIMIT) {
      problems.push({
        field: "similarMaxFixes",
        message: `Enter a whole number from 1 to ${SIMILAR_MAX_FIXES_LIMIT}, or leave it empty.`,
      });
    } else {
      flags.push(flag("--max-similar-fixes", String(Number(count))));
    }
  }
  return flags;
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
 * What a form would prepare, as one comparable string.
 *
 * The prepared context goes stale when this changes: it is every input that
 * reaches `buildPrepareArgs` — the issue, the guidance, the retrieval
 * overrides, the attachments, the Fix Mode and the plan — and nothing that
 * describes what happens afterwards. `fixWithAI`, the agent and its command are
 * the handoff's, `fresh` is how a run treats the old folder rather than what it
 * prepares, and `useIssueDetails` only gates the hint improver.
 *
 * Normalized the way the argument builder reads each field, so whitespace a
 * run would ignore — a trailing space, a blank keyword line, a lowercase key —
 * does not make a package look out of date. A hand-written bug's title and
 * description count only on the manual path, as they do on the command line.
 */
export function preparationFingerprint(form: FormState): string {
  const manual = form.source === "manual";
  return JSON.stringify({
    source: form.source,
    issue: manual ? form.description.trim() : form.issueKey.trim().toUpperCase(),
    title: manual ? form.title.trim() : "",
    hint: form.hint.trim(),
    keywords: parseKeywords(form.keywords),
    focusFiles: parsePaths(form.focusFiles),
    ignorePaths: parsePaths(form.ignorePaths),
    maxFiles: form.maxFiles.trim(),
    maxSearchLines: form.maxSearchLines.trim(),
    attachments: form.attachments.filter((entry) => entry.trim() !== ""),
    attachmentDescriptions: form.attachments
      .filter((entry) => entry.trim() !== "")
      .map((entry) => attachmentDescriptionOf(form, entry)),
    fixModeId: form.fixModeId.trim(),
    plan: planFlags(form.plan),
    // Every Git History Setting can change the prepared context's Git History
    // section, so each one is here — read the way the argument builder reads it.
    git: {
      sharedKeywords: form.gitUseSharedKeywords,
      sharedFocusFiles: form.gitUseSharedFocusFiles,
      keywords: parseKeywords(form.gitKeywords),
      files: parsePaths(form.gitFiles),
      messages: form.gitSearchMessages,
      fileHistory: form.gitSearchFileHistory,
      depth: gitHistoryDepthOf(form.gitHistoryDepth),
      maxCommits: form.gitMaxCommits.trim(),
    },
    // And every Similar Fixes Setting can change its section of context.md.
    similar: {
      sharedKeywords: form.similarUseSharedKeywords,
      keywords: parseKeywords(form.similarKeywords),
      maxFixes: form.similarMaxFixes.trim(),
    },
    // The branch policy is written into task.md, as the Fix Mode is.
    branchPolicy: branchPolicyOf(form.branchPolicy),
  });
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
