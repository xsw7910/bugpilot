/**
 * Every command line this extension sends to the bugpilot CLI, as one shared
 * fixture (pre-release Batch 1, B).
 *
 * A stale CLI once passed every check this project had: the source tree
 * declared each flag, the start-up handshake (`doctor --json`) worked, and the
 * installed wheel still rejected every Run. So the argv lives in
 * `tests/fixtures/extension_cli_argv.json`, built here from the extension's own
 * argv builders — the real ones, with the runner's own `--json`/`--json-lines`
 * appended as it appends them — and checked three ways:
 *
 * - here, that the fixture is what the builders produce today;
 * - `tests/test_extension_argv_contract.py`, that the CLI's parser accepts each;
 * - `scripts/check_cli_contract.py`, that an *installed* bugpilot does — run it
 *   against a freshly built wheel before every release.
 *
 * File paths are placeholders, so the fixture is the same on every platform.
 * After an intended change to an argv builder, regenerate it with
 *     BUGPILOT_UPDATE_ARGV_FIXTURE=1 node --test test/cliArgvContract.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_FORM, buildPrepareArgs, buildRetryArgs } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { FIX_MODE_LIST_ARGS, FIX_MODE_MANAGED_ARGS, deleteArgsFor, saveArgsForDraft } from "../src/app/fixModes.ts";
import type { FixModeDraft, ManagedFixMode } from "../src/app/fixModes.ts";
import { reviewPackageArgs } from "../src/app/reviewPackage.ts";
import { instructionsArgs } from "../src/app/instructions.ts";
import { projectSettingsArgs } from "../src/app/projectSettings.ts";
import { jiraSiteArgs } from "../src/app/jiraSite.ts";
import { recordReviewArgs } from "../src/app/reviewCapture.ts";
import { recordVerificationArgs } from "../src/app/verificationCapture.ts";
import { repositoryProfileArgs } from "../src/app/repositoryProfile.ts";

const FIXTURE = new URL("../../tests/fixtures/extension_cli_argv.json", import.meta.url);

const ROOT = path.resolve(tmpdir(), "bugpilot-argv-contract");
const ATTACHMENT = path.join(tmpdir(), "bugpilot-argv-crash.log");
const DESCRIPTION_FILE = path.join(tmpdir(), "bugpilot-argv-description.md");
const PAYLOAD = "{PAYLOAD_FILE}";

/** Concrete paths back to placeholders, separators to `/`, so every platform agrees. */
function placeholders(argv: readonly string[]): string[] {
  return argv.map((arg) => {
    let out = arg;
    for (const [concrete, name] of [
      [DESCRIPTION_FILE, "{DESCRIPTION_FILE}"],
      [ATTACHMENT, "{ATTACHMENT}"],
      [ROOT, "{REPO}"],
    ] as const) {
      if (out.includes(concrete)) out = out.replace(concrete, name).replaceAll("\\", "/");
    }
    return out;
  });
}

/** A Run or Rebuild Context: the builder's argv, then the `--json-lines` `runStreaming` appends. */
function prepare(form: FormState): string[] {
  const built = buildPrepareArgs(form, { root: ROOT, descriptionFilePath: DESCRIPTION_FILE });
  assert.ok(built.ok, JSON.stringify(built));
  return placeholders([...built.args, "--json-lines"]);
}

/** A `--json` query: the builder's argv, then the `--json` `runJson` appends. */
const json = (argv: readonly string[]): string[] => placeholders([...argv, "--json"]);

/** Every setting away from its default, so every flag the panel can send is sent. */
const EVERYTHING: FormState = {
  ...DEFAULT_FORM,
  issueKey: "JR-12345",
  hint: "Look at the cache invalidation in SearchCache",
  keywords: "SearchCache, invalidate\n-Wall",
  focusFiles: "src/search/cache.ts",
  ignorePaths: "build/\nvendor/",
  maxFiles: "5",
  maxSearchLines: "120",
  attachments: [ATTACHMENT],
  attachmentDescriptions: { [ATTACHMENT]: "The stack trace after the second search" },
  fixModeId: "conservative",
  gitUseSharedKeywords: false,
  gitUseSharedFocusFiles: false,
  gitKeywords: "cache",
  gitFiles: "src/search/",
  gitSearchMessages: false,
  gitSearchFileHistory: false,
  gitHistoryDepth: "broader",
  gitMaxCommits: "7",
  similarUseSharedKeywords: false,
  similarKeywords: "stale results",
  similarMaxFixes: "3",
  branchPolicy: "per-issue",
};

const DRAFT: FixModeDraft = {
  intent: "create",
  id: "my-careful",
  name: "My careful fix",
  description: "",
  executionKind: "fix",
  objective: "",
  investigation: "",
  implementation: "",
  verification: "",
  constraints: "",
  completion: "",
  scope: "project",
} as unknown as FixModeDraft;

const MANAGED = { id: "my-careful", scope: "project", version: 3 } as unknown as ManagedFixMode;

function contract(): { readonly name: string; readonly argv: readonly string[] }[] {
  return [
    { name: "run: Jira issue, every setting changed", argv: prepare(EVERYTHING) },
    { name: "run: described bug with a title", argv: prepare({ ...DEFAULT_FORM, source: "manual", description: "Saving a record crashes", title: "Save crash", branchPolicy: "ask" }) },
    { name: "run: long description through a file", argv: prepare({ ...DEFAULT_FORM, source: "manual", description: "x".repeat(5_000) }) },
    {
      name: "run: Fresh, optional steps unticked",
      argv: prepare({ ...DEFAULT_FORM, issueKey: "JR-12345", fresh: true, plan: { ...DEFAULT_FORM.plan, codeSearch: false, gitHistory: false, similarFixes: false } }),
    },
    { name: "retry", argv: json(buildRetryArgs("JR-12345")) },
    { name: "doctor (start-up handshake)", argv: json(["doctor"]) },
    { name: "list (History)", argv: json(["list"]) },
    { name: "issue-details (hint improver)", argv: json(["issue-details", "JR-12345"]) },
    { name: "clean (Reset Session)", argv: ["clean", "JR-12345"] },
    { name: "agent-check", argv: ["agent-check"] },
    { name: "fix-mode list", argv: json(FIX_MODE_LIST_ARGS) },
    { name: "fix-mode list --all-scopes", argv: json(FIX_MODE_MANAGED_ARGS) },
    { name: "fix-mode create", argv: json(saveArgsForDraft(DRAFT, PAYLOAD)) },
    { name: "fix-mode update", argv: json(saveArgsForDraft({ ...DRAFT, intent: "edit", version: 2 } as unknown as FixModeDraft, PAYLOAD)) },
    { name: "fix-mode delete", argv: json(deleteArgsFor(MANAGED)) },
    { name: "review-package", argv: json(reviewPackageArgs("JR-12345")) },
    { name: "review-package --include-changes (Review with AI)", argv: json(reviewPackageArgs("JR-12345", { includeChanges: true })) },
    { name: "record-review", argv: json(recordReviewArgs("JR-12345", PAYLOAD, true)) },
    { name: "record-verification", argv: json(recordVerificationArgs("JR-12345", PAYLOAD, true)) },
    { name: "repository-profile show", argv: placeholders([...repositoryProfileArgs(), "--json"]) },
    { name: "repository-profile set", argv: placeholders([...repositoryProfileArgs(PAYLOAD), "--json"]) },
    // User and Project instructions (pre-release Batch 2): the text goes on stdin, so none is here.
    // Jira Setup's site (Batch 3): read when the dialog opens, written by Save — the site on stdin.
    { name: "jira-site show", argv: placeholders([...jiraSiteArgs(false)]) },
    { name: "jira-site set", argv: placeholders([...jiraSiteArgs(true)]) },
    // Project settings (Batch 3): read when the environment resolves, written on Apply.
    { name: "project-settings show", argv: placeholders([...projectSettingsArgs(), "--json"]) },
    { name: "project-settings set", argv: placeholders([...projectSettingsArgs(PAYLOAD), "--json"]) },
    { name: "instructions show", argv: placeholders([...instructionsArgs()]) },
    { name: "instructions set (stdin)", argv: placeholders([...instructionsArgs({ scope: "project", clear: false })]) },
    { name: "instructions set --clear", argv: placeholders([...instructionsArgs({ scope: "user", clear: true })]) },
  ];
}

test("the shared fixture is every command line the extension sends today", () => {
  const actual = { "//": "Generated by extension/test/cliArgvContract.test.ts; see its header.", commands: contract() };
  if (process.env["BUGPILOT_UPDATE_ARGV_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  }
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof actual;
  assert.deepEqual(
    stored,
    JSON.parse(JSON.stringify(actual)),
    "an argv builder changed: regenerate tests/fixtures/extension_cli_argv.json (see this file's header) and check the CLI accepts it",
  );
});

test("the fixture covers every flag a Run can carry", () => {
  const flags = new Set(contract().flatMap((entry) => entry.argv).filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0]));
  for (const flag of [
    "--prepare-only", "--resume", "--fresh", "--replace-attachments", "--branch-policy", "--fix-mode", "--hint",
    "--keywords", "--focus-file", "--ignore-path", "--max-files", "--max-search-lines", "--attach", "--attach-description",
    "--git-keyword", "--git-file", "--git-no-shared-keywords", "--git-no-shared-focus-files", "--git-no-commit-search",
    "--git-no-file-history", "--git-history-depth", "--git-max-commits", "--similar-fixes-keyword",
    "--similar-fixes-no-shared-keywords", "--max-similar-fixes", "--skip-code-search", "--skip-git-history",
    "--skip-similar-fixes", "--description", "--description-file", "--title", "--json-lines", "--retry", "--json",
  ]) {
    assert.ok(flags.has(flag), `no command line in the fixture sends ${flag}`);
  }
});
