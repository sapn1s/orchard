/**
 * Targeted live reproduction for the two container-related HIGH findings.
 * Requires docker. Creates a throwaway container project, kills it in several
 * ways, and asserts the server behaves honestly. Cleans up everything it makes.
 *
 *   npm run verify:container
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_CONTAINER_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ctest-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ctest-work-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
server.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
server.stderr.on('data', d => process.stderr.write(`  [server!] ${d}`));

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

function events(ws) { const a = []; ws.on('message', (m) => a.push(JSON.parse(String(m)))); return a; }
const waitEv = async (a, pred, ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = a.find(pred); if (h) return h; await sleep(150); } return null; };

let cname = null;
try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(250); } }

  fs.writeFileSync(path.join(WORK, 'README.md'), 'ctest\n');
  const created = await api('/api/projects', 'POST', { hostPath: WORK, name: 'CTest', isolation: 'container' });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const pid = created.body.project.id;
  cname = `claude-station-${pid}`;
  console.log(`project=${pid} container=${cname} work=${WORK}`);

  /* ---------------- #2: a session whose container dies must die loudly ---- */
  console.log('\n=== #2: container killed under a live session ===');
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ev1 = events(ws1);
  await new Promise((r, j) => { ws1.once('open', r); ws1.once('error', j); });
  ws1.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'Reply with exactly: ok' }));
  const init = await waitEv(ev1, e => e.t === 'session-init');
  if (!init) throw new Error(`precondition failed: container session never initialised. events=${JSON.stringify(ev1.slice(-6))}`);
  const end1 = await waitEv(ev1, e => e.t === 'turn-end');
  check('PRECONDITION: a container session really started and answered', !!end1 && end1.subtype === 'success', `cwd=${init.cwd} subtype=${end1?.subtype}`);

  const before = ev1.length;
  execFileSync('docker', ['rm', '-f', cname], { stdio: 'pipe' });
  console.log(`  (killed ${cname})`);
  const fatal = await waitEv(ev1.slice(before), e => e.t === 'error' && e.fatal, 60000)
    ?? await waitEv(ev1, e => e.t === 'error' && e.fatal, 30000);
  const closed = await waitEv(ev1, e => e.t === 'session-closed', 30000);
  check(
    'a killed container tears the session DOWN (fatal error + session-closed), not just a warning',
    !!fatal && !!closed,
    `fatal=${JSON.stringify(fatal?.message?.slice(0, 120) ?? null)}; session-closed reason=${JSON.stringify(closed?.reason?.slice(0, 120) ?? null)}`,
  );
  const n = ev1.length;
  ws1.send(JSON.stringify({ type: 'send', prompt: 'are you still there?' }));
  await sleep(1500);
  const after = ev1.slice(n);
  const acked = after.find(e => e.t === 'ack' && e.of === 'send');
  const errored = after.find(e => e.t === 'error');
  check(
    'a later turn on a dead session FAILS LOUDLY instead of being acked as success',
    !acked && !!errored,
    `ack=${JSON.stringify(acked ?? null)}; error=${JSON.stringify(errored?.message ?? null)}`,
  );
  const listed = await api('/api/sessions');
  check('the dead session was released, not retained forever', listed.body.sessions.length === 0, `GET /api/sessions -> ${JSON.stringify(listed.body.sessions)}`);
  ws1.close();
  await sleep(500);
  check('the server survived all of that', (await api('/api/health')).status === 200, `GET /api/health -> ${(await api('/api/health')).status}`);

  /* ---------------- #3: destructive container ops vs live sessions -------- */
  console.log('\n=== #3: POST /container/start must not destroy a live session ===');
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ev2 = events(ws2);
  await new Promise((r, j) => { ws2.once('open', r); ws2.once('error', j); });
  ws2.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'Reply with exactly: ok' }));
  const init2 = await waitEv(ev2, e => e.t === 'session-init');
  const end2 = await waitEv(ev2, e => e.t === 'turn-end');
  if (!init2 || end2?.subtype !== 'success') throw new Error('precondition failed: second container session did not come up');
  check('PRECONDITION: a second container session is live', true, `sdk session=${init2.sessionId}`);

  // An ordinary settings edit that makes the live container "drifted".
  const patched = await api(`/api/projects/${pid}`, 'PATCH', { container: { memoryMb: 4096 } });
  const st = await api(`/api/projects/${pid}/container/status`);
  check('PRECONDITION: the live container is now drifted (so ensure would recreate it)', st.body.drifted === true, `state=${st.body.state} drifted=${st.body.drifted} reasons=${JSON.stringify(st.body.driftReasons)}`);

  const start1 = await api(`/api/projects/${pid}/container/start`, 'POST');
  check(
    'POST /container/start REFUSES with 409 while a session is live (it used to silently kill it and return "running")',
    start1.status === 409 && start1.body.code === 'live-sessions' && start1.body.liveSessions?.length === 1,
    `HTTP ${start1.status} ${JSON.stringify(String(start1.body.error).slice(0, 160))} live=${JSON.stringify(start1.body.liveSessions)}`,
  );
  const nn = ev2.length;
  await sleep(1000);
  check(
    'and the live session is untouched — no exit 137, no session-closed',
    !ev2.slice(nn).some(e => e.t === 'session-closed' || (e.t === 'error' && e.fatal)),
    `events since the refused start: ${JSON.stringify(ev2.slice(nn).map(e => e.t))}`,
  );

  const start2 = await api(`/api/projects/${pid}/container/start?force=1`, 'POST');
  check(
    'with ?force=1 it proceeds AND reports which live sessions it destroyed',
    start2.status === 200 && Array.isArray(start2.body.forcedOverLiveSessions) && start2.body.forcedOverLiveSessions.length === 1,
    `HTTP ${start2.status} state=${start2.body.state} forcedOverLiveSessions=${JSON.stringify(start2.body.forcedOverLiveSessions)}`,
  );
  ws2.close();
  await sleep(1500);

  /* ---------------- #6: deleting a project must not orphan the container -- */
  /* -------- #7: container defaults to bypassPermissions, but overridable ---- */
  console.log('\n=== #7: container isolation defaults to bypassPermissions (overridable) ===');
  // Reading a file OUTSIDE the container cwd needs approval in `default` mode —
  // the same probe verify.ts uses on the host. In bypassPermissions it does not.
  const PROBE = 'Read the file /etc/hostname and tell me exactly what it contains. Do not use any other method or tool.';

  // (a) No explicit permissionMode → container default.
  const wsP = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const evP = events(wsP);
  await new Promise((r, j) => { wsP.once('open', r); wsP.once('error', j); });
  wsP.send(JSON.stringify({ type: 'start', projectId: pid, prompt: PROBE }));
  const ecDefault = await waitEv(evP, e => e.t === 'effective-config', 240000);
  check(
    'effective-config for a container session with no override shows bypassPermissions + source=container-default',
    !!ecDefault && ecDefault.effective.permissionMode === 'bypassPermissions' && ecDefault.permissionModeSource === 'container-default' && ecDefault.projectDefault.permissionMode === 'default',
    `effective.permissionMode=${ecDefault?.effective?.permissionMode} source=${ecDefault?.permissionModeSource} projectDefault=${ecDefault?.projectDefault?.permissionMode}`,
  );
  const endP = await waitEv(evP, e => e.t === 'turn-end', 240000);
  const asksDefault = evP.filter(e => e.t === 'approval-request');
  check(
    'a tool that normally needs approval runs with ZERO approval requests under the container default',
    endP?.subtype === 'success' && asksDefault.length === 0,
    `approval-requests=${asksDefault.length}, subtype=${endP?.subtype}, reply=${JSON.stringify(String(evP.filter(e => e.t === 'text' && !e.agentId).map(e => e.text).join(' ')).trim().slice(0, 80))}`,
  );
  wsP.send(JSON.stringify({ type: 'close' }));
  wsP.close();
  await sleep(500);

  // (b) Explicit override permissionMode='default' → prompts fire (proves it is
  // a default, not a lock).
  const wsO = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const evO = events(wsO);
  await new Promise((r, j) => { wsO.once('open', r); wsO.once('error', j); });
  const asksO = [];
  wsO.on('message', (m) => { const e = JSON.parse(String(m)); if (e.t === 'approval-request') { asksO.push(e); wsO.send(JSON.stringify({ type: 'approval-response', requestId: e.requestId, allow: false, message: 'denied by test' })); } });
  wsO.send(JSON.stringify({ type: 'start', projectId: pid, prompt: PROBE, overrides: { permissionMode: 'default' } }));
  const ecOverride = await waitEv(evO, e => e.t === 'effective-config', 240000);
  check(
    'an explicit permissionMode=default override is respected in a container (source=session-override)',
    !!ecOverride && ecOverride.effective.permissionMode === 'default' && ecOverride.permissionModeSource === 'session-override',
    `effective.permissionMode=${ecOverride?.effective?.permissionMode} source=${ecOverride?.permissionModeSource}`,
  );
  const endO = await waitEv(evO, e => e.t === 'turn-end', 240000);
  check(
    'and approvals DO fire under the override — the container default is overridable, not locked',
    asksO.length > 0,
    `approval-requests=${asksO.length} (first tool=${asksO[0]?.toolName}), subtype=${endO?.subtype}`,
  );
  wsO.send(JSON.stringify({ type: 'close' }));
  wsO.close();
  await sleep(500);

  // (c) The override never touched the registry on disk.
  const regOnDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8'));
  const projOnDisk = regOnDisk.projects.find(p => p.id === pid);
  check(
    'neither the container default nor the override leaked into the registry',
    projOnDisk.settings.permissionMode === 'default',
    `registry.json settings.permissionMode=${JSON.stringify(projOnDisk.settings.permissionMode)} (still the stored default; bypass is per-session only)`,
  );

  // (d) A DIRECT project with no override still prompts — the host default is unchanged.
  const dwork = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ctest-direct-'));
  fs.writeFileSync(path.join(dwork, 'README.md'), 'x\n');
  const dproj = (await api('/api/projects', 'POST', { hostPath: dwork, name: 'DirectPerm', isolation: 'direct' })).body.project;
  const wsD = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const evD = events(wsD);
  await new Promise((r, j) => { wsD.once('open', r); wsD.once('error', j); });
  const asksD = [];
  wsD.on('message', (m) => { const e = JSON.parse(String(m)); if (e.t === 'approval-request') { asksD.push(e); wsD.send(JSON.stringify({ type: 'approval-response', requestId: e.requestId, allow: false })); } });
  wsD.send(JSON.stringify({ type: 'start', projectId: dproj.id, prompt: PROBE }));
  const ecDirect = await waitEv(evD, e => e.t === 'effective-config', 240000);
  const endD = await waitEv(evD, e => e.t === 'turn-end', 240000);
  check(
    'a DIRECT project with no override still defaults to prompting (source=project, approvals fire)',
    ecDirect?.effective?.permissionMode === 'default' && ecDirect?.permissionModeSource === 'project' && asksD.length > 0,
    `effective.permissionMode=${ecDirect?.effective?.permissionMode} source=${ecDirect?.permissionModeSource} approval-requests=${asksD.length}`,
  );
  wsD.send(JSON.stringify({ type: 'close' }));
  wsD.close();
  await api(`/api/projects/${dproj.id}`, 'DELETE');
  fs.rmSync(dwork, { recursive: true, force: true });
  await sleep(500);

  console.log('\n=== #6: project delete tears the container down ===');
  const upBefore = execFileSync('docker', ['ps', '-a', '--filter', `name=^${cname}$`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  check('PRECONDITION: the container exists before the delete', upBefore === cname, `docker ps -a -> ${JSON.stringify(upBefore)}`);
  const del = await api(`/api/projects/${pid}`, 'DELETE');
  const upAfter = execFileSync('docker', ['ps', '-a', '--filter', `name=^${cname}$`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  check(
    'DELETE /api/projects/:id removes the container instead of orphaning it',
    del.status === 200 && del.body.deleted === true && upAfter === '',
    `HTTP ${del.status} deleted=${del.body.deleted} container=${JSON.stringify(del.body.container?.state ?? del.body.container)}; docker ps -a after -> ${JSON.stringify(upAfter)}; keptSessionHistory=${del.body.keptSessionHistory}`,
  );
  const orph = await api('/api/containers/orphans');
  check('the orphan sweep endpoint answers and lists none for this project', orph.status === 200 && !orph.body.orphans.some(o => o.name === cname), `orphans=${JSON.stringify(orph.body.orphans.map(o => o.name))}`);
  if (del.body.keptSessionHistory) fs.rmSync(del.body.keptSessionHistory, { recursive: true, force: true });
} catch (err) {
  fail++;
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  try { if (cname) execFileSync('docker', ['rm', '-f', cname], { stdio: 'pipe' }); } catch { /* gone */ }
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  await sleep(1500);
  try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-ctest`), { recursive: true, force: true });
  // #7(d) ran a DIRECT-isolation session in the real store (the CLI writes there
  // regardless of CLAUDE_PROJECTS_DIR), leaving a `-tmp-cs-ctest-direct-*` dir.
  const store = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(store).filter((n) => n.startsWith('-tmp-cs-ctest-direct-'))) {
    fs.rmSync(path.join(store, d), { recursive: true, force: true });
  }
  console.log(`\n============ container checks: ${pass} passed, ${fail} failed ============`);
  process.exit(fail ? 1 : 0);
}
