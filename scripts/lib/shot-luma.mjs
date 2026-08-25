/**
 * Screenshot self-checks for the verify harnesses — FEAT-082 (visual review).
 *
 * WHY THIS EXISTS. The digest harness wrote a light capture and a dark capture
 * to two different filenames, and both files came out byte-identical (same md5,
 * both DARK): the dark leg silently overwrote the light one. Nothing failed —
 * the run was green — so the builder concluded "dark capture is broken" while the
 * real defect was that the two shots were never two shots. A screenshot the run
 * never inspects is not evidence; a mislabelled one is worse than none, because
 * a later reviewer grades the wrong pixels and files findings against them.
 *
 * So every capture is now graded on its own content:
 *   · a file labelled DARK must actually be dark, one labelled LIGHT must be light
 *     (mean luminance of the decoded pixels, not the page's computed styles — the
 *     styles were right in the failing run; the FILE was wrong);
 *   · no two captures within one run may be byte-identical.
 *
 * The PNG decoder here is deliberately minimal (8-bit, non-interlaced — what
 * CDP's Page.captureScreenshot emits) and has no dependencies.
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';

/** Decode an 8-bit non-interlaced PNG to { width, height, pixels } (RGBA rows). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.depth !== 8) throw new Error(`unsupported PNG bit depth ${ihdr.depth}`);
  if (ihdr.interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${ihdr.colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

/** Mean perceptual luminance (0-255) of a PNG file, sampled on a grid. */
export function meanLuma(file) {
  const { width, height, channels, pixels } = decodePng(fs.readFileSync(file));
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  let sum = 0, n = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = y * width * channels + x * channels;
      const r = pixels[i];
      const g = channels >= 3 ? pixels[i + 1] : r;
      const b = channels >= 3 ? pixels[i + 2] : r;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return { luma: sum / n, width, height };
}

export const md5 = (file) => createHash('md5').update(fs.readFileSync(file)).digest('hex');

/**
 * A per-run screenshot ledger. `record(file, tone)` grades one capture:
 *   · tone 'dark'  → mean luminance must be < 90
 *   · tone 'light' → mean luminance must be > 150
 *   · tone null    → tone not asserted (still deduplicated)
 * and refuses a byte-identical twin of an earlier capture in the same run.
 * Thresholds sit either side of a wide neutral band, so an ordinary theme tweak
 * never trips them but a light/dark mix-up always does (the failing run's two
 * files measured ~30; the light one should measure ~245).
 */
export function shotLedger({ dark = 90, light = 150 } = {}) {
  const seen = new Map(); // md5 → first file that had it
  return {
    /** @returns {{ ok: boolean, why: string }} */
    record(file, tone = null) {
      let m;
      try { m = meanLuma(file); } catch (err) { return { ok: false, why: `unreadable capture: ${err.message}` }; }
      const digest = md5(file);
      const twin = seen.get(digest);
      seen.set(digest, twin ?? file);
      const why = `luma=${m.luma.toFixed(1)} ${m.width}x${m.height} md5=${digest.slice(0, 8)}`;
      if (twin) return { ok: false, why: `${why} — BYTE-IDENTICAL to ${twin} (one capture overwrote the other)` };
      if (tone === 'dark' && !(m.luma < dark)) return { ok: false, why: `${why} — labelled dark but is not dark (needs < ${dark})` };
      if (tone === 'light' && !(m.luma > light)) return { ok: false, why: `${why} — labelled light but is not light (needs > ${light})` };
      return { ok: true, why };
    },
  };
}
