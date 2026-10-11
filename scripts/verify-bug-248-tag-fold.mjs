#!/usr/bin/env node
/**
 * BUG-248 — the pin tag as a RESUMABLE FOLD, so the session LIST does not rescan a
 * whole (usually UNTAGGED) transcript on every live reopen.
 *
 * Two properties:
 *  C (correctness) pin state == a FRESH FULL SCAN after append / tag / untag /
 *    compaction (head rewrite) / truncation / replace, and across the REAL
 *    transcript truncated at several offsets (CONVENTIONS "partial and truncated
 *    reads"). Ground truth = readTitleMeta on a never-cached COPY (a cold full
 *    scanTagBackward).
 *  D (delta engages) a live reopen of a large grown file folds only the appended
 *    bytes. Measured as time; graded as a ratio against the SAME file read with the
 *    cache cleared (the pre-fix behaviour: a full scan every changed reopen). The
 *    fold must be dramatically faster; a full-scan-every-time module cannot be.
 *
 * MUST-FAIL (not HEAD-anchored): BUG248_MUT_MODULE pointing at a pinned pre-fix
 * copy (no resumable fold — full scan every changed file) makes D redden: its warm
 * reopen is ~as slow as a cache-cleared read (no speedup).
 *
 * SYNTHETIC fixtures mirror the real CLI record shapes; the REAL transcript is used
 * where available (discovered or BUG245_REAL).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempScratch } from '../scripts/lib/scratch.mjs';

const MOD = process.env.BUG248_MUT_MODULE ?? new URL('../src/server/session-mutations.ts', import.meta.url).href;
const sm = await import(MOD);
const PIN = sm.PIN_TAG;

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok || process.env.VERBOSE) console.log(`        observed: ${JSON.stringify(observed)}`);
};
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} — ${why}`); };
// Informational only — documents an accepted out-of-contract behaviour; never a pass/fail.
const info = (name, observed) => console.log(`  INFO  ${name}\n        ${JSON.stringify(observed)}`);

const SCRATCH = mkdtempScratch('verify-bug-248-');
let seq = 0;
const scratchFile = (contents) => { const f = path.join(SCRATCH, `s${seq++}.jsonl`); if (contents != null) fs.writeFileSync(f, contents); return f; };

// --- fixtures (SYNTHETIC — shapes mirror real CLI records) -----------------
const userRec = (id, text) => JSON.stringify({ type: 'user', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
const asstRec = (id, text) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
const tagRec = (tag) => JSON.stringify({ type: 'tag', tag, sessionId: 's' }) + '\n';
// NON-COMPACT / ESCAPED tag records a full JSON parse accepts but the r4 substring
// prefilter `line.indexOf('"type":"tag"')` SKIPS (BUG-248 r5). Each parses to a
// record whose top-level type === "tag".
const tagRecSpaced = (tag) => JSON.stringify({ type: 'tag', tag, sessionId: 's' }, null, 1).replace(/\n\s*/g, ' ') + '\n'; // `{ "type": "tag", … }` — space after each colon
const tagRecEscaped = (tag) => `{"type":"ta\\u0067","tag":${JSON.stringify(tag)},"sessionId":"s"}` + '\n'; // g === 'g'
// The r4 predicate, synthesized here (NOT anchored to HEAD): what the prefilter let
// through. A line is folded by r4 only if it contains this exact compact substring.
const r4PrefilterAccepts = (line) => line.indexOf('"type":"tag"') !== -1;
const titleRec = (t) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' }) + '\n';

/** Read via a never-cached COPY: a cold full scanTagBackward (ground truth). */
const freshMeta = (f) => {
  const copy = path.join(SCRATCH, `fresh-${seq++}.jsonl`);
  fs.copyFileSync(f, copy);
  try { return sm.readTitleMeta(copy); } finally { try { fs.unlinkSync(copy); } catch { /* best effort */ } }
};
const tagEq = (a, b) => a.tag === b.tag && a.pinned === b.pinned;
const brief = (m) => ({ tag: m.tag, pinned: m.pinned });

// A realistic body: many message lines (the untagged bulk the ticket is about).
const bodyOf = (n, startId = 0) => {
  let s = '';
  for (let i = 0; i < n; i++) { s += userRec('u' + (startId + i), `q ${i} naïve café ✓`); s += asstRec('a' + (startId + i), `reply ${i} 日本語 🌲`); }
  return s;
};

try {
  // ===================================================================== C (correctness)
  // C1 — a tag in the UNSUMMARISED MIDDLE (why a bounded-tail read is wrong; FEAT-168 r1/2).
  {
    const f = scratchFile(bodyOf(40) + tagRec(PIN) + bodyOf(400, 40)); // pin ~1% in, buried under 400 later turns
    sm.clearTitleMetaCache();
    const got = sm.readTitleMeta(f);
    check('C1: a pin tag buried in the middle is found (not a bounded-tail read) == fresh', got.tag === PIN && got.pinned === true && tagEq(got, freshMeta(f)), brief(got));
  }
  // C2 — pure APPEND after an untagged read: still untagged, == fresh.
  {
    const f = scratchFile(bodyOf(30));
    sm.clearTitleMetaCache();
    sm.readTitleMeta(f); // warm: full scan, checkpoint
    fs.appendFileSync(f, bodyOf(10, 30)); // live append
    const got = sm.readTitleMeta(f); // delta
    check('C2: untagged + append (live reopen) stays untagged == fresh', got.tag === null && tagEq(got, freshMeta(f)), brief(got));
  }
  // C3 — TAG appended between reopens (pin): delta picks up the new last-tag.
  {
    const f = scratchFile(bodyOf(30));
    sm.clearTitleMetaCache();
    sm.readTitleMeta(f);
    fs.appendFileSync(f, tagRec(PIN));
    const got = sm.readTitleMeta(f);
    check('C3: pin appended between reopens — delta reports pinned == fresh', got.tag === PIN && got.pinned && tagEq(got, freshMeta(f)), brief(got));
    // C4 — UNTAG (clearing tag) appended next: delta clears, last-record-wins.
    fs.appendFileSync(f, bodyOf(3, 100) + tagRec('')); // a clearing tag record is last
    const got2 = sm.readTitleMeta(f);
    check('C4: clearing tag appended after a pin — delta clears == fresh (last record wins)', got2.tag === null && !got2.pinned && tagEq(got2, freshMeta(f)), brief(got2));
    // C5 — re-pin appended: delta re-pins.
    fs.appendFileSync(f, tagRec(PIN));
    const got3 = sm.readTitleMeta(f);
    check('C5: re-pin appended — delta pins again == fresh', got3.tag === PIN && got3.pinned && tagEq(got3, freshMeta(f)), brief(got3));
  }
  // C6 — a trailing complete-JSON tag line with NO newline is NOT committed until its newline lands.
  {
    const f = scratchFile(bodyOf(10));
    sm.clearTitleMetaCache();
    sm.readTitleMeta(f);
    fs.appendFileSync(f, tagRec(PIN).trimEnd()); // pin WITHOUT a trailing newline (uncommitted)
    const mid = sm.readTitleMeta(f);
    check('C6a: an uncommitted (no-newline) pin line is NOT yet pinned == fresh', mid.tag === null && tagEq(mid, freshMeta(f)), brief(mid));
    fs.appendFileSync(f, '\n'); // commit it
    const done = sm.readTitleMeta(f);
    check('C6b: once the newline lands the pin commits == fresh', done.tag === PIN && done.pinned && tagEq(done, freshMeta(f)), brief(done));
  }
  // C7 — COMPACTION (head rewrite) that keeps a pin in the new head, then grows: full rescan, == fresh.
  {
    const f = scratchFile(bodyOf(50) + tagRec(PIN) + bodyOf(50, 50));
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f);
    // compaction rewrites from the head (summary) and changes size; pin removed by the rewrite.
    fs.writeFileSync(f, titleRec('compacted') + bodyOf(5, 1000));
    fs.appendFileSync(f, bodyOf(5, 2000));
    const got = sm.readTitleMeta(f);
    check('C7: compaction (head rewrite) drops the pin — full rescan, == fresh (no stale pin)', before.pinned && got.tag === null && tagEq(got, freshMeta(f)), { before: brief(before), got: brief(got) });
  }
  // C8 — TRUNCATION (/rewind) below the checkpoint: full rescan, == fresh.
  {
    const f = scratchFile(bodyOf(20) + tagRec(PIN) + bodyOf(20, 20));
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f);
    const buf = fs.readFileSync(f);
    fs.truncateSync(f, buf.indexOf('\n', buf.indexOf('"uuid":"u5"')) + 1); // back before the pin
    const got = sm.readTitleMeta(f);
    check('C8: truncate below the pin — full rescan drops it, == fresh', before.pinned && got.tag === null && tagEq(got, freshMeta(f)), { before: brief(before), got: brief(got) });
  }
  // C9 — REPLACE (temp+rename, new inode) between reopens: identity miss → full scan, == fresh.
  {
    const f = scratchFile(bodyOf(20) + tagRec(PIN));
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f);
    const t = f + '.new'; fs.writeFileSync(t, bodyOf(5, 500)); fs.renameSync(t, f); // new inode, no pin
    const got = sm.readTitleMeta(f);
    check('C9: temp+rename replace (new inode) — full rescan, == fresh (no cross-file reuse)', before.pinned && got.tag === null && tagEq(got, freshMeta(f)), { before: brief(before), got: brief(got) });
  }
  // C10 — same-size in-place rewrite (ctime-only move): full rescan, == fresh.
  {
    const a = bodyOf(10) + tagRec(PIN) + userRec('zz', 'x');
    const f = scratchFile(a);
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f);
    const mt = fs.statSync(f).mtime;
    // Pad the trailing text by exactly len('pinned') so the clearing-tag file is the SAME byte length.
    const b = bodyOf(10) + tagRec('') + userRec('zz', 'x'.repeat(1 + PIN.length)); // SAME byte length, pin cleared
    if (b.length === a.length) {
      fs.writeFileSync(f, b);
      fs.utimesSync(f, mt, mt); // restore mtime; only ctime moves
      const got = sm.readTitleMeta(f);
      check('C10: same-size in-place rewrite (mtime restored) — full rescan via ctime, == fresh', before.pinned && !got.pinned && tagEq(got, freshMeta(f)), { before: brief(before), got: brief(got) });
    } else skipped('C10', 'fixture lengths differ');
  }

  // ===================================================================== N (non-compact / escaped tag — the r4 prefilter gap)
  // N0 — MUST-FAIL guard (synthetic r4, not HEAD-anchored): the r4 prefilter rejects
  // these tag records while a full JSON parse accepts them, so under r4 the DELTA
  // would read a different tag than the full scan. Assert the divergence is real
  // (the cases below are non-vacuous) AND that the FIXED module no longer has it.
  {
    const spaced = tagRecSpaced(PIN).trimEnd();
    const escaped = tagRecEscaped(PIN).trimEnd();
    const bothParseAsTag = JSON.parse(spaced).type === 'tag' && JSON.parse(escaped).type === 'tag';
    const r4WouldSkipBoth = !r4PrefilterAccepts(spaced) && !r4PrefilterAccepts(escaped);
    check('N0: r4 prefilter SKIPS a non-compact + an escaped tag record a full parse accepts (the gap the fix closes)',
      bothParseAsTag && r4WouldSkipBoth, { spacedAccepted: r4PrefilterAccepts(spaced), escapedAccepted: r4PrefilterAccepts(escaped), bothParseAsTag });
  }
  // N1 — a NON-COMPACT pin record appended in the DELTA region: the fold must pin,
  // == fresh full scan. (r4 would leave it unpinned.)
  {
    const f = scratchFile(bodyOf(30));
    sm.clearTitleMetaCache();
    sm.readTitleMeta(f); // warm: full scan + checkpoint
    fs.appendFileSync(f, bodyOf(3, 100) + tagRecSpaced(PIN)); // live append, non-compact pin last
    const got = sm.readTitleMeta(f); // delta
    check('N1: non-compact pin appended (delta region) — fold pins == fresh (r4 would miss it)',
      got.tag === PIN && got.pinned && tagEq(got, freshMeta(f)), brief(got));
  }
  // N2 — an ESCAPED-type pin record appended in the delta region: fold must pin, == fresh.
  {
    const f = scratchFile(bodyOf(30));
    sm.clearTitleMetaCache();
    sm.readTitleMeta(f);
    fs.appendFileSync(f, bodyOf(3, 200) + tagRecEscaped(PIN)); // escaped g type
    const got = sm.readTitleMeta(f);
    check('N2: escaped-type pin appended (delta region) — fold pins == fresh (r4 would miss it)',
      got.tag === PIN && got.pinned && tagEq(got, freshMeta(f)), brief(got));
  }
  // N3 — a non-compact CLEARING tag must also fold: pin then a spaced clearing record
  // in the delta → unpinned, == fresh (last record wins, both paths agree).
  {
    const f = scratchFile(bodyOf(10) + tagRec(PIN));
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f);
    fs.appendFileSync(f, bodyOf(2, 300) + tagRecSpaced('')); // non-compact clearing record last
    const got = sm.readTitleMeta(f);
    check('N3: non-compact clearing tag appended after a pin — fold clears == fresh',
      before.pinned && got.tag === null && !got.pinned && tagEq(got, freshMeta(f)), { before: brief(before), got: brief(got) });
  }

  // ===================================================================== M4 (accepted out-of-contract residual — documented, NOT a pass/fail)
  // Mirrors BUG-245's M4. The tag fold trusts a grown file whose HEAD [0,W) and
  // BOUNDARY [lastNlPos-W,lastNlPos) windows are unchanged. A SAME-LENGTH rewrite of
  // a tag record threaded strictly BETWEEN those two windows, keeping both byte-
  // identical, then an append, is undetected: the delta keeps the prior tag while a
  // fresh full scan sees the rewrite. This is the SAME out-of-contract residual the
  // orchestrator accepted for the count (r2 RESCOPE / clean-room 01a121a2): no real
  // transcript writer rewrites a transcript's interior in place at the same length —
  // the CLI/SDK/mirror only append or rewrite from the head (→ head window changes →
  // full rescan). Shown here so the tag fold's blind spot is on the record, not a
  // surprise. INFORMATIONAL — not graded.
  {
    const W = 4096;
    const pad = 'z'.repeat(W + 200); // ensure the pin sits >W from the start
    const trail = bodyOf(80, 5000);  // and >W from the last newline
    const pinLine = tagRec(PIN);      // `{"type":"tag","tag":"pinned",…}\n`
    const f = scratchFile(pad + '\n' + bodyOf(5) + pinLine + trail);
    sm.clearTitleMetaCache();
    const before = sm.readTitleMeta(f); // warm: full scan finds the interior pin; checkpoint built
    // Same-length clearing rewrite of the interior pin: clear the tag, pad sessionId
    // by exactly the removed byte count so the line keeps its original length.
    const pinBody = pinLine.trimEnd();
    const clearBase = JSON.stringify({ type: 'tag', tag: '', sessionId: 's' });
    const clearPadded = JSON.stringify({ type: 'tag', tag: '', sessionId: 's' + 'x'.repeat(Math.max(0, pinBody.length - clearBase.length)) }) + '\n';
    const buf = fs.readFileSync(f);
    const at = buf.indexOf(Buffer.from(pinLine));
    if (at > W && (buf.length - (at + pinLine.length)) > W && clearPadded.length === pinLine.length) {
      const rewritten = Buffer.concat([buf.subarray(0, at), Buffer.from(clearPadded), buf.subarray(at + pinLine.length)]);
      fs.writeFileSync(f, rewritten);
      fs.appendFileSync(f, bodyOf(2, 9999)); // grow, head+boundary windows preserved
      const delta = sm.readTitleMeta(f);
      const fresh = freshMeta(f);
      info('M4: interior SAME-LENGTH pin→clear rewrite between the head+boundary windows + append (accepted out-of-contract residual)',
        { beforePinned: before.pinned, deltaTag: delta.tag, freshTag: fresh.tag, divergent: delta.tag !== fresh.tag });
    } else {
      info('M4: interior-rewrite residual not demonstrable with this fixture (padding/offset)', { at, clearLen: clearPadded.length, pinLen: pinLine.length });
    }
  }

  // ===================================================================== D (delta engages)
  // Build a LARGE untagged file so a full scanTagBackward is measurably slow.
  const bigUntagged = (() => {
    const f = scratchFile(null);
    const fd = fs.openSync(f, 'w');
    const chunk = bodyOf(200);
    const target = 60 * (1 << 20); // ~60 MiB untagged
    let written = 0;
    while (written < target) { fs.writeSync(fd, chunk); written += chunk.length; }
    fs.closeSync(fd);
    return f;
  })();
  const bigSize = fs.statSync(bigUntagged).size;
  const timeIt = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  // A full scan (cache cleared) — the pre-fix behaviour on every changed reopen.
  const fullMs = () => { sm.clearTitleMetaCache(); return timeIt(() => sm.readTitleMeta(bigUntagged)); };
  sm.clearTitleMetaCache();
  sm.readTitleMeta(bigUntagged); // warm: full scan + checkpoint
  const coldFull = Math.min(fullMs(), fullMs()); // representative full-scan cost (min of 2)
  // Now: a live append + a WARM reopen (should delta — only the appended bytes).
  fs.appendFileSync(bigUntagged, bodyOf(2, 9000));
  sm.readTitleMeta(bigUntagged); // this reopen is warm from the pre-append checkpoint
  fs.appendFileSync(bigUntagged, bodyOf(2, 9100));
  const warmDelta = Math.min(
    timeIt(() => sm.readTitleMeta(bigUntagged)),
    (fs.appendFileSync(bigUntagged, bodyOf(2, 9200)), timeIt(() => sm.readTitleMeta(bigUntagged))),
  );
  // Correctness of the big-file deltas too.
  check('D0: large untagged file stays untagged through live appends == fresh', sm.readTitleMeta(bigUntagged).tag === null && freshMeta(bigUntagged).tag === null, { size: bigSize });
  check(`D1: a live reopen deltas (warm ${warmDelta.toFixed(1)}ms ≪ full ${coldFull.toFixed(1)}ms on ${(bigSize / (1 << 20)).toFixed(0)} MiB) — no whole-file rescan`,
    warmDelta < coldFull * 0.25 && coldFull > 20, { warmDelta: +warmDelta.toFixed(2), coldFull: +coldFull.toFixed(2), ratio: +(warmDelta / coldFull).toFixed(3) });

  // ===================================================================== REAL transcript
  const REAL = process.env.BUG245_REAL ?? (() => {
    const root = process.env.CLAUDE_PROJECTS_DIR ?? (process.env.HOME ? path.join(process.env.HOME, '.claude', 'projects') : null);
    if (!root || !fs.existsSync(root)) return null;
    let best = null, bestSize = 5 * (1 << 20);
    for (const proj of fs.readdirSync(root)) {
      let es; try { es = fs.readdirSync(path.join(root, proj)); } catch { continue; }
      for (const e of es) { if (!e.endsWith('.jsonl')) continue; const fp = path.join(root, proj, e); let sz; try { sz = fs.statSync(fp).size; } catch { continue; } if (sz > bestSize) { bestSize = sz; best = fp; } }
    }
    return best;
  })();
  if (REAL && fs.existsSync(REAL)) {
    const f = scratchFile(null);
    fs.copyFileSync(REAL, f);
    const sz = fs.statSync(f).size;
    sm.clearTitleMetaCache();
    const cold = timeIt(() => sm.readTitleMeta(f));
    const realTag = sm.readTitleMeta(f).tag;
    fs.appendFileSync(f, bodyOf(2, 70000)); // a live turn
    const live = timeIt(() => sm.readTitleMeta(f));
    const fresh = freshMeta(f);
    check(`R1: REAL ${(sz / (1 << 20)).toFixed(0)} MiB — live reopen (${live.toFixed(1)}ms) deltas vs cold (${cold.toFixed(1)}ms); tag == fresh`,
      sm.readTitleMeta(f).tag === fresh.tag && (cold < 10 || live < cold * 0.5), { cold: +cold.toFixed(1), live: +live.toFixed(1), tag: realTag });
    // CONVENTIONS partial reads: the REAL transcript truncated at several offsets, each == fresh.
    const g = scratchFile(null);
    const real = fs.readFileSync(REAL);
    const errs = [];
    for (const frac of [0.15, 0.4, 0.66, 0.9]) {
      fs.writeFileSync(g, real.subarray(0, Math.floor(sz * frac)));
      const got = sm.readTitleMeta(g);
      if (!tagEq(got, freshMeta(g))) errs.push({ frac, got: brief(got) });
    }
    fs.truncateSync(g, Math.floor(sz * 0.2)); // a shrink after the grow sequence
    if (!tagEq(sm.readTitleMeta(g), freshMeta(g))) errs.push({ shrink: true });
    check('R2: REAL transcript cut at 4 growing offsets + a shrink — tag == fresh each time', errs.length === 0, errs);

    // P — PROPERTY: random append sequences on a COPY of the REAL transcript, incl.
    // non-compact/escaped tag records, truncated/partial last lines and complete-then-
    // append, must keep the resumable fold's tag == a fresh full scan at every step.
    {
      const p = scratchFile(null);
      fs.copyFileSync(REAL, p);
      sm.clearTitleMetaCache();
      sm.readTitleMeta(p); // warm checkpoint from the real file
      // Deterministic PRNG so a failure reproduces (seed overridable).
      let s = (process.env.BUG248_SEED ? (Number(process.env.BUG248_SEED) >>> 0) : 0x248a5c0d) || 0x1234abcd;
      const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const mk = [
        () => bodyOf(1 + Math.floor(rnd() * 4), 800000 + Math.floor(rnd() * 1e6)), // ordinary turns
        () => pick([tagRec, tagRecSpaced, tagRecEscaped])(PIN),                      // pin (any shape)
        () => pick([tagRec, tagRecSpaced, tagRecEscaped])(''),                       // clearing tag (any shape)
      ];
      const errs2 = [];
      let partialPending = false;
      for (let i = 0; i < 80; i++) {
        const roll = rnd();
        if (partialPending) {
          // Complete the previously-written partial last line with its newline.
          fs.appendFileSync(p, '\n');
          partialPending = false;
        } else if (roll < 0.12) {
          // Write a COMPLETE-JSON tag line WITHOUT its newline (uncommitted): must not
          // take effect until the newline lands.
          fs.appendFileSync(p, pick([tagRec, tagRecSpaced, tagRecEscaped])(rnd() < 0.5 ? PIN : '').trimEnd());
          partialPending = true;
        } else if (roll < 0.20) {
          // Truncate back to a random earlier committed boundary (a /rewind), then
          // the next iterations regrow — forces a full rescan on shrink.
          const buf = fs.readFileSync(p);
          const cut = buf.lastIndexOf(0x0a, Math.floor(buf.length * (0.3 + rnd() * 0.5)));
          if (cut > 0) fs.truncateSync(p, cut + 1);
        } else {
          fs.appendFileSync(p, pick(mk)());
        }
        const got = sm.readTitleMeta(p);
        const fresh = freshMeta(p);
        if (!tagEq(got, fresh)) { errs2.push({ step: i, roll: +roll.toFixed(3), got: brief(got), fresh: brief(fresh) }); if (errs2.length > 4) break; }
      }
      check('P: 80 random append/tag/untag/partial/truncate steps on the REAL transcript — fold tag == fresh full scan every step',
        errs2.length === 0, errs2);
    }
  } else {
    skipped('R1-R2', 'no real transcript');
  }
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nBUG-248 tag fold: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
