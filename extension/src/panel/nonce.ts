/**
 * The CSP nonce for a panel load.
 *
 * A nonce is a security control, not a cache-buster: the Content-Security-Policy
 * allows exactly the script carrying this value, so anything injected into the
 * page can only run by guessing it. `Math.random()` is seeded predictably and is
 * not built to resist that, so this uses the crypto RNG.
 *
 * Kept in its own module rather than inside `provider.ts` because that file
 * imports `vscode` and therefore cannot be unit-tested.
 */

import { randomBytes } from "node:crypto";

/** Characters that need no escaping inside a CSP header or an HTML attribute. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 24 characters of the alphabet above: ~143 bits, well past guessing. */
export const NONCE_LENGTH = 24;

export function createNonce(): string {
  // One byte per character, mapped by modulo. The slight bias that modulo
  // introduces across 62 symbols is irrelevant at this length, and rejection
  // sampling here would be complexity for no security gain.
  return [...randomBytes(NONCE_LENGTH)]
    .map((byte) => ALPHABET.charAt(byte % ALPHABET.length))
    .join("");
}
