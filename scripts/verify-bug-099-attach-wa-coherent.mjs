/**
 * BUG-099 — the Wiring panel's one-click attach-WA must attach the COHERENT
 * stack (v1 base FIRST, then v2 extension), not v2 alone, and the CHECK side
 * must report a v2-only stack as PARTIAL, not ✅.
 *
 *   node scripts/verify-bug-099-attach-wa-coherent.mjs
 *
 * One scratch station server (OS-assigned free port, scratch dataDir — NEVER
 * :4317, never the real registry). Fixtures are real registered projects on
 * real temp dirs.
 *
 * The decisive assertion is (2): the COMPOSED system prompt for a
 * freshly-attached project must carry v1-only markers ("### 2. Evidence over
 * narrative", "The final report"). Pre-fix those markers are ABSENT because only
 * v2 is attached — that absence is the actual harm the ticket describes.
 *
 * MUST-FAIL pre-fix (each labelled below):
 *   (1c) only `working-agreement-v2` is attached → BOTH-refs assertion fails.
 *   (2)  v1-only markers absent from the composed prompt → decisive assertion fails.
 *   (5)  a v2-only fixture reports the Working Agreement as ✅ (state 'ok') →
 *        the partial-report assertion fails.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { composeInstructions } from '../src/server/templates.ts';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG099_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug099-data-'));
// Point THIS process's template store at the same scratch data dir the server
// seeds into, so the in-process composeInstructions() below reads the same
// seeded WA template bodies the server does.
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function req(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const fixtures = [];
function mkfix(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug099-${kind}-`));
  fixtures.push(dir);
  return dir;
}
const stateOf = (wiring, key) => wiring?.checks?.find((c) => c.key === key)?.state;
const refsOf = (project) => project?.settings?.instructions ?? [];

async function main() {
  /* ---- FRESH fixture: a real project with an empty instruction stack ---- */
  const freshDir = mkfix('fresh');
  fs.writeFileSync(path.join(freshDir, 'package.json'),
    JSON.stringify({ name: 'fresh-fixture', version: '1.0.0' }, null, 2) + '\n');
  // No CLAUDE.md pointer — exercises the REF arm, not the pointer fallback.

  /* ---- V2ONLY fixture: the incoherent half-applied state the ticket names ---- */
  const v2Dir = mkfix('v2only');
  fs.writeFileSync(path.join(v2Dir, 'package.json'),
    JSON.stringify({ name: 'v2only-fixture', version: '1.0.0' }, null, 2) + '\n');

  /* ---- REALISTIC fixture: a busy stack with other refs already attached ---- */
  const busyDir = mkfix('busy');
  fs.writeFileSync(path.join(busyDir, 'package.json'),
    JSON.stringify({ name: 'busy-fixture', version: '1.0.0' }, null, 2) + '\n');

  /* ---- boot the scratch server (never :4317) ---- */
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  // applyMethod:false (FEAT-089): this suite tests the attach-wa REPAIR path, so
  // fixtures must start in their chosen bare / v2-only / busy states — not with
  // the coherent WA auto-attached on add. Auto-apply-on-add is covered by
  // verify-feat-089-method-auto.mjs.
  const fresh = (await req('POST', '/api/projects', { hostPath: freshDir, name: 'fresh-fixture', applyMethod: false })).body?.project;
  const v2only = (await req('POST', '/api/projects', { hostPath: v2Dir, name: 'v2only-fixture', applyMethod: false })).body?.project;
  const busy = (await req('POST', '/api/projects', { hostPath: busyDir, name: 'busy-fixture', applyMethod: false })).body?.project;
  check('fixtures registered as real projects', !!(fresh && v2only && busy),
    { fresh: fresh?.id, v2only: v2only?.id, busy: busy?.id });

  /* ================= (1) attach-wa on a fresh empty stack ================== */
  console.log('\n=== (1) attach-wa on instructions:[] → COHERENT stack (base first) ===');
  check('(1-pre) fresh fixture starts with an empty instruction stack', refsOf(fresh).length === 0, refsOf(fresh));
  const apply1 = await req('POST', `/api/projects/${fresh.id}/wiring/apply`, { check: 'attach-wa' });
  check('(1a) apply attach-wa → 200 with fresh wiring', apply1.status === 200 && !!apply1.body?.wiring,
    { status: apply1.status, applied: apply1.body?.applied });
  const freshAfter = (await req('GET', `/api/projects/${fresh.id}`)).body?.project;
  const refs1 = refsOf(freshAfter);
  const enabledIds1 = refs1.filter((r) => r.enabled !== false).map((r) => r.templateId);
  check('(1b) BOTH working-agreement AND working-agreement-v2 refs present & enabled',
    enabledIds1.includes('working-agreement') && enabledIds1.includes('working-agreement-v2'), enabledIds1);
  const iBase = refs1.findIndex((r) => r.templateId === 'working-agreement');
  const iExt = refs1.findIndex((r) => r.templateId === 'working-agreement-v2');
  // MUST-FAIL pre-fix: pre-fix only working-agreement-v2 is attached → iBase === -1.
  check('(1c) base (v1) is present AND ordered BEFORE the extension (v2) [must-FAIL pre-fix]',
    iBase !== -1 && iExt !== -1 && iBase < iExt, { iBase, iExt, refs: refs1.map((r) => r.templateId) });
  check('(1d) the WA check now reports ✅ (coherent)', stateOf(apply1.body?.wiring, 'working-agreement') === 'ok',
    stateOf(apply1.body?.wiring, 'working-agreement'));

  /* ============ (2) DECISIVE: composed prompt carries v1-only markers ====== */
  console.log('\n=== (2) DECISIVE: composeInstructions carries the v1-only core ===');
  const composed = composeInstructions(refs1);
  const prompt = typeof composed.systemPrompt === 'string'
    ? composed.systemPrompt
    : (composed.systemPrompt?.append ?? '');
  // These markers live ONLY in v1. Pre-fix (v2-only) they are ABSENT — the harm.
  check('(2a) composed prompt contains "### 2. Evidence over narrative" (v1 core) [must-FAIL pre-fix]',
    prompt.includes('### 2. Evidence over narrative'), prompt.includes('### 2. Evidence over narrative'));
  check('(2b) composed prompt contains "The final report" (v1 core) [must-FAIL pre-fix]',
    /final report/i.test(prompt), /final report/i.test(prompt));
  check('(2c) composed prompt ALSO contains a v2 section marker (extension present too)',
    prompt.includes('Working Agreement v2') || prompt.includes('Everything in v1, plus'),
    prompt.includes('Working Agreement v2'));
  const v1Marker = prompt.indexOf('### 1. Definition of done'); // unique to v1
  const v2Marker = prompt.indexOf('Everything in v1, plus');     // unique to v2
  check('(2d) v1 section appears BEFORE v2 in the composed prompt (base first)',
    v1Marker !== -1 && v2Marker !== -1 && v1Marker < v2Marker, { v1Marker, v2Marker });
  check('(2e) both WA template ids resolved (no missing template)', composed.missingIds.length === 0, composed.missingIds);

  /* ================= (3) idempotency: apply twice, no duplicates =========== */
  console.log('\n=== (3) idempotency: a second apply does not duplicate refs ===');
  await req('POST', `/api/projects/${fresh.id}/wiring/apply`, { check: 'attach-wa' });
  const freshTwice = (await req('GET', `/api/projects/${fresh.id}`)).body?.project;
  const refs2 = refsOf(freshTwice);
  const baseCount = refs2.filter((r) => r.templateId === 'working-agreement').length;
  const extCount = refs2.filter((r) => r.templateId === 'working-agreement-v2').length;
  check('(3a) exactly one base ref and one extension ref after a double apply',
    baseCount === 1 && extCount === 1, { baseCount, extCount, refs: refs2.map((r) => r.templateId) });

  /* ================= (4) REPAIR a v2-only stack ============================ */
  console.log('\n=== (4) repair: a v2-only stack gains v1 (base first), other refs intact ===');
  // Seed the v2only fixture with ONLY v2, plus an unrelated ref to prove it is
  // not disturbed. Use the validated PATCH path (the real seam).
  await req('PATCH', `/api/projects/${v2only.id}`, {
    settings: { instructions: [
      { templateId: 'pattern-manager-subagent-tree', enabled: true },
      { templateId: 'working-agreement-v2', enabled: true },
    ] },
  });
  const v2before = (await req('GET', `/api/projects/${v2only.id}`)).body?.project;
  check('(4-pre) v2only fixture has v2 but NOT v1',
    refsOf(v2before).some((r) => r.templateId === 'working-agreement-v2')
    && !refsOf(v2before).some((r) => r.templateId === 'working-agreement'),
    refsOf(v2before).map((r) => r.templateId));
  const repair = await req('POST', `/api/projects/${v2only.id}/wiring/apply`, { check: 'attach-wa' });
  const v2after = (await req('GET', `/api/projects/${v2only.id}`)).body?.project;
  const rRefs = refsOf(v2after);
  const rBase = rRefs.findIndex((r) => r.templateId === 'working-agreement');
  const rExt = rRefs.findIndex((r) => r.templateId === 'working-agreement-v2');
  check('(4a) repair added v1, ordered before v2', rBase !== -1 && rExt !== -1 && rBase < rExt,
    { rBase, rExt, refs: rRefs.map((r) => r.templateId) });
  check('(4b) the unrelated ref was NOT disturbed',
    rRefs.some((r) => r.templateId === 'pattern-manager-subagent-tree' && r.enabled !== false),
    rRefs.map((r) => r.templateId));
  check('(4c) no duplicate v2 ref introduced by the repair',
    rRefs.filter((r) => r.templateId === 'working-agreement-v2').length === 1,
    rRefs.map((r) => r.templateId));
  check('(4d) repair flips the WA check to ✅', stateOf(repair.body?.wiring, 'working-agreement') === 'ok',
    stateOf(repair.body?.wiring, 'working-agreement'));

  /* ================= (5) CHECK side: v2-only reports PARTIAL, not ✅ ======== */
  console.log('\n=== (5) check side: a v2-only stack is a warning, not ✅ [must-FAIL pre-fix] ===');
  // A fresh busy fixture in the exact incoherent state, read WITHOUT repairing.
  await req('PATCH', `/api/projects/${busy.id}`, {
    settings: { instructions: [{ templateId: 'working-agreement-v2', enabled: true }] },
  });
  const busyWiring = (await req('GET', `/api/projects/${busy.id}/wiring`)).body?.wiring;
  const waRow = busyWiring?.checks?.find((c) => c.key === 'working-agreement');
  // MUST-FAIL pre-fix: hasEnabledWaRef treats any WA ref as satisfied → state 'ok'.
  check('(5a) v2-only WA check does NOT report fully-satisfied (state !== "ok") [must-FAIL pre-fix]',
    waRow?.state !== 'ok', waRow?.state);
  check('(5b) v2-only WA check surfaces as a partial with a repair Apply action',
    waRow?.state === 'warn' && waRow?.apply === 'attach-wa', { state: waRow?.state, apply: waRow?.apply });
  check('(5c) the detail names the missing base and the dropped core',
    /base/i.test(waRow?.detail || '') && /(final report|definition of done|evidence)/i.test(waRow?.detail || ''),
    waRow?.detail);

  /* ================= (6) pointer path still works as today ================= */
  console.log('\n=== (6) CLAUDE.md pointer arm still satisfies when there is no ref ===');
  const ptrDir = mkfix('pointer');
  fs.writeFileSync(path.join(ptrDir, 'CLAUDE.md'), '# ptr\n\nread docs/prompts/WORKING_AGREEMENT.md\n');
  // applyMethod:false: assert the CLAUDE.md POINTER arm in isolation (no
  // attached ref), which the auto-attach would otherwise mask.
  const ptr = (await req('POST', '/api/projects', { hostPath: ptrDir, name: 'pointer-fixture', applyMethod: false })).body?.project;
  const ptrWiring = (await req('GET', `/api/projects/${ptr.id}/wiring`)).body?.wiring;
  check('(6a) a pointer-only project (no ref) still reports WA ✅', stateOf(ptrWiring, 'working-agreement') === 'ok',
    stateOf(ptrWiring, 'working-agreement'));
}

main()
  .catch((err) => { console.error('\nverify-bug-099: FATAL', err); fail++; })
  .finally(() => {
    stopByPid(server);
    for (const dir of fixtures) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\nBUG-099 attach-wa coherence — ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
    process.exit(0);
  });
