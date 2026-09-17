/**
 * Nothing is exported without being used, unless someone said why.
 *
 * The TypeScript half of `tests/test_no_unwired_symbols.py`. Two of the four
 * "built a guard and never wired it" defects in this project were on this side:
 * `assertNoSecretsInArgs` had no caller for two phases, and the promised
 * re-check of a command id against COMMANDS did not exist at all — which also
 * left every button on the install wizard dead.
 *
 * Production and test references are counted separately, because an export used
 * only by its own tests is exactly that shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXTENSION = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/**
 * Exports with no production consumer, each with the reason.
 *
 * Adding a line here is a decision; leaving one out is a failing test.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "extension.ts:activate":
    "Called by VS Code itself through the manifest's `main`, which no source file can reference.",
  "extension.ts:deactivate": "Same: the host calls it, nothing here does.",
  "errors.ts:knownCodes":
    "Exists so the cross-language test can compare this table against bugpilot/core/errors.py.",
  "html.ts:TEXT_FIELD_IDS":
    "A guard export: test/panel.test.ts compares the document's fields against FormState.",
  "html.ts:PLAN_CHECKBOX_IDS": "Same, for the plan checkboxes.",
  "commands.ts:HIDDEN_FROM_PALETTE":
    "A guard export: the manifest test checks these are hidden from the command palette.",
  "messages.ts:WORKFLOW_CHECKBOX_IDS":
    "A guard export: the checkbox id per workflow step, compared against the document.",
  "html.ts:ADVANCED_FIELD_IDS":
    "A guard export: test/panel.test.ts checks each of these is inside the collapsed section and not above Run.",
};

const EXPORTED =
  /^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".mjs") ? [full] : [];
  });
}

/**
 * Comments removed before counting.
 *
 * A name mentioned in a comment would count as a use and make this guard
 * lenient in exactly the case it exists for — a symbol everyone talks about and
 * nobody calls. (This is the third file scanner in the project to need it; the
 * colour scan and the nonce scan hit the same thing.)
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function sources(...directories: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const file of walk(path.join(EXTENSION, directory))) {
      files.set(file, stripComments(readFileSync(file, "utf8")));
    }
  }
  return files;
}

function references(name: string, files: Map<string, string>, skip?: string): number {
  const pattern = new RegExp(`\\b${name}\\b`, "g");
  let total = 0;
  for (const [file, text] of files) {
    const hits = text.match(pattern)?.length ?? 0;
    total += file === skip ? Math.max(hits - 1, 0) : hits;
  }
  return total;
}

test("every export has a production consumer or a recorded reason", () => {
  const production = sources("src");
  const elsewhere = sources("test", "test-integration", "scripts");

  const unwired: string[] = [];
  for (const [file, text] of production) {
    for (const match of text.matchAll(EXPORTED)) {
      const name = match[1]!;
      const key = `${path.basename(file)}:${name}`;
      if (key in ALLOWED) continue;
      if (references(name, production, file) > 0) continue;
      const inTests = references(name, elsewhere);
      unwired.push(`${key} — ${inTests ? "used only by tests" : "referenced nowhere at all"}`);
    }
  }

  assert.deepEqual(
    unwired,
    [],
    `no production consumer. Wire it in, delete it, or add it to ALLOWED with the reason:\n  ${unwired.join("\n  ")}`,
  );
});

test("the allowlist itself stays honest", () => {
  // An entry that has since acquired a consumer should leave the list, or the
  // allowlist becomes where stale exemptions accumulate and the guard quietly
  // stops guarding.
  const production = sources("src");
  const stale: string[] = [];
  for (const key of Object.keys(ALLOWED)) {
    const [basename, name] = key.split(":") as [string, string];
    const defining = [...production.keys()].find((file) => path.basename(file) === basename);
    if (!defining) {
      stale.push(`${key} is on the allowlist but its file is gone`);
      continue;
    }
    if (references(name, production, defining) > 0) {
      stale.push(`${key} now has a production consumer and can leave ALLOWED`);
    }
  }
  assert.deepEqual(stale, []);
});
