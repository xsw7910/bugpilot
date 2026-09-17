import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NONCE_LENGTH, createNonce } from "../src/panel/nonce.ts";

test("a nonce is unguessable, which is the whole point of it", () => {
  // The CSP allows exactly the script carrying this value, so anything injected
  // into the page can only run by guessing it. Math.random() is seeded
  // predictably and is not built to resist that.
  // Comments stripped first: the file explains why the weak RNG is wrong, and a
  // plain grep finds that sentence rather than a real use of it.
  const source = readFileSync(new URL("../src/panel/nonce.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  assert.match(source, /node:crypto/);
  assert.equal(source.includes("Math.random"), false);
});

test("nonces differ every time and are attribute-safe", () => {
  const values = new Set(Array.from({ length: 200 }, () => createNonce()));
  assert.equal(values.size, 200, "a repeated nonce would let a cached script run");
  for (const value of values) {
    assert.equal(value.length, NONCE_LENGTH);
    // No quote, space or angle bracket: it goes into a header and an attribute.
    assert.match(value, /^[A-Za-z0-9]+$/);
  }
});
