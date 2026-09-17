/**
 * Is this workspace ready to run bugpilot, and if not, what should we offer?
 *
 * Two questions have to be answered before any UI can do anything useful:
 * which repository to operate on (§5.3 — bugpilot writes `.ai/<work_item>/`
 * into its cwd, so guessing wrong scatters artifacts into the wrong checkout),
 * and whether a usable bugpilot exists (§5.4 — the "CLI 未安装" row of the
 * three-state table).
 *
 * Both answers are computed here as data, not as side effects, so the install
 * wizard's contents are testable without VS Code: the caller renders whatever
 * `actions` it gets, and never decides for itself what to offer.
 */

import { COMMANDS } from "../commands.ts";
import { describeVerdict } from "../executable.ts";
import type { Verdict } from "../executable.ts";
import { chooseRepoRoot } from "../workspace.ts";
import type { Folder, WorkspaceProbe } from "../workspace.ts";

/** A button: a label and the command it runs. Rendered by whoever asked. */
export interface CommandAction {
  readonly title: string;
  readonly command: string;
}

export type Environment =
  | {
      readonly kind: "ready";
      readonly root: string;
      readonly executable: string;
      /** `doctor`'s report, so the panel can warn before the first run. */
      readonly report: Record<string, unknown>;
      readonly version?: string;
    }
  /** Several repositories are open. There is no safe guess; the developer picks. */
  | { readonly kind: "choose-folder"; readonly candidates: readonly Folder[] }
  | { readonly kind: "no-folder"; readonly summary: string }
  /** A bugpilot problem: not installed, too old, wedged, or unhealthy. */
  | {
      readonly kind: "unusable-cli";
      readonly root: string;
      readonly verdict: Verdict;
      readonly summary: string;
      readonly action: string;
      readonly actions: readonly CommandAction[];
    };

export interface EnvironmentInput {
  readonly folders: readonly Folder[];
  readonly probe: WorkspaceProbe;
  /** The `bugpilot.executablePath` setting, if set. */
  readonly configured?: string | undefined;
  /**
   * A root the developer already picked in this window.
   *
   * Honoured only if it is still one of the candidates: a stale pick from a
   * closed folder must not send artifacts to a checkout no longer open.
   */
  readonly preferredRoot?: string | undefined;
  readonly discover: (options: {
    readonly cwd: string;
    readonly configured?: string | undefined;
  }) => Promise<Verdict>;
}

export async function resolveEnvironment(input: EnvironmentInput): Promise<Environment> {
  const choice = chooseRepoRoot(input.folders, input.probe);
  let root: string;
  if (choice.kind === "none") {
    return { kind: "no-folder", summary: choice.detail };
  }
  if (choice.kind === "ambiguous") {
    const preferred = input.preferredRoot;
    const match = preferred
      ? choice.candidates.find((candidate) => candidate.fsPath === preferred)
      : undefined;
    if (!match) return { kind: "choose-folder", candidates: choice.candidates };
    root = match.fsPath;
  } else {
    root = choice.root;
  }

  const verdict = await input.discover({ cwd: root, configured: input.configured });
  if (verdict.kind === "ready") {
    return {
      kind: "ready",
      root,
      executable: verdict.executable,
      report: verdict.report,
      ...(verdict.version === undefined ? {} : { version: verdict.version }),
    };
  }
  const described = describeVerdict(verdict);
  return {
    kind: "unusable-cli",
    root,
    verdict,
    summary: described.summary,
    action: described.action,
    actions: actionsFor(verdict),
  };
}

/**
 * What to offer for a given verdict.
 *
 * The offers differ because the problems differ — that is the whole reason
 * `Verdict` has five states (§5.3). Offering "Install Instructions" to someone
 * whose `doctor` failed on a missing Jira credential wastes their time.
 */
export function actionsFor(verdict: Verdict): readonly CommandAction[] {
  const retry: CommandAction = { title: "Retry", command: COMMANDS.checkEnvironment };
  const choose: CommandAction = { title: "Choose Executable", command: COMMANDS.chooseExecutable };
  const install: CommandAction = {
    title: "Install Instructions",
    command: COMMANDS.showInstallInstructions,
  };

  switch (verdict.kind) {
    case "ready":
      return [];
    case "not-found":
      return [install, choose, retry];
    case "incompatible":
      // It is installed, so upgrading it is the first thing to try; a second
      // copy elsewhere on the machine is the common reason a chosen path helps.
      return [install, choose, retry];
    case "unresponsive":
      // Says nothing about the version, so neither install nor path is advice.
      return [retry];
    case "unhealthy":
      // bugpilot itself is fine; its environment is not. `doctor` is where the
      // details are.
      return [{ title: "Run Doctor", command: COMMANDS.doctor }, retry];
  }
}

/**
 * The install wizard's text.
 *
 * Kept as data so it can be shown in a notification, the panel's empty state,
 * or the output channel without three copies drifting apart.
 */
export function installInstructions(): readonly string[] {
  return [
    "bugpilot is a Python CLI. The extension drives it; it does not bundle it.",
    "",
    "    pipx install bugpilot",
    "",
    "Or, from a checkout of the repository:",
    "    python -m pip install -e .",
    "",
    "Then tell it where your Jira lives — there is no built-in default:",
    "    bugpilot setup",
    "",
    "Already installed but not found? It is probably not on PATH. Use",
    "\"Choose Executable\" to point the `bugpilot.executablePath` setting at it.",
  ];
}
