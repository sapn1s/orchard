#!/usr/bin/env node
/**
 * BUG-245 r3 — the count as a RESUMABLE FOLD ("B on C"). Three properties, each
 * graded against a FRESH FULL SCAN of the same bytes (persistence off, cache
 * cleared — the cold answer the user would get after a restart):
 *
 *  P (F1) warm == cold across the byte CEILING. The r2 clean-room break: the delta
 *    re-applied `maxBytes` per scan, so an append crossing the ceiling counted bytes
 *    a cold scan never reads. Graded as a property over many split points x
 *    ceilings (below / at / mid-line / mid-UTF-8 / above) x all four option variants.
 *  T (F2) the tail labels exactly the prefix the count counted. The interleaving is
 *    injected BETWEEN the count and the tail (inside countThenTail's mkTail hook,
 *    which runs after the count and before the tail's open): append, partial line,
 *    line completion, in-place truncate (/rewind), temp+rename replace,
 *    truncate-and-regrow past the old size, ?beforeBytes paging, subagent filter.
 *  S (F3) a COLD process resumes from a validated sidecar — and rejects every
 *    stale/foreign/torn one (code-hash, inode, head rewrite, shrink, a sidecar file
 *    truncated at several offsets = a torn write), with no tmp litter and an LRU cap.
 *
 * MUST-FAIL (not HEAD-anchored): run with BUG245_TX_MODULE pointing at a pinned
 * copy of the r1/r2 module (no countThenTail / no persistence) — P and T redden:
 * the old route sequence (count, then an unclamped tail) mislabels, and the
 * per-scan ceiling diverges. Cases needing F3 report SKIP there.
 *
 * Real artifact: the user's largest transcript (discovered at runtime, or
 * BUG245_REAL) copied to scratch; truncated at several offsets (CONVENTIONS
 * "partial and truncated reads"). Constructed fixtures are SYNTHETIC and say so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempScratch } from '../scripts/lib/scratch.mjs';

const DEFAULT_TX = new URL('../src/server/transcript.ts', import.meta.url).href;
const TX_MODULE = process.env.BUG245_TX_MODULE ?? DEFAULT_TX;
const tx = await import(TX_MODULE);
const NEW = typeof tx.countThenTail === 'function' && typeof tx.enableCountPersistence === 'function';

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok || process.env.VERBOSE) console.log(`        observed: ${JSON.stringify(observed)}`);
};
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} — ${why}`); };

const SCRATCH = mkdtempScratch('verify-bug-245-r3-');
const SIDECARS = path.join(SCRATCH, 'transcript-index');

function discoverLargestTranscript() {
  if (process.env.BUG245_REAL) return process.env.BUG245_REAL;
  const root = process.env.CLAUDE_PROJECTS_DIR ?? (process.env.HOME ? path.join(process.env.HOME, '.claude', 'projects') : null);
  if (!root || !fs.existsSync(root)) return null;
  let best = null, bestSize = 5 * (1 << 20);
  for (const proj of fs.readdirSync(root)) {
    let entries; try { entries = fs.readdirSync(path.join(root, proj)); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const fp = path.join(root, proj, e);
      let sz; try { sz = fs.statSync(fp).size; } catch { continue; }
      if (sz > bestSize) { bestSize = sz; best = fp; }
    }
  }
  return best;
}
const REAL = discoverLargestTranscript();
const haveReal = REAL != null && fs.existsSync(REAL);

// --- fixtures (SYNTHETIC — shapes mirror real CLI records) ----------------
const userRec = (id, text) => JSON.stringify({ type: 'user', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
const asstRec = (id, text) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
const toolOnly = (id) => JSON.stringify({ type: 'user', uuid: id, sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }) + '\n';
const sideRec = (id) => JSON.stringify({ type: 'user', uuid: id, isSidechain: true, sessionId: 's', message: { role: 'user', content: 'side' } }) + '\n';
const hookRec = (id, parent, msg = 'Cannot find module foo') => JSON.stringify({ type: 'attachment', uuid: id, parentUuid: parent, attachment: { type: 'hook_non_blocking_error', hookName: 'gate', hookEvent: 'Stop', exitCode: 1, stderr: msg } }) + '\n';

let seq = 0;
const scratchFile = (contents) => { const f = path.join(SCRATCH, `s${seq++}.jsonl`); if (contents != null) fs.writeFileSync(f, contents); return f; };

/** Fresh FULL scan of the same bytes: a never-seen path, no memory, no sidecar. */
const freshFull = (f, opts = {}) => {
  if (NEW) tx.enableCountPersistence(null);
  const copy = path.join(SCRATCH, `fresh-${seq++}.jsonl`);
  fs.copyFileSync(f, copy);
  try { return tx.countMessages(copy, opts); } finally { fs.unlinkSync(copy); if (NEW && persistOn) tx.enableCountPersistence(SIDECARS); }
};
let persistOn = false;
const same = (a, b) => a.total === b.total && a.isLowerBound === b.isLowerBound &&
  a.hookErrors.totalRecords === b.hookErrors.totalRecords && a.hookErrors.crashRecords === b.hookErrors.crashRecords &&
  a.hookErrors.records.length === b.hookErrors.records.length && a.hookErrors.groups.length === b.hookErrors.groups.length;
const brief = (r) => ({ total: r.total, lb: r.isLowerBound, hooks: r.hookErrors.totalRecords, bytes: r.bytesScanned });

const VARIANTS = [{}, { includeToolResults: true }, { requireRenderable: false }, { includeToolResults: true, requireRenderable: false }];

// A realistic mixed body: messages, tool-only turns, sidechain noise, hook errors, multi-byte text.
function mixedBody(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += userRec('u' + i, `question ${i} — naïve café ✓ ${'x'.repeat(i % 37)}`);
    if (i % 3 === 0) s += toolOnly('t' + i);
    if (i % 5 === 0) s += sideRec('sd' + i);
    s += asstRec('a' + i, `answer ${i} 日本語 🌲 ${'y'.repeat(i % 53)}`);
    if (i % 7 === 0) s += hookRec('h' + i, 'a' + i, i % 2 ? 'Cannot find module x' : 'lint failed: 3 problems');
  }
  return s;
}

try {
  // ===================================================================== P (F1)
  {
    const full = Buffer.from(mixedBody(60) + userRec('tail', 'unterminated countable carry').trimEnd()); // ends WITHOUT a newline
    let checked = 0, bad = [];
    const nl = [];
    for (let i = 0; i < full.length; i++) if (full[i] === 0x0a) nl.push(i + 1);
    // split points: newline-aligned, mid-line, inside a multi-byte char
    const mb = full.indexOf(Buffer.from('é')) + 1;
    const splits = [nl[3], nl[Math.floor(nl.length / 2)], nl[nl.length - 2], nl[10] + 7, mb, full.length - 5];
    for (const split of splits) {
      // ceilings: below the split, inside the appended region (mid-line), exactly at EOF, above EOF, mid-UTF-8
      const ceilings = [Math.floor(split / 2), split + Math.floor((full.length - split) / 2) + 3, full.length, full.length + 100, mb + 1];
      for (const maxBytes of ceilings) {
        for (const v of VARIANTS) {
          const opts = { ...v, maxBytes };
          const f = scratchFile(full.subarray(0, split));
          tx.countMessages(f, opts); // warm the fold at `split`
          fs.appendFileSync(f, full.subarray(split)); // pure append, in-contract
          const warm = tx.countMessages(f, opts);
          const cold = freshFull(f, opts);
          checked++;
          if (!same(warm, cold)) bad.push({ split, maxBytes, v, warm: brief(warm), cold: brief(cold) });
        }
      }
    }
    check(`P1: warm == cold for a pure append across ${checked} split x ceiling x variant cases (SYNTHETIC mixed body)`, bad.length === 0, { mismatches: bad.length, first: bad.slice(0, 3) });

    // The exact clean-room shape (01a121b4): one record, ceiling, an append crossing it.
    const f = scratchFile(userRec('c1', 'one'));
    const MB = fs.statSync(f).size + 10;
    tx.countMessages(f, { maxBytes: MB });
    fs.appendFileSync(f, userRec('c2', 'two') + hookRec('ch', 'c2'));
    const warm = tx.countMessages(f, { maxBytes: MB });
    const cold = freshFull(f, { maxBytes: MB });
    check('P2: clean-room repro — append crossing the ceiling: warm total/isLowerBound/hooks == cold', same(warm, cold), { warm: brief(warm), cold: brief(cold) });
    // A lower-bound fold keeps a checkpoint: a further grow re-reads only the cut line, not the ceiling's worth.
    fs.appendFileSync(f, userRec('c3', 'three'));
    const warm2 = tx.countMessages(f, { maxBytes: MB });
    check('P3: past the ceiling, a grow does not re-scan from byte 0 (and stays == cold)',
      !NEW || (warm2.bytesScanned < MB && same(warm2, freshFull(f, { maxBytes: MB }))), { warm2: brief(warm2), MB });
    // Shrink below a lower-bound checkpoint → full rescan, exact.
    fs.truncateSync(f, Math.floor(MB / 2));
    const shr = tx.countMessages(f, { maxBytes: MB });
    check('P4: shrink after a lower-bound fold == cold', same(shr, freshFull(f, { maxBytes: MB })), brief(shr));
    // Different ceilings on one path never share a fold (critique #4).
    const g = scratchFile(mixedBody(10));
    const big = tx.countMessages(g, {});
    const small = tx.countMessages(g, { maxBytes: 200 });
    check('P5: a different maxBytes on the same path is its own fold (no cross-ceiling reuse)',
      small.isLowerBound === true && big.isLowerBound === false && same(small, freshFull(g, { maxBytes: 200 })), { big: brief(big), small: brief(small) });
  }

  // ===================================================================== T (F2)
  {
    /**
     * Serve a tail page the way the route does. NEW: countThenTail with an
     * injected mutation between the count and the tail. OLD module: the
     * pre-r3 route sequence — count, mutate, unclamped tail.
     */
    const serve = (f, { limit, mutate, beforeBytes, sub, maxBytes } = {}) => {
      const countOpts = { ...(sub ? { entryFilter: tx.subagentEntryFilter, cacheKeySuffix: 'sub' } : {}), ...(maxBytes != null ? { maxBytes } : {}) };
      const tailBase = sub ? { entryFilter: tx.subagentEntryFilter } : {};
      let mutated = false;
      const mk = (c) => {
        if (mutate && !mutated) { mutated = true; mutate(); }
        return { extra: c.total, tail: beforeBytes != null ? { ...tailBase, limit, startByte: beforeBytes } : { ...tailBase, limit, skip: 0 } };
      };
      let counted, r, before;
      if (NEW) ({ counted, tail: r, extra: before } = tx.countThenTail(f, countOpts, mk));
      else { counted = tx.countMessages(f, countOpts); ({ extra: before } = mk(counted)); r = tx.tailMessages(f, beforeBytes != null ? { ...tailBase, limit, startByte: beforeBytes } : { ...tailBase, limit }); }
      // Label exactly as the HTTP route does: labelBackwardPage (new) or base+i (old).
      let base;
      if (typeof tx.labelBackwardPage === 'function') base = tx.labelBackwardPage(r.messages, before, counted.isLowerBound);
      else { base = Math.max(0, before - r.messages.length); r.messages.forEach((m, i) => { m.index = base + i; }); }
      return { total: counted.total, isLowerBound: counted.isLowerBound,
        page: r.messages.map((m) => ({ i: m.index, uuid: m.uuid ?? m.id })), cursor: r.blockStartByte };
    };
    /** Ground truth: the canonical uuid at each index of the file AS COUNTED (fresh full read). */
    const truthIndex = (f, sub) => {
      const all = tx.tailMessages(f, { limit: 2000, ...(sub ? { entryFilter: tx.subagentEntryFilter } : {}) }).messages;
      return new Map(all.map((m, i) => [m.uuid ?? m.id, i]));
    };
    const labelsTrue = (served, truth) => served.page.every((p) => truth.get(p.uuid) === p.i);
    const body = Array.from({ length: 6 }, (_, i) => userRec('m' + i, 'msg ' + i)).join('');

    // T1 append between count and tail.
    {
      const f = scratchFile(body);
      const s = serve(f, { limit: 3, mutate: () => fs.appendFileSync(f, userRec('m6', 'msg 6')) });
      const truth = truthIndex(f);
      check('T1: append between count and tail — every page label is the true index; newest page == counted prefix',
        labelsTrue(s, truth) && s.page.at(-1).uuid === 'm5', s);
    }
    // T2 partial line appended between them, T3 a trailing complete-no-newline line completed between them.
    {
      const f = scratchFile(body);
      const s = serve(f, { limit: 3, mutate: () => fs.appendFileSync(f, userRec('m6', 'msg 6').slice(0, 30)) });
      check('T2: partial line appended between count and tail — labels true, partial never shown', labelsTrue(s, truthIndex(f)) && !s.page.some((p) => p.uuid === 'm6'), s);
      const g = scratchFile(body + userRec('m6', 'msg 6').trimEnd());
      const s2 = serve(g, { limit: 3, mutate: () => fs.appendFileSync(g, '\n' + userRec('m7', 'msg 7')) });
      check('T3: trailing complete-JSON line (no newline) completed + appended between them — labels true, counted once',
        labelsTrue(s2, truthIndex(g)) && s2.total === 7 && s2.page.at(-1).uuid === 'm6', s2);
    }
    // T4 in-place truncate (/rewind) between them — critique #1 reproduced case.
    {
      const f = scratchFile(body);
      const s = serve(f, { limit: 2, mutate: () => { const b = fs.readFileSync(f); fs.truncateSync(f, b.indexOf('\n', b.indexOf('m1')) + 1); } });
      check('T4: in-place truncate between count and tail — re-counted, labels true (was m0/m1 @ 4/5)', labelsTrue(s, truthIndex(f)) && s.total === 2, s);
    }
    // T5 temp+rename replace between them.
    {
      const f = scratchFile(body);
      const s = serve(f, { limit: 2, mutate: () => { const t = f + '.new'; fs.writeFileSync(t, userRec('r0', 'other') + userRec('r1', 'file')); fs.renameSync(t, f); } });
      check('T5: temp+rename replace between count and tail — re-counted, labels true', labelsTrue(s, truthIndex(f)) && s.total === 2, s);
    }
    // T6 truncate-and-REGROW past the old size (same inode, size not shorter) — boundary hash catches it.
    {
      const f = scratchFile(body);
      const s = serve(f, { limit: 2, mutate: () => { fs.truncateSync(f, 0); fs.appendFileSync(f, Array.from({ length: 9 }, (_, i) => userRec('g' + i, 'regrown ' + i + ' zz')).join('')); } });
      check('T6: truncate then regrow past the old size between them — re-counted, labels true', labelsTrue(s, truthIndex(f)) && s.total === 9, s);
    }
    // T7 ?beforeBytes paging with an append in between: the older page's labels stay true.
    {
      const f = scratchFile(body);
      const first = serve(f, { limit: 3 });
      const s = serve(f, { limit: 3, beforeBytes: first.cursor, mutate: () => fs.appendFileSync(f, userRec('m6', 'msg 6')) });
      // beforeBytes pages label [K-len, K) from the caller's K; here K = first page offset
      const K = first.page[0].i;
      const truth = truthIndex(f);
      const ok = s.page.every((p, j) => truth.get(p.uuid) === K - s.page.length + j);
      check('T7: ?beforeBytes page with an append in between — older page lands on the true indices', ok, { first, s, K });
    }
    // T8 subagent tail (entryFilter + cacheKeySuffix) with an append in between.
    {
      const f = scratchFile(body.replaceAll('"type":"user"', '"type":"user","isSidechain":true'));
      const s = serve(f, { limit: 3, sub: true, mutate: () => fs.appendFileSync(f, userRec('m6', 'msg 6').replace('"type":"user"', '"type":"user","isSidechain":true')) });
      check('T8: subagent tail — append between count and tail, labels true', labelsTrue(s, truthIndex(f, true)), s);
    }
    // T9 REAL transcript: append between count and tail; newest page labels true.
    if (haveReal) {
      const f = scratchFile(null);
      fs.copyFileSync(REAL, f);
      tx.clearTranscriptCaches();
      const s = serve(f, { limit: 100, mutate: () => fs.appendFileSync(f, userRec('rx1', 'live turn') + asstRec('rx2', 'live reply')) });
      const fresh = freshFull(f, {});
      const lastIdx = s.page.at(-1).i;
      check('T9: REAL transcript + live append mid-open — newest page ends at counted total-1, appended msgs not mislabelled into it',
        lastIdx === s.total - 1 && fresh.total === s.total + 2 && !s.page.some((p) => p.uuid === 'rx1' || p.uuid === 'rx2'), { total: s.total, lastIdx, freshTotal: fresh.total });
    } else skipped('T9', 'no real transcript');
  }

  // ===================================================================== G (r4 — the two F2 gaps)
  {
    // Rebuild the server locally (T's `serve` is block-scoped) with the same
    // route-faithful labelling, so G can exercise it too.
    const serveG = (f, args) => {
      const limit = args.limit, mutate = args.mutate, maxBytes = args.maxBytes, sub = args.sub;
      const countOpts = { ...(sub ? { entryFilter: tx.subagentEntryFilter, cacheKeySuffix: 'sub' } : {}), ...(maxBytes != null ? { maxBytes } : {}) };
      const tailBase = sub ? { entryFilter: tx.subagentEntryFilter } : {};
      let mutated = false;
      const mk = (c) => { if (mutate && !mutated) { mutated = true; mutate(); } return { extra: c.total, tail: { ...tailBase, limit, skip: 0 } }; };
      let counted, r, before;
      if (NEW) ({ counted, tail: r, extra: before } = tx.countThenTail(f, countOpts, mk));
      else { counted = tx.countMessages(f, countOpts); ({ extra: before } = mk(counted)); r = tx.tailMessages(f, { ...tailBase, limit }); }
      let base;
      if (typeof tx.labelBackwardPage === 'function') base = tx.labelBackwardPage(r.messages, before, counted.isLowerBound);
      else { base = Math.max(0, before - r.messages.length); r.messages.forEach((m, i) => { m.index = base + i; }); }
      return { total: counted.total, isLowerBound: counted.isLowerBound, page: r.messages.map((m) => ({ i: m.index, uuid: m.uuid ?? m.id })) };
    };
    const truthIndexG = (f) => {
      const all = tx.tailMessages(f, { limit: 2000 }).messages;
      return new Map(all.map((m, i) => [m.uuid ?? m.id, i]));
    };

    // ---- GAP 1 (clean-room 8a282a45b7c7) --------------------------------------
    // The count counts a trailing complete-JSON line with NO newline (the carry).
    // Between count and tail, truncate EXACTLY to the last newline (dropping the
    // carry) then regrow past the old size with DIFFERENT content. A re-check
    // window ending at the last newline misses it (the changed bytes are all after
    // the newline); a window ending at fileBytes catches it → re-count → true.
    // MUST-FAIL on the pre-fix module (boundary window at lastNlPos): no mismatch,
    // the tail is clamped to a prefix whose tail bytes have been overwritten, so
    // base = total - len mislabels. SYNTHETIC fixture (shape mirrors real records).
    {
      const bodyNl = Array.from({ length: 6 }, (_, i) => userRec('m' + i, 'msg ' + i)).join('');
      const lastNlPos = bodyNl.length;
      const f = scratchFile(bodyNl + userRec('m6', 'carry no newline').trimEnd()); // trailing carry, no \n
      const s = serveG(f, { limit: 3, mutate: () => {
        fs.truncateSync(f, lastNlPos); // drop the carry, back to the last newline
        fs.appendFileSync(f, Array.from({ length: 5 }, (_, i) => userRec('x' + i, 'regrown DIFFERENT content ' + i + ' qqqq')).join(''));
      } });
      const truth = truthIndexG(f); // ground truth = the file as it is NOW (post-mutation)
      check('G1: counted no-newline carry + truncate-to-last-newline then regrow between count and tail — re-counted, every label true',
        s.page.every((p) => truth.get(p.uuid) === p.i) && s.total === truth.size && s.page.at(-1).uuid === 'x4', { total: s.total, page: s.page });
    }

    // ---- GAP 2 (clean-room 26694d246f54) --------------------------------------
    // A LOWER-BOUND count (file past the ceiling) must NOT label the newest
    // messages from a ceiling-cut total. Decision: SHOW them, but UNNUMBERED —
    // each index non-integer — so a FEAT-118 bookmark degrades visibly instead of
    // colliding with an early message's real index.
    // MUST-FAIL on the pre-fix module (no labelBackwardPage): base = total - len
    // hands them integer indices the count never reached. SYNTHETIC fixture.
    {
      const body12 = Array.from({ length: 12 }, (_, i) => userRec('b' + i, 'body ' + i + ' ' + 'z'.repeat(24))).join('');
      const f = scratchFile(body12);
      const buf = fs.readFileSync(f);
      const ceiling = buf.indexOf(0x0a, buf.indexOf(Buffer.from('"uuid":"b3"'))) + 1; // past the first 4 records
      const s = serveG(f, { limit: 3, maxBytes: ceiling });
      check('G2: lower-bound tail (file past the ceiling) — newest 3 messages SHOWN but UNNUMBERED (no fabricated colliding index)',
        s.isLowerBound === true && s.page.length === 3 && s.page.every((p) => !Number.isInteger(p.i)), { lb: s.isLowerBound, idx: s.page.map((p) => p.i) });
    }
    // G3: the SAME lower-bound file read FORWARD (offset paging) keeps exact
    // indices for messages inside the ceiling — only the from-EOF tail is unknown.
    {
      const body12 = Array.from({ length: 12 }, (_, i) => userRec('b' + i, 'body ' + i)).join('');
      const f = scratchFile(body12);
      const buf = fs.readFileSync(f);
      const ceiling = buf.indexOf(0x0a, buf.indexOf(Buffer.from('"uuid":"b3"'))) + 1;
      const fwd = tx.readForward(f, { offset: 0, limit: 10, maxBytes: ceiling });
      check('G3: forward paging of a lower-bound file still numbers messages within the ceiling exactly',
        fwd.messages.length > 0 && fwd.messages.every((m, i) => m.index === i), { n: fwd.messages.length, idx: fwd.messages.map((m) => m.index) });
    }
  }

  // ===================================================================== S (F3)
  if (!NEW) {
    skipped('S*', 'module has no persistence (pre-r3)');
  } else {
    persistOn = true;
    tx.enableCountPersistence(SIDECARS);
    // A module whose code hash cannot be computed keeps persistence OFF (never a guessed version).
    check('S0: persistence is live (code hash computed, index dir created)', fs.existsSync(SIDECARS), { dir: SIDECARS });
    if (!fs.existsSync(SIDECARS)) throw new Error('persistence did not enable — S cases cannot run');
    const COLD_CHILD = `
      const tx = await import(${JSON.stringify(TX_MODULE)});
      tx.enableCountPersistence(process.argv[1]);
      const r = tx.countMessages(process.argv[2], JSON.parse(process.argv[3]));
      process.stdout.write(JSON.stringify({ total: r.total, isLowerBound: r.isLowerBound, bytesScanned: r.bytesScanned, hookErrors: r.hookErrors }));`;
    /** Count in a brand-new PROCESS (a real cold server: empty memory, sidecar only). */
    const coldProcess = (f, opts = {}) => {
      const out = spawnSync(process.execPath, ['--input-type=module', '-e', COLD_CHILD, SIDECARS, f, JSON.stringify(opts)], { encoding: 'utf8' });
      if (out.status !== 0) throw new Error(out.stderr);
      return JSON.parse(out.stdout);
    };

    // S1 real transcript: index once, restart, append → the cold process folds only the appended bytes.
    if (haveReal) {
      const f = scratchFile(null);
      fs.copyFileSync(REAL, f);
      const size = fs.statSync(f).size;
      const first = coldProcess(f);
      fs.appendFileSync(f, userRec('sx1', 'after restart') + hookRec('sxh', 'sx1'));
      const t0 = process.hrtime.bigint();
      const cold = coldProcess(f);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const ref = freshFull(f, {});
      check('S1: REAL transcript, new process after an append — resumes from the sidecar (bytes ≪ file) and == fresh',
        cold.bytesScanned < size / 50 && same(cold, ref) && first.bytesScanned >= size, { first: first.bytesScanned, cold: cold.bytesScanned, size, coldTotal: cold.total, ref: ref.total, childMs: ms.toFixed(0) });
      const again = coldProcess(f);
      check('S2: unchanged file in a new process — reads only the trailing line, == fresh', again.bytesScanned < 64 * 1024 && same(again, ref), { bytes: again.bytesScanned });
      // CONVENTIONS partial reads: the real transcript truncated at several offsets, a fresh
      // process at each step (grow sequence resumes, the final shrink must full-scan).
      const offsets = [0.2, 0.45, 0.7, 0.93].map((x) => Math.floor(size * x));
      const g = scratchFile(null);
      const real = fs.readFileSync(REAL);
      const errs = [];
      for (const off of offsets) {
        fs.writeFileSync(g, real.subarray(0, off)); // NOTE rewrite → same inode, grows each step
        const r = coldProcess(g);
        if (!same(r, freshFull(g, {}))) errs.push({ off, r: r.total });
      }
      fs.truncateSync(g, offsets[1]);
      const sh = coldProcess(g);
      if (!same(sh, freshFull(g, {}))) errs.push({ shrink: true, r: sh.total });
      check('S3: REAL transcript cut at 4 growing offsets + a shrink, new process each — every count == fresh', errs.length === 0, errs);
    } else skipped('S1-S3', 'no real transcript');

    const base = mixedBody(40);
    // S4 code-hash mismatch → full scan. S5 inode replace → full scan. S6 head rewrite (compaction) + grow → full scan.
    {
      const f = scratchFile(base);
      coldProcess(f);
      for (const n of fs.readdirSync(SIDECARS)) {
        const p = path.join(SIDECARS, n); const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j.key.startsWith(f + '\0')) { j.codeHash = 'stale-code'; fs.writeFileSync(p, JSON.stringify(j)); }
      }
      fs.appendFileSync(f, userRec('z', 'z'));
      const r = coldProcess(f);
      check('S4: sidecar from different counting code is rejected → full scan, == fresh', r.bytesScanned === fs.statSync(f).size && same(r, freshFull(f)), brief(r));
    }
    {
      const f = scratchFile(base);
      coldProcess(f);
      const t = f + '.tmp-replace'; fs.writeFileSync(t, base + userRec('n', 'n')); fs.renameSync(t, f);
      const r = coldProcess(f);
      check('S5: temp+rename replace (new inode) → full scan, == fresh', r.bytesScanned === fs.statSync(f).size && same(r, freshFull(f)), brief(r));
    }
    {
      const f = scratchFile(base);
      coldProcess(f);
      const b = fs.readFileSync(f); const sum = userRec('cmp', 'compaction summary').padEnd(200, ' ');
      fs.writeFileSync(f, Buffer.concat([Buffer.from(sum.trimEnd() + '\n'), b.subarray(b.indexOf('\n') + 1), Buffer.from(userRec('post', 'after compaction'))]));
      const r = coldProcess(f);
      check('S6: compaction (head rewrite) + grow → full scan, == fresh', r.bytesScanned === fs.statSync(f).size && same(r, freshFull(f)), brief(r));
    }
    // S7 torn sidecar (a crash mid-write that bypassed the rename, or disk corruption): truncated at several offsets.
    {
      const f = scratchFile(base);
      coldProcess(f);
      const p = fs.readdirSync(SIDECARS).map((n) => path.join(SIDECARS, n)).find((q) => q.endsWith('.json') && JSON.parse(fs.readFileSync(q, 'utf8')).key.startsWith(f + '\0'));
      const good = fs.readFileSync(p);
      fs.appendFileSync(f, userRec('tw', 'tw'));
      const errs = [];
      for (const cut of [1, 17, Math.floor(good.length / 3), Math.floor(good.length * 0.9), good.length - 1]) {
        fs.writeFileSync(p, good.subarray(0, cut));
        const r = coldProcess(f);
        if (!same(r, freshFull(f)) || r.bytesScanned !== fs.statSync(f).size) errs.push({ cut, r: brief(r) });
      }
      check('S7: sidecar truncated at 5 offsets (torn write) → full scan each time, == fresh', errs.length === 0, errs);
    }
    // S8 hook roll-up survives the sidecar round trip (groups + records + caps), over a delta.
    {
      const many = Array.from({ length: 520 }, (_, i) => hookRec('hh' + i, 'p' + i, i % 2 ? 'Cannot find module q' : 'reported ' + (i % 4))).join('');
      const f = scratchFile(base + many);
      coldProcess(f);
      fs.appendFileSync(f, hookRec('hz', 'pz', 'ENOENT x') + userRec('after', 'after'));
      const r = coldProcess(f);
      const ref = freshFull(f);
      check('S8: 520+ hook records (cap) folded through a cold sidecar delta == fresh (records capped, groups, kinds)',
        same(r, ref) && r.hookErrors.recordsCapped === ref.hookErrors.recordsCapped && JSON.stringify(r.hookErrors.groups) === JSON.stringify(ref.hookErrors.groups) && r.bytesScanned < 2000,
        { r: brief(r), capped: r.hookErrors.recordsCapped });
    }
    // S9 no tmp litter; LRU cap; stale tmp swept; persistence OFF by default writes nothing.
    {
      const litter = fs.readdirSync(SIDECARS).filter((n) => n.endsWith('.tmp'));
      check('S9: no tmp files left after many atomic writes', litter.length === 0, litter);
      for (let i = 0; i < 530; i++) fs.writeFileSync(path.join(SIDECARS, `filler-${i}.json`), '{}');
      const stale = path.join(SIDECARS, 'x.json.1.dead.tmp'); fs.writeFileSync(stale, 'x');
      const old = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(stale, old, old);
      tx.enableCountPersistence(SIDECARS); // sweeps
      const after = fs.readdirSync(SIDECARS);
      check('S10: directory LRU-capped at 512 and a stale tmp swept', after.filter((n) => n.endsWith('.json')).length <= 512 && !after.includes('x.json.1.dead.tmp'), { n: after.length });
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const tx = await import(${JSON.stringify(TX_MODULE)}); tx.countMessages(process.argv[1]);`, scratchFile(base)],
      { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(SCRATCH, 'should-stay-empty') } });
      check('S11: importing + counting without enableCountPersistence writes nothing to the data dir', child.status === 0 && !fs.existsSync(path.join(SCRATCH, 'should-stay-empty')), child.stderr);
    }
    // S12 in-memory LRU: 300 sessions → the most recent ones stay warm (no clear-all at 257).
    {
      tx.enableCountPersistence(null);
      const files = Array.from({ length: 300 }, (_, i) => scratchFile(userRec('l' + i, 'x')));
      for (const f of files) tx.countMessages(f);
      const recent = tx.countMessages(files[299]);
      const mid = tx.countMessages(files[200]);
      check('S12: in-memory cache is LRU — recent sessions stay warm past 256 entries', recent.cached && mid.cached, { recent: recent.cached, mid: mid.cached });
      tx.enableCountPersistence(SIDECARS);
    }
  }
} finally {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nBUG-245 r3 fold: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}${NEW ? '' : ' (PRE-r3 module — must-FAIL run)'}`);
process.exit(fail ? 1 : 0);
