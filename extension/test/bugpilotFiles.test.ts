/**
 * What a `.bugpilot/` policy file is, on a real disk: Edit opens only a plain
 * file of this repository — never one reached through a linked `.bugpilot`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bugpilotFileKind } from "../src/host/bugpilotFiles.ts";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "bugpilot-files-"));
}

test("a plain file is a file; none is absent; a folder in its place is other", async () => {
  const root = await scratch();
  try {
    assert.equal(await bugpilotFileKind(root, "ai_behavior.md"), "absent");
    await mkdir(path.join(root, ".bugpilot"));
    assert.equal(await bugpilotFileKind(root, "ai_behavior.md"), "absent");
    await writeFile(path.join(root, ".bugpilot", "ai_behavior.md"), "x\n");
    assert.equal(await bugpilotFileKind(root, "ai_behavior.md"), "file");
    await mkdir(path.join(root, ".bugpilot", "verification.md"));
    assert.equal(await bugpilotFileKind(root, "verification.md"), "other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file reached through a linked .bugpilot folder is other, never opened", async () => {
  const root = await scratch();
  const outside = await scratch();
  try {
    await writeFile(path.join(outside, "ai_behavior.md"), "outside the repository\n");
    // A junction on Windows (no privilege needed), a directory link elsewhere.
    await symlink(outside, path.join(root, ".bugpilot"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(await bugpilotFileKind(root, "ai_behavior.md"), "other");
    assert.equal(await bugpilotFileKind(root, "verification.md"), "other");
  } finally {
    await rm(path.join(root, ".bugpilot"), { force: true });
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a linked file inside a real .bugpilot is other", async (t) => {
  const root = await scratch();
  const outside = await scratch();
  try {
    await mkdir(path.join(root, ".bugpilot"));
    await writeFile(path.join(outside, "target.md"), "outside\n");
    try {
      await symlink(path.join(outside, "target.md"), path.join(root, ".bugpilot", "ai_behavior.md"), "file");
    } catch {
      t.skip("file symbolic links need a privilege this account does not have");
      return;
    }
    assert.equal(await bugpilotFileKind(root, "ai_behavior.md"), "other");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
