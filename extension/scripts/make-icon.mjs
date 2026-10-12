/**
 * Draw `media/icon.png`, the extension's Marketplace icon.
 *
 * Run with: node scripts/make-icon.mjs [size] [output]
 *
 * Why a script rather than a checked-in image nobody can edit: the icon has to
 * be a PNG — vsce refuses an SVG outright (`SVGs can't be used as icons`) — and
 * this machine has no rasterizer, no Pillow, no ImageMagick. Generating it keeps
 * the asset reproducible and reviewable.
 *
 * The mark is the codicons `bug` icon, read from `media/bug.svg` — an unmodified
 * copy of `src/icons/bug.svg` in microsoft/vscode-codicons, © Microsoft
 * Corporation, CC BY 4.0 (see `THIRD_PARTY_NOTICES.md`). This script adapts it,
 * and says so there: the icon's path is filled in a near-white on BugPilot's
 * slate tile. Nothing of the drawing is BugPilot's own but the tile.
 *
 * The codicon is drawn for 16px, so it holds at the 32px the Extensions list
 * shows far more often than the full size.
 */

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXTENSION = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/**
 * The grid the tile and the glyph are placed on.
 *
 * Separate from the output size so the same drawing can be rendered small —
 * `node scripts/make-icon.mjs 32 <preview.png>` shows the mark at the size the
 * Extensions list actually uses.
 */
const DESIGN = 256;
const SIZE = Number(process.argv[2] ?? 256);
/** Sub-samples per axis. Four is enough for edges this smooth to look clean. */
const SAMPLES = 4;
/** Design units per icon unit: the 16-unit codicon spans about 60% of the tile. */
const GLYPH_SCALE = 11;

// A slate tile with a near-white glyph. Two colours only: at 32px anything more
// turns to mush, and the tile carries its own background on both Marketplace
// themes.
const TILE = [0x26, 0x32, 0x38, 0xff];
const GLYPH = [0xec, 0xef, 0xf4, 0xff];

/** Signed distance to a rounded rectangle, given its centre and half-extents. */
function roundedRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
}

// --- the icon: media/bug.svg, read as it is -------------------------------

/** The SVG's path data and fill rule. One path, as the codicons ship them. */
function readIcon(file) {
  const svg = readFileSync(file, "utf8");
  const paths = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
  if (paths.length !== 1) throw new Error(`${file}: expected one <path>, found ${paths.length}`);
  const evenOdd = /fill-rule="evenodd"/.test(svg);
  return { d: paths[0], evenOdd };
}

/**
 * The path's outline as closed polygons, in icon units: M, L, H, V, C, S, Q,
 * T and Z, absolute or relative. Curves are flattened finely enough that no
 * facet shows at 256px. An arc is refused rather than guessed: the codicon has
 * none, and a new icon that does needs this extended, not approximated.
 */
function polygons(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const result = [];
  let current = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;
  let command = "";
  let i = 0;
  const number = () => Number(tokens[i++]);
  const close = () => {
    if (current.length > 2) result.push(current);
    current = [];
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    for (let step = 1; step <= 24; step++) {
      const t = step / 24;
      const u = 1 - t;
      current.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    lastControl = [x2, y2];
    x = x3;
    y = y3;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M": {
        close();
        x = ox + number();
        y = oy + number();
        startX = x;
        startY = y;
        current.push([x, y]);
        // Further pairs after a moveto are linetos.
        command = relative ? "l" : "L";
        lastControl = null;
        break;
      }
      case "L":
        x = ox + number();
        y = oy + number();
        current.push([x, y]);
        lastControl = null;
        break;
      case "H":
        x = ox + number();
        current.push([x, y]);
        lastControl = null;
        break;
      case "V":
        y = oy + number();
        current.push([x, y]);
        lastControl = null;
        break;
      case "C": {
        const x1 = ox + number(), y1 = oy + number(), x2 = ox + number(), y2 = oy + number();
        cubic(x1, y1, x2, y2, ox + number(), oy + number());
        break;
      }
      case "S": {
        const [cx, cy] = lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
        const x2 = ox + number(), y2 = oy + number();
        cubic(cx, cy, x2, y2, ox + number(), oy + number());
        break;
      }
      case "Q":
      case "T": {
        const [qx, qy] =
          command.toUpperCase() === "Q"
            ? [ox + number(), oy + number()]
            : lastControl
              ? [2 * x - lastControl[0], 2 * y - lastControl[1]]
              : [x, y];
        const ex = ox + number(), ey = oy + number();
        // A quadratic as the cubic with the same curve.
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        lastControl = [qx, qy];
        break;
      }
      case "Z":
        x = startX;
        y = startY;
        close();
        lastControl = null;
        break;
      default:
        throw new Error(`path command ${command} is not supported by make-icon.mjs`);
    }
  }
  close();
  return result;
}

/**
 * Coverage of the glyph at every output pixel, by scanlines: for each sample
 * row, the polygon edges' crossings, sorted, give inside and outside along it
 * (non-zero winding, or even-odd when the SVG says so).
 */
function glyphCoverage(icon) {
  const outline = polygons(icon.d);
  const xs = outline.flat().map(([px]) => px);
  const ys = outline.flat().map(([, py]) => py);
  // Centred on the tile by its own bounds, not the 16-unit box.
  const offsetX = DESIGN / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * GLYPH_SCALE;
  const offsetY = DESIGN / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * GLYPH_SCALE;
  const edges = [];
  for (const polygon of outline) {
    for (let k = 0; k < polygon.length; k++) {
      const [ax, ay] = polygon[k];
      const [bx, by] = polygon[(k + 1) % polygon.length];
      if (ay !== by) edges.push([ax * GLYPH_SCALE + offsetX, ay * GLYPH_SCALE + offsetY, bx * GLYPH_SCALE + offsetX, by * GLYPH_SCALE + offsetY]);
    }
  }
  const scale = DESIGN / SIZE;
  const coverage = new Float64Array(SIZE * SIZE);
  for (let row = 0; row < SIZE * SAMPLES; row++) {
    const sampleY = ((row + 0.5) / SAMPLES) * scale;
    const crossings = [];
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= sampleY && by > sampleY) || (by <= sampleY && ay > sampleY)) {
        crossings.push([ax + ((sampleY - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1]);
      }
    }
    crossings.sort((a, b) => a[0] - b[0]);
    const py = Math.floor(row / SAMPLES);
    let next = 0;
    let winding = 0;
    for (let column = 0; column < SIZE * SAMPLES; column++) {
      const sampleX = ((column + 0.5) / SAMPLES) * scale;
      while (next < crossings.length && crossings[next][0] <= sampleX) winding += crossings[next++][1];
      const inside = icon.evenOdd ? winding % 2 !== 0 : winding !== 0;
      if (inside) coverage[py * SIZE + Math.floor(column / SAMPLES)] += 1 / (SAMPLES * SAMPLES);
    }
  }
  return coverage;
}

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
  const glyph = glyphCoverage(readIcon(path.join(EXTENSION, "media", "bug.svg")));

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const onTile = coverage(tile, px, py, scale);
      const onGlyph = Math.min(1, glyph[py * SIZE + px]);
      const offset = (py * SIZE + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(mix(TILE[channel], GLYPH[channel], onGlyph));
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
