#!/usr/bin/env node
/**
 * FEAT-106 commit 2 — layout independence, the GATE side + must-FAIL baselines.
 *
 *   node scripts/verify-feat-106-layout-independence.mjs
 *
 * The HOOK's both-layout candidate loop is driven in
 * scripts/verify-bug-118-orchard-only-stop-hook.mjs (section H). This file owns
 * the two things that do not belong in the hook suite:
 *
 *   C-partial — `scripts/gate.mjs` resolves its sub-gates as SIBLINGS of itself,
 *     so it reaches all three (leak-gate, check-nul, typecheck) and reports each
 *     rather than crashing on a missing `ROOT/scripts/...`. Proven in Orchard's
 *     own tree AND in a genuine flat `.orchard/` scratch tree, with a non-vacuity
 *     case: remove a sibling and the gate must REPORT it FAIL, not skip it.
 *
 *   MUST-FAIL BASELINE — the SAME flat-layout fixtures run against the PRE-CHANGE
 *     files taken from `git show HEAD~…`, showing the old hook and old gate
 *     genuinely broke where the new ones hold. (In a clean room with no git
 *     history this degrades to SKIPPED, announced, never a silent pass.)
 *
 * Scratch under ORCHARD_SCRATCH (else the OS temp dir). No server, no port.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH?.trim() ? path.resolve(process.env.ORCHARD_SCRATCH) : os.tmpdir();
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'feat106-li-'));

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && observed !== undefined) console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function skip(name, why) { console.log(`  SKIP  ${name} — ${why}`); skipped++; }

const runGate = (gatePath, cwd) => {
  const r = spawnSync(process.execPath, [gatePath], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const reachesAllThree = (out) => /\bleak-gate\b/.test(out) && /\bcheck-nul\b/.test(out) && /\btypecheck\b/.test(out);

/** A flat `.orchard/` scratch tree that is its own git repo, holding the gate trio. */
function flatGateTree(name, { gateSrc, includeCheckNul = true } = {}) {
  const base = path.join(SCRATCH, name);
  const orch = path.join(base, '.orchard');
  fs.mkdirSync(orch, { recursive: true });
  fs.writeFileSync(path.join(orch, 'gate.mjs'), gateSrc ?? fs.readFileSync(path.join(ROOT, 'scripts', 'gate.mjs')));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'leak-gate.mjs'), path.join(orch, 'leak-gate.mjs'));
  if (includeCheckNul) fs.copyFileSync(path.join(ROOT, 'scripts', 'check-nul.mjs'), path.join(orch, 'check-nul.mjs'));
  fs.writeFileSync(path.join(base, 'README.md'), '# scratch flat tree\n'); // one clean tracked file
  // A real repo so leak-gate's REPO mode (git ls-files) has a tree to scan.
  execFileSync('git', ['init', '-q'], { cwd: base });
  execFileSync('git', ['add', '-A'], { cwd: base });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: base });
  return { base, orch, gate: path.join(orch, 'gate.mjs') };
}

// ── C1. Orchard's own tree: the gate reaches all three sub-gates ──────────────
console.log('\n=== C1. gate.mjs reaches all three sub-gates in Orchard\'s own tree ===');
{
  const r = runGate(path.join(ROOT, 'scripts', 'gate.mjs'), ROOT);
  check('C1 the real gate reports leak-gate, check-nul AND typecheck (sibling resolution intact here)',
    reachesAllThree(r.out), r.out.split('\n').filter((l) => /PASS|FAIL/.test(l)).slice(0, 6));
}

// ── C2. A genuine FLAT .orchard tree: the gate still reaches all three ─────────
console.log('\n=== C2. gate.mjs reaches all three from a flat .orchard/ layout ===');
{
  const { base, gate } = flatGateTree('flat-ok');
  const r = runGate(gate, base);
  check('C2 gate.mjs at .orchard/gate.mjs finds its siblings and reaches all three sub-gates',
    reachesAllThree(r.out), r.out.split('\n').filter((l) => /PASS|FAIL/.test(l)).slice(0, 6));
  check('C2b …and a clean flat tree PASSES (exit 0)', r.code === 0, { code: r.code });
}

// ── C3. NON-VACUITY: remove a sibling, the gate must REPORT it FAIL ────────────
console.log('\n=== C3. non-vacuity: a genuinely-absent sibling is caught, not skipped ===');
{
  const { base, gate } = flatGateTree('flat-missing', { includeCheckNul: false });
  const r = runGate(gate, base);
  check('C3 with check-nul.mjs absent, the gate reports check-nul FAIL and exits non-zero',
    r.code !== 0 && /FAIL\s+check-nul/.test(r.out), { code: r.code, tail: r.out.split('\n').filter((l) => /check-nul/.test(l)).slice(0, 3) });
}

// ── M. MUST-FAIL BASELINE against the PRE-CHANGE files (git HEAD~ / working) ───
console.log('\n=== M. must-FAIL: the PRE-CHANGE gate and hook break where the new ones hold ===');
/*
 * The pre-change files are the committed ones on HEAD (this stage has NOT
 * committed yet), so `git show HEAD:<path>` is the real "before". If git is
 * unavailable (clean room), each baseline is SKIPPED and said so.
 */
function gitShow(relPath) {
  try { return execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { return null; }
}

// M1 — the OLD gate (ROOT/scripts/leak-gate.mjs) cannot find its sub-gates when
// it lives at .orchard/gate.mjs: ROOT becomes the scratch root, which has no
// scripts/ dir, so every sub-gate spawn fails.
{
  const oldGate = gitShow('scripts/gate.mjs');
  if (!oldGate) {
    skip('M1 old gate breaks in a flat layout', 'git show HEAD:scripts/gate.mjs unavailable');
  } else if (/path\.join\(HERE, 'leak-gate\.mjs'\)/.test(oldGate)) {
    skip('M1 old gate breaks in a flat layout', 'HEAD already carries the sibling fix (nothing older to contrast)');
  } else {
    const { base, gate } = flatGateTree('flat-oldgate', { gateSrc: oldGate });
    const r = runGate(gate, base);
    // The old gate resolves ROOT/scripts/leak-gate.mjs — absent here — so it does
    // NOT reach a real leak scan: it reports the sub-gates as failing/unreachable.
    check('M1 the PRE-CHANGE gate FAILS to run its sub-gates from a flat layout (the defect the sibling fix removes)',
      r.code !== 0 && !/PASS\s+leak-gate/.test(r.out), { code: r.code, out: r.out.split('\n').filter((l) => /leak-gate|Error|ENOENT|Cannot find/.test(l)).slice(0, 4) });
  }
}

// M2 — the OLD hook (direct import '../../public/lib/digest.js') cannot grade in
// a flat layout: there is no public/ there, so it records deps-digest-unloadable
// and stays silent — the exact invisible failure the candidate loop prevents.
{
  const oldHook = gitShow('scripts/hooks/response-format-gate.mjs');
  if (!oldHook) {
    skip('M2 old hook goes inert in a flat layout', 'git show HEAD:scripts/hooks/... unavailable');
  } else if (/importFirst\(\[/.test(oldHook)) {
    skip('M2 old hook goes inert in a flat layout', 'HEAD already carries the candidate loop');
  } else {
    // Build a flat mirror: hook at hooks/, all STATIC deps + grading closure in a
    // flat lib/, NO public/. The NEW hook grades here (proven in bug-118 §H); the
    // OLD hook, importing ../../public/lib, cannot.
    const base = path.join(SCRATCH, 'flat-oldhook');
    const hooks = path.join(base, 'hooks');
    const lib = path.join(base, 'lib');
    fs.mkdirSync(hooks, { recursive: true });
    fs.mkdirSync(lib, { recursive: true });
    for (const rel of [['scripts', 'lib', 'readability.mjs'], ['scripts', 'lib', 'structure.mjs'], ['scripts', 'lib', 'format-metrics.mjs'],
      ['public', 'lib', 'digest.js'], ['public', 'lib', 'dom.js'], ['public', 'lib', 'route.js'], ['public', 'lib', 'response-blocks.js']]) {
      try { fs.symlinkSync(path.join(ROOT, ...rel), path.join(lib, rel[rel.length - 1])); } catch { /* exists */ }
    }
    const hookPath = path.join(hooks, 'response-format-gate.mjs');
    fs.writeFileSync(hookPath, oldHook);
    const SID = 'c8e843c1-fd74-4225-a06a-00ab7a0dbe83';
    const tp = path.join(base, 't.jsonl');
    fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'no digest here, just prose about the sky being blue and scattering.' }] } }) + '\n');
    const data = path.join(base, 'data');
    const payload = { session_id: SID, transcript_path: tp, cwd: base, hook_event_name: 'Stop', stop_hook_active: false };
    const r = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, ORCHARD_SESSION: SID, CLAUDE_STATION_DATA: data, ORCHARD_STOP_HOOK_ENFORCE: '' },
    });
    let recs = [];
    try { recs = fs.readFileSync(path.join(data, 'logs', 'stop-hook-advisory.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    const silent = r.status === 0 && !(r.stdout || '').trim();
    const depsUnloadable = recs.some((x) => x?.verdict === 'deps-digest-unloadable' || x?.verdict === 'deps-digest-incompatible');
    check('M2 the PRE-CHANGE hook goes INERT in a flat layout (silent + deps-digest-* record) — the defect the candidate loop removes',
      silent && depsUnloadable, { silent, verdicts: recs.map((x) => x?.verdict) });
  }
}

// ── cleanup + summary ─────────────────────────────────────────────────────────
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed, ${skipped} skipped`);
if (failures.length) console.log('  failed:', failures.join(' | '));
process.exit(fail === 0 ? 0 : 1);
