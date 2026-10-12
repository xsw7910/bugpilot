/**
 * The Protected Rules as the panel shows them (0.1.4): read from `bugpilot
 * protected-rules show --json` — never a TypeScript copy — and refused when
 * the answer is not the read-only list it claims to be.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  PROTECTED_RULES_CAPABILITY,
  protectedRulesArgs,
  protectedRulesFromEnvelope,
  readsProtectedRules,
  runProtectedRules,
} from "../src/app/protectedRules.ts";

const payload = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  ok: true,
  command: "protected-rules",
  rules_version: 1,
  editable: false,
  source: "bugpilot",
  contract: ["BugPilot writes these rules into every task.md it prepares, word for word."],
  groups: [
    { id: "git-editing", title: "Git / Editing", rules: ["rule-a"] },
    { id: "jira", title: "Jira", rules: ["rule-b"] },
  ],
  rules: [
    { id: "rule-a", group: "git-editing", section: "BugPilot Safety Rules", title: "Rule A", text: "Text A." },
    { id: "rule-b", group: "jira", section: "BugPilot Safety Rules", title: "Rule B", text: "Text B." },
  ],
  sections: [],
  precedence: { layers: [{ position: 1, name: "BugPilot safety rules" }, { position: 2, name: "Repository context" }], rules: [] },
  warnings: [],
  ...overrides,
});

test("one read-only command line, and the capability by exact name", () => {
  assert.deepEqual(protectedRulesArgs(), ["protected-rules", "show", "--json"]);
  assert.equal(PROTECTED_RULES_CAPABILITY, "protected-rules");
  assert.equal(readsProtectedRules({ capabilities: ["protected-rules"] }), true);
  assert.equal(readsProtectedRules({ capabilities: ["protected-rule"] }), false);
});

test("the snapshot is the CLI's groups, rules, contract and precedence", () => {
  assert.deepEqual(protectedRulesFromEnvelope(payload()), {
    rulesVersion: 1,
    contract: ["BugPilot writes these rules into every task.md it prepares, word for word."],
    groups: [
      { id: "git-editing", title: "Git / Editing", rules: [{ id: "rule-a", title: "Rule A", text: "Text A.", section: "BugPilot Safety Rules" }] },
      { id: "jira", title: "Jira", rules: [{ id: "rule-b", title: "Rule B", text: "Text B.", section: "BugPilot Safety Rules" }] },
    ],
    precedence: ["BugPilot safety rules", "Repository context"],
  });
});

test("anything that is not the read-only list is refused", () => {
  assert.equal(protectedRulesFromEnvelope(payload({ editable: true })), undefined, "an editable list");
  assert.equal(protectedRulesFromEnvelope(payload({ rules_version: 0 })), undefined);
  assert.equal(protectedRulesFromEnvelope(payload({ groups: [{ id: "jira", title: "Jira", rules: ["missing"] }] })), undefined, "a group naming no rule");
  assert.equal(protectedRulesFromEnvelope(payload({ groups: [{ id: "jira", title: "Jira", rules: ["rule-a"] }] })), undefined, "a rule in another group");
  assert.equal(protectedRulesFromEnvelope(payload({ rules: [{ id: "rule-a", group: "git-editing", title: "", text: "x", section: "s" }] })), undefined);
});

test("no rule text is spelled in the extension's sources", () => {
  // The rules are the CLI's: a phrase from them in TypeScript would be a second copy.
  const sources = readdirSync(new URL("../src/app/", import.meta.url)).map((name) => readFileSync(new URL(`../src/app/${name}`, import.meta.url), "utf8")).join("\n");
  for (const phrase of ["Never force push, and never use", "Never reveal credentials or tokens.", "Do not delete files, and do not mass-format", "git reset --hard"]) {
    assert.equal(sources.includes(phrase), false, phrase);
  }
});

test("an old CLI is out of date, a failure says why, and a good answer is loaded", async () => {
  assert.deepEqual(await runProtectedRules(async () => ({ code: 2, stdout: "", stderr: "usage: bugpilot ...\nbugpilot: error: argument command: invalid choice: 'protected-rules'" })), { kind: "outdated" });
  assert.deepEqual(await runProtectedRules(async () => ({ code: 0, stdout: "not json", stderr: "" })).then((outcome) => outcome.kind), "failed");
  assert.equal((await runProtectedRules(async () => ({ code: 0, stdout: JSON.stringify(payload()), stderr: "" }))).kind, "loaded");
});
