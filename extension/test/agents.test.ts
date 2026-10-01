/**
 * The AI Agent layer (§37.94): detection, Auto-detect's choice, explicit
 * choices that never fall back, the extension bridge, the custom command, and
 * the migration of an old saved choice.
 *
 * Every probe is a fake: no test here needs Codex or Claude installed, and none
 * spawns anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_CHOICES,
  AgentService,
  CLI_AGENTS,
  DETECTION_TIMEOUT_MS,
  EXTENSION_AGENTS,
  PROMPT_PLACEHOLDER,
  capturedReviewOf,
  cliAgent,
  customCommandAgent,
  extensionAgent,
  isPlainPrompt,
  migrateAgentChoice,
} from "../src/app/agents.ts";
import type {
  AgentChoice,
  AgentId,
  AgentLaunch,
  AgentProbes,
  AiFixRequest,
  InstalledExtension,
} from "../src/app/agents.ts";
import { restoreForm, DEFAULT_FORM } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";

const PROMPT = "Read .ai/JR-1/task.md and complete the workflow.";
const REQUEST: AiFixRequest = { workspacePath: "/repo", workItemId: "JR-1", prompt: PROMPT, purpose: "fix" };

const CODEX_EXTENSION: InstalledExtension = {
  version: "26.917.62051",
  active: true,
  commands: ["chatgpt.openSidebar", "chatgpt.newChat", "chatgpt.addFileToThread"],
};
const CLAUDE_EXTENSION: InstalledExtension = {
  version: "2.1.285",
  active: false,
  commands: ["claude-vscode.sidebar.open", "claude-vscode.editor.openLast", "claude-vscode.newConversation"],
};

/** A machine: which commands are on PATH, which extensions installed. Records every probe. */
function machine(options: { onPath?: readonly string[]; extensions?: Readonly<Record<string, InstalledExtension>> } = {}) {
  const probed: string[] = [];
  const looked: string[] = [];
  const probes: AgentProbes = {
    canRun: async (command) => {
      probed.push(command);
      return (options.onPath ?? []).includes(command);
    },
    extension: (id) => {
      looked.push(id);
      return options.extensions?.[id];
    },
  };
  return { probes, probed, looked };
}

/** A launch that records what an adapter did with it. */
function recordingLaunch(options: { executeThrows?: boolean; wanted?: () => boolean } = {}) {
  const terminals: string[] = [];
  const clipboard: string[] = [];
  const executed: { command: string; args: readonly unknown[] }[] = [];
  const wanted = options.wanted ?? (() => true);
  const launch: AgentLaunch = {
    runInTerminal: (commandLine) => {
      if (wanted()) terminals.push(commandLine);
    },
    copyToClipboard: async (text) => {
      if (wanted()) clipboard.push(text);
    },
    executeCommand: async (command, ...args) => {
      if (!wanted()) return false;
      if (options.executeThrows) return false;
      executed.push({ command, args });
      return true;
    },
  };
  return { launch, terminals, clipboard, executed };
}

function service(probes: AgentProbes, extra: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) {
  const logged: string[] = [];
  const agents = new AgentService({ probes, log: { info: (message) => logged.push(message) }, ...extra });
  return { agents, logged };
}

const resolve = (agents: AgentService, choice: AgentChoice, customCommand = "", prompt = PROMPT) =>
  agents.resolve({ choice, customCommand, prompt });

// --- the picker -------------------------------------------------------------------

test("the picker offers exactly the six choices, in order", () => {
  assert.deepEqual(AGENT_CHOICES, ["auto", "codex-cli", "claude-cli", "codex-extension", "claude-extension", "custom"]);
});

// --- CLI detection ------------------------------------------------------------------

test("Codex CLI detected: available, a CLI, and it can take the prompt", async () => {
  const { probes, probed } = machine({ onPath: ["codex"] });
  const adapter = cliAgent(CLI_AGENTS.find((entry) => entry.id === "codex-cli")!, probes);
  const capability = await adapter.detect();
  assert.equal(capability.available, true);
  assert.equal(capability.installed, true);
  assert.equal(capability.integration, "cli");
  assert.equal(capability.canReceivePrompt, true);
  assert.equal(capability.detail, "Available");
  assert.deepEqual(probed, ["codex"]);
});

test("Codex CLI missing: unavailable, with a sentence that says what to do", async () => {
  const { probes } = machine();
  const capability = await cliAgent(CLI_AGENTS.find((entry) => entry.id === "codex-cli")!, probes).detect();
  assert.equal(capability.available, false);
  assert.equal(capability.detail, "Not found on PATH");
  assert.match(capability.reason ?? "", /^Codex CLI is not available/);
  assert.match(capability.reason ?? "", /Install or configure Codex CLI, or choose another AI Agent/);
});

test("Claude CLI detected and missing, independently of Codex", async () => {
  const claude = CLI_AGENTS.find((entry) => entry.id === "claude-cli")!;
  assert.equal((await cliAgent(claude, machine({ onPath: ["claude"] }).probes).detect()).available, true);
  const missing = await cliAgent(claude, machine({ onPath: ["codex"] }).probes).detect();
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? "", /^Claude CLI is not available: claude was not found on PATH/);
});

test("a CLI runs in a terminal as `<command> \"<prompt>\"`, one line", async () => {
  for (const [id, command] of [["codex-cli", "codex"], ["claude-cli", "claude"]] as const) {
    const adapter = cliAgent(CLI_AGENTS.find((entry) => entry.id === id)!, machine({ onPath: [command] }).probes);
    const { launch, terminals, clipboard } = recordingLaunch();
    const result = await adapter.run({ ...REQUEST, prompt: "Read the task.\n\n  Then fix it.\n" }, launch);
    assert.equal(result.kind, "terminal");
    // A raw newline inside a quoted argument is submitted as a second command.
    assert.deepEqual(terminals, [`${command} "Read the task. Then fix it."`]);
    assert.deepEqual(clipboard, []);
  }
});

test("a probe that throws is 'not found', never an uncaught error", async () => {
  const probes: AgentProbes = { canRun: async () => Promise.reject(new Error("spawn EPERM")) };
  const capability = await cliAgent(CLI_AGENTS[0]!, probes).detect();
  assert.equal(capability.available, false);
});

test("detection that hangs or throws is bounded: unavailable, and the service keeps going", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hanging: AgentProbes = { canRun: () => new Promise<boolean>(() => {}) };
  const { agents } = service(hanging, {
    adapters: [
      { ...cliAgent(CLI_AGENTS[0]!, hanging) },
      { ...cliAgent(CLI_AGENTS[1]!, hanging), detect: () => Promise.reject(new Error("boom")) },
    ],
  });
  let settled = false;
  const pending = resolve(agents, "auto").finally(() => (settled = true));
  // Run the clock past the backstop until the pass is through every candidate.
  for (let turn = 0; turn < 50 && !settled; turn += 1) {
    await new Promise((next) => setImmediate(next));
    t.mock.timers.tick(DETECTION_TIMEOUT_MS + 1);
  }
  const resolution = await pending;
  assert.equal(resolution.kind, "unavailable");

  const timedOut = resolve(agents, "claude-cli").finally(() => (settled = true));
  settled = false;
  for (let turn = 0; turn < 50 && !settled; turn += 1) {
    await new Promise((next) => setImmediate(next));
    t.mock.timers.tick(DETECTION_TIMEOUT_MS + 1);
  }
  const explicit = await timedOut;
  assert.match(explicit.kind === "unavailable" ? explicit.reason : "", /could not be checked: detection timed out/);
  const thrown = await resolve(agents, "codex-cli");
  assert.match(thrown.kind === "unavailable" ? thrown.reason : "", /could not be checked: detection failed/);
});

// --- extension detection ------------------------------------------------------------

test("an installed extension with no callable API is a bridge: 'Installed · Limited integration'", async () => {
  const { probes, probed } = machine({ extensions: { "openai.chatgpt": CODEX_EXTENSION } });
  const adapter = extensionAgent(EXTENSION_AGENTS.find((entry) => entry.id === "codex-extension")!, probes);
  const capability = await adapter.detect();
  assert.equal(capability.installed, true);
  assert.equal(capability.available, true);
  assert.equal(capability.integration, "extension-bridge");
  assert.equal(capability.canReceivePrompt, false, "a bridge must not claim the prompt reaches the agent");
  assert.equal(capability.detail, "Installed · Limited integration");
  assert.deepEqual(probed, [], "detecting an extension spawns nothing");
});

test("neither built-in extension claims a native integration", () => {
  // Read off their installed manifests: no command takes a prompt, and no API
  // is documented. A `native` entry here would be a guess.
  for (const definition of EXTENSION_AGENTS) assert.equal(definition.native, undefined, definition.id);
});

test("a supported extension with a declared native command is 'Native integration available', and is invoked", async () => {
  const definition = {
    ...EXTENSION_AGENTS[0]!,
    native: { command: "chatgpt.startTask", args: (request: AiFixRequest) => [request.prompt] },
  };
  const installed = { ...CODEX_EXTENSION, commands: [...CODEX_EXTENSION.commands, "chatgpt.startTask"] };
  const adapter = extensionAgent(definition, machine({ extensions: { "openai.chatgpt": installed } }).probes);
  const capability = await adapter.detect();
  assert.equal(capability.integration, "native-extension");
  assert.equal(capability.canReceivePrompt, true);
  assert.equal(capability.detail, "Installed · Native integration available");

  const { launch, executed, clipboard } = recordingLaunch();
  const result = await adapter.run(REQUEST, launch);
  assert.equal(result.kind, "native");
  assert.deepEqual(executed, [{ command: "chatgpt.startTask", args: [PROMPT] }]);
  assert.deepEqual(clipboard, []);
});

test("a native command the installed version does not declare is never run: it is a bridge", async () => {
  const definition = { ...EXTENSION_AGENTS[0]!, native: { command: "chatgpt.startTask", args: () => [] } };
  const adapter = extensionAgent(definition, machine({ extensions: { "openai.chatgpt": CODEX_EXTENSION } }).probes);
  assert.equal((await adapter.detect()).integration, "extension-bridge");
  const { launch, executed } = recordingLaunch();
  await adapter.run(REQUEST, launch);
  assert.equal(executed.some((entry) => entry.command === "chatgpt.startTask"), false);
});

test("a native command that fails falls back to the same agent's bridge, not another agent", async () => {
  const definition = { ...EXTENSION_AGENTS[0]!, native: { command: "chatgpt.startTask", args: () => [] } };
  const installed = { ...CODEX_EXTENSION, commands: [...CODEX_EXTENSION.commands, "chatgpt.startTask"] };
  const adapter = extensionAgent(definition, machine({ extensions: { "openai.chatgpt": installed } }).probes);
  const { launch, clipboard } = recordingLaunch({ executeThrows: true });
  const result = await adapter.run(REQUEST, launch);
  assert.equal(result.kind, "bridge");
  assert.deepEqual(clipboard, [PROMPT]);
});

test("the bridge copies the prompt, then brings the agent's own view forward, and says what to do", async () => {
  const adapter = extensionAgent(EXTENSION_AGENTS[1]!, machine({ extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } }).probes);
  const { launch, clipboard, executed, terminals } = recordingLaunch();
  const result = await adapter.run(REQUEST, launch);
  assert.deepEqual(clipboard, [PROMPT]);
  assert.deepEqual(executed.map((entry) => entry.command), ["claude-vscode.sidebar.open"]);
  assert.deepEqual(terminals, []);
  assert.deepEqual(result, {
    kind: "bridge",
    label: "Claude Extension",
    revealed: true,
    message: "BugPilot AI fix context copied. Paste it into Claude to continue.",
  });
  const review = await adapter.run({ ...REQUEST, purpose: "review" }, recordingLaunch().launch);
  assert.equal(review.kind === "bridge" && review.message, "BugPilot review prompt copied. Paste it into Claude to continue.");
});

test("the bridge only runs reveal commands the installed manifest declares", async () => {
  const bare = { ...CODEX_EXTENSION, commands: ["chatgpt.newChat"] };
  const adapter = extensionAgent(EXTENSION_AGENTS[0]!, machine({ extensions: { "openai.chatgpt": bare } }).probes);
  const { launch, executed, clipboard } = recordingLaunch();
  const result = await adapter.run(REQUEST, launch);
  assert.deepEqual(executed, []);
  assert.deepEqual(clipboard, [PROMPT], "the clipboard still works");
  assert.equal(result.kind === "bridge" && result.revealed, false);
});

test("an extension that is not installed is unavailable, and one the host cannot see is too", async () => {
  const missing = await extensionAgent(EXTENSION_AGENTS[0]!, machine().probes).detect();
  assert.equal(missing.installed, false);
  assert.equal(missing.available, false);
  assert.equal(missing.detail, "Not installed or disabled");
  assert.match(missing.reason ?? "", /^Codex Extension is not available: the openai\.chatgpt extension is not installed/);
  // No extension port at all: not guessed at.
  const blind = await extensionAgent(EXTENSION_AGENTS[0]!, { canRun: async () => true }).detect();
  assert.equal(blind.available, false);
  // A lookup that throws is "not installed", not a crash.
  const throwing = await extensionAgent(EXTENSION_AGENTS[0]!, {
    canRun: async () => true,
    extension: () => {
      throw new Error("extension host gone");
    },
  }).detect();
  assert.equal(throwing.available, false);
});

// --- Auto-detect ----------------------------------------------------------------------

test("Auto-detect with no history takes the strongest integration: a CLI over a bridge", async () => {
  const { probes } = machine({ onPath: ["codex", "claude"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const { agents, logged } = service(probes);
  const resolution = await resolve(agents, "auto");
  assert.equal(resolution.kind, "ready");
  // Claude CLI over Codex CLI: its captured review lets Review with AI read the answer back.
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "claude-cli");
  assert.ok(logged.includes("Auto-detect resolved to Claude CLI."), logged.join("\n"));
});

test("Auto-detect takes Codex CLI when it is the only CLI, and asks lazily", async () => {
  const { probes, probed } = machine({ onPath: ["codex"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const resolution = await resolve(service(probes).agents, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "codex-cli");
  assert.deepEqual(probed, ["claude", "codex"]);
});

test("Auto-detect stops at the first usable CLI: a machine with Claude is not made to probe for Codex", async () => {
  const { probes, probed } = machine({ onPath: ["claude", "codex"] });
  await resolve(service(probes).agents, "auto");
  assert.deepEqual(probed, ["claude"]);
});

test("Auto-detect prefers a native extension over a CLI", async () => {
  const definition = { ...EXTENSION_AGENTS[0]!, native: { command: "chatgpt.startTask", args: () => [] } };
  const installed = { ...CODEX_EXTENSION, commands: [...CODEX_EXTENSION.commands, "chatgpt.startTask"] };
  const { probes, probed } = machine({ onPath: ["claude"], extensions: { "openai.chatgpt": installed } });
  const adapters = [...CLI_AGENTS.map((entry) => cliAgent(entry, probes)), extensionAgent(definition, probes)];
  const resolution = await resolve(service(probes, { adapters }).agents, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "codex-extension");
  assert.deepEqual(probed, [], "no CLI was probed once a native integration was found");
});

test("Auto-detect falls back to an extension bridge only when no CLI is there", async () => {
  const { probes } = machine({ extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const resolution = await resolve(service(probes).agents, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "claude-extension");
  assert.equal(resolution.kind === "ready" && resolution.capability.integration, "extension-bridge");
});

test("Auto-detect prefers the last agent a handoff reached, while it is still available", async () => {
  const { probes, probed } = machine({ onPath: ["codex", "claude"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  let stored: string | undefined = "codex-cli";
  const { agents } = service(probes, { lastAgent: { get: () => stored, set: (id) => void (stored = id) } });
  const resolution = await resolve(agents, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "codex-cli");
  assert.deepEqual(probed, ["codex"], "the last-used agent was asked first, and alone");

  // A bridge counts too, when it was the last one used.
  stored = "claude-extension";
  const bridge = await resolve(agents, "auto");
  assert.equal(bridge.kind === "ready" && bridge.adapter.id, "claude-extension");
});

test("Auto-detect ignores a last-used agent that is not available any more", async () => {
  const { probes } = machine({ onPath: ["claude"] });
  const { agents } = service(probes, { lastAgent: { get: () => "codex-cli", set: () => {} } });
  const resolution = await resolve(agents, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "claude-cli");
  // And an id this version does not know is no preference at all.
  const unknown = service(probes, { lastAgent: { get: () => "gemini-cli", set: () => {} } }).agents;
  assert.equal((await resolve(unknown, "auto")).kind, "ready");
});

test("succeeded() is remembered, in the store and for the session", async () => {
  const saved: AgentId[] = [];
  const { probes } = machine({ onPath: ["codex", "claude"] });
  const withStore = service(probes, { lastAgent: { get: () => saved.at(-1), set: (id) => void saved.push(id) } }).agents;
  withStore.succeeded("codex-cli");
  assert.deepEqual(saved, ["codex-cli"]);
  const without = service(probes).agents;
  without.succeeded("codex-cli");
  const resolution = await resolve(without, "auto");
  assert.equal(resolution.kind === "ready" && resolution.adapter.id, "codex-cli");
});

test("Auto-detect uses a custom command only when one is configured, and last", async () => {
  const { probes } = machine({ onPath: ["my-agent"] });
  const { agents } = service(probes);
  assert.equal((await resolve(agents, "auto", "")).kind, "unavailable");
  const configured = await resolve(agents, "auto", `my-agent --prompt ${PROMPT_PLACEHOLDER}`);
  assert.equal(configured.kind === "ready" && configured.adapter.id, "custom");
  // Not while a real agent is there.
  const both = await resolve(service(machine({ onPath: ["my-agent", "codex"] }).probes).agents, "auto", `my-agent ${PROMPT_PLACEHOLDER}`);
  assert.equal(both.kind === "ready" && both.adapter.id, "codex-cli");
});

test("nothing installed: a reason naming what was looked for, never a command line", async () => {
  const resolution = await resolve(service(machine().probes).agents, "auto");
  assert.equal(resolution.kind, "unavailable");
  assert.equal(
    resolution.kind === "unavailable" && resolution.reason,
    "No supported AI agent detected. BugPilot looked for Claude CLI, Codex CLI, Codex Extension and Claude Extension.",
  );
});

// --- explicit choices ------------------------------------------------------------------

test("explicit Codex CLI does not silently fall back to Claude", async () => {
  const { probes, probed, looked } = machine({ onPath: ["claude"], extensions: { "openai.chatgpt": CODEX_EXTENSION } });
  const resolution = await resolve(service(probes).agents, "codex-cli");
  assert.equal(resolution.kind, "unavailable");
  assert.match(resolution.kind === "unavailable" ? resolution.reason : "", /^Codex CLI is not available/);
  assert.deepEqual(probed, ["codex"], "only the chosen agent may be probed");
  assert.deepEqual(looked, []);
});

test("explicit Claude CLI does not silently fall back to Codex", async () => {
  const { probes, probed } = machine({ onPath: ["codex"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const resolution = await resolve(service(probes).agents, "claude-cli");
  assert.equal(resolution.kind, "unavailable");
  assert.match(resolution.kind === "unavailable" ? resolution.reason : "", /^Claude CLI is not available/);
  assert.deepEqual(probed, ["claude"]);
});

test("an explicit extension that is not installed is refused, not replaced by its CLI", async () => {
  const { probes, probed } = machine({ onPath: ["codex", "claude"] });
  for (const choice of ["codex-extension", "claude-extension"] as const) {
    const resolution = await resolve(service(probes).agents, choice);
    assert.equal(resolution.kind, "unavailable", choice);
  }
  assert.deepEqual(probed, []);
});

test("an explicit extension that is installed resolves to its bridge", async () => {
  const { probes } = machine({ extensions: { "openai.chatgpt": CODEX_EXTENSION } });
  const resolution = await resolve(service(probes).agents, "codex-extension");
  assert.equal(resolution.kind === "ready" && resolution.capability.integration, "extension-bridge");
});

// --- the custom command -------------------------------------------------------------------

test("a custom command is substituted, quoted, and probed by its own program", async () => {
  const { probes, probed } = machine({ onPath: ["wsl"] });
  const resolution = await resolve(service(probes).agents, "custom", `wsl my-agent --prompt ${PROMPT_PLACEHOLDER} --yes`);
  assert.equal(resolution.kind, "ready");
  // Probed by the first word: `wsl claude ...` lives or dies by `wsl`.
  assert.deepEqual(probed, ["wsl"]);
  const { launch, terminals } = recordingLaunch();
  const result = resolution.kind === "ready" ? await resolution.adapter.run(REQUEST, launch) : undefined;
  assert.deepEqual(terminals, [`wsl my-agent --prompt "${PROMPT}" --yes`]);
  // Labelled by what the developer wrote.
  assert.equal(result?.kind === "terminal" && result.label, "wsl");
});

test("a custom command without the placeholder, or empty, is refused with a reason", async () => {
  const { agents } = service(machine({ onPath: ["my-agent"] }).probes);
  const without = await resolve(agents, "custom", "my-agent --resume");
  assert.match(without.kind === "unavailable" ? without.reason : "", /\{prompt\}/);
  const empty = await resolve(agents, "custom", "   ");
  assert.match(empty.kind === "unavailable" ? empty.reason : "", /Advanced Settings → Fix with AI/);
  const missing = await resolve(agents, "custom", `my-tool ${PROMPT_PLACEHOLDER}`);
  assert.equal(missing.kind === "unavailable" && missing.reason, "my-tool is not on PATH.");
});

test("the custom adapter used directly is the same as through the service", async () => {
  const adapter = customCommandAgent(`agent ${PROMPT_PLACEHOLDER}`, machine({ onPath: ["agent"] }).probes);
  assert.equal((await adapter.detect()).integration, "custom");
});

// --- the prompt gate --------------------------------------------------------------------------

test("a prompt a shell could act on is refused before any agent is looked for, by every choice", async () => {
  for (const choice of AGENT_CHOICES) {
    for (const prompt of ['fix "the" thing', "Read .ai/x$(calc)/task.md and complete the workflow.", "Read `id`", "-rf now", ""]) {
      const { probes, probed, looked } = machine({ onPath: ["codex", "claude", "my-agent"], extensions: { "openai.chatgpt": CODEX_EXTENSION } });
      const resolution = await resolve(service(probes).agents, choice, `my-agent ${PROMPT_PLACEHOLDER}`, prompt);
      assert.equal(resolution.kind, "refused", `${choice}: ${JSON.stringify(prompt)}`);
      assert.deepEqual([...probed, ...looked], [], `${choice}: an agent was looked for for a refused prompt`);
    }
  }
  for (const prompt of [PROMPT, "Read .ai/local_20260926010922/task.md and complete the workflow.", "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n"]) {
    assert.equal(isPlainPrompt(prompt), true, prompt);
  }
});

// --- captured review -------------------------------------------------------------------------

test("only Claude CLI has a captured review; Codex CLI, the extensions and custom hand over instead", async () => {
  const { probes } = machine({ onPath: ["codex", "claude", "my-agent"], extensions: { "openai.chatgpt": CODEX_EXTENSION, "anthropic.claude-code": CLAUDE_EXTENSION } });
  const { agents } = service(probes);
  const captured = capturedReviewOf(await resolve(agents, "claude-cli"), true);
  assert.equal(captured?.command, "claude");
  for (const choice of ["codex-cli", "codex-extension", "claude-extension"] as const) {
    assert.equal(capturedReviewOf(await resolve(agents, choice), true), undefined, choice);
  }
  assert.equal(capturedReviewOf(await resolve(agents, "custom", `my-agent ${PROMPT_PLACEHOLDER}`), true), undefined);
  assert.equal(capturedReviewOf(await resolve(agents, "claude-cli"), false), undefined, "no capture port, no capture");
});

// --- the picker's status line ---------------------------------------------------------------

test("the status line: nothing before detection, then 'Detected: …' and each agent's standing", async () => {
  const { probes } = machine({ onPath: ["codex"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const { agents } = service(probes);
  assert.deepEqual(agents.status("").lines, {}, "nothing is said before anything was asked");
  await agents.refresh("");
  assert.deepEqual(agents.status("").lines, {
    auto: "Detected: Codex CLI",
    "claude-cli": "Not found on PATH",
    "codex-cli": "Available",
    "codex-extension": "Not installed or disabled",
    "claude-extension": "Installed · Limited integration",
  });
});

test("the status line says when nothing usable is found", async () => {
  const { agents } = service(machine().probes);
  await agents.refresh("");
  assert.equal(agents.status("").lines.auto, "No supported AI agent detected.");
});

test("the status line reads 'Detecting…' while the first detection runs", async () => {
  const answers: ((found: boolean) => void)[] = [];
  const probes: AgentProbes = { canRun: () => new Promise<boolean>((resolve) => answers.push(resolve)) };
  const { agents } = service(probes);
  const refreshing = agents.refresh("");
  assert.equal(agents.status("").lines.auto, "Detecting AI agents…");
  assert.equal(agents.status("").lines["codex-cli"], "Checking…");
  // Both CLIs are asked at once; answer every one of them.
  await new Promise((next) => setImmediate(next));
  assert.equal(answers.length, 2);
  for (const answer of answers) answer(false);
  await refreshing;
  assert.equal(agents.status("").lines.auto, "No supported AI agent detected.");
});

test("a refresh within the cache's life spawns nothing; invalidate() asks again", async () => {
  let now = 0;
  const { probes, probed } = machine({ onPath: ["claude"] });
  const { agents } = service(probes, { now: () => now });
  await agents.refresh("");
  const first = probed.length;
  now += 30_000;
  await agents.refresh("");
  assert.equal(probed.length, first, "a cached detection was asked again");
  agents.invalidate();
  await agents.refresh("");
  assert.equal(probed.length, first * 2);
});

test("a handoff always detects afresh, whatever the cache says", async () => {
  const onPath = ["claude"];
  const probes: AgentProbes = { canRun: async (command) => onPath.includes(command) };
  const { agents } = service(probes);
  await agents.refresh("");
  onPath.length = 0;
  const resolution = await resolve(agents, "claude-cli");
  assert.equal(resolution.kind, "unavailable", "a stale 'available' reached a handoff");
});

test("detection logs what it found, and never a prompt", async () => {
  const { probes } = machine({ onPath: ["codex"], extensions: { "anthropic.claude-code": CLAUDE_EXTENSION } });
  const { agents, logged } = service(probes);
  await agents.refresh("");
  await resolve(agents, "auto");
  for (const line of [
    "Detecting AI agents…",
    "Codex CLI available.",
    "Claude CLI not available (Not found on PATH).",
    "Claude Extension installed, no native integration.",
    "Auto-detect resolved to Codex CLI.",
  ]) {
    assert.ok(logged.includes(line), `missing "${line}" in:\n${logged.join("\n")}`);
  }
  assert.equal(logged.some((line) => line.includes("task.md")), false);
});

// --- migration ---------------------------------------------------------------------------------

test("an old saved choice migrates: `claude` is Claude CLI, never Auto-detect", () => {
  assert.equal(migrateAgentChoice("claude"), "claude-cli");
  for (const choice of AGENT_CHOICES) assert.equal(migrateAgentChoice(choice), choice);
  for (const junk of [undefined, null, 3, "gemini", ""]) assert.equal(migrateAgentChoice(junk), "auto");
});

test("a saved form comes back whole, with only the agent translated", () => {
  const saved = { ...DEFAULT_FORM, agent: "claude", agentCommand: "my-agent {prompt}", keywords: "save" } as unknown as FormState;
  const restored = restoreForm(saved);
  assert.equal(restored.agent, "claude-cli");
  assert.equal(restored.agentCommand, "my-agent {prompt}");
  assert.equal(restored.keywords, "save");
  const custom = restoreForm({ ...DEFAULT_FORM, agent: "custom", agentCommand: "x {prompt}" });
  assert.equal(custom.agent, "custom", "existing custom command users keep their choice");
  assert.equal(restoreForm(undefined), DEFAULT_FORM);
});

// --- quoting and injection (§37.94, real-world verification) ----------------------------

/** Text a terminal must never receive as shell syntax, from Jira, a description, a path or a title. */
const HOSTILE = [
  "C:\\sandbox\\bugpilot repo\\task.md",
  'Fix the issue described in "task.md" & preserve existing behavior.',
  "修复这个问题并保持现有行为",
  "Don't break the saver",
  "Read (task.md) and fix it",
  "Read %PATH% and fix it",
  "Read task.md; Remove-Item -Recurse .",
  "Read task.md | Out-File x",
  "Read task.md > out.txt",
  "Read $env:USERPROFILE and fix it",
  "Read `whoami` and fix it",
  "Read task.md && del /q *",
  "-c Read task.md",
];

test("tricky text never reaches a terminal: every terminal adapter refuses it on its own", async () => {
  const probes = machine({ onPath: ["codex", "claude", "my-agent"] }).probes;
  const adapters = [
    ...CLI_AGENTS.map((definition) => cliAgent(definition, probes)),
    customCommandAgent(`my-agent --prompt ${PROMPT_PLACEHOLDER}`, probes),
  ];
  for (const adapter of adapters) {
    for (const prompt of HOSTILE) {
      const { launch, terminals } = recordingLaunch();
      const result = await adapter.run({ ...REQUEST, prompt }, launch);
      assert.equal(result.kind, "failed", `${adapter.id}: ${prompt}`);
      assert.deepEqual(terminals, [], `${adapter.id} put ${JSON.stringify(prompt)} on a command line`);
    }
  }
});

test("tricky text is refused before any agent is looked for, whichever agent is chosen", async () => {
  for (const choice of AGENT_CHOICES) {
    for (const prompt of HOSTILE) {
      const { probes, probed, looked } = machine({ onPath: ["codex", "claude", "my-agent"], extensions: { "openai.chatgpt": CODEX_EXTENSION } });
      const resolution = await resolve(service(probes).agents, choice, `my-agent ${PROMPT_PLACEHOLDER}`, prompt);
      assert.equal(resolution.kind, "refused", `${choice}: ${prompt}`);
      assert.deepEqual([...probed, ...looked], []);
    }
  }
});

test("what the gate lets through stays one quoted argument: newlines collapse, words stay words", async () => {
  // Every character here is allowed, so the risk left is layout: a newline
  // would submit a second command, and an unquoted word could be read as a flag.
  const prompt = "Read .ai/JR-1/task.md\r\nRemove-Item -Recurse . --yolo";
  for (const definition of CLI_AGENTS) {
    const { launch, terminals } = recordingLaunch();
    await cliAgent(definition, machine({ onPath: [definition.command] }).probes).run({ ...REQUEST, prompt }, launch);
    assert.deepEqual(terminals, [`${definition.command} "Read .ai/JR-1/task.md Remove-Item -Recurse . --yolo"`]);
  }
});

test("both handoff sentences BugPilot builds pass the gate for every valid work item id shape", () => {
  for (const id of ["JR-12345", "ABC2-1", "local_20260930230052"]) {
    assert.equal(isPlainPrompt(`Read .ai/${id}/task.md and complete the workflow.`), true, id);
    assert.equal(isPlainPrompt(`Read .ai/${id}/agent_retry_prompt.md and continue the workflow.`), true, id);
  }
});
