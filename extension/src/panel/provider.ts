/**
 * Hosting the panel, in the sidebar and in an editor tab.
 *
 * One HTML document serves both (§5.4): the sidebar view is where the panel
 * lives, and an editor tab is offered for the wide layout a long description
 * deserves. Both go through `#configure`, so the CSP, the resource roots and
 * the message validation cannot drift apart between them.
 *
 * The last state is kept here because a webview is destroyed when hidden. Its
 * page restores what was typed from `setState`, and this replays everything
 * else the moment the view comes back — without `retainContextWhenHidden`,
 * which would hold the whole page resident for the session.
 */

import * as vscode from "vscode";

import { panelHtml } from "./html.ts";
import { createNonce } from "./nonce.ts";
import { parsePanelMessage } from "./messages.ts";
import type { PanelMessage, PanelState } from "./messages.ts";

export class PanelHost {
  /** The sidebar view id, which the manifest contributes. */
  static readonly viewType = "bugpilot.panel";
  /**
   * A separate type for the editor tab.
   *
   * Reusing the contributed view id for a `createWebviewPanel` conflates two
   * different things in VS Code's registry (a view and a panel type, the latter
   * being what a serializer would key off).
   */
  static readonly editorViewType = "bugpilot.panelEditor";

  readonly #extensionUri: vscode.Uri;
  readonly #onMessage: (message: PanelMessage) => void;
  #view: vscode.WebviewView | undefined;
  #editor: vscode.WebviewPanel | undefined;
  #last: PanelState | undefined;

  constructor(extensionUri: vscode.Uri, onMessage: (message: PanelMessage) => void) {
    this.#extensionUri = extensionUri;
    this.#onMessage = onMessage;
  }

  /** Registered as the sidebar view's provider. */
  get provider(): vscode.WebviewViewProvider {
    return {
      resolveWebviewView: (view) => {
        this.#view = view;
        this.#configure(view.webview);
        view.onDidDispose(() => {
          if (this.#view === view) this.#view = undefined;
        });
      },
    };
  }

  /** Open the same panel as an editor tab, or focus the one already open. */
  openInEditor(): void {
    if (this.#editor) {
      this.#editor.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PanelHost.editorViewType,
      "BugPilot",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.#editor = panel;
    this.#configure(panel.webview);
    panel.onDidDispose(() => {
      this.#editor = undefined;
    });
  }

  /** Send a state to every open copy of the panel. */
  render(state: PanelState): void {
    this.#last = state;
    for (const webview of [this.#view?.webview, this.#editor?.webview]) {
      void webview?.postMessage({ type: "state", state });
    }
  }

  #configure(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      // Nothing outside the extension's own directory can be loaded, which
      // together with the CSP is what keeps the page offline (§5.4).
      localResourceRoots: [vscode.Uri.joinPath(this.#extensionUri, "media")],
    };
    const media = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.#extensionUri, "media", name)).toString();
    webview.html = panelHtml({
      // A fresh nonce per load: reusing one would let a cached page's script
      // run against a new document.
      nonce: createNonce(),
      cspSource: webview.cspSource,
      styleUri: media("panel.css"),
      scriptUri: media("panel.js"),
      // Vendored rather than reached for: VS Code does not expose its icon font
      // to webviews, and the CSP allows no remote origin.
      codiconUri: media("codicons/codicon.css"),
    });
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = parsePanelMessage(raw);
      // Silently dropped when unrecognized: the page and the host ship
      // together, so anything else is either stale or not ours.
      if (message) this.#onMessage(message);
    });
    if (this.#last) void webview.postMessage({ type: "state", state: this.#last });
  }
}
