/**
 * Repository Files' quick fix: add `.ai/` and `.ai_memory/` to the repository's
 * `.gitignore` (§37.85).
 *
 * What is missing is never decided here. `bugpilot doctor` asks git — `git
 * check-ignore` on a path inside each directory, the same probe behind the
 * warning — and reports the answer per directory. So `.ai`, `/.ai/`, a rule in
 * `.git/info/exclude` or a global excludes file all count exactly as they do
 * for git, and a rule is added only for a directory git does not ignore.
 *
 * This file appends lines and nothing else: the existing bytes stay as they
 * are, the new lines take the file's own line ending, and a line already there
 * is not written twice. An open `.gitignore` with unsaved changes is edited in
 * its buffer and left for the developer to save — never written behind.
 */

/** Each BugPilot artifact directory, and the rule the quick fix writes for it. */
export const ARTIFACT_IGNORE_RULES = {
  ".ai": ".ai/",
  ".ai_memory": ".ai_memory/",
} as const;

export type ArtifactDirectory = keyof typeof ARTIFACT_IGNORE_RULES;

const ARTIFACT_DIRECTORIES = Object.keys(ARTIFACT_IGNORE_RULES) as ArtifactDirectory[];

/** The file the quick fix edits: the active repository root's own, and no other. */
export const GITIGNORE_NAME = ".gitignore";

/**
 * The directories git does not ignore, from `doctor`'s per-directory answer.
 *
 * `undefined` when the report cannot say — no git, not a checkout, or a CLI
 * older than the per-directory field. Then no quick fix is offered: guessing
 * from the file's text would be a second opinion about what git ignores.
 */
export function unignoredArtifactDirectories(report: Record<string, unknown>): readonly ArtifactDirectory[] | undefined {
  const paths = report["ai_artifacts_ignored_paths"];
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return undefined;
  const answers = paths as Record<string, unknown>;
  const missing: ArtifactDirectory[] = [];
  for (const directory of ARTIFACT_DIRECTORIES) {
    const ignored = answers[directory];
    if (typeof ignored !== "boolean") return undefined;
    if (!ignored) missing.push(directory);
  }
  return missing;
}

/** The rules to write for these directories, in the file's order: `.ai/` first. */
export function rulesFor(directories: readonly ArtifactDirectory[]): readonly string[] {
  return ARTIFACT_DIRECTORIES.filter((directory) => directories.includes(directory)).map(
    (directory) => ARTIFACT_IGNORE_RULES[directory],
  );
}

export type LineEnding = "\n" | "\r\n";

/** The file's own line ending: the first one in it. LF for a file with none. */
export function lineEndingOf(text: string): LineEnding {
  const first = text.indexOf("\n");
  return first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * What to append to a `.gitignore` so each rule is a line of it.
 *
 * `existing` is the file's text, `undefined` when there is no file. Rules that
 * are already a line (trailing whitespace aside, which git ignores too) are
 * left out, so pressing the fix twice writes nothing the second time. The new
 * lines start on a line of their own and end with the file's line ending; no
 * comment, no blank line, nothing reordered. `""` means there is nothing to add.
 */
export function gitignoreAppendix(existing: string | undefined, rules: readonly string[], eol?: LineEnding): string {
  const text = existing ?? "";
  const present = new Set(text.split(/\r?\n/).map((line) => line.trimEnd()));
  const adding = rules.filter((rule, index) => !present.has(rule) && rules.indexOf(rule) === index);
  if (adding.length === 0) return "";
  const newline = eol ?? lineEndingOf(text);
  const lead = text === "" || text.endsWith("\n") ? "" : newline;
  return lead + adding.map((rule) => rule + newline).join("");
}

/**
 * The editor's view of `.gitignore`, as the quick fix needs it — an open text
 * document, if there is one. The host adapts VS Code's `TextDocument`.
 */
export interface GitignoreDocument {
  readonly text: string;
  readonly eol: LineEnding;
  /** Unsaved changes: the buffer is the developer's, not the disk's. */
  readonly dirty: boolean;
  /** Insert at the end of the buffer (a `WorkspaceEdit`). False if the editor refused. */
  readonly append: (text: string) => Promise<boolean>;
  /** Save the buffer. False if the editor could not. */
  readonly save: () => Promise<boolean>;
}

/** What is at `<root>/.gitignore` on disk. */
export type GitignoreEntry = "file" | "missing" | "symlink" | "other";

/** The filesystem and the editor, as the quick fix uses them. */
export interface GitignoreIo {
  /** The open document for this file, if the editor has one. */
  readonly document: (file: string) => GitignoreDocument | undefined;
  readonly stat: (file: string) => Promise<GitignoreEntry>;
  readonly read: (file: string) => Promise<Uint8Array>;
  readonly write: (file: string, bytes: Uint8Array) => Promise<void>;
}

export type GitignoreOutcome =
  /** Written to disk (a new file, bytes appended, or an open clean buffer saved). */
  | { readonly kind: "written"; readonly created: boolean; readonly added: readonly string[] }
  /** Inserted into an open buffer with unsaved changes, and left unsaved. */
  | { readonly kind: "unsaved"; readonly added: readonly string[] }
  /** Every rule is already a line of the file (or of its unsaved buffer). */
  | { readonly kind: "unchanged"; readonly unsaved: boolean }
  /** Nothing written. `detail` is for the output channel: never the file's contents. */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Add `rules` to the `.gitignore` at `file`, appending only what is missing.
 *
 * An open document goes through the editor, so what the developer typed stays:
 * a clean one gets the lines and is saved (the save writes exactly the disk's
 * text plus them); a dirty one gets the lines in its buffer and is left for the
 * developer to save. Otherwise the file's bytes are kept byte for byte — a BOM,
 * odd whitespace, anything — with the new lines after them.
 */
export async function addGitignoreRules(io: GitignoreIo, file: string, rules: readonly string[]): Promise<GitignoreOutcome> {
  try {
    const document = io.document(file);
    if (document) {
      const appendix = gitignoreAppendix(document.text, rules, document.eol);
      if (appendix === "") return { kind: "unchanged", unsaved: document.dirty };
      const added = linesOf(appendix);
      const dirty = document.dirty;
      if (!(await document.append(appendix))) return { kind: "failed", detail: "the editor did not accept the edit" };
      if (dirty) return { kind: "unsaved", added };
      if (!(await document.save())) return { kind: "failed", detail: "the editor could not save it" };
      return { kind: "written", created: false, added };
    }

    const entry = await io.stat(file);
    // Git does not read a symbolic link as `.gitignore`, and following one would
    // write outside the repository: not this fix's file to change.
    if (entry === "symlink") return { kind: "failed", detail: ".gitignore is a symbolic link" };
    if (entry === "other") return { kind: "failed", detail: ".gitignore is not a file" };
    const existing = entry === "file" ? await io.read(file) : undefined;
    const text = existing === undefined ? undefined : new TextDecoder("utf-8").decode(existing);
    const appendix = gitignoreAppendix(text, rules);
    if (appendix === "") return { kind: "unchanged", unsaved: false };
    const tail = new TextEncoder().encode(appendix);
    const bytes = new Uint8Array((existing?.length ?? 0) + tail.length);
    if (existing) bytes.set(existing, 0);
    bytes.set(tail, existing?.length ?? 0);
    await io.write(file, bytes);
    return { kind: "written", created: existing === undefined, added: linesOf(appendix) };
  } catch (error) {
    return { kind: "failed", detail: (error as Error)?.message || String(error) };
  }
}

function linesOf(appendix: string): readonly string[] {
  return appendix.split(/\r?\n/).filter((line) => line !== "");
}
