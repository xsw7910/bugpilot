import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  COMMANDS,
  HIDDEN_FROM_PALETTE,
  HISTORY_ITEM_CONTEXT,
  SETTINGS,
  VIEWS,
  workItemFromTree,
} from "../src/commands.ts";

/**
 * The manifest is a contract with VS Code that no typechecker sees, so it gets
 * the same treatment as the cross-language error table: read the real file and
 * compare it against the code in both directions.
 */
/**
 * The company identifiers, from the same gitignored file the Python guard
 * reads. Empty when the file is absent, which is what a fork sees.
 */
function forbiddenWords(): string[] {
  const list = new URL("../../tests/forbidden_words.txt", import.meta.url);
  if (!existsSync(list)) return [];
  return readFileSync(list, "utf8")
    .split("\n")
    .map((line) => (line.split("#")[0] ?? "").trim().toLowerCase())
    .filter(Boolean);
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  main: string;
  icon: string;
  publisher: string;
  license: string;
  engines: Record<string, string>;
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { properties: Record<string, { type: string; default?: unknown }> };
    views: Record<string, { id: string; name: string; type?: string }[]>;
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
  devDependencies: Record<string, string>;
};

test("every command in the code is contributed by the manifest", () => {
  // An id missing from `contributes` is invisible in the command palette and
  // fails with VS Code's unhelpful "command not found" when a button calls it.
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of Object.values(COMMANDS)) {
    assert.ok(contributed.has(command), `${command} is not in contributes.commands`);
  }
});

test("every contributed command exists in the code", () => {
  // The other direction catches the leftover: a command removed from the code
  // but still offered in the palette, which throws when picked.
  const declared = new Set<string>(Object.values(COMMANDS));
  for (const entry of manifest.contributes.commands) {
    assert.ok(declared.has(entry.command), `${entry.command} is contributed but not registered`);
  }
});

test("commands are grouped under one palette category with real titles", () => {
  for (const entry of manifest.contributes.commands) {
    assert.equal(entry.category, "BugPilot");
    assert.notEqual(entry.title.trim(), "");
    // The category supplies the prefix; repeating it reads as "BugPilot: BugPilot: …".
    assert.ok(!entry.title.startsWith("BugPilot"), `${entry.command} repeats the category`);
  }
});

test("the settings key the code reads is the one the manifest declares", () => {
  const key = `${SETTINGS.section}.${SETTINGS.executablePath}`;
  const property = manifest.contributes.configuration.properties[key];
  assert.ok(property, `${key} is not declared in contributes.configuration`);
  assert.equal(property.type, "string");
  // Empty, not "bugpilot": the code treats blank as "resolve through PATH", and
  // a default of "bugpilot" would make "configured" indistinguishable from it.
  assert.equal(property.default, "");
});

test("the packaged entry point is built JavaScript, not a TypeScript source", () => {
  // The extension host loads `main` with require() on a Node far older than the
  // 22.18 that made type stripping the default. Pointing this at a .ts file
  // produces an extension that cannot activate at all.
  assert.match(manifest.main, /\.js$/);
  assert.match(manifest.main, /^\.\/out\//);
});

test("the declared VS Code API level matches the installed types", () => {
  // Types newer than the engine let code call an API the minimum version does
  // not have, which fails only on the user's older editor.
  assert.equal(manifest.engines["vscode"], manifest.devDependencies["@types/vscode"]);
});


test("the views the code registers are the ones the manifest declares", () => {
  const declared = manifest.contributes.views["bugpilot"] ?? [];
  assert.deepEqual(
    declared.map((view) => view.id).sort(),
    Object.values(VIEWS).sort(),
  );
  // The panel is the webview; the other two are native trees, which is the
  // split §5.3 settled on.
  assert.equal(declared.find((view) => view.id === VIEWS.panel)?.type, "webview");
  assert.equal(declared.find((view) => view.id === VIEWS.artifacts)?.type, undefined);
});

test("the activity bar icon exists on disk", () => {
  // A missing icon is not a startup error; the container simply renders blank,
  // which is a bug report waiting to happen.
  const icon = manifest.contributes.viewsContainers.activitybar[0]?.icon;
  assert.ok(icon, "no activity bar icon declared");
  assert.ok(
    existsSync(new URL(`../${icon}`, import.meta.url)),
    `${icon} is declared but not present`,
  );
});

test("tree-only commands are hidden from the command palette", () => {
  // Both take an argument from the tree item that invoked them; from the
  // palette they would run with undefined and do nothing visible.
  const hidden = (manifest.contributes.menus["commandPalette"] ?? []).filter(
    (entry) => entry.when === "false",
  );
  assert.deepEqual(
    hidden.map((entry) => entry.command).sort(),
    [...HIDDEN_FROM_PALETTE].sort(),
  );
});

test("the History context menu matches the value the tree actually sets", () => {
  // A `when` clause that names a contextValue nothing sets produces no menu and
  // no error — the failure is a right-click that does nothing.
  const entries = manifest.contributes.menus["view/item/context"] ?? [];
  assert.ok(entries.length >= 4, `expected a History menu, found ${entries.length} entries`);
  for (const entry of entries) {
    assert.equal(
      entry.when,
      `view == ${VIEWS.history} && viewItem == ${HISTORY_ITEM_CONTEXT}`,
      `${entry.command} targets something else`,
    );
  }
});

test("every command in that menu is one the extension registers", () => {
  const declared = new Set<string>(Object.values(COMMANDS));
  for (const entry of manifest.contributes.menus["view/item/context"] ?? []) {
    assert.ok(declared.has(entry.command), `${entry.command} is in a menu but not registered`);
  }
});

test("the destructive one is in a group of its own", () => {
  // Clean deletes a work item's artifacts, including anything an agent wrote.
  // Sitting next to Open in the same group is how it gets clicked by accident.
  const entries = manifest.contributes.menus["view/item/context"] ?? [];
  const clean = entries.find((entry) => entry.command === COMMANDS.clean);
  assert.ok(clean, "Clean is not in the History menu");
  const others = entries.filter((entry) => entry.command !== COMMANDS.clean);
  const group = (value: string | undefined) => (value ?? "").split("@")[0];
  for (const entry of others) {
    assert.notEqual(group(entry.group), group(clean.group), `${entry.command} shares Clean's group`);
  }
});

test("only a tree node names the work item a command acts on", () => {
  // The lenient version of this — accepting a bare string — would let any
  // caller tell `bugpilot.clean` which directory to delete.
  assert.equal(workItemFromTree({ workItemId: "JR-1" }), "JR-1");
  for (const argument of [undefined, null, "JR-1", 7, [], {}, { workItemId: "" }, { workItemId: 7 }]) {
    assert.equal(workItemFromTree(argument), undefined, JSON.stringify(argument) ?? "undefined");
  }
});

test("the Marketplace icon is a PNG big enough for the Marketplace", () => {
  // Three separate rules, and only the first is one vsce enforces: it refuses
  // an SVG, but it will happily ship a 16px icon that looks like a mistake on
  // the extension page.
  assert.match(manifest.icon, /\.png$/, "vsce refuses an SVG as an icon");
  const file = new URL(`../${manifest.icon}`, import.meta.url);
  assert.ok(existsSync(file), `${manifest.icon} is declared but not present`);

  // IHDR is the first chunk of every PNG: 8 bytes of signature, 4 of length,
  // 4 of type, then width and height as big-endian 32-bit integers.
  const bytes = readFileSync(file);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "not a PNG whatever the extension says",
  );
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height, "the Marketplace crops a non-square icon");
  assert.ok(width >= 128, `${width}px is below the 128px minimum`);
});

test("the activity bar icon and the Marketplace icon are different files", () => {
  // They have different jobs and different rules: the activity bar one is a
  // single-colour SVG the editor tints, and the Marketplace one is a full
  // colour PNG. Confusing them is how one of them ends up wrong.
  const activityBar = manifest.contributes.viewsContainers.activitybar[0];
  assert.ok(activityBar, "no activity bar container is contributed");
  assert.notEqual(manifest.icon, activityBar.icon);
  assert.match(activityBar.icon, /\.svg$/);
});

test("the manifest names a publisher, and not a company", () => {
  // The identity is a decision, not a leftover: this extension is published
  // under a personal publisher, and a company id was in this field until the
  // decision was made. The Python side has the same guard over its package.
  //
  // The words are read from `tests/forbidden_words.txt`, which is gitignored,
  // because writing them here would put a company's name in a public
  // repository in order to check that it is not in a published artifact. No
  // list, no check — and `test_publishable.py` is where that is noticed.
  assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]*$/i, "vsce requires an id, not a name");
  const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  for (const word of forbiddenWords()) {
    assert.equal(
      text.toLowerCase().includes(word),
      false,
      `the manifest names a company; publishing identity is a decision that has to stay made`,
    );
  }
});

test("the licence is a file the extension page can link to", () => {
  // `UNLICENSED` was the old value and it says "no rights granted at all",
  // which is the wrong thing to tell someone installing from the Marketplace:
  // they need permission to *use* it. vsce only ships a License asset for the
  // `SEE LICENSE IN` form, so this is also what makes the page link work.
  assert.equal(manifest.license, "SEE LICENSE IN LICENSE.txt");
  const file = new URL("../LICENSE.txt", import.meta.url);
  assert.ok(existsSync(file), "the manifest names a licence file that is not there");

  const text = readFileSync(file, "utf8");
  // The four things this file exists to do.
  assert.match(text, /free of charge/, "no grant of use");
  // Matched loosely on purpose: the file is wrapped prose, so a phrase that
  // spans a line break must not fail a guard about what the licence *says*.
  assert.match(text, /Future versions may not be free/, "no room to charge later");
  assert.match(text, /paid licence/);
  assert.match(text, /may not redistribute/, "no restriction on redistribution");
  assert.match(text, /WITHOUT WARRANTY OF ANY KIND/, "no warranty disclaimer");
  // CC BY 4.0 asks for attribution wherever the font is redistributed, and a
  // proprietary licence must not appear to override it.
  assert.match(text, /codicons/);
  assert.match(text, /CC BY 4\.0/);
});
