# Third-party notice: codicons

The icons below are from [@vscode/codicons](https://github.com/microsoft/vscode-codicons),
copyright (c) Microsoft Corporation. They are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the project's code is
MIT. They are provided as-is, without warranties; the licence grants no right
to Microsoft's names, logos or trademarks.

- **`codicon.ttf`** in this directory is the codicons icon font, version
  0.0.46-24 (font version 1.15), redistributed unmodified inside the `.vsix`.
- **`../bug.svg`** (`media/bug.svg`, the activity bar icon) is the codicons
  `bug` icon, an unmodified copy of [`src/icons/bug.svg`](https://github.com/microsoft/vscode-codicons/blob/ddce330af4c41ecc653c74b519b821312a86affd/src/icons/bug.svg) at commit
  `ddce330af4c41ecc653c74b519b821312a86affd` (codicons 0.0.40).
- **`../icon.png`** (`media/icon.png`, the Marketplace icon) is adapted from that
  `bug` icon: `scripts/make-icon.mjs` renders its path in near-white on a slate
  rounded tile. That change is BugPilot's; the bug's design is Microsoft's.

CC BY 4.0 permits this redistribution and adaptation, including commercially,
with attribution — which is what this file and `THIRD_PARTY_NOTICES.md` are.

`codicon.css` beside it is **not** Microsoft's stylesheet. It is written for this
extension and declares only the glyphs the panel uses; the code points in it are
read from their `dist/codicon.css`, so they must be re-checked whenever the font
is updated.
