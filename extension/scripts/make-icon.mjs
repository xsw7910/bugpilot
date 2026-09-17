/**
 * Draw `media/icon.png`, the extension's Marketplace icon.
 *
 * Run with: node scripts/make-icon.mjs
 *
 * Why a script rather than a checked-in image nobody can edit: the icon has to
 * be a PNG — vsce refuses an SVG outright (`SVGs can't be used as icons`) — and
 * this machine has no rasterizer, no Pillow, no ImageMagick. Generating it from
 * shapes keeps the asset reproducible and reviewable: the mark is the same bug
 * as `media/bug.svg`, described here in numbers instead of bezier curves.
 *
 * The glyph is deliberately heavy. This image is shown at 32px in the
 * Extensions list far more often than at its full size, and thin legs
 * disappear there.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The grid every shape below is described on.
 *
 * Separate from the output size so the same drawing can be rendered small —
 * `node scripts/make-icon.mjs 32 /tmp/preview.png` is how the mark was checked
 * at the size the Extensions list actually shows it, which is where thin legs
 * turn to mush.
 */
const DESIGN = 256;
const SIZE = Number(process.argv[2] ?? 256);
/** Sub-samples per axis. Four is enough for edges this smooth to look clean. */
const SAMPLES = 4;

// A slate tile with a near-white bug. Two colours only: at 32px anything more
// turns to mush, and the tile carries its own background on both Marketplace
// themes.
const TILE = [0x26, 0x32, 0x38, 0xff];
const GLYPH = [0xec, 0xef, 0xf4, 0xff];

/** Signed distance to a circle: negative inside. */
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

/** Signed distance to a thick line segment — a leg, an antenna, a seam. */
function capsule(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - r;
}

/** Signed distance to a rounded rectangle, given its centre and half-extents. */
function roundedRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
}

/** The bug, mirrored about the vertical centre line. */
function bug(x, y) {
  // DESIGN, not SIZE: the shapes live on the design grid, and mirroring about
  // the output size folded the legs off the tile at any size but 256.
  const mirrored = DESIGN - x;
  // Kept clear of the tile edge, and thick enough to survive 32px: at that
  // size a leg is three pixels wide, and eight design units would be two.
  const legs = (px) =>
    Math.min(
      capsule(px, y, 86, 118, 58, 100, 10),
      capsule(px, y, 84, 148, 52, 148, 10),
      capsule(px, y, 86, 178, 58, 196, 10),
    );
  return Math.min(
    // Head, then body: two overlapping shapes rather than one outline, so the
    // waist between them comes out of the geometry.
    circle(x, y, 128, 76, 30),
    roundedRect(x, y, 128, 150, 46, 58, 42),
    // Antennae.
    capsule(x, y, 112, 58, 98, 36, 8),
    capsule(mirrored, y, 112, 58, 98, 36, 8),
    legs(x),
    legs(mirrored),
  );
}

/** The shell split, cut back out of the body so the mark reads as a beetle. */
const seam = (x, y) => capsule(x, y, 128, 104, 128, 196, 5);

/** Coverage of a shape at one pixel, from its signed distance at sub-samples. */
function coverage(shape, px, py, scale) {
  let inside = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = (px + (sx + 0.5) / SAMPLES) * scale;
      const y = (py + (sy + 0.5) / SAMPLES) * scale;
      if (shape(x, y) <= 0) inside += 1;
    }
  }
  return inside / (SAMPLES * SAMPLES);
}

function mix(under, over, alpha) {
  return under + (over - under) * alpha;
}

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const tile = (x, y) => roundedRect(x, y, DESIGN / 2, DESIGN / 2, DESIGN / 2, DESIGN / 2, 46);
  // Pixel centres in design units, so the drawing is resolution-independent.
  const scale = DESIGN / SIZE;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const onTile = coverage(tile, px, py, scale);
      // The glyph, minus the seam: subtracting it here rather than painting the
      // tile colour back over keeps the seam crisp at any size.
      const onGlyph = Math.max(
        0,
        coverage(bug, px, py, scale) - coverage(seam, px, py, scale),
      );

      const offset = (py * SIZE + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(
          mix(TILE[channel], GLYPH[channel], onGlyph),
        );
      }
      // Transparent outside the tile: the corners are rounded, and the
      // Marketplace draws its own background behind them.
      pixels[offset + 3] = Math.round(255 * onTile);
    }
  }
  return pixels;
}

// --- PNG container ---------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Compression, filter and interlace methods: the only values PNG defines.
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // One filter byte per scanline. Filter 0 (none) — the image is a flat mark,
  // so a smarter filter would save a few hundred bytes and cost clarity here.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const target =
  process.argv[3] ??
  path.join(
    path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
    "media",
    "icon.png",
  );
const file = png(render());
writeFileSync(target, file);
console.log(`icon ok: ${SIZE}x${SIZE}, ${(file.length / 1024).toFixed(1)} KB, ${target}`);
