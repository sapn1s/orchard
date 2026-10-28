#!/usr/bin/env node
/**
 * FEAT-200 — unit proofs for container ACCESS requests, against fakes: no docker, no server.
 * The end-to-end proof (a real container in the FEAT-158 sandbox) is verify-feat-200-access-requests.mjs.
 *
 *   node scripts/verify-feat-200-access-unit.mjs [--tree <dir>]
 *
 * Sections:
 *   R  the FEAT-175 reconciler with the access level read: stale recreates only when idle, never under a busy
 *      turn, never holds turns; unknown never recreates; the entry drops once clean; failed downgrade rules.
 *   S  the typed store: decided once; approved-pending → committed | not applied (r5); a frozen resume text is
 *      never replaced; a torn store is quarantined, never overwritten.
 *   C  the inbox reader on HOSTILE files: symlink, FIFO, oversize, truncated (young → retried, old → refused),
 *      a reply never follows or overwrites a planted file.
 *   P  request parsing: env through the settings validator, ports loopback-only, no-ops dropped, unknown
 *      fields refused; port collisions from another project / container / host listener.
 *   Q  resume texts and the level-based checker: reject sends at once; approve waits while drift is not clean;
 *      the frozen text is re-used under the same nonce after a failed enqueue.
 *   V  (c) after the r3 design review: docker's refusal wordings parsed; an IPv6-only listener is in use; a refused
 *      approved-pending request FAILS (r5: nothing written, nothing reverted) and is frozen "approved, but could not
 *      be applied"; r6: a user edit of a named key/port cancels (edit versions, not values); no container →
 *      create first (backed off), never "granted" first; a failed access-only rebuild never holds turns.
 *
 * Synthetic by necessity (the units have no real artifact); the e2e suite exercises the real ones.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const argTree = process.argv.indexOf('--tree');
const ROOT = argTree > 0 ? path.resolve(process.argv[argTree + 1]) : path.resolve(HERE, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-unit-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
// FEAT-200 r8: a request is read against the project row it was raised for (a request whose project row is missing is
// "removed"), so the store sections' projects exist in the scratch registry (created before any request is raised).
{
  const at = new Date(Date.now() - 60_000).toISOString();
  const row = (id) => ({ id, name: id.toUpperCase(), hostPath: DATA, isolation: 'container', settings: { model: null, effort: null, claudeAccount: null, maxBudgetUsd: null, permissionMode: 'default', allowedTools: [], disallowedTools: [], mounts: [], instructions: [], container: { gpu: 'off', env: {}, ports: [] } }, createdAt: at, updatedAt: at });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: ['p', 'fp', 'fq', 'qp', 'vp'].map(row) }, null, 2));
}

let pass = 0, fail = 0;
function check(name, ok, observed) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}
const need = (rel) => { const f = path.join(ROOT, rel); if (!fs.existsSync(f)) { check(`${rel} exists in the tree under test`, false, f); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); } return url.pathToFileURL(f).href; };
const { createGrantRebuild } = await import(need('src/server/grant-rebuild.ts'));
const acc = await import(need('src/server/access-requests.ts'));
const ch = await import(need('src/server/access-channel.ts'));
const regTop = await import(need('src/server/registry.ts'));
/**
 * FEAT-200 r7/r8 contract: "committed" is written by the commit's ONE registry save (the project row's accessCommitted),
 * and every reader — markCommitted's own backstop included — reads it from the REAL registry row. Stubs commit here.
 */
const commitInRegistry = (pid, ids) => { const cur = regTop.getProject(pid)?.accessCommitted ?? []; regTop.updateProject(pid, {}, { accessCommit: true, committed: [...cur, ...ids] }); };
const { validatePorts, validateProjectPatch } = await import(need('src/server/validate.ts'));

/* ================================================================ R — reconciler */
console.log('\n--- R: the reconciler with readAccessDrift');
function world() {
  const w = { t: 1_000_000, access: 'clean', cred: 'clean', desired: 'ro', actual: 'ro', sessions: [], leases: [], recreates: [], logs: [], delivering: new Set(), gr: null };
  w.session = (id, o = {}) => {
    const s = { id, label: `session ${id}`, sdkKey: `sdk-${id}`, closed: false, busy: !!o.busy, working: () => false, turnKey: () => (s.busy ? 't1' : null),
      closeLifetime: async () => ({ lifetime: 'no', source: 'fake' }),
      close: async () => { s.closed = true; w.leases = w.leases.filter((l) => l.sessionId !== id); } };
    w.sessions.push(s); w.leases.push({ id: `lease-${id}`, state: 'attached', sessionId: id, createdAt: w.t, orphan: false });
    return s;
  };
  w.gr = createGrantRebuild({
    listProjects: () => [{ id: 'p', name: 'P', isolation: 'container' }],
    desiredOf: () => w.desired,
    readActual: () => w.actual,
    readCredDrift: () => w.cred,
    readAccessDrift: () => { if (w.access === 'throw') throw new Error('docker down'); return w.access; },
    sessionsOf: () => w.sessions, leasesOf: () => w.leases,
    deliveryBusy: (k) => w.delivering.has(k), reserve: (k) => { w.delivering.add(k); return () => w.delivering.delete(k); },
    recreate: async (p, o) => { w.recreates.push({ force: o.force, live: w.sessions.filter((s) => !s.closed && s.busy).map((s) => s.id) }); w.access = 'clean'; w.gr.recordActual('p', w.desired); },
    settled: () => {}, logFile: null, now: () => w.t, log: (s) => w.logs.push(s), leaseSettleMs: 20, tickMs: 999_999,
  });
  return w;
}
const flush = () => new Promise((r) => setTimeout(r, 120));
{
  const w = world();
  const busy = w.session('a', { busy: true });
  w.access = 'stale';
  w.gr.tick(); await flush();
  check('R1 access stale + a BUSY turn: pending, NOT recreated', w.recreates.length === 0 && w.gr._phaseOf('p') === 'pending', { recreates: w.recreates.length, phase: w.gr._phaseOf('p') });
  check('R2 access stale never HOLDS turns (no rebuild-hold on a new turn)', w.gr.turnHoldOf('p') === null, w.gr.turnHoldOf('p'));
  let threw = null; try { w.gr.assertTurnAllowed('p'); } catch (e) { threw = e.code; }
  check('R3 assertTurnAllowed passes while access drift is pending', threw === null, threw);
  busy.busy = false;
  w.gr.tick(); await flush(); await flush();
  check('R4 the turn ended: recreated once, with no busy session at the call, never forced', w.recreates.length === 1 && w.recreates[0].live.length === 0 && w.recreates[0].force === false, w.recreates);
  check('R5 the idle session was closed resumably before the recreate', busy.closed === true, { closed: busy.closed });
  w.gr.tick(); await flush();
  check('R6 once clean the entry is gone (no second recreate)', w.gr._phaseOf('p') === null && w.recreates.length === 1, { phase: w.gr._phaseOf('p'), recreates: w.recreates.length });
  const line = w.logs.find((l) => /recreating the container for/.test(l)) ?? '';
  check('R7 the log names the access reason', /approved container access change/.test(line), line.slice(0, 200));
}
{
  const w = world();
  w.session('a');
  w.access = 'unknown';
  w.gr.tick(); await flush(); w.gr.tick(); await flush();
  check('R8 access UNKNOWN (docker unreadable) is kept pending and NEVER recreated', w.recreates.length === 0 && w.gr._phaseOf('p') === 'pending', { recreates: w.recreates.length, phase: w.gr._phaseOf('p') });
  w.access = 'throw';
  w.gr.tick(); await flush();
  check('R9 a THROWING access read is unknown, never recreated', w.recreates.length === 0, { recreates: w.recreates.length });
  w.t += 3 * 60_000;
  const items = w.gr.railItems().filter((x) => /cannot read/.test(x.title));
  check('R10 access unknown for > 2 min raises a rail card (never a silent wait)', items.length === 1, items.map((x) => x.title));
  w.access = 'clean';
  w.gr.tick(); await flush();
  check('R11 access back to clean: entry dropped, nothing recreated', w.gr._phaseOf('p') === null && w.recreates.length === 0, { phase: w.gr._phaseOf('p') });
}
{
  const w = world();
  w.access = 'stale';
  w.actual = 'none';
  w.gr.tick(); await flush();
  check('R12 no container (actual none): access drift does not add an entry (the next start creates it fresh)', w.gr._phaseOf('p') === null && w.recreates.length === 0, { phase: w.gr._phaseOf('p') });
}
{
  // A user-forced "Rebuild now" applies an access change too, over a busy session (consent), via the same pass.
  const w = world();
  w.session('a', { busy: true });
  w.access = 'stale';
  w.gr.tick(); await flush();
  const r = await w.gr.request('p', { force: true });
  await flush(); await flush();
  check('R13 "Rebuild now" (user force) applies the pending access change at once', /recreating the container now/.test(r.outcome) && w.recreates.length === 1 && w.recreates[0].force === true, { outcome: r.outcome, recreates: w.recreates });
}

/* ================================================================ S — store */
console.log('\n--- S: the typed access-request store');
const change = (o = {}) => ({ kind: 'env', key: 'MONGODB_URI', value: 'mongodb://host.docker.internal:27017/app', previous: null, ...o });
{
  const r = acc.raiseAccess({ projectId: 'p', projectName: 'P', sdkSessionId: 'sess-1234', reason: 'tests need the db', changes: [change()], conflicts: [] });
  check('S1 a raised request is pending with no decision', r.decision === null && acc.getAccess(r.id)?.decision === null, r.decision);
  const d = acc.beginDecision(r.id, 'approved');
  check('S2 an approval is APPROVED-PENDING (r5): approved, by user, applied=false, an approval seq', d.decision.verdict === 'approved' && d.decision.by === 'user' && d.decision.applied === false && d.decision.seq === 1, d.decision);
  check('S3 an approved-pending record is in the overlay and NOT in the delivery worklist (nothing true to say yet)', acc.listApprovedPending('p').some((x) => x.id === r.id) && !acc.listUnresumed().some((x) => x.id === r.id), acc.listApprovedPending('p').map((x) => x.id));
  let again = null; try { acc.beginDecision(r.id, 'rejected'); } catch (e) { again = e.code; }
  check('S4 a second decision is refused (honoured once)', again === 'already-decided', again);
  commitInRegistry('p', [r.id]);
  acc.markCommitted({ [r.id]: 'FIRST TEXT' });
  check('S5 markCommitted: out of the overlay, committed (applied), message frozen, in the delivery worklist', !acc.listApprovedPending('p').some((x) => x.id === r.id) && acc.getAccess(r.id).decision.applied === true && acc.getAccess(r.id).resume.state === 'frozen' && acc.listUnresumed().some((x) => x.id === r.id), acc.getAccess(r.id).resume);
  acc.noteResume(r.id, { state: 'frozen', text: 'A DIFFERENT TEXT' });
  check('S6 a frozen resume text is never replaced', acc.getAccess(r.id).resume.text === 'FIRST TEXT', acc.getAccess(r.id).resume.text);
  acc.noteResume(r.id, { state: 'queued', rowId: 'q1' });
  acc.noteResume(r.id, { state: 'waiting' });
  check('S7 queued never moves backwards', acc.getAccess(r.id).resume.state === 'queued', acc.getAccess(r.id).resume);
  const r2 = acc.raiseAccess({ projectId: 'p', projectName: 'P', sdkSessionId: 'sess-1234', reason: 'x', changes: [change()], conflicts: [] });
  acc.beginDecision(r2.id, 'approved');
  check('S8a a second approval in the project gets the next seq (approval order)', acc.getAccess(r2.id).decision.seq === 2, acc.getAccess(r2.id).decision);
  const na = acc.markNotApplied([{ id: r2.id, reason: 'x', text: 'NOT APPLIED' }], 'refused');
  const na2 = acc.markNotApplied([{ id: r.id, reason: 'x', text: 'NOPE' }], 'refused');
  check('S8 markNotApplied: an approved-pending record becomes terminal (out of the overlay, frozen); a COMMITTED one is never re-marked', na.length === 1 && !acc.listApprovedPending('p').some((x) => x.id === r2.id) && acc.getAccess(r2.id).notApplied?.cause === 'refused' && na2.length === 0 && !acc.getAccess(r.id).notApplied, { na, na2 });
  const r2b = acc.raiseAccess({ projectId: 'p', projectName: 'P', sdkSessionId: 'sess-1234', reason: 'x', changes: [change()], conflicts: [] });
  // torn store: quarantined, never overwritten
  const file = path.join(DATA, 'access-requests.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before.slice(0, Math.floor(before.length / 2)));
  let decideErr = null; try { acc.beginDecision(r2b.id, 'approved'); } catch (e) { decideErr = e.code; }
  check('S9 a torn store refuses a decision (nothing decided blind)', decideErr === 'unreadable', decideErr);
  const torn = fs.readFileSync(file, 'utf8');
  let raiseErr = null; try { acc.raiseAccess({ projectId: 'p', projectName: 'P', sdkSessionId: 'sess-1234', reason: 'y', changes: [change()], conflicts: [] }); } catch (e) { raiseErr = e.code ?? e.message; }
  check('S10 an agent-driven raise over a torn store is REFUSED and leaves its bytes untouched (IV r2)', raiseErr === 'unreadable' && fs.readFileSync(file, 'utf8') === torn && !fs.readdirSync(DATA).some((f) => /\.corrupt-/.test(f)), { raiseErr, files: fs.readdirSync(DATA) });
  const kept = acc.recoverAccessStoreAtBoot();
  check('S11 the SERVER at boot preserves (quarantines) an unreadable store and starts fresh', !!kept && fs.readdirSync(DATA).some((f) => /access-requests\.json\.corrupt-/.test(f)), { kept, files: fs.readdirSync(DATA) });
}
{
  // IV r2 flood: an approved, unresumed record must survive any number of agent raises.
  fs.rmSync(path.join(DATA, 'access-requests.json'), { force: true });
  const ok = acc.raiseAccess({ projectId: 'fp', projectName: 'FP', sdkSessionId: 'sess-flood', reason: 'r', changes: [change()], conflicts: [] });
  acc.beginDecision(ok.id, 'approved'); commitInRegistry('fp', [ok.id]); acc.markCommitted({ [ok.id]: 'granted' });
  const big = 'x'.repeat(30_000);
  let refused = 0; let lastErr = '';
  for (let i = 0; i < 200; i++) {
    try { acc.raiseAccess({ projectId: 'fp', projectName: 'FP', sdkSessionId: `sess-flood-${i % 7}`, reason: 'flood', changes: Array.from({ length: 2 }, (_, k) => change({ key: `K${k}`, value: big })), conflicts: [] }); }
    catch (e) { refused++; lastErr = e.message; }
  }
  const pend = acc.listAccessForProject('fp').filter((r) => !r.decision).length;
  const size = fs.statSync(path.join(DATA, 'access-requests.json')).size;
  check('S12 a 200-request flood is capped (pending per project <= the limit); the rest are refused with a reason', pend <= acc.MAX_PENDING_PER_PROJECT && refused >= 200 - acc.MAX_PENDING_PER_PROJECT && /waiting for the user/.test(lastErr), { pend, refused, lastErr: lastErr.slice(0, 120), size });
  check('S13 the approved, unresumed record survives the flood and is still in the resume worklist', acc.getAccess(ok.id)?.decision?.verdict === 'approved' && acc.listUnresumed().some((r) => r.id === ok.id), acc.getAccess(ok.id)?.decision ?? 'GONE');
  let perSession = null; try { for (let i = 0; i < 5; i++) acc.raiseAccess({ projectId: 'fq', projectName: 'FQ', sdkSessionId: 'sess-one', reason: 'r', changes: [change()], conflicts: [] }); } catch (e) { perSession = acc.listAccessForSession('sess-one').filter((r) => !r.decision).length; }
  check('S14 one session can hold at most MAX_PENDING_PER_SESSION undecided requests', perSession === acc.MAX_PENDING_PER_SESSION, perSession);
}

/* ================================================================ C — hostile inbox files */
console.log('\n--- C: the inbox reader on hostile files');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-inbox-'));
  const secretFile = path.join(dir, 'secret.txt');
  fs.writeFileSync(secretFile, '{"reason":"SECRET-CONTENT","env":{"A":"b"}}');
  const sid = '0f0e0d0c-1111-2222-3333-444455556666';
  const raised = [];
  const deps = {
    listContainerProjects: () => [{ id: 'p', name: 'P', isolation: 'container', settings: {} }],
    inboxDirOf: () => dir,
    sessionLive: (_p, s) => s === sid,
    parseChanges: (p, body) => ch.parseChanges(p, body, { validateEnv: (e) => e, validatePorts, currentEnv: () => ({}), currentPorts: () => [] }),
    portConflicts: async () => [],
    onRaised: (r) => raised.push(r),
    log: () => {},
  };
  const name = (n) => path.join(dir, `.orchard-access.${sid}.${n}.json`);
  const reply = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `.orchard-access.${sid}.${n}.reply`), 'utf8')); } catch { return null; } };
  fs.symlinkSync(secretFile, name('sym'));
  fs.writeFileSync(name('big'), JSON.stringify({ reason: 'x'.repeat(70_000) }));
  spawnSync('mkfifo', [name('fifo')]);
  fs.writeFileSync(name('torn'), '{"reason":"half wri');
  fs.writeFileSync(name('ok'), JSON.stringify({ reason: 'need the db', env: { MONGODB_URI: 'mongodb://host.docker.internal:27017/app' } }));
  fs.writeFileSync(path.join(dir, `.orchard-access.${sid}.tmpd.json.tmp`), '{}');
  fs.writeFileSync(name('ghost').replace(sid, 'aaaaaaaa-0000-0000-0000-000000000000'), JSON.stringify({ reason: 'r', env: { A: 'b' } }));
  // A planted reply symlink pointing at a host file: the writer must not follow/overwrite it.
  const victim = path.join(dir, 'victim.txt'); fs.writeFileSync(victim, 'ORIGINAL');
  fs.writeFileSync(name('planted'), JSON.stringify({ reason: 'r', env: { B: 'c' } }));
  fs.symlinkSync(victim, path.join(dir, `.orchard-access.${sid}.planted.reply`));
  const t0 = Date.now();
  const n = await ch.pollInboxes(deps);
  const took = Date.now() - t0;
  check('C1 the poll returns promptly with a FIFO present (O_NONBLOCK: never hangs the server)', took < 3000, `${took} ms`);
  check('C2 the valid request was raised exactly once', raised.filter((r) => r.reason === 'need the db').length === 1, raised.map((r) => r.reason));
  check('C3 a symlink request is refused and its target content is never raised or echoed', !raised.some((r) => /SECRET/.test(r.reason)) && reply('sym')?.ok === false && !/SECRET/.test(JSON.stringify(reply('sym'))), reply('sym'));
  check('C4 the symlink TARGET is untouched', fs.readFileSync(secretFile, 'utf8').includes('SECRET-CONTENT'), 'intact');
  check('C5 an oversize request is refused', reply('big')?.ok === false && /larger than/.test(reply('big')?.error), reply('big'));
  check('C6 a FIFO request is refused as not a regular file', reply('fifo')?.ok === false, reply('fifo'));
  check('C7 a young truncated file is LEFT for the next poll (no reply yet, file still there)', reply('torn') === null && fs.existsSync(name('torn')), { reply: reply('torn'), exists: fs.existsSync(name('torn')) });
  check('C8 a .tmp being written is ignored', fs.existsSync(path.join(dir, `.orchard-access.${sid}.tmpd.json.tmp`)), 'still there');
  check('C9 a request naming a session that is not live is refused', !raised.some((r) => r.sdkSessionId.startsWith('aaaaaaaa')), raised.map((r) => r.sdkSessionId));
  check('C10 a planted reply symlink is neither followed nor overwritten', fs.readFileSync(victim, 'utf8') === 'ORIGINAL', fs.readFileSync(victim, 'utf8'));
  // completing the torn file (mv into place) is then raised
  fs.writeFileSync(name('torn'), JSON.stringify({ reason: 'completed now', env: { C: 'd' } }));
  await ch.pollInboxes(deps);
  check('C11 the completed file is raised on the next poll', raised.some((r) => r.reason === 'completed now'), raised.map((r) => r.reason));
  // an OLD unparseable file is refused
  fs.writeFileSync(name('old'), '{not json');
  const old = new Date(Date.now() - 60_000); fs.utimesSync(name('old'), old, old);
  await ch.pollInboxes(deps);
  check('C12 an old unparseable file is refused with the tmp+mv hint', reply('old')?.ok === false && /not valid JSON/.test(reply('old')?.error), reply('old'));
  check('C13 the first poll raised exactly the two valid requests (ok + the one whose reply path was planted)', n === 2, n);
}

/* ================================================================ P — parsing + collisions */
console.log('\n--- P: request parsing and port collisions');
{
  const proj = { id: 'p', name: 'P', settings: {} };
  const pd = (env = {}, ports = []) => ({
    validateEnv: (e) => (validateProjectPatch({ settings: { container: { env: e } } }).settings.container.env),
    validatePorts, currentEnv: () => env, currentPorts: () => ports,
  });
  const ok = ch.parseChanges(proj, { reason: 'r', env: { MONGODB_URI: 'mongodb://host.docker.internal:27017/x' }, ports: [{ containerPort: 3000 }] }, pd());
  check('P1 env + port parse into typed changes; hostPort defaults to containerPort; loopback', ok.length === 2 && ok[1].hostIp === '127.0.0.1' && ok[1].hostPort === 3000, ok);
  const bad = (body, d = pd()) => { try { ch.parseChanges(proj, body, d); return null; } catch (e) { return e.message; } };
  check('P2 a host address is refused (never 0.0.0.0)', /not settable/.test(bad({ reason: 'r', ports: [{ containerPort: 3000, hostIp: '0.0.0.0' }] }) ?? ''), bad({ reason: 'r', ports: [{ containerPort: 3000, hostIp: '0.0.0.0' }] }));
  check('P3 a privileged host port is refused', /1024-65535/.test(bad({ reason: 'r', ports: [{ containerPort: 80, hostPort: 80 }] }) ?? ''), bad({ reason: 'r', ports: [{ containerPort: 80, hostPort: 80 }] }));
  check('P4 a reserved env name is refused with the settings validator\'s words', /reserved/.test(bad({ reason: 'r', env: { ANTHROPIC_API_KEY: 'x' } }) ?? ''), bad({ reason: 'r', env: { ANTHROPIC_API_KEY: 'x' } }));
  check('P5 ORCHARD_ACCESS_DIR cannot be set as container env', /reserved/.test(bad({ reason: 'r', env: { ORCHARD_ACCESS_DIR: '/x' } }) ?? ''), bad({ reason: 'r', env: { ORCHARD_ACCESS_DIR: '/x' } }));
  check('P6 an unknown field is refused', /unknown field/.test(bad({ reason: 'r', mounts: [] }) ?? ''), bad({ reason: 'r', mounts: [] }));
  check('P7 a change the project already has is not a change (nothing to ask)', /nothing to change/.test(bad({ reason: 'r', env: { A: 'b' } }, pd({ A: 'b' })) ?? ''), bad({ reason: 'r', env: { A: 'b' } }, pd({ A: 'b' })));
  const prev = ch.parseChanges(proj, { reason: 'r', env: { A: 'new' } }, pd({ A: 'old' }));
  check('P8 overwriting a key records the previous value shown on the card', prev[0].previous === 'old', prev);
  check('P9 PATCH validation refuses hostIp too', (() => { try { validatePorts([{ hostPort: 3000, containerPort: 3000, hostIp: '0.0.0.0' }]); return false; } catch { return true; } })(), 'refused');
  // collisions
  const cd = (o = {}) => ({ otherProjects: () => o.others ?? [], publishedElsewhere: () => { if (o.dockerThrows) throw new Error('docker down'); return o.elsewhere ?? []; }, ownHolds: () => !!o.own, hostPortFree: o.free ?? (async () => ({ free: true })) });
  const c1 = await ch.findPortConflicts(proj, [{ hostPort: 3000, containerPort: 3000 }], cd({ others: [{ id: 'q', name: 'Other', ports: [{ hostPort: 3000, containerPort: 80 }] }] }));
  check('P10 another PROJECT declaring the host port is a conflict naming it', c1.length === 1 && /project “Other”/.test(c1[0]), c1);
  const c2 = await ch.findPortConflicts(proj, [{ hostPort: 3000, containerPort: 3000 }], cd({ elsewhere: [{ hostPort: 3000, hostIp: '0.0.0.0', container: 'someone-elses' }] }));
  check('P11 another CONTAINER publishing it is a conflict naming it', c2.length === 1 && /someone-elses/.test(c2[0]), c2);
  const c3 = await ch.findPortConflicts(proj, [{ hostPort: 3000, containerPort: 3000 }], cd({ dockerThrows: true }));
  check('P12 docker unreadable: refused (never approved blind)', c3.length >= 1 && /could not ask Docker/.test(c3[0]), c3);
  // a real host listener
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const taken = srv.address().port;
  const c4 = await ch.findPortConflicts(proj, [{ hostPort: taken, containerPort: 3000 }], cd({ free: ch.hostPortFree }));
  check('P13 a real program listening on 127.0.0.1:<port> is a conflict', c4.length === 1 && /in use on this machine/.test(c4[0]), c4);
  const c5 = await ch.findPortConflicts(proj, [{ hostPort: taken, containerPort: 3000 }], cd({ free: ch.hostPortFree, own: true }));
  check('P14 …unless this project\'s own container holds exactly that binding', c5.length === 0, c5);
  srv.close();
}

/* ================================================================ Q — resume */
console.log('\n--- Q: resume texts and the level-based checker');
{
  const p = regTop.getProject('qp'); // r8: the real registry row (the classifier reads committed / incarnation from it)
  const port = { kind: 'port', hostIp: '127.0.0.1', hostPort: 3000, containerPort: 3000 };
  const mk = () => acc.raiseAccess({ projectId: 'qp', projectName: 'QP', sdkSessionId: 'sess-q', reason: 'r', changes: [change(), port], conflicts: [] });
  const rej = mk(); acc.beginDecision(rej.id, 'rejected');
  const app = mk(); acc.beginDecision(app.id, 'approved');
  let drift = 'stale'; let phase = null; let failEnqueue = true; const enq = []; const commits = [];
  const deps = {
    getProject: () => regTop.getProject('qp'), accessDriftOf: () => drift, rebuildPhaseOf: () => phase,
    liveAccessOf: () => ({ env: ['MONGODB_URI=mongodb://host.docker.internal:27017/app'], ports: ['127.0.0.1:3000->3000/tcp'] }),
    // r7 contract: the commit's ONE settings write also names the records in the project's committed set.
    commitBase: (_p, recs) => { commits.push(recs.map((r) => r.id)); commitInRegistry('qp', recs.map((r) => r.id)); },
    enqueue: (r, nonce, text) => { if (r.id === app.id && failEnqueue) throw new Error('outbox busy'); enq.push({ id: r.id, nonce, text }); return `row-${enq.length}`; },
    log: () => {},
  };
  ch.checkResumes(deps);
  const rejSent = enq.find((e) => e.id === rej.id);
  check('Q1 a rejection is sent at once, as "denied: <what>"', !!rejSent && /^\[station\] denied: env MONGODB_URI=.*port 127\.0\.0\.1:3000 → container 3000/.test(rejSent.text), rejSent?.text);
  check('Q2 an approval is NOT sent, and NOT committed to the settings, while the container still has access drift', !enq.some((e) => e.id === app.id) && acc.getAccess(app.id).resume.state === 'waiting' && commits.length === 0, { resume: acc.getAccess(app.id).resume, commits });
  drift = 'clean'; phase = 'rebuilding';
  ch.checkResumes(deps);
  check('Q2b drift reads clean but the reconciler is mid-rebuild (no container in the remove→create window): still waiting', !enq.some((e) => e.id === app.id) && acc.getAccess(app.id).resume.state === 'waiting', acc.getAccess(app.id).resume);
  phase = null;
  ch.checkResumes(deps);
  const frozen = acc.getAccess(app.id).resume;
  check('Q3 drift clean on a running container: COMMITTED to the settings once (r5), and the text is FROZEN for the enqueue retry', frozen.state === 'frozen' && /access granted: .* continue/.test(frozen.text ?? '') && JSON.stringify(commits) === JSON.stringify([[app.id]]) && acc.getAccess(app.id).decision.applied === true, { frozen, commits });
  failEnqueue = false;
  deps.liveAccessOf = () => null; // what the container says now must NOT change the frozen text
  ch.checkResumes(deps);
  const sent = enq.find((e) => e.id === app.id);
  check('Q4 the retry sends the SAME frozen text under nonce access-<id>', !!sent && sent.text === frozen.text && sent.nonce === `access-${app.id}`, sent);
  check('Q5 queued is recorded with the row id', acc.getAccess(app.id).resume.state === 'queued' && acc.getAccess(app.id).resume.rowId === `row-${enq.length}`, acc.getAccess(app.id).resume);
  ch.checkResumes(deps);
  check('Q6 a queued record is never sent again', enq.filter((e) => e.id === app.id).length === 1, enq.length);
  const t1 = ch.resumeTextFor({ ...app, decision: { verdict: 'approved' } }, p, { env: [], ports: ['127.0.0.1:3000->3000/tcp'] });
  check('Q7 if the settings changed since, the text says what is NOT in the container (never a false "granted")', /not in the container now/.test(t1) && !/access granted/.test(t1), t1);
}

/* ================================================================ V — (c) after the r3 redesign */
console.log('\n--- V: property (c) after the r3 design review (docker is the authority; refused change reverted; no loop/hold)');
{
  const cm = await import(need('src/server/container-manager.ts'));
  const w1 = cm.refusedHostPortsOf?.(new Error('created x.next but it would not start\nError response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint x.next (abc): Bind for 127.0.0.1:35149 failed: port is already allocated'));
  const w2 = cm.refusedHostPortsOf?.(new Error('failed to set up container networking: driver failed programming external connectivity on endpoint e: failed to bind host port 127.0.0.1:34259/tcp: address already in use'));
  check('V1 both docker refusal wordings name the refused host port', JSON.stringify(w1) === '[35149]' && JSON.stringify(w2) === '[34259]', { w1, w2 });

  // the IPv6 door: something listens ONLY on [::1]:H while 127.0.0.1:H is free
  const v6 = net.createServer();
  const v6ok = await new Promise((r) => { v6.once('error', (e) => r(e.code)); v6.listen({ host: '::1', port: 0, ipv6Only: true }, () => r(true)); });
  if (v6ok === true) {
    const H6 = v6.address().port;
    const pr = await ch.hostPortFree(H6);
    check('V2 an IPv6-only listener on [::1]:H reads IN USE (loopback is two addresses)', pr.free === false && /::1|IPv6/.test(pr.why ?? ''), { H6, pr });
    v6.close();
  } else check('V2 (skipped: this host has no IPv6 loopback, so the door does not exist here)', true, v6ok);
  const fp = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p0 = s.address().port; s.close(() => r(p0)); }); });
  check('V2b a port free on both loopbacks reads free', (await ch.hostPortFree(fp)).free === true, fp);

  // FEAT-200 r5 (commit on success): docker's refusal FAILS the approved-pending owners; nothing is written to settings.
  if (typeof ch.failRefused !== 'function') check('V3-V11 the tree under test has the r5 refusal handler (access-channel failRefused)', false, 'absent');
  else {
  const mkApproved = (changes) => { const r = acc.raiseAccess({ projectId: 'vp', projectName: 'VP', sdkSessionId: 'sess-v', reason: 'r', changes, conflicts: [] }); acc.beginDecision(r.id, 'approved'); return r; };
  const A = mkApproved([{ kind: 'env', key: 'K', value: 'new', previous: 'old' }, { kind: 'port', hostIp: '127.0.0.1', hostPort: 41001, containerPort: 8080 }]);
  const B = mkApproved([{ kind: 'env', key: 'LATER', value: 'v', previous: null }, { kind: 'port', hostIp: '127.0.0.1', hostPort: 41002, containerPort: 9000 }]);
  const got = ch.failRefused({ projectId: 'vp', refused: [{ hostPort: 41001, containerPort: 8080 }], reason: 'Bind for 127.0.0.1:41001 failed: port is already allocated' }, [], () => {});
  const a2 = acc.getAccess(A.id); const b2 = acc.getAccess(B.id);
  check('V3 the request needing the refused port FAILS: notApplied (refused) with docker\'s reason, message FROZEN "approved, but could not be applied … never written to the project settings"', got === 'retry' && a2.notApplied?.cause === 'refused' && a2.resume.state === 'frozen' && /approved, but could not be applied: Bind for 127\.0\.0\.1:41001/.test(a2.resume.text) && /never written to the project settings/.test(a2.resume.text), { got, notApplied: a2.notApplied, resume: a2.resume.text?.slice(0, 160) });
  check('V5 a request that does not need the refused port stays approved-pending (in the overlay)', acc.isApprovedPending(b2) && !b2.notApplied, b2.decision);
  // a request already committed (the container had it) is never re-said
  const D = mkApproved([{ kind: 'port', hostIp: '127.0.0.1', hostPort: 41004, containerPort: 8080 }]);
  commitInRegistry('vp', [D.id]);
  acc.markCommitted({ [D.id]: '[station] access granted: …' });
  const gd = ch.failRefused({ projectId: 'vp', refused: [{ hostPort: 41004, containerPort: 8080 }], reason: 'r' }, [], () => {});
  check('V7 a committed request keeps what it said; nothing pending owned the port → "stop"', !acc.getAccess(D.id).notApplied && acc.getAccess(D.id).resume.text === '[station] access granted: …' && gd === 'stop', { gd, resume: acc.getAccess(D.id).resume });
  // a refused port the USER set (base) is not any request's: stop (retrying cannot help); nothing written
  const E2 = mkApproved([{ kind: 'port', hostIp: '127.0.0.1', hostPort: 41005, containerPort: 7000 }]);
  const own = ch.failRefused({ projectId: 'vp', refused: [{ hostPort: 41005, containerPort: 7000 }], reason: 'r' }, [41005], () => {});
  check('V8 a refused port that is ALSO in the user\'s base settings → "stop" (owners told; the user\'s setting is left as set)', own === 'stop' && acc.getAccess(E2.id).notApplied?.cause === 'refused', { own, E2: acc.getAccess(E2.id).notApplied });
  const none = ch.failRefused({ projectId: 'vp', refused: [{ hostPort: 49999, containerPort: 1 }], reason: 'r' }, [], () => {});
  check('V9 no pending request owns the refused port → "stop" (the ensure does not retry)', none === 'stop', none);
  // r6: a user edit cancels STRUCTURALLY — edit versions stamped by the registry writer, compared to the approval's basis.
  const regm = await import(need('src/server/registry.ts'));
  if (typeof regm.bumpAccessEdits !== 'function' || typeof acc.editsSince !== 'function' || typeof ch.liveFor !== 'function') {
    check('V14 the tree under test has r6 edit versions (registry bumpAccessEdits, access editsSince, channel liveFor)', false, 'absent');
  } else {
    const z = { env: {}, ports: {} };
    const e1 = regm.bumpAccessEdits(z, { env: { K: 'old' }, ports: [] }, { env: { K: 'new' }, ports: [] });
    const e2 = regm.bumpAccessEdits(e1, { env: { K: 'new' }, ports: [] }, { env: { K: 'old' }, ports: [] });
    const same = regm.bumpAccessEdits(e2, { env: { K: 'old', O: '1' }, ports: [{ hostPort: 41009, containerPort: 1 }] }, { env: { O: '1', K: 'old' }, ports: [{ hostPort: 41009, containerPort: 1 }] });
    const add = regm.bumpAccessEdits(z, { env: {}, ports: [] }, { env: { N: 'x' }, ports: [{ hostPort: 41010, containerPort: 80 }] });
    const del = regm.bumpAccessEdits(add, { env: { N: 'x' }, ports: [{ hostPort: 41010, containerPort: 80 }] }, { env: {}, ports: [] });
    const remap = regm.bumpAccessEdits(z, { ports: [{ hostPort: 41011, containerPort: 80 }] }, { ports: [{ hostPort: 41011, containerPort: 81 }] });
    check('V14 registry stamper: K old→new→old = 2 bumps; an unchanged re-send (any key order) = 0; add/delete env and port bump; a remap bumps', e1.env.K === 1 && e2.env.K === 2 && JSON.stringify(same) === JSON.stringify(e2) && add.env.N === 1 && add.ports['41010'] === 1 && del.env.N === 2 && del.ports['41010'] === 2 && remap.ports['41011'] === 1 && !('O' in same.env), { e1, e2, same, add, del, remap });
    const changes = [{ kind: 'env', key: 'K', value: 'new', previous: 'old' }, { kind: 'port', hostIp: '127.0.0.1', hostPort: 41012, containerPort: 8080 }];
    const basis = acc.basisFor(changes, { env: { K: 3, OTHER: 9 }, ports: { 41012: 1 } }, 'c1');
    const rec = { changes, decision: { verdict: 'approved', applied: false, basis } };
    const none = acc.editsSince(rec, { env: { K: 3, OTHER: 10 }, ports: { 41012: 1, 41013: 4 } }, 'c1');
    const envHit = acc.editsSince(rec, { env: { K: 4 }, ports: { 41012: 1 } }, 'c1');
    const portHit = acc.editsSince(rec, { env: { K: 3 }, ports: { 41012: 2 } }, 'c1');
    // r8 (design review 8e184b1e): a re-added project is NOT an edit (editsSince counts edits within one incarnation);
    // the classifier reads it as 'removed' first. Pre-r8 trees count it as an edit.
    const R8u = typeof acc.classify === 'function';
    const reAdded = R8u ? acc.classify({ ...rec, id: 'x', projectId: 'vx', createdAt: 'c0' }, { id: 'vx', createdAt: 'c2', accessEdits: { env: { K: 3 }, ports: { 41012: 1 } }, settings: {} }).kind : acc.editsSince(rec, { env: { K: 3 }, ports: { 41012: 1 } }, 'c2').length;
    check('V14b basis + editsSince: unrelated keys/ports never count; a moved version of a named env key / host port does; a re-added project is "removed" (r8; an edit before r8)', JSON.stringify(basis) === JSON.stringify({ env: { K: 3 }, ports: { 41012: 1 }, projectCreatedAt: 'c1' }) && none.length === 0 && JSON.stringify(envHit) === JSON.stringify(['env K']) && JSON.stringify(portHit) === JSON.stringify(['port 127.0.0.1:41012']) && (R8u ? reAdded === 'removed' : reAdded === 1), { basis, none, envHit, portHit, reAdded });
    const legacy = { changes, decision: { verdict: 'approved', applied: false } };
    check('V14c a record approved before r6 (no basis) reads as basis 0: cancelled by any edit ever made to what it names (the safe side)', acc.editsSince(legacy, { env: {}, ports: {} }, 'c1').length === 0 && acc.editsSince(legacy, { env: { K: 1 }, ports: {} }, 'c1').length === 1, 'legacy');
    const pB = { ...regm.getProject('vp'), accessEdits: { env: { LATER: 1 }, ports: {} } };
    check('V14d liveFor: the overlay drops a record whose named key was edited after its approval', ch.liveFor(acc.getAccess(B.id), { ...pB, accessEdits: { env: {}, ports: {} } }) === true && ch.liveFor(acc.getAccess(B.id), pB) === false, 'liveFor');
  }
  // the no-container case: the checker creates first, never freezes "granted" before a container has it
  const E = mkApproved([{ kind: 'env', key: 'NOC', value: '1', previous: null }]);
  let live = null; let ensures = 0; let ensureFails = false; let kicks = 0; const enq2 = [];
  const committedBy = new Map(); // r7 contract: the commit's settings write names the records in the committed set
  const qd = {
    getProject: (id) => regTop.getProject(id), accessDriftOf: () => 'clean', rebuildPhaseOf: () => null,
    liveAccessOf: (p) => (p.id === 'vp' ? live : { env: [], ports: [] }), commitBase: (p, recs) => { committedBy.set(p.id, [...(committedBy.get(p.id) ?? []), ...recs.map((r) => r.id)]); commitInRegistry(p.id, recs.map((r) => r.id)); },
    enqueue: (r, nonce, text) => { enq2.push({ id: r.id, text }); return `row-${enq2.length}`; },
    ensureNotRunning: async () => { ensures++; if (ensureFails) throw new Error('docker refused something else'); live = { env: ['NOC=1'], ports: [] }; },
    kick: () => { kicks++; }, log: () => {},
  };
  ensureFails = true;
  ch.checkResumes(qd); await flush();
  ch.checkResumes(qd); await flush();
  check('V10 no running container: the checker runs ONE create-only ensure and freezes nothing', ensures === 1 && !enq2.some((x) => x.id === E.id) && acc.getAccess(E.id).resume.state === 'waiting', { ensures, resume: acc.getAccess(E.id).resume });
  check('V11 a failed create is backed off (no hot retry loop) and said on the record', ensures === 1 && /could not create the container yet/.test(acc.getAccess(E.id).resume.error ?? ''), acc.getAccess(E.id).resume.error);
  }
}
{
  const mkFailing = () => {
    const w = world();
    w.session('a');
    w.gr = createGrantRebuild({
      listProjects: () => [{ id: 'p', name: 'P', isolation: 'container' }], desiredOf: () => w.desired, readActual: () => w.actual,
      readCredDrift: () => w.cred, readAccessDrift: () => w.access,
      sessionsOf: () => w.sessions, leasesOf: () => w.leases, deliveryBusy: () => false, reserve: () => () => {},
      recreate: async () => { w.recreates.push(1); w.actual = 'none'; throw new Error('the container is gone'); },
      settled: () => {}, logFile: null, now: () => w.t, log: (s) => w.logs.push(s), leaseSettleMs: 20, tickMs: 999_999,
    });
    return w;
  };
  const wa = mkFailing(); wa.access = 'stale';
  wa.gr.tick(); await flush(); await flush();
  check('V12 an ACCESS-only rebuild that failed (no container left) does NOT hold turns', wa.recreates.length === 1 && wa.gr._phaseOf('p') === 'failed' && wa.gr.turnHoldOf('p') === null, { phase: wa.gr._phaseOf('p'), hold: wa.gr.turnHoldOf('p') });
  const wg = mkFailing(); wg.desired = 'ro'; wg.actual = 'rw';
  wg.gr.tick(); await flush(); await flush();
  check('V13 a GIT-driven rebuild that failed still holds turns (fail closed, unchanged)', wg.recreates.length === 1 && wg.gr._phaseOf('p') === 'failed' && wg.gr.turnHoldOf('p') !== null, { phase: wg.gr._phaseOf('p'), hold: !!wg.gr.turnHoldOf('p') });
}

/* ================================================================ CV — the card text for every end state (r10) */
console.log('\n--- CV: r10 (IV r9 2af93888) — the card for every request end state, incl. a project removed / re-added after the outcome');
{
  // The REAL accessStatusText from public/app.js (extracted by brace matching, evaluated as is), fed by the REAL
  // accessCardView (src/server/access-requests.ts; index.ts accessView adds only the outbox row state). Real store, real
  // registry createProject/deleteProject. A pre-r10 tree has no accessCardView: the view is then the pre-r10 accessView
  // body transcribed below (labelled), so the must-FAIL shows the old reading, not a missing symbol.
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const fnAt = appSrc.indexOf('function accessStatusText(rec) {');
  let depth = 0, end = -1;
  for (let i = appSrc.indexOf('{', fnAt); i < appSrc.length; i++) { const c = appSrc[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) { end = i + 1; break; } } }
  const accessStatusText = new Function(`${appSrc.slice(fnAt, end)}; return accessStatusText;`)();
  const R10 = typeof acc.accessCardView === 'function';
  const viewOf = (rec, delivery) => {
    const cls = acc.classOf(rec);
    if (R10) return acc.accessCardView(rec, cls, delivery, () => null);
    // pre-r10 index.ts accessView, transcribed (only for the must-FAIL run on an older tree)
    if (cls.kind === 'committed' && rec.decision) rec = { ...rec, decision: { ...rec.decision, applied: true } };
    if (cls.kind === 'removed') rec = { ...rec, notApplied: rec.notApplied ?? { reason: 'its project was removed from Orchard', at: 'x', cause: 'removed' } };
    return { ...rec, delivery, rebuild: null, cancellable: cls.kind === 'live' || cls.kind === 'edited' };
  };
  const cvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-cv-proj-'));
  const mk = () => regTop.createProject({ name: 'cvproj', hostPath: cvDir, isolation: 'container', settings: { tools: { playwright: false, serena: false, openaiDispatch: false }, laneDocker: 'sandbox', container: { gpu: 'off', env: {}, ports: [] } } });
  let P = mk();
  const inc = () => (typeof regTop.incarnationOf === 'function' ? { projectIncarnation: regTop.incarnationOf(regTop.getProject(P.id)) } : {});
  const raise = (sid, key = 'K') => acc.raiseAccess({ projectId: P.id, projectName: P.name, ...inc(), sdkSessionId: sid, reason: 'cv', changes: [change({ key, value: 'v' })], conflicts: [] });
  // One request per end state, all in the SAME incarnation, each with a queued resume row.
  const committed = raise('sess-cv1', 'GRANTED');
  acc.beginDecision(committed.id, 'approved'); commitInRegistry(P.id, [committed.id]); acc.markCommitted({ [committed.id]: '[station] access granted: env GRANTED=v' }); acc.noteResume(committed.id, { state: 'queued', rowId: 'row-c' });
  const rejected = raise('sess-cv2', 'REJ'); acc.beginDecision(rejected.id, 'rejected'); acc.noteResume(rejected.id, { state: 'frozen', text: 'denied' }); acc.noteResume(rejected.id, { state: 'queued', rowId: 'row-r' });
  const cancelled = raise('sess-cv3', 'CAN'); acc.beginDecision(cancelled.id, 'approved'); acc.markNotApplied([{ id: cancelled.id, reason: 'the user pressed Cancel on its card', text: 'cancelled' }], 'cancelled'); acc.noteResume(cancelled.id, { state: 'queued', rowId: 'row-x' });
  const refused = raise('sess-cv4', 'REF'); acc.beginDecision(refused.id, 'approved'); acc.markNotApplied([{ id: refused.id, reason: 'Bind for 127.0.0.1:41001 failed: port is already allocated', text: 'could not be applied' }], 'refused'); acc.noteResume(refused.id, { state: 'queued', rowId: 'row-f' });
  const saveFailed = raise('sess-cv5', 'SAV'); acc.beginDecision(saveFailed.id, 'approved'); acc.markNotApplied([{ id: saveFailed.id, reason: 'EACCES writing the registry', text: 'could not be saved' }], 'save-failed'); acc.noteResume(saveFailed.id, { state: 'queued', rowId: 'row-s' });
  const live = raise('sess-cv6', 'LIVE'); acc.beginDecision(live.id, 'approved');
  const undecided = raise('sess-cv7', 'UND');
  const ids = { committed, rejected, cancelled, refused, saveFailed, live, undecided };
  const T = (r, d) => { const v = viewOf(acc.getAccess(r.id), d); return { text: accessStatusText(v), v }; };
  // Anti-regressions (the CURRENT incarnation): each end state keeps its own reading.
  const cur = {
    granted: T(committed, 'delivered'), grantedFailed: T(committed, 'failed'), rejected: T(rejected, 'delivered'), cancelled: T(cancelled, 'delivered'),
    refused: T(refused, 'delivered'), saveFailed: T(saveFailed, 'delivered'), live: T(live, null), undecided: T(undecided, null),
  };
  check('CV0 anti-regression (current project): granted → "approved · container ready · the session has been resumed with it"', /^approved · container ready · the session has been resumed with it$/.test(cur.granted.text), cur.granted.text);
  check('CV0b anti-regression (current project): a failed row of a live project still says "could not be delivered — open the session" (the session IS this project\'s)', /could not be delivered — open the session to see it/.test(cur.grantedFailed.text), cur.grantedFailed.text);
  check('CV0c anti-regression: rejected / cancelled / could not be applied / could not be saved each keep their own text', /^rejected · the session has been resumed/.test(cur.rejected.text) && /^cancelled: the user pressed Cancel .* never written/.test(cur.cancelled.text) && /^approved, but could not be applied: Bind for/.test(cur.refused.text) && /^approved, but could not be saved: EACCES/.test(cur.saveFailed.text), { rej: cur.rejected.text, can: cur.cancelled.text, ref: cur.refused.text, sav: cur.saveFailed.text });
  check('CV0d anti-regression: approved-pending is cancellable; undecided waits for a decision; neither reads removed', cur.live.v.cancellable === true && /^approved · pending/.test(cur.live.text) && /^waiting for your decision/.test(cur.undecided.text) && !/removed/.test(cur.live.text + cur.undecided.text), { live: cur.live.text, und: cur.undecided.text });
  // The r9 scenario: the project is DELETED and RE-ADDED under the same id; every row was failed by the outbox (BUG-284).
  const inc1 = inc().projectIncarnation ?? null;
  regTop.deleteProject(P.id); const P2 = mk();
  const inc2 = typeof regTop.incarnationOf === 'function' ? regTop.incarnationOf(P2) : null;
  check('CV1 setup: re-added under the SAME id, a new incarnation', P2.id === P.id && inc1 !== inc2, { id: P2.id, inc1, inc2 });
  const NOT_SENT = /its project was removed from Orchard, so it is not in effect · not sent: the session belonged to the removed project/;
  const OPEN = /open the session|check the session/;
  const gone = {}; for (const [k, r] of Object.entries(ids)) gone[k] = T(r, r.resume === null && !acc.getAccess(r.id).resume ? null : 'failed');
  check('CV1 THE r9 BREAK: approved and APPLIED, "granted" queued, project deleted + re-added, row failed → the card reads "not sent / project removed", never "open the session"', NOT_SENT.test(gone.committed.text) && !OPEN.test(gone.committed.text) && /^approved, but/.test(gone.committed.text), gone.committed.text);
  check('CV1b …and it is not cancellable and flagged removed (no Approve/Reject/Cancel path on the card)', gone.committed.v.cancellable === false && (gone.committed.v.projectRemoved === true || !R10), { cancellable: gone.committed.v.cancellable, projectRemoved: gone.committed.v.projectRemoved });
  check('CV2 rejected, then removed: "rejected, and its project was removed … not sent" (never "approved", never "open the session")', /^rejected, and /.test(gone.rejected.text) && NOT_SENT.test(gone.rejected.text) && !OPEN.test(gone.rejected.text), gone.rejected.text);
  check('CV3 cancelled by a user edit, then removed: keeps "cancelled: <reason>", adds removed / not sent', /^approved, but not applied \(cancelled: the user pressed Cancel on its card\), and /.test(gone.cancelled.text) && NOT_SENT.test(gone.cancelled.text) && !OPEN.test(gone.cancelled.text), gone.cancelled.text);
  check('CV4 could not be applied, then removed: keeps the reason, adds removed / not sent', /^approved, but not applied \(could not be applied: Bind for/.test(gone.refused.text) && NOT_SENT.test(gone.refused.text) && !OPEN.test(gone.refused.text), gone.refused.text);
  check('CV5 could not be saved, then removed: keeps the reason, adds removed / not sent', /^approved, but not applied \(could not be saved: EACCES/.test(gone.saveFailed.text) && NOT_SENT.test(gone.saveFailed.text) && !OPEN.test(gone.saveFailed.text), gone.saveFailed.text);
  check('CV6 approved-pending of the removed incarnation: removed, not cancellable', /^approved, but its project was removed/.test(gone.live.text) && gone.live.v.cancellable === false && !OPEN.test(gone.live.text), { t: gone.live.text, c: gone.live.v.cancellable });
  check('CV7 undecided of the removed incarnation: "not decided: … removed", no decision path', /^not decided: its project was removed/.test(gone.undecided.text) && !!gone.undecided.v.notApplied, gone.undecided.text);
  const q = T(committed, 'queued'), u = T(committed, 'uncertain'), dl = T(committed, 'delivered');
  check('CV8 the other row states of a removed project\'s final request: queued → "telling the session…", uncertain → not "check the session", delivered before the removal → "the session has been told"', /telling the session…$/.test(q.text) && !OPEN.test(u.text) && /not resumed into another project/.test(u.text) && /the session has been told$/.test(dl.text), { q: q.text, u: u.text, dl: dl.text });
  // Deleted and NOT re-added ('gone', no row under the id).
  regTop.deleteProject(P.id);
  const g = T(committed, 'failed');
  check('CV9 project deleted and not re-added: the committed request reads the same "removed / not sent"', NOT_SENT.test(g.text) && !OPEN.test(g.text), g.text);

  /* The per-session pending limit must not count requests already closed (r9 open item). */
  P = mk();
  const capSess = 'sess-cv-cap';
  const olds = []; for (let i = 0; i < acc.MAX_PENDING_PER_SESSION; i++) olds.push(raise(capSess, `C${i}`));
  regTop.deleteProject(P.id); P = mk();
  const closed = acc.markNotApplied(olds.map((r) => ({ id: r.id, reason: 'its project was removed from Orchard', text: 'removed' })), 'removed');
  let capErr = null, capRec = null; try { capRec = raise(capSess, 'NEW'); } catch (e) { capErr = e.message; }
  check('CV10 the per-session limit does NOT count requests already closed as removed: the session can ask again in the re-added project', closed.length === acc.MAX_PENDING_PER_SESSION && !!capRec && !capErr, { closed: closed.length, capErr: capErr?.slice(0, 120) ?? null });
  let capErr2 = null; try { for (let i = 0; i < acc.MAX_PENDING_PER_SESSION; i++) raise(capSess, `D${i}`); } catch (e) { capErr2 = e.message; }
  const openNow = acc.listAccessForSession(capSess).filter((r) => acc.classOf(r).kind === 'undecided').length;
  check('CV10b anti-regression: the limit still holds for requests genuinely waiting (exactly MAX open, then refused)', /waiting for the user/.test(capErr2 ?? '') && openNow === acc.MAX_PENDING_PER_SESSION, { capErr2: capErr2?.slice(0, 120) ?? null, openNow });
  regTop.deleteProject(P.id);
  try { fs.rmSync(cvDir, { recursive: true, force: true }); } catch { /* */ }
}

/* ================================================================ L — loopback only, even from a hand-edited registry */
console.log('\n--- L: docker create publishes on 127.0.0.1 only');
{
  const cm = await import(need('src/server/container-manager.ts'));
  const p = { id: 'lp', name: 'LP', hostPath: os.tmpdir(), isolation: 'container', settings: { container: { ports: [
    { hostPort: '0.0.0.0:4000', containerPort: 3000 }, { hostPort: 4001, containerPort: 3001 }, { hostPort: 80, containerPort: 80 },
    { hostPort: 4002.5, containerPort: 1 }, { hostPort: 4003, containerPort: '3003 -p 0.0.0.0:5000:5000' } ] } } };
  const a = cm.createArgs(p, 'n', 'img', {});
  const ps = a.flatMap((v, i) => (v === '-p' ? [a[i + 1]] : []));
  check('L1 only well-formed publishes reach `docker create -p`, each on 127.0.0.1', JSON.stringify(ps) === JSON.stringify(['127.0.0.1:4001:3001']), ps);
  check('L2 no publish-all / network flag is ever composed', !a.includes('-P') && !a.includes('--publish-all') && !a.includes('--network'), a.filter((x) => /^-P$|publish-all|--network/.test(x)));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
process.exit(fail ? 1 : 0);
