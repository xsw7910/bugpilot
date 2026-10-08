/**
 * Project settings, as the panel holds them (pre-release Batch 3): the form's
 * copy of `.bugpilot/project_settings.json`, the CLI's answer read as untrusted
 * input, and the constants the two languages share.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_FORM } from "../src/app/form.ts";
import {
  DEFAULT_BRANCH_TEMPLATE,
  MAX_BRANCH_TEMPLATE_CHARS,
  VERIFICATION_FIELDS,
  formWithProjectSettings,
  projectSettingsArgs,
  projectSettingsFromEnvelope,
  projectSettingsOfForm,
  runProjectSettings,
  sameProjectSettings,
} from "../src/app/projectSettings.ts";

const PYTHON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bugpilot", "core");

test("the switches, their defaults, the default name and the template limit are the CLI's", () => {
  const settings = readFileSync(path.join(PYTHON, "project_settings.py"), "utf8");
  const keys = [...settings.matchAll(/\("([a-z_]+)", (True|False)\),/g)].map((match) => [match[1], match[2] === "True"]);
  assert.deepEqual(keys, VERIFICATION_FIELDS.map((entry) => [entry.key, entry.default]));
  assert.match(settings, new RegExp(`DEFAULT_BRANCH_TEMPLATE_LABEL = "${DEFAULT_BRANCH_TEMPLATE.replace(/[{}]/g, "\\$&")}"`));
  const gitOps = readFileSync(path.join(PYTHON, "git_ops.py"), "utf8");
  assert.match(gitOps, new RegExp(`^MAX_BRANCH_TEMPLATE_CHARS = ${MAX_BRANCH_TEMPLATE_CHARS}$`, "m"));
});

test("the defaults are the file's defaults: nothing to save for a fresh form", () => {
  assert.deepEqual(projectSettingsOfForm(DEFAULT_FORM), {
    verification: { relevant_tests: true, static_checks: true, full_suite: false, report_not_run: true },
    branch_naming: { template: "" },
  });
});

test("a template counts only while Custom is chosen, and its text survives a switch", () => {
  const custom = { ...DEFAULT_FORM, branchNaming: "custom" as const, branchTemplate: "  bugfix/{issue}-{slug} " };
  assert.equal(projectSettingsOfForm(custom).branch_naming.template, "bugfix/{issue}-{slug}");
  const back = { ...custom, branchNaming: "default" as const };
  assert.equal(projectSettingsOfForm(back).branch_naming.template, "");
  assert.equal(sameProjectSettings(back, projectSettingsOfForm(DEFAULT_FORM)), true);

  // The file's default name keeps the form's text, so Custom again finds it.
  const loaded = formWithProjectSettings(custom, projectSettingsOfForm(DEFAULT_FORM));
  assert.equal(loaded.branchNaming, "default");
  assert.equal(loaded.branchTemplate, "  bugfix/{issue}-{slug} ");
  const fromFile = formWithProjectSettings(DEFAULT_FORM, {
    verification: { relevant_tests: false, static_checks: true, full_suite: true, report_not_run: true },
    branch_naming: { template: "fix/{issue}" },
  });
  assert.equal(fromFile.branchNaming, "custom");
  assert.equal(fromFile.branchTemplate, "fix/{issue}");
  assert.equal(fromFile.verifyRelevantTests, false);
  assert.equal(fromFile.verifyFullSuite, true);
});

test("the CLI's answer is read as untrusted input", () => {
  const snapshot = projectSettingsFromEnvelope({
    ok: true,
    settings: {
      verification: { relevant_tests: "yes", static_checks: false, full_suite: true },
      branch_naming: { template: `fix/{issue}${"x".repeat(200)}` },
    },
    saved: true,
    warnings: ["one", 2, null],
  })!;
  // A switch that is not a boolean is its default; a missing one too.
  assert.deepEqual(snapshot.settings.verification, { relevant_tests: true, static_checks: false, full_suite: true, report_not_run: true });
  assert.equal(snapshot.settings.branch_naming.template.length, MAX_BRANCH_TEMPLATE_CHARS);
  assert.deepEqual(snapshot.warnings, ["one"]);
  assert.equal(snapshot.saved, true);
  for (const broken of [{ ok: false, settings: {} }, { ok: true }, { ok: true, settings: [] }, null, "x"]) {
    assert.equal(projectSettingsFromEnvelope(broken), undefined);
  }
});

test("show, and set from a temporary file that is gone afterwards; an old CLI is out of date", async () => {
  assert.deepEqual([...projectSettingsArgs()], ["project-settings", "show"]);
  const seen: (readonly string[])[] = [];
  let payloadFile = "";
  const outcome = await runProjectSettings(
    async (args) => {
      seen.push(args);
      const flag = args.find((arg) => arg.startsWith("--from-file="));
      if (flag) {
        payloadFile = flag.slice("--from-file=".length);
        const sent = JSON.parse(readFileSync(payloadFile, "utf8"));
        assert.deepEqual(sent.branch_naming, { template: "fix/{issue}" });
      }
      return { code: 0, stderr: "", stdout: `${JSON.stringify({ schema_version: 1, ok: true, command: "project-settings", settings: { verification: {}, branch_naming: { template: "fix/{issue}" } }, saved: true, warnings: [] })}\n` };
    },
    { verification: { relevant_tests: true, static_checks: true, full_suite: false, report_not_run: true }, branch_naming: { template: "fix/{issue}" } },
  );
  assert.equal(outcome.kind, "loaded");
  assert.equal(seen[0]![0], "project-settings");
  assert.equal(seen[0]!.at(-1), "--json");
  assert.equal(existsSync(payloadFile), false, "the payload file was left behind");

  const old = await runProjectSettings(async () => ({
    code: 2,
    stdout: "",
    stderr: "usage: bugpilot ...\nbugpilot: error: argument command: invalid choice: 'project-settings' (choose from 'bug')\n",
  }));
  assert.deepEqual(old, { kind: "outdated", rejected: ["project-settings"] });

  const refused = await runProjectSettings(async () => ({
    code: 1,
    stderr: "",
    stdout: `${JSON.stringify({ schema_version: 1, ok: false, command: "project-settings", error: { code: "INVALID_INPUT", message: "A branch naming template cannot contain '..' or '//'." } })}\n`,
  }));
  assert.deepEqual(refused, { kind: "failed", message: "A branch naming template cannot contain '..' or '//'." });
});
