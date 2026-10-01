/**
 * Pasted and dropped attachments (§37.98): what each is named, and when one is
 * already attached.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { attachmentDigest, attachmentFileName, holdsDigest } from "../src/app/attachmentFiles.ts";

test("a clipboard screenshot is screenshot-N, one past the highest attached", () => {
  assert.equal(attachmentFileName("image.png", "image/png", []), "screenshot-1.png");
  assert.equal(attachmentFileName("", "image/png", ["/s/aaa/screenshot-1.png"]), "screenshot-2.png");
  assert.equal(attachmentFileName("image.png", "image/jpeg", ["/s/a/screenshot-1.png", "C:\\s\\b\\screenshot-4.jpg"]), "screenshot-5.jpg");
  // No timestamp anywhere in the name.
  assert.doesNotMatch(attachmentFileName("", "image/png", []), /\d{6,}/);
});

test("a file with a real name keeps it, made safe for every file system", () => {
  assert.equal(attachmentFileName("error.log", "text/plain", []), "error.log");
  assert.equal(attachmentFileName("Login dialog.png", "image/png", []), "Login dialog.png");
  assert.equal(attachmentFileName('C:\\fake\\a:b*c?.txt', "text/plain", []), "a_b_c_.txt");
  assert.equal(attachmentFileName("..\\..\\escape.log", "", []), "escape.log");
  assert.equal(attachmentFileName("", "application/octet-stream", ["/s/x/attachment-1"]), "attachment-2");
});

test("the same bytes are the same digest, and a list holding it is found by its directory", () => {
  const bytes = new TextEncoder().encode("console output");
  const digest = attachmentDigest(bytes);
  assert.match(digest, /^[0-9a-f]{16}$/);
  assert.equal(attachmentDigest(new TextEncoder().encode("console output")), digest);
  assert.notEqual(attachmentDigest(new TextEncoder().encode("other")), digest);
  assert.equal(holdsDigest([`C:\\storage\\attachments\\${digest}\\screenshot-1.png`], digest), true);
  // A path that merely contains the characters is not that directory.
  assert.equal(holdsDigest([`/home/me/x${digest}y/file.png`], digest), false);
});
