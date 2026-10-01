/**
 * Collecting old, unreferenced pasted and dropped attachments (§37.100).
 *
 * Every test builds its own storage root under the OS temp folder; nothing here
 * touches VS Code's real global storage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ATTACHMENT_GC_RETENTION_DAYS,
  AttachmentReferenceRegistry,
  attachmentReferenceKey,
  collectAttachmentGarbage,
  describeGc,
  initializeAttachmentGc,
  runAttachmentGc,
} from "../src/app/attachmentStorage.ts";
import type { GcFileSystem, ReferenceMemento } from "../src/app/attachmentStorage.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - (ATTACHMENT_GC_RETENTION_DAYS + 5) * DAY;
const RECENT = NOW - 2 * DAY;
/** Reference tracking that began long ago: the migration grace is over. */
const TRACKED = NOW - 365 * DAY;
const DIGEST_A = "0123456789abcdef";
const DIGEST_B = "fedcba9876543210";

async function storage(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bugpilot-gc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A stored attachment, as `createAttachmentStore` lays one out, with the given age. */
async function blob(root: string, digest: string, name: string, mtime: number): Promise<string> {
  const directory = path.join(root, "attachments", digest);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, "bytes");
  await utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

function memento(): ReferenceMemento & { values: Map<string, unknown>; writes: number } {
  const values = new Map<string, unknown>();
  return {
    values,
    writes: 0,
    keys: () => [...values.keys()],
    get: (key) => values.get(key),
    update(key, value) {
      this.writes += 1;
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  };
}

function logger(): { lines: string[]; info(message: string): void; error(message: string): void } {
  const lines: string[] = [];
  return { lines, info: (message) => lines.push(message), error: (message) => lines.push(message) };
}

const NODE_FS: GcFileSystem = { lstat, readdir, realpath, rmdir, unlink };

/** Junctions need no privilege on Windows; a file link may. `undefined` means this machine cannot make one. */
async function tryLink(target: string, link: string, kind: "dir" | "file"): Promise<boolean> {
  try {
    await symlink(target, link, kind === "dir" && process.platform === "win32" ? "junction" : kind);
    return true;
  } catch {
    return false;
  }
}

// --- what is kept and what goes ------------------------------------------------

test("an old blob a form references is kept; an old one nobody references is removed", async (t) => {
  const root = await storage(t);
  const kept = await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const gone = await blob(root, DIGEST_B, "screenshot-2.png", OLD);
  const registry = new AttachmentReferenceRegistry(memento(), "ws", root);
  registry.record([kept]);

  const report = await runAttachmentGc({ storageRoot: root, registry, current: [], log: logger(), now: NOW, trackingSince: TRACKED });

  assert.ok(existsSync(kept));
  assert.ok(!existsSync(gone));
  assert.deepEqual(report, { scanned: 2, removed: 1, kept: 1, skipped: 0, unexpected: 0 });
});

test("the current form protects its blobs even before anything was recorded", async (t) => {
  const root = await storage(t);
  const file = await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const registry = new AttachmentReferenceRegistry(memento(), "ws", root);
  await runAttachmentGc({ storageRoot: root, registry, current: [file], log: logger(), now: NOW, trackingSince: TRACKED });
  assert.ok(existsSync(file));
});

test("an unreferenced blob younger than the retention period is kept", async (t) => {
  // An unapplied settings draft is recorded nowhere: its age is what protects it.
  const root = await storage(t);
  const file = await blob(root, DIGEST_A, "screenshot-1.png", RECENT);
  const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW });
  assert.ok(existsSync(file));
  assert.equal(report.removed, 0);
  assert.equal(ATTACHMENT_GC_RETENTION_DAYS, 30);
});

test("a blob two workspaces reference stays until neither does", async (t) => {
  const root = await storage(t);
  const file = await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const shared = memento();
  const first = new AttachmentReferenceRegistry(shared, "first", root);
  const second = new AttachmentReferenceRegistry(shared, "second", root);
  first.record([file]);
  second.record([file]);

  first.record([]);
  await collectAttachmentGarbage({ storageRoot: root, referenced: first.referenced([]), now: NOW });
  assert.ok(existsSync(file), "the second workspace still references it");

  second.record([]);
  await collectAttachmentGarbage({ storageRoot: root, referenced: second.referenced([]), now: NOW });
  assert.ok(!existsSync(file), "nobody references it now");
});

test("a digest folder left empty is removed; the attachments folder is not", async (t) => {
  const root = await storage(t);
  await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const keep = await blob(root, DIGEST_B, "a.png", OLD);
  await blob(root, DIGEST_B, "b.png", OLD);

  await collectAttachmentGarbage({ storageRoot: root, referenced: new Set([`${DIGEST_B}/a.png`]), now: NOW });

  assert.ok(!existsSync(path.join(root, "attachments", DIGEST_A)));
  assert.ok(existsSync(keep));
  assert.ok(existsSync(path.join(root, "attachments")));
  // And once the last one goes, the attachments folder still stays.
  await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW });
  assert.deepEqual(await readdir(path.join(root, "attachments")), []);
});

test("a missing attachments folder is nothing to do, and says nothing", async (t) => {
  const root = await storage(t);
  const log = logger();
  const report = await runAttachmentGc({
    storageRoot: root,
    registry: new AttachmentReferenceRegistry(memento(), "ws", root),
    current: [],
    log,
    now: NOW,
    trackingSince: TRACKED,
  });
  assert.deepEqual(report, { scanned: 0, removed: 0, kept: 0, skipped: 0, unexpected: 0 });
  assert.deepEqual(log.lines, []);
});

// --- only BugPilot's layout, only inside BugPilot's folder ----------------------

test("anything that is not attachments/<16 hex>/<file> is left alone", async (t) => {
  const root = await storage(t);
  const attachments = path.join(root, "attachments");
  const strays = [
    path.join(root, "bug-description.md"),
    path.join(attachments, "loose.png"),
    path.join(attachments, "ABCDEF0123456789", "upper.png"),
    path.join(attachments, "0123456789abcde", "short.png"),
    path.join(attachments, "not-a-digest", "x.png"),
    path.join(attachments, DIGEST_A, "nested", "deep.png"),
  ];
  for (const file of strays) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x");
    await utimes(file, OLD / 1000, OLD / 1000);
  }

  const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW });

  for (const file of strays) assert.ok(existsSync(file), path.relative(root, file));
  assert.equal(report.removed, 0);
  // loose.png, three badly named folders, and the folder inside the digest folder.
  assert.equal(report.unexpected, 5);
  // The digest folder still holds the nested one, so it stays.
  assert.ok(existsSync(path.join(attachments, DIGEST_A)));
});

test("a link cannot lead a collection outside the storage folder", async (t) => {
  const root = await storage(t);
  const outside = await storage(t);
  const victim = path.join(outside, DIGEST_B, "victim.png");
  await mkdir(path.dirname(victim), { recursive: true });
  await writeFile(victim, "keep me");
  await utimes(victim, OLD / 1000, OLD / 1000);

  // A digest folder that is a link to somewhere else.
  await mkdir(path.join(root, "attachments"), { recursive: true });
  if (await tryLink(path.join(outside, DIGEST_B), path.join(root, "attachments", DIGEST_B), "dir")) {
    const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW });
    assert.ok(existsSync(victim));
    assert.equal(report.unexpected, 1);
  }

  // A file inside a real digest folder that is a link to a file elsewhere.
  await mkdir(path.join(root, "attachments", DIGEST_A), { recursive: true });
  if (await tryLink(victim, path.join(root, "attachments", DIGEST_A, "link.png"), "file")) {
    await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW });
    assert.equal(readFileSync(victim, "utf8"), "keep me");
  }

  // The attachments folder itself a link: nothing beneath it is touched.
  const linkedRoot = await storage(t);
  if (await tryLink(outside, path.join(linkedRoot, "attachments"), "dir")) {
    const report = await collectAttachmentGarbage({ storageRoot: linkedRoot, referenced: new Set(), now: NOW });
    assert.ok(existsSync(victim));
    assert.deepEqual(report, { scanned: 0, removed: 0, kept: 0, skipped: 0, unexpected: 1 });
  }
});

test("a reference is only ever a file directly inside a digest folder of this storage", () => {
  const root = path.join(os.tmpdir(), "store");
  const inside = path.join(root, "attachments", DIGEST_A, "screenshot-1.png");
  assert.equal(attachmentReferenceKey(root, inside, false), `${DIGEST_A}/screenshot-1.png`);
  // Picked from disk: not ours to keep or collect.
  assert.equal(attachmentReferenceKey(root, path.join(os.tmpdir(), "logs", "crash.log"), false), undefined);
  // Traversal resolves before it is judged.
  assert.equal(attachmentReferenceKey(root, path.join(root, "attachments", DIGEST_A, "..", "..", "x.png"), false), undefined);
  assert.equal(attachmentReferenceKey(root, path.join(root, "attachments", DIGEST_A, "sub", "x.png"), false), undefined);
  assert.equal(attachmentReferenceKey(root, path.join(root, "attachments", "not-hex", "x.png"), false), undefined);
  assert.equal(attachmentReferenceKey(root, path.join(root, "attachments", DIGEST_A), false), undefined);
  // On Windows a path is the same file whatever its case.
  assert.equal(
    attachmentReferenceKey("C:\\Store", "c:\\store\\ATTACHMENTS\\0123456789abcdef\\Shot.PNG", true),
    `${DIGEST_A}/shot.png`,
  );
});

// --- failures cost one entry, never the activation ------------------------------

test("a blob that cannot be deleted is skipped, and the rest still go", async (t) => {
  const root = await storage(t);
  const locked = await blob(root, DIGEST_A, "locked.png", OLD);
  const free = await blob(root, DIGEST_B, "free.png", OLD);
  const fs: GcFileSystem = {
    ...NODE_FS,
    unlink: (async (file: string) => {
      if (String(file) === locked) throw Object.assign(new Error(`EBUSY: ${file}`), { code: "EBUSY" });
      return unlink(file);
    }) as GcFileSystem["unlink"],
  };

  const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW, fs });

  assert.ok(existsSync(locked));
  assert.ok(!existsSync(free));
  assert.equal(report.skipped, 1);
  assert.equal(report.removed, 1);
  // Its folder is not empty, so it stays.
  assert.ok(existsSync(path.dirname(locked)));
});

test("a blob rewritten by a paste between the two looks is kept", async (t) => {
  const root = await storage(t);
  const file = await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  let looks = 0;
  const fs: GcFileSystem = {
    ...NODE_FS,
    lstat: (async (target: string) => {
      if (String(target) === file && ++looks === 2) await utimes(file, NOW / 1000, NOW / 1000);
      return lstat(target);
    }) as GcFileSystem["lstat"],
  };
  const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW, fs });
  assert.ok(existsSync(file));
  assert.equal(report.removed, 0);
});

test("a collection that cannot run says so in one line and never throws", async (t) => {
  const root = await storage(t);
  await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const broken: ReferenceMemento = {
    keys: () => {
      throw Object.assign(new Error("state unavailable"), { code: "EBROKEN" });
    },
    get: () => undefined,
    update: () => Promise.resolve(),
  };
  const log = logger();
  const report = await runAttachmentGc({
    storageRoot: root,
    registry: new AttachmentReferenceRegistry(broken, "ws", root),
    current: [],
    log,
    now: NOW,
    trackingSince: TRACKED,
  });
  assert.equal(report, undefined);
  assert.deepEqual(log.lines, ["Attachment GC did not run (EBROKEN)."]);
  // And when nothing could decide what is referenced, nothing was removed.
  assert.ok(existsSync(path.join(root, "attachments", DIGEST_A, "screenshot-1.png")));
});

test("an unreadable attachments folder is skipped, not an error", async (t) => {
  const root = await storage(t);
  await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const fs: GcFileSystem = {
    ...NODE_FS,
    readdir: (async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }) as unknown as GcFileSystem["readdir"],
  };
  const report = await collectAttachmentGarbage({ storageRoot: root, referenced: new Set(), now: NOW, fs });
  assert.deepEqual(report, { scanned: 0, removed: 0, kept: 0, skipped: 1, unexpected: 0 });
});

// --- the reference record -------------------------------------------------------

test("each workspace records its own references, only when they change, and only BugPilot's", async (t) => {
  const root = await storage(t);
  const state = memento();
  const registry = new AttachmentReferenceRegistry(state, "ws", root);
  const stored = path.join(root, "attachments", DIGEST_A, "screenshot-1.png");
  const picked = path.join(os.tmpdir(), "logs", "crash.log");

  registry.record([stored, picked]);
  registry.record([stored, picked]);
  assert.equal(state.writes, 1, "an unchanged list is not written again");
  const [key] = state.keys();
  assert.match(key!, /^bugpilot\.attachmentReferences\.ws$/);
  // Keys, not paths: the record names no folder of anyone's.
  assert.deepEqual(state.get(key!), [attachmentReferenceKey(root, stored)]);

  registry.record([picked]);
  assert.deepEqual(state.keys(), [], "a form with no stored attachments leaves no record");
  // Other keys in global state are not references.
  state.values.set("bugpilot.lastAgent", ["0123456789abcdef/x.png"]);
  assert.deepEqual([...registry.referenced([])], []);
});

// --- what the log may say -------------------------------------------------------

test("the log line is counts only: no name, no digest, no path", async (t) => {
  const root = await storage(t);
  await blob(root, DIGEST_A, "customer-acme-invoice.png", OLD);
  await blob(root, DIGEST_B, "patient-record.txt", RECENT);
  await mkdir(path.join(root, "attachments", "stray-folder"));
  const log = logger();

  await runAttachmentGc({
    storageRoot: root,
    registry: new AttachmentReferenceRegistry(memento(), "ws", root),
    current: [],
    log,
    now: NOW,
    trackingSince: TRACKED,
  });

  assert.deepEqual(log.lines, ["Attachment GC scanned 2 blobs; removed 1; kept 1; left 1 unexpected entry alone."]);
  for (const secret of ["acme", "patient", DIGEST_A, DIGEST_B, "stray", root, os.tmpdir()]) {
    assert.ok(!log.lines.join("\n").includes(secret), secret);
  }
  assert.equal(
    describeGc({ scanned: 1, removed: 0, kept: 0, skipped: 1, unexpected: 0 }),
    "Attachment GC scanned 1 blob; removed 0; kept 0; skipped 1 unreadable or locked.",
  );
});

// --- the migration: one grace period for blobs from before tracking (§37.101) ---

const GC_STATE = "bugpilot.attachmentGcVersion";

/** A start-up as activation does it: record this workspace's saved form, then the GC state. */
async function startUp(state: ReturnType<typeof memento>, root: string, saved: readonly string[], now: number, log = logger()) {
  const registry = new AttachmentReferenceRegistry(state, "this-workspace", root);
  registry.record(saved);
  const trackingSince = await initializeAttachmentGc(state, now, log);
  return { registry, trackingSince, log };
}

test("the first start-up after the upgrade deletes no legacy blob, and records this workspace", async (t) => {
  const root = await storage(t);
  // Pasted months ago, before references were recorded: one in this workspace's
  // saved form, one only in a workspace nobody has opened since.
  const mine = await blob(root, DIGEST_A, "screenshot-1.png", OLD);
  const theirs = await blob(root, DIGEST_B, "screenshot-1.png", OLD);
  const state = memento();

  const { registry, trackingSince, log } = await startUp(state, root, [mine], NOW);
  const report = await runAttachmentGc({ storageRoot: root, registry, current: [mine], log, now: NOW, trackingSince });

  assert.equal(trackingSince, NOW);
  assert.deepEqual(state.get(GC_STATE), { version: 1, trackingSince: NOW });
  assert.deepEqual(state.get("bugpilot.attachmentReferences.this-workspace"), [`${DIGEST_A}/screenshot-1.png`]);
  assert.ok(existsSync(mine) && existsSync(theirs));
  assert.equal(report?.removed, 0);
  assert.equal(log.lines[0], "Attachment GC started tracking references; stored attachments are kept at least 30 days from now.");
});

test("a legacy blob becomes eligible only once the grace period after tracking began is over", async (t) => {
  const root = await storage(t);
  const theirs = await blob(root, DIGEST_B, "screenshot-1.png", OLD);
  const state = memento();
  const upgrade = NOW;
  await startUp(state, root, [], upgrade);

  // Every later start-up reads the same moment back.
  const day29 = await startUp(state, root, [], upgrade + 29 * DAY);
  assert.equal(day29.trackingSince, upgrade);
  await runAttachmentGc({ storageRoot: root, registry: day29.registry, current: [], log: logger(), now: upgrade + 29 * DAY, trackingSince: day29.trackingSince });
  assert.ok(existsSync(theirs), "still inside the grace period");

  const day31 = await startUp(state, root, [], upgrade + 31 * DAY);
  await runAttachmentGc({ storageRoot: root, registry: day31.registry, current: [], log: logger(), now: upgrade + 31 * DAY, trackingSince: day31.trackingSince });
  assert.ok(!existsSync(theirs), "the grace period is over and nobody registered it");
});

test("a workspace reopened during the grace period keeps its legacy blobs for good", async (t) => {
  const root = await storage(t);
  const theirs = await blob(root, DIGEST_B, "screenshot-1.png", OLD);
  const state = memento();
  await startUp(state, root, [], NOW);
  // Their window opens during the grace period and records its saved form.
  new AttachmentReferenceRegistry(state, "their-workspace", root).record([theirs]);

  const later = await startUp(state, root, [], NOW + 400 * DAY);
  await runAttachmentGc({ storageRoot: root, registry: later.registry, current: [], log: logger(), now: NOW + 400 * DAY, trackingSince: later.trackingSince });
  assert.ok(existsSync(theirs));
});

test("after the migration, an unreferenced blob written since tracking began ages normally", async (t) => {
  const root = await storage(t);
  const upgrade = NOW - 40 * DAY;
  // Written 31 days ago — after tracking began — and dropped from every form.
  const stale = await blob(root, DIGEST_A, "screenshot-1.png", NOW - 31 * DAY);
  const fresh = await blob(root, DIGEST_B, "screenshot-1.png", NOW - 10 * DAY);
  const state = memento();
  await startUp(state, root, [], upgrade);

  const today = await startUp(state, root, [], NOW);
  assert.equal(today.trackingSince, upgrade);
  await runAttachmentGc({ storageRoot: root, registry: today.registry, current: [], log: logger(), now: NOW, trackingSince: today.trackingSince });
  assert.ok(!existsSync(stale), "30 days from its own mtime, not from tracking + 30");
  assert.ok(existsSync(fresh));
});

test("the GC state survives a restart and is written once", async (t) => {
  const root = await storage(t);
  const state = memento();
  await startUp(state, root, [], NOW);
  const writes = state.writes;
  // A new extension host: a fresh registry and a later clock, the same global state.
  const restarted = await startUp(state, root, [], NOW + 5 * DAY);
  assert.equal(restarted.trackingSince, NOW);
  assert.equal(state.writes, writes, "nothing rewritten");
  assert.deepEqual(restarted.log.lines, [], "only the first start-up says tracking started");
});

test("an unreadable GC state starts the grace period over; a newer one turns collection off", async (t) => {
  const root = await storage(t);
  const theirs = await blob(root, DIGEST_B, "screenshot-1.png", OLD);
  for (const broken of ["yes", { version: 1 }, { version: 1, trackingSince: "long ago" }, { version: 0, trackingSince: 1 }]) {
    const state = memento();
    state.values.set(GC_STATE, broken);
    const { trackingSince } = await startUp(state, root, [], NOW);
    assert.equal(trackingSince, NOW, JSON.stringify(broken));
  }

  const state = memento();
  state.values.set(GC_STATE, { version: 2, trackingSince: 0 });
  const { registry, trackingSince, log } = await startUp(state, root, [], NOW);
  assert.equal(trackingSince, undefined);
  assert.deepEqual(state.get(GC_STATE), { version: 2, trackingSince: 0 }, "a newer build's state is not rewritten");
  assert.equal(await runAttachmentGc({ storageRoot: root, registry, current: [], log, now: NOW, trackingSince }), undefined);
  assert.ok(existsSync(theirs));
  assert.deepEqual(log.lines, ["Attachment GC is off: its state was written by a newer BugPilot."]);
});

test("a GC state that cannot be read or saved collects nothing and throws nothing", async (t) => {
  const root = await storage(t);
  const theirs = await blob(root, DIGEST_B, "screenshot-1.png", OLD);
  const failing = (how: "get" | "update" | "throw"): ReferenceMemento => ({
    keys: () => [],
    get: () => {
      if (how === "get") throw Object.assign(new Error("state unavailable"), { code: "EBROKEN" });
      return undefined;
    },
    update: () => {
      if (how === "throw") throw Object.assign(new Error("closed"), { code: "ECLOSED" });
      return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    },
  });
  for (const how of ["get", "update", "throw"] as const) {
    const log = logger();
    const state = failing(how);
    const registry = new AttachmentReferenceRegistry(state, "ws", root);
    // Recording does not throw into the activation that calls it either.
    assert.doesNotThrow(() => registry.record([theirs]));
    const trackingSince = await initializeAttachmentGc(state, NOW, log);
    assert.equal(trackingSince, undefined, how);
    assert.match(log.lines[0]!, /^Attachment GC state could not be saved \((EBROKEN|ENOSPC|ECLOSED)\); nothing is collected this session\.$/);
    assert.equal(await runAttachmentGc({ storageRoot: root, registry, current: [], log, now: NOW, trackingSince }), undefined);
    assert.ok(existsSync(theirs), how);
  }
});

test("a record that failed to write is written again on the next save", async () => {
  let fail = true;
  const values = new Map<string, unknown>();
  const state: ReferenceMemento = {
    keys: () => [...values.keys()],
    get: (key) => values.get(key),
    update: (key, value) => {
      if (fail) return Promise.reject(new Error("busy"));
      values.set(key, value);
      return Promise.resolve();
    },
  };
  const root = path.join(os.tmpdir(), "store");
  const stored = path.join(root, "attachments", DIGEST_A, "screenshot-1.png");
  const registry = new AttachmentReferenceRegistry(state, "ws", root);
  registry.record([stored]);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  registry.record([stored]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(values.get("bugpilot.attachmentReferences.ws"), [`${DIGEST_A}/screenshot-1.png`]);
});

// --- when it runs ---------------------------------------------------------------

test("activation collects once, deferred, and records references wherever the form is saved", () => {
  const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  // One collection, from one timer, cancelled with the rest of activation.
  assert.equal(source.match(/runAttachmentGc\(/g)?.length, 1);
  assert.match(source, /const collect = setTimeout\(/);
  assert.match(source, /clearTimeout\(collect\)/);
  assert.doesNotMatch(source, /setInterval/);
  // The migration clock starts at activation, before the deferred pass.
  assert.ok(source.indexOf("initializeAttachmentGc(context.globalState") < source.indexOf("const collect = setTimeout("));
  assert.match(source, /attachmentGcTracking\.then\(\(trackingSince\) =>/);
  // Every save of the form records what it references.
  assert.match(source, /saveForm: \(form\) => \{[^}]*attachmentReferences\.record\(form\.attachments\)/);
  // The controller — where pastes arrive — never collects.
  const controller = readFileSync(new URL("../src/app/controller.ts", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /attachmentStorage|runAttachmentGc|collectAttachmentGarbage/);
});
