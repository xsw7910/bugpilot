/**
 * Scratch files on the real file system (0.1.5, plan §44.6 S4: F10, F11).
 *
 * A Fix Mode, review or verification payload, and a description too long for a
 * command line, each go to the CLI in a file. These tests create real files and
 * real links in a fresh temporary folder and read back what is there: the name
 * nobody can predict, the exclusive create that refuses whatever is already at
 * it, the owner-only mode, and a removal that takes a link and never its target.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPayloadCommand } from "../src/app/fixModeTransport.ts";
import { removeScratchFile, scratchFileName, writeScratchFile } from "../src/app/scratchFile.ts";

const POSIX = process.platform !== "win32";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function inFolder(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bugpilot-scratch-test-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A symbolic link, or `false` where this account may not make one (Windows without the privilege). */
async function linked(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

test("a scratch name is its prefix and a random UUID, different every time", () => {
  const names = new Set(Array.from({ length: 50 }, () => scratchFileName("bug-description", ".md")));
  assert.equal(names.size, 50);
  for (const name of names) {
    const match = /^bug-description-(.+)\.md$/.exec(name);
    assert.ok(match && UUID.test(match[1]!), name);
  }
});

test("a scratch file is created new with its contents, owner-only on POSIX", async () => {
  await inFolder(async (dir) => {
    const file = path.join(dir, "nested", scratchFileName("bug-description", ".md"));
    await writeScratchFile(file, "a long description\n");
    assert.equal(await readFile(file, "utf8"), "a long description\n");
    if (POSIX) assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test("a file already at the name is an error, and is left as it was", async () => {
  await inFolder(async (dir) => {
    const file = path.join(dir, "taken.md");
    await writeFile(file, "someone else's\n");
    await assert.rejects(writeScratchFile(file, "a description\n"), { code: "EEXIST" });
    assert.equal(await readFile(file, "utf8"), "someone else's\n");
  });
});

test("a link already at the name is an error: its target is neither written nor created", async (t) => {
  await inFolder(async (dir) => {
    const target = path.join(dir, "target.md");
    const nowhere = path.join(dir, "nowhere.md");
    await writeFile(target, "untouched\n");
    if (!(await linked(target, path.join(dir, "link.md"))) || !(await linked(nowhere, path.join(dir, "dangling.md")))) {
      t.skip("symbolic links need a privilege this account does not have");
      return;
    }
    await assert.rejects(writeScratchFile(path.join(dir, "link.md"), "a description\n"), { code: "EEXIST" });
    await assert.rejects(writeScratchFile(path.join(dir, "dangling.md"), "a description\n"), { code: "EEXIST" });
    assert.equal(await readFile(target, "utf8"), "untouched\n");
    await assert.rejects(lstat(nowhere), { code: "ENOENT" });
  });
});

test("removal takes a file, or a link and never its target; a file already gone is no error", async (t) => {
  await inFolder(async (dir) => {
    const file = path.join(dir, "used.md");
    await writeScratchFile(file, "done\n");
    await removeScratchFile(file);
    await assert.rejects(lstat(file), { code: "ENOENT" });
    await removeScratchFile(file);
    const target = path.join(dir, "target.md");
    await writeFile(target, "untouched\n");
    if (!(await linked(target, path.join(dir, "link.md")))) {
      t.skip("symbolic links need a privilege this account does not have");
      return;
    }
    await removeScratchFile(path.join(dir, "link.md"));
    await assert.rejects(lstat(path.join(dir, "link.md")), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), "untouched\n");
  });
});

test("F10: the payload file is named unpredictably, created owner-only, and gone afterwards", async () => {
  let file = "";
  let mode = -1;
  await runPayloadCommand(
    async (args) => {
      file = args[args.length - 1]!.split("=")[1]!;
      mode = (await stat(file)).mode & 0o777;
      return { ok: true, command: "fix-mode", warnings: [] };
    },
    { args: (payload) => ["fix-mode", "update", "my-mode", `--from-file=${payload}`], payload: { id: "my-mode" } },
    "bugpilot-fix-mode",
  );
  const match = /^bugpilot-fix-mode-(.+)\.json$/.exec(path.basename(file));
  assert.ok(match && UUID.test(match[1]!), file);
  assert.equal(path.dirname(file), tmpdir());
  if (POSIX) assert.equal(mode, 0o600);
  await assert.rejects(lstat(file), { code: "ENOENT" });
});
