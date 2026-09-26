/**
 * What the Fix result row shows of `fix_report.md`: two lines, and nothing else.
 *
 * The report is agent-owned Markdown (plan §37, Batch 5): the coding agent — or
 * `manual-result`, for a hand-made fix — writes `## Summary`, `## Analysis`,
 * `## Changes`, `## Tests` and `## Review Notes`, and BugPilot only reads it.
 * The row needs two of those, as one line each, in the agent's own words; the
 * rest stays in the file, which the row opens in the editor.
 *
 * Deliberately not a classifier. "Fixed …", "Investigation complete …",
 * "Attempted fix …", "No code change was required." and "2 failed, 18 passed"
 * all pass through as text. The report carries no machine-readable outcome, and
 * reading one out of English would be a guess dressed as a status.
 *
 * Read the way `bugpilot/core/fix_report.py` reads it: a `##` heading matches
 * with case and surrounding whitespace forgiven, a section runs to the next
 * line starting `## ` (so `###` stays inside), and a missing section is empty
 * rather than an error — a report being written is a report with fewer
 * sections, not a broken one.
 */

/**
 * Only the start of a pathological file is parsed; the row needs two lines.
 * Characters, not bytes — the host has already read the file as text.
 */
const MAX_SCANNED_CHARS = 256 * 1024;

/** One line on a sidebar row, in code points; the full text is one click away. */
export const MAX_PREVIEW_CHARS = 240;

/** Every line boundary Python's `str.splitlines()` knows, which `section_of` splits on. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

export interface FixReportPreview {
  /**
   * Whether the file could be read at all.
   *
   * Listed but unreadable is still a report — the row appears and opens it —
   * it just has nothing to preview.
   */
  readonly readable: boolean;
  /** The first meaningful line of `## Summary`, bounded; absent when there is none. */
  readonly summary?: string;
  /** The first meaningful line of `## Tests`, bounded; absent when there is none. */
  readonly tests?: string;
}

export function parseFixReport(text: string | undefined): FixReportPreview {
  if (text === undefined) return { readable: false };
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const summary = firstLine(sectionOf(scanned, "## Summary"));
  const tests = firstLine(sectionOf(scanned, "## Tests"));
  return {
    readable: true,
    ...(summary === undefined ? {} : { summary }),
    ...(tests === undefined ? {} : { tests }),
  };
}

/**
 * The body under a `##` heading, up to the next one. `###` stays inside.
 *
 * A line-for-line port of `section_of` in `bugpilot/core/fix_report.py`, so the
 * panel and the CLI agree about what a report says.
 */
export function sectionOf(markdown: string, heading: string): string {
  const wanted = heading.trim().toLowerCase();
  const lines = markdown.split(LINE_BREAK);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === wanted);
  if (start === -1) return "";
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

/**
 * The first line of a section that says something, as one bounded line.
 *
 * Only Markdown's own scaffolding is set aside — blank lines, rules, HTML
 * comments and bare tags, subheadings, a table's header and separator, a list,
 * quote or task marker, and bold markers that wrap a whole span — never words:
 * `__init__.py`, `**kwargs` and `a ** b` stay as written. Prose outside a code
 * fence wins; a section that is nothing but a fence yields its first line,
 * literally. Table cells are joined with " · ".
 */
function firstLine(body: string): string | undefined {
  const lines = body.split("\n");
  let fenced: string | undefined;
  let inFence = false;
  let inComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (fenced === undefined && line !== "") fenced = line.replace(/\s+/g, " ");
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (line === "" || RULE.test(line) || HEADING.test(line) || BARE_TAGS.test(line) || TABLE_SEPARATOR.test(line)) {
      continue;
    }
    // A table's header row names its columns; the first data row says something.
    if (line.startsWith("|") && TABLE_SEPARATOR.test(nextNonEmpty(lines, index))) continue;
    const text = scaffoldingRemoved(line);
    if (text !== "") return bounded(text);
  }
  return fenced === undefined ? undefined : bounded(fenced);
}

const RULE = /^([-*_])(\s*\1){2,}$/;
/** A subheading titles what follows; it is not what the section says. */
const HEADING = /^#{1,6}(\s|$)/;
const BARE_TAGS = /^(<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>\s*)+$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
/** `**bold**` around a whole span, never a lone `**` or one inside a word. */
const BOLD = /(^|[\s(])\*\*(?=\S)(.+?)(?<=\S)\*\*(?=$|[\s).,;:!?])/g;

function nextNonEmpty(lines: readonly string[], index: number): string {
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

function scaffoldingRemoved(line: string): string {
  let text = line
    .replace(/^(>\s*)+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  const cells = /^\|(.*)\|$/.exec(text);
  if (cells) {
    text = cells[1]!
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "")
      .join(" · ");
  }
  return text.replace(BOLD, "$1$2").replace(/\s+/g, " ").trim();
}

/** Cut at a code point, so an emoji is never split into half a surrogate pair. */
function bounded(text: string): string {
  const points = Array.from(text);
  if (points.length <= MAX_PREVIEW_CHARS) return text;
  return `${points.slice(0, MAX_PREVIEW_CHARS - 1).join("").trimEnd()}…`;
}
