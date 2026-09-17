import { test } from "node:test";
import assert from "node:assert/strict";

import { actionsFor, installInstructions, resolveEnvironment } from "../src/app/environment.ts";
import { COMMANDS } from "../src/commands.ts";
import type { Verdict } from "../src/executable.ts";
import type { Folder, WorkspaceProbe } from "../src/workspace.ts";

const gitEverywhere: WorkspaceProbe = { hasDirectory: (_folder, child) => child === ".git" };
const noGit: WorkspaceProbe = { hasDirectory: () => false };

const folder = (name: string, fsPath: string): Folder => ({ name, fsPath });

const ready: Verdict = { kind: "ready", executable: "bugpilot", report: { python_ok: true } };

function discovering(verdict: Verdict): {
  discover: (options: { cwd: string; configured?: string | undefined }) => Promise<Verdict>;
  seen: { cwd: string; configured?: string | undefined }[];
} {
  const seen: { cwd: string; configured?: string | undefined }[] = [];
  return {
    seen,
    discover: async (options) => {
      seen.push(options);
      return verdict;
    },
  };
}

test("one repository and a working CLI is ready", async () => {
  const { discover, seen } = discovering(ready);
  const environment = await resolveEnvironment({
    folders: [folder("app", "/work/app")],
    probe: gitEverywhere,
    configured: "/tools/bugpilot",
    discover,
  });

  assert.equal(environment.kind, "ready");
  if (environment.kind === "ready") {
    assert.equal(environment.root, "/work/app");
    assert.equal(environment.executable, "bugpilot");
    assert.equal(environment.report["python_ok"], true);
  }
  // The handshake must run in the chosen repository, not in some default cwd:
  // bugpilot writes .ai/<work_item>/ relative to it.
  assert.deepEqual(seen, [{ cwd: "/work/app", configured: "/tools/bugpilot" }]);
});

test("no open folder is reported without touching the CLI", async () => {
  const { discover, seen } = discovering(ready);
  const environment = await resolveEnvironment({ folders: [], probe: noGit, discover });

  assert.equal(environment.kind, "no-folder");
  assert.equal(seen.length, 0, "there is nothing to hand bugpilot yet");
});

test("several repositories ask the developer instead of guessing", async () => {
  const { discover } = discovering(ready);
  const environment = await resolveEnvironment({
    folders: [folder("app", "/work/app"), folder("lib", "/work/lib")],
    probe: gitEverywhere,
    discover,
  });

  assert.equal(environment.kind, "choose-folder");
  if (environment.kind === "choose-folder") {
    assert.deepEqual(
      environment.candidates.map((candidate) => candidate.fsPath),
      ["/work/app", "/work/lib"],
    );
  }
});

test("a remembered repository is used when it is still open", async () => {
  const { discover, seen } = discovering(ready);
  const environment = await resolveEnvironment({
    folders: [folder("app", "/work/app"), folder("lib", "/work/lib")],
    probe: gitEverywhere,
    preferredRoot: "/work/lib",
    discover,
  });

  assert.equal(environment.kind, "ready");
  assert.equal(seen[0]?.cwd, "/work/lib");
});

test("a remembered repository that is no longer open is not honoured", async () => {
  // A stale pick must not send artifacts into a checkout that was closed; the
  // developer is asked again instead.
  const { discover } = discovering(ready);
  const environment = await resolveEnvironment({
    folders: [folder("app", "/work/app"), folder("lib", "/work/lib")],
    probe: gitEverywhere,
    preferredRoot: "/work/gone",
    discover,
  });

  assert.equal(environment.kind, "choose-folder");
});

test("an unusable CLI carries both an explanation and something to do", async () => {
  const { discover } = discovering({
    kind: "not-found",
    executable: "bugpilot",
    detail: "bugpilot is not on PATH.",
  });
  const environment = await resolveEnvironment({
    folders: [folder("app", "/work/app")],
    probe: gitEverywhere,
    discover,
  });

  assert.equal(environment.kind, "unusable-cli");
  if (environment.kind !== "unusable-cli") return;
  assert.match(environment.summary, /not on PATH/);
  assert.match(environment.action, /executablePath/);
  assert.deepEqual(
    environment.actions.map((action) => action.command),
    [COMMANDS.showInstallInstructions, COMMANDS.chooseExecutable, COMMANDS.checkEnvironment],
  );
  // The root is still reported: the workspace was fine, only bugpilot was not.
  assert.equal(environment.root, "/work/app");
});

test("the offers differ by verdict, which is why there are five of them", () => {
  const commands = (verdict: Verdict) => actionsFor(verdict).map((action) => action.command);

  // Nothing to install and nothing to reconfigure — only waiting helps.
  assert.deepEqual(commands({ kind: "unresponsive", executable: "bugpilot", detail: "slow" }), [
    COMMANDS.checkEnvironment,
  ]);
  // bugpilot is fine; its environment is not. Sending someone to reinstall
  // over a missing Jira credential wastes their afternoon.
  assert.deepEqual(
    commands({
      kind: "unhealthy",
      executable: "bugpilot",
      code: "JIRA_NOT_CONFIGURED",
      message: "no credentials",
    }),
    [COMMANDS.doctor, COMMANDS.checkEnvironment],
  );
  assert.deepEqual(commands({ kind: "ready", executable: "bugpilot", report: {} }), []);
});

test("every offered action is a command the extension declares", () => {
  const known = new Set<string>(Object.values(COMMANDS));
  const verdicts: Verdict[] = [
    { kind: "not-found", executable: "bugpilot", detail: "" },
    { kind: "incompatible", executable: "bugpilot", detail: "" },
    { kind: "unresponsive", executable: "bugpilot", detail: "" },
    { kind: "unhealthy", executable: "bugpilot", code: "INTERNAL_ERROR", message: "" },
  ];
  for (const verdict of verdicts) {
    for (const action of actionsFor(verdict)) {
      assert.ok(known.has(action.command), `${action.command} is not a declared command`);
      assert.notEqual(action.title.trim(), "", "a button with no label is unclickable");
    }
  }
});

test("the install instructions name both install routes and the PATH escape hatch", () => {
  const text = installInstructions().join("\n");
  assert.match(text, /pip install -e \./);
  assert.match(text, /pipx install/);
  assert.match(text, /executablePath/);
});
