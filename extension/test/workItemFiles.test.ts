/**
 * O-1: reading a work item's files never goes through a link — against a real file system.
 *
 * A link can stand at `work`, at a work item's folder or at a file in it (and a junction can
 * be made there on Windows). Each test builds a repository and an "outside" folder in a temporary directory, with
 * a synthetic sentinel outside: a refused read must say nothing of it, and name no absolute path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkItemRefusal, listWorkItemFolder, readWorkItemFile, workItemFileState } from "../src/app/workItemFiles.ts";

const POSIX = process.platform !== "win32";
const ID = "JR-12345";
const SENTINEL = "o1-extension-outside-sentinel-7c3e";

interface Layout {
  readonly tmp: string;
  readonly root: string;
  readonly item: string;
  readonly outside: string;
  readonly secret: string;
}

async function inRepository(body: (layout: Layout) => Promise<void>): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "bugpilot-o1-test-"));
  try {
    const root = path.join(tmp, "repo");
    const item = path.join(root, "work", ID);
    const outside = path.join(tmp, "outside");
    await mkdir(item, { recursive: true });
    await mkdir(outside);
    const secret = path.join(outside, "notes.md");
    await writeFile(secret, `# ${SENTINEL}\n`, "utf8");
    await body({ tmp, root, item, outside, secret });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const folderOf = (layout: Layout) => ({ base: layout.root, workItemId: ID });

async function linkFile(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at);
    return true;
  } catch {
    return false;
  }
}

/** A directory link that needs no privilege: a junction on Windows, a symbolic link elsewhere. */
async function linkFolder(target: string, at: string): Promise<void> {
  await symlink(target, at, POSIX ? "dir" : "junction");
}

async function refused(promise: Promise<unknown>, layout: Layout): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkItemRefusal, `not a refusal: ${String(error)}`);
    assert.equal(error.message.includes(SENTINEL), false, "the refusal said something of the outside file");
    assert.equal(error.message.includes(layout.tmp), false, "the refusal named an absolute path");
    return error.message;
  }
  assert.fail("the read was not refused");
}

test("a regular file reads exactly as readFile reads it", async () => {
  await inRepository(async (layout) => {
    const file = path.join(layout.item, "fix_report.md");
    await writeFile(file, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("## Summary\r\n\r\nfixed "), 0xff, ...Buffer.from(" it\n")]));
    assert.equal(await readWorkItemFile(file, folderOf(layout)), await readFile(file, "utf8"));
    assert.equal(await workItemFileState(file, folderOf(layout)), "file");
  });
});

test("nothing there reads as undefined: no file, no work item folder, no work folder", async () => {
  await inRepository(async (layout) => {
    assert.equal(await readWorkItemFile(path.join(layout.item, "context.md"), folderOf(layout)), undefined);
    assert.equal(await workItemFileState(path.join(layout.item, "context.md"), folderOf(layout)), "missing");
    await rm(path.join(layout.root, "work"), { recursive: true });
    assert.equal(await readWorkItemFile(path.join(layout.item, "context.md"), folderOf(layout)), undefined);
    assert.deepEqual(await listWorkItemFolder(layout.item, folderOf(layout)), { kind: "missing" });
  });
});

test("a link at the file is refused, whether or not its target exists", async (t) => {
  await inRepository(async (layout) => {
    const file = path.join(layout.item, "context.md");
    if (!(await linkFile(layout.secret, file))) {
      t.skip("symbolic links to files need a privilege this account does not have");
      return;
    }
    const message = await refused(readWorkItemFile(file, folderOf(layout)), layout);
    assert.match(message, /^BugPilot will not read work\/JR-12345\/context\.md: it is a symbolic link or junction\./);
    await refused(workItemFileState(file, folderOf(layout)), layout);
    const dangling = path.join(layout.item, "issue.json");
    assert.ok(await linkFile(path.join(layout.outside, "missing.json"), dangling));
    await refused(readWorkItemFile(dangling, folderOf(layout)), layout);
  });
});

test("a link or junction at the work item folder, or at work, is refused, and the listing is unreadable", async () => {
  for (const at of ["work-item", "work"] as const) {
    await inRepository(async (layout) => {
      const elsewhere = path.join(layout.tmp, "elsewhere", ID);
      await mkdir(elsewhere, { recursive: true });
      await writeFile(path.join(elsewhere, "context.md"), `${SENTINEL}\n`, "utf8");
      if (at === "work-item") {
        await rm(layout.item, { recursive: true });
        await linkFolder(elsewhere, layout.item);
      } else {
        await rm(path.join(layout.root, "work"), { recursive: true });
        await linkFolder(path.dirname(elsewhere), path.join(layout.root, "work"));
      }
      const file = path.join(layout.item, "context.md");
      const message = await refused(readWorkItemFile(file, folderOf(layout)), layout);
      assert.match(message, /work\/JR-12345, or the folder above it, is a symbolic link or junction/);
      await refused(workItemFileState(file, folderOf(layout)), layout);
      const listing = await listWorkItemFolder(layout.item, folderOf(layout));
      assert.equal(listing.kind, "unreadable");
      assert.equal(listing.kind === "unreadable" && listing.detail.includes(SENTINEL), false);
    });
  }
});

test("a folder at a file's name is not a regular file, and is refused", async () => {
  await inRepository(async (layout) => {
    const file = path.join(layout.item, "context.md");
    await mkdir(file);
    assert.match(await refused(readWorkItemFile(file, folderOf(layout)), layout), /context\.md: it is not a regular file/);
  });
});

test("a FIFO is refused without blocking", { skip: POSIX ? false : "FIFOs are POSIX" }, async () => {
  await inRepository(async (layout) => {
    const file = path.join(layout.item, "fix_report.md");
    execFileSync("mkfifo", [file]);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("a read blocked on a FIFO")), 5000);
    });
    try {
      const message = await Promise.race([refused(readWorkItemFile(file, folderOf(layout)), layout), timeout]);
      assert.match(message, /it is not a regular file/);
    } finally {
      clearTimeout(timer);
    }
  });
});

test("a file over the limit is refused before it is decoded; one at the limit is read", async () => {
  await inRepository(async (layout) => {
    const file = path.join(layout.item, "fix_report.md");
    await writeFile(file, "x".repeat(11), "utf8");
    assert.match(await refused(readWorkItemFile(file, folderOf(layout), 10), layout), /larger than the 10 bytes/);
    await writeFile(file, "x".repeat(10), "utf8");
    assert.equal(await readWorkItemFile(file, folderOf(layout), 10), "x".repeat(10));
  });
});

test("a file outside the work item's folder is refused", async () => {
  await inRepository(async (layout) => {
    const file = path.join(layout.root, "README.md");
    await writeFile(file, "readme\n", "utf8");
    assert.match(await refused(readWorkItemFile(file, folderOf(layout)), layout), /not in this work item's folder/);
  });
});

test("the listing names regular files only, never a link, a folder or what a link points at", async () => {
  await inRepository(async (layout) => {
    await writeFile(path.join(layout.item, "context.md"), "# Context\n", "utf8");
    await writeFile(path.join(layout.item, "task.md"), "# Task\n", "utf8");
    await mkdir(path.join(layout.item, "attachments"));
    await linkFolder(layout.outside, path.join(layout.item, "linked-folder"));
    await linkFile(layout.secret, path.join(layout.item, "linked.md")); // listed or not, never named: see below
    const listing = await listWorkItemFolder(layout.item, folderOf(layout));
    assert.equal(listing.kind, "ok");
    assert.deepEqual(listing.kind === "ok" ? [...listing.names].sort() : [], ["context.md", "task.md"]);
  });
});
