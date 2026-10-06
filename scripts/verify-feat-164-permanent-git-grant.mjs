#!/usr/bin/env node
/**
 * verify-feat-164-permanent-git-grant.mjs — FEAT-164: a PERMANENT, per-project,
 * revocable agent git-write grant, declared as a project setting and honoured by
 * the ONE existing grant check (peekGrant → evaluateGitWrite).
 *
 *   node scripts/verify-feat-164-permanent-git-grant.mjs
 *
 * Part A (in-process, the enforcement path). The real registry module over a
 * SCRATCH CLAUDE_STATION_DATA, the real store, the real evaluateGitWrite that
 * both the runtime PreToolUse hook and the git-shim decide route call. The leak
 * gate is a stub here (its real run is covered by verify-feat-108-git-grant);
 * what is graded is the grant decision and that the gate is still REQUIRED.
 *
 * Part B (HTTP, an ISOLATED scratch server: own CLAUDE_STATION_DATA, free port,
 * never the live service). The grant route writes the setting; GET reads it back
 * through grantView; a restart keeps it; the generic settings PATCH cannot set it
 * and does not drop it; the 30-minute grant still works.
 *
 * MUST-FAIL on the pre-change tree: registry.ts has no setGitWritePermanent /
 * gitWritePermanentOf, the store has no setPermanentGrantSource, and the route
 * coerces scope 'permanent' to 'once' — Part A throws at import, Part B's
 * permanent assertions fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164a-data-'));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164b-data-'));
// Plain project dirs: the grant decision does not depend on the dir being a repo
// (the leak gate, which does, is stubbed in Part A and never reached in Part B).
// No fixture repo is created: an agent lane's PATH carries the FEAT-135 shim,
// which refuses repo-creating commands, and bypassing it would defeat its point.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164-proj-'));
const REPO2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164-proj2-'));
fs.writeFileSync(path.join(REPO, 'README.md'), 'fixture\n');
const cleanup = [DATA_A, DATA_B, REPO, REPO2];

const COMMIT = ['git', 'commit', '-m', 'x'].join(' ');
const gateOK = () => ({ ok: true, detail: '' });
const gateFAIL = () => ({ ok: false, detail: 'LEAK GATE: FAIL — 1 hit' });

/* ═══ Part A — enforcement, in-process ═══════════════════════════════════════ */
console.log('\n[A] enforcement path (registry → store → evaluateGitWrite)');
process.env.CLAUDE_STATION_DATA = DATA_A;
const reg = await import('../src/server/registry.ts');
const store = await import('./lib/git-grant-store.mjs');
const { evaluateGitWrite } = await import('./lib/git-grant.mjs');

check('A0 registry exposes the single writer + reader', typeof reg.setGitWritePermanent === 'function' && typeof reg.gitWritePermanentOf === 'function');
check('A0 store exposes setPermanentGrantSource', typeof store.setPermanentGrantSource === 'function');

const pA = reg.createProject({ hostPath: REPO, isolation: 'direct' });
const pB = reg.createProject({ hostPath: REPO2, isolation: 'direct' });
store._resetGitGrantsForTest();
// The SAME wiring index.ts installs at boot.
store.setPermanentGrantSource(reg.gitWritePermanentOf);
const ev = (key, gate = gateOK) => evaluateGitWrite({ command: COMMIT, projectKey: key, env: {}, runLeakGate: gate });

check('A1 no grant → agent commit DENIED', ev(pA.id).allow === false);
reg.setGitWritePermanent(pA.id, true, { via: 'dashboard' });
const rowA = JSON.parse(fs.readFileSync(path.join(DATA_A, 'registry.json'), 'utf8')).projects.find((p) => p.id === pA.id);
check('A2 permanent grant is stored ONCE, as the project setting', rowA?.settings?.gitWrite?.permanent === true, rowA?.settings?.gitWrite);
const r3 = ev(pA.id);
check('A3 permanent grant → agent commit ALLOWED, scope=permanent', r3.allow === true && r3.granted === true && r3.grant?.scope === 'permanent', { allow: r3.allow, scope: r3.grant?.scope });
check('A4 permanent grant does NOT lift the leak gate (gate FAIL → denied)', (() => { const r = ev(pA.id, gateFAIL); return r.allow === false && r.gateFailed === true; })());
check('A5 permanent grant has NO runner → fails closed', evaluateGitWrite({ command: COMMIT, projectKey: pA.id, env: {} }).allow === false);
check('A6 per-project: a permanent grant on A does not allow B', ev(pB.id).allow === false);
let many = true; for (let i = 0; i < 25; i++) many = many && ev(pA.id).allow === true;
check('A7 permanent grant is not use-bounded (25 writes in a row allowed)', many);
check('A8 grantView reports scope permanent, no expiry', (() => { const g = store.grantView(pA.id); return g?.scope === 'permanent' && g.expiresAt === null; })(), store.grantView(pA.id));

// A "running session": the same key keeps calling between grant changes. Revoke
// must bite on the NEXT write, no relaunch.
store.grantGitWrite(pA.id, { scope: 'once' });
check('A9 a once-grant under a permanent grant is NOT spent by permanent writes', (() => { ev(pA.id); ev(pA.id); return store.permanentGrantOf(pA.id) && store.grantView(pA.id)?.scope === 'permanent'; })());
reg.setGitWritePermanent(pA.id, false, { via: 'dashboard' });
check('A10 after revoking permanent, the surviving once-grant permits exactly one more write', ev(pA.id).allow === true && ev(pA.id).allow === false);
check('A11 revoked: running session\'s next commit DENIED', ev(pA.id).allow === false);
store.grantGitWrite(pA.id, { scope: 'duration', ttlMs: 30 * 60_000 });
const r12 = ev(pA.id);
check('A12 30-minute grant still works alone (scope=duration, ~30m left)', r12.allow === true && r12.grant?.scope === 'duration' && r12.grant.expiresInMs > 29 * 60_000, r12.grant);
store.revokeGitWrite(pA.id);
check('A13 revoking the timed grant re-blocks', ev(pA.id).allow === false);

// FEAT-164 r2 — ONE DECISION, ONE INSTANT. The round-1 independent verify (run
// 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9) revoked permanent DURING the leak-gate
// callback with an independent once-grant active; consumeGrant re-read permanent
// (now false) and spent the once-grant. Same probe, through the real writer.
reg.setGitWritePermanent(pA.id, true, { via: 'dashboard' });
store.grantGitWrite(pA.id, { scope: 'once' });
const rRace = ev(pA.id, () => { reg.setGitWritePermanent(pA.id, false, { via: 'dashboard' }); return gateOK(); });
// FEAT-164 r4 — the store is the only authority, asked at the write: a revoke landing
// mid-gate DENIES the write decided before it (r3 let it through).
check('A13a race: the write decided under permanent is DENIED by a mid-gate revoke (r4: revocation wins)', rRace.allow === false, { allow: rRace.allow, scope: rRace.grant?.scope });
check('A13b race: a permanent revoke mid-gate does NOT spend the independent once-grant', store.grantView(pA.id)?.scope === 'once' && store.grantView(pA.id)?.remainingUses === 1, store.grantView(pA.id));
check('A13c race: that once-grant then permits exactly one more write', ev(pA.id).allow === true && ev(pA.id).allow === false);
// Replacement: the once-grant a decision read is revoked and a NEW one granted
// mid-gate. The decision must not spend the replacement.
store.grantGitWrite(pA.id, { scope: 'once' });
const rRepl = ev(pA.id, () => { store.revokeGitWrite(pA.id); store.grantGitWrite(pA.id, { scope: 'once' }); return gateOK(); });
check('A13d replaced mid-gate: the write is denied (r4) and the NEW once-grant is left unspent', rRepl.allow === false && store.grantView(pA.id)?.remainingUses === 1, store.grantView(pA.id));
store.revokeGitWrite(pA.id);
store.grantGitWrite(pA.id, { scope: 'once' });
check('A13e a failed gate spends nothing', ev(pA.id, gateFAIL).allow === false && store.grantView(pA.id)?.remainingUses === 1);
store.revokeGitWrite(pA.id);
// FEAT-164 r3 — peek/consume are gone; the one authority is claimGrant → settleClaim.
check('A13f the decide/spend split is gone: no peekGrant/consumeGrant export', !('peekGrant' in store) && !('consumeGrant' in store));
let threw = false; try { store.settleClaim({ scope: 'once', view: {} }, 'commit'); } catch { threw = true; }
check('A13f settleClaim refuses an object it did not mint (a forged claim)', threw);

// Fail-closed shapes of the declared setting. Driven onto the real registry file.
const regFile = path.join(DATA_A, 'registry.json');
const real = fs.readFileSync(regFile, 'utf8');
const withSetting = (v) => { const j = JSON.parse(real); j.projects.find((p) => p.id === pA.id).settings.gitWrite = v; fs.writeFileSync(regFile, JSON.stringify(j)); };
withSetting({ permanent: 'yes' });
check('A14 a non-boolean permanent ("yes") grants nothing', ev(pA.id).allow === false);
withSetting(null);
check('A15 gitWrite:null grants nothing', ev(pA.id).allow === false);
withSetting({ permanent: true, grantedAt: '2026-10-05T00:00:00.000Z' });
check('A16 control: a well-formed setting grants', ev(pA.id).allow === true);
// The registry file is replaced atomically by its writer, but a hand edit or a
// torn copy is possible; a read of a TRUNCATED file must fail CLOSED, not throw
// out of the hook and not grant.
const full = fs.readFileSync(regFile, 'utf8');
let truncOk = true; const cuts = [1, 10, Math.floor(full.length / 3), Math.floor(full.length / 2), full.length - 2];
for (const cut of cuts) {
  fs.writeFileSync(regFile, full.slice(0, cut));
  let r; try { r = ev(pA.id); } catch (e) { r = { threw: e.message }; }
  if (r.allow !== false) { truncOk = false; console.log(`        truncated at ${cut}: ${JSON.stringify(r)}`); }
}
fs.writeFileSync(regFile, full);
check(`A17 truncated registry (${cuts.length} cut points) → DENIED, never throws`, truncOk);
store.setPermanentGrantSource(() => { throw new Error('boom'); });
check('A18 a throwing source fails closed', ev(pA.id).allow === false);
store.setPermanentGrantSource(null);
check('A19 no source registered → permanent setting ignored (fail closed)', ev(pA.id).allow === false);
store.setPermanentGrantSource(reg.gitWritePermanentOf);
// The generic settings PATCH validator must refuse the key: the grant route is the
// one writer of this fact.
const { validateProjectPatch } = await import('../src/server/validate.ts');
let refused = false; try { validateProjectPatch({ gitWrite: { permanent: true } }); } catch { refused = true; }
check('A20 generic settings PATCH refuses gitWrite (one writer: the grant route)', refused);
// A generic PATCH of another setting keeps the declared grant.
reg.updateProject(pA.id, validateProjectPatch({ model: 'claude-opus-5' }));
check('A21 an unrelated settings PATCH does not drop the permanent grant', ev(pA.id).allow === true);
reg.setGitWritePermanent(pA.id, false);
store._resetGitGrantsForTest();

/* ═══ Part B — HTTP against an isolated scratch server ═══════════════════════ */
console.log('\n[B] grant route on an isolated scratch server');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA_B });
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`scratch server did not come up:\n${log.slice(-2000)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([done, sleep(5000)]);
  try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
}
const j = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
};
try {
  await boot();
  // applyMethod:false — registration must not onboard (write scaffold into) the dir.
  const created = await j('POST', '/api/projects', { hostPath: REPO, isolation: 'direct', applyMethod: false });
  const pid = created.d?.project?.id ?? created.d?.id;
  check('B0 project registered on the scratch server', created.status < 300 && !!pid, created.status);
  const gw = `/api/projects/${encodeURIComponent(pid)}/git-write-grant`;
  check('B1 GET: no grant initially', (await j('GET', gw)).d?.grant === null);
  const g30 = await j('POST', gw, { scope: 'duration', minutes: 30 });
  check('B2 30-minute grant via the route (scope duration, ~30m)', g30.d?.grant?.scope === 'duration' && g30.d.grant.expiresInMs > 29 * 60_000, g30.d?.grant);
  const perm = await j('POST', gw, { scope: 'permanent' });
  check('B3 permanent grant via the route (scope permanent, no expiry)', perm.status === 200 && perm.d?.grant?.scope === 'permanent' && perm.d.grant.expiresAt === null, perm.d);
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_B, 'registry.json'), 'utf8')).projects.find((p) => p.id === pid);
  check('B4 stored as the declared project setting', onDisk?.settings?.gitWrite?.permanent === true && onDisk.settings.gitWrite.grantedVia === 'dashboard', onDisk?.settings?.gitWrite);
  const patch = await j('PATCH', `/api/projects/${encodeURIComponent(pid)}`, { gitWrite: { permanent: false } });
  check('B5 generic PATCH cannot touch it (400)', patch.status === 400, patch);
  await stop(); await boot();
  const after = await j('GET', gw);
  check('B6 survives a server restart (it is permanent)', after.d?.grant?.scope === 'permanent', after.d?.grant);
  const del = await j('DELETE', gw);
  check('B7 DELETE revokes it (and reports it was active)', del.d?.revoked === true && del.d?.grant === null, del.d);
  const onDisk2 = JSON.parse(fs.readFileSync(path.join(DATA_B, 'registry.json'), 'utf8')).projects.find((p) => p.id === pid);
  check('B8 setting cleared in the registry', !onDisk2?.settings?.gitWrite?.permanent, onDisk2?.settings?.gitWrite);
  check('B9 GET: no grant after revoke', (await j('GET', gw)).d?.grant === null);
  const sessions = await j('GET', '/api/sessions');
  check('B10 server still serves sessions list (grantView in the list path does not throw)', sessions.status === 200, sessions.status);
} catch (e) {
  check(`B threw: ${e.message}`, false);
} finally {
  await stop();
}

for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nFEAT-164: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
