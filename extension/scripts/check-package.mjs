/**
 * Check what would actually ship in the .vsix.
 *
 * A packaging mistake is invisible until someone installs the result: a missing
 * `media/panel.js` gives them a blank panel, a missing `out/extension.js` gives
 * them an extension that never activates, and a stale `out/` gives them the
 * version you compiled an hour ago.
 *
 * The file list comes from `vsce ls`, so this is the real archive rather than a
 * guess, and it is checked in three directions:
 *
 *  1. everything the extension cannot run without is present;
 *  2. nothing outside the allowlist is present — this replaced a blocklist that
 *     rotted the moment `test-integration/` was added, matched none of its
 *     patterns, and shipped inside the extension;
 *  3. every built file is newer than the source it came from.
 *
 * Run with: npm run package   (which builds and packages first)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const manifest = require("../package.json");
const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** The file list `vsce` would put in the archive, as posix-style paths. */
function packagedFiles() {
  // vsce's own entry script, run by this Node: going through `npx` means
  // spawning a `.cmd` shim on Windows, which needs a shell and fails without
  // one. The dependency is already installed, so ask it directly.
  const vsce = require.resolve("@vscode/vsce/vsce");
  const output = execFileSync(process.execPath, [vsce, "ls", "--no-dependencies"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line !== "");
}

/** Every file under a directory, relative to `root`, posix-style. */
function walk(directory) {
  const results = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) results.push(...walk(relative));
    else results.push(relative);
  }
  return results;
}

const files = packagedFiles();
assert.ok(files.length > 0, "vsce ls listed nothing");

// --- 1. what must be there -------------------------------------------------

const required = [
  "package.json",
  "README.md",
  // Both were present in the working tree and absent from the archive, because
  // `.vscodeignore` is an allowlist: a new file at the root is excluded by
  // default. The changelog shipped as nothing for one build before this line
  // existed, and the Marketplace would have shown an empty Changelog tab.
  "CHANGELOG.md",
  // Named by `license` in the manifest, and the file the extension page's
  // License link points at.
  "LICENSE.txt",
  // The entry point the extension host requires.
  manifest.main.replace(/^\.\//, ""),
  // The activity bar icon: a missing one renders as a blank container.
  manifest.contributes.viewsContainers.activitybar[0].icon,
  // The Marketplace icon. Declared but absent is a hard vsce failure, so this
  // is really about the other order: shipping without it means a grey tile.
  manifest.icon,
  // The page assets. Without these the panel opens empty, with no error
  // anywhere — the CSP simply blocks nothing and there is nothing to load.
  "media/panel.js",
  "media/panel.css",
  // The icon font. Without it every status and action icon renders as a
  // tofu box, which looks like a broken extension rather than a missing file.
  "media/codicons/codicon.css",
  "media/codicons/codicon.ttf",
  // CC BY 4.0 asks for attribution wherever the font is redistributed, and the
  // .vsix is a redistribution.
  "media/codicons/ATTRIBUTION.md",
];

for (const file of required) {
  assert.ok(files.includes(file), `${file} is missing from the package`);
}

// --- 2. nothing else -------------------------------------------------------

/** The only things a .vsix of this extension may contain. */
const allowed = [
  /^package\.json$/,
  /^README\.md$/i,
  /^CHANGELOG\.md$/i,
  /^LICENSE\.txt$/i,
  /^out\//,
  /^media\//,
];

for (const file of files) {
  assert.ok(
    allowed.some((pattern) => pattern.test(file)),
    `${file} is packaged but not on the allowlist — add it to .vscodeignore, or here if it belongs`,
  );
}

// --- 3. the built output is current ----------------------------------------

// The packaging mistake with the longest debugging time: the extension runs,
// and behaves like the version from before your last edit. Every source file
// must have a build output that is newer than it.
const stale = [];
for (const source of walk("src").filter((file) => file.endsWith(".ts"))) {
  const built = source.replace(/^src\//, "out/").replace(/\.ts$/, ".js");
  if (!files.includes(built)) {
    assert.fail(`${source} has no built counterpart at ${built}`);
  }
  if (statSync(path.join(root, source)).mtimeMs > statSync(path.join(root, built)).mtimeMs) {
    stale.push(source);
  }
}
assert.deepEqual(stale, [], `edited since the last build: ${stale.join(", ")} — run npm run build`);

const outFiles = files.filter((file) => file.startsWith("out/") && file.endsWith(".js"));
console.log(
  `package ok: ${files.length} files, ${outFiles.length} of them built JavaScript, all current`,
);
