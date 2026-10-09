/**
 * Whether an AI CLI accepts flags, from its own `--help` (`flagProbe.ts`):
 * asked once per executable and version, and every doubt is "no". Nothing is
 * run here — the executable, its identity and its output are the test's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFlagProbe } from "../src/app/flagProbe.ts";
import type { FlagProbeDeps } from "../src/app/flagProbe.ts";

const FLAGS = ["--session-id", "--resume"] as const;
const SECRET = "HELP_TEXT_MARKER_5521";
/** What Claude Code 2.1.214's --help says, in the lines that matter. */
const MODERN_HELP = `Usage: claude [options] [command] [prompt]
  -c, --continue                        Continue the most recent conversation in the current directory
  -r, --resume [value]                  Resume a conversation by session ID, or open interactive picker
  --session-id <uuid>                   Use a specific session ID for the conversation (must be a valid UUID)
  ${SECRET}`;
const LEGACY_HELP = `Usage: claude [options] [prompt]
  -c, --continue        Continue the most recent conversation
  -p, --print           Print response and exit
  ${SECRET}`;

function probe(options: {
  file?: string | undefined;
  help?: string;
  code?: number | null;
  aborted?: boolean;
  runThrows?: Error;
  identity?: () => string;
  identityThrows?: boolean;
} = {}) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const logged: string[] = [];
  const deps: FlagProbeDeps = {
    locate: () => ("file" in options ? options.file : "C:\\tools\\claude.exe"),
    identity: async () => {
      if (options.identityThrows) throw new Error("EACCES");
      return options.identity ? options.identity() : "1000:1";
    },
    run: async (file, args) => {
      runs.push({ file, args });
      if (options.runThrows) throw options.runThrows;
      return { code: options.code === undefined ? 0 : options.code, stdout: options.help ?? MODERN_HELP, stderr: "", aborted: options.aborted ?? false };
    },
    log: (message) => logged.push(message),
  };
  return { ask: createFlagProbe(deps), runs, logged };
}

test("a --help that lists both flags: yes, asked with argv --help only, and its text never logged", async () => {
  const { ask, runs, logged } = probe();
  assert.equal(await ask("claude", FLAGS), true);
  assert.deepEqual(runs, [{ file: "C:\\tools\\claude.exe", args: ["--help"] }]);
  assert.deepEqual(logged, ["claude: its --help lists --session-id, --resume."]);
  assert.equal(logged.some((line) => line.includes(SECRET)), false);
});

test("an older CLI whose --help lacks them: no, and said which one is missing", async () => {
  const { ask, logged } = probe({ help: LEGACY_HELP });
  assert.equal(await ask("claude", FLAGS), false);
  assert.deepEqual(logged, ["claude: its --help does not list --session-id, --resume; not using --session-id, --resume."]);
});

test("a flag counts only as its own word: --resume-session or --no-resume is not --resume", async () => {
  const { ask } = probe({ help: "  --session-id <uuid>   x\n  --resume-session   x\n  --no-resume   x" });
  assert.equal(await ask("claude", FLAGS), false);
});

test("asked once per executable and version: repeated and concurrent questions share one --help", async () => {
  const { ask, runs } = probe();
  const answers = await Promise.all([ask("claude", FLAGS), ask("claude", FLAGS), ask("claude", FLAGS)]);
  assert.deepEqual(answers, [true, true, true]);
  assert.equal(await ask("claude", FLAGS), true);
  assert.equal(runs.length, 1);
});

test("an upgraded executable — a new size or modification time — is asked again", async () => {
  let identity = "1000:1";
  const { ask, runs } = probe({ identity: () => identity });
  await ask("claude", FLAGS);
  identity = "2048:2";
  await ask("claude", FLAGS);
  assert.equal(runs.length, 2);
});

test("every doubt is no: not startable without a shell, a failed spawn, a timeout, an error exit, an unreadable file", async () => {
  const cases = [
    probe({ file: undefined }),
    probe({ runThrows: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
    probe({ aborted: true, code: null }),
    probe({ code: 1 }),
    probe({ identityThrows: true }),
  ];
  for (const [index, { ask }] of cases.entries()) assert.equal(await ask("claude", FLAGS), false, `case ${index}`);
  // A command that only runs through a shell (an npm claude.cmd on Windows) is never run at all.
  assert.deepEqual(cases[0]!.runs, []);
  assert.deepEqual(cases[0]!.logged, ["claude: not inspected — it is not a program that starts without a shell; not using --session-id, --resume."]);
  assert.deepEqual(cases[1]!.logged, ["claude: its --help could not be run (ENOENT); not using --session-id, --resume."]);
  assert.deepEqual(cases[2]!.logged, ["claude: its --help did not answer in time; not using --session-id, --resume."]);
});

test("each outcome is logged once, however often it is asked", async () => {
  const { ask, logged } = probe({ file: undefined });
  await ask("claude", FLAGS);
  await ask("claude", FLAGS);
  assert.equal(logged.length, 1);
});
