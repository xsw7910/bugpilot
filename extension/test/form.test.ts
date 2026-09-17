import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ARGV_TEXT_LIMIT,
  DEFAULT_FORM,
  HINT_LIMIT,
  JIRA_ISSUE_KEY_RE,
  buildPrepareArgs,
  buildRetryArgs,
  canFixWithAI,
  effectivePlan,
  parseKeywords,
  parsePaths,
  planFlags,
} from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";

const OPTIONS = { root: "/work/app", platform: "linux" } as const;

function form(overrides: Partial<FormState> = {}): FormState {
  return { ...DEFAULT_FORM, ...overrides };
}

function argsOf(state: FormState, options = OPTIONS): readonly string[] {
  const result = buildPrepareArgs(state, options);
  assert.equal(result.ok, true, `expected valid form, got ${JSON.stringify(result)}`);
  return result.ok ? result.args : [];
}

/**
 * The value a flag carries, read out of the `--flag=value` form.
 *
 * Every value-carrying flag uses that form deliberately (see `flag()` in
 * form.ts): argparse reads a separate `-Wall` token as an option.
 */
function valueOf(args: readonly string[], name: string): string | undefined {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

/** Every value a repeatable flag carries, in order. */
function valuesOf(args: readonly string[], name: string): string[] {
  return args
    .filter((arg) => arg.startsWith(`${name}=`))
    .map((arg) => arg.slice(name.length + 1));
}

// --- the identity rule is shared with Python ------------------------------

test("the issue key pattern matches the one bugpilot enforces", () => {
  // Two copies of a rule drift. The error-code table is kept honest the same
  // way: read the Python source and compare, so a change on either side fails
  // here instead of at the developer's first run.
  const source = readFileSync(
    new URL("../../bugpilot/core/identity.py", import.meta.url),
    "utf8",
  );
  const match = /JIRA_ISSUE_KEY_RE = re\.compile\(r"([^"]+)"\)/.exec(source);
  assert.ok(match, "could not find JIRA_ISSUE_KEY_RE in bugpilot/core/identity.py");
  assert.equal(JIRA_ISSUE_KEY_RE.source, match[1]);
});

// --- input source ----------------------------------------------------------

test("a Jira key is uppercased rather than rejected", () => {
  // bugpilot requires uppercase; refusing a lowercase paste would be pedantry.
  assert.deepEqual(argsOf(form({ issueKey: " jr-12345 " })).slice(0, 2), ["bug", "JR-12345"]);
});

test("a missing issue key is reported on the issue key field", () => {
  const result = buildPrepareArgs(form({ issueKey: "  " }), OPTIONS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.problems.map((problem) => problem.field),
    ["issueKey"],
  );
});

test("something that is not an issue key says what one looks like", () => {
  const result = buildPrepareArgs(form({ issueKey: "the login page" }), OPTIONS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.problems[0]!.message, /JR-12345/);
});

test("a hand-written bug passes its description and title", () => {
  const args = argsOf(
    form({ source: "manual", description: "  crash on save  ", title: " Save crash " }),
  );
  assert.equal(valueOf(args, "--description"), "crash on save");
  assert.equal(valueOf(args, "--title"), "Save crash");
  // No positional issue key: the CLI requires exactly one of the two inputs.
  assert.match(args[1] ?? "", /^--description=/);
});

test("an empty description points at the description, not the issue key", () => {
  const result = buildPrepareArgs(form({ source: "manual" }), OPTIONS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems[0]!.field, "description");
});

test("a description too long for a command line is written to a file", () => {
  // Windows caps the whole command line at 32,767 characters, and a pasted bug
  // report can exceed it alone. The failure would be a spawn error with no
  // obvious cause, so the length decides the transport.
  const long = "x".repeat(ARGV_TEXT_LIMIT + 1);
  const result = buildPrepareArgs(
    form({ source: "manual", description: long }),
    { ...OPTIONS, descriptionFilePath: "/tmp/bugpilot-description.md" },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(valueOf(result.args, "--description-file"), "/tmp/bugpilot-description.md");
  assert.equal(
    result.args.some((arg) => arg.startsWith("--description=")),
    false,
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["/tmp/bugpilot-description.md"],
  );
  assert.match(result.files[0]!.contents, /^x{4001}\n$/);
});

test("a long description with nowhere to put it is a problem, not a silent spawn", () => {
  const result = buildPrepareArgs(
    form({ source: "manual", description: "y".repeat(ARGV_TEXT_LIMIT + 1) }),
    OPTIONS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems[0]!.field, "description");
});

// --- options ---------------------------------------------------------------

test("keywords split on commas or newlines, deduplicated", () => {
  assert.deepEqual(parseKeywords("save, crash\ncrash\n\n  retry  "), ["save", "crash", "retry"]);
  const args = argsOf(form({ issueKey: "JR-1", keywords: "save, crash" }));
  assert.deepEqual(valuesOf(args, "--keywords"), ["save", "crash"]);
});

test("paths split on newlines only, because a path may contain a comma", () => {
  // Splitting `src/a,b/file.ts` would produce two paths that match nothing, and
  // a search that quietly finds nothing is the worst possible outcome here.
  assert.deepEqual(parsePaths("src/a,b/file.ts\nsrc/other.ts"), [
    "src/a,b/file.ts",
    "src/other.ts",
  ]);
});

test("an absolute path outside the repository is refused", () => {
  const result = buildPrepareArgs(
    form({ issueKey: "JR-1", focusFiles: "/elsewhere/app/src/a.ts" }),
    OPTIONS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems[0]!.field, "focusFiles");
  assert.match(result.problems[0]!.message, /outside the repository/);
});

test("an absolute path inside the repository is kept", () => {
  const args = argsOf(form({ issueKey: "JR-1", focusFiles: "/work/app/src/a.ts" }));
  assert.equal(valueOf(args, "--focus-file"), "/work/app/src/a.ts");
});

test("a relative path is passed through untouched", () => {
  // Relative paths are resolved by bugpilot against its own cwd, which is the
  // repository root; second-guessing them here would break that.
  const args = argsOf(form({ issueKey: "JR-1", ignorePaths: "vendor/\ndist/" }));
  assert.deepEqual(valuesOf(args, "--ignore-path"), ["vendor/", "dist/"]);
});

test("numeric limits are validated, not passed through as text", () => {
  for (const value of ["0", "-3", "ten", "3.5"]) {
    const result = buildPrepareArgs(form({ issueKey: "JR-1", maxFiles: value }), OPTIONS);
    assert.equal(result.ok, false, `${value} should be refused`);
    if (!result.ok) assert.equal(result.problems[0]!.field, "maxFiles");
  }
  const args = argsOf(form({ issueKey: "JR-1", maxFiles: " 25 ", maxSearchLines: "500" }));
  assert.equal(valueOf(args, "--max-files"), "25");
  assert.equal(valueOf(args, "--max-search-lines"), "500");
});

test("empty limits are omitted so the CLI's defaults apply", () => {
  const args = argsOf(form({ issueKey: "JR-1" }));
  assert.equal(valueOf(args, "--max-files"), undefined);
  assert.equal(valueOf(args, "--max-search-lines"), undefined);
});

test("an over-long hint is refused rather than truncated", () => {
  // The CLI has no --hint-file, and silently cutting a developer's text is
  // worse than telling them where it belongs.
  const result = buildPrepareArgs(
    form({ issueKey: "JR-1", hint: "z".repeat(HINT_LIMIT + 1) }),
    OPTIONS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems[0]!.field, "hint");
});

test("every field problem is reported at once, not one per attempt", () => {
  const result = buildPrepareArgs(
    form({ issueKey: "", maxFiles: "nope", hint: "h".repeat(HINT_LIMIT + 1) }),
    OPTIONS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(new Set(result.problems.map((problem) => problem.field)),
    new Set(["issueKey", "hint", "maxFiles"]));
});

// --- the plan --------------------------------------------------------------

test("the full plan passes no skip flags", () => {
  const args = argsOf(form({ issueKey: "JR-1" }));
  assert.equal(
    args.some((arg) => arg.startsWith("--skip-") || arg === "--only-issue-details"),
    false,
  );
});

test("each capability maps to its own skip flag", () => {
  assert.deepEqual(
    planFlags({
      issueDetails: true,
      codeSearch: false,
      gitHistory: true,
      similarFixes: false,
      buildContext: true,
    }),
    ["--skip-code-search", "--skip-similar-fixes"],
  );
});

test("dropping the context step is only-issue-details, and drops the rest with it", () => {
  // The CLI has no --skip-build-context: --only-issue-details is the only way
  // to skip it, and that flag also turns off search, history and similar fixes.
  // Modelling it as five independent checkboxes would show a plan that never ran.
  const plan = {
    issueDetails: true,
    codeSearch: true,
    gitHistory: true,
    similarFixes: true,
    buildContext: false,
  } as const;
  assert.deepEqual(planFlags(plan), ["--only-issue-details"]);
  assert.deepEqual(effectivePlan(plan), {
    issueDetails: true,
    codeSearch: false,
    gitHistory: false,
    similarFixes: false,
    buildContext: false,
  });
});

// --- what every run must and must not carry -------------------------------

test("a prepare run streams events and never launches an agent", () => {
  const args = argsOf(form({ issueKey: "JR-1" }));
  assert.ok(args.includes("--json-lines"));
  assert.ok(args.includes("--prepare-only"));
  // Handing artifacts to an agent is a human act (R5). An extension that
  // spawned Claude in a terminal on Run would be doing it behind the developer.
  assert.equal(args.includes("--copilot"), false);
  assert.equal(args.includes("--agent-fix"), false);
});

test("the AI step contributes no argument at all", () => {
  // It describes what the extension does *after* the process exits. A flag here
  // would make the run itself launch an agent, which is exactly what
  // `--prepare-only` exists to prevent — and the panel would then be involving
  // a model without the separate decision R5 asks for.
  const plain = argsOf(form({ issueKey: "JR-1" }));
  const withFix = argsOf(
    form({
      issueKey: "JR-1",
      fixWithAI: true,
      agent: "custom",
      agentCommand: "my-agent --prompt {prompt}",
    }),
  );
  assert.deepEqual(withFix, plain);
  for (const leak of ["my-agent", "{prompt}", "--agent", "--fix"]) {
    assert.equal(
      withFix.some((arg) => arg.includes(leak)),
      false,
      `${leak} reached the command line`,
    );
  }
});

test("the AI step needs the package Build context writes", () => {
  // `--only-issue-details` writes no package, so there would be nothing to hand
  // over — the row is coupled to Build context exactly as the middle three are.
  assert.equal(canFixWithAI(form({ fixWithAI: true })), true);
  assert.equal(
    canFixWithAI(
      form({ fixWithAI: true, plan: { ...DEFAULT_FORM.plan, buildContext: false } }),
    ),
    false,
  );
  assert.equal(canFixWithAI(form({ fixWithAI: false })), false);
});

test("artifacts are preserved unless the developer asks for a fresh run", () => {
  // The CLI's default is destructive; phase 3 lost an agent's fix_summary.md to
  // exactly that. Re-preparing from the panel must not repeat it.
  assert.ok(argsOf(form({ issueKey: "JR-1" })).includes("--resume"));
  assert.ok(argsOf(form({ issueKey: "JR-1", fresh: true })).includes("--fresh"));
  assert.equal(argsOf(form({ issueKey: "JR-1", fresh: true })).includes("--resume"), false);
});

test("a run never asks the agent to comment on Jira", () => {
  // R5: writing to Jira stays a human decision, and the panel has no such box.
  assert.equal(argsOf(form({ issueKey: "JR-1" })).includes("--jira-comment"), false);
});

test("a retry uses --json, because --json-lines is ignored on that path", () => {
  // The CLI's retry branch only honours --json; with --json-lines it would
  // print human text (which the event reader drops, looking like a crash) and
  // then launch an agent in a terminal.
  const args = buildRetryArgs("JR-12345");
  assert.deepEqual(args, ["bug", "JR-12345", "--retry", "--prepare-only", "--json"]);
  assert.equal(args.includes("--json-lines"), false);
});

test("a value that starts with a dash survives, because argparse would eat it", () => {
  // Verified against the real CLI: `bugpilot bug JR-1 --keywords -Wall` exits 2
  // with a usage banner, and under --json-lines it emits no events at all — so
  // the extension could only report "stopped without saying why", for a keyword
  // the developer was right to type. `--keywords=-Wall` is unambiguous.
  const args = argsOf(
    form({ issueKey: "JR-1", keywords: "-Wall, -fPIC", hint: "-Wall", ignorePaths: "-weird-dir" }),
  );
  assert.deepEqual(valuesOf(args, "--keywords"), ["-Wall", "-fPIC"]);
  assert.equal(valueOf(args, "--hint"), "-Wall");
  assert.equal(valueOf(args, "--ignore-path"), "-weird-dir");
  // Nothing rides as a bare following token, which is the shape that breaks.
  assert.equal(args.includes("-Wall"), false);
});

test("every value-carrying flag uses the = form", () => {
  // A flag added later with a space would reintroduce the bug for that one
  // field, which is exactly the kind of gap nobody notices.
  const args = argsOf(
    form({
      source: "manual",
      issueKey: "",
      description: "crash",
      title: "t",
      hint: "h",
      keywords: "k",
      focusFiles: "src/a.ts",
      ignorePaths: "dist/",
      maxFiles: "5",
      maxSearchLines: "50",
    }),
  );
  for (const name of [
    "--description",
    "--title",
    "--hint",
    "--keywords",
    "--focus-file",
    "--ignore-path",
    "--max-files",
    "--max-search-lines",
  ]) {
    assert.ok(valueOf(args, name) !== undefined, `${name} is missing`);
    assert.equal(args.includes(name), false, `${name} was passed as a separate token`);
  }
});

test("each attachment becomes one --attach flag", () => {
  const args = argsOf(
    form({ issueKey: "JR-1", attachments: ["C:/logs/crash.log", "/home/me/shot.png"] }),
  );
  assert.deepEqual(
    args.filter((arg) => arg.startsWith("--attach")),
    ["--attach=C:/logs/crash.log", "--attach=/home/me/shot.png"],
  );
});

test("no attachments means no flag at all", () => {
  assert.equal(
    argsOf(form({ issueKey: "JR-1" })).some((arg) => arg.startsWith("--attach")),
    false,
  );
});

test("a path with a space survives as one argument", () => {
  // `--flag=value` for the same reason every other value uses it: argparse
  // treats a separate token starting with `-` as an option, and a Windows
  // path lives under "Program Files" often enough to matter.
  const args = argsOf(
    form({ issueKey: "JR-1", attachments: ["C:/Users/me/My Documents/a log.txt"] }),
  );
  assert.ok(args.includes("--attach=C:/Users/me/My Documents/a log.txt"));
  assert.equal(args.includes("--attach"), false);
});
