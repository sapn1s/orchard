#!/usr/bin/env node
/**
 * verify:feat-199 (r6 exact-count) — the structural fix for run d37b0ba5
 * (BROKEN).
 *
 * r5 made the twin completeness check fall back to FILE SIZE whenever either
 * copy's messageCount was a sampled lower bound (a file past the 512 KB
 * head+tail budget). Size is a PROXY for completeness, and the proxy broke: an
 * 822 KB metadata-only twin (0 real messages, all `summary`/meta lines, sitting
 * in the canonical host dir) is BIGGER than an 80-message real transcript, so
 * size picked the metadata stub and hid the real session from the full list,
 * the page AND the deep link.
 *
 * r6 removes the proxy: on a same-id twin collision we compute the EXACT real
 * (`user`/`assistant`, non-meta, non-sidechain) message count of each copy by a
 * FULL streaming parse — no sampling, no size cap — and pick the max by a
 * TOTAL-ORDER sort key: (1) more exact real messages, (2) canonical-cwd copy,
 * (3) newest mtime, (4) stable path. The exact count is memoised by
 * (path, mtime, size) and computed ONLY on a collision.
 *
 * PART A — pure logic over the REAL `canonicalSessionIndex`:
 *   - MUST-FAIL from the r5 code (re-implemented faithfully as `r5PreferCur`):
 *     the 822 KB metadata-only twin beats the 80-msg real transcript on size.
 *     r6 keeps the real transcript.
 *   - a sampled-size real transcript vs a truncated prefix (run 459a68fa) — r6
 *     exact count keeps the real transcript.
 *   - equal counts, different cwd → canonical wins.
 *   - equal counts, equal canon → newest mtime, then stable path.
 *   - 3+ copies mixing every kind → one transitive winner (the real one).
 *   - a twin that GROWS between two index builds → cache key changes, the new
 *     exact count is used (no stale cache).
 *   - a symlinked twin resolves to one winner (no crash, no double-count).
 * PART B — REAL SERVER: the 822 KB metadata twin and a 3-way mix across
 *   host/past/container dirs; full list, keyset page union and ?session= deep
 *   link agree on every id and serve the REAL transcript.
 *
 * (Real-store union/first-page timing, the client generation guard, the finder
 * corpus and the load-more race are covered by verify-feat-199-pagination.mjs
 * and verify-feat-199-r3-client.mjs, run alongside this suite.)
 *
 * No port 4317, no live host, no writes outside the scratch dirs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
let failures = 0;
const ok = (n, x = '') => console.log(`  ok  ${n}${x ? `  — ${x}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => JSON.stringify(o);

// A real transcript with `turns` user+assistant pairs (2*turns real messages).
function writeReal(dir, stem, { sessionId, cwd, ts, turns = 40, mtime }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  for (let i = 0; i < turns; i++) {
    rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `msg ${i}` } }));
    rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: `reply ${i}` } }));
  }
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  if (mtime) fs.utimesSync(fp, mtime, mtime);
  return fp;
}
// A BIG metadata-only twin: >512 KB so readSessionMeta SAMPLES it (its count is
// a lower bound), carries sessionId+cwd so it looks canonical, but EVERY line is
// a `summary`/meta entry — ZERO real messages. This is the run d37b0ba5 break.
function writeBigMetaOnly(dir, stem, { sessionId, cwd, ts, sizeKB = 822 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [line({ type: 'summary', summary: 'archived', sessionId, cwd, timestamp: ts, version: '1.0.0' })];
  // Pad with meta/sidechain entries (NOT real messages) until over sizeKB.
  const pad = 'y'.repeat(900);
  let bytes = rows[0].length;
  let i = 0;
  while (bytes < sizeKB * 1024) {
    const r = line({ type: 'user', isMeta: true, sessionId, cwd, timestamp: ts, message: { role: 'user', content: `meta ${i} ${pad}` } });
    rows.push(r);
    bytes += r.length + 1;
    i++;
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
// A LARGE real transcript whose byte size exceeds the 512 KB sample budget, so
// readSessionMeta's messageCount is a SAMPLED LOWER BOUND.
function writeLargeReal(dir, stem, { sessionId, cwd, ts, turns = 120, bodyKB = 48 }) {
  fs.mkdirSync(dir, { recursive: true });
  const body = 'x'.repeat(bodyKB * 1024);
  const rows = [];
  for (let i = 0; i < turns; i++) {
    rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: 'user', content: `msg ${i} ${body}` } }));
    rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: `reply ${i} ${body}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
// A truncated PREFIX just over the budget: ~29 lines, FEWER bytes than the whole.
function writeLargeTruncated(dir, stem, { sessionId, cwd, ts, lines = 29, bodyKB = 18 }) {
  fs.mkdirSync(dir, { recursive: true });
  const body = 'x'.repeat(bodyKB * 1024);
  const rows = [];
  for (let i = 0; i < lines; i++) {
    rows.push(line({ type: i % 2 === 0 ? 'user' : 'assistant', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `frag ${i} ${body}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
function writeTruncated(dir, stem, { sessionId, cwd, ts, mtime }) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: 'user', content: 'only line' } }) + '\n');
  if (mtime) fs.utimesSync(fp, mtime, mtime);
}
function writeEmpty(dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), '');
}

const withStore = (STORE, fn) => {
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  hist.clearSessionCache?.();
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
    hist.clearSessionCache?.();
  }
};

/* Re-implements the r5 completeness rule EXACTLY, so PART A can show the break
 * it produced on the d37b0ba5 fixture. Count comparable only when BOTH exact;
 * else file SIZE; then canonical-cwd; then larger file. */
function r5Winner(STORE, encodedDirs, id) {
  return withStore(STORE, () => {
    const stats = (fp, dir) => {
      const m = hist.readSessionMeta(fp, dir, {});
      return { count: m ? m.messageCount : -1, exact: m ? m.statsExact : true };
    };
    const copies = [];
    for (const d of encodedDirs) {
      for (const stub of hist.listSessionStubs(d)) {
        const f = hist.readSessionHeadFacts(stub.filePath);
        if ((f.sessionId ?? stub.sessionId) === id) copies.push({ ...stub, cwd: f.cwd });
      }
    }
    const canon = (c) => c.cwd !== null && hist.encodeCwd(c.cwd) === c.encodedDir;
    const preferCur = (cur, prev) => {
      const c = stats(cur.filePath, cur.encodedDir);
      const p = stats(prev.filePath, prev.encodedDir);
      if (c.exact && p.exact) { if (c.count !== p.count) return c.count > p.count; }
      else if (cur.fileBytes !== prev.fileBytes) return cur.fileBytes > prev.fileBytes;
      if (canon(cur) !== canon(prev)) return canon(cur);
      return cur.fileBytes > prev.fileBytes;
    };
    let win = copies[0];
    for (let i = 1; i < copies.length; i++) if (preferCur(copies[i], win)) win = copies[i];
    return win;
  });
}

function partA() {
  console.log('\n--- PART A: exact real-message count beats every size/sampling proxy ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r6a-'));

  // ---- Case 1: 822 KB metadata-only twin vs 80-msg real transcript (d37b0ba5)
  {
    const STORE = path.join(tmp, 'c1');
    const curPath = '/tmp/r6c1/current/proj';         // canonical host dir
    const pastPath = '/tmp/r6c1/old/legacy-archive';  // non-canonical past dir
    const hostEnc = hist.encodeCwd(curPath);
    const pastEnc = hist.encodeCwd(pastPath);
    const hostDir = path.join(STORE, hostEnc);
    const pastDir = path.join(STORE, pastEnc);
    const idX = 'd37b0ba5-0000-4000-8000-000000000000';
    writeBigMetaOnly(hostDir, idX, { sessionId: idX, cwd: curPath, ts: '2026-10-20T00:00:00.000Z', sizeKB: 822 });
    writeReal(pastDir, idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-20T00:00:00.000Z', turns: 40 }); // 80 msgs

    const metaBytes = fs.statSync(path.join(hostDir, `${idX}.jsonl`)).size;
    const realBytes = fs.statSync(path.join(pastDir, `${idX}.jsonl`)).size;
    ok('fixture: metadata twin is BIGGER than the real transcript', `meta=${(metaBytes/1024|0)}KB > real=${(realBytes/1024|0)}KB`);

    // MUST-FAIL: the r5 size-fallback picks the big metadata stub.
    const r5 = r5Winner(STORE, [hostEnc, pastEnc], idX);
    if (r5 && r5.encodedDir === hostEnc) ok('MUST-FAIL: r5 size-fallback picks the 822 KB metadata-only stub (0 real msgs)', 'dir=host');
    else bad('MUST-FAIL expected r5 to pick the host metadata stub', `r5=${JSON.stringify(r5 && { d: r5.encodedDir })}`);

    // FIX: r6 exact count keeps the real transcript.
    const win = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, pastEnc]).get(idX));
    if (win && win.encodedDir === pastEnc && win.messages === 80) ok('FIX: r6 keeps the REAL 80-msg transcript (exact count 80 > 0)', `dir=past msgs=${win.messages}`);
    else bad('FIX expected r6 → past dir, 80 msgs', `win=${JSON.stringify(win && { d: win.encodedDir, m: win.messages })}`);
  }

  // ---- Case 2: sampled-size real transcript vs truncated prefix (459a68fa)
  {
    const STORE = path.join(tmp, 'c2');
    const curPath = '/tmp/r6c2/current/proj';
    const pastPath = '/tmp/r6c2/old/legacy-archive';
    const hostEnc = hist.encodeCwd(curPath);
    const pastEnc = hist.encodeCwd(pastPath);
    const idX = 'aaaa0002-0000-4000-8000-000000000000';
    // Truncated prefix in the canonical host dir (small bytes, 29 real msgs);
    // the huge real transcript (240 msgs) stranded in the past dir.
    writeLargeTruncated(path.join(STORE, hostEnc), idX, { sessionId: idX, cwd: curPath, ts: '2026-10-21T00:00:00.000Z', lines: 29, bodyKB: 18 });
    writeLargeReal(path.join(STORE, pastEnc), idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-21T00:00:00.000Z', turns: 120, bodyKB: 48 });
    const win = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, pastEnc]).get(idX));
    if (win && win.encodedDir === pastEnc && win.messages === 240) ok('r6: sampled-size real transcript (240 msgs) beats the 29-line truncated prefix', `dir=past msgs=${win.messages}`);
    else bad('expected r6 → past dir, 240 msgs', `win=${JSON.stringify(win && { d: win.encodedDir, m: win.messages })}`);
  }

  // ---- Case 3: equal counts, different cwd → canonical wins
  {
    const STORE = path.join(tmp, 'c3');
    const pA = '/tmp/r6c3/A/proj';
    const pB = '/tmp/r6c3/B/proj';
    const encA = hist.encodeCwd(pA);
    const encB = hist.encodeCwd(pB);
    const idX = 'aaaa0003-0000-4000-8000-000000000000';
    // Both 40-msg real transcripts; dir A's cwd encodes to A (canonical), dir B
    // holds a COPY whose in-file cwd is still pA (so B is non-canonical). B is
    // larger (extra padding) so the OLD larger-file tiebreak would pick B.
    writeReal(path.join(STORE, encA), idX, { sessionId: idX, cwd: pA, ts: '2026-10-22T00:00:00.000Z', turns: 20 });
    // copy in B with same count but padded bigger and cwd=pA (non-canonical in B)
    {
      const dir = path.join(STORE, encB);
      fs.mkdirSync(dir, { recursive: true });
      const body = 'z'.repeat(2048);
      const rows = [];
      for (let i = 0; i < 20; i++) {
        rows.push(line({ type: 'user', sessionId: idX, cwd: pA, timestamp: '2026-10-22T00:00:00.000Z', message: { role: 'user', content: `msg ${i} ${body}` } }));
        rows.push(line({ type: 'assistant', sessionId: idX, cwd: pA, timestamp: '2026-10-22T00:00:00.000Z', message: { role: 'assistant', model: 'claude', content: `reply ${i} ${body}` } }));
      }
      fs.writeFileSync(path.join(dir, `${idX}.jsonl`), rows.join('\n') + '\n');
    }
    const win = withStore(STORE, () => hist.canonicalSessionIndex([encA, encB]).get(idX));
    if (win && win.encodedDir === encA) ok('r6: equal exact counts → canonical-cwd copy wins (over a LARGER non-canonical twin)', `dir=A msgs=${win.messages}`);
    else bad('expected r6 → canonical dir A', `win=${JSON.stringify(win && { d: win.encodedDir, m: win.messages })}`);
  }

  // ---- Case 4: equal counts, equal canon → newest mtime, then stable path
  {
    const STORE = path.join(tmp, 'c4');
    // Two past-style dirs, BOTH non-canonical (in-file cwd ≠ dir), equal counts.
    const pReal = '/tmp/r6c4/realcwd/proj';
    const d1 = '/tmp/r6c4/one/arch1';
    const d2 = '/tmp/r6c4/two/arch2';
    const e1 = hist.encodeCwd(d1);
    const e2 = hist.encodeCwd(d2);
    const idX = 'aaaa0004-0000-4000-8000-000000000000';
    const older = new Date('2026-10-10T00:00:00.000Z');
    const newer = new Date('2026-10-23T00:00:00.000Z');
    writeReal(path.join(STORE, e1), idX, { sessionId: idX, cwd: pReal, ts: '2026-10-10T00:00:00.000Z', turns: 15, mtime: older });
    writeReal(path.join(STORE, e2), idX, { sessionId: idX, cwd: pReal, ts: '2026-10-10T00:00:00.000Z', turns: 15, mtime: newer });
    const win = withStore(STORE, () => hist.canonicalSessionIndex([e1, e2]).get(idX));
    if (win && win.encodedDir === e2) ok('r6: equal counts + equal canon → NEWEST mtime wins', `dir=e2(newer) msgs=${win.messages}`);
    else bad('expected r6 → newer-mtime dir e2', `win=${JSON.stringify(win && { d: win.encodedDir })}`);
  }

  // ---- Case 5: 3+ copies mixing every kind → one transitive winner (real)
  {
    const STORE = path.join(tmp, 'c5');
    const curPath = '/tmp/r6c5/current/proj';
    const pastPath = '/tmp/r6c5/old/legacy-archive';
    const contPath = '/tmp/r6c5/container/proj';
    const hostEnc = hist.encodeCwd(curPath);
    const pastEnc = hist.encodeCwd(pastPath);
    const contEnc = hist.encodeCwd(contPath);
    const idX = 'aaaa0005-0000-4000-8000-000000000000';
    writeBigMetaOnly(path.join(STORE, hostEnc), idX, { sessionId: idX, cwd: curPath, ts: '2026-10-24T00:00:00.000Z', sizeKB: 700 }); // 0 msgs, big, canonical dir
    writeTruncated(path.join(STORE, contEnc), idX, { sessionId: idX, cwd: contPath, ts: '2026-10-24T00:00:00.000Z' }); // 1 msg, canonical dir
    writeReal(path.join(STORE, pastEnc), idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-24T00:00:00.000Z', turns: 50 }); // 100 msgs, non-canonical
    const idx = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, contEnc, pastEnc]));
    const win = idx.get(idX);
    if (win && win.encodedDir === pastEnc && win.messages === 100 && win.droppedCopies.length === 2) ok('r6: 3 copies (big-meta / truncated / real) → the 100-msg real transcript, 2 dropped', `dir=past msgs=${win.messages} dropped=${win.droppedCopies.length}`);
    else bad('expected r6 → past real, 2 dropped', `win=${JSON.stringify(win && { d: win.encodedDir, m: win.messages, dc: win.droppedCopies.length })}`);
    // transitivity: the winner is independent of dir order
    for (const order of [[contEnc, pastEnc, hostEnc], [pastEnc, hostEnc, contEnc]]) {
      const w = withStore(STORE, () => hist.canonicalSessionIndex(order).get(idX));
      if (!(w && w.encodedDir === pastEnc)) { bad('transitivity: winner independent of dir order', `order=${order} → ${w && w.encodedDir}`); break; }
    }
    if (!failures) ok('r6: winner is independent of dir-walk order (total-order sort key)', 'all orders → past');
  }

  // ---- Case 6: twin GROWS between two builds → cache key changes, new count used
  {
    const STORE = path.join(tmp, 'c6');
    const curPath = '/tmp/r6c6/current/proj';
    const pastPath = '/tmp/r6c6/old/legacy-archive';
    const hostEnc = hist.encodeCwd(curPath);
    const pastEnc = hist.encodeCwd(pastPath);
    const idX = 'aaaa0006-0000-4000-8000-000000000000';
    // Host: a real transcript with 10 msgs; Past: 30 msgs. Past wins first.
    writeReal(path.join(STORE, hostEnc), idX, { sessionId: idX, cwd: curPath, ts: '2026-10-25T00:00:00.000Z', turns: 5 });
    writeReal(path.join(STORE, pastEnc), idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-25T00:00:00.000Z', turns: 15 });
    const w1 = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, pastEnc]).get(idX));
    // Now grow the HOST copy to 60 msgs (and it's canonical-cwd). Without cache
    // invalidation the stale 10-count would keep past as winner.
    writeReal(path.join(STORE, hostEnc), idX, { sessionId: idX, cwd: curPath, ts: '2026-10-25T01:00:00.000Z', turns: 30 });
    const w2 = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, pastEnc]).get(idX));
    if (w1 && w1.encodedDir === pastEnc && w2 && w2.encodedDir === hostEnc && w2.messages === 60) ok('r6: twin grows between builds → new exact count used (10→60), winner flips to host', `before=past after=host(${w2.messages})`);
    else bad('expected winner to flip to host after growth', `w1=${w1 && w1.encodedDir} w2=${JSON.stringify(w2 && { d: w2.encodedDir, m: w2.messages })}`);
  }

  // ---- Case 7: symlinked twin → one winner, no crash, no double count
  {
    const STORE = path.join(tmp, 'c7');
    const curPath = '/tmp/r6c7/current/proj';
    const pastPath = '/tmp/r6c7/old/legacy-archive';
    const hostEnc = hist.encodeCwd(curPath);
    const pastEnc = hist.encodeCwd(pastPath);
    const idX = 'aaaa0007-0000-4000-8000-000000000000';
    const realFp = writeReal(path.join(STORE, pastEnc), idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-26T00:00:00.000Z', turns: 40 });
    // A symlink in the canonical host dir pointing at the real past transcript.
    fs.mkdirSync(path.join(STORE, hostEnc), { recursive: true });
    try { fs.symlinkSync(realFp, path.join(STORE, hostEnc, `${idX}.jsonl`)); } catch (e) { bad('symlink setup', e.message); }
    const idx = withStore(STORE, () => hist.canonicalSessionIndex([hostEnc, pastEnc]));
    const win = idx.get(idX);
    // `listSessionFiles` enumerates with `Dirent.isFile()`, which is FALSE for a
    // symlink — so the symlinked twin is never listed as a second copy. The id
    // resolves to the ONE real regular file (no crash, no double-count). (If a
    // future store followed symlinks the collision path would exact-count both.)
    const resolvesToReal = win && win.encodedDir === pastEnc;
    if (resolvesToReal) ok('r6: symlinked twin → one winner, no crash, resolves to the real regular file', `dir=past (symlink not enumerated as a second copy)`);
    else bad('expected symlinked twin resolved to the one real past copy', `win=${JSON.stringify(win && { d: win.encodedDir, m: win.messages })}`);
  }

  // ---- Case 8: long (>200-char) cwd — canonical tie-break must use sdkEncodeDir
  // (independent-verify run 87bdfef5). The canonical copy sits in the SDK's REAL
  // dir for its own cwd (truncated+hash); a newer NON-canonical twin has equal
  // counts. Plain encodeCwd would never match the long dir, so rule (b) would
  // misfire and the newer non-canonical copy would win on mtime.
  {
    const STORE = path.join(tmp, 'c8');
    const longCwd = '/tmp/r6c8/' + 'seg/'.repeat(80) + 'proj'; // > 200 chars
    const otherCwd = '/tmp/r6c8/elsewhere/archive';
    const canonEnc = hist.sdkEncodeDir(longCwd);   // where the SDK actually puts it
    const plainEnc = hist.encodeCwd(longCwd);
    const otherEnc = hist.encodeCwd(otherCwd);
    const idX = 'aaaa0008-0000-4000-8000-000000000000';
    const older = new Date('2026-10-10T00:00:00.000Z');
    const newer = new Date('2026-10-27T00:00:00.000Z');
    // canonical copy (cwd=longCwd) in its real SDK dir, OLDER mtime
    writeReal(path.join(STORE, canonEnc), idX, { sessionId: idX, cwd: longCwd, ts: '2026-10-10T00:00:00.000Z', turns: 20, mtime: older });
    // non-canonical twin (cwd=longCwd but living in otherEnc), equal count, NEWER
    writeReal(path.join(STORE, otherEnc), idX, { sessionId: idX, cwd: longCwd, ts: '2026-10-10T00:00:00.000Z', turns: 20, mtime: newer });
    if (plainEnc === canonEnc) { bad('Case 8 precondition: cwd long enough to trigger sdk hash', `plain==sdk len=${plainEnc.length}`); }
    else ok('fixture: long cwd → sdkEncodeDir differs from plain encodeCwd', `len=${plainEnc.length}>200, hashed dir`);
    const win = withStore(STORE, () => hist.canonicalSessionIndex([canonEnc, otherEnc]).get(idX));
    if (win && win.encodedDir === canonEnc) ok('r6: long-cwd canonical copy wins (isCanon uses sdkEncodeDir, over a NEWER non-canonical twin)', `dir=canon(sdk)`);
    else bad('expected long-cwd canonical copy (sdk dir) to win over newer non-canonical twin', `win=${JSON.stringify(win && { d: win.encodedDir === canonEnc ? 'canon' : 'other' })}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* --------------------------- PART B: real server --------------------------- */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function partB() {
  console.log('\n--- PART B: real server — full list, page union & deep link agree over the r6 twins ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r6b-'));
  const STORE = path.join(tmp, 'store');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(STORE, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const PID = 'r6proj';
  const curPath = '/tmp/r6b/current/proj';
  const pastPath = '/tmp/r6b/old/legacy-archive';
  const contPath = '/tmp/r6b/container/proj';
  const hostEnc = hist.encodeCwd(curPath);
  const pastEnc = hist.encodeCwd(pastPath);
  const contEnc = hist.encodeCwd(contPath);
  const hostDir = path.join(STORE, hostEnc);
  const pastDir = path.join(STORE, pastEnc);
  const contDir = path.join(STORE, contEnc);

  // a base ordinary session so the project forms a logical group
  writeReal(hostDir, '0000base-0000-4000-8000-000000000000', { sessionId: '0000base-0000-4000-8000-000000000000', cwd: curPath, ts: '2026-10-01T00:00:00.000Z', turns: 3 });
  // twin M: 822 KB metadata-only host stub → real past transcript (80 msgs)
  const idM = 'd37b0ba5-0000-4000-8000-00000000000b';
  writeBigMetaOnly(hostDir, idM, { sessionId: idM, cwd: curPath, ts: '2026-10-20T00:00:00.000Z', sizeKB: 822 });
  writeReal(pastDir, idM, { sessionId: idM, cwd: pastPath, ts: '2026-10-20T00:00:00.000Z', turns: 40 });
  // twin T: 3-way big-meta(host)/truncated(container)/real(past, 120 msgs)
  const idT = 'aaaa00b5-0000-4000-8000-000000000003';
  writeBigMetaOnly(hostDir, idT, { sessionId: idT, cwd: curPath, ts: '2026-10-24T00:00:00.000Z', sizeKB: 600 });
  writeTruncated(contDir, idT, { sessionId: idT, cwd: contPath, ts: '2026-10-24T00:00:00.000Z' });
  writeReal(pastDir, idT, { sessionId: idT, cwd: pastPath, ts: '2026-10-24T00:00:00.000Z', turns: 60 });

  fs.writeFileSync(path.join(STORE, '.gitkeep'), '');
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: PID, name: 'proj', hostPath: curPath, isolation: 'direct', pastPaths: [pastPath, contPath], settings: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let srvErr = '';
  server.stderr?.on('data', (d) => { srvErr += d.toString(); if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) { bad('server came up', srvErr.slice(-800)); return; }
    const get = async (qs) => (await fetch(`${BASE}/api/projects/${PID}/sessions${qs}`)).json();

    const full = await get('');
    const fullById = new Map(full.sessions.map((s) => [s.sessionId, s]));

    // keyset page union
    const pageById = new Map();
    let cursor = null, guard = 0;
    for (;;) {
      const j = await get(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const s of j.sessions) pageById.set(s.sessionId, s);
      cursor = j.page?.cursor;
      if (!j.page?.hasMore || !cursor || ++guard > 60) break;
    }

    const sameSet = fullById.size === pageById.size && [...fullById.keys()].every((k) => pageById.has(k));
    if (sameSet) ok('full list id set == page-union id set', `${fullById.size} ids`); else bad('full/page id sets differ', `full=${fullById.size} page=${pageById.size} miss=${[...fullById.keys()].filter((k) => !pageById.has(k)).slice(0, 5)}`);

    for (const [label, id, wantMsgs] of [['M 822KB-meta→past', idM, 80], ['T 3-way→past', idT, 120]]) {
      const deep = await get(`?session=${id}`);
      const deepRow = (deep.sessions ?? []).find((s) => s.sessionId === id) ?? (deep.sessions ?? [])[0];
      const fRow = fullById.get(id);
      const pRow = pageById.get(id);
      const agree = fRow && pRow && deepRow && fRow.encodedDir === pRow.encodedDir && fRow.encodedDir === deepRow.encodedDir;
      const real = fRow && fRow.encodedDir === pastEnc && fRow.messageCount === wantMsgs;
      if (agree && real) ok(`twin ${label}: full/page/deep agree → the REAL past transcript`, `${wantMsgs} msgs`);
      else bad(`twin ${label}: expected agreement on the real past transcript`, `full=${JSON.stringify(fRow && { d: fRow.encodedDir === pastEnc ? 'past' : fRow.encodedDir === hostEnc ? 'host' : 'cont', m: fRow.messageCount })} page=${pRow && pRow.encodedDir} deep=${deepRow && deepRow.encodedDir}`);
    }

    const health = await fetch(`${BASE}/api/health`);
    if (health.ok) ok('server healthy after the run'); else bad('server unhealthy after run', String(health.status));
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ }
    server.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  console.log('\n========== FEAT-199 r6 — exact real-message count (no size proxy) ==========');
  partA();
  await partB();
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199 r6 exact-count`);
  process.exit(failures === 0 ? 0 : 1);
})();
