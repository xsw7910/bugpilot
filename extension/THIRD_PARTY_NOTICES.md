# Third-party notices

The BugPilot VS Code extension is licensed under the Business Source License 1.1;
see `LICENSE.txt`. It includes the following third-party components, which are
not part of the Licensed Work and remain under their own licence. Nothing in
`LICENSE.txt` restricts any right that licence grants you.

## codicons

From [microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons),
copyright (c) Microsoft Corporation, licensed under the
[Creative Commons Attribution 4.0 International licence (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
They are provided as-is, without warranties of any kind; see the licence's
disclaimer. The licence grants no right to Microsoft's names, logos or
trademarks, and their use here implies no endorsement.

- **The icon font** `media/codicons/codicon.ttf`, redistributed unmodified.
- **The `bug` icon** `media/bug.svg` — the extension's activity bar icon — an
  unmodified copy of [`src/icons/bug.svg`](https://github.com/microsoft/vscode-codicons/blob/ddce330af4c41ecc653c74b519b821312a86affd/src/icons/bug.svg) at commit `ddce330af4c4`
  (codicons 0.0.40).
- **The Marketplace icon** `media/icon.png` is **adapted** from that `bug` icon:
  `scripts/make-icon.mjs` fills its path in near-white on a slate rounded tile.
  The tile is BugPilot's; the drawing of the bug is Microsoft's.

Their attribution is in `media/codicons/ATTRIBUTION.md` and must be preserved.
