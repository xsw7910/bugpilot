/**
 * Fix Mode discovery: what the extension is allowed to know about modes.
 *
 * The rule under test is negative. The extension must not contain a list of Fix
 * Modes, must not decide which one is the default, and must not fall back to
 * either when the CLI cannot be read — because the registry behind the CLI
 * grows, and a copy on this side would look correct while quietly omitting a
 * team's own modes. So every one of these tests either reads the catalog out of
 * a CLI payload, or checks that a missing payload produces an honest "no".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DRAFT_SECTIONS,
  FIX_MODE_LIST_ARGS,
  deleteArgsFor,
  draftFromDefinition,
  findFixMode,
  fixModesFromPayload,
  managedFixModesFromPayload,
  fixModeDiscoveryFailure,
  payloadFromDraft,
  preparedFixModeFromStatus,
  saveArgsForDraft,
  selectedFixModeId,
  suggestedCopyId,
} from "../src/app/fixModes.ts";
import type { FixModeCatalog, FixModeDraft } from "../src/app/fixModes.ts";

const PAYLOAD = {
  schema_version: 1,
  ok: true,
  command: "fix-mode",
  default_mode_id: "standard",
  modes: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default workflow for most bugs.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
    },
    {
      id: "investigate-first",
      name: "Investigate First",
      description: "Diagnose and propose a fix plan before changing source code.",
      version: 1,
      source: "builtin",
      execution_kind: "investigate",
    },
  ],
  warnings: [],
};

const READY = fixModesFromPayload(PAYLOAD);

function ready(): Extract<FixModeCatalog, { kind: "ready" }> {
  assert.equal(READY.kind, "ready");
  return READY as Extract<FixModeCatalog, { kind: "ready" }>;
}

// --- the catalog -----------------------------------------------------------

test("the discovery call is the structured one, not the human table", () => {
  assert.deepEqual([...FIX_MODE_LIST_ARGS], ["fix-mode", "list", "--json"]);
});

test("modes and their display metadata survive the crossing", () => {
  const catalog = ready();
  assert.deepEqual(
    catalog.modes.map((mode) => mode.id),
    ["standard", "investigate-first"],
  );
  const investigate = findFixMode(catalog, "investigate-first")!;
  assert.equal(investigate.name, "Investigate First");
  assert.equal(investigate.executionKind, "investigate");
  assert.match(investigate.description, /fix plan/);
  assert.equal(investigate.version, 1);
  assert.equal(investigate.source, "builtin");
});

test("the default comes from the CLI, not from a name on this side", () => {
  assert.equal(ready().defaultModeId, "standard");
  // A payload that declares a different default is followed, which is the whole
  // point: "standard" is not special to this code.
  const moved = fixModesFromPayload({ ...PAYLOAD, default_mode_id: "investigate-first" });
  assert.equal(moved.kind === "ready" && moved.defaultModeId, "investigate-first");
});

test("a default the list does not contain falls back to the first mode", () => {
  const catalog = fixModesFromPayload({ ...PAYLOAD, default_mode_id: "gone" });
  assert.equal(catalog.kind === "ready" && catalog.defaultModeId, "standard");
});

test("a mode with an execution kind this client cannot read is dropped", () => {
  // `executionKind` is what the panel promises the developer about source
  // changes. Guessing it would be a promise made up by the extension.
  const catalog = fixModesFromPayload({
    ...PAYLOAD,
    modes: [...PAYLOAD.modes, { id: "future", name: "Future", execution_kind: "rewrite" }],
  });
  assert.deepEqual(
    catalog.kind === "ready" ? catalog.modes.map((mode) => mode.id) : [],
    ["standard", "investigate-first"],
  );
});

// --- failure is never a substituted list -----------------------------------

test("a failure envelope becomes an unavailable catalog carrying its message", () => {
  const catalog = fixModesFromPayload({
    schema_version: 1,
    ok: false,
    command: "fix-mode",
    error: { code: "INVALID_INPUT", message: "nope" },
  });
  assert.equal(catalog.kind, "unavailable");
  assert.equal(catalog.kind === "unavailable" && catalog.detail, "nope");
});

test("an older bugpilot with no Fix Modes says so and offers an action", () => {
  const catalog = fixModesFromPayload({ schema_version: 1, ok: true, command: "doctor" });
  assert.equal(catalog.kind, "unavailable");
  assert.match(
    catalog.kind === "unavailable" ? catalog.detail : "",
    /does not expose AI Fix Modes/,
  );
});

test("a bugpilot too old to have `fix-mode` reads as an upgrade, not a fault", () => {
  // What argparse says when the subcommand does not exist: nothing on stdout,
  // this on stderr. The runner surfaces it as a thrown error carrying both.
  const error = Object.assign(new Error("bugpilot produced no output on stdout."), {
    stdout: "",
    stderr:
      "usage: bugpilot [-h] {bug,list} ... bugpilot: error: argument command: "
      + "invalid choice: 'fix-mode' (choose from 'bug', 'list')",
  });
  const catalog = fixModeDiscoveryFailure(error);
  assert.equal(catalog.kind, "unavailable");
  assert.match(catalog.detail, /does not expose AI Fix Modes/);
  assert.doesNotMatch(catalog.detail, /invalid choice/);
});

test("other discovery failures keep their own message", () => {
  // A missing executable, a timeout, or a different bad argument must not be
  // dressed up as "update BugPilot": the developer would fix the wrong thing.
  for (const error of [
    new Error("spawn bugpilot ENOENT"),
    Object.assign(new Error("bugpilot produced no output on stdout."), {
      stderr: "bugpilot: error: argument command: invalid choice: 'status' (choose from 'bug')",
    }),
    Object.assign(new Error("timed out after 30000ms"), { stderr: "" }),
  ]) {
    const catalog = fixModeDiscoveryFailure(error);
    assert.equal(catalog.kind, "unavailable");
    assert.match(catalog.detail, /could not list its AI Fix Modes/);
    assert.ok(catalog.detail.includes(error.message), catalog.detail);
    assert.doesNotMatch(catalog.detail, /does not expose/);
  }
});

test("malformed payloads are unavailable rather than partly believed", () => {
  for (const payload of [undefined, null, "[]", 7, [], { modes: "standard" }, { modes: [] }]) {
    const catalog = fixModesFromPayload(payload);
    assert.equal(catalog.kind, "unavailable", JSON.stringify(payload));
    assert.ok((catalog as { detail: string }).detail.length > 0);
  }
});

test("an unavailable catalog offers nothing to select", () => {
  const catalog = fixModesFromPayload(undefined);
  assert.equal(findFixMode(catalog, "standard"), undefined);
  // The chosen id is kept rather than replaced by an invented default: there is
  // no catalog to say what the default is.
  assert.equal(selectedFixModeId(catalog, "conservative"), "conservative");
  assert.equal(selectedFixModeId(catalog, undefined), "");
});

// --- selection -------------------------------------------------------------

test("a selection the catalog still offers is kept", () => {
  assert.equal(selectedFixModeId(READY, "investigate-first"), "investigate-first");
});

test("no selection, or one that is gone, falls to the declared default", () => {
  assert.equal(selectedFixModeId(READY, undefined), "standard");
  assert.equal(selectedFixModeId(READY, ""), "standard");
  assert.equal(selectedFixModeId(READY, "team-safe-fix"), "standard");
});

// --- what a package was prepared with --------------------------------------

test("the prepared mode is read from the work item's status file", () => {
  const prepared = preparedFixModeFromStatus(
    { fix_mode: { id: "investigate-first", name: "Investigate First", execution_kind: "investigate" } },
    READY,
  )!;
  assert.equal(prepared.id, "investigate-first");
  assert.equal(prepared.name, "Investigate First");
  assert.equal(prepared.executionKind, "investigate");
  assert.equal(prepared.availability, "available");
});

test("a package prepared before Fix Modes existed reports none", () => {
  assert.equal(preparedFixModeFromStatus({ steps: {} }, READY), undefined);
  assert.equal(preparedFixModeFromStatus(undefined, READY), undefined);
  assert.equal(preparedFixModeFromStatus({ fix_mode: { name: "No id" } }, READY), undefined);
});

test("a prepared mode the catalog no longer has is reported as unavailable, not as the default", () => {
  // The Phase 5 case, once modes come from files: a package prepared with a
  // team mode whose definition has since gone. Showing "Standard Fix" would
  // misdescribe what the agent was actually told.
  const prepared = preparedFixModeFromStatus(
    { fix_mode: { id: "team-safe-fix", name: "Team Safe Fix", execution_kind: "fix" } },
    READY,
  )!;
  assert.equal(prepared.id, "team-safe-fix");
  assert.equal(prepared.availability, "unavailable");
  assert.equal(prepared.name, "Team Safe Fix");
});

test("the recorded name is what the package was prepared with, not today's", () => {
  // A custom mode can be renamed. Showing the current name over a months-old
  // package would rewrite history: that agent was handed "My Safe Fix".
  const prepared = preparedFixModeFromStatus(
    { fix_mode: { id: "standard", name: "My Safe Fix", execution_kind: "fix" } },
    READY,
  )!;
  assert.equal(prepared.name, "My Safe Fix");
  assert.equal(prepared.id, "standard");
  // The catalog answers a different question: can it still be run.
  assert.equal(prepared.availability, "available");
});

test("a catalog that could not be read leaves availability unknown", () => {
  // The Phase 4 hand-off item. "Gone" and "not checked" are different facts,
  // and reporting the second as the first told people a mode was fine because
  // BugPilot had failed to look.
  const prepared = preparedFixModeFromStatus(
    { fix_mode: { id: "my-safe", name: "My Safe Fix" } },
    { kind: "unavailable", detail: "bugpilot is not installed" },
  )!;
  assert.equal(prepared.availability, "unknown");
  assert.equal(prepared.name, "My Safe Fix");

  // And it becomes a real answer once a catalog arrives.
  assert.equal(
    preparedFixModeFromStatus({ fix_mode: { id: "standard", name: "Standard Fix" } }, READY)!
      .availability,
    "available",
  );
});

// --- the negative rule -----------------------------------------------------

test("no source file in the extension contains a list of Fix Mode ids", () => {
  // The guard for the rule this whole module exists to keep. A list here would
  // work today and be wrong the moment a project defines its own mode — and it
  // would fail silently, by omission.
  const builtins = ["conservative", "investigate-first", "test-driven", "deep-analysis"];
  for (const file of sourceFiles()) {
    const text = code(readFileSync(file, "utf8"));
    const named = builtins.filter((id) => text.includes(`"${id}"`));
    assert.deepEqual(named, [], `${file} names built-in Fix Modes: ${named.join(", ")}`);
  }
});

test("no source file decides that standard is the default", () => {
  for (const file of sourceFiles()) {
    assert.ok(
      !code(readFileSync(file, "utf8")).includes('"standard"'),
      `${file} hard-codes the default Fix Mode id; the CLI reports default_mode_id`,
    );
  }
});

/**
 * Source with comments removed.
 *
 * Prose has to be able to name a mode — explaining *why* the list is not here
 * needs the words — so the guard reads code only, the way the Python
 * unwired-symbol guard strips docstrings before counting references.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every shipped source file: `src/**` plus the page script. */
function sourceFiles(): string[] {
  const files: string[] = [fileURLToPath(new URL("../media/panel.js", import.meta.url))];
  const walk = (directory: URL): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) files.push(fileURLToPath(child));
    }
  };
  walk(new URL("../src/", import.meta.url));
  return files;
}

test("duplicate ids are malformed discovery data, not a choice to make", () => {
  // Core never emits two modes with one id. If one ever arrives, keeping either
  // would put two identical values in the selector: the second unselectable,
  // and the description beside it belonging to the first.
  const catalog = fixModesFromPayload({
    ...PAYLOAD,
    modes: [...PAYLOAD.modes, { ...PAYLOAD.modes[0], name: "Standard Fix (other)" }],
  });

  assert.equal(catalog.kind, "unavailable");
  assert.match(catalog.kind === "unavailable" ? catalog.detail : "", /two AI Fix Modes with the id/);
  assert.match(catalog.kind === "unavailable" ? catalog.detail : "", /standard/);
});

// --- managing custom modes ---------------------------------------------------

const MANAGED_PAYLOAD = {
  schema_version: 1,
  ok: true,
  command: "fix-mode",
  default_mode_id: "standard",
  builtin: [
    {
      id: "standard",
      name: "Standard Fix",
      description: "Default workflow.",
      version: 1,
      source: "builtin",
      execution_kind: "fix",
      based_on: null,
      based_on_version: null,
      scope: "builtin",
      effective: true,
    },
  ],
  user: [
    {
      id: "my-safe",
      name: "My Safe Fix",
      description: "Mine.",
      version: 3,
      source: "user",
      execution_kind: "fix",
      based_on: "standard",
      based_on_version: 1,
      scope: "user",
      effective: false,
    },
  ],
  project: [
    {
      id: "my-safe",
      name: "Team Safe Fix",
      description: "Ours.",
      version: 1,
      source: "project",
      execution_kind: "investigate",
      based_on: "conservative",
      based_on_version: 1,
      scope: "project",
      effective: true,
    },
  ],
  issues: [
    { scope: "project", path: "/repo/.bugpilot/fix_modes/broken.json", message: "not valid JSON" },
  ],
  warnings: [],
};

test("the management view keeps both definitions of a shadowed id", () => {
  // The whole reason management is a second call: the selector shows one
  // `my-safe`, and the user's own copy would be unreachable if that were the
  // only list — no way to edit it, no way to delete it.
  const managed = managedFixModesFromPayload(MANAGED_PAYLOAD);

  assert.equal(managed.kind, "ready");
  if (managed.kind !== "ready") return;
  assert.deepEqual(
    managed.user.map((mode) => [mode.id, mode.name, mode.effective]),
    [["my-safe", "My Safe Fix", false]],
  );
  assert.deepEqual(
    managed.project.map((mode) => [mode.id, mode.name, mode.effective]),
    [["my-safe", "Team Safe Fix", true]],
  );
  assert.equal(managed.user[0]!.basedOn, "standard");
  assert.equal(managed.user[0]!.basedOnVersion, 1);
  assert.equal(managed.project[0]!.executionKind, "investigate");
});

test("unreadable custom files are carried through with scope and path", () => {
  const managed = managedFixModesFromPayload(MANAGED_PAYLOAD);

  assert.equal(managed.kind === "ready" && managed.issues.length, 1);
  if (managed.kind !== "ready") return;
  assert.equal(managed.issues[0]!.scope, "project");
  assert.match(managed.issues[0]!.path, /broken\.json$/);
});

test("an older bugpilot that cannot manage modes says so", () => {
  const managed = managedFixModesFromPayload({ schema_version: 1, ok: true, modes: [] });

  assert.equal(managed.kind, "unavailable");
  assert.match(
    managed.kind === "unavailable" ? managed.detail : "",
    /cannot manage custom Fix Modes/,
  );
});

test("a failure envelope becomes an unavailable management view", () => {
  const managed = managedFixModesFromPayload({
    ok: false,
    error: { code: "INVALID_INPUT", message: "no repository" },
  });

  assert.equal(managed.kind === "unavailable" && managed.detail, "no repository");
});

// --- drafts ------------------------------------------------------------------

const DEFINITION = {
  ok: true,
  mode: {
    id: "my-safe",
    name: "My Safe Fix",
    description: "Mine.",
    version: 3,
    source: "user",
    execution_kind: "fix",
    based_on: "standard",
    based_on_version: 1,
    objective: "Objective text.",
    investigation: "Investigation text.",
    implementation: "Implementation text.",
    verification: "Verification text.",
    constraints: "Constraints text.",
    completion: "Completion text.",
  },
};

test("a draft carries every editable section and the version it was opened at", () => {
  const draft = draftFromDefinition(DEFINITION, "edit", "user")!;

  assert.equal(draft.intent, "edit");
  assert.equal(draft.version, 3);
  assert.equal(draft.basedOn, "standard");
  assert.equal(draft.basedOnVersion, 1);
  for (const section of DRAFT_SECTIONS) {
    assert.match(draft[section], /text\.$/, section);
  }
});

test("a saved draft becomes a payload that cannot claim a source", () => {
  // Scope comes from the directory core writes to. A payload that could name a
  // source could name `builtin`.
  const payload = payloadFromDraft(draftFromDefinition(DEFINITION, "edit", "user")!);

  assert.equal(payload["source"], undefined);
  assert.equal(payload["version"], undefined);
  assert.equal(payload["schema_version"], 1);
  assert.equal(payload["execution_kind"], "fix");
  assert.equal(payload["based_on"], "standard");
});

test("an edit sends the expected version and a create does not", () => {
  const draft = draftFromDefinition(DEFINITION, "edit", "user")!;

  assert.deepEqual(saveArgsForDraft(draft, "/tmp/p.json"), [
    "fix-mode",
    "update",
    "my-safe",
    "--scope=user",
    "--expected-version=3",
    "--from-file=/tmp/p.json",
    "--json",
  ]);
  assert.deepEqual(saveArgsForDraft({ ...draft, intent: "create" }, "/tmp/p.json"), [
    "fix-mode",
    "create",
    "my-safe",
    "--scope=user",
    "--from-file=/tmp/p.json",
    "--json",
  ]);
});

test("mode text never becomes part of a command line", () => {
  // Quotes, backticks, pipes, newlines and a NUL-adjacent mess: all of it rides
  // in the payload file, and the argv only ever names a path.
  const hostile = "a \" b ' c ` d $e %f& g | h > i < j\nnewline\ttab \\ 反斜杠";
  const draft: FixModeDraft = {
    ...draftFromDefinition(DEFINITION, "edit", "user")!,
    objective: hostile,
    constraints: hostile,
  };

  const payload = payloadFromDraft(draft);
  const args = saveArgsForDraft(draft, "/tmp/p.json");

  assert.equal(payload["objective"], hostile);
  assert.ok(!args.some((arg) => arg.includes("newline")), "mode text reached argv");
  assert.ok(args.every((arg) => !arg.includes("`") && !arg.includes("|")));
});

test("a delete names the scope and the version it saw", () => {
  const managed = managedFixModesFromPayload(MANAGED_PAYLOAD);
  if (managed.kind !== "ready") return assert.fail("catalog not ready");

  assert.deepEqual(deleteArgsFor(managed.user[0]!), [
    "fix-mode",
    "delete",
    "my-safe",
    "--scope=user",
    "--expected-version=3",
    "--json",
  ]);
});

test("a suggested copy id avoids the ids already in use", () => {
  assert.equal(suggestedCopyId("standard", []), "my-standard");
  assert.equal(suggestedCopyId("standard", ["my-standard"]), "my-standard-2");
  assert.equal(suggestedCopyId("standard", ["my-standard", "my-standard-2"]), "my-standard-3");
});

test("a managed entry is effective only when Core says so", () => {
  // The management list exists to say which of two same-id definitions runs.
  // Assuming "effective" when the field is missing would answer that wrongly.
  const managed = managedFixModesFromPayload({
    ok: true,
    builtin: [],
    user: [
      { id: "said-yes", name: "Said Yes", execution_kind: "fix", effective: true },
      { id: "said-no", name: "Said No", execution_kind: "fix", effective: false },
      { id: "said-nothing", name: "Said Nothing", execution_kind: "fix" },
    ],
    project: [],
    issues: [],
  });

  assert.deepEqual(
    managed.kind === "ready" ? managed.user.map((mode) => [mode.id, mode.effective]) : [],
    [
      ["said-yes", true],
      ["said-no", false],
      ["said-nothing", false],
    ],
  );
});
