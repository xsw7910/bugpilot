/**
 * Quoting text into a prompt without letting it become the prompt's structure (0.1.5, plan §44.5.6, S8).
 *
 * The TypeScript half of `bugpilot/core/evidence.py`, for the one prompt the
 * extension writes itself: the hint improver's. The rules are the Python ones,
 * character for character, and `test/evidence.test.ts` holds this file to the
 * Python output on the shared corpus fixture
 * (`tests/golden/prompt_boundary/evidence_mirror.json`):
 *
 * - **visible escapes** — control, format, line- and paragraph-separator
 *   characters are written `<U+XXXX>`, never dropped (decision D2);
 * - **evidence block** — text quoted verbatim inside a backtick fence longer
 *   than any backtick run in it, so nothing inside can end it (decision D3);
 * - **one line** — a short field on one line: each run of whitespace becomes one
 *   space, invisible characters escaped as above.
 *
 * Containment is structural. It decides what a reader takes for the prompt's
 * own parts; it cannot make a model disregard what quoted text says.
 *
 * Node-only: no `vscode` import.
 */

/** Unicode categories written as visible escapes: control, format, line and paragraph separators. */
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
/** Whitespace a run of which becomes one space, once the invisible characters are escaped: what Python's `str.split()` splits on then. */
const WHITESPACE_RUN = /[\t\n\r\p{Zs}]+/u;
const BACKTICK_RUN = /`+/g;

function escaped(character: string): string {
  return `<U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
}

/** `text` with every control, format, line- or paragraph-separator character as `<U+XXXX>`, but those in `keep`. */
function visibleEscapes(text: string, keep = "\t\n"): string {
  let out = "";
  for (const character of text) {
    out += keep.includes(character) || !INVISIBLE.test(character) ? character : escaped(character);
  }
  return out;
}

function words(text: string): string[] {
  return text.split(WHITESPACE_RUN).filter((word) => word !== "");
}

/** A backtick fence no line of `text` can close: longer than any backtick run in it, and at least three. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(BACKTICK_RUN) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** `text` quoted verbatim in a fenced block nothing in it can close; `info` names what it holds, on one line. */
export function evidenceBlock(text: string, info = "text"): string {
  const body = visibleEscapes(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const fence = fenceFor(body);
  const label = words(visibleEscapes(info, "").replace(/`/g, "")).join(" ");
  const opening = `${fence}${label}`;
  return body === "" ? `${opening}\n${fence}` : `${opening}\n${body}\n${fence}`;
}

/** `text` on one line: each run of whitespace, line breaks included, becomes one space; invisible characters escaped. */
export function oneLine(text: string): string {
  return words(visibleEscapes(text, "\t\n\r")).join(" ");
}
