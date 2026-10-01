/**
 * Pasted and dropped attachments: what each one is called, and whether it is
 * already attached.
 *
 * The page hands over bytes; the host stores them under a directory named by
 * their digest and the file name chosen here. Content, not a path, decides
 * "already attached": the same screenshot pasted twice, or dropped after it
 * was pasted, lands on the same digest.
 */

import { createHash } from "node:crypto";

/** The first 16 hex characters of the content's SHA-256: a directory name, and the identity of a pasted file. */
export function attachmentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Whether a list already holds a file stored under this digest. */
export function holdsDigest(attachments: readonly string[], digest: string): boolean {
  return attachments.some((path) => path.split(/[\\/]/).includes(digest));
}

/** What a clipboard image arrives named when it was never a file: Chromium calls them all image.png. */
const UNNAMED_IMAGE = /^image\.(png|jpe?g|gif|webp|bmp)$/i;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/**
 * The name a pasted or dropped file is stored and attached under.
 *
 * A real file keeps its own name, made safe for every file system the work
 * item may be copied to. An image with no name of its own — a screenshot from
 * the clipboard — is `screenshot-N.<ext>`, N one past the highest already
 * attached, so the list reads screenshot-1, screenshot-2 and never a
 * timestamp. Anything else nameless is `attachment-N`.
 */
export function attachmentFileName(name: string, type: string, attachments: readonly string[]): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    // Characters Windows refuses in a file name, and control characters.
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  const image = IMAGE_EXTENSIONS[type.toLowerCase()];
  if (base !== "" && !(image && UNNAMED_IMAGE.test(base))) return base;
  const stem = image ? "screenshot" : "attachment";
  const extension = image ? `.${image}` : "";
  const taken = attachments
    .map((path) => path.split(/[\\/]/).pop() ?? "")
    .map((existing) => new RegExp(`^${stem}-(\\d+)\\.`, "i").exec(existing) ?? new RegExp(`^${stem}-(\\d+)$`, "i").exec(existing))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return `${stem}-${Math.max(0, ...taken) + 1}${extension}`;
}
