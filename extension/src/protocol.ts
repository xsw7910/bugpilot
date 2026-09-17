/**
 * Consumer side of the CLI machine contract (docs/adapter_design.md §5.1).
 *
 * The CLI promises three things. This module *enforces* them rather than
 * assuming them, because a violated promise should surface as one clear error
 * instead of an undefined value three layers away:
 *
 *  1. `--json` writes exactly one JSON object to stdout, success or failure.
 *  2. `--json-lines` always ends with a terminal `completed` event.
 *  3. Consumers branch on `error.code` and never parse `error.message`.
 *
 * Nothing here imports `vscode`, so it is unit-testable with plain node.
 */

/** The contract version this client understands. */
export const SCHEMA_VERSION = 1;

export interface EnvelopeSuccess {
  readonly ok: true;
  readonly command: string;
  readonly warnings: readonly string[];
  readonly [field: string]: unknown;
}

export interface EnvelopeFailure {
  readonly ok: false;
  readonly command: string;
  readonly error: { readonly code: string; readonly message: string };
  readonly [field: string]: unknown;
}

export type Envelope = EnvelopeSuccess | EnvelopeFailure;

/**
 * A stdout/stderr pair that does not satisfy the contract at all.
 *
 * Fields are declared and assigned explicitly rather than via TypeScript
 * parameter properties: those emit code, so Node's type-stripping runtime
 * rejects them and `erasableSyntaxOnly` in tsconfig flags them at typecheck.
 */
export class ProtocolError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = "ProtocolError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function checkVersion(payload: Record<string, unknown>, stdout: string, stderr: string): void {
  const version = payload["schema_version"];
  if (version === SCHEMA_VERSION) return;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    // Refusing beats guessing: a newer CLI may have moved a field this client
    // reads, and a confident misread is worse than a clear "please update".
    throw new ProtocolError(
      `bugpilot speaks contract v${version}; this extension understands v${SCHEMA_VERSION}. Update the extension.`,
      stdout,
      stderr,
    );
  }
  throw new ProtocolError(
    `Expected schema_version ${SCHEMA_VERSION}, got ${JSON.stringify(version)}.`,
    stdout,
    stderr,
  );
}

/**
 * Parse the single object a `--json` command writes.
 *
 * Trailing newlines are tolerated; anything else on stdout is a contract
 * violation and reported as one, since a stray `print` in the CLI would
 * otherwise silently corrupt whatever the caller does next.
 */
export function parseEnvelope(stdout: string, stderr = ""): Envelope {
  const text = stdout.trim();
  if (text === "") {
    throw new ProtocolError("bugpilot produced no output on stdout.", stdout, stderr);
  }
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(text));
  } catch (cause) {
    throw new ProtocolError(
      `bugpilot stdout was not a single JSON object: ${(cause as Error).message}`,
      stdout,
      stderr,
    );
  }
  if (!payload) {
    throw new ProtocolError("bugpilot stdout was JSON but not an object.", stdout, stderr);
  }
  checkVersion(payload, stdout, stderr);

  if (payload["ok"] === true) {
    const warnings = Array.isArray(payload["warnings"]) ? (payload["warnings"] as string[]) : [];
    return { ...payload, ok: true, command: String(payload["command"] ?? ""), warnings } as EnvelopeSuccess;
  }
  if (payload["ok"] === false) {
    const error = asRecord(payload["error"]);
    if (!error || typeof error["code"] !== "string") {
      throw new ProtocolError(
        "A failure envelope carried no error.code, which is the only field a consumer may branch on.",
        stdout,
        stderr,
      );
    }
    return {
      ...payload,
      ok: false,
      command: String(payload["command"] ?? ""),
      error: { code: error["code"], message: String(error["message"] ?? "") },
    } as EnvelopeFailure;
  }
  throw new ProtocolError("Envelope had no boolean `ok` field.", stdout, stderr);
}

// --- JSONL event stream ----------------------------------------------------

export type StreamEvent =
  | { readonly type: "started"; readonly work_item_id: string; readonly source: string }
  | { readonly type: "phase"; readonly phase: string }
  | { readonly type: "step_started"; readonly step: string }
  | { readonly type: "step_completed"; readonly step: string }
  | { readonly type: "step_skipped"; readonly step: string; readonly reason: string }
  | { readonly type: "artifact"; readonly path: string }
  | {
      readonly type: "completed";
      readonly ok: boolean;
      readonly error?: { readonly code: string; readonly message: string };
      /**
       * Things the run did differently than asked, without failing.
       *
       * Added to the terminal event rather than as an event type of its own,
       * which is why an older extension reading a newer CLI simply ignores the
       * key instead of meeting a shape it has to decide about.
       */
      readonly warnings?: readonly string[];
    };

/**
 * Incremental JSONL reader.
 *
 * A spawned process delivers stdout in arbitrary chunks, so a line routinely
 * arrives split across two `push` calls. Buffering the tail is the whole point
 * of this class — parsing each chunk independently drops events at random and
 * looks like a flaky CLI.
 */
export class EventStreamReader {
  #buffer = "";
  #sawTerminal = false;
  #foreignVersion: number | undefined;

  /** Feed a chunk; returns whatever complete events it completed. */
  push(chunk: string): StreamEvent[] {
    this.#buffer += chunk;
    const events: StreamEvent[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const event = this.#parseLine(line);
      if (event) events.push(event);
      newline = this.#buffer.indexOf("\n");
    }
    return events;
  }

  /**
   * Flush a final unterminated line and report whether the stream was closed.
   *
   * The CLI emits a `completed` event on every path, including a preflight
   * failure, so a missing one means the process died mid-run. Saying so beats
   * leaving a progress view stuck at the last step it saw.
   */
  end(): { events: StreamEvent[]; terminated: boolean; foreignVersion?: number } {
    const events: StreamEvent[] = [];
    const tail = this.#buffer.trim();
    this.#buffer = "";
    if (tail !== "") {
      const event = this.#parseLine(tail);
      if (event) events.push(event);
    }
    return {
      events,
      terminated: this.#sawTerminal,
      // A version bump must not look like a crash. Dropping every event
      // silently would resolve a perfectly good run as `terminated: false`,
      // which the UI reports as "died mid-run" — while parseEnvelope on the
      // same CLI correctly says "update the extension". Surface it so the
      // caller can say the same thing.
      ...(this.#foreignVersion === undefined ? {} : { foreignVersion: this.#foreignVersion }),
    };
  }

  #parseLine(line: string): StreamEvent | undefined {
    const text = line.trim();
    if (text === "") return undefined;
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(text));
    } catch {
      // One malformed line must not abort a run that is otherwise progressing;
      // the terminal-event check is what catches a genuinely broken stream.
      return undefined;
    }
    if (!payload || typeof payload["type"] !== "string") return undefined;
    if (payload["schema_version"] !== SCHEMA_VERSION) {
      const version = payload["schema_version"];
      if (typeof version === "number") this.#foreignVersion = version;
      return undefined;
    }
    if (payload["type"] === "completed") this.#sawTerminal = true;
    return payload as unknown as StreamEvent;
  }
}
