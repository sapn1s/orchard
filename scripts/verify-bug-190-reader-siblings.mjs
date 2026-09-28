#!/usr/bin/env node
/**
 * BUG-190 round 4 — sibling sweep of the watcher's two defects into the store
 * readers (src/server/transcript.ts), against the REAL module on real files.
 *
 *  R1  tailMessages (backward, 1 MiB chunks) — a chunk boundary inside a
 *      multi-byte character must not decode as U+FFFD. Pre-fix measured on the
 *      real module: 3 of 4 byte offsets corrupted (only the aligned one clean).
 *  R2  readForward (forward, 1 MiB chunks) — same, forward direction.
 *  R3  countMessages — a record straddling the boundary is counted once.
 *  R4  a final record with NO trailing newline is read by all three readers
 *      (tail, forward, count) — the store side of the watcher's round-4 fix.
 *  R5  a genuinely PARTIAL final line is read by none of them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const tx = await import(process.env.BUG190_TX_MODULE ?? '../src/server/transcript.ts'); // env: run the arm against a pinned pre-fix copy

let pass = 0, fail = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        observed: ${JSON.stringify(observed)}`);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b190-readers-'));
const file = path.join(dir, 's.jsonl');
const rec = (t) => JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: t } }) + '\n';
const MiB = 1 << 20;
const hasFFFD = (x) => JSON.stringify(x).includes('\\ufffd') || JSON.stringify(x).includes('�');
const text = (m) => JSON.stringify(m.blocks ?? m.content ?? m);

try {
  // R1 — backward boundary inside the emoji run, at 4 byte offsets.
  const big = rec('🙂'.repeat(3000));
  const tailBad = [];
  for (let pad = 0; pad < 4; pad++) {
    const lastLen = MiB - big.length + 2000 + pad;
    fs.writeFileSync(file, rec('first') + big + rec('y'.repeat(lastLen - rec('').length)));
    tx.clearTranscriptCaches?.();
    const r = tx.tailMessages(file, { limit: 10 });
    if (hasFFFD(r.messages) || r.messages.length !== 3) tailBad.push({ pad, n: r.messages.length, fffd: hasFFFD(r.messages) });
  }
  check('R1: backward read — a 1 MiB chunk boundary inside a multi-byte character decodes whole (4 byte offsets)', tailBad.length === 0, { tailBad });

  // R2/R3 — forward boundary inside the emoji run.
  const fwdBad = [], countBad = [];
  for (let pad = 0; pad < 4; pad++) {
    const firstLen = MiB - 2000 + pad;
    fs.writeFileSync(file, rec('x'.repeat(firstLen - rec('').length)) + big + rec('last'));
    tx.clearTranscriptCaches?.();
    const r = tx.readForward(file, { offset: 0, limit: 10 });
    if (hasFFFD(r.messages) || r.messages.length !== 3) fwdBad.push({ pad, n: r.messages.length, fffd: hasFFFD(r.messages) });
    const c = tx.countMessages(file);
    if (c.total !== 3) countBad.push({ pad, total: c.total });
  }
  check('R2: forward read — a chunk boundary inside a multi-byte character decodes whole (4 byte offsets)', fwdBad.length === 0, { fwdBad });
  check('R3: count — the straddling record is counted exactly once', countBad.length === 0, { countBad });

  // R4 — final record complete but with NO trailing newline.
  fs.writeFileSync(file, rec('a') + rec('b') + rec('NO-NEWLINE-END').replace(/\n$/, ''));
  tx.clearTranscriptCaches?.();
  const t4 = tx.tailMessages(file, { limit: 10 }), f4 = tx.readForward(file, { offset: 0, limit: 10 }), c4 = tx.countMessages(file);
  check('R4: a final record with no trailing newline is read by tail, forward and count alike',
    t4.messages.length === 3 && f4.messages.length === 3 && c4.total === 3 && text(t4.messages.at(-1)).includes('NO-NEWLINE-END'),
    { tail: t4.messages.length, forward: f4.messages.length, count: c4.total });

  // R5 — a genuinely partial final line.
  const partial = rec('PARTIAL-END'); 
  fs.writeFileSync(file, rec('a') + rec('b') + partial.slice(0, partial.length - 15));
  tx.clearTranscriptCaches?.();
  const t5 = tx.tailMessages(file, { limit: 10 }), f5 = tx.readForward(file, { offset: 0, limit: 10 }), c5 = tx.countMessages(file);
  check('R5: a genuinely partial final line is read by none of them',
    t5.messages.length === 2 && f5.messages.length === 2 && c5.total === 2, { tail: t5.messages.length, forward: f5.messages.length, count: c5.total });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0;
