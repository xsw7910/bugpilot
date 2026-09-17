/**
 * The Jira token: stored by VS Code, handed to the CLI through the environment.
 *
 * This is the requirement-R6 half of the extension. Today the CLI keeps the
 * token in plaintext in `~/.bugpilot/config.toml`; VS Code's SecretStorage is
 * an improvement, and `config.py` already prefers environment variables over
 * that file, so injecting it needs no change on the Python side.
 *
 * Two rules, both enforced below rather than documented and hoped for:
 *
 *  1. **The environment, never argv.** A command line is readable by any
 *     process listing on the machine; a child's environment is not.
 *  2. **Never returned for display.** The only export that yields the token
 *     hands back an environment block ready to spawn with, so there is no
 *     convenient way to log it by accident.
 *
 * `vscode` is not imported: SecretStorage arrives as a narrow interface.
 */

/**
 * The slice of `vscode.SecretStorage` this module uses.
 *
 * Declared with `PromiseLike` rather than VS Code's `Thenable`, which is the
 * same shape from the standard library — so the real SecretStorage satisfies
 * this structurally without the extension depending on `@types/vscode`.
 */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/**
 * Both parts live under one key, as one JSON value.
 *
 * Two keys meant two sequential writes, and a failure on the second left the new
 * email paired with the old token — a state `status()` calls configured and
 * `environment()` injects, producing a JIRA_AUTH_FAILED that points at the
 * wrong thing. One key makes the save atomic.
 */
const CREDENTIAL_KEY = "bugpilot.jiraCredentials";

/** Environment variable names, matching what `config.py` reads. */
const TOKEN_ENV = "JIRA_TOKEN";
const EMAIL_ENV = "JIRA_EMAIL";

export interface Credentials {
  readonly email: string;
  readonly token: string;
}

export class CredentialStore {
  readonly #store: SecretStore;

  constructor(store: SecretStore) {
    this.#store = store;
  }

  /** Store both parts in one write. Rejects blanks so no half credential is saved. */
  async save(credentials: Credentials): Promise<void> {
    const email = credentials.email.trim();
    const token = credentials.token.trim();
    if (email === "" || token === "") {
      throw new Error("Both a Jira email and an API token are required.");
    }
    await this.#store.store(CREDENTIAL_KEY, JSON.stringify({ email, token }));
  }

  async clear(): Promise<void> {
    await this.#store.delete(CREDENTIAL_KEY);
  }

  /** Read the stored pair, or undefined when nothing usable is stored. */
  async #read(): Promise<Credentials | undefined> {
    const raw = await this.#store.get(CREDENTIAL_KEY);
    if (raw === undefined || raw.trim() === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt storage reads as "not configured" rather than throwing from
      // every command that asks; re-running setup overwrites it.
      return undefined;
    }
    const record = parsed as { email?: unknown; token?: unknown } | null;
    const email = typeof record?.email === "string" ? record.email.trim() : "";
    const token = typeof record?.token === "string" ? record.token.trim() : "";
    if (email === "" || token === "") return undefined;
    return { email, token };
  }

  /**
   * Whether a usable credential is stored, without producing it.
   *
   * This is what UI code asks. It deliberately cannot leak the token, so a
   * status indicator or a log line has no way to print it.
   */
  async status(): Promise<{ readonly configured: boolean; readonly email?: string }> {
    const credentials = await this.#read();
    if (!credentials) return { configured: false };
    // The email is an identifier the developer typed and expects to see echoed;
    // the token is never returned from here.
    return { configured: true, email: credentials.email };
  }

  /**
   * The environment block to spawn bugpilot with.
   *
   * Empty when nothing is stored, which lets the CLI fall back to its own
   * config file or ambient environment — a manual-mode bug needs no Jira
   * credential at all, so a missing one is not an error here.
   */
  async environment(): Promise<Record<string, string>> {
    const credentials = await this.#read();
    if (!credentials) return {};
    return { [EMAIL_ENV]: credentials.email, [TOKEN_ENV]: credentials.token };
  }
}

/**
 * Guard against a credential reaching a command line.
 *
 * Called before spawning: if a secret value ever shows up in argv, that is a
 * bug worth failing on rather than shipping, because the command line is
 * visible to every other process on the machine.
 *
 * Matching is not a bare substring test. A short secret makes substring
 * matching fire on ordinary words — a token of `"t"` matches the argument
 * `doctor` — and a guard that blocks every legitimate run is worse than no
 * guard, because it gets deleted. So two rules are combined:
 *
 *  - The shapes a credential actually arrives in are always rejected: the whole
 *    argument, or the value half of `--flag=value`. These cannot false-positive.
 *  - A substring anywhere is rejected only for a secret long enough that the
 *    match means something. Real Atlassian API tokens are far longer than this.
 */
const MIN_SUBSTRING_SECRET = 8;

export function assertNoSecretsInArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): void {
  const secrets = Object.entries(environment)
    .filter(([name]) => name === TOKEN_ENV)
    .map(([, value]) => value.trim())
    .filter((value) => value !== "");
  for (const arg of args) {
    for (const secret of secrets) {
      if (leaks(arg, secret)) {
        throw new Error(
          "Refusing to spawn bugpilot: a credential appeared in the command line, where any process could read it.",
        );
      }
    }
  }
}

function leaks(arg: string, secret: string): boolean {
  if (arg === secret) return true;
  const separator = arg.indexOf("=");
  if (separator !== -1 && arg.slice(separator + 1) === secret) return true;
  return secret.length >= MIN_SUBSTRING_SECRET && arg.includes(secret);
}
