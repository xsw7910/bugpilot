/**
 * The Repository Profile in the extension: the copy of
 * the CLI's model, the transport through `bugpilot repository-profile`, and the
 * Advanced Settings section.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  REPOSITORY_FIELDS,
  REPOSITORY_PROFILE_LABELS,
  REPOSITORY_PROFILE_MODES,
  cleanFact,
  formWithRepositoryProfile,
  repositoryProfileArgs,
  repositoryProfileModeOf,
  repositoryProfileOfForm,
  repositoryProfileView,
  runRepositoryProfile,
  sameRepositoryProfile,
  snapshotFromEnvelope,
} from "../src/app/repositoryProfile.ts";
import type { ProfileRunResult } from "../src/app/repositoryProfile.ts";
import { DEFAULT_FORM, buildPrepareArgs, preparationFingerprint, restoreForm } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";
import { panelHtml } from "../src/panel/html.ts";

const CONTRACT = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/repository_profile_contract.json", import.meta.url), "utf8"),
) as {
  modes: string[];
  default_mode: string;
  labels: Record<string, string>;
  fields: { key: string; label: string; max: number }[];
};

test("the extension's copy of the model is the CLI's, through the shared fixture", () => {
  assert.deepEqual([...REPOSITORY_PROFILE_MODES], CONTRACT.modes);
  assert.equal(REPOSITORY_PROFILE_MODES[0], CONTRACT.default_mode);
  assert.deepEqual({ ...REPOSITORY_PROFILE_LABELS }, CONTRACT.labels);
  assert.deepEqual(
    REPOSITORY_FIELDS.map((entry) => ({ key: entry.key, label: entry.label, max: entry.max })),
    CONTRACT.fields,
  );
});

test("an unknown mode from outside is Auto-detect; a form from before the profile restores to it", () => {
  assert.equal(repositoryProfileModeOf("legacy-cpp"), "auto");
  assert.equal(repositoryProfileModeOf(undefined), "auto");
  assert.equal(repositoryProfileModeOf("custom"), "custom");
  const old = { ...DEFAULT_FORM } as Record<string, unknown>;
  for (const entry of REPOSITORY_FIELDS) delete old[entry.field];
  delete old["repositoryProfile"];
  const restored = restoreForm(old as unknown as FormState);
  assert.equal(restored.repositoryProfile, "auto");
  assert.equal(restored.repositoryNotes, "");
});

test("a detail is one line, as the CLI stores it", () => {
  assert.equal(cleanFact("  C++,\n\tPython\u0007 "), "C++, Python");
  assert.equal(cleanFact(3), "");
});

const SNAPSHOT_ENVELOPE = {
  schema_version: 1,
  ok: true,
  command: "repository-profile",
  profile: { mode: "custom", custom: { languages: "Go", notes: "No cgo.", unknown: "dropped" } },
  saved: true,
  detected: { facts: { languages: "C++", frameworks: "Qt", build_system: "CMake", notes: "" }, guidance_files: [] },
  effective: { mode: "custom", facts: {} },
  warnings: ["a warning", 3],
};

test("the CLI's answer is read field by field, as untrusted input", () => {
  const snapshot = snapshotFromEnvelope(SNAPSHOT_ENVELOPE)!;
  assert.equal(snapshot.profile.mode, "custom");
  assert.equal(snapshot.profile.custom.languages, "Go");
  assert.equal(snapshot.profile.custom.frameworks, "");
  assert.equal("unknown" in snapshot.profile.custom, false);
  assert.equal(snapshot.detected, "C++ · Qt · CMake");
  assert.deepEqual(snapshot.warnings, ["a warning"]);
  assert.equal(snapshotFromEnvelope({ ok: false, error: { code: "INVALID_INPUT", message: "x" } }), undefined);
  assert.equal(snapshotFromEnvelope("nonsense"), undefined);
});

test("the page's line says what Auto-detect found, or that nothing was, and only for Auto-detect", () => {
  const snapshot = snapshotFromEnvelope(SNAPSHOT_ENVELOPE)!;
  assert.deepEqual(repositoryProfileView(snapshot).lines, { auto: "Detected: C++ · Qt · CMake", generic: "", custom: "" });
  assert.equal(repositoryProfileView({ ...snapshot, detected: "" }).lines.auto, "Nothing detected with confidence. No assumptions are made.");
  assert.deepEqual(repositoryProfileView(undefined).lines, { auto: "", generic: "", custom: "" });
});

function fakeRun(result: Partial<ProfileRunResult>) {
  const calls: { args: readonly string[]; payload?: unknown; existed?: boolean }[] = [];
  const run = async (args: readonly string[]): Promise<ProfileRunResult> => {
    const file = args.find((arg) => arg.startsWith("--from-file="))?.slice("--from-file=".length);
    calls.push({
      args,
      ...(file === undefined ? {} : { payload: JSON.parse(readFileSync(file, "utf8")), existed: existsSync(file) }),
    });
    return { code: 0, stdout: JSON.stringify(SNAPSHOT_ENVELOPE), stderr: "", ...result };
  };
  return { calls, run };
}

test("show runs `repository-profile show --json` in the repository and reads the answer", async () => {
  const fake = fakeRun({});
  const outcome = await runRepositoryProfile(fake.run);
  assert.deepEqual(fake.calls[0]!.args, ["repository-profile", "show", "--json"]);
  assert.equal(outcome.kind, "loaded");
});

test("set sends the profile in a temporary file, never on the command line, and removes it", async () => {
  const fake = fakeRun({});
  const profile = repositoryProfileOfForm({ ...DEFAULT_FORM, repositoryProfile: "custom", repositoryLanguages: "  Rust " });
  await runRepositoryProfile(fake.run, profile);
  const call = fake.calls[0]!;
  assert.equal(call.args[0], "repository-profile");
  assert.equal(call.args[1], "set");
  assert.match(call.args[2]!, /^--from-file=.*bugpilot-repository-profile-.*\.json$/);
  assert.equal(call.args.some((arg) => arg.includes("Rust")), false, "a detail rode on the command line");
  assert.deepEqual(call.payload, { mode: "custom", custom: { ...profile.custom, languages: "Rust" } });
  assert.equal(existsSync(call.args[2]!.slice("--from-file=".length)), false, "the payload file was left behind");
  assert.deepEqual(repositoryProfileArgs(), ["repository-profile", "show"]);
});

test("a CLI without the command is out of date; a failure envelope or garbage is a failure", async () => {
  const old = await runRepositoryProfile(
    fakeRun({
      code: 2,
      stdout: "",
      stderr: "usage: bugpilot ...\nbugpilot: error: argument command: invalid choice: 'repository-profile' (choose from 'bug')\n",
    }).run,
  );
  assert.deepEqual(old, { kind: "outdated", rejected: ["repository-profile"] });
  // What a CLI from before the command really says: `repository-profile` taken
  // for an issue key of its default `bug` command, and the rest unrecognized.
  const older = await runRepositoryProfile(
    fakeRun({ code: 2, stdout: "", stderr: "usage: bugpilot bug ...\nbugpilot: error: unrecognized arguments: show --json\n" }).run,
  );
  assert.deepEqual(older, { kind: "outdated", rejected: ["repository-profile"] });

  const refused = await runRepositoryProfile(
    fakeRun({
      code: 1,
      stdout: JSON.stringify({ schema_version: 1, ok: false, command: "repository-profile", error: { code: "INVALID_INPUT", message: "Languages is longer than 200 characters." } }),
    }).run,
  );
  assert.deepEqual(refused, { kind: "failed", message: "Languages is longer than 200 characters." });

  const garbage = await runRepositoryProfile(fakeRun({ code: 1, stdout: "Traceback" }).run);
  assert.equal(garbage.kind, "failed");
});

test("the form and a saved profile compare the way the CLI stores them", () => {
  const form = { ...DEFAULT_FORM, repositoryProfile: "custom" as const, repositoryLanguages: " Go " };
  const saved = repositoryProfileOfForm({ ...DEFAULT_FORM, repositoryProfile: "custom", repositoryLanguages: "Go" });
  assert.ok(sameRepositoryProfile(form, saved));
  assert.equal(sameRepositoryProfile({ ...form, repositoryProfile: "auto" }, saved), false);
  const overlaid = formWithRepositoryProfile({ ...DEFAULT_FORM, keywords: "kept" }, saved);
  assert.equal(overlaid.repositoryProfile, "custom");
  assert.equal(overlaid.repositoryLanguages, "Go");
  assert.equal(overlaid.keywords, "kept", "only the profile is replaced");
});

test("the profile moves the preparation fingerprint, whitespace does not, and no flag carries it", () => {
  const base = { ...DEFAULT_FORM, issueKey: "JR-1" };
  assert.notEqual(preparationFingerprint({ ...base, repositoryProfile: "generic" }), preparationFingerprint(base));
  assert.notEqual(preparationFingerprint({ ...base, repositoryNotes: "No cgo." }), preparationFingerprint(base));
  assert.equal(preparationFingerprint({ ...base, repositoryLanguages: " Go " }), preparationFingerprint({ ...base, repositoryLanguages: "Go" }));
  const built = buildPrepareArgs({ ...base, repositoryProfile: "custom", repositoryLanguages: "Go" }, { root: "/repo", descriptionFilePath: "/tmp/d.md" });
  assert.ok(built.ok);
  if (built.ok) assert.equal(built.args.some((arg) => arg.includes("repository") || arg.includes("Go")), false);
});

test("the webview's values are normalised and capped at the CLI's limits", () => {
  const message = parsePanelMessage({
    type: "applySettings",
    form: { ...DEFAULT_FORM, source: "jira", repositoryProfile: "legacy", repositoryNotes: "x".repeat(5_000), repositoryLanguages: "y".repeat(500) },
  });
  assert.ok(message && message.type === "applySettings");
  if (message && message.type === "applySettings") {
    assert.equal(message.form.repositoryProfile, "auto");
    assert.equal(message.form.repositoryNotes.length, 1_000);
    assert.equal(message.form.repositoryLanguages.length, 200);
  }
});

const HTML = panelHtml({ nonce: "n", cspSource: "c", styleUri: "s", scriptUri: "j", codiconUri: "i" });
const SECTION = (() => {
  const start = HTML.indexOf('id="settings-section-repository"');
  return HTML.slice(start, HTML.indexOf("</section>", start));
})();

test("the Repository section is a select, a quiet line and six hidden details, marked Requires rebuild", () => {
  assert.match(SECTION, />Repository</);
  assert.match(SECTION, /<span class="settings-tag" id="settings-note-repository"[^>]*>Requires rebuild<\/span>/);
  const options = [...SECTION.matchAll(/<option value="([a-z]+)" title="[^"]+">([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(options, [["auto", "Auto-detect"], ["generic", "Generic"], ["custom", "Custom"]]);
  assert.match(SECTION, /<label for="repositoryProfile" title="Describe the repository context BugPilot gives to the AI agent\./);
  assert.match(SECTION, /<p class="hint repository-detected" id="repositoryProfile-detected" aria-live="polite" hidden><\/p>/);
  for (const entry of REPOSITORY_FIELDS) {
    assert.match(SECTION, new RegExp(`<div class="field" id="field-${entry.field}" hidden>`), entry.field);
    assert.match(SECTION, new RegExp(`id="${entry.field}"[^>]*maxlength="${entry.max}"|maxlength="${entry.max}"[^>]*id="${entry.field}"`), entry.field);
  }
  // The notes are the one paragraph, two rows, never a large form.
  assert.match(SECTION, /<textarea id="repositoryNotes" name="repositoryNotes" rows="2"/);
  // Repository-neutral copy: no language or framework named as a default, only as examples.
  assert.equal(/legacy/i.test(SECTION), false);
});
