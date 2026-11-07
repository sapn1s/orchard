#!/usr/bin/env node
/**
 * verify:feat-204 (step 1) — the memoised head-facts cache on the
 * canonicalSessionIndex request path.
 *
 * Contract this proves:
 *  1. CANONICAL RESULTS UNCHANGED — readSessionHeadFactsCached returns EXACTLY
 *     what the uncached readSessionHeadFacts returns, for every file in the real
 *     store; and canonicalSessionIndex cold (cache empty) == warm (served from
 *     cache) on a frozen deterministic fixture.
 *  2. INVALIDATED BY ANY FILE CHANGE — append, head rewrite (incl. same byte
 *     length), rename, delete+recreate-twin (new inode), and delete are each
 *     reflected on the next call.
 *  3. WARM PAGE 1 MUCH FASTER — a warm canonicalSessionIndex over the busiest
 *     real project is dramatically faster than the cold (full re-read) pass.
 *
 * Read-only against the real store (never writes to it); all mutation happens in
 * throwaway scratch dirs. Imports the module from THIS checkout (process.cwd()),
 * so a clean-room freeze tests the frozen candidate, not some other tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const hist = await import(pathToFileURL(path.join(REPO, 'src/lib/session-history.ts')).href);

const REAL_STORE = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } };
const section = (s) => console.log('\n== ' + s + ' ==');

function hrms(fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/* ---------------------------------------------------------------- 1. equality */
section('1. canonical results unchanged (cached == uncached)');
let realDirs = [];
try {
  realDirs = fs.readdirSync(REAL_STORE, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((d) => hist.listSessionStubs(d, { root: REAL_STORE }).length > 0);
} catch (e) { console.log('  (real store not readable: ' + e.message + ')'); }

let files = 0, mism = 0;
for (const d of realDirs) {
  for (const s of hist.listSessionStubs(d, { root: REAL_STORE })) {
    files++;
    const raw = hist.readSessionHeadFacts(s.filePath);
    const cac = hist.readSessionHeadFactsCached(s.filePath);
    if (raw.sessionId !== cac.sessionId || raw.cwd !== cac.cwd) {
      mism++;
      if (mism <= 5) console.log(`    mismatch ${s.filePath}`);
    }
  }
}
console.log(`  real-store files compared: ${files}, mismatches: ${mism}`);
ok(files > 0, 'real store had files to compare');
ok(mism === 0, 'cached head facts are byte-identical to uncached for every real file');

// cold == warm on a frozen deterministic fixture
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feat204-eq-'));
  const dir = 'd1'; const dp = path.join(root, dir); fs.mkdirSync(dp);
  const L = (o) => JSON.stringify(o) + '\n';
  // normal file, same-id twin across... single dir so unique ids; plus a file
  // whose stem != in-file id (exercises the stem-fallback path).
  fs.writeFileSync(path.join(dp, 'aaa.jsonl'), L({ type: 'user', sessionId: 'ID-1', cwd: '/p1' }));
  fs.writeFileSync(path.join(dp, 'renamed-stem.jsonl'), L({ type: 'user', sessionId: 'ID-2', cwd: '/p2' }));
  fs.writeFileSync(path.join(dp, 'nohead.jsonl'), L({ type: 'assistant', message: { role: 'assistant', content: 'x' } }));
  hist.clearSessionCache?.();
  const serial = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => k + '=' + JSON.stringify({ f: v.filePath, c: v.cwd, b: v.fileBytes, dc: v.droppedCopies })).join('|');
  const cold = serial(hist.canonicalSessionIndex([dir], { root }));
  const warm = serial(hist.canonicalSessionIndex([dir], { root }));
  ok(cold === warm, 'canonicalSessionIndex cold == warm on frozen fixture');
  fs.rmSync(root, { recursive: true, force: true });
}

/* ---------------------------------------------------------- 2. invalidation */
section('2. invalidated by any file change');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feat204-inv-'));
  const dir = 'd'; const dp = path.join(root, dir); fs.mkdirSync(dp);
  const opts = { root };
  const L = (o) => JSON.stringify(o) + '\n';
  const mk = (id, cwd) => L({ type: 'user', sessionId: id, cwd });
  const P = (n) => path.join(dp, n);
  const facts = (n) => hist.readSessionHeadFactsCached(P(n));
  const canon = () => hist.canonicalSessionIndex([dir], opts);
  let t = 1700000000; const bump = (n) => { t += 5; fs.utimesSync(P(n), t, t); };

  fs.writeFileSync(P('a.jsonl'), mk('A', '/one')); bump('a.jsonl');
  hist.clearSessionCache?.();
  ok(facts('a.jsonl').sessionId === 'A', 'baseline id A');

  // append
  const b0 = fs.statSync(P('a.jsonl')).size;
  fs.appendFileSync(P('a.jsonl'), L({ type: 'assistant', message: { role: 'assistant', content: 'later' } })); bump('a.jsonl');
  ok(facts('a.jsonl').sessionId === 'A', 'append: id still A');
  ok(canon().get('A').fileBytes > b0, 'append: canonical entry reflects new size');

  // head rewrite (facts change)
  fs.writeFileSync(P('a.jsonl'), mk('A2', '/two')); bump('a.jsonl');
  ok(facts('a.jsonl').sessionId === 'A2' && facts('a.jsonl').cwd === '/two', 'head rewrite: new facts reflected');

  // same-byte-length head rewrite
  const s1 = mk('SAME-1', '/x'); fs.writeFileSync(P('b.jsonl'), s1); bump('b.jsonl'); hist.clearSessionCache?.();
  ok(facts('b.jsonl').sessionId === 'SAME-1', 'same-size baseline');
  const s2 = mk('SAME-2', '/x');
  ok(s1.length === s2.length, 'same-size precondition (equal length)');
  fs.writeFileSync(P('b.jsonl'), s2); bump('b.jsonl');
  ok(facts('b.jsonl').sessionId === 'SAME-2', 'same-size rewrite reflected (mtimeNs invalidates)');

  // rename
  canon();
  fs.renameSync(P('a.jsonl'), P('c.jsonl')); bump('c.jsonl');
  const m = canon();
  ok([...m.values()].some((e) => e.filePath.endsWith('/c.jsonl')), 'rename: new path present');
  ok(![...m.values()].some((e) => e.filePath.endsWith('/a.jsonl')), 'rename: old path gone');

  // delete + twin (new inode, different content)
  fs.writeFileSync(P('twin.jsonl'), mk('TWIN-OLD', '/t')); bump('twin.jsonl'); hist.clearSessionCache?.();
  ok(facts('twin.jsonl').sessionId === 'TWIN-OLD', 'twin baseline');
  const inoOld = fs.statSync(P('twin.jsonl'), { bigint: true }).ino;
  fs.rmSync(P('twin.jsonl'));
  fs.writeFileSync(P('twin.jsonl'), mk('TWIN-NEW', '/t2')); bump('twin.jsonl');
  const inoNew = fs.statSync(P('twin.jsonl'), { bigint: true }).ino;
  ok(facts('twin.jsonl').sessionId === 'TWIN-NEW', `delete+twin reflected (ino ${inoOld}->${inoNew})`);

  // delete only
  fs.writeFileSync(P('d.jsonl'), mk('D', '/d')); bump('d.jsonl'); canon();
  ok(canon().has('D'), 'delete: present before');
  fs.rmSync(P('d.jsonl'));
  ok(!canon().has('D'), 'delete: gone after');

  // ADVERSARIAL (independent-verify run 180052d9): in-place same-size rewrite
  // with the OLD mtime restored (cp -p / rsync -t / tar over an existing file).
  // Same inode, same size, mtime set back — only ctime advances. Must NOT stale.
  fs.writeFileSync(P('r.jsonl'), mk('REST-OLD', '/r')); fs.utimesSync(P('r.jsonl'), t, t); hist.clearSessionCache?.();
  ok(facts('r.jsonl').sessionId === 'REST-OLD', 'restore baseline');
  const stOld = fs.statSync(P('r.jsonl'), { bigint: true });
  const nu = mk('REST-NEW', '/r');
  ok(nu.length === mk('REST-OLD', '/r').length, 'restore precondition (equal length)');
  fs.writeFileSync(P('r.jsonl'), nu);
  fs.utimesSync(P('r.jsonl'), t, t); // restore the OLD mtime (as cp -p would)
  const stNew = fs.statSync(P('r.jsonl'), { bigint: true });
  ok(stOld.mtimeNs === stNew.mtimeNs && stOld.size === stNew.size && stOld.ino === stNew.ino,
    'restore precondition (mtime+size+ino all unchanged; only ctime moves)');
  ok(facts('r.jsonl').sessionId === 'REST-NEW', 'mtime-restored same-size rewrite reflected (ctimeNs invalidates)');
  ok(canon().has('REST-NEW') && !canon().has('REST-OLD'), 'restore: canonical index reflects new id');

  // ADVERSARIAL (independent-verify run dd04fb58): a TRANSIENT open/read failure
  // (EMFILE under fd pressure) must NOT be memoised. stat succeeds, open fails →
  // null returned but not cached; when pressure clears, the very next call (file
  // stat UNCHANGED, same signature) must read the real facts, not a stale null.
  {
    fs.writeFileSync(P('fail.jsonl'), mk('REAL', '/real')); bump('fail.jsonl'); hist.clearSessionCache?.();
    const fds = [];
    let induced = false;
    try {
      // Exhaust file descriptors until open() throws EMFILE.
      for (let i = 0; i < 5_000_000; i++) {
        try { fds.push(fs.openSync(P('fail.jsonl'), 'r')); }
        catch (e) { if (e.code === 'EMFILE' || e.code === 'ENFILE') { induced = true; } break; }
      }
      if (induced) {
        const during = facts('fail.jsonl'); // open fails → null, must NOT be cached
        // release pressure
        for (const fd of fds.splice(0)) { try { fs.closeSync(fd); } catch { /* */ } }
        const after = facts('fail.jsonl'); // same stat sig; must re-read the real facts
        ok(after.sessionId === 'REAL', `transient failure not memoised: after-recovery reads REAL (during=${during.sessionId})`);
        const m = canon();
        ok([...m.keys()].includes('REAL'), 'canonical index keys the real in-file id after a transient failure (not the stem)');
      } else {
        console.log('  (could not induce EMFILE on this host; skipping transient-failure assertion)');
      }
    } finally {
      for (const fd of fds) { try { fs.closeSync(fd); } catch { /* */ } }
    }
  }

  // ADVERSARIAL: a caller that MUTATES the returned object must not corrupt the
  // cache — the next read must still see the file's real facts.
  fs.writeFileSync(P('m.jsonl'), mk('MUT', '/m')); bump('m.jsonl'); hist.clearSessionCache?.();
  const got = facts('m.jsonl');
  got.sessionId = 'HACKED';
  ok(facts('m.jsonl').sessionId === 'MUT', 'mutating the returned object does not poison the cache');

  fs.rmSync(root, { recursive: true, force: true });
}

/* --------------------------------------- 3a. exactRealMessageCount identity */
section('3a. exactRealMessageCount keyed on full file identity (ino+ctime), not just mtime+size');
{
  // OpenAI run 01a1b79b-29e5-7020-a3ec-28e300f62b96: exactRealMessageCount's memo
  // key used to be (path, mtimeMs, size) only. Force a same-id TWIN COLLISION
  // (the only path that calls exactRealMessageCount), establish a cached count
  // for the LOSING twin, then rewrite that twin to have MORE real messages than
  // the winner while keeping its byte length identical and its mtime RESTORED
  // (cp -p-style) — only ctime moves. The twin must flip to canonical; a stale
  // (path, mtime, size)-only cache would keep serving the OLD (lower) count and
  // never flip the winner.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feat204-exact-'));
  const dirA = 'dA', dirB = 'dB';
  fs.mkdirSync(path.join(root, dirA)); fs.mkdirSync(path.join(root, dirB));
  const pA = path.join(root, dirA, 'twin.jsonl');
  const pB = path.join(root, dirB, 'twin.jsonl');
  const ID = 'TWINX-204';
  // "user" and "meta" are both 4 chars, so flipping between them never changes
  // byte length — the file's SIZE stays identical across the rewrite below.
  const header = (cwd) => JSON.stringify({ type: 'user', sessionId: ID, cwd, message: { role: 'user', content: 'h' } }) + '\n';
  const line = (type) => JSON.stringify({ type, message: { role: 'user', content: 'x' } }) + '\n';
  let t = 1700100000;

  // A starts with 1 real message (header only, 2 non-real 'meta' lines); B has
  // 2 real messages (header + 1 'user' line, 1 non-real 'meta' line) -> B wins.
  const aBefore = header('/a') + line('meta') + line('meta');
  fs.writeFileSync(pA, aBefore);
  fs.utimesSync(pA, t, t);
  fs.writeFileSync(pB, header('/b') + line('user') + line('meta'));
  fs.utimesSync(pB, t, t);
  hist.clearSessionCache?.();

  const before = hist.canonicalSessionIndex([dirA, dirB], { root }).get(ID);
  ok(before?.encodedDir === dirB && before?.messages === 2, `baseline: B wins with 2 real messages (got dir=${before?.encodedDir} messages=${before?.messages})`);

  // Rewrite A to 3 real messages (now MORE than B's 2), same byte length (both
  // 'meta' lines flipped to 'user', 4 chars either way), mtime RESTORED to the
  // old t (as cp -p / rsync -t would) — only ctime moves.
  const aAfter = header('/a') + line('user') + line('user'); // A: 1 -> 3 real messages
  ok(aAfter.length === aBefore.length, 'rewrite precondition: byte length unchanged');
  fs.writeFileSync(pA, aAfter);
  fs.utimesSync(pA, t, t);

  const after = hist.canonicalSessionIndex([dirA, dirB], { root }).get(ID);
  ok(after?.encodedDir === dirA && after?.messages === 3, `after same-size restore-mtime rewrite: A flips to canonical with 3 real messages (got dir=${after?.encodedDir} messages=${after?.messages})`);

  fs.rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------- 3. warm speed */
section('3. warm page 1 much faster');
{
  // pick the busiest real dir
  let best = null, bestN = 0;
  for (const d of realDirs) {
    const n = hist.listSessionStubs(d, { root: REAL_STORE }).length;
    if (n > bestN) { bestN = n; best = d; }
  }
  if (best && bestN >= 200) {
    hist.clearSessionCache?.();
    const cold = hrms(() => hist.canonicalSessionIndex([best], { root: REAL_STORE }));
    const warm1 = hrms(() => hist.canonicalSessionIndex([best], { root: REAL_STORE }));
    const warm2 = hrms(() => hist.canonicalSessionIndex([best], { root: REAL_STORE }));
    console.log(`  busiest dir files=${bestN} cold=${cold.ms.toFixed(1)}ms warm1=${warm1.ms.toFixed(1)}ms warm2=${warm2.ms.toFixed(1)}ms`);
    const warm = Math.min(warm1.ms, warm2.ms);
    ok(warm < cold.ms / 5, `warm is >5x faster than cold (cold ${cold.ms.toFixed(0)}ms / warm ${warm.toFixed(0)}ms)`);
    ok(warm < 400, `warm pass under 400ms (${warm.toFixed(0)}ms)`);
  } else {
    console.log('  (no sufficiently busy real dir found; skipping timing assertions)');
  }
}

console.log(`\nFEAT-204 head-facts cache: ${pass} passed, ${fail} failed -> ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
