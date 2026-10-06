#!/usr/bin/env node
/**
 * store-io.ts — the shared data-loss-safe primitives (FEAT-126 / BUG-202 round 6).
 *
 *   node scripts/verify-store-io.mjs
 *
 * The FEAT-126 round-6 independent verify (run 8e8e3761) found THREE defects that
 * every store's private quarantine/read copy shared:
 *   1. quarantine renamed onto `<file>.corrupt-<ts>` with no existence check —
 *      silently OVERWRITING an earlier quarantine of that name;
 *   2. two quarantines in the SAME millisecond collided, DESTROYING the first;
 *   3. the size guard was stat-then-unbounded-read — a file that grows between the
 *      stat and the read is read in full, bypassing the cap.
 *
 * ARCH-010 fix: one shared owner (src/server/store-io.ts). This suite proves each
 * defect fixed, with the MUST-FAIL anchored to a self-contained inline PRE-FIX
 * SIMULATION (a fixed synthesized baseline — not a moving reference), exactly the
 * methodology BUG-202's own suite uses.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { quarantine, readCapped } = await import(path.join(ROOT, 'src', 'server', 'store-io.ts'));

let pass = 0; const fails = [];
function T(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL ${name}\n       ${err?.message ?? err}`); }
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'store-io-'));
const corruptFiles = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(base + '.corrupt-'));

/* ── PRE-FIX SIMULATIONS (fixed baselines) ──────────────────────────────────── */
// The old quarantine: rename onto an ISO-timestamp name, no existence check.
function oldQuarantine(file, nowIso) {
  const dest = `${file}.corrupt-${(nowIso ?? new Date().toISOString()).replace(/[^0-9]/g, '')}`;
  try { fs.renameSync(file, dest); return dest; }
  catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}
// The old read guard: statSync then unbounded readFileSync.
function oldReadGuard(file, max, growTo) {
  const sz = fs.statSync(file).size;      // sees the CURRENT (small) size
  if (sz > max) return { refused: true };
  if (growTo !== undefined) fs.writeFileSync(file, growTo); // the file GROWS after the stat
  const data = fs.readFileSync(file, 'utf8'); // reads unbounded — bypassed
  return { refused: false, bytes: data.length };
}

/* ── Defect 1: quarantine must never overwrite an earlier quarantine ─────────── */
T('DEFECT 1 (no-clobber): PRE-FIX overwrites an existing quarantine of the same name', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd1old-'));
  const f = path.join(d, 'store.json');
  // Two corrupt events that map to the same ISO timestamp (frozen).
  fs.writeFileSync(f, 'FIRST');
  const a = oldQuarantine(f, '2026-09-30T00:00:00.000Z');
  fs.writeFileSync(f, 'SECOND');
  const b = oldQuarantine(f, '2026-09-30T00:00:00.000Z'); // same name → renameSync clobbers
  assert.equal(a, b, 'pre-fix picks the same name');
  assert.equal(fs.readFileSync(a, 'utf8'), 'SECOND', 'pre-fix: first bytes destroyed');
  assert.equal(corruptFiles(d, 'store.json').length, 1, 'pre-fix left only one quarantine');
});
T('DEFECT 1 (no-clobber): the FIX preserves both quarantines, never overwriting', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd1fix-'));
  const f = path.join(d, 'store.json');
  fs.writeFileSync(f, 'FIRST'); const a = quarantine(f, 'test');
  fs.writeFileSync(f, 'SECOND'); const b = quarantine(f, 'test');
  assert.notEqual(a, b, 'distinct quarantine names');
  assert.equal(fs.readFileSync(a, 'utf8'), 'FIRST');
  assert.equal(fs.readFileSync(b, 'utf8'), 'SECOND');
  assert.equal(corruptFiles(d, 'store.json').length, 2, 'both preserved');
  // Even a pre-EXISTING file that happens to collide is never overwritten (O_EXCL).
  fs.writeFileSync(f, 'THIRD'); const c = quarantine(f, 'test');
  assert.equal(fs.readFileSync(c, 'utf8'), 'THIRD');
  assert.equal(corruptFiles(d, 'store.json').length, 3);
});

/* ── Defect 2: two quarantines in the SAME millisecond ───────────────────────── */
T('DEFECT 2 (same-ms): PRE-FIX destroys the first when the clock does not advance', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd2old-'));
  const f = path.join(d, 'store.json');
  const FROZEN = '2026-09-30T12:00:00.123Z';
  fs.writeFileSync(f, 'A'); oldQuarantine(f, FROZEN);
  fs.writeFileSync(f, 'B'); oldQuarantine(f, FROZEN);
  assert.equal(corruptFiles(d, 'store.json').length, 1, 'pre-fix: same-ms collapsed to one file');
});
T('DEFECT 2 (same-ms): the FIX keeps both even with Date.now frozen', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd2fix-'));
  const f = path.join(d, 'store.json');
  const realNow = Date.now;
  Date.now = () => 1_790_000_000_000; // freeze — the random suffix must carry uniqueness
  try {
    fs.writeFileSync(f, 'A'); const a = quarantine(f, 'test');
    fs.writeFileSync(f, 'B'); const b = quarantine(f, 'test');
    assert.notEqual(a, b);
    assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B');
    assert.equal(corruptFiles(d, 'store.json').length, 2);
  } finally { Date.now = realNow; }
});

/* ── Defect 3: read bounded by the fd, not a prior stat ──────────────────────── */
T('DEFECT 3 (TOCTOU): PRE-FIX stat-then-read reads a file that GREW past the cap', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd3old-'));
  const f = path.join(d, 'store.json');
  const MAX = 4096;
  fs.writeFileSync(f, 'x'.repeat(100)); // small at stat time
  const grown = 'y'.repeat(MAX * 4);
  const r = oldReadGuard(f, MAX, grown); // stat sees 100B (<=MAX), then file grows, read is unbounded
  assert.equal(r.refused, false, 'pre-fix passed the guard');
  assert.ok(r.bytes > MAX, `pre-fix read ${r.bytes} bytes (> cap ${MAX}) — bypassed`);
});
T('DEFECT 3 (bounded): the FIX refuses an over-cap file, reading at most max+1', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'd3fix-'));
  const f = path.join(d, 'store.json');
  const MAX = 4096;
  fs.writeFileSync(f, 'y'.repeat(MAX * 4));
  assert.equal(readCapped(f, MAX).kind, 'toobig');
  // within the cap → ok, exact bytes
  fs.writeFileSync(f, 'hello');
  const ok = readCapped(f, MAX);
  assert.equal(ok.kind, 'ok'); assert.equal(ok.data, 'hello');
  // absent → absent (ENOENT distinguished from unreadable)
  assert.equal(readCapped(path.join(d, 'nope.json'), MAX).kind, 'absent');
  // a directory at the path → error (present but unreadable), never a throw
  fs.mkdirSync(path.join(d, 'adir'));
  assert.equal(readCapped(path.join(d, 'adir'), MAX).kind, 'error');
  // exactly at the cap boundary → ok (max bytes), max+1 → toobig
  fs.writeFileSync(f, 'z'.repeat(MAX)); assert.equal(readCapped(f, MAX).kind, 'ok');
  fs.writeFileSync(f, 'z'.repeat(MAX + 1)); assert.equal(readCapped(f, MAX).kind, 'toobig');
});

/* ── quarantine edge: a vanished source is a no-op (null), not a throw ────────── */
T('quarantine: a source that does not exist returns null (no throw, no stray file)', () => {
  const d = fs.mkdtempSync(path.join(scratch, 'qv-'));
  const f = path.join(d, 'gone.json');
  assert.equal(quarantine(f, 'test'), null);
  assert.equal(corruptFiles(d, 'gone.json').length, 0, 'no stray placeholder left behind');
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.error('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
