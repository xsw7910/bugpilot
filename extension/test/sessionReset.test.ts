/**
 * Reset Session's rules (§37.103): which form fields are the session's, the
 * fresh form, and deleting a work item's generated files only when the folder
 * is provably the repository's own.
 *
 * The deletion tests run against real temporary directories — with real links
 * and junctions — because the question they answer is what the file system
 * does, not what a fake says it does. `clean` is a stand-in for the CLI here
 * (the real `bugpilot clean` is exercised by `npm run integration`); what is
 * under test is that nothing reaches it unless the check passed, and that
 * success is the folder being gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_FORM } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import {
  DELETE_FILES_HELPER,
  DELETE_FILES_HISTORY,
  FORM_FIELD_SCOPE,
  KEEP_FILES_HELPER,
  RESET_DIALOG_BODY,
  RESET_DIALOG_TITLE,
  checkArtifactDirectory,
  deleteWorkItemArtifacts,
  deletionProblem,
  resetSessionForm,
  writeWorkItemFile,
} from "../src/app/sessionReset.ts";
import type { DeletionFileSystem } from "../src/app/sessionReset.ts";

/** A form with every field away from its default — what a long session leaves. */
const USED: FormState = {
  source: "manual",
  issueKey: "",
  title: "Crash when saving",
  description: "Saving with no selection crashes the widget.",
  hint: "Check WidgetController::save",
  useIssueDetails: false,
  keywords: "WidgetController, save",
  focusFiles: "src/widgets/",
  ignorePaths: "build/",
  maxFiles: "5",
  maxSearchLines: "100",
  attachments: ["C:/path/to/crash.log"],
  attachmentDescriptions: { "C:/path/to/crash.log": "The stack trace" },
  fixModeId: "conservative",
  plan: { issueDetails: true, codeSearch: false, gitHistory: false, similarFixes: false, buildContext: true },
  fixWithAI: true,
  agent: "codex-cli",
  agentCommand: "my-agent --prompt {prompt}",
  gitUseSharedKeywords: false,
  gitUseSharedFocusFiles: false,
  gitKeywords: "gather order",
  gitFiles: "src/legacy/",
  gitSearchMessages: false,
  gitSearchFileHistory: false,
  gitHistoryDepth: "broader",
  gitMaxCommits: "20",
  similarUseSharedKeywords: false,
  similarKeywords: "export crash",
  similarMaxFixes: "2",
  fresh: true,
  branchPolicy: "ask",
  repositoryProfile: "custom",
  repositoryLanguages: "C++, Python",
  repositoryFrameworks: "Qt",
  repositoryApplicationType: "Desktop application",
  repositoryBuildSystem: "CMake",
  repositoryTestFramework: "Catch2",
  repositoryNotes: "Keep the plugin ABI stable.",
  verifyRelevantTests: false,
  verifyStaticChecks: false,
  verifyFullSuite: true,
  verifyReportNotRun: false,
  branchNaming: "custom",
  branchTemplate: "bugfix/{issue}-{slug}",
};

// --- the form ---------------------------------------------------------------

test("every form field is classified, and only the AI Agent, branch policy, repository profile and project settings are kept", () => {
  // The Record makes a missing field a compile error; this makes an extra one a
  // test failure, and states the decision in one line. The branch policy is how
  // the developer works with branches, not anything about this issue (§37.127);
  // the Repository Profile is a copy of the repository's own file, which a
  // session reset never touches (pre-release Batch 1).
  assert.deepEqual(Object.keys(FORM_FIELD_SCOPE).sort(), Object.keys(DEFAULT_FORM).sort());
  assert.deepEqual(
    Object.entries(FORM_FIELD_SCOPE)
      .filter(([, scope]) => scope === "preference")
      .map(([field]) => field)
      .sort(),
    [
      "agent",
      "agentCommand",
      "branchNaming",
      "branchPolicy",
      "branchTemplate",
      "repositoryApplicationType",
      "repositoryBuildSystem",
      "repositoryFrameworks",
      "repositoryLanguages",
      "repositoryNotes",
      "repositoryProfile",
      "repositoryTestFramework",
      // The repository's project settings (Batch 3), copies of its own file.
      "verifyFullSuite",
      "verifyRelevantTests",
      "verifyReportNotRun",
      "verifyStaticChecks",
    ],
  );
  // The fields this feature names as the session's, by name.
  for (const field of [
    "issueKey", "description", "title", "hint", "keywords", "focusFiles", "attachments", "attachmentDescriptions",
    "plan", "fixWithAI", "fixModeId", "gitUseSharedKeywords", "gitUseSharedFocusFiles", "gitKeywords", "gitFiles",
    "gitSearchMessages", "gitSearchFileHistory", "gitHistoryDepth", "gitMaxCommits", "fresh", "useIssueDetails",
    "similarUseSharedKeywords", "similarKeywords", "similarMaxFixes",
  ] as const) {
    assert.equal(FORM_FIELD_SCOPE[field], "session", field);
  }
});

test("a reset form is the product defaults, Fix Mode at the catalog default, the agent kept", () => {
  const fresh = resetSessionForm(USED, "standard");
  for (const [field, scope] of Object.entries(FORM_FIELD_SCOPE) as [keyof FormState, string][]) {
    if (field === "fixModeId") continue;
    if (scope === "preference") assert.deepEqual(fresh[field], USED[field], `${field} was not kept`);
    else assert.deepEqual(fresh[field], DEFAULT_FORM[field], `${field} was not reset`);
  }
  assert.equal(fresh.fixModeId, "standard", "Fix Mode is not Standard Fix after a reset");
  // Git History Settings, spelled out: shared guidance on, nothing extra, both
  // routes on, Recent, the CLI's own count.
  assert.equal(fresh.gitUseSharedKeywords, true);
  assert.equal(fresh.gitUseSharedFocusFiles, true);
  assert.equal(fresh.gitKeywords, "");
  assert.equal(fresh.gitFiles, "");
  assert.equal(fresh.gitSearchMessages, true);
  assert.equal(fresh.gitSearchFileHistory, true);
  assert.equal(fresh.gitHistoryDepth, "recent");
  assert.equal(fresh.gitMaxCommits, "");
  // The shared Retrieval inputs, empty (§37.113).
  assert.equal(fresh.keywords, "");
  assert.equal(fresh.focusFiles, "");
  // Similar Fixes Settings, spelled out: the shared Keywords on, no keywords of
  // its own, the CLI's own count — five.
  assert.equal(fresh.similarUseSharedKeywords, true);
  assert.equal(fresh.similarKeywords, "");
  assert.equal(fresh.similarMaxFixes, "");
  // The branch policy is how the developer works, and stays (§37.127).
  assert.equal(fresh.branchPolicy, "ask");
  // Nothing of the old form is shared by reference.
  assert.notEqual(fresh.attachments, USED.attachments);
  // A catalog not read yet: no mode, as `DEFAULT_FORM` says, rather than a guess.
  assert.equal(resetSessionForm(USED, "").fixModeId, "");
});

test("the dialog says what resets, that History stays, and what Delete costs", () => {
  assert.equal(RESET_DIALOG_TITLE, "Reset BugPilot Session?");
  assert.equal(RESET_DIALOG_BODY, "Reset the current issue, workflow settings, and prepared context.");
  assert.equal(KEEP_FILES_HELPER, "History will be kept.");
  assert.match(DELETE_FILES_HELPER, /permanently deleted/);
  assert.match(DELETE_FILES_HELPER, /Repository source files will not be deleted\./);
  assert.match(DELETE_FILES_HISTORY, /other History entries are kept/);
});

// --- deleting the generated files ---------------------------------------------

/**
 * A throwaway repository: a source file, two prepared work items, a file of
 * the developer's own in `.ai/`, a memory entry, and a folder outside it all.
 */
function repository() {
  const base = mkdtempSync(path.join(tmpdir(), "bugpilot-reset-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "widget.ts"), "export const widget = 1;\n");
  for (const id of ["JR-1", "JR-2"]) {
    mkdirSync(path.join(root, ".ai", id, "attachments"), { recursive: true });
    for (const name of ["issue.json", "retrieval.json", "context.md", "task.md", "run.json"]) {
      writeFileSync(path.join(root, ".ai", id, name), `${id} ${name}\n`);
    }
    writeFileSync(path.join(root, ".ai", id, "attachments", "crash.log"), "trace\n");
  }
  writeFileSync(path.join(root, ".ai", "notes.txt"), "mine\n");
  mkdirSync(path.join(root, ".ai_memory", "bugs"), { recursive: true });
  writeFileSync(path.join(root, ".ai_memory", "bugs", "JR-1.md"), "memory\n");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "precious.txt"), "do not delete\n");
  return {
    root,
    outside,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** A directory link that needs no privilege: a junction on Windows, a symlink elsewhere. */
function linkDirectory(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** `bugpilot clean <id>`'s effect, without the CLI: the folder, and nothing it links to. */
function fakeClean(root: string, workItemId: string, calls: string[]) {
  return async () => {
    calls.push(workItemId);
    rmSync(path.join(root, ".ai", workItemId), { recursive: true, force: true });
    return { code: 0 };
  };
}

test("Delete removes the current work item's folder and nothing else", async () => {
  const repo = repository();
  try {
    const calls: string[] = [];
    const outcome = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: fakeClean(repo.root, "JR-1", calls) });
    assert.deepEqual(outcome, { kind: "deleted" });
    assert.deepEqual(calls, ["JR-1"]);
    assert.equal(existsSync(path.join(repo.root, ".ai", "JR-1")), false);
    // Untouched: the repository's source, the other work item, the developer's
    // own file in .ai/, the memory entry, and anything outside.
    assert.equal(readFileSync(path.join(repo.root, "src", "widget.ts"), "utf8"), "export const widget = 1;\n");
    assert.equal(readFileSync(path.join(repo.root, ".ai", "JR-2", "task.md"), "utf8"), "JR-2 task.md\n");
    assert.equal(readFileSync(path.join(repo.root, ".ai", "notes.txt"), "utf8"), "mine\n");
    assert.equal(readFileSync(path.join(repo.root, ".ai_memory", "bugs", "JR-1.md"), "utf8"), "memory\n");
    assert.equal(readFileSync(path.join(repo.outside, "precious.txt"), "utf8"), "do not delete\n");
  } finally {
    repo.cleanup();
  }
});

test("no folder to delete is said as such, and nothing runs", async () => {
  const repo = repository();
  try {
    const calls: string[] = [];
    const outcome = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-3", clean: fakeClean(repo.root, "JR-3", calls) });
    assert.deepEqual(outcome, { kind: "missing" });
    assert.deepEqual(calls, []);
    // No .ai/ at all is the same answer.
    rmSync(path.join(repo.root, ".ai"), { recursive: true });
    assert.deepEqual(await checkArtifactDirectory(repo.root, "JR-1"), { kind: "missing" });
  } finally {
    repo.cleanup();
  }
});

test("a work item folder that is a link or junction is refused, and what it points at survives", async () => {
  const repo = repository();
  try {
    rmSync(path.join(repo.root, ".ai", "JR-1"), { recursive: true });
    linkDirectory(repo.outside, path.join(repo.root, ".ai", "JR-1"));
    const calls: string[] = [];
    const outcome = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: fakeClean(repo.root, "JR-1", calls) });
    assert.deepEqual(outcome, { kind: "refused", reason: "link" });
    assert.deepEqual(calls, [], "the delete ran through a link");
    assert.equal(readFileSync(path.join(repo.outside, "precious.txt"), "utf8"), "do not delete\n");
  } finally {
    repo.cleanup();
  }
});

test("an .ai folder that is itself a link or junction is refused", async () => {
  const repo = repository();
  try {
    const elsewhere = path.join(repo.outside, "ai");
    mkdirSync(path.join(elsewhere, "JR-1"), { recursive: true });
    writeFileSync(path.join(elsewhere, "JR-1", "task.md"), "elsewhere\n");
    rmSync(path.join(repo.root, ".ai"), { recursive: true });
    linkDirectory(elsewhere, path.join(repo.root, ".ai"));
    const calls: string[] = [];
    const outcome = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: fakeClean(repo.root, "JR-1", calls) });
    assert.deepEqual(outcome, { kind: "refused", reason: "link" });
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(path.join(elsewhere, "JR-1", "task.md"), "utf8"), "elsewhere\n");
  } finally {
    repo.cleanup();
  }
});

test("a file where the folder should be is refused", async () => {
  const repo = repository();
  try {
    rmSync(path.join(repo.root, ".ai", "JR-1"), { recursive: true });
    writeFileSync(path.join(repo.root, ".ai", "JR-1"), "not a folder\n");
    const calls: string[] = [];
    const outcome = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: fakeClean(repo.root, "JR-1", calls) });
    assert.deepEqual(outcome, { kind: "refused", reason: "not-a-directory" });
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(path.join(repo.root, ".ai", "JR-1"), "utf8"), "not a folder\n");
  } finally {
    repo.cleanup();
  }
});

test("an id BugPilot could not have created is refused before the file system is asked", async () => {
  const touched: string[] = [];
  const fs: DeletionFileSystem = {
    lstat: (async (file: string) => {
      touched.push(String(file));
      return lstat(file);
    }) as DeletionFileSystem["lstat"],
    realpath,
  };
  for (const id of ["", "..", "../src", "JR-1/../../src", "JR-1\\..\\src", "C:\\work", "/etc", "src", "JR-1 ", "jr 1"]) {
    let ran = false;
    const outcome = await deleteWorkItemArtifacts({
      root: "/work/app",
      workItemId: id,
      clean: async () => {
        ran = true;
        return { code: 0 };
      },
      fs,
    });
    assert.deepEqual(outcome, { kind: "refused", reason: "invalid-id" }, JSON.stringify(id));
    assert.equal(ran, false, `clean ran for ${JSON.stringify(id)}`);
  }
  assert.deepEqual(touched, []);
});

test("a folder that resolves anywhere but the repository's own .ai/<id> is refused", async () => {
  // A reparse point lstat does not call a link still resolves elsewhere: the
  // resolved path is what is compared.
  const fs: DeletionFileSystem = {
    lstat: (async () => ({ isSymbolicLink: () => false, isDirectory: () => true })) as unknown as DeletionFileSystem["lstat"],
    realpath: (async (file: string) =>
      String(file).endsWith("JR-1") ? "/elsewhere/JR-1" : "/work/app") as unknown as DeletionFileSystem["realpath"],
  };
  let ran = false;
  const outcome = await deleteWorkItemArtifacts({
    root: "/work/app",
    workItemId: "JR-1",
    clean: async () => {
      ran = true;
      return { code: 0 };
    },
    fs,
    caseInsensitive: false,
  });
  assert.deepEqual(outcome, { kind: "refused", reason: "outside" });
  assert.equal(ran, false);
});

test("on Windows the comparison ignores case, as the file system does", async () => {
  const fs: DeletionFileSystem = {
    lstat: (async () => ({ isSymbolicLink: () => false, isDirectory: () => true })) as unknown as DeletionFileSystem["lstat"],
    realpath: (async (file: string) =>
      String(file).endsWith("JR-1") ? path.resolve("/Work/App/.AI/jr-1") : path.resolve("/work/app")) as unknown as DeletionFileSystem["realpath"],
  };
  assert.equal((await checkArtifactDirectory(path.resolve("/work/app"), "JR-1", fs, true)).kind, "ok");
  assert.equal((await checkArtifactDirectory(path.resolve("/work/app"), "JR-1", fs, false)).kind, "refused");
});

test("success is the folder gone — never an exit code alone", async () => {
  const repo = repository();
  try {
    // Exit 0, folder still there.
    assert.deepEqual(
      await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: async () => ({ code: 0 }) }),
      { kind: "failed", reason: "still-present" },
    );
    // Exit 1, folder still there.
    assert.deepEqual(
      await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: async () => ({ code: 1 }) }),
      { kind: "failed", reason: "exit-1" },
    );
    // A delete that stopped half-way: one file gone, an error, the rest left.
    const halfway = await deleteWorkItemArtifacts({
      root: repo.root,
      workItemId: "JR-1",
      clean: async () => {
        rmSync(path.join(repo.root, ".ai", "JR-1", "task.md"));
        return { code: 1 };
      },
    });
    assert.deepEqual(halfway, { kind: "failed", reason: "exit-1" });
    assert.equal(existsSync(path.join(repo.root, ".ai", "JR-1", "context.md")), true);
    // Gone, but the command said it failed: not claimed as a clean delete.
    assert.deepEqual(
      await deleteWorkItemArtifacts({
        root: repo.root,
        workItemId: "JR-1",
        clean: async () => {
          rmSync(path.join(repo.root, ".ai", "JR-1"), { recursive: true });
          return { code: 2 };
        },
      }),
      { kind: "failed", reason: "exit-2" },
    );
  } finally {
    repo.cleanup();
  }
});

test("a delete that could not start, or timed out, is a failure with a safe reason", async () => {
  const repo = repository();
  try {
    const spawnFailed = await deleteWorkItemArtifacts({
      root: repo.root,
      workItemId: "JR-1",
      clean: async () => {
        throw Object.assign(new Error(`spawn bugpilot ENOENT ${repo.root}`), { code: "ENOENT" });
      },
    });
    assert.deepEqual(spawnFailed, { kind: "failed", reason: "spawn-ENOENT" });
    const timedOut = await deleteWorkItemArtifacts({ root: repo.root, workItemId: "JR-1", clean: async () => ({ code: null, aborted: true }) });
    assert.deepEqual(timedOut, { kind: "failed", reason: "timeout" });
    // Neither reason carries a path or a message.
    for (const outcome of [spawnFailed, timedOut]) {
      assert.ok(outcome.kind === "failed" && /^[A-Za-z0-9_-]+$/.test(outcome.reason));
    }
  } finally {
    repo.cleanup();
  }
});

test("why nothing was reset is said without any path but the work item's own folder", () => {
  for (const deletion of [
    { kind: "refused", reason: "invalid-id" },
    { kind: "refused", reason: "link" },
    { kind: "refused", reason: "not-a-directory" },
    { kind: "refused", reason: "outside" },
    { kind: "failed", reason: "exit-1" },
  ] as const) {
    const message = deletionProblem(deletion, "JR-12345");
    assert.match(message, /^Session not reset: /);
    // The only paths in it are the work item's folder and `.ai/` itself.
    const others = message.replaceAll(".ai/JR-12345/", "").replaceAll(".ai/", "");
    assert.doesNotMatch(others, /[\\/]/, message);
    assert.doesNotMatch(message, /exit-1/, "a code reached the developer's sentence");
  }
  assert.match(deletionProblem({ kind: "refused", reason: "link" }, "JR-12345"), /Nothing was deleted\./);
  assert.match(deletionProblem({ kind: "failed", reason: "exit-1" }, "JR-12345"), /\.ai\/JR-12345\//);
});

// --- writing into the work item folder (pre-release Batch 2, D) -----------------

test("the extension's write into .ai/<id>/ lands in the repository's own folder, creating it when needed", async () => {
  const repo = repository();
  try {
    await writeWorkItemFile({ root: repo.root, workItemId: "JR-1", name: "user_feedback.md", contents: "first\n" });
    assert.equal(readFileSync(path.join(repo.root, ".ai", "JR-1", "user_feedback.md"), "utf8"), "first\n");
    await writeWorkItemFile({ root: repo.root, workItemId: "JR-1", name: "user_feedback.md", contents: "second\n" });
    assert.equal(readFileSync(path.join(repo.root, ".ai", "JR-1", "user_feedback.md"), "utf8"), "second\n");
    rmSync(path.join(repo.root, ".ai"), { recursive: true });
    await writeWorkItemFile({ root: repo.root, workItemId: "JR-9", name: "user_feedback.md", contents: "new\n" });
    assert.equal(readFileSync(path.join(repo.root, ".ai", "JR-9", "user_feedback.md"), "utf8"), "new\n");
  } finally {
    repo.cleanup();
  }
});

test("a linked .ai or work item folder is refused, nothing is written through it, and the reason names no absolute path", async () => {
  for (const linked of [".ai", ".ai/JR-1"] as const) {
    const repo = repository();
    try {
      const elsewhere = path.join(repo.outside, "target");
      mkdirSync(path.join(elsewhere, "JR-1"), { recursive: true });
      rmSync(path.join(repo.root, ...linked.split("/")), { recursive: true });
      linkDirectory(linked === ".ai" ? elsewhere : path.join(elsewhere, "JR-1"), path.join(repo.root, ...linked.split("/")));
      await assert.rejects(
        writeWorkItemFile({ root: repo.root, workItemId: "JR-1", name: "user_feedback.md", contents: "feedback\n" }),
        (error: Error) => {
          assert.match(error.message, /does not write through a link or junction, and \.ai\/JR-1\/ or \.ai\/ is one/);
          assert.equal(error.message.includes(repo.root), false, error.message);
          return true;
        },
        linked,
      );
      assert.equal(existsSync(path.join(elsewhere, "JR-1", "user_feedback.md")), false, `${linked}: written through the link`);
    } finally {
      repo.cleanup();
    }
  }
});

test("a linked .ai with no work item folder yet is refused before anything is created through it", async () => {
  const repo = repository();
  try {
    const elsewhere = path.join(repo.outside, "target");
    mkdirSync(elsewhere);
    rmSync(path.join(repo.root, ".ai"), { recursive: true });
    linkDirectory(elsewhere, path.join(repo.root, ".ai"));
    await assert.rejects(writeWorkItemFile({ root: repo.root, workItemId: "JR-7", name: "user_feedback.md", contents: "x\n" }));
    assert.equal(existsSync(path.join(elsewhere, "JR-7")), false, "a folder was created through the link");
  } finally {
    repo.cleanup();
  }
});

test("a user_feedback.md that is itself a link is refused, and its target is unchanged", async (t) => {
  const repo = repository();
  try {
    const target = path.join(repo.outside, "precious.txt");
    try {
      symlinkSync(target, path.join(repo.root, ".ai", "JR-1", "user_feedback.md"), "file");
    } catch (error) {
      // A file link needs a privilege Windows grants only in Developer Mode.
      if ((error as { code?: string }).code === "EPERM") return t.skip("file links need Developer Mode here");
      throw error;
    }
    await assert.rejects(
      writeWorkItemFile({ root: repo.root, workItemId: "JR-1", name: "user_feedback.md", contents: "overwrite\n" }),
      /\.ai\/JR-1\/user_feedback\.md is one/,
    );
    assert.equal(readFileSync(target, "utf8"), "do not delete\n");
  } finally {
    repo.cleanup();
  }
});

test("only a plain file name in a valid work item folder is written", async () => {
  const repo = repository();
  try {
    for (const name of ["../escape.md", "..", "a/b.md", "a\\b.md", ""]) {
      await assert.rejects(writeWorkItemFile({ root: repo.root, workItemId: "JR-1", name, contents: "x\n" }), /nothing was written/, name);
    }
    await assert.rejects(
      writeWorkItemFile({ root: repo.root, workItemId: "../../escape-1", name: "user_feedback.md", contents: "x\n" }),
      /id is not one BugPilot could have created/,
    );
    assert.equal(existsSync(path.join(repo.root, "..", "escape.md")), false);
  } finally {
    repo.cleanup();
  }
});
