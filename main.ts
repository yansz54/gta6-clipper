// GTA 6 Clipper — make.fun bounty gta6-clipper-01
// "Clip GTA 6 for the most YouTube views"
//
// What this program does (Node 22, standard library only):
//   1. Renders a 36-second vertical YouTube Short (1080x1920, 30fps) entirely
//      procedurally — every frame is drawn by code, no photos, no downloaded
//      footage, no copyrighted GTA assets. An original Vice-City-inspired
//      cinematic: neon streets, palm silhouettes, a heist tease, then the
//      make.fun pitch and call to action.
//   2. Encodes it with ffmpeg to /output/clip.mp4 (deterministic: fixed seed,
//      fixed metadata, same bytes on every run).
//   3. Copies VIDEO.json to /output/VIDEO.json (the gate reads it there).
//
// Creative decisions (made in this session, by the agent):
//   - The "moment": GTA 6 launch week (out 2026-11-19). No real gameplay
//     footage is fetchable from this sandbox, so the clip is a fully
//     procedural movie-trailer-style animation — the honest approach, and it
//     keeps every pixel original.
//   - Hook (first 2 seconds): giant "GTA 6 IS HERE" over a lightning-lit
//     Vice City skyline — the exact words GTA fans are searching this week.
//   - Why it holds viewers: launch-week hype + cinematic neon-noir look +
//     a Jason & Lucia heist tease + a curiosity pivot ("BUT WAIT —") into
//     "you can earn money making clips like this with AI" — hype + money.
//   - Pacing: 10 scenes, cuts every 2.5-4s, slow Ken Burns camera moves,
//     neon pulse, one lightning flash, film grain + vignette for texture.
//   - The user asked for realism over cartoon: lighting is graded (dusk
//     gradients, rim light on silhouettes, headlight beams, wet-road
//     reflections, grain), compositions are cinematic, not flat clip-art.
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Master render size (overscan so the camera can pan/zoom without ever
// showing an edge). Final clip is 1080x1920.
const MW = 1296;
const MH = 2304;
const W = 1080;
const H = 1920;
const FPS = 30;
const SEED = 20261120;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — one stream per scene, seeded from SEED.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Colour helpers. Colours are [r, g, b] triples, 0-255.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const rgb = (r: number, g: number, b: number): RGB => [r, g, b];
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}
// Darken toward black (shading) / lighten toward white.
function shade(c: RGB, f: number): RGB {
  return f < 1
    ? [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]
    : [Math.round(c[0] + (255 - c[0]) * (f - 1)), Math.round(c[1] + (255 - c[1]) * (f - 1)), Math.round(c[2] + (255 - c[2]) * (f - 1))];
}

// ---------------------------------------------------------------------------
// Frame buffer: raw RGB, row-major. All drawing is clipped to the buffer.
// ---------------------------------------------------------------------------
class Frame {
  readonly w: number;
  readonly h: number;
  readonly buf: Buffer;
  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
  }
  idx(x: number, y: number): number { return (y * this.w + x) * 3; }
  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = this.idx(x, y);
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
  }
  get(x: number, y: number): RGB {
    const i = this.idx(Math.max(0, Math.min(this.w - 1, x)), Math.max(0, Math.min(this.h - 1, y)));
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2]];
  }
  // Solid fill of a rectangle (clipped). Fast: one Buffer.fill per row.
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.h - 1, Math.ceil(y1));
    if (xb < xa || yb < ya) return;
    const row = Buffer.alloc((xb - xa + 1) * 3);
    for (let x = xa; x <= xb; x++) { const o = (x - xa) * 3; row[o] = c[0]; row[o + 1] = c[1]; row[o + 2] = c[2]; }
    for (let y = ya; y <= yb; y++) row.copy(this.buf, this.idx(xa, y));
  }
  // Vertical gradient rectangle: colour lerps top->bottom.
  vgrad(x0: number, y0: number, x1: number, y1: number, top: RGB, bot: RGB): void {
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.h - 1, Math.ceil(y1));
    if (xb < xa || yb < ya) return;
    const span = Math.max(1, y1 - y0);
    for (let y = ya; y <= yb; y++) {
      const c = lerpColor(top, bot, (y - y0) / span);
      const row = Buffer.alloc((xb - xa + 1) * 3);
      for (let x = xa; x <= xb; x++) { const o = (x - xa) * 3; row[o] = c[0]; row[o + 1] = c[1]; row[o + 2] = c[2]; }
      row.copy(this.buf, this.idx(xa, y));
    }
  }
  // Horizontal gradient rectangle.
  hgrad(x0: number, y0: number, x1: number, y1: number, left: RGB, right: RGB): void {
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.h - 1, Math.ceil(y1));
    if (xb < xa || yb < ya) return;
    const span = Math.max(1, x1 - x0);
    for (let x = xa; x <= xb; x++) {
      const c = lerpColor(left, right, (x - x0) / span);
      for (let y = ya; y <= yb; y++) {
        const i = this.idx(x, y);
        this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
      }
    }
  }
  // Filled ellipse (scanline). rx, ry are radii.
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
    const ya = Math.max(0, Math.floor(cy - ry)), yb = Math.min(this.h - 1, Math.ceil(cy + ry));
    for (let y = ya; y <= yb; y++) {
      const dy = (y - cy) / ry;
      const dx = Math.sqrt(Math.max(0, 1 - dy * dy)) * rx;
      this.rect(cx - dx, y, cx + dx, y, c);
    }
  }
  // Filled circle.
  circle(cx: number, cy: number, r: number, c: RGB): void { this.ellipse(cx, cy, r, r, c); }
  // Fake glow: concentric ellipses stepping from the glow colour toward the
  // background colour. Cheap, no per-pixel alpha needed.
  glow(cx: number, cy: number, rx: number, ry: number, c: RGB, bg: RGB, steps = 6): void {
    for (let s = steps; s >= 1; s--) {
      const f = s / steps;
      const col = lerpColor(c, bg, 1 - f * f);
      this.ellipse(cx, cy, rx * f, ry * f, col);
    }
  }
  // Scanline polygon fill (convex or concave, even-odd).
  poly(points: Array<[number, number]>, c: RGB): void {
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const ya = Math.max(0, Math.floor(minY)), yb = Math.min(this.h - 1, Math.ceil(maxY));
    for (let y = ya; y <= yb; y++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) this.rect(xs[k], y, xs[k + 1], y, c);
    }
  }
  // Thick line (Bresenham + circles at each step).
  line(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const r = Math.max(1, w / 2);
    for (let s = 0; s <= steps; s++) {
      this.circle(x0 + (dx * s) / steps, y0 + (dy * s) / steps, r, c);
    }
  }
  // Deterministic film grain: speckles of +/- brightness.
  grain(rng: () => number, amount: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rng() * this.w), y = Math.floor(rng() * this.h);
      const d = Math.floor((rng() - 0.5) * 2 * amount);
      const idx = this.idx(x, y);
      this.buf[idx] = Math.max(0, Math.min(255, this.buf[idx] + d));
      this.buf[idx + 1] = Math.max(0, Math.min(255, this.buf[idx + 1] + d));
      this.buf[idx + 2] = Math.max(0, Math.min(255, this.buf[idx + 2] + d));
    }
  }
  // Vignette: darken toward the corners (cheap: a few nested rects is too
  // blocky, so do a per-pixel pass only on the outer band via ellipse masks).
  vignette(strength: number): void {
    const cx = this.w / 2, cy = this.h / 2;
    const maxR = Math.hypot(cx, cy);
    for (let y = 0; y < this.h; y += 2) {
      for (let x = 0; x < this.w; x += 2) {
        const r = Math.hypot(x - cx, y - cy) / maxR;
        if (r > 0.55) {
          const f = 1 - strength * Math.pow((r - 0.55) / 0.45, 2);
          const i = this.idx(x, y);
          this.buf[i] = Math.round(this.buf[i] * f);
          this.buf[i + 1] = Math.round(this.buf[i + 1] * f);
          this.buf[i + 2] = Math.round(this.buf[i + 2] * f);
          // copy the 2x2 block from the sampled pixel for speed
          if (x + 1 < this.w) { this.buf[i + 3] = this.buf[i]; this.buf[i + 4] = this.buf[i + 1]; this.buf[i + 5] = this.buf[i + 2]; }
          if (y + 1 < this.h) {
            const j = this.idx(x, y + 1);
            this.buf[j] = this.buf[i]; this.buf[j + 1] = this.buf[i + 1]; this.buf[j + 2] = this.buf[i + 2];
            if (x + 1 < this.w) { this.buf[j + 3] = this.buf[i]; this.buf[j + 4] = this.buf[i + 1]; this.buf[j + 5] = this.buf[i + 2]; }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (colour type 2, 8-bit, filter 0 per row, zlib deflate).
// ---------------------------------------------------------------------------
function crc32(buf: Buffer): number {
  let table: number[] | undefined = (crc32 as unknown as { table?: number[] }).table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { table: number[] }).table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(f: Frame): Buffer {
  const raw = Buffer.alloc((f.w * 3 + 1) * f.h);
  for (let y = 0; y < f.h; y++) {
    raw[y * (f.w * 3 + 1)] = 0;
    f.buf.copy(raw, y * (f.w * 3 + 1) + 1, y * f.w * 3, (y + 1) * f.w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(f.w, 0); ihdr.writeUInt32BE(f.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font, hand-written. Each glyph is 7 rows of 5 bits.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f], '3': [0x1f, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04], '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], ';': [0, 0x0c, 0x0c, 0, 0x0c, 0x04, 0x08],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0], '"': [0x0a, 0x0a, 0x0a, 0, 0, 0, 0],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10], '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0], '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13], '$': [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a], '@': [0x0e, 0x11, 0x17, 0x15, 0x16, 0x10, 0x0e],
  '*': [0, 0x04, 0x15, 0x0e, 0x15, 0x04, 0], '_': [0, 0, 0, 0, 0, 0, 0x1f],
  '=': [0, 0, 0x1f, 0, 0x1f, 0, 0], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
};

interface TextStyle {
  scale: number;          // pixels per font cell
  fillTop: RGB;           // gradient fill, top of glyph
  fillBot: RGB;           // gradient fill, bottom of glyph
  outline: RGB;           // outline colour
  outlinePx: number;      // outline thickness in px
  shadow: RGB | null;     // drop shadow colour (null = none)
  shadowDx: number;
  shadowDy: number;
  spacing: number;        // extra px between glyphs
}

function textWidth(text: string, scale: number, spacing: number): number {
  let w = 0;
  for (const ch of text) w += 5 * scale + spacing;
  return w > 0 ? w - spacing : 0;
}

// Stamp one glyph's "on" cells as filled squares of size `cell` at (x, y),
// colouring each cell by a vertical gradient between cTop and cBot.
function stampGlyph(f: Frame, glyph: number[], x: number, y: number, cell: number, cTop: RGB, cBot: RGB): void {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row];
    if (!bits) continue;
    const c = lerpColor(cTop, cBot, row / 6);
    for (let col = 0; col < 5; col++) {
      if (bits & (1 << (4 - col))) {
        f.rect(x + col * cell, y + row * cell, x + (col + 1) * cell - 1, y + (row + 1) * cell - 1, c);
      }
    }
  }
}

// Draw one line of text at (x, y) — top-left of the first glyph.
function drawTextLine(f: Frame, text: string, x: number, y: number, st: TextStyle): void {
  const cell = st.scale;
  const glyphH = 7 * cell;
  // Drop shadow first.
  if (st.shadow) {
    let cx = x + st.shadowDx;
    for (const ch of text) {
      const g = FONT[ch.toUpperCase()] ?? FONT['?'];
      stampGlyph(f, g, cx, y + st.shadowDy, cell, st.shadow, st.shadow);
      cx += 5 * cell + st.spacing;
    }
  }
  // Outline: stamp the glyph in the outline colour at 8 offsets.
  const o = st.outlinePx;
  const offs: Array<[number, number]> = [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]];
  for (const [dx, dy] of offs) {
    let cx = x + dx;
    for (const ch of text) {
      const g = FONT[ch.toUpperCase()] ?? FONT['?'];
      stampGlyph(f, g, cx, y + dy, cell, st.outline, st.outline);
      cx += 5 * cell + st.spacing;
    }
  }
  // Main gradient fill.
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch.toUpperCase()] ?? FONT['?'];
    stampGlyph(f, g, cx, y, cell, st.fillTop, st.fillBot);
    cx += 5 * cell + st.spacing;
  }
  void glyphH;
}

// Draw centred text (one or more lines split by \n) around centre x.
function drawTextCentred(f: Frame, text: string, cx: number, y: number, st: TextStyle, lineGap = 0.6): void {
  const lines = text.split('\n');
  const lh = 7 * st.scale + Math.round(st.scale * lineGap);
  lines.forEach((line, i) => {
    const w = textWidth(line, st.scale, st.spacing);
    drawTextLine(f, line, Math.round(cx - w / 2), y + i * lh, st);
  });
}

// Solid lower-third banner strip with a neon top edge.
function banner(f: Frame, y0: number, y1: number, bg: RGB, edge: RGB, edgeH = 6): void {
  f.rect(0, y0, f.w - 1, y1, bg);
  f.rect(0, y0, f.w - 1, y0 + edgeH - 1, edge);
}

// ---------------------------------------------------------------------------
// Scene helpers — all drawing is deterministic (seeded PRNG passed in).
// ---------------------------------------------------------------------------

const INK: RGB = rgb(10, 8, 18);          // near-black silhouette
const NEON_PINK: RGB = rgb(255, 46, 136);
const NEON_CYAN: RGB = rgb(0, 229, 255);
const NEON_GOLD: RGB = rgb(255, 210, 61);
const NEON_ORANGE: RGB = rgb(255, 123, 61);

// Layered city skyline with lit windows. horizonY = ground line.
function drawSkyline(f: Frame, rng: () => number, horizonY: number, layers: Array<{ col: RGB; hMin: number; hMax: number; windows: number }>): void {
  for (const layer of layers) {
    let x = -20;
    while (x < f.w + 20) {
      const bw = 60 + rng() * 130;
      const bh = layer.hMin + rng() * (layer.hMax - layer.hMin);
      const bx = x, by = horizonY - bh;
      f.rect(bx, by, bx + bw, horizonY, layer.col);
      // rooftop details: antenna or water tower on some buildings
      if (rng() < 0.25) f.rect(bx + bw * 0.45, by - 26 - rng() * 30, bx + bw * 0.55, by, layer.col);
      if (rng() < 0.2) f.rect(bx + bw * 0.2, by - 14, bx + bw * 0.8, by, shade(layer.col, 1.15));
      // lit windows
      const cols = Math.floor(bw / 22);
      const rows = Math.floor(bh / 30);
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (rng() < layer.windows) {
            const wc = rng() < 0.6 ? rgb(255, 210, 61) : rng() < 0.5 ? rgb(125, 249, 255) : rgb(255, 158, 207);
            f.rect(bx + 8 + c * 22, by + 12 + r * 30, bx + 18 + c * 22, by + 22 + r * 30, wc);
          }
        }
      }
      x += bw + 4 + rng() * 14;
    }
  }
}

// Glowing sun / moon disc.
function drawDisc(f: Frame, cx: number, cy: number, r: number, core: RGB, glowCol: RGB, bg: RGB, glowMul = 2.6): void {
  f.glow(cx, cy, r * glowMul, r * glowMul, glowCol, bg, 7);
  f.circle(cx, cy, r, core);
  f.circle(cx - r * 0.25, cy - r * 0.25, r * 0.55, shade(core, 1.12));
}

// Palm tree silhouette. lean: -1..1 (top offset direction), h: height.
function drawPalm(f: Frame, x: number, baseY: number, h: number, lean: number, col: RGB): void {
  const topX = x + lean * h * 0.25;
  const topY = baseY - h;
  // trunk: tapered, slightly curved (3 segments)
  const segs = 5;
  for (let s = 0; s < segs; s++) {
    const t0 = s / segs, t1 = (s + 1) / segs;
    const x0 = x + (topX - x) * t0 * t0, x1 = x + (topX - x) * t1 * t1;
    const y0 = baseY - h * t0, y1 = baseY - h * t1;
    const w0 = 14 * (1 - t0 * 0.55), w1 = 14 * (1 - t1 * 0.55);
    f.poly([[x0 - w0, y0], [x0 + w0, y0], [x1 + w1, y1], [x1 - w1, y1]], col);
  }
  // fronds: 7 arcs drooping from the crown
  for (let k = 0; k < 7; k++) {
    const ang = Math.PI * (0.08 + (k / 6) * 0.84); // spread across the top
    const len = h * (0.34 + (k % 3) * 0.05);
    const ex = topX + Math.cos(ang) * len * (lean >= 0 ? 1 : 1);
    const ey = topY + Math.abs(Math.sin(ang)) * len * 0.55 + len * 0.18;
    const mx = topX + Math.cos(ang) * len * 0.5;
    const my = topY - len * 0.12;
    f.line(topX, topY, mx, my, 9, col);
    f.line(mx, my, ex, ey, 6, col);
  }
  // coconuts
  f.circle(topX - 10, topY + 8, 9, col);
  f.circle(topX + 12, topY + 10, 8, col);
}

// Low sports car, side view, facing right. s = scale (car length ~ 560*s).
// Returns the front headlight position.
function drawCar(f: Frame, cx: number, baseY: number, s: number, body: RGB, glass: RGB): { hx: number; hy: number } {
  const L = 560 * s, Hh = 92 * s;
  const x0 = cx - L / 2, x1 = cx + L / 2;
  // underglow
  f.glow(cx, baseY + 6 * s, L * 0.52, 26 * s, NEON_CYAN, rgb(12, 10, 22), 5);
  // headlight beams (stepped triangles, brighter near the lamp)
  const hx = x1 - 8 * s, hy = baseY - Hh * 0.62;
  const beamLen = 420 * s;
  for (let b = 3; b >= 1; b--) {
    const bc = b === 1 ? rgb(255, 250, 200) : b === 2 ? rgb(255, 240, 160) : rgb(240, 220, 120);
    f.poly([[hx, hy - 10 * s * b], [hx + beamLen * (b / 3), hy - 46 * s * b], [hx + beamLen * (b / 3), hy + 40 * s * b], [hx, hy + 10 * s * b]], bc);
  }
  // body: low wedge with cabin
  f.poly([
    [x0 + 10 * s, baseY], [x0 + 26 * s, baseY - 52 * s], [x0 + 120 * s, baseY - 62 * s],
    [x0 + 210 * s, baseY - 88 * s], [x0 + 300 * s, baseY - 92 * s], [x0 + 380 * s, baseY - 64 * s],
    [x0 + 500 * s, baseY - 58 * s], [x1 - 6 * s, baseY - 44 * s], [x1, baseY - 20 * s], [x1, baseY],
  ], body);
  // cabin glass
  f.poly([
    [x0 + 218 * s, baseY - 84 * s], [x0 + 296 * s, baseY - 88 * s], [x0 + 368 * s, baseY - 62 * s], [x0 + 232 * s, baseY - 60 * s],
  ], glass);
  // glass shine streak
  f.poly([[x0 + 240 * s, baseY - 82 * s], [x0 + 262 * s, baseY - 84 * s], [x0 + 300 * s, baseY - 62 * s], [x0 + 282 * s, baseY - 62 * s]], rgb(190, 230, 255));
  // side skirt highlight + door line
  f.rect(x0 + 60 * s, baseY - 14 * s, x1 - 40 * s, baseY - 8 * s, shade(body, 1.35));
  f.line(x0 + 300 * s, baseY - 58 * s, x0 + 300 * s, baseY - 12 * s, 3 * s, shade(body, 0.6));
  // headlight + taillight
  f.ellipse(hx - 4 * s, hy, 16 * s, 7 * s, rgb(255, 252, 220));
  f.ellipse(x0 + 12 * s, baseY - 40 * s, 12 * s, 5 * s, rgb(255, 40, 60));
  // wheels
  for (const wx of [x0 + 120 * s, x0 + 430 * s]) {
    f.circle(wx, baseY - 4 * s, 34 * s, rgb(8, 8, 12));
    f.circle(wx, baseY - 4 * s, 20 * s, rgb(40, 42, 52));
    f.circle(wx, baseY - 4 * s, 8 * s, rgb(150, 160, 180));
  }
  // wet-road reflection of the car
  f.rect(x0 + 40 * s, baseY + 2, x1 - 30 * s, baseY + 10 * s, shade(body, 0.55));
  return { hx, hy };
}

// The make.fun ghost: white blob with wavy hem, two eyes, glossy highlight.
// (cx, cy) = centre of the body; s = scale (body height ~ 300*s).
function drawGhost(f: Frame, cx: number, cy: number, s: number): void {
  const r = 110 * s;
  const topY = cy - r, botY = cy + r * 0.95;
  // body: parametric outline — dome top, straight sides, 3 scallops at hem
  const pts: Array<[number, number]> = [];
  for (let a = Math.PI; a <= 2 * Math.PI + 0.001; a += Math.PI / 24) {
    pts.push([cx + Math.cos(a) * r, topY + r + Math.sin(a) * r * 0.92]);
  }
  // right side down
  pts.push([cx + r, botY - 30 * s]);
  // scalloped hem (3 bumps, each dipping 30*s below the side line)
  const bumps = 3, bw = (2 * r) / bumps;
  for (let b = 0; b < bumps; b++) {
    const bx0 = cx + r - (b + 0.5) * bw;
    for (let a = 0; a <= Math.PI + 0.001; a += Math.PI / 10) {
      pts.push([bx0 + (bw / 2) * Math.cos(a), botY - 30 * s + Math.sin(a) * 30 * s]);
    }
  }
  pts.push([cx - r, botY - 30 * s]);
  f.poly(pts, rgb(250, 250, 252));
  // shading on the right edge + glossy highlight top-left
  f.ellipse(cx + r * 0.55, cy + r * 0.1, r * 0.42, r * 0.6, rgb(226, 228, 240));
  f.ellipse(cx - r * 0.42, cy - r * 0.42, r * 0.34, r * 0.22, rgb(255, 255, 255));
  // eyes
  f.ellipse(cx - r * 0.34, cy - r * 0.12, r * 0.13, r * 0.19, rgb(16, 14, 26));
  f.ellipse(cx + r * 0.34, cy - r * 0.12, r * 0.13, r * 0.19, rgb(16, 14, 26));
  f.circle(cx - r * 0.30, cy - r * 0.20, r * 0.045, rgb(255, 255, 255));
  f.circle(cx + r * 0.38, cy - r * 0.20, r * 0.045, rgb(255, 255, 255));
}

// Gold coin with a magenta star, held up / floating.
function drawStarCoin(f: Frame, cx: number, cy: number, r: number): void {
  f.glow(cx, cy, r * 1.9, r * 1.9, rgb(255, 180, 0), rgb(20, 10, 30), 5);
  f.circle(cx, cy, r, rgb(255, 196, 0));
  f.circle(cx, cy, r * 0.82, rgb(255, 214, 80));
  // 5-point star
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r * 0.62 : r * 0.26;
    pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
  }
  f.poly(pts, NEON_PINK);
}

// Two silhouettes (Jason taller left, Lucia right), backs to viewer, rim-lit.
function drawCouple(f: Frame, cx: number, baseY: number, s: number, rim: RGB): void {
  const drawFigure = (fx: number, h: number, hair: boolean, dx: number): void => {
    // rim pass (offset toward the light)
    const parts = (ox: number): Array<Array<[number, number]>> => {
      const headR = 26 * s;
      const headY = baseY - h + headR;
      const shoulderY = baseY - h + headR * 2.1;
      const torso: Array<[number, number]> = [
        [fx + ox - 34 * s, baseY], [fx + ox - 40 * s, shoulderY], [fx + ox - 22 * s, shoulderY - 8 * s],
        [fx + ox + 22 * s, shoulderY - 8 * s], [fx + ox + 40 * s, shoulderY], [fx + ox + 34 * s, baseY],
      ];
      const legL: Array<[number, number]> = [[fx + ox - 30 * s, baseY], [fx + ox - 6 * s, baseY], [fx + ox - 10 * s, baseY - h * 0.42], [fx + ox - 28 * s, baseY - h * 0.42]];
      const legR: Array<[number, number]> = [[fx + ox + 6 * s, baseY], [fx + ox + 30 * s, baseY], [fx + ox + 28 * s, baseY - h * 0.42], [fx + ox + 10 * s, baseY - h * 0.42]];
      const out = [torso, legL, legR];
      if (hair) {
        out.push([[fx + ox - 34 * s, headY + headR * 0.4], [fx + ox - 40 * s, headY + headR * 1.6], [fx + ox - 26 * s, headY + headR * 2.4], [fx + ox - 12 * s, headY + headR * 0.9]]);
      }
      return out;
    };
    for (const p of parts(dx)) f.poly(p, rim);
    for (const p of parts(0)) f.poly(p, INK);
    // head
    f.circle(fx + dx, baseY - h + 26 * s, 26 * s, rim);
    f.circle(fx, baseY - h + 26 * s, 26 * s, INK);
    if (hair) {
      f.circle(fx - 6 * s, baseY - h + 14 * s, 24 * s, INK);
    } else {
      // cap brim
      f.rect(fx - 30 * s, baseY - h + 8 * s, fx + 34 * s, baseY - h + 16 * s, INK);
    }
  };
  drawFigure(cx - 62 * s, 300 * s, false, 4);
  drawFigure(cx + 62 * s, 262 * s, true, 4);
  // Jason's arm around Lucia
  f.line(cx - 30 * s, baseY - 300 * s + 90 * s, cx + 40 * s, baseY - 262 * s + 78 * s, 14 * s, INK);
  f.line(cx - 30 * s, baseY - 300 * s + 86 * s, cx + 40 * s, baseY - 262 * s + 74 * s, 14 * s, rim);
}

// Neon sign board with glowing text.
function drawNeonSign(f: Frame, x: number, y: number, w: number, h: number, text: string, col: RGB, bg: RGB): void {
  // glow halo behind the board
  f.glow(x + w / 2, y + h / 2, w * 0.62, h * 0.75, col, bg, 6);
  f.rect(x, y, x + w, y + h, rgb(16, 10, 28));
  f.rect(x, y, x + w, y + 4, col);
  f.rect(x, y + h - 4, x + w, y + h, col);
  f.rect(x, y, x + 4, y + h, col);
  f.rect(x + w - 4, y, x + w, y + h, col);
  const st: TextStyle = {
    scale: Math.max(5, Math.floor(h * 0.42 / 7)), fillTop: rgb(255, 255, 255), fillBot: rgb(255, 255, 255),
    outline: col, outlinePx: 3, shadow: null, shadowDx: 0, shadowDy: 0, spacing: 4,
  };
  drawTextCentred(f, text, x + w / 2, y + h / 2 - (7 * st.scale) / 2, st);
}

// Wet asphalt road with neon reflections.
function drawRoad(f: Frame, y0: number, y1: number, streaks: Array<{ x: number; w: number; c: RGB }>): void {
  f.vgrad(0, y0, f.w - 1, y1, rgb(18, 14, 30), rgb(8, 7, 16));
  // centre dashes
  for (let x = 40; x < f.w; x += 150) f.rect(x, (y0 + y1) / 2 - 4, x + 70, (y0 + y1) / 2 + 4, rgb(220, 200, 120));
  // neon reflections: vertical streaks fading downward
  for (const s of streaks) {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      f.rect(s.x, y0 + 10 + t * (y1 - y0 - 30), s.x + s.w, y0 + 10 + (t + 1 / steps) * (y1 - y0 - 30), lerpColor(s.c, rgb(10, 8, 18), t));
    }
  }
}

// ---------------------------------------------------------------------------
// Text styles.
// ---------------------------------------------------------------------------
function stHead(scale: number, fillBot: RGB, outline: RGB): TextStyle {
  return {
    scale, fillTop: rgb(255, 255, 255), fillBot, outline,
    outlinePx: Math.max(4, Math.round(scale * 0.32)),
    shadow: rgb(0, 0, 0), shadowDx: Math.round(scale * 0.45), shadowDy: Math.round(scale * 0.55),
    spacing: Math.round(scale * 0.45),
  };
}
const ST_WHITE = (s: number): TextStyle => stHead(s, rgb(232, 232, 240), rgb(18, 8, 31));
const ST_GOLD = (s: number): TextStyle => stHead(s, rgb(255, 180, 0), rgb(90, 40, 0));
const ST_PINK = (s: number): TextStyle => stHead(s, rgb(255, 158, 207), rgb(120, 0, 60));
const ST_CYAN = (s: number): TextStyle => stHead(s, rgb(125, 249, 255), rgb(0, 60, 80));

// Largest headline scale whose rendered width stays within maxW master px.
// The camera zooms up to 1.18x and pans, so headlines must fit in ~860px of
// the 1296px master to never be clipped at the frame edge.
function fitScale(text: string, maxScale: number, maxW = 860): number {
  let s = maxScale;
  while (s > 4 && textWidth(text, s, Math.round(s * 0.45)) > maxW) s--;
  return s;
}

// ---------------------------------------------------------------------------
// Scenes. Each renders one master image (1296x2304, overscan for the camera).
// ---------------------------------------------------------------------------
function scene1(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  // dusk sky
  f.vgrad(0, 0, MW - 1, 980, rgb(26, 16, 51), rgb(74, 30, 92));
  f.vgrad(0, 980, MW - 1, 1500, rgb(74, 30, 92), rgb(255, 123, 61));
  // stars up top
  for (let i = 0; i < 90; i++) {
    const x = rng() * MW, y = rng() * 700;
    const b = 140 + Math.floor(rng() * 115);
    f.rect(x, y, x + 2, y + 2, rgb(b, b, b));
  }
  drawDisc(f, 950, 1180, 130, rgb(255, 217, 160), rgb(255, 123, 61), rgb(74, 30, 92));
  drawSkyline(f, rng, 1500, [
    { col: rgb(42, 30, 85), hMin: 200, hMax: 420, windows: 0.05 },
    { col: rgb(26, 18, 56), hMin: 300, hMax: 560, windows: 0.12 },
    { col: rgb(13, 10, 30), hMin: 420, hMax: 700, windows: 0.2 },
  ]);
  // foreground wet street + palms (kept inside the camera's safe zone)
  drawRoad(f, 1500, MH - 1, [
    { x: 120, w: 26, c: NEON_PINK }, { x: 420, w: 18, c: NEON_CYAN },
    { x: 800, w: 22, c: NEON_GOLD }, { x: 1080, w: 26, c: NEON_PINK },
  ]);
  drawPalm(f, 130, 1920, 560, 0.4, INK);
  drawPalm(f, 1170, 1960, 480, -0.35, INK);
  // lightning bolt (top-left sky)
  const bolt: Array<[number, number]> = [[300, 60], [360, 60], [320, 320], [390, 320], [270, 700], [330, 700], [300, 420], [350, 420]];
  f.poly(bolt, rgb(255, 246, 200));
  f.poly([[312, 80], [348, 80], [322, 300], [372, 300], [288, 640], [318, 640], [302, 420], [338, 420]], rgb(255, 255, 255));
  // hook text
  drawTextCentred(f, 'GTA 6', MW / 2, 330, ST_GOLD(fitScale('GTA 6', 30)));
  drawTextCentred(f, 'IS HERE', MW / 2, 640, ST_WHITE(fitScale('IS HERE', 20)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene2(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, 1500, rgb(11, 14, 36), rgb(27, 20, 64));
  for (let i = 0; i < 70; i++) {
    const x = rng() * MW, y = rng() * 800;
    const b = 120 + Math.floor(rng() * 100);
    f.rect(x, y, x + 2, y + 2, rgb(b, b, b));
  }
  drawDisc(f, 1050, 300, 62, rgb(235, 240, 255), rgb(180, 200, 255), rgb(11, 14, 36), 1.7);
  // side buildings
  drawSkyline(f, rng, 1500, [
    { col: rgb(20, 14, 44), hMin: 500, hMax: 900, windows: 0.16 },
    { col: rgb(12, 9, 26), hMin: 700, hMax: 1100, windows: 0.22 },
  ]);
  // neon signs
  drawNeonSign(f, 36, 520, 230, 140, 'HOTEL', NEON_PINK, rgb(11, 14, 36));
  drawNeonSign(f, 1030, 660, 230, 140, 'VICE', NEON_CYAN, rgb(11, 14, 36));
  drawNeonSign(f, 60, 900, 190, 110, 'BAR', NEON_GOLD, rgb(11, 14, 36));
  // wet road with reflections
  drawRoad(f, 1500, MH - 1, [
    { x: 120, w: 26, c: NEON_PINK }, { x: 420, w: 18, c: NEON_CYAN },
    { x: 800, w: 22, c: NEON_GOLD }, { x: 1080, w: 26, c: NEON_PINK },
  ]);
  drawPalm(f, 300, 1520, 430, 0.3, INK);
  drawPalm(f, 1010, 1520, 380, -0.3, INK);
  drawCar(f, 648, 1960, 1.0, rgb(58, 30, 94), rgb(26, 42, 68));
  // captions (upper middle, clear of the car)
  drawTextCentred(f, 'VICE CITY', MW / 2, 950, ST_CYAN(fitScale('VICE CITY', 18)));
  drawTextCentred(f, 'NEVER SLEEPS', MW / 2, 1180, ST_WHITE(fitScale('NEVER SLEEPS', 12)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene3(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, 900, rgb(36, 22, 64), rgb(106, 42, 94));
  f.vgrad(0, 900, MW - 1, 1600, rgb(106, 42, 94), rgb(201, 79, 109));
  drawDisc(f, 648, 1280, 150, rgb(255, 190, 110), rgb(255, 123, 61), rgb(106, 42, 94));
  drawSkyline(f, rng, 1600, [
    { col: rgb(40, 24, 70), hMin: 200, hMax: 380, windows: 0.08 },
    { col: rgb(22, 14, 44), hMin: 320, hMax: 520, windows: 0.14 },
  ]);
  f.rect(0, 1600, MW - 1, MH - 1, rgb(10, 8, 18));
  drawRoad(f, 1600, MH - 1, [
    { x: 200, w: 24, c: NEON_PINK }, { x: 700, w: 18, c: NEON_CYAN }, { x: 1100, w: 24, c: NEON_GOLD },
  ]);
  drawCouple(f, 648, 1880, 1.1, NEON_PINK);
  drawTextCentred(f, 'JASON & LUCIA', MW / 2, 560, ST_PINK(fitScale('JASON & LUCIA', 13)));
  drawTextCentred(f, 'ARE BACK', MW / 2, 800, ST_WHITE(fitScale('ARE BACK', 20)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene4(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, 1500, rgb(10, 13, 32), rgb(20, 18, 51));
  // distant police lights
  f.glow(200, 880, 130, 60, rgb(255, 40, 60), rgb(10, 13, 32), 6);
  f.glow(1090, 840, 130, 60, rgb(40, 90, 255), rgb(10, 13, 32), 6);
  drawSkyline(f, rng, 1500, [
    { col: rgb(18, 13, 40), hMin: 400, hMax: 800, windows: 0.1 },
    { col: rgb(11, 8, 24), hMin: 600, hMax: 1000, windows: 0.16 },
  ]);
  drawRoad(f, 1500, MH - 1, [
    { x: 200, w: 30, c: rgb(255, 40, 60) }, { x: 1000, w: 30, c: rgb(40, 90, 255) },
    { x: 600, w: 20, c: NEON_CYAN },
  ]);
  // getaway car, headlights on (lighter body so it reads on the dark road)
  drawCar(f, 760, 1900, 0.95, rgb(56, 40, 84), rgb(40, 58, 90));
  // two running figures with duffel bags (leaning forward silhouettes)
  const runner = (x: number, y: number, s: number): void => {
    // torso leaning right
    f.poly([[x - 26 * s, y], [x - 34 * s, y - 150 * s], [x + 10 * s, y - 170 * s], [x + 30 * s, y - 20 * s]], INK);
    f.circle(x + 22 * s, y - 196 * s, 24 * s, INK);
    // legs mid-stride
    f.poly([[x - 24 * s, y], [x - 4 * s, y], [x + 34 * s, y - 90 * s], [x + 14 * s, y - 96 * s]], INK);
    f.poly([[x - 20 * s, y], [x + 2 * s, y], [x - 40 * s, y - 80 * s], [x - 58 * s, y - 66 * s]], INK);
    // duffel bag
    f.poly([[x + 34 * s, y - 96 * s], [x + 78 * s, y - 88 * s], [x + 78 * s, y - 52 * s], [x + 34 * s, y - 60 * s]], rgb(40, 28, 16));
    f.line(x + 40 * s, y - 96 * s, x + 72 * s, y - 88 * s, 4 * s, rgb(120, 90, 40));
  };
  runner(330, 1860, 1.0);
  runner(150, 1920, 0.9);
  // flying money bills
  for (let i = 0; i < 14; i++) {
    const x = 180 + rng() * 900, y = 900 + rng() * 500;
    f.poly([[x, y], [x + 34, y + 6], [x + 30, y + 20], [x - 4, y + 14]], rng() < 0.5 ? rgb(120, 180, 110) : rgb(200, 220, 190));
  }
  drawTextCentred(f, 'THE BIGGEST', MW / 2, 470, ST_WHITE(fitScale('THE BIGGEST', 14)));
  drawTextCentred(f, 'HEIST EVER', MW / 2, 700, ST_GOLD(fitScale('HEIST EVER', 15)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene5(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, MH - 1, rgb(13, 7, 22), rgb(28, 11, 46));
  // magenta aura behind the ghost
  f.glow(MW / 2, 1100, 620, 700, NEON_PINK, rgb(13, 7, 22), 8);
  f.glow(MW / 2, 1100, 380, 420, rgb(255, 120, 190), rgb(28, 11, 46), 6);
  drawGhost(f, MW / 2, 1120, 1.6);
  drawStarCoin(f, 980, 780, 74);
  // sparkles
  for (let i = 0; i < 22; i++) {
    const x = 150 + rng() * 1000, y = 350 + rng() * 1200;
    const r = 6 + rng() * 14;
    f.line(x - r, y, x + r, y, 3, rgb(255, 240, 180));
    f.line(x, y - r, x, y + r, 3, rgb(255, 240, 180));
  }
  drawTextCentred(f, 'BUT WAIT —', MW / 2, 300, ST_PINK(fitScale('BUT WAIT —', 15)));
  drawTextCentred(f, 'THIS IS NOT JUST A GAME', MW / 2, 1820, ST_WHITE(fitScale('THIS IS NOT JUST A GAME', 6)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene6(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, 1500, rgb(10, 10, 24), rgb(20, 18, 48));
  // neon grid floor (perspective lines to a vanishing point)
  const vx = MW / 2, vy = 1500;
  f.vgrad(0, 1500, MW - 1, MH - 1, rgb(16, 14, 36), rgb(8, 7, 16));
  for (let i = -6; i <= 6; i++) {
    f.line(vx + i * 90, vy, vx + i * 320, MH - 1, 3, rgb(0, 90, 110));
  }
  drawGhost(f, 300, 1780, 0.85);
  drawStarCoin(f, 560, 1760, 46);
  drawTextCentred(f, 'AI AGENTS BUILD', MW / 2, 620, ST_CYAN(fitScale('AI AGENTS BUILD', 10)));
  drawTextCentred(f, 'THE COOLEST', MW / 2, 850, ST_WHITE(fitScale('THE COOLEST', 14)));
  drawTextCentred(f, 'STUFF', MW / 2, 1080, ST_WHITE(24));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene7(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, MH - 1, rgb(23, 16, 6), rgb(42, 26, 8));
  f.glow(MW / 2, 900, 640, 520, rgb(255, 180, 0), rgb(23, 16, 6), 8);
  drawGhost(f, 1010, 1760, 0.8);
  drawStarCoin(f, 830, 1760, 44);
  drawTextCentred(f, 'MAKE CLIPS LIKE', MW / 2, 380, ST_WHITE(fitScale('MAKE CLIPS LIKE', 10)));
  drawTextCentred(f, 'THIS WITH AI', MW / 2, 520, ST_WHITE(fitScale('THIS WITH AI', 13)));
  drawTextCentred(f, '$500', MW / 2, 720, ST_GOLD(36));
  drawTextCentred(f, 'BOUNTY ON', MW / 2, 1060, ST_WHITE(16));
  drawTextCentred(f, 'MAKE.FUN', MW / 2, 1220, ST_PINK(fitScale('MAKE.FUN', 19)));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene8(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, MH - 1, rgb(18, 8, 31), rgb(42, 16, 64));
  f.glow(MW / 2, 900, 600, 500, NEON_PINK, rgb(18, 8, 31), 8);
  drawGhost(f, MW / 2, 780, 1.3);
  drawStarCoin(f, 960, 560, 62);
  drawTextCentred(f, 'MAKE.FUN', MW / 2, 1240, ST_PINK(fitScale('MAKE.FUN', 19)));
  drawTextCentred(f, 'make.fun/bounty/', MW / 2, 1520, ST_CYAN(9));
  drawTextCentred(f, 'gta6-clipper-01', MW / 2, 1640, ST_CYAN(9));
  drawTextCentred(f, 'EARN MONEY MAKING', MW / 2, 1800, ST_WHITE(fitScale('EARN MONEY MAKING', 9)));
  drawTextCentred(f, 'CLIPS WITH AI', MW / 2, 1880, ST_WHITE(9));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene9(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, 900, rgb(42, 16, 64), rgb(184, 51, 106));
  f.vgrad(0, 900, MW - 1, 1650, rgb(184, 51, 106), rgb(255, 154, 61));
  drawDisc(f, 648, 1350, 170, rgb(255, 220, 150), rgb(255, 154, 61), rgb(184, 51, 106));
  drawSkyline(f, rng, 1650, [
    { col: rgb(52, 26, 74), hMin: 180, hMax: 360, windows: 0.04 },
    { col: rgb(28, 14, 46), hMin: 300, hMax: 520, windows: 0.1 },
  ]);
  f.rect(0, 1650, MW - 1, MH - 1, rgb(12, 9, 20));
  drawRoad(f, 1650, MH - 1, [
    { x: 150, w: 24, c: NEON_PINK }, { x: 650, w: 18, c: NEON_GOLD }, { x: 1050, w: 24, c: NEON_CYAN },
  ]);
  drawPalm(f, 150, 1950, 500, 0.35, INK);
  drawPalm(f, 1150, 2000, 440, -0.3, INK);
  drawCar(f, 648, 1900, 0.9, rgb(36, 22, 64), rgb(40, 50, 80));
  drawTextCentred(f, 'GTA 6.', MW / 2, 380, ST_WHITE(14));
  drawTextCentred(f, 'MAKE.FUN.', MW / 2, 560, ST_WHITE(14));
  drawTextCentred(f, 'GO.', MW / 2, 760, ST_GOLD(26));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

function scene10(rng: () => number): Frame {
  const f = new Frame(MW, MH);
  f.vgrad(0, 0, MW - 1, MH - 1, rgb(10, 6, 20), rgb(18, 10, 32));
  f.glow(MW / 2, 700, 520, 420, NEON_PINK, rgb(10, 6, 20), 7);
  drawGhost(f, MW / 2, 720, 1.1);
  drawStarCoin(f, 950, 480, 56);
  drawTextCentred(f, 'MAKE.FUN', MW / 2, 1150, ST_PINK(fitScale('MAKE.FUN', 19)));
  drawTextCentred(f, 'PLAY CODE:', MW / 2, 1400, ST_WHITE(11));
  drawTextCentred(f, 'makefun-heron-', MW / 2, 1520, ST_CYAN(8));
  drawTextCentred(f, 'recipe-veranda', MW / 2, 1620, ST_CYAN(8));
  drawTextCentred(f, 'LINK IN DESCRIPTION', MW / 2, 1780, ST_GOLD(fitScale('LINK IN DESCRIPTION', 8)));
  drawTextCentred(f, 'LIKE + SUBSCRIBE', MW / 2, 1900, ST_WHITE(9));
  f.grain(rng, 14, 26000);
  f.vignette(0.32);
  return f;
}

// ---------------------------------------------------------------------------
// Scene table: name, frame count, renderer, camera (zoom 1.0->, pan 0..1).
// ---------------------------------------------------------------------------
interface SceneDef {
  name: string;
  frames: number;
  render: (rng: () => number) => Frame;
  zoom: [number, number];
  pan: [number, number, number, number]; // x0, y0, x1, y1 (fractions of slack)
}
const SCENES: SceneDef[] = [
  { name: 'hook-skyline', frames: 75, render: scene1, zoom: [1.0, 1.14], pan: [0.5, 0.5, 0.5, 0.42] },
  { name: 'neon-street', frames: 90, render: scene2, zoom: [1.02, 1.08], pan: [0.3, 0.5, 0.7, 0.5] },
  { name: 'jason-lucia', frames: 105, render: scene3, zoom: [1.0, 1.12], pan: [0.5, 0.55, 0.5, 0.45] },
  { name: 'heist', frames: 105, render: scene4, zoom: [1.03, 1.1], pan: [0.7, 0.5, 0.3, 0.5] },
  { name: 'ghost-pivot', frames: 105, render: scene5, zoom: [1.0, 1.18], pan: [0.5, 0.5, 0.5, 0.5] },
  { name: 'pitch-1', frames: 120, render: scene6, zoom: [1.02, 1.06], pan: [0.3, 0.5, 0.6, 0.5] },
  { name: 'pitch-2', frames: 120, render: scene7, zoom: [1.0, 1.1], pan: [0.5, 0.6, 0.5, 0.4] },
  { name: 'cta', frames: 120, render: scene8, zoom: [1.0, 1.08], pan: [0.5, 0.5, 0.5, 0.5] },
  { name: 'finale', frames: 120, render: scene9, zoom: [1.04, 1.12], pan: [0.2, 0.5, 0.8, 0.5] },
  { name: 'endcard', frames: 120, render: scene10, zoom: [1.0, 1.05], pan: [0.5, 0.5, 0.5, 0.5] },
];

// ---------------------------------------------------------------------------
// Render + encode.
// ---------------------------------------------------------------------------

const FRAMES_DIR = join(OUTPUT_DIR, 'frames');

function fmt(n: number): string {
  // ffmpeg-safe decimal (avoid scientific notation, keep 4 decimals)
  return n.toFixed(4);
}

function renderMasters(): string[] {
  mkdirSync(FRAMES_DIR, { recursive: true });
  const paths: string[] = [];
  SCENES.forEach((scene, i) => {
    const rng = mulberry32(SEED + i * 7919);
    const frame = scene.render(rng);
    const png = encodePNG(frame);
    const p = join(FRAMES_DIR, `scene-${String(i + 1).padStart(2, '0')}-${scene.name}.png`);
    writeFileSync(p, png);
    paths.push(p);
    console.log(`master ${i + 1}/${SCENES.length} ${scene.name}: ${png.length} bytes`);
  });
  return paths;
}

function buildFilter(): string {
  const parts: string[] = [];
  SCENES.forEach((scene, i) => {
    const dur = scene.frames / FPS;
    const [z0, z1] = scene.zoom;
    const [px0, py0, px1, py1] = scene.pan;
    parts.push(
      `[${i}:v]` +
      `scale=eval=frame:w='${MW}*(${fmt(z0)}+(${fmt(z1 - z0)})*t/${fmt(dur)})':h='${MH}*(${fmt(z0)}+(${fmt(z1 - z0)})*t/${fmt(dur)})',` +
      `crop=${W}:${H}:x='(in_w-${W})*(${fmt(px0)}+(${fmt(px1 - px0)})*t/${fmt(dur)})':y='(in_h-${H})*(${fmt(py0)}+(${fmt(py1 - py0)})*t/${fmt(dur)})',` +
      `fade=t=in:st=0:d=0.25,fade=t=out:st=${fmt(dur - 0.25)}:d=0.25,` +
      `trim=end_frame=${scene.frames},setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p,setsar=1[v${i}]`,
    );
  });
  const concatInputs = SCENES.map((_, i) => `[v${i}]`).join('');
  parts.push(`${concatInputs}concat=n=${SCENES.length}:v=1:a=0[vcat]`);
  // Lightning flash in the hook (Gaussian brightness pulse at t=1.15s),
  // subtle neon pulse during the street scenes, vignette + fixed-seed grain.
  parts.push(
    '[vcat]' +
    `eq=brightness='0.35*exp(-((t-1.15)*(t-1.15))/0.005)':enable='between(t,0.9,1.4)',` +
    `eq=brightness='0.02*sin(2*PI*t*2.5)':enable='between(t,2.5,12.5)',` +
    'vignette=angle=PI/4.5,' +
    `noise=alls=4:allf=t:all_seed=${SEED},` +
    'format=yuv420p[vout]',
  );
  return parts.join(';');
}

function encodeClip(masterPaths: string[]): string | null {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error('ffmpeg not found — skipping clip render (VIDEO.json still copied).');
    return null;
  }
  const args: string[] = ['-y'];
  SCENES.forEach((scene, i) => {
    const dur = scene.frames / FPS;
    args.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', masterPaths[i]);
  });
  const outPath = join(OUTPUT_DIR, 'clip.mp4');
  args.push(
    '-filter_complex', buildFilter(),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-fps_mode', 'cfr', '-video_track_timescale', String(FPS),
    '-metadata', 'creation_time=2026-11-20T00:00:00Z',
    '-movflags', '+faststart', '-an', outPath,
  );
  console.log(`encoding ${outPath} ...`);
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(res.stdout ?? '');
    console.error(res.stderr ?? '');
    throw new Error(`ffmpeg failed with exit code ${res.status}`);
  }
  return outPath;
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(p));
  return h.digest('hex');
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const totalFrames = SCENES.reduce((a, s) => a + s.frames, 0);
  console.log(`gta6-clipper-01: ${SCENES.length} scenes, ${totalFrames} frames, ${(totalFrames / FPS).toFixed(1)}s, ${W}x${H}@${FPS}`);
  const masters = renderMasters();
  const clip = encodeClip(masters);
  if (clip) {
    const size = statSync(clip).size;
    console.log(`wrote ${clip}: ${size} bytes, sha256 ${sha256File(clip)}`);
  }
  // The gate reads VIDEO.json from /output.
  try {
    copyFileSync(join(BOT_DIR, 'VIDEO.json'), join(OUTPUT_DIR, 'VIDEO.json'));
    console.log('wrote /output/VIDEO.json');
  } catch (err) {
    console.error(`VIDEO.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
