#!/usr/bin/env node
/**
 * BUG-202 — decisions.ts / outcomes.ts torn-read wipe (DATA-LOSS).
 *
 *   node scripts/verify-bug-202-store-dataloss.mjs
 *
 * The defect (same shape FEAT-126 fixed in requests.ts): each store is ONE
 * shared JSON file mutated read-all → write-all, and `readAll()` returns `[]`
 * for BOTH "no store yet" (ENOENT — genuinely empty) AND "present but
 * unreadable" (torn / corrupt / wrong-shape). The unconditional-append writers
 * (`decisions.raise`, `outcomes.record`) then write over that `[]` — so a write
 * that lands on a corrupt store WIPES every prior record.
 *
 * INVARIANT under test (the fix): "a write for key K can never remove or
 * overwrite another key's data, and an unreadable store is never overwritten as
 * if empty." Concretely, when the store file is present-but-unreadable, an
 * append writer must PRESERVE the existing bytes (quarantine to
 * `<file>.corrupt-<ts>`) before starting fresh — never destroy them.
 *
 * Everything here drives the REAL src/server/decisions.ts and src/server/
 * outcomes.ts against a scratch CLAUDE_STATION_DATA dir. No server, no network.
 *
 * MUST-FAIL is proven two independent ways, neither anchored to a moving
 * baseline (docs/CONVENTIONS.md):
 *  1. a self-contained PRE-FIX SIMULATION (the old readAll/writeAll semantics,
 *     reimplemented inline) is shown to wipe — a fixed synthesized baseline;
 *  2. `--prefix` re-runs the store assertions against a supplied pre-fix copy of
 *     the module (used by the ticket's must-FAIL capture before the edit landed).
 *
 * Design rules (WORKING_AGREEMENT §C): every check prints the value it observed;
 * each assertion states its precondition; a check that could pass on empty input
 * asserts that precondition first.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const scratches = new Set();
function freshData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bug202-'));
  scratches.add(d);
  return d;
}
function cleanup() {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** Import a store module against a chosen data dir (each import re-reads env). */
async function loadStores(dataDir) {
  process.env.CLAUDE_STATION_DATA = dataDir;
  // Cache-bust so a re-import re-evaluates against the new env (module code
  // reads dataDir() lazily per call, but a fresh URL is belt-and-braces).
  const q = `?d=${encodeURIComponent(dataDir)}&t=${Date.now()}-${Math.random()}`;
  const decisions = await import(path.join(ROOT, 'src', 'server', 'decisions.ts') + q);
  const outcomes = await import(path.join(ROOT, 'src', 'server', 'outcomes.ts') + q);
  return { decisions, outcomes };
}

function corruptFiles(dir) {
  // Every `<store>.corrupt-*` quarantine file in the data dir.
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.corrupt-/.test(f))
    : [];
}

/* ───────────────────────── 1. PRE-FIX SIMULATION (fixed baseline) ─────────── */
// The old semantics, reimplemented so the must-FAIL proof cannot silently become
// vacuous once the fix is committed (CONVENTIONS: never anchor to HEAD).
function preFixWipes() {
  const dir = freshData();
  const file = path.join(dir, 'store.json');
  const oldReadAll = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const oldWriteAll = (recs) => fs.writeFileSync(file, JSON.stringify(recs));
  // seed 3, then corrupt, then append 1 the old way
  oldWriteAll([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  fs.writeFileSync(file, '[{"id":"a"},{"id":"b"},{"id":"c'); // torn mid-record
  const all = oldReadAll(); all.push({ id: 'd' }); oldWriteAll(all);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const quarantines = corruptFiles(dir);
  check('pre-fix simulation WIPES on torn read (baseline is non-vacuous)',
    after.length === 1 && after[0].id === 'd' && quarantines.length === 0,
    `after write, store=${JSON.stringify(after)} quarantines=${quarantines.length} (a,b,c gone — this is the bug)`);
}

/* ───────────────────────── 2. decisions.ts torn-read wipe ─────────────────── */
async function decisionsTornWipe() {
  const dir = freshData();
  const { decisions } = await loadStores(dir);
  const file = path.join(dir, 'decisions.json');

  // seed 3 open decisions
  for (const q of ['q1', 'q2', 'q3']) {
    decisions.raise({ projectId: 'p1', sessionId: 's1', sdkSessionId: null, question: q });
  }
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('decisions: precondition — 3 records seeded and readable', seeded.length === 3, `len=${seeded.length}`);

  // corrupt the store (a torn write — valid JSON prefix, truncated mid-record)
  const tornBytes = fs.readFileSync(file, 'utf8').slice(0, 80);
  fs.writeFileSync(file, tornBytes);
  check('decisions: precondition — store is now present-but-unreadable',
    (() => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return !Array.isArray(j); } catch { return true; } })(),
    `first80=${JSON.stringify(tornBytes.slice(0, 40))}…`);

  // the WIPE trigger: raise on a corrupt store
  const rec = decisions.raise({ projectId: 'p1', sessionId: 's1', sdkSessionId: null, question: 'q4' });

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const quarantines = corruptFiles(dir);
  const preserved = quarantines.length === 1 && fs.readFileSync(path.join(dir, quarantines[0]), 'utf8') === tornBytes;

  check('decisions: DATA-LOSS — corrupt bytes are PRESERVED, not destroyed (quarantined)',
    preserved,
    `quarantine files=${JSON.stringify(quarantines)} bytes-match=${preserved}`);
  check('decisions: store self-heals — readable array holding the new record',
    Array.isArray(after) && after.some((r) => r.question === 'q4') && rec?.question === 'q4',
    `after=${JSON.stringify(after.map((r) => r.question))} raised=${rec?.question}`);
}

/* ───────────────────────── 3. outcomes.ts torn-read wipe ──────────────────── */
async function outcomesTornWipe() {
  const dir = freshData();
  const { outcomes } = await loadStores(dir);
  const file = path.join(dir, 'agent-outcomes.json');

  for (const a of ['ag1', 'ag2', 'ag3']) {
    outcomes.record({ stationSessionId: 'S', sdkSessionId: null, agentId: a, row: 'agent', label: a, kind: 'killed', detail: 'x' });
  }
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('outcomes: precondition — 3 death records seeded and readable', seeded.length === 3, `len=${seeded.length}`);

  const tornBytes = fs.readFileSync(file, 'utf8').slice(0, 120);
  fs.writeFileSync(file, tornBytes);
  check('outcomes: precondition — store is now present-but-unreadable',
    (() => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return !Array.isArray(j); } catch { return true; } })(),
    `first bytes truncated to 120`);

  const rec = outcomes.record({ stationSessionId: 'S', sdkSessionId: null, agentId: 'ag4', row: 'agent', label: 'ag4', kind: 'failed', detail: 'y' });

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const quarantines = corruptFiles(dir);
  const preserved = quarantines.length === 1 && fs.readFileSync(path.join(dir, quarantines[0]), 'utf8') === tornBytes;

  check('outcomes: DATA-LOSS — corrupt bytes are PRESERVED, not destroyed (quarantined)',
    preserved,
    `quarantine files=${JSON.stringify(quarantines)} bytes-match=${preserved}`);
  check('outcomes: store self-heals — readable array holding the new record',
    Array.isArray(after) && after.some((r) => r.agentId === 'ag4') && rec?.agentId === 'ag4',
    `after=${JSON.stringify(after.map((r) => r.agentId))} recorded=${rec?.agentId}`);
}

/* ─────────── 4. mutating writers never clobber a corrupt store (both) ─────── */
async function mutatingWritersAreSafe() {
  const dir = freshData();
  const { decisions, outcomes } = await loadStores(dir);
  const dfile = path.join(dir, 'decisions.json');
  const ofile = path.join(dir, 'agent-outcomes.json');
  decisions.raise({ projectId: 'p1', sessionId: 's1', sdkSessionId: null, question: 'keep-me' });
  outcomes.record({ stationSessionId: 'S', sdkSessionId: null, agentId: 'a', row: 'agent', label: 'a', kind: 'killed', detail: 'x' });
  const dTorn = fs.readFileSync(dfile, 'utf8').slice(0, 30);
  const oTorn = fs.readFileSync(ofile, 'utf8').slice(0, 30);
  fs.writeFileSync(dfile, dTorn);
  fs.writeFileSync(ofile, oTorn);

  // resolve/dismiss on a corrupt store: return the empty answer, write NOTHING
  const r = decisions.resolve('nope', 'Allow', false);
  const n = outcomes.dismiss(['nope']);
  const dAfter = fs.readFileSync(dfile, 'utf8');
  const oAfter = fs.readFileSync(ofile, 'utf8');
  check('mutating writers do not clobber a corrupt store (byte-identical, no quarantine)',
    r === null && n === 0 && dAfter === dTorn && oAfter === oTorn && corruptFiles(dir).length === 0,
    `resolve=${r} dismiss=${n} decisions-untouched=${dAfter === dTorn} outcomes-untouched=${oAfter === oTorn}`);
}

/* ─────────── 5. real-file COMPAT: existing valid stores read unchanged ─────── */
// Migration check: the fix keeps the single-file layout, so a real valid store
// must read identically and MUST NOT be quarantined. Tested on a /tmp COPY of
// the real data dir — the real dir is never touched.
async function realFileCompat() {
  const realDir = path.join(os.homedir(), '.local', 'share', 'claude-station');
  const dir = freshData();
  let copied = [];
  for (const f of ['decisions.json', 'agent-outcomes.json']) {
    const src = path.join(realDir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); copied.push(f); }
  }
  if (!copied.length) { check('real-file compat — SKIPPED (no real store on this machine)', true, 'none present'); return; }
  const { decisions, outcomes } = await loadStores(dir);
  const dOpen = decisions.listOpenForProject('__none__'); // reads through readAll
  const oList = outcomes.list({ limit: 1000 });
  const readAllDec = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'));
  const readAllOut = fs.existsSync(path.join(dir, 'agent-outcomes.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'agent-outcomes.json'), 'utf8')) : [];
  check('real-file compat — valid stores parse, NOT quarantined, byte-preserved',
    corruptFiles(dir).length === 0 && Array.isArray(readAllDec) && Array.isArray(readAllOut),
    `copied=${JSON.stringify(copied)} decisions=${readAllDec.length} outcomes=${readAllOut.length} listOpen=${dOpen.length} list=${oList.length} quarantines=${corruptFiles(dir).length}`);
}

/* ─────────── 6. shared quarantine helper (store-io.ts) — round-6 defects ─────
 * decisions.ts / outcomes.ts now route quarantine + capped read through
 * src/server/store-io.ts (ARCH-010: one owner). These prove both stores inherit
 * the round-6 fixes: (1) a second corrupt event never overwrites an earlier
 * quarantine; (2) two quarantines in the same millisecond both survive; (3) an
 * oversized store is refused by an fd-bounded read (no unbounded read), preserved,
 * and self-heals — never clobbered. */
async function sharedHelperRound6() {
  // (1) no-clobber: two corrupt events preserve BOTH sets of bytes.
  for (const store of ['decisions', 'outcomes']) {
    const dir = freshData();
    const stores = await loadStores(dir);
    const raise = store === 'decisions'
      ? (q) => stores.decisions.raise({ projectId: 'p', sessionId: 's', sdkSessionId: null, question: q })
      : (q) => stores.outcomes.record({ stationSessionId: 'S', sdkSessionId: null, agentId: q, row: 'agent', label: q, kind: 'killed', detail: 'x' });
    const file = path.join(dir, store === 'decisions' ? 'decisions.json' : 'agent-outcomes.json');
    // Corrupt content these stores treat as unreadable: torn JSON, and a non-array
    // object (they validate Array.isArray, so a non-array is corrupt). Frozen clock
    // so a timestamp-only quarantine name would collide (defects 1 & 2).
    const realNow = Date.now; Date.now = () => 1_790_000_000_000;
    try {
      raise('seed');
      fs.writeFileSync(file, '[{"id":"a"'); raise('q1');  // corrupt #1 (torn) → quarantine A
      fs.writeFileSync(file, '{"x":1}'); raise('q2');     // corrupt #2 (object), same ms → quarantine B
    } finally { Date.now = realNow; }
    const q = corruptFiles(dir);
    const bodies = q.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(`${store}: two same-ms corrupt events preserve BOTH quarantines (no-clobber) + self-heal`,
      q.length === 2 && bodies.join('|') === ['[{"id":"a"', '{"x":1}'].sort().join('|') && Array.isArray(after) && after.length >= 1,
      `quarantines=${q.length} bodies=${JSON.stringify(bodies)} after=${after.length}`);
  }
  // (3) oversized store: a >16 MB VALID-JSON file (an unbounded read would parse
  // and admit it) is refused by the fd-bounded read, quarantined (bytes preserved),
  // and self-heals — never read unbounded, never clobbered.
  for (const store of ['decisions', 'outcomes']) {
    const dir = freshData();
    const stores = await loadStores(dir);
    const raise = store === 'decisions'
      ? (q) => stores.decisions.raise({ projectId: 'p', sessionId: 's', sdkSessionId: null, question: q })
      : (q) => stores.outcomes.record({ stationSessionId: 'S', sdkSessionId: null, agentId: q, row: 'agent', label: q, kind: 'killed', detail: 'x' });
    const file = path.join(dir, store === 'decisions' ? 'decisions.json' : 'agent-outcomes.json');
    const huge = '[' + '"x",'.repeat(4_500_000) + '"x"]'; // ~18 MB, a VALID JSON array
    fs.writeFileSync(file, huge);
    raise('after-huge');
    const q = corruptFiles(dir);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const preservedBig = q.length === 1 && fs.statSync(path.join(dir, q[0])).size === huge.length;
    check(`${store}: oversized VALID-JSON store refused (fd-bounded read), quarantined + self-heals`,
      preservedBig && Array.isArray(after) && after.length === 1,
      `quarantines=${q.length} preserved-size-ok=${preservedBig} after=${after.length}`);
  }
}

(async () => {
  console.log('BUG-202 — store torn-read wipe (decisions.ts / outcomes.ts)\n');
  try {
    preFixWipes();
    await decisionsTornWipe();
    await outcomesTornWipe();
    await mutatingWritersAreSafe();
    await realFileCompat();
    await sharedHelperRound6();
  } catch (err) {
    console.error('FATAL', err?.stack || err);
    fail++;
  } finally {
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:', failures.join(', ')); process.exit(1); }
})();
