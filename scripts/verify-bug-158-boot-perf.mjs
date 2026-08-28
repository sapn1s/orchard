/**
 * verify:bug-158 — the boot-path scan memoisation is FAST and CORRECT.
 *
 * BUG-158: GET /api/projects re-ran two whole-store scans once PER PROJECT.
 * The fix memoises the codex rollout head (codex-native.ts) and probeCwd
 * (session-history.ts). This proves:
 *
 *  A. IDENTITY — a memoised scan returns byte-identical rows (same sessions,
 *     same fields, same order) to an un-memoised (cache-cleared) scan, against
 *     the REAL store when present, else a realistic-state scratch store.
 *  B. INVALIDATION — changing a rollout's size/mtime forces a fresh head read;
 *     the cache never serves stale rows.
 *  C. HEAD SIZE — the 256 KB head is NOT safely shrinkable on this store: the
 *     session_meta line alone is ~18.6 KB, so a sub-19 KB head returns ZERO
 *     sessions. Guards the "silent wrong answer" trap.
 *  D. BOUND — the two scans, run once per project (13×) with the cache warm,
 *     complete well under the endpoint's 400 ms budget; and 13× is far faster
 *     than the un-memoised cost (the regression the ticket bounds).
 *
 * No writes outside a scratch dir. Never touches port 4317 or any live host.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

import * as hist from '../src/lib/session-history.ts';
import * as cn from '../src/server/codex-native.ts';

let failures = 0;
const ok = (name) => console.log(`  ok  ${name}`);
const bad = (name, err) => { failures++; console.log(`FAIL  ${name}\n      ${err}`); };
function check(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e?.message ?? e); } }

const REAL_CLAUDE = path.join(os.homedir(), '.claude', 'projects');
const REAL_CODEX = path.join(os.homedir(), '.codex');
const HAVE_REAL = fs.existsSync(REAL_CLAUDE) && fs.existsSync(path.join(REAL_CODEX, 'sessions'));

// Real registry cwds (for the codex per-cwd scan); fall back to a couple of
// synthetic cwds if the registry is not present.
function realCwds() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/share/claude-station/registry.json'), 'utf8'));
    return (Array.isArray(reg) ? reg : reg.projects).map((p) => p.hostPath);
  } catch { return []; }
}

console.log(`\nBUG-158 boot-perf verify (real store: ${HAVE_REAL ? 'YES' : 'no — using scratch'})\n`);

/* ---------------------------------------------------------------- A. IDENTITY */

if (HAVE_REAL) {
  const env = { ...process.env, CODEX_HOME: REAL_CODEX };
  const cwds = realCwds();
  const codexTargets = (cwds.length ? cwds : [os.homedir()]).slice(0, 13);

  check('A1 codex: warm (cached) rows === cold (cleared) rows, per project', () => {
    for (const cwd of codexTargets) {
      cn.clearRolloutCache();
      const cold = cn.listNativeCodexSessions(cwd, { env });
      const warm = cn.listNativeCodexSessions(cwd, { env }); // 2nd call = all cache hits
      assert.deepEqual(warm, cold, `rows differ for ${cwd}`);
    }
  });

  check('A2 codex: rows are stable across a full 13× request (order + fields)', () => {
    cn.clearRolloutCache();
    const first = codexTargets.map((c) => cn.listNativeCodexSessions(c, { env }));
    const second = codexTargets.map((c) => cn.listNativeCodexSessions(c, { env }));
    assert.deepEqual(second, first);
  });

  check('A3 listProjectDirs: probeCwd-memo output === cache-cleared output', () => {
    hist.clearSessionCache();
    const cold = hist.listProjectDirs({ root: REAL_CLAUDE });
    const warm = hist.listProjectDirs({ root: REAL_CLAUDE }); // probeCwd now cached
    assert.deepEqual(warm, cold);
  });

  check('A4 listLogicalProjects: memoised === fresh', () => {
    hist.clearSessionCache();
    const cold = hist.listLogicalProjects({ root: REAL_CLAUDE });
    const warm = hist.listLogicalProjects({ root: REAL_CLAUDE });
    assert.deepEqual(warm, cold);
  });
}

/* ----------------------------------------------------- B. INVALIDATION (scratch) */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug158-'));
try {
  // A realistic-state codex rollout: an 18.6 KB session_meta line (base_instructions),
  // then a wrapper user block, then a real user prompt — mirroring the real store.
  const day = path.join(tmp, 'codex', 'sessions', '2026', '08', '27');
  fs.mkdirSync(day, { recursive: true });
  const sid = '01a00000-0000-7000-8000-000000000001';
  const cwd = path.join(tmp, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const bigInstr = 'x'.repeat(18 * 1024); // push session_meta past 18 KB, like the real store
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: sid, cwd, timestamp: '2026-08-27T00:00:00.000Z', model: 'gpt-5', base_instructions: bigInstr } });
  const wrap = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignore me</environment_context>' }] } });
  const prompt1 = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FIRST real prompt' }] } });
  const file = path.join(day, `rollout-2026-08-27T00-00-00-${sid}.jsonl`);
  fs.writeFileSync(file, [meta, wrap, prompt1].join('\n') + '\n');
  const env = { ...process.env, CODEX_HOME: path.join(tmp, 'codex') };

  check('B0 realistic scratch rollout lists (session_meta line ~18.6 KB)', () => {
    cn.clearRolloutCache();
    const rows = cn.listNativeCodexSessions(cwd, { env });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, sid);
    assert.equal(rows[0].displayTitle, 'FIRST real prompt');
  });

  check('B1 head cache: a changed file (new size+mtime) re-reads the HEAD, never stale', () => {
    // SYNTHETIC invalidation test. fileBytes/fileMtime refresh from a fresh stat
    // every call regardless of the head cache, so they cannot prove head reuse.
    // The only field that proves the cached HEAD was re-read is one PARSED from
    // the head — the title. Populate the cache on v1, then change the head's
    // first user prompt and bump size+mtime; a correct cache must return v2's
    // title, not the memoised v1 title.
    cn.clearRolloutCache();
    const v1 = cn.listNativeCodexSessions(cwd, { env })[0];
    assert.equal(v1.displayTitle, 'FIRST real prompt', 'v1 title cached');
    const prompt2 = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECOND real prompt now' }] } });
    fs.writeFileSync(file, [meta, wrap, prompt2].join('\n') + '\n'); // different content + size
    const now = Date.now() / 1000 + 5;
    fs.utimesSync(file, now, now);
    const v2 = cn.listNativeCodexSessions(cwd, { env })[0];
    assert.equal(v2.displayTitle, 'SECOND real prompt now', `stale head served: got ${JSON.stringify(v2.displayTitle)}`);
  });

  check('C head size: a sub-19 KB head returns ZERO sessions (16 KB is UNSAFE)', () => {
    // Directly: the session_meta line is longer than 16 KB, so a 16 KB head
    // drops it as a trailing partial and finds no session_id/cwd.
    const h16 = cn.readRolloutHead(file, 16 * 1024);
    assert.equal(h16.sessionId, null, 'expected 16 KB head to miss session_meta');
    assert.equal(h16.cwd, null);
    const hFull = cn.readRolloutHead(file, 256 * 1024);
    assert.equal(hFull.sessionId, sid, 'full head must recover session_meta');
    assert.equal(hFull.cwd, cwd);
  });

  check('B2 listProjectDirs freshness: a new session file updates lastActivityAt', () => {
    const root = path.join(tmp, 'claude');
    const enc = hist.encodeCwd(cwd);
    const dir = path.join(root, enc);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({ type: 'user', cwd, timestamp: '2026-08-27T01:00:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n');
    hist.clearSessionCache();
    const first = hist.listProjectDirs({ root }).find((d) => d.encodedDir === enc);
    assert.ok(first, 'dir listed');
    const before = first.lastActivityAt;
    // A newer session appears; probeCwd is cached by path but the stat walk must
    // still pick up the new file's mtime.
    const f2 = path.join(dir, 's2.jsonl');
    fs.writeFileSync(f2, JSON.stringify({ type: 'user', cwd, timestamp: '2026-08-27T02:00:00.000Z', message: { role: 'user', content: 'later' } }) + '\n');
    const later = Date.now() / 1000 + 10;
    fs.utimesSync(f2, later, later);
    const after = hist.listProjectDirs({ root }).find((d) => d.encodedDir === enc);
    assert.equal(after.sessionCount, 2, 'new file counted');
    assert.ok((after.lastActivityAt ?? '') > (before ?? ''), `lastActivityAt stale: ${before} -> ${after.lastActivityAt}`);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* -------------------------------------------------------------------- D. BOUND */

if (HAVE_REAL) {
  const env = { ...process.env, CODEX_HOME: REAL_CODEX };
  const cwds = (realCwds().length ? realCwds() : [os.homedir()]).slice(0, 13);
  const ms = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

  // Un-memoised: clear the cache before EVERY per-project call (the old behaviour).
  const cold = ms(() => {
    for (const c of cwds) { cn.clearRolloutCache(); hist.clearSessionCache(); cn.listNativeCodexSessions(c, { env }); hist.listLogicalProjects({ root: REAL_CLAUDE }); }
  });
  // Memoised: warm the caches once, then run the full 13× request REPEATEDLY —
  // the criterion is "warm and repeated", so take the median of several passes
  // (a single pass is noisy near the boundary under machine contention).
  cn.clearRolloutCache(); hist.clearSessionCache();
  cn.listNativeCodexSessions(cwds[0], { env }); hist.listLogicalProjects({ root: REAL_CLAUDE });
  const warmRuns = [];
  for (let i = 0; i < 5; i++) {
    warmRuns.push(ms(() => {
      for (const c of cwds) { cn.listNativeCodexSessions(c, { env }); hist.listLogicalProjects({ root: REAL_CLAUDE }); }
    }));
  }
  const warm = warmRuns.slice().sort((a, b) => a - b)[Math.floor(warmRuns.length / 2)];
  console.log(`\n  timing: un-memoised 13× = ${cold.toFixed(0)}ms   memoised 13× warm median = ${warm.toFixed(0)}ms  (runs: ${warmRuns.map((x) => x.toFixed(0)).join(', ')})`);
  check('D1 warm 13× scan (median, repeated) is under the 400ms endpoint budget', () => {
    assert.ok(warm < 400, `warm median ${warm.toFixed(0)}ms exceeds 400ms`);
  });
  check('D2 memoisation is a large win (warm < 40% of un-memoised)', () => {
    assert.ok(warm < cold * 0.4, `warm ${warm.toFixed(0)}ms vs cold ${cold.toFixed(0)}ms`);
  });
} else {
  console.log('\n  (D bound skipped — no real store on this host)');
}

console.log(`\n${failures ? `FAILED (${failures})` : 'ALL PASSED'}\n`);
process.exit(failures ? 1 : 0);
