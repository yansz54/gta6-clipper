// gta6-clipper-01 v2 — "Vice City Nights, Real Life" (Node 22, standard library only).
//
// A 36-second vertical YouTube Short for make.fun's "Clip GTA 6 for the most
// YouTube views" bounty ($500 in USDC). Every frame is drawn procedurally by
// code — no photos, no copyrighted GTA assets — but rendered as close to
// real life as code can get: smooth vector shapes (no pixel-art), clean bold
// sans lettering drawn as vector strokes, realistic gradients, soft shadows,
// rim light, atmospheric haze, wet-road reflections, film grain and a
// cinematic color grade.
//
// The clip: a cinematic Vice City night — lightning-lit skyline, neon
// streets, Jason & Lucia, a heist tease — then the make.fun pitch: AI agents
// build cool stuff and win real money, and you can too.
//
// Pipeline: ten scene masters are rendered as PNGs (1296x2304, analytic
// anti-aliasing, fixed seed 20261120), then assembled with ffmpeg into a
// 1080x1920, 30fps, 36-second clip at /output/clip.mp4 (deterministic: fixed
// seed, fixed metadata, same bytes on every run). VIDEO.json is copied to
// /output/VIDEO.json, where the gate reads the YouTube video's address.
//
// Run it:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
//
// `out/clip.mp4` is the clip. Upload it to YouTube as a public Short, put the
// bounty line and the play code in its description (see YOUTUBE-DESCRIPTION.txt),
// then replace the placeholder in VIDEO.json with the video's address.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SEED = 20261120;
const W = 1296; // master width (1.2x output, headroom for the camera zoom)
const H = 2304; // master height
const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — every random choice in the render is
// seeded, so repeated runs produce byte-identical frames.
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
// Color helpers. Colors are [r, g, b] in 0..255.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const rgb = (r: number, g: number, b: number): RGB => [r, g, b];
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Multi-stop vertical gradient lookup: stops are [position 0..1, color].
function gradAt(stops: Array<[number, RGB]>, t: number): RGB {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      return lerpColor(c0, c1, (t - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1][1];
}
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
// Smoothstep edge: 0 below lo, 1 above hi, smooth between.
function sstep(lo: number, hi: number, v: number): number {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder (truecolor RGB, filter 0, zlib level 6).
// No timestamps anywhere in a PNG, so the output is byte-stable.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePNG(w: number, h: number, px: Uint8Array): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas — an RGB framebuffer with analytic anti-aliasing. Every shape is
// rasterized with a 1px smooth edge (coverage = smoothstep over the signed
// distance to the shape's edge), so nothing ever looks blocky.
// ---------------------------------------------------------------------------
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array; // RGB, row-major
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
  }
  // Blend one pixel: src color at coverage*alpha over the destination.
  blend(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    const p = this.px;
    p[i] = p[i] + (c[0] - p[i]) * a;
    p[i + 1] = p[i + 1] + (c[1] - p[i + 1]) * a;
    p[i + 2] = p[i + 2] + (c[2] - p[i + 2]) * a;
  }
  // Fill the whole canvas with a vertical multi-stop gradient.
  vgrad(stops: Array<[number, RGB]>): void {
    for (let y = 0; y < this.h; y++) {
      const c = gradAt(stops, y / (this.h - 1));
      const base = y * this.w * 3;
      for (let x = 0; x < this.w; x++) {
        this.px[base + x * 3] = c[0];
        this.px[base + x * 3 + 1] = c[1];
        this.px[base + x * 3 + 2] = c[2];
      }
    }
  }
  // Fill a rect with a vertical gradient.
  rectGrad(x0: number, y0: number, x1: number, y1: number, stops: Array<[number, RGB]>): void {
    const xa = Math.max(0, Math.floor(x0));
    const xb = Math.min(this.w, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(this.h, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      const c = gradAt(stops, (y - y0) / Math.max(1, y1 - y0));
      const base = y * this.w * 3;
      for (let x = xa; x < xb; x++) {
        this.px[base + x * 3] = c[0];
        this.px[base + x * 3 + 1] = c[1];
        this.px[base + x * 3 + 2] = c[2];
      }
    }
  }
  // Solid rect (optionally with soft AA edges via `soft` px feather).
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, alpha = 1, soft = 0): void {
    const xa = Math.max(0, Math.floor(x0 - soft - 1));
    const xb = Math.min(this.w, Math.ceil(x1 + soft + 1));
    const ya = Math.max(0, Math.floor(y0 - soft - 1));
    const yb = Math.min(this.h, Math.ceil(y1 + soft + 1));
    for (let y = ya; y < yb; y++) {
      const cy = y + 0.5;
      const ay = soft > 0
        ? sstep(y0 - soft, y0 + soft, cy) * (1 - sstep(y1 - soft, y1 + soft, cy))
        : cy >= y0 && cy < y1 ? 1 : 0;
      if (ay <= 0) continue;
      for (let x = xa; x < xb; x++) {
        const cx = x + 0.5;
        const ax = soft > 0
          ? sstep(x0 - soft, x0 + soft, cx) * (1 - sstep(x1 - soft, x1 + soft, cx))
          : cx >= x0 && cx < x1 ? 1 : 0;
        const a = ay * ax * alpha;
        if (a > 0) this.blend(x, y, c, a);
      }
    }
  }
  // Filled circle with a 1px smooth edge; `edge` widens the feather (glow).
  circle(cx: number, cy: number, r: number, c: RGB, alpha = 1, edge = 1): void {
    const xa = Math.max(0, Math.floor(cx - r - edge - 1));
    const xb = Math.min(this.w, Math.ceil(cx + r + edge + 1));
    const ya = Math.max(0, Math.floor(cy - r - edge - 1));
    const yb = Math.min(this.h, Math.ceil(cy + r + edge + 1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = (1 - sstep(r - edge, r + edge, d)) * alpha;
        if (a > 0) this.blend(x, y, c, a);
      }
    }
  }
  // Soft radial glow: gaussian-ish falloff, alpha peaks at the center.
  glow(cx: number, cy: number, r: number, c: RGB, alpha: number, power = 2): void {
    const xa = Math.max(0, Math.floor(cx - r));
    const xb = Math.min(this.w, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r));
    const yb = Math.min(this.h, Math.ceil(cy + r));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const a = alpha * Math.pow(1 - d * d, power);
        if (a > 0) this.blend(x, y, c, a);
      }
    }
  }
  // Ellipse (axis-aligned) with a smooth edge.
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1, edge = 1.5): void {
    const xa = Math.max(0, Math.floor(cx - rx - edge - 1));
    const xb = Math.min(this.w, Math.ceil(cx + rx + edge + 1));
    const ya = Math.max(0, Math.floor(cy - ry - edge - 1));
    const yb = Math.min(this.h, Math.ceil(cy + ry + edge + 1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = (1 - sstep(1 - edge / Math.max(rx, ry), 1 + edge / Math.max(rx, ry), d)) * alpha;
        if (a > 0) this.blend(x, y, c, a);
      }
    }
  }
  // Thick line segment with round caps (a capsule), analytic AA.
  // `col` may be a function (x, y) => RGB for gradient strokes (text).
  capsule(x1: number, y1: number, x2: number, y2: number, width: number, col: RGB | ((x: number, y: number) => RGB), alpha = 1): void {
    const r = width / 2;
    const xa = Math.max(0, Math.floor(Math.min(x1, x2) - r - 2));
    const xb = Math.min(this.w, Math.ceil(Math.max(x1, x2) + r + 2));
    const ya = Math.max(0, Math.floor(Math.min(y1, y2) - r - 2));
    const yb = Math.min(this.h, Math.ceil(Math.max(y1, y2) + r + 2));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
        const a = (1 - sstep(r - 1, r + 1, d)) * alpha;
        if (a > 0) this.blend(x, y, typeof col === 'function' ? col(px, py) : col, a);
      }
    }
  }
  // Polyline of thick segments with round joins (calls capsule per segment).
  polyline(pts: Array<[number, number]>, width: number, col: RGB | ((x: number, y: number) => RGB), alpha = 1): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      this.capsule(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width, col, alpha);
    }
  }
  // Filled polygon (scanline, AA on the two edge pixels of each span).
  poly(pts: Array<[number, number]>, c: RGB, alpha = 1): void {
    if (pts.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const ya = Math.max(0, Math.floor(minY));
    const yb = Math.min(this.h, Math.ceil(maxY));
    for (let y = ya; y < yb; y++) {
      const cy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) {
          xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = xs[k];
        const x1 = xs[k + 1];
        const xa = Math.max(0, Math.floor(x0));
        const xb = Math.min(this.w, Math.ceil(x1));
        for (let x = xa; x < xb; x++) {
          const cx = x + 0.5;
          const cov = Math.min(1, Math.min(cx + 0.5, x1) - Math.max(cx - 0.5, x0));
          if (cov > 0) this.blend(x, y, c, cov * alpha);
        }
      }
    }
  }
  // Quadratic bezier sampled into a polyline.
  quad(p0: [number, number], p1: [number, number], p2: [number, number], steps = 16): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
    return out;
  }
  // Cubic bezier sampled into a polyline.
  cubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], steps = 20): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      out.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
    return out;
  }
  // Deterministic film grain: +/- `amount` brightness noise (seeded LCG).
  grain(seed: number, amount: number): void {
    const rnd = mulberry32(seed);
    for (let i = 0; i < this.px.length; i++) {
      const n = (rnd() - 0.5) * 2 * amount;
      const v = this.px[i] + n;
      this.px[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  // Cinematic vignette: darken toward the corners.
  vignette(amount: number): void {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const maxD = Math.hypot(cx, cy);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxD;
        const f = 1 - amount * Math.pow(Math.max(0, d - 0.45) / 0.55, 2);
        if (f < 1) {
          const i = (y * this.w + x) * 3;
          this.px[i] *= f;
          this.px[i + 1] *= f;
          this.px[i + 2] *= f;
        }
      }
    }
  }
  // Warm/cool color grade: lift shadows slightly blue, push highlights warm.
  grade(): void {
    for (let i = 0; i < this.px.length; i += 3) {
      const r = this.px[i];
      const g = this.px[i + 1];
      const b = this.px[i + 2];
      const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
      // shadows -> cool blue lift, highlights -> warm push
      const warm = (lum - 0.5) * 10;
      this.px[i] = Math.max(0, Math.min(255, r + warm));
      this.px[i + 1] = Math.max(0, Math.min(255, g + warm * 0.4));
      this.px[i + 2] = Math.max(0, Math.min(255, b - warm * 0.8));
    }
  }
  // Finish a master: vignette + grain + grade, then write the PNG.
  finish(path: string, seed: number): void {
    this.vignette(0.22);
    this.grain(seed, 4.5);
    this.grade();
    writeFileSync(path, encodePNG(this.w, this.h, this.px));
  }
}

// ---------------------------------------------------------------------------
// Vector stroke font — a clean bold geometric sans, authored as stroke
// paths on a 10-unit cap-height grid. Strokes render with round caps/joins
// and analytic anti-aliasing, so lettering is smooth at any size (no
// bitmap font, no pixel-art). DSL per glyph: space-separated commands
//   M x y            move to
//   L x y            line to
//   A cx cy rx ry a0 a1   elliptical arc, angles in degrees (0=east, 90=south,
//                         y grows downward), sampled a0 -> a1
// ---------------------------------------------------------------------------
type Glyph = { adv: number; path: string };
const FONT: Record<string, Glyph> = {
  A: { adv: 9, path: 'M1 10 L4.5 0 L8 10 M2.6 6.8 L6.4 6.8' },
  B: { adv: 9, path: 'M1 0 L1 10 M1 0 L5 0 A5 2.2 2.2 2.2 -90 90 L1 4.4 M1 4.4 L5.5 4.4 A5.5 7.2 2.7 2.7 -90 90 L1 10' },
  C: { adv: 9, path: 'M7.2 1.6 A4 5 4.2 4.2 -50 -310' },
  D: { adv: 9, path: 'M1 0 L1 10 M1 0 L4.5 0 A4.5 5 5 5 -90 90 L1 10' },
  E: { adv: 9, path: 'M7 0 L1 0 L1 10 L7 10 M1 5 L5.5 5' },
  F: { adv: 9, path: 'M1 0 L1 10 M1 0 L7 0 M1 5 L5.5 5' },
  G: { adv: 9, path: 'M7.5 1.8 A4 5 4.2 4.2 -50 -310 M8.2 5 L5.2 5 L5.2 7.8' },
  H: { adv: 9, path: 'M1 0 L1 10 M7 0 L7 10 M1 5 L7 5' },
  I: { adv: 5, path: 'M2.5 0 L2.5 10' },
  J: { adv: 9, path: 'M6.5 0 L6.5 7.5 A4.3 7.5 2.2 2.2 0 180' },
  K: { adv: 9, path: 'M1 0 L1 10 M7 0 L1 5 L7 10' },
  L: { adv: 9, path: 'M1 0 L1 10 L7 10' },
  M: { adv: 11, path: 'M1 10 L1 0 L5.5 6 L10 0 L10 10' },
  N: { adv: 9, path: 'M1 10 L1 0 L7 10 L7 0' },
  O: { adv: 9, path: 'A4 5 3.8 4.6 -90 -450' },
  P: { adv: 9, path: 'M1 10 L1 0 L5 0 A5 2.5 2.5 2.5 -90 90 L1 5' },
  Q: { adv: 9, path: 'A4 4.8 3.9 4.6 -90 -450 M5.5 7 L8 10' },
  R: { adv: 9, path: 'M1 10 L1 0 L5 0 A5 2.5 2.5 2.5 -90 90 L1 5 M4.5 5 L8 10' },
  S: { adv: 9, path: 'M6.4 1.2 A4 2.5 2.8 2.5 -31 -270 A4 7.5 2.8 2.5 -90 149' },
  T: { adv: 9, path: 'M0.5 0 L7.5 0 M4 0 L4 10' },
  U: { adv: 9, path: 'M1 0 L1 7 A4 7 3 3 180 0 L7 0' },
  V: { adv: 9, path: 'M1 0 L4 10 L7 0' },
  W: { adv: 11, path: 'M0.5 0 L2.8 10 L5.5 4 L8.2 10 L10.5 0' },
  X: { adv: 9, path: 'M1 0 L7 10 M7 0 L1 10' },
  Y: { adv: 9, path: 'M1 0 L4 5 L7 0 M4 5 L4 10' },
  Z: { adv: 9, path: 'M1 0 L7 0 L1 10 L7 10' },
  '0': { adv: 9, path: 'A4 5 3.4 4.6 -90 -450' },
  '1': { adv: 9, path: 'M3 2.2 L5.5 0 L5.5 10 M2.8 10 L7 10' },
  '2': { adv: 9, path: 'A4.2 2.6 2.4 2.4 150 390 L1.5 10 L7 10' },
  '3': { adv: 9, path: 'A4.5 2.5 2.3 2.3 150 390 M2 6 A4.6 7.3 2.6 2.6 180 -45' },
  '4': { adv: 9, path: 'M5.5 0 L1.8 6.5 L7 6.5 M5.5 0 L5.5 10' },
  '5': { adv: 9, path: 'M7 0 L1 0 L1 4.5 L5 4.5 A5 7.2 2.7 2.7 -90 90 L1 10' },
  '6': { adv: 9, path: 'A4 5.6 3.4 4.2 -90 -450 M7.2 1.2 L6.6 5.5' },
  '7': { adv: 9, path: 'M1 0 L7 0 L3.5 10' },
  '8': { adv: 9, path: 'A4 2.6 2.6 2.2 -90 -450 M4 7.4 A4 7.4 3 3 -90 -450' },
  '9': { adv: 9, path: 'A4 4.4 3.4 4.2 -90 -450 M7.4 4.4 L7.4 10' },
  '.': { adv: 4, path: 'A2 9.3 1 1 -90 -450' },
  '/': { adv: 6, path: 'M5 0 L1 10' },
  ':': { adv: 5, path: 'A2.5 2.5 0.8 0.8 -90 -450 M2.5 7.5 A2.5 7.5 0.8 0.8 -90 -450' },
  '-': { adv: 8, path: 'M1 5 L7 5' },
  '+': { adv: 8, path: 'M1 4.5 L7 4.5 M4 1.5 L4 7.5' },
  '&': { adv: 9, path: 'M6.2 2.4 A4.3 2.9 2 2 -15 -235 M7 3.8 L1.7 9.6 A4.9 8.3 3 1.7 180 -30' },
  $: { adv: 9, path: 'M4 0 L4 10 M6.4 1.2 A4 2.5 2.8 2.5 -31 -270 A4 7.5 2.8 2.5 -90 149' },
  '!': { adv: 5, path: 'M2.5 0 L2.5 6.5 M2.5 8.5 A2.5 8.8 1 1 -90 -450' },
  "'": { adv: 4, path: 'M2.5 0 L1.5 3.5' },
  '—': { adv: 9, path: 'M0.5 5 L8.5 5' },
  ' ': { adv: 5, path: '' },
};

// Parse a glyph path string into polylines of [x, y] points.
function parsePath(d: string): Array<Array<[number, number]>> {
  // The FONT DSL writes commands attached to the first number ("M1 10"),
  // so split the M/L/A letters out before tokenizing on whitespace.
  const tokens = d.replace(/([MLA])/g, ' $1 ').trim().split(/\s+/).filter(Boolean);
  const polylines: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let i = 0;
  const flush = () => {
    if (cur.length > 1) polylines.push(cur);
    else if (cur.length === 1) polylines.push([cur[0], cur[0]]);
    cur = [];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      flush();
      cur = [[parseFloat(tokens[i++]), parseFloat(tokens[i++])]];
    } else if (cmd === 'L') {
      cur.push([parseFloat(tokens[i++]), parseFloat(tokens[i++])]);
    } else if (cmd === 'A') {
      const cx = parseFloat(tokens[i++]);
      const cy = parseFloat(tokens[i++]);
      const rx = parseFloat(tokens[i++]);
      const ry = parseFloat(tokens[i++]);
      const a0 = parseFloat(tokens[i++]);
      const a1 = parseFloat(tokens[i++]);
      const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 9));
      for (let s = 0; s <= steps; s++) {
        const a = ((a0 + ((a1 - a0) * s) / steps) * Math.PI) / 180;
        cur.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
    }
  }
  flush();
  return polylines;
}
const GLYPHS = new Map<string, { adv: number; lines: Array<Array<[number, number]>> }>();
for (const [ch, g] of Object.entries(FONT)) {
  GLYPHS.set(ch, { adv: g.adv, lines: parsePath(g.path) });
}
function textWidth(s: string, scale: number): number {
  let w = 0;
  for (const ch of s) {
    const g = GLYPHS.get(ch.toUpperCase());
    w += (g ? g.adv : 5) * scale;
  }
  return w;
}

export interface TextOpts {
  scale: number; // px per font unit (cap height = 10 * scale)
  color: RGB | ((x: number, y: number) => RGB);
  alpha?: number;
  shadow?: { dx: number; dy: number; color: RGB; alpha: number };
  align?: 'left' | 'center' | 'right';
  stroke?: number; // stroke width in font units (default 2.6)
}

// Draw one line of text. (x, y) is the top-left of the cap-height box
// (or the center / right edge when align is center/right).
function drawText(cv: Canvas, s: string, x: number, y: number, o: TextOpts): void {
  const scale = o.scale;
  const strokeW = (o.stroke ?? 2.6) * scale;
  const alpha = o.alpha ?? 1;
  const w = textWidth(s, scale);
  let x0 = x;
  if (o.align === 'center') x0 = x - w / 2;
  if (o.align === 'right') x0 = x - w;
  const draw = (col: RGB | ((x: number, y: number) => RGB), a: number, dx: number, dy: number) => {
    let cx = x0 + dx;
    for (const ch of s) {
      const g = GLYPHS.get(ch.toUpperCase());
      if (g) {
        for (const line of g.lines) {
          const pts: Array<[number, number]> = line.map(([px, py]) => [cx + px * scale, y + py * scale + dy]);
          cv.polyline(pts, strokeW, col, a);
        }
      }
      cx += (g ? g.adv : 5) * scale;
    }
  };
  if (o.shadow) {
    const sh = o.shadow;
    draw(sh.color, sh.alpha, sh.dx, sh.dy);
  }
  draw(o.color, alpha, 0, 0);
}

// Vertical-gradient text color: lerp top->bottom across the cap height.
function textGradient(top: RGB, bottom: RGB, yTop: number, yBottom: number): (x: number, y: number) => RGB {
  return (_x: number, y: number) => lerpColor(top, bottom, clamp01((y - yTop) / Math.max(1, yBottom - yTop)));
}

// ---------------------------------------------------------------------------
// Scene helpers — shared realistic elements.
// ---------------------------------------------------------------------------

// Star field: small soft dots, brighter near the top, seeded.
function stars(cv: Canvas, seed: number, n: number, yMax: number): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const x = rnd() * W;
    const y = rnd() * yMax;
    const r = 0.8 + rnd() * 1.8;
    const a = 0.25 + rnd() * 0.65;
    cv.circle(x, y, r, rgb(255, 255, 240), a, 1.2);
  }
}

// City skyline silhouette with lit windows. `baseY` is the ground line,
// `hMin/hMax` the building height range, `seed` the layout seed.
function skyline(cv: Canvas, seed: number, baseY: number, hMin: number, hMax: number, color: RGB): void {
  const rnd = mulberry32(seed);
  let x = -20;
  while (x < W + 20) {
    const bw = 70 + rnd() * 130;
    const bh = hMin + rnd() * (hMax - hMin);
    const top = baseY - bh;
    // main slab
    cv.rect(x, top, x + bw, baseY, color, 1, 0);
    // rooftop antenna / setback on some buildings
    if (rnd() < 0.35) {
      const aw = bw * (0.3 + rnd() * 0.3);
      cv.rect(x + bw * 0.2, top - 26 - rnd() * 40, x + bw * 0.2 + aw, top, color, 1, 0);
      if (rnd() < 0.5) cv.circle(x + bw * 0.2 + aw / 2, top - 26 - rnd() * 40 - 8, 3, rgb(255, 90, 90), 0.9, 1);
    }
    // lit windows: warm dots with slight glow
    const cols = Math.floor(bw / 26);
    const rows = Math.floor(bh / 34);
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        if (rnd() < 0.34) {
          const wx = x + 12 + cx * 26 + rnd() * 6;
          const wy = top + 14 + cy * 34 + rnd() * 6;
          const warm = rnd();
          const wc: RGB = warm < 0.6 ? rgb(255, 196, 110) : warm < 0.85 ? rgb(150, 225, 255) : rgb(255, 150, 200);
          cv.rect(wx, wy, wx + 7, wy + 10, wc, 0.5 + rnd() * 0.45, 0);
        }
      }
    }
    x += bw + 4 + rnd() * 22;
  }
}

// Wet asphalt road with neon reflections. `y0` top of the road, `y1` bottom.
// `streaks` are [xCenter, width, color, alpha] vertical light streaks.
function wetRoad(cv: Canvas, y0: number, y1: number, streaks: Array<[number, number, RGB, number]>): void {
  cv.rectGrad(0, y0, W, y1, [
    [0, rgb(16, 12, 26)],
    [1, rgb(8, 6, 14)],
  ]);
  // reflection streaks: soft vertical smears that fade toward the bottom
  for (const [cx, wd, col, a] of streaks) {
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const y = y0 + t * (y1 - y0);
      const wob = Math.sin(t * 9 + cx * 0.01) * 6;
      const fade = (1 - t) * a;
      cv.rect(cx - wd / 2 + wob, y, cx + wd / 2 + wob, y + (y1 - y0) / steps + 2, col, fade * 0.5, 1.5);
    }
  }
  // lane dashes with a faint reflection below them
  const dashY = y0 + (y1 - y0) * 0.62;
  for (let x = 40; x < W; x += 190) {
    cv.rect(x, dashY, x + 105, dashY + 10, rgb(240, 214, 130), 0.85, 1);
    cv.rect(x, dashY + 16, x + 105, dashY + 22, rgb(240, 214, 130), 0.22, 1.5);
  }
}

// Palm silhouette: curved trunk + arching fronds, smooth bezier strokes.
function palm(cv: Canvas, x: number, baseY: number, h: number, lean: number, color: RGB): void {
  const topX = x + lean;
  const topY = baseY - h;
  // trunk: gentle S-curve
  const trunk = cv.cubic([x, baseY], [x + lean * 0.25, baseY - h * 0.45], [x + lean * 0.8, baseY - h * 0.8], [topX, topY], 18);
  cv.polyline(trunk, 26, color, 1);
  // fronds: 7 arcs fanning out from the crown
  for (let i = 0; i < 7; i++) {
    const ang = (-160 + i * 52) * (Math.PI / 180); // fan from left-down to right-down
    const len = h * (0.42 + (i % 3) * 0.06);
    const tipX = topX + Math.cos(ang) * len;
    const tipY = topY + Math.sin(ang) * len * 0.55 + len * 0.28; // droop
    const midX = topX + Math.cos(ang) * len * 0.55;
    const midY = topY + Math.sin(ang) * len * 0.28 - 14;
    const frond = cv.quad([topX, topY], [midX, midY], [tipX, tipY], 12);
    cv.polyline(frond, 13, color, 1);
  }
  // coconut cluster
  cv.circle(topX - 12, topY + 16, 12, color, 1, 1);
  cv.circle(topX + 12, topY + 18, 11, color, 1, 1);
}

// Synthwave sun: gradient disc with horizontal stripe gaps in its lower half.
function synthSun(cv: Canvas, cx: number, cy: number, r: number): void {
  // halo
  cv.glow(cx, cy, r * 2.4, rgb(255, 120, 60), 0.35, 2);
  // disc: radial gradient orange -> pink
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(W, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(H, Math.ceil(cy + r));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d > 1) continue;
      const t = clamp01((y - (cy - r)) / (2 * r));
      const c = lerpColor(lerpColor(rgb(255, 214, 110), rgb(255, 122, 60), t), rgb(255, 80, 140), t * t * 0.7);
      const a = (1 - sstep(0.97, 1.0, d)) * 1;
      if (a > 0) cv.blend(x, y, c, a);
    }
  }
  // stripe gaps across the lower half (sky-colored bands, growing thicker)
  const sky = rgb(58, 16, 74);
  let sy = cy + r * 0.05;
  let th = 5;
  while (sy < cy + r) {
    cv.rect(cx - r - 2, sy, cx + r + 2, sy + th, sky, 1, 0);
    sy += th + 34;
    th += 5;
  }
}

// Lightning bolt: jagged core + wide soft glow.
function lightning(cv: Canvas, seed: number, x0: number, y0: number): void {
  const rnd = mulberry32(seed);
  const pts: Array<[number, number]> = [[x0, y0]];
  let x = x0;
  let y = y0;
  while (y < 900) {
    x += (rnd() - 0.5) * 130;
    y += 90 + rnd() * 110;
    pts.push([x, y]);
    // branch
    if (rnd() < 0.45) {
      const bx = x + (rnd() < 0.5 ? -1 : 1) * (50 + rnd() * 90);
      const by = y + 60 + rnd() * 90;
      cv.polyline([[x, y], [(x + bx) / 2, (y + by) / 2], [bx, by]], 7, rgb(230, 240, 255), 0.75);
    }
  }
  cv.polyline(pts, 26, rgb(190, 200, 255), 0.35); // outer glow
  cv.polyline(pts, 12, rgb(240, 246, 255), 0.9); // mid glow
  cv.polyline(pts, 5, rgb(255, 255, 255), 1); // hot core
}

// Sports car, side profile, with realistic proportions. `x` is the center,
// `y` the ground line, `s` the scale (body length ~ 620*s), `flip` mirrors it.
function sportsCar(cv: Canvas, x: number, y: number, s: number, body: RGB, flip: boolean): void {
  const m = flip ? -1 : 1;
  const P = (dx: number, dy: number): [number, number] => [x + dx * m * s, y + dy * s];
  // body: smooth outline via beziers — low nose, rising hood, cabin, tail
  const outline: Array<[number, number]> = [
    ...cv.cubic(P(-310, -28), P(-300, -62), P(-210, -78), P(-120, -84), 10),
    ...cv.cubic(P(-120, -84), P(-60, -128), P(30, -150), P(110, -148), 10),
    ...cv.cubic(P(110, -148), P(190, -146), P(250, -120), P(295, -84), 10),
    ...cv.cubic(P(295, -84), P(315, -60), P(312, -30), P(300, -22), 8),
    ...cv.cubic(P(300, -22), P(180, -8), P(-180, -8), P(-310, -28), 8),
  ];
  cv.poly(outline, body, 1);
  // cabin glass: dark gradient band
  const glass: Array<[number, number]> = [
    ...cv.cubic(P(-95, -88), P(-45, -122), P(35, -140), P(105, -138), 8),
    ...cv.cubic(P(105, -138), P(150, -124), P(180, -96), P(185, -88), 8),
    ...cv.cubic(P(185, -88), P(60, -80), P(-40, -80), P(-95, -88), 8),
  ];
  cv.poly(glass, rgb(14, 22, 38), 0.95);
  // glass highlight streak
  cv.polyline([P(-70, -96), P(20, -118), P(95, -128)], 7, rgb(160, 200, 235), 0.5);
  // body highlight along the shoulder line
  cv.polyline([P(-285, -72), P(-120, -88), P(120, -128), P(280, -88)], 6, rgb(255, 255, 255), 0.22);
  // wheels: tires + rims + spokes
  for (const wx of [-195, 195]) {
    const [cx, cy] = P(wx, -34);
    cv.circle(cx, cy, 52 * s, rgb(10, 10, 12), 1, 1.5);
    cv.circle(cx, cy, 30 * s, rgb(196, 204, 214), 1, 1.5);
    cv.circle(cx, cy, 12 * s, rgb(40, 44, 52), 1, 1);
    for (let k = 0; k < 5; k++) {
      const a = (k * 72 * Math.PI) / 180;
      cv.capsule(cx, cy, cx + Math.cos(a) * 26 * s, cy + Math.sin(a) * 26 * s, 7 * s, rgb(120, 128, 140), 1);
    }
  }
  // headlight beam + taillight glow
  const [hx, hy] = P(300, -58);
  cv.glow(hx + 60 * m, hy, 120, rgb(255, 244, 200), 0.5, 2);
  cv.ellipse(hx, hy, 16, 7, rgb(255, 250, 220), 1, 1);
  const [tx, ty] = P(-308, -58);
  cv.glow(tx - 30 * m, ty, 70, rgb(255, 40, 60), 0.55, 2);
  cv.ellipse(tx, ty, 12, 6, rgb(255, 70, 90), 1, 1);
  // underglow
  cv.glow(x, y - 6, 320 * s, rgb(255, 60, 160), 0.28, 2);
}

// A person silhouette built from smooth capsules (limbs) + a rounded torso
// + a head — realistic proportions, no stick figures. `h` is total height.
// `pose` picks a stance: 'stand' | 'lean' | 'run' | 'arm' (arm around partner).
// `rim` is the rim-light color drawn on the sun side (pass null for none).
function person(cv: Canvas, x: number, baseY: number, h: number, pose: 'stand' | 'lean' | 'run' | 'arm', color: RGB, rim: RGB | null, flip: boolean): void {
  const m = flip ? -1 : 1;
  const u = h / 640; // unit scale
  const headR = 34 * u;
  const headY = baseY - h + headR;
  const shoulderY = baseY - h + headR * 2 + 26 * u;
  const hipY = baseY - h * 0.42;
  const kneeY = baseY - h * 0.2;
  const footY = baseY;
  const rimDx = rim ? -7 * m : 0; // rim light on the sun side (left when facing right)
  const draw = (dx: number, dy: number, c: RGB, a: number) => {
    // helper that draws the whole figure offset by (dx, dy) in color c
    // head
    cv.circle(x + dx, headY + dy, headR, c, a, 1.5);
    // torso: rounded trapezoid (shoulders -> hips)
    const sw = 62 * u;
    const hw = 48 * u;
    const torso: Array<[number, number]> = [
      [x - sw + dx, shoulderY + dy],
      [x + sw + dx, shoulderY + dy],
      [x + hw + dx, hipY + dy],
      [x - hw + dx, hipY + dy],
    ];
    cv.poly(torso, c, a);
    // legs
    if (pose === 'run') {
      // front leg forward-down, back leg back-up (mid-stride)
      cv.capsule(x - 8 * m * u + dx, hipY + dy, x + 78 * m * u + dx, kneeY + dy + 30 * u, 34 * u, c, a);
      cv.capsule(x + 78 * m * u + dx, kneeY + dy + 30 * u, x + 118 * m * u + dx, footY + dy, 30 * u, c, a);
      cv.capsule(x + 8 * m * u + dx, hipY + dy, x - 62 * m * u + dx, kneeY + dy - 40 * u, 34 * u, c, a);
      cv.capsule(x - 62 * m * u + dx, kneeY + dy - 40 * u, x - 108 * m * u + dx, footY + dy - 46 * u, 30 * u, c, a);
    } else {
      cv.capsule(x - 18 * m * u + dx, hipY + dy, x - 26 * m * u + dx, footY + dy, 36 * u, c, a);
      cv.capsule(x + 18 * m * u + dx, hipY + dy, x + 30 * m * u + dx, footY + dy, 36 * u, c, a);
    }
    // arms
    if (pose === 'arm') {
      // one arm hangs, the other reaches around the partner (to the right)
      cv.capsule(x - sw * 0.9 + dx, shoulderY + 10 * u + dy, x - sw * 1.15 + dx, hipY + dy, 26 * u, c, a);
      cv.capsule(x + sw * 0.9 + dx, shoulderY + 10 * u + dy, x + sw * 2.1 + dx, shoulderY + 46 * u + dy, 26 * u, c, a);
    } else if (pose === 'run') {
      cv.capsule(x - sw * 0.9 + dx, shoulderY + 10 * u + dy, x - sw * 1.7 + dx, hipY - 30 * u + dy, 26 * u, c, a);
      cv.capsule(x + sw * 0.9 + dx, shoulderY + 10 * u + dy, x + sw * 1.5 + dx, hipY - 10 * u + dy, 26 * u, c, a);
    } else {
      cv.capsule(x - sw * 0.95 + dx, shoulderY + 8 * u + dy, x - sw * 1.1 + dx, hipY + 10 * u + dy, 26 * u, c, a);
      cv.capsule(x + sw * 0.95 + dx, shoulderY + 8 * u + dy, x + sw * 1.05 + dx, hipY + 10 * u + dy, 26 * u, c, a);
    }
  };
  if (rim) {
    // rim pass: same figure shifted toward the light, warm color
    draw(rimDx, -2, rim, 0.9);
  }
  draw(0, 0, color, 1);
}

// The make.fun ghost: smooth dome + wavy hem, two eyes, soft shading.
function ghost(cv: Canvas, cx: number, cy: number, s: number, body: RGB, shade: RGB): void {
  // body outline: dome top, straight sides, 4 wavy lobes at the hem
  const w = 150 * s;
  const h = 175 * s;
  const top = cy - h / 2;
  const bot = cy + h / 2;
  const outline: Array<[number, number]> = [];
  // dome: top half-ellipse from the left side, over the crown, to the right
  const domeCy = top + w * 0.62;
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI + (i / 16) * Math.PI;
    outline.push([cx + Math.cos(a) * w, domeCy + Math.sin(a) * w * 0.62]);
  }
  // right side down to the hem
  outline.push([cx + w, bot - 26 * s]);
  // wavy hem: 4 lobes
  const lobes = 4;
  for (let l = 0; l < lobes; l++) {
    const x0 = cx + w - (l * 2 * w) / lobes;
    const x1 = cx + w - ((l + 1) * 2 * w) / lobes;
    const midX = (x0 + x1) / 2;
    outline.push(...cv.quad([x0, bot - 26 * s], [midX, bot + 26 * s], [x1, bot - 26 * s], 8).slice(1));
  }
  outline.push([cx - w, bot - 26 * s]);
  cv.poly(outline, body, 1);
  // soft shading on the right side (a translucent shade blob)
  cv.ellipse(cx + w * 0.42, cy + h * 0.12, w * 0.42, h * 0.34, shade, 0.35, 8);
  // eyes: dark ovals with a tiny highlight
  for (const ex of [-52, 52]) {
    cv.ellipse(cx + ex * s, cy - h * 0.08, 15 * s, 21 * s, rgb(16, 16, 24), 1, 2);
    cv.circle(cx + ex * s - 5 * s, cy - h * 0.08 - 7 * s, 4.5 * s, rgb(255, 255, 255), 0.9, 1);
  }
}

// Gold star coin: disc with a darker star.
function starCoin(cv: Canvas, cx: number, cy: number, r: number): void {
  cv.glow(cx, cy, r * 1.8, rgb(255, 190, 60), 0.4, 2);
  cv.circle(cx, cy, r, rgb(255, 196, 66), 1, 1.5);
  cv.circle(cx, cy, r * 0.78, rgb(232, 164, 32), 1, 1);
  // 5-point star
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r * 0.55 : r * 0.24;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  cv.poly(pts, rgb(255, 222, 120), 1);
}

// Neon sign: glowing rounded panel with small text inside.
function neonSign(cv: Canvas, x: number, y: number, w: number, h: number, label: string, col: RGB, scale: number): void {
  // layered glow
  cv.glow(x + w / 2, y + h / 2, Math.max(w, h) * 0.75, col, 0.3, 2);
  cv.rect(x, y, x + w, y + h, rgb(12, 10, 22), 0.92, 4);
  // glowing border: draw the rect outline as capsules
  const c = col;
  cv.capsule(x + 6, y + 6, x + w - 6, y + 6, 5, c, 0.95);
  cv.capsule(x + w - 6, y + 6, x + w - 6, y + h - 6, 5, c, 0.95);
  cv.capsule(x + w - 6, y + h - 6, x + 6, y + h - 6, 5, c, 0.95);
  cv.capsule(x + 6, y + h - 6, x + 6, y + 6, 5, c, 0.95);
  drawText(cv, label, x + w / 2, y + h / 2 - 5 * scale, { scale, color: rgb(255, 255, 255), align: 'center', stroke: 2.4, shadow: { dx: 0, dy: 0, color: c, alpha: 0.9 } });
}

// ---------------------------------------------------------------------------
// Headline helper: draw centered lines, auto-shrinking the scale so each
// line fits `maxW` (never clipped, never overflowing the frame).
// ---------------------------------------------------------------------------
function fitScale(s: string, maxScale: number, maxW: number): number {
  const w = textWidth(s, 1);
  return Math.min(maxScale, maxW / w);
}
interface HeadLine {
  text: string;
  scale: number;
  color: RGB | ((x: number, y: number) => RGB);
  stroke?: number;
}
function headline(cv: Canvas, lines: HeadLine[], y0: number, gap: number, maxW = 1180): void {
  let y = y0;
  for (const ln of lines) {
    const sc = fitScale(ln.text, ln.scale, maxW);
    const capH = 10 * sc;
    drawText(cv, ln.text, W / 2, y, {
      scale: sc,
      color: ln.color,
      align: 'center',
      stroke: ln.stroke ?? 2.6,
      shadow: { dx: 0, dy: 7, color: rgb(0, 0, 0), alpha: 0.5 },
    });
    y += capH + gap;
  }
}

// ---------------------------------------------------------------------------
// Scene 1 — Hook skyline: night sky, lightning, skyline + synthwave sun,
// wet road + palms, "GTA 6 / IS HERE".
// ---------------------------------------------------------------------------
function scene1(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#160a2e')],
    [0.42, hex('#2c0f4d')],
    [0.72, hex('#5c1a5e')],
    [1, hex('#7a2d6e')],
  ]);
  stars(cv, SEED + 1, 170, 1150);
  lightning(cv, SEED + 11, 150, -30);
  synthSun(cv, 880, 1020, 300);
  skyline(cv, SEED + 21, 1560, 280, 500, hex('#12081f'));
  wetRoad(cv, 1560, H, [
    [180, 26, rgb(255, 90, 180), 0.5],
    [430, 20, rgb(80, 220, 255), 0.45],
    [820, 24, rgb(255, 190, 80), 0.45],
    [1120, 22, rgb(255, 90, 180), 0.5],
  ]);
  palm(cv, 70, 1580, 540, 95, hex('#0a0514'));
  palm(cv, 1230, 1580, 480, -85, hex('#0a0514'));
  headline(cv, [
    { text: 'GTA 6', scale: 23, color: textGradient(rgb(255, 224, 130), rgb(255, 150, 40), 400, 660) },
    { text: 'IS HERE', scale: 20, color: rgb(255, 255, 255) },
  ], 400, 46);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 2 — Neon street: moon, neon signs, wet street, sports car,
// "VICE CITY / NEVER SLEEPS".
// ---------------------------------------------------------------------------
function scene2(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#0b1030')],
    [0.5, hex('#1a1445')],
    [1, hex('#3a1a5e')],
  ]);
  stars(cv, SEED + 2, 140, 900);
  // moon + halo
  cv.glow(1010, 320, 260, rgb(220, 225, 255), 0.5, 2);
  cv.circle(1010, 320, 92, rgb(240, 242, 255), 1, 2);
  cv.circle(985, 300, 16, rgb(205, 210, 235), 0.8, 1.5);
  cv.circle(1035, 345, 11, rgb(205, 210, 235), 0.8, 1.5);
  // far skyline
  skyline(cv, SEED + 22, 1380, 240, 480, hex('#0d0a20'));
  // street: perspective road from the horizon to the bottom edge
  cv.poly([[560, 1380], [736, 1380], [1296, 2304], [0, 2304]], rgb(14, 11, 24), 1);
  // wet reflections on the road
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const y = 1450 + t * 800;
    cv.rect(560 - t * 560 + 60, y, 736 + t * 560 - 60, y + 6, rgb(90, 200, 255), 0.16 + t * 0.1, 1.5);
  }
  // neon signs on the buildings flanking the street
  neonSign(cv, 56, 660, 280, 130, 'HOTEL', rgb(255, 70, 180), 7.5);
  neonSign(cv, 960, 800, 260, 120, 'VICE', rgb(70, 220, 255), 8);
  neonSign(cv, 66, 1060, 220, 110, 'BAR', rgb(255, 190, 70), 8);
  neonSign(cv, 1010, 1120, 220, 100, 'CLUB', rgb(180, 90, 255), 7.5);
  // car, headlights on — bright violet body so it reads on the dark street
  cv.glow(648, 2010, 400, rgb(180, 90, 255), 0.3, 2);
  sportsCar(cv, 648, 1980, 1.15, hex('#b45cff'), false);
  headline(cv, [
    { text: 'VICE CITY', scale: 19, color: textGradient(rgb(190, 250, 255), rgb(80, 200, 255), 300, 520) },
    { text: 'NEVER SLEEPS', scale: 16, color: rgb(255, 255, 255) },
  ], 300, 44);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 3 — Jason & Lucia: orange sunset, skyline, two rim-lit silhouettes,
// "JASON & LUCIA / ARE BACK".
// ---------------------------------------------------------------------------
function scene3(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#ff9a3c')],
    [0.38, hex('#ff6b5e')],
    [0.68, hex('#c23a6e')],
    [1, hex('#6e2358')],
  ]);
  // low sun + haze
  cv.glow(648, 1120, 620, rgb(255, 190, 90), 0.55, 2);
  cv.circle(648, 1120, 330, rgb(255, 214, 110), 1, 2);
  cv.circle(648, 1120, 330, rgb(255, 140, 70), 0.25, 2);
  skyline(cv, SEED + 23, 1500, 280, 520, hex('#2a0f2e'));
  wetRoad(cv, 1500, H, [
    [300, 22, rgb(255, 150, 80), 0.4],
    [648, 30, rgb(255, 120, 110), 0.45],
    [1000, 22, rgb(255, 170, 90), 0.4],
  ]);
  // the couple, standing close on the road, silhouetted against the sun
  person(cv, 520, 1560, 750, 'arm', rgb(16, 8, 20), rgb(255, 150, 90), false);
  person(cv, 700, 1560, 700, 'stand', rgb(16, 8, 20), rgb(255, 150, 90), true);
  // Lucia's hair: a soft bun behind her head
  cv.circle(700 + 34, 1560 - 700 + 40, 20, rgb(16, 8, 20), 1, 1.5);
  headline(cv, [
    { text: 'JASON & LUCIA', scale: 16, color: rgb(255, 255, 255) },
    { text: 'ARE BACK', scale: 21, color: rgb(255, 255, 255) },
  ], 380, 46);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 4 — Heist: police light glows, getaway car, two runners with
// duffel bags, money in the air, "THE BIGGEST / HEIST EVER".
// ---------------------------------------------------------------------------
function scene4(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#0a0d24')],
    [0.5, hex('#171233')],
    [1, hex('#2a1445')],
  ]);
  // police light wash: red left, blue right
  cv.glow(140, 700, 420, rgb(255, 40, 60), 0.5, 2);
  cv.glow(1160, 640, 420, rgb(60, 120, 255), 0.5, 2);
  stars(cv, SEED + 4, 90, 800);
  skyline(cv, SEED + 24, 1450, 260, 520, hex('#0c0818'));
  wetRoad(cv, 1450, H, [
    [220, 24, rgb(255, 60, 80), 0.45],
    [1050, 24, rgb(80, 140, 255), 0.45],
    [648, 20, rgb(255, 200, 120), 0.3],
  ]);
  // getaway car, facing left — brighter red, bigger, so it reads at night
  sportsCar(cv, 760, 1830, 1.1, hex('#c22738'), true);
  // runners with duffel bags — bigger, lifted off the dark street by a warm glow
  cv.glow(330, 1600, 380, rgb(255, 120, 90), 0.22, 2);
  person(cv, 400, 1780, 620, 'run', rgb(28, 22, 38), rgb(255, 120, 90), false);
  person(cv, 250, 1860, 600, 'run', rgb(28, 22, 38), rgb(120, 160, 255), false);
  // duffel bags (dark rounded shapes near the runners' hands)
  cv.ellipse(478, 1670, 52, 30, rgb(20, 16, 26), 1, 3);
  cv.ellipse(330, 1760, 48, 28, rgb(20, 16, 26), 1, 3);
  // money in the air: small pale-green bills, seeded scatter
  const rnd = mulberry32(SEED + 44);
  for (let i = 0; i < 16; i++) {
    const x = 120 + rnd() * 1050;
    const y = 900 + rnd() * 620;
    const a = rnd() * Math.PI;
    const w = 34 + rnd() * 14;
    const h = 16 + rnd() * 5;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const pts: Array<[number, number]> = [
      [x - (w / 2) * c + (h / 2) * s, y - (w / 2) * s - (h / 2) * c],
      [x + (w / 2) * c + (h / 2) * s, y + (w / 2) * s - (h / 2) * c],
      [x + (w / 2) * c - (h / 2) * s, y + (w / 2) * s + (h / 2) * c],
      [x - (w / 2) * c - (h / 2) * s, y - (w / 2) * s + (h / 2) * c],
    ];
    cv.poly(pts, rgb(198, 224, 168), 0.95);
  }
  headline(cv, [
    { text: 'THE BIGGEST', scale: 18, color: rgb(255, 255, 255) },
    { text: 'HEIST EVER', scale: 20, color: textGradient(rgb(255, 224, 130), rgb(255, 150, 40), 560, 800) },
  ], 360, 46);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 5 — Ghost pivot: magenta aura, make.fun ghost + star coins,
// "BUT WAIT — / THIS IS NOT / JUST A GAME".
// ---------------------------------------------------------------------------
function scene5(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#120a24')],
    [0.5, hex('#2a0f3d')],
    [1, hex('#3d1150')],
  ]);
  // concentric magenta aura
  cv.glow(648, 1000, 760, rgb(255, 60, 170), 0.4, 2);
  cv.glow(648, 1000, 520, rgb(255, 80, 190), 0.4, 2);
  cv.glow(648, 1000, 320, rgb(255, 110, 210), 0.35, 2);
  ghost(cv, 648, 1000, 1.5, rgb(248, 248, 255), rgb(190, 190, 220));
  starCoin(cv, 320, 700, 72);
  starCoin(cv, 990, 760, 62);
  starCoin(cv, 950, 1330, 54);
  starCoin(cv, 300, 1380, 48);
  headline(cv, [
    { text: 'BUT WAIT —', scale: 18, color: rgb(255, 255, 255) },
    { text: 'THIS IS NOT', scale: 14, color: rgb(255, 255, 255) },
    { text: 'JUST A GAME', scale: 14, color: rgb(255, 255, 255) },
  ], 330, 40);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 6 — Pitch 1: neon grid floor, ghost + coins,
// "AI AGENTS BUILD / THE COOLEST / STUFF".
// ---------------------------------------------------------------------------
function scene6(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#050514')],
    [0.45, hex('#0d0a2a')],
    [1, hex('#160a3a')],
  ]);
  // horizon glow
  cv.glow(648, 1150, 700, rgb(80, 200, 255), 0.3, 2);
  cv.glow(648, 1150, 420, rgb(255, 70, 190), 0.25, 2);
  // neon grid floor: perspective lines from the vanishing point
  const vx = 648;
  const vy = 1150;
  for (let i = -8; i <= 8; i++) {
    const bx = vx + i * 165;
    cv.capsule(vx, vy, bx, H, 5, rgb(70, 220, 255), 0.5);
  }
  const rows = [1150, 1215, 1300, 1415, 1570, 1780, 2050, 2304];
  for (let i = 0; i + 1 < rows.length; i++) {
    const w = 4 + i * 1.6;
    const a = 0.35 + i * 0.06;
    cv.capsule(0, rows[i], W, rows[i], w, i % 2 === 0 ? rgb(70, 220, 255) : rgb(255, 70, 190), a);
  }
  ghost(cv, 648, 820, 1.1, rgb(248, 248, 255), rgb(190, 190, 220));
  starCoin(cv, 300, 600, 56);
  starCoin(cv, 1000, 640, 50);
  starCoin(cv, 900, 1120, 42);
  headline(cv, [
    { text: 'AI AGENTS BUILD', scale: 15, color: rgb(255, 255, 255) },
    { text: 'THE COOLEST', scale: 17, color: textGradient(rgb(190, 250, 255), rgb(80, 200, 255), 1680, 1880) },
    { text: 'STUFF', scale: 19, color: rgb(255, 255, 255) },
  ], 1500, 42);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 7 — Pitch 2: gold background, light rays, floating coins,
// "MAKE CLIPS LIKE / THIS WITH AI / $500 / BOUNTY ON / MAKE.FUN".
// ---------------------------------------------------------------------------
function scene7(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#ffe9a8')],
    [0.45, hex('#f7c948')],
    [0.8, hex('#e09e00')],
    [1, hex('#a86e00')],
  ]);
  // light rays from the center
  const cx = 648;
  const cy = 1000;
  const rnd = mulberry32(SEED + 7);
  for (let i = 0; i < 12; i++) {
    const a0 = (i * 30 + rnd() * 8) * (Math.PI / 180);
    const a1 = a0 + (7 + rnd() * 6) * (Math.PI / 180);
    const r = 1500;
    cv.poly(
      [
        [cx, cy],
        [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r],
        [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r],
      ],
      rgb(255, 255, 255),
      0.06,
    );
  }
  cv.glow(cx, cy, 560, rgb(255, 240, 180), 0.5, 2);
  starCoin(cv, 220, 420, 58);
  starCoin(cv, 1080, 480, 50);
  starCoin(cv, 180, 1500, 52);
  starCoin(cv, 1120, 1560, 46);
  const dark: RGB = rgb(36, 26, 77);
  headline(cv, [
    { text: 'MAKE CLIPS LIKE', scale: 15, color: dark },
    { text: 'THIS WITH AI', scale: 16, color: dark },
    { text: '$500', scale: 32, color: textGradient(rgb(60, 30, 110), rgb(30, 16, 60), 880, 1240) },
    { text: 'BOUNTY ON', scale: 15, color: dark },
    { text: 'MAKE.FUN', scale: 21, color: dark },
  ], 420, 40);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 8 — CTA: big ghost + coins, "MAKE.FUN / MAKE.FUN/BOUNTY/
// GTA6-CLIPPER-01 / EARN MONEY MAKING / CLIPS WITH AI".
// ---------------------------------------------------------------------------
function scene8(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#100a26')],
    [0.5, hex('#220f3e')],
    [1, hex('#3a1150')],
  ]);
  cv.glow(648, 900, 780, rgb(255, 60, 170), 0.42, 2);
  cv.glow(648, 900, 480, rgb(255, 90, 200), 0.4, 2);
  ghost(cv, 648, 900, 1.6, rgb(248, 248, 255), rgb(190, 190, 220));
  starCoin(cv, 280, 600, 66);
  starCoin(cv, 1020, 680, 58);
  starCoin(cv, 180, 1180, 50);
  starCoin(cv, 1120, 1220, 46);
  headline(cv, [
    { text: 'MAKE.FUN', scale: 21, color: textGradient(rgb(255, 210, 235), rgb(255, 110, 190), 1330, 1560) },
    { text: 'MAKE.FUN/BOUNTY/', scale: 9, color: rgb(140, 235, 255) },
    { text: 'GTA6-CLIPPER-01', scale: 9, color: rgb(140, 235, 255) },
    { text: 'EARN MONEY MAKING', scale: 12, color: rgb(255, 255, 255) },
    { text: 'CLIPS WITH AI', scale: 12, color: rgb(255, 255, 255) },
  ], 1330, 38);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 9 — Finale: sunset skyline + car, "GTA 6. / MAKE.FUN. / GO."
// ---------------------------------------------------------------------------
function scene9(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#ff8a3c')],
    [0.4, hex('#e84a6e')],
    [0.7, hex('#7a2a5e')],
    [1, hex('#3a1445')],
  ]);
  cv.glow(648, 1080, 600, rgb(255, 180, 90), 0.55, 2);
  cv.circle(648, 1080, 300, rgb(255, 214, 110), 1, 2);
  skyline(cv, SEED + 29, 1500, 300, 540, hex('#240d28'));
  wetRoad(cv, 1500, H, [
    [300, 22, rgb(255, 150, 80), 0.4],
    [648, 28, rgb(255, 120, 110), 0.45],
    [1000, 22, rgb(255, 170, 90), 0.4],
  ]);
  sportsCar(cv, 648, 1960, 1.05, hex('#6a4fd0'), false);
  headline(cv, [
    { text: 'GTA 6.', scale: 21, color: textGradient(rgb(255, 224, 130), rgb(255, 150, 40), 360, 600) },
    { text: 'MAKE.FUN.', scale: 19, color: rgb(255, 255, 255) },
    { text: 'GO.', scale: 19, color: rgb(255, 255, 255) },
  ], 360, 44);
  return cv;
}

// ---------------------------------------------------------------------------
// Scene 10 — Endcard: ghost + coin, "MAKE.FUN / PLAY CODE:
// MAKEFUN-HERON- / RECIPE-VERANDA / LINK IN DESCRIPTION / LIKE + SUBSCRIBE".
// ---------------------------------------------------------------------------
function scene10(): Canvas {
  const cv = new Canvas(W, H);
  cv.vgrad([
    [0, hex('#0d0a20')],
    [0.5, hex('#1c0f38')],
    [1, hex('#2a1150')],
  ]);
  cv.glow(648, 780, 640, rgb(255, 60, 170), 0.42, 2);
  cv.glow(648, 780, 380, rgb(255, 90, 200), 0.38, 2);
  ghost(cv, 648, 780, 1.3, rgb(248, 248, 255), rgb(190, 190, 220));
  starCoin(cv, 960, 540, 72);
  starCoin(cv, 300, 620, 54);
  headline(cv, [
    { text: 'MAKE.FUN', scale: 20, color: textGradient(rgb(255, 210, 235), rgb(255, 110, 190), 1180, 1400) },
    { text: 'PLAY CODE:', scale: 13, color: rgb(255, 255, 255) },
    { text: 'MAKEFUN-HERON-', scale: 11, color: rgb(140, 235, 255) },
    { text: 'RECIPE-VERANDA', scale: 11, color: rgb(140, 235, 255) },
    { text: 'LINK IN DESCRIPTION', scale: 9, color: textGradient(rgb(255, 224, 130), rgb(255, 170, 60), 1900, 2000) },
    { text: 'LIKE + SUBSCRIBE', scale: 10, color: rgb(255, 255, 255) },
  ], 1180, 38);
  return cv;
}

// ---------------------------------------------------------------------------
// Main: render the ten masters, assemble with ffmpeg (slow zoom/pan per
// scene, 30fps, 36s), copy VIDEO.json to the output dir.
// ---------------------------------------------------------------------------
const SCENES: Array<{ fn: () => Canvas; frames: number; pan: number }> = [
  { fn: scene1, frames: 75, pan: 1 },
  { fn: scene2, frames: 90, pan: -1 },
  { fn: scene3, frames: 105, pan: 1 },
  { fn: scene4, frames: 105, pan: -1 },
  { fn: scene5, frames: 105, pan: 1 },
  { fn: scene6, frames: 120, pan: -1 },
  { fn: scene7, frames: 120, pan: 1 },
  { fn: scene8, frames: 120, pan: -1 },
  { fn: scene9, frames: 120, pan: 1 },
  { fn: scene10, frames: 120, pan: -1 },
];

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const framesDir = join(OUTPUT_DIR, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const masters: string[] = [];
  SCENES.forEach((sc, i) => {
    const t0 = Date.now();
    const cv = sc.fn();
    const path = join(framesDir, `scene-${String(i + 1).padStart(2, '0')}.png`);
    cv.finish(path, SEED + 100 + i);
    masters.push(path);
    console.log(`master ${i + 1}/10: ${path} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  });

  // ffmpeg: slow zoom (1.00 -> 1.10) + gentle pan per scene, concat, encode.
  const inputs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  masters.forEach((m, i) => {
    inputs.push('-i', m);
    const d = SCENES[i].frames;
    const dir = SCENES[i].pan;
    // zoom grows 1.00 -> 1.10 over the segment; pan drifts sideways.
    const z = `1+0.10*on/${d}`;
    const x = `(iw-iw/zoom)*(0.5+${0.35 * dir}*sin(on/45))`;
    const y = `(ih-ih/zoom)*(0.5+0.30*cos(on/38))`;
    filters.push(`[${i}:v]zoompan=z='${z}':x='${x}':y='${y}':d=${d}:s=${OUT_W}x${OUT_H}:fps=${FPS}[v${i}]`);
    labels.push(`[v${i}]`);
  });
  filters.push(`${labels.join('')}concat=n=${SCENES.length}:v=1:a=0,format=yuv420p[out]`);
  const clipPath = join(OUTPUT_DIR, 'clip.mp4');
  const t0 = Date.now();
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[out]',
      '-c:v', 'libx264', '-crf', '22', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-flags:v', '+bitexact', '-fflags', '+bitexact',
      '-metadata', 'creation_time=2026-01-01T00:00:00Z',
      '-movflags', '+faststart',
      '-an',
      clipPath,
    ],
    { stdio: 'inherit' },
  );
  console.log(`encoded ${clipPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // The gate reads VIDEO.json from the output dir.
  const videoJson = join(BOT_DIR, 'VIDEO.json');
  if (existsSync(videoJson)) {
    copyFileSync(videoJson, join(OUTPUT_DIR, 'VIDEO.json'));
    console.log('copied VIDEO.json to output');
  } else {
    console.error(`VIDEO.json not found in ${BOT_DIR}`);
    process.exit(1);
  }
}

main();
