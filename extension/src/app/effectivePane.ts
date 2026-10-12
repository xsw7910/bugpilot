/**
 * One read-only view the host fills from the CLI: the Effective AI Task, the
 * Effective Context or the Protected Rules (0.1.4).
 *
 * The bookkeeping every such view needs, in one place so the three cannot
 * differ: while it is open, ask for the request the controller says is
 * current — once per request key, never again for the same key — and drop any
 * answer to a request that is no longer the current one, so a slow reply for
 * the previous work item can never replace the next one's. An older CLI is
 * marked unsupported without being asked, and an `outdated` answer is never
 * asked again. The last good answer stays on screen while a new one loads.
 *
 * Reading only: it never writes, and nothing it does marks a context stale.
 *
 * Node-only: no `vscode` import.
 */

export type PaneOutcome<T> =
  | { readonly kind: "loaded"; readonly snapshot: T }
  | { readonly kind: "outdated" }
  | { readonly kind: "failed"; readonly message: string };

export type PaneStatus = "loading" | "loaded" | "failed" | "unsupported";

export interface PaneState<T> {
  /** Bumped by every open, so the page moves focus once per open. */
  readonly token: number;
  readonly status: PaneStatus;
  /** The last good answer, kept while a newer one loads — and after a failure, which is said beside it. */
  readonly snapshot?: T;
  readonly message?: string;
  /** A newer answer is on its way. */
  readonly refreshing: boolean;
  /**
   * Held: BugPilot is busy — a run, or a check of the CLI — so nothing is
   * asked, an answer still on its way is dropped, and what is shown is the
   * last answer from before, never one that is current. Asked again after.
   */
  readonly held: boolean;
  /**
   * The snapshot answers the request the view is for now: loaded for this
   * request key, nothing newer on its way, not held. False while a new work
   * item or a changed input is asked for, after a failure (the last good
   * answer is still shown), and on a Refresh — so the snapshot is never handed
   * on (Copy) as the current one when it is not.
   */
  readonly current: boolean;
}

/** What the controller wants shown now: a request by key, "unsupported" (do not ask), or `undefined` (hold: ask nothing yet). */
export type PaneDesire<R> = { readonly key: string; readonly request: R } | "unsupported" | undefined;

export class Pane<R, T> {
  readonly #load: (request: R) => Promise<PaneOutcome<T>>;
  readonly #changed: () => void;
  #open = false;
  #token = 0;
  #key: string | undefined;
  #seq = 0;
  #inflight = false;
  #held = false;
  #status: PaneStatus = "loading";
  #snapshot: T | undefined;
  /** The request key the snapshot answered. */
  #snapshotKey: string | undefined;
  #message: string | undefined;

  constructor(load: (request: R) => Promise<PaneOutcome<T>>, changed: () => void) {
    this.#load = load;
    this.#changed = changed;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Open afresh: nothing shown until the first answer. */
  open(): void {
    this.#open = true;
    this.#token += 1;
    this.#seq += 1;
    this.#key = undefined;
    this.#inflight = false;
    this.#held = false;
    this.#status = "loading";
    this.#snapshot = undefined;
    this.#snapshotKey = undefined;
    this.#message = undefined;
  }

  /** Close; an answer still on its way is dropped when it comes. */
  close(): void {
    this.#open = false;
    this.#seq += 1;
    this.#inflight = false;
    this.#held = false;
  }

  /** Ask again for the same request: a Refresh. */
  invalidate(): void {
    this.#key = undefined;
  }

  /** Make the open view show `desired`, asking the CLI only when its key is new. */
  sync(desired: PaneDesire<R>): void {
    if (!this.#open) return;
    if (desired === undefined) {
      this.#hold();
      return;
    }
    this.#held = false;
    if (desired === "unsupported") {
      if (this.#key === "unsupported") return;
      this.#key = "unsupported";
      this.#seq += 1;
      this.#inflight = false;
      this.#status = "unsupported";
      this.#snapshot = undefined;
      this.#snapshotKey = undefined;
      this.#message = undefined;
      return;
    }
    if (desired.key === this.#key || this.#status === "unsupported" && this.#key === "outdated") return;
    const key = desired.key;
    this.#key = key;
    const seq = ++this.#seq;
    this.#inflight = true;
    if (this.#snapshot === undefined) this.#status = "loading";
    void this.#load(desired.request).then(
      (outcome) => this.#settle(seq, key, outcome),
      (error: unknown) => this.#settle(seq, key, { kind: "failed", message: (error as Error)?.message ?? String(error) }),
    );
  }

  /**
   * BugPilot is busy: drop an answer still on its way — it may describe the
   * files a run is now rewriting, or come from the executable being replaced —
   * and ask again once the hold ends. A CLI already found unable to answer is
   * not asked again for that.
   */
  #hold(): void {
    if (this.#held) return;
    this.#held = true;
    if (this.#inflight) {
      this.#seq += 1;
      this.#inflight = false;
    }
    if (this.#key !== "unsupported" && this.#key !== "outdated") this.#key = undefined;
  }

  #settle(seq: number, key: string, outcome: PaneOutcome<T>): void {
    // A newer request, a close or a reopen since: this answer is about something no longer shown.
    if (seq !== this.#seq || !this.#open) return;
    this.#inflight = false;
    if (outcome.kind === "loaded") {
      this.#status = "loaded";
      this.#snapshot = outcome.snapshot;
      this.#snapshotKey = key;
      this.#message = undefined;
    } else if (outcome.kind === "outdated") {
      // Never asked again while open: the same CLI would refuse the same way.
      this.#key = "outdated";
      this.#status = "unsupported";
      this.#snapshot = undefined;
      this.#snapshotKey = undefined;
      this.#message = undefined;
    } else {
      this.#status = "failed";
      this.#message = outcome.message;
    }
    this.#changed();
  }

  view(): PaneState<T> | undefined {
    if (!this.#open) return undefined;
    return {
      token: this.#token,
      status: this.#status,
      ...(this.#snapshot === undefined ? {} : { snapshot: this.#snapshot }),
      ...(this.#message === undefined ? {} : { message: this.#message }),
      refreshing: this.#inflight,
      held: this.#held,
      current:
        this.#status === "loaded" &&
        !this.#inflight &&
        !this.#held &&
        this.#snapshot !== undefined &&
        this.#snapshotKey !== undefined &&
        this.#snapshotKey === this.#key,
    };
  }
}
