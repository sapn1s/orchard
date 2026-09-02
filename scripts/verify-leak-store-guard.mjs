#!/usr/bin/env node
/**
 * verify-leak-store-guard.mjs — the fixture-pollutes-reality guard.
 *
 * Verification suites spawn `claude` sessions whose transcripts land in
 * `<CLAUDE_CONFIG_DIR else ~/.claude>/projects/<encoded-cwd>/`. Isolating only
 * `CLAUDE_STATION_DATA` (the station's own data dir) leaves that store on the
 * user's REAL ~/.claude/projects, so every probe pollutes their history — the
 * largest source of junk sessions in the store.
 *
 * `assertSessionStoreIsolated` (src/lib/paths.ts) refuses a real-store write
 * unless it is the sanctioned production server in normal (shared-data) mode.
 * This grades the decision matrix directly — no model calls, safe in the gate.
 *
 * The must-FAIL-before / stops-after / auth-still-works proof against a REAL
 * session lives in scratch (scripts referenced in the BUG ticket); this file is
 * the deterministic anti-regression.
 */
import os from 'node:os';
import path from 'node:path';
import {
  claudeStoreDir, realClaudeStoreDir, assertSessionStoreIsolated,
  markSanctionedRealStoreWriter, isSanctionedRealStoreWriter,
} from '../src/lib/paths.ts';

const REAL = path.join(os.homedir(), '.claude', 'projects');
const SCRATCH_CFG = path.join(os.homedir(), 'scratch', 'guard-cfg');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// --- store resolution ---
check('claudeStoreDir → real store when CLAUDE_CONFIG_DIR unset',
  claudeStoreDir({}) === REAL, claudeStoreDir({}));
check('claudeStoreDir → <CLAUDE_CONFIG_DIR>/projects when set',
  claudeStoreDir({ CLAUDE_CONFIG_DIR: SCRATCH_CFG }) === path.join(SCRATCH_CFG, 'projects'));
check('CLAUDE_PROJECTS_DIR does NOT move the CLI writer (reader-only knob)',
  claudeStoreDir({ CLAUDE_PROJECTS_DIR: '/some/scratch/projects' }) === REAL,
  'setting only CLAUDE_PROJECTS_DIR must still resolve the writer to the real store');
check('realClaudeStoreDir ignores overrides',
  realClaudeStoreDir({ CLAUDE_CONFIG_DIR: SCRATCH_CFG }) === REAL);

// --- guard matrix (marker starts UNSET in this fresh process) ---
check('precondition: this process is not yet the sanctioned server', isSanctionedRealStoreWriter() === false);

// A) isolated DATA, real store, unmarked → REFUSE (the classic half-isolated harness)
check('A: isolated DATA + real store → refuses loudly',
  throws(() => assertSessionStoreIsolated({ CLAUDE_STATION_DATA: '/scratch/data' }, { label: 'A' }))?.includes('REFUSING'));

// A2) the wrong-var trap: CLAUDE_PROJECTS_DIR set (reader only) but writer still real → REFUSE, and say so
{
  const msg = throws(() => assertSessionStoreIsolated(
    { CLAUDE_STATION_DATA: '/scratch/data', CLAUDE_PROJECTS_DIR: '/scratch/store/projects' }, { label: 'A2' }));
  check('A2: CLAUDE_PROJECTS_DIR-only isolation is refused (the wrong-var trap)', msg?.includes('REFUSING'));
  check('A2: the refusal names CLAUDE_PROJECTS_DIR as reader-only, not isolation',
    !!msg && /only steers Orchard's reader/.test(msg), msg?.slice(0, 120));
}

// B) e2e shape: shared DATA (nothing isolated), real store, unmarked → REFUSE
check('B: unmarked in-process harness + real store → refuses (catches e2e that isolates nothing)',
  throws(() => assertSessionStoreIsolated({}, { label: 'B' }))?.includes('not the production station server'));

// C) isolated store → always fine, regardless of anything else
check('C: isolated CLAUDE_CONFIG_DIR → allowed (no throw)',
  throws(() => assertSessionStoreIsolated({ CLAUDE_STATION_DATA: '/scratch/data', CLAUDE_CONFIG_DIR: SCRATCH_CFG })) === null);
check('C2: isolated store allowed even for the production server',
  throws(() => { markSanctionedRealStoreWriter(); assertSessionStoreIsolated({ CLAUDE_CONFIG_DIR: SCRATCH_CFG }); }) === null);

// D) production server: marked + shared DATA + real store → allowed (the user's real work)
check('D: sanctioned server + shared DATA + real store → allowed',
  isSanctionedRealStoreWriter() && throws(() => assertSessionStoreIsolated({})) === null);

// E) marked but isolated DATA + real store → STILL refused (a test server subprocess that forgot store isolation)
check('E: sanctioned marker does NOT excuse an isolated-DATA server writing the real store',
  throws(() => assertSessionStoreIsolated({ CLAUDE_STATION_DATA: '/scratch/data' }, { label: 'E' }))?.includes('REFUSING'));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
