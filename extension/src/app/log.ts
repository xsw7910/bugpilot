/**
 * Where the extension writes what it did.
 *
 * An interface rather than VS Code's `OutputChannel` so every module below the
 * host layer can log without importing `vscode` — the rule that keeps this
 * codebase testable with `node --test` (§4.1, and the phase 4 result doc).
 *
 * The one thing that must never be logged is a credential; `CredentialStore`
 * is built so the token is only ever handed out as a spawn environment.
 */
export interface Log {
  info(message: string): void;
  error(message: string): void;
}
