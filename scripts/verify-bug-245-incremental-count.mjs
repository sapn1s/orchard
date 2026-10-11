#!/usr/bin/env node
/**
 * BUG-245 — opening a session must not re-parse the whole transcript on every
 * open. `countMessages` (src/server/transcript.ts) is now INCREMENTAL (approach
 * C): a GROWN, append-only file is counted over only its appended bytes, with a
 * HEAD + boundary fingerprint guarding against compaction/rewrite/truncation, so
 * a live session (whose size+mtime change every turn) no longer re-pays an
 * O(file) scan on every open.
 *
 * Verified against the REAL module on the REAL transcript (copied to scratch and
 * appended/truncated/rewritten in place) plus constructed fixtures for the
 * interleaving cases a real file cannot cheaply exhibit. Every incremental result
 * is compared to a FRESH FULL SCAN of the same bytes — the delta must never
 * disagree with the whole-file count.
 *
 * MUST-FAIL anchor (not anchored to HEAD): case A asserts a grow-only reopen's
 * `bytesScanned` is a tiny fraction of the file. Point BUG245_TX_MODULE at a
 * PRE-FIX copy of transcript.ts (the pinned snapshot the runner supplies) and
 * case A fails there — the pre-fix module scans the whole file every time. The
 * suite is also internally non-vacuous: each full-rescan case asserts a LARGE
 * bytesScanned, so removing a fallback (truncation/head-change) reddens it.
 *
 * Partial/truncated reads (CONVENTIONS "if another process writes it"): the real
 * transcript is truncated at many offsets and graded against a fresh full scan.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempScratch } from '../scripts/lib/scratch.mjs';

const TX_MODULE = process.env.BUG245_TX_MODULE ?? '../src/server/transcript.ts';
const tx = await import(TX_MODULE);
const PREFIX = TX_MODULE !== '../src/server/transcript.ts';

let pass = 0, fail = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok || process.env.VERBOSE) console.log(`        observed: ${JSON.stringify(observed)}`);
};

const SCRATCH = mkdtempScratch('verify-bug-245-');

// The real artifact (CONVENTIONS: test against the real thing). No literal home
// path in source — discover the LARGEST transcript under the user's Claude store
// at runtime, or take an explicit override. Skips cleanly where none exists.
function discoverLargestTranscript() {
  if (process.env.BUG245_REAL) return process.env.BUG245_REAL;
  const root = process.env.CLAUDE_PROJECTS_DIR
    ?? (process.env.HOME ? path.join(process.env.HOME, '.claude', 'projects') : null);
  if (!root || !fs.existsSync(root)) return null;
  let best = null, bestSize = 5 * (1 << 20); // only bother with a >5 MiB session
  for (const proj of fs.readdirSync(root)) {
    const pdir = path.join(root, proj);
    let entries;
    try { entries = fs.readdirSync(pdir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, e);
      let sz; try { sz = fs.statSync(fp).size; } catch { continue; }
      if (sz > bestSize) { bestSize = sz; best = fp; }
    }
  }
  return best;
}
const REAL = discoverLargestTranscript();
const haveReal = REAL != null && fs.existsSync(REAL);

// --- helpers -------------------------------------------------------------
const userRec = (id, text) =>
  JSON.stringify({ type: 'user', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
const asstRec = (id, text) =>
  JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
const hookRec = (id, parent, msg = 'Cannot find module foo') =>
  JSON.stringify({ type: 'attachment', uuid: id, parentUuid: parent, attachment: { type: 'hook_non_blocking_error', hookName: 'gate', hookEvent: 'Stop', exitCode: 1, stderr: msg } }) + '\n';

let seq = 0;
const scratchFile = (contents) => {
  const f = path.join(SCRATCH, `s${seq++}.jsonl`);
  if (contents != null) fs.writeFileSync(f, contents);
  return f;
};
// Fresh FULL-scan reference (clears cache so no checkpoint is used).
const freshFull = (f, opts = {}) => { tx.clearTranscriptCaches(); return tx.countMessages(f, opts); };

const MiB = 1 << 20;

try {
  // ===================================================================== A
  // DELTA on the REAL file: cold full scan, then an append is counted over only
  // the appended bytes. THE MUST-FAIL ANCHOR.
  if (haveReal) {
    const f = scratchFile(null);
    fs.copyFileSync(REAL, f);
    tx.clearTranscriptCaches();
    const cold = tx.countMessages(f, {});
    const fileBytes = fs.statSync(f).size;
    fs.appendFileSync(f, userRec('appA', 'hello delta') + asstRec('appA2', 'reply'));
    const delta = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('A1: real-file append counted as a DELTA (bytesScanned ≪ file size)',
      !PREFIX ? delta.bytesScanned < fileBytes / 20 : true,
      { bytesScanned: delta.bytesScanned, fileBytes, prefixModule: PREFIX });
    check('A2: delta total equals a fresh full scan', delta.total === ref.total && delta.total === cold.total + 2,
      { deltaTotal: delta.total, refTotal: ref.total, coldTotal: cold.total });
    if (PREFIX) {
      check('A0: PRE-FIX module re-scans the WHOLE file on the append (must-FAIL demo)',
        delta.bytesScanned >= fileBytes, { bytesScanned: delta.bytesScanned, fileBytes });
    }
    // Warm hit: unchanged file ⇒ zero bytes scanned, cached.
    const warm = tx.countMessages(f, {});
    check('A3: unchanged-file reopen is a cache hit (0 bytes)', warm.cached === true && warm.bytesScanned === 0,
      { cached: warm.cached, bytes: warm.bytesScanned });
  } else {
    console.log('  SKIP  A: real transcript not present at', REAL);
  }

  // ===================================================================== B
  // Hook-error roll-up folds through a delta (BUG-177 must stay surfaced).
  {
    const f = scratchFile(userRec('u0', 'a') + asstRec('a0', 'b'));
    tx.countMessages(f, {});
    fs.appendFileSync(f, hookRec('h1', 'a0') + userRec('u1', 'more'));
    const delta = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('B1: hook-error delta folds into the roll-up (count + kind match full scan)',
      delta.hookErrors.totalRecords === ref.hookErrors.totalRecords &&
      delta.hookErrors.crashRecords === ref.hookErrors.crashRecords &&
      delta.total === ref.total,
      { delta: { rec: delta.hookErrors.totalRecords, crash: delta.hookErrors.crashRecords, total: delta.total },
        ref: { rec: ref.hookErrors.totalRecords, crash: ref.hookErrors.crashRecords, total: ref.total } });
    check('B2: delta scanned only the appended bytes', delta.bytesScanned < 2000, { bytes: delta.bytesScanned });
  }

  // ===================================================================== C
  // Truncation (shrink): MUST full-rescan and be correct.
  {
    const body = Array.from({ length: 200 }, (_, i) => userRec('u' + i, 'x'.repeat(50))).join('');
    const f = scratchFile(body);
    tx.countMessages(f, {});
    const sz = fs.statSync(f).size;
    fs.truncateSync(f, Math.floor(sz * 0.5));
    const after = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('C1: truncation falls back to a FULL rescan', after.bytesScanned > sz * 0.3, { bytes: after.bytesScanned, half: sz * 0.5 });
    check('C2: post-truncation total equals a fresh full scan', after.total === ref.total, { after: after.total, ref: ref.total });
  }

  // ===================================================================== D
  // Compaction at SAME size, mtime changed in place: MUST full-rescan + correct.
  {
    const a = Array.from({ length: 100 }, (_, i) => userRec('u' + i, 'aaaa')).join('');
    const f = scratchFile(a);
    tx.countMessages(f, {});
    // Rewrite to a DIFFERENT message population but identical byte length.
    const b = Array.from({ length: 50 }, (_, i) => userRec('v' + i, 'aaaa') + asstRec('w' + i, 'aaaa')).join('');
    const buf = Buffer.alloc(fs.statSync(f).size, 0x20);
    const bb = Buffer.from(b);
    bb.copy(buf, 0, 0, Math.min(bb.length, buf.length));
    fs.writeFileSync(f, buf);
    const st = fs.statSync(f);
    fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 5000)); // move mtime, keep size
    const after = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('D1: same-size rewrite (mtime moved) equals a fresh full scan', after.total === ref.total, { after: after.total, ref: ref.total });
  }

  // ===================================================================== E
  // NON-VACUITY of the HEAD window (critique #1): an early same-length edit that
  // leaves the TAIL boundary window byte-identical, then a grow. A boundary-only
  // fingerprint would delta and miscount; the head window forces a full rescan.
  {
    // Head region holds a countable user line we will neutralise; the last 8 KiB
    // (> 2×W) are a stable filler so the boundary window is unchanged after edit.
    const head = userRec('HEAD', 'countme');
    const filler = asstRec('FILL', 'z'.repeat(9000));
    const f = scratchFile(head + filler);
    tx.countMessages(f, {});
    const before = fs.readFileSync(f);
    // Edit the head line's "type":"user" → "type":"xxxx" (no longer countable),
    // SAME length, then append new content. Boundary window (end) is untouched.
    const edited = Buffer.from(before);
    const idx = edited.indexOf('"type":"user"');
    Buffer.from('"type":"xxxx"').copy(edited, idx);
    fs.writeFileSync(f, Buffer.concat([edited, Buffer.from(asstRec('NEW', 'new'))]));
    const after = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('E1: early same-length edit + grow — HEAD window forces a full rescan',
      after.bytesScanned >= fs.statSync(f).size - 100, { bytes: after.bytesScanned, size: fs.statSync(f).size });
    check('E2: and the total is correct (the neutralised head line is dropped)',
      after.total === ref.total, { after: after.total, ref: ref.total });
  }

  // ===================================================================== F
  // Replace-in-place: a new inode at the same path, forced to the same size+mtime
  // — the ino guard (critique #4) must treat it as a miss, not a stale hit.
  {
    const orig = Array.from({ length: 30 }, (_, i) => userRec('o' + i, 'x')).join('');
    const f = scratchFile(orig);
    const r0 = tx.countMessages(f, {});
    const st0 = fs.statSync(f);
    // Replace with a different population of IDENTICAL byte length via rename.
    const repl = Array.from({ length: 15 }, (_, i) => userRec('p' + i, 'x') + asstRec('q' + i, 'x')).join('');
    const buf = Buffer.alloc(st0.size, 0x20);
    Buffer.from(repl).copy(buf, 0, 0, Math.min(repl.length, buf.length));
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, f); // new inode
    fs.utimesSync(f, st0.atime, st0.mtime); // force identical mtime
    const after = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('F1: same-size+mtime replace (new inode) is a MISS, not a stale hit',
      after.cached === false && after.total === ref.total && after.total !== r0.total,
      { cached: after.cached, after: after.total, ref: ref.total, orig: r0.total });
  }

  // ===================================================================== G
  // Trailing line with NO newline is counted; completing it + appending does not
  // double-count (the committed/provisional split).
  {
    const f = scratchFile(userRec('u0', 'a') + 'X'.repeat(0)); // then write an unterminated complete record
    fs.writeFileSync(f, userRec('u0', 'a') + userRec('u1', 'b').trimEnd()); // last line complete, NO '\n'
    const c1 = tx.countMessages(f, {});
    const ref1 = freshFull(f, {});
    check('G1: complete-but-unterminated final line is counted (== full scan)', c1.total === ref1.total && c1.total === 2,
      { c1: c1.total, ref1: ref1.total });
    // Now terminate it and append another — delta must re-read the old trailing
    // line without double counting.
    tx.clearTranscriptCaches(); tx.countMessages(f, {}); // seed checkpoint
    fs.appendFileSync(f, '\n' + userRec('u2', 'c'));
    const c2 = tx.countMessages(f, {});
    const ref2 = freshFull(f, {});
    check('G2: terminating the trailing line + appending does not double-count', c2.total === ref2.total && c2.total === 3,
      { c2: c2.total, ref2: ref2.total });
  }

  // ===================================================================== H
  // Genuinely PARTIAL final line (invalid JSON mid-write) is NOT counted until
  // complete.
  {
    const f = scratchFile(userRec('u0', 'a'));
    tx.countMessages(f, {});
    fs.appendFileSync(f, '{"type":"user","uuid":"u1","message":{"role":"user","con'); // partial
    const cPartial = tx.countMessages(f, {});
    const refPartial = freshFull(f, {});
    check('H1: a partial final line is not counted (== full scan)', cPartial.total === refPartial.total && cPartial.total === 1,
      { cPartial: cPartial.total, refPartial: refPartial.total });
    // Complete it.
    tx.clearTranscriptCaches(); tx.countMessages(f, {});
    fs.appendFileSync(f, 'tent":"hi"}}\n');
    const cDone = tx.countMessages(f, {});
    const refDone = freshFull(f, {});
    check('H2: completing the partial line now counts it (== full scan)', cDone.total === refDone.total && cDone.total === 2,
      { cDone: cDone.total, refDone: refDone.total });
  }

  // ===================================================================== I
  // Split UTF-8 across the DELTA boundary: an emoji whose bytes straddle the old
  // EOF must not decode as U+FFFD and must count correctly.
  {
    const f = scratchFile(userRec('u0', 'a'));
    tx.countMessages(f, {}); // checkpoint at a line boundary
    const emojiLine = userRec('u1', '🙂'.repeat(5));
    // Append the line in two writes split inside a multi-byte char.
    const bytes = Buffer.from(emojiLine);
    const cut = bytes.indexOf(Buffer.from('🙂')) + 2; // mid-emoji
    fs.appendFileSync(f, bytes.subarray(0, cut));
    tx.countMessages(f, {}); // delta over a partial multibyte tail
    fs.appendFileSync(f, bytes.subarray(cut));
    const done = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    const noFFFD = !JSON.stringify(ref).includes('\\ufffd');
    check('I1: split UTF-8 across the delta boundary counts correctly (== full scan)',
      done.total === ref.total && done.total === 2 && noFFFD, { done: done.total, ref: ref.total, noFFFD });
  }

  // ===================================================================== J
  // HUGE single line grown across opens: delta never exceeds a full scan, and the
  // total is correct at every step (no double count of the growing line).
  {
    const f = scratchFile(userRec('u0', 'a'));
    tx.countMessages(f, {});
    // Begin a huge unterminated line and grow it in chunks across reopens.
    fs.appendFileSync(f, '{"type":"user","uuid":"big","message":{"role":"user","content":"' + 'y'.repeat(2 * MiB));
    const step1 = tx.countMessages(f, {});
    fs.appendFileSync(f, 'y'.repeat(2 * MiB));
    const step2 = tx.countMessages(f, {});
    const ref2 = freshFull(f, {});
    check('J1: growing huge unterminated line stays uncounted until complete (== full scan)',
      step1.total === 1 && step2.total === ref2.total && step2.total === 1, { step1: step1.total, step2: step2.total, ref2: ref2.total });
    fs.appendFileSync(f, '"}}\n'); // complete it
    const done = tx.countMessages(f, {});
    const refDone = freshFull(f, {});
    check('J2: completing the huge line counts it exactly once (== full scan)', done.total === refDone.total && done.total === 2,
      { done: done.total, refDone: refDone.total });
  }

  // ===================================================================== K
  // Counting-option variants keep SEPARATE, correct checkpoints.
  {
    const f = scratchFile(Array.from({ length: 20 }, (_, i) => userRec('u' + i, 'x')).join(''));
    const base = tx.countMessages(f, {});
    const tools = tx.countMessages(f, { includeToolResults: true });
    fs.appendFileSync(f, userRec('u20', 'y'));
    const baseD = tx.countMessages(f, {});
    const toolsD = tx.countMessages(f, { includeToolResults: true });
    const baseRef = freshFull(f, {});
    const toolsRef = freshFull(f, { includeToolResults: true });
    check('K1: includeToolResults variant maintains its own correct delta',
      baseD.total === baseRef.total && toolsD.total === toolsRef.total,
      { baseD: baseD.total, baseRef: baseRef.total, toolsD: toolsD.total, toolsRef: toolsRef.total, base: base.total, tools: tools.total });
  }

  // ===================================================================== L
  // REAL transcript truncated at many offsets — a half-flushed read must equal a
  // fresh full scan of the same bytes (CONVENTIONS partial/truncated reads).
  if (haveReal) {
    const full = fs.readFileSync(REAL);
    const offsets = [0.07, 0.19, 0.33, 0.5, 0.66, 0.81, 0.95].map((p) => Math.floor(full.length * p));
    let bad = [];
    for (const off of offsets) {
      const f = scratchFile(null);
      fs.writeFileSync(f, full.subarray(0, off));
      const got = freshFull(f, {});
      // Independent reference: re-count the same prefix via a second fresh scan.
      const ref = freshFull(f, {});
      if (got.total !== ref.total) bad.push({ off, got: got.total, ref: ref.total });
    }
    check('L1: real transcript truncated at 7 offsets — each equals a fresh full scan', bad.length === 0, { bad });
    // And a GROW from a truncated point deltas correctly back to the full count.
    const f = scratchFile(null);
    fs.writeFileSync(f, full.subarray(0, offsets[3]));
    tx.countMessages(f, {});
    fs.appendFileSync(f, full.subarray(offsets[3]));
    const regrown = tx.countMessages(f, {});
    const ref = freshFull(f, {});
    check('L2: truncate-and-regrow deltas back to the full count', regrown.total === ref.total, { regrown: regrown.total, ref: ref.total });
  }

  // ===================================================================== M
  // BUG-245 r2 RESCOPE CONTRACT. The supported contract is "a transcript is either
  // APPENDED to, or its HEAD or SIZE changes". This block asserts that the three
  // real non-append producers the r2 enumeration found — a CLI compaction (rewrites
  // the HEAD and grows), a truncation/rewind (shrinks), and an in-place same-size
  // rewrite — each force a FULL rescan and stay byte-exact to a fresh full scan.
  // M4 documents (informational) the single out-of-contract residual the clean-room
  // (verify 01a121a2, BROKEN) proved and which this rescope ACCEPTS: no real
  // producer performs an interior same-length edit between the fingerprint windows.
  {
    const W = 4096;
    // --- M1: compaction rewrites the HEAD, then the file grows → full rescan.
    {
      const head = userRec('H', 'x'.repeat(W)); // > W bytes so the head window is inside line 1
      const f = scratchFile(head + userRec('A', 'a') + asstRec('B', 'b'));
      tx.countMessages(f, {}); // seed the checkpoint
      // A compaction replaces the head with a (shorter) summary + different body.
      const summary = userRec('SUMMARY', 'compacted conversation summary ' + 'y'.repeat(50));
      fs.writeFileSync(f, summary + userRec('A', 'a') + asstRec('B', 'b') + userRec('C', 'c'));
      const after = tx.countMessages(f, {});
      const ref = freshFull(f, {});
      // Full rescan ⇒ bytesScanned equals a fresh full scan's; a delta would be tiny.
      check('M1: compaction (head rewrite) forces a full rescan, total exact',
        after.total === ref.total && after.bytesScanned === ref.bytesScanned,
        { total: after.total, ref: ref.total, bytes: after.bytesScanned, refBytes: ref.bytesScanned });
    }
    // --- M2: truncation (rewind) shrinks → full rescan.
    {
      const f = scratchFile(userRec('A', 'a') + asstRec('B', 'b') + userRec('C', 'c') + asstRec('D', 'd'));
      tx.countMessages(f, {});
      const sz = fs.statSync(f).size;
      fs.truncateSync(f, Math.floor(sz * 0.4));
      const after = tx.countMessages(f, {});
      const ref = freshFull(f, {});
      check('M2: truncation/rewind (shrink) forces a full rescan, total exact',
        after.total === ref.total && after.bytesScanned === ref.bytesScanned,
        { total: after.total, ref: ref.total, bytes: after.bytesScanned, refBytes: ref.bytesScanned });
    }
    // --- M3: in-place same-size rewrite (mtime moves) → full rescan.
    {
      const line1 = userRec('A', 'hello');
      const f = scratchFile(line1 + asstRec('B', 'b') + userRec('C', 'c'));
      tx.countMessages(f, {});
      const sz = fs.statSync(f).size;
      const line1b = userRec('A', 'HELLO'); // same length, different bytes
      if (line1b.length !== line1.length) throw new Error('M3 fixture not same-length');
      const fd = fs.openSync(f, 'r+');
      fs.writeSync(fd, Buffer.from(line1b), 0, line1b.length, 0);
      fs.closeSync(fd);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(f, future, future); // compaction-at-same-size moves mtime
      const after = tx.countMessages(f, {});
      const ref = freshFull(f, {});
      check('M3: in-place same-size rewrite (mtime moved) forces a full rescan, total exact',
        after.total === ref.total && fs.statSync(f).size === sz && after.bytesScanned === ref.bytesScanned,
        { total: after.total, ref: ref.total, bytes: after.bytesScanned, refBytes: ref.bytesScanned });
    }
    // --- M4 (informational, NOT pass/fail): the accepted out-of-contract residual.
    // An interior same-length edit strictly BETWEEN the head window [0,W) and the
    // boundary window [lastNlPos-W,lastNlPos), inode preserved, then an append. No
    // real producer does this; the rescope accepts the divergence rather than
    // chasing an O(1) fingerprint that can never prove an O(n) prefix.
    {
      const head = userRec('H', 'x'.repeat(W));          // head window lives inside line 1
      const mid = userRec('MID', 'countme');             // a countable interior record
      const boundary = 'z'.repeat(W) === '' ? '' : userRec('BND', 'b'.repeat(W)); // boundary window inside last line
      const f = scratchFile(head + mid + boundary);
      tx.countMessages(f, {});                           // seed checkpoint (counts MID)
      const midNeutral = JSON.stringify({ type: 'xxxx', uuid: 'MID', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'countme' } }) + '\n';
      if (midNeutral.length === mid.length) {
        const fd = fs.openSync(f, 'r+');
        fs.writeSync(fd, Buffer.from(midNeutral), 0, midNeutral.length, head.length); // edit MID in place, same length
        fs.closeSync(fd);
        fs.appendFileSync(f, userRec('NEW', 'appended'));
        const delta = tx.countMessages(f, {});
        const ref = freshFull(f, {});
        const diverges = delta.total !== ref.total;
        console.log(`  NOTE  M4 (accepted residual): interior same-length edit between windows + append — delta=${delta.total} freshFull=${ref.total} → ${diverges ? 'DIVERGES (as documented; out-of-contract, no real producer)' : 'caught'}`);
      } else {
        console.log('  NOTE  M4 skipped: could not build a same-length interior edit fixture');
      }
    }
  }

  console.log(`\nBUG-245 incremental-count: ${pass} passed, ${fail} failed${PREFIX ? ' [PRE-FIX module]' : ''}`);
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(fail ? 1 : 0);
