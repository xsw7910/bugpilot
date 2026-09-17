/**
 * Load the *built* extension the way VS Code does and activate it.
 *
 * `node --test` runs the TypeScript sources, so it proves nothing about the
 * packaged output: a CommonJS emit problem, a specifier that was not rewritten,
 * or a command that is declared but never registered all survive a green test
 * run and then fail on activation, where the only symptom is a greyed-out
 * extension and "command not found".
 *
 * So this requires `out/extension.js` with a stub `vscode` module in place,
 * calls `activate`, and checks that every declared command got registered.
 *
 * Run with: npm run smoke   (which builds first)
 */

import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const registered = [];
const handlers = new Map();
const disposable = { dispose: () => {} };

const views = [];
const listeners = [];

/** Only what activation touches. Anything missing shows up as a TypeError. */
const vscodeStub = {
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    createTerminal: () => ({ show: () => {}, sendText: () => {} }),
    createWebviewPanel: () => ({
      webview: { options: {}, html: "", asWebviewUri: (uri) => uri, cspSource: "vscode-webview:", onDidReceiveMessage: () => disposable, postMessage: async () => true },
      reveal: () => {},
      onDidDispose: () => disposable,
    }),
    registerWebviewViewProvider: (id, provider) => {
      views.push(id);
      // Resolving the view here is what proves the HTML can actually be built:
      // a bad resource path or a template error would otherwise wait for a
      // developer to open the sidebar.
      provider.resolveWebviewView({
        webview: {
          options: {},
          html: "",
          asWebviewUri: (uri) => uri,
          cspSource: "vscode-webview:",
          onDidReceiveMessage: () => disposable,
          postMessage: async () => true,
        },
        onDidDispose: () => disposable,
      });
      return disposable;
    },
    createTreeView: (id) => {
      views.push(id);
      return { dispose: () => {}, description: undefined };
    },
  },
  commands: {
    registerCommand: (command, handler) => {
      registered.push(command);
      handlers.set(command, handler);
      return disposable;
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => "", update: async () => {} }),
    openTextDocument: async () => ({}),
    onDidChangeWorkspaceFolders: () => {
      listeners.push("workspaceFolders");
      return disposable;
    },
    onDidChangeConfiguration: () => {
      listeners.push("configuration");
      return disposable;
    },
  },
  env: { clipboard: { writeText: async () => {} } },
  EventEmitter: class {
    constructor() {
      this.event = () => disposable;
    }
    fire() {}
    dispose() {}
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: {
    file: (value) => ({ fsPath: value, toString: () => value }),
    joinPath: (base, ...parts) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/"),
    }),
  },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return load.call(this, request, parent, isMain);
};

const extension = require("../out/extension.js");
const { COMMANDS } = require("../out/commands.js");

const context = {
  subscriptions: [],
  workspaceState: { get: () => undefined, update: async () => {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  extensionUri: { fsPath: "/ext", toString: () => "/ext" },
  globalStorageUri: { fsPath: "/storage", toString: () => "/storage" },
};

assert.equal(typeof extension.activate, "function", "the built extension exports no activate()");
extension.activate(context);

const declared = Object.values(COMMANDS).sort();
const actual = [...registered].sort();
assert.deepEqual(
  actual,
  declared,
  `activate() registered ${actual.length} commands but ${declared.length} are declared`,
);
assert.ok(context.subscriptions.length > 0, "nothing was registered for disposal");

const manifest = require("../package.json");
const declaredViews = (manifest.contributes.views.bugpilot ?? []).map((view) => view.id).sort();
assert.deepEqual(
  [...views].sort(),
  declaredViews,
  "the views registered at activation are not the ones the manifest declares",
);

// Stale answers are a real failure mode: without these the panel keeps saying
// "no folder is open" after one is opened, and keeps running the old binary
// after `bugpilot.executablePath` changes.
assert.deepEqual(
  [...listeners].sort(),
  ["configuration", "workspaceFolders"],
  "activation must react to folder and configuration changes",
);

// Handlers that touch no child process are invoked for real: a null deref in
// one of them is otherwise only found by a developer clicking it.
const safeCommands = [
  "bugpilot.showLog",
  "bugpilot.showInstallInstructions",
  "bugpilot.openPanelInEditor",
  "bugpilot.stop",
  "bugpilot.refreshViews",
];
for (const command of safeCommands) {
  const handler = handlers.get(command);
  assert.ok(handler, `${command} was never registered`);
  await handler();
}

assert.equal(typeof extension.deactivate, "function", "the built extension exports no deactivate()");
extension.deactivate();

console.log(
  `smoke ok: activated, registered ${actual.length} commands and ${views.length} views, and built the panel HTML`,
);
