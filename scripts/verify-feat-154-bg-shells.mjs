/**
 * FEAT-154 (round 6) — background SHELLS do not make a session "working"; they
 * are listed in its running strip and can be stopped.
 *
 *   node scripts/verify-feat-154-bg-shells.mjs
 *
 * The report: session 7f7e39a1 read light-blue "running" permanently. Ground
 * truth: an ADOPTED bridge (the server had restarted) whose engine level listed
 * five `local_bash` lanes — never-ending `until grep …; do sleep` pollers — and
 * no agent. Round 5's `working` counted any background lane, so the session was
 * "working" for as long as the pollers lived (36h), while its running strip was
 * EMPTY (the lanes were born under the previous server, so no row existed).
 *
 * This drives the REAL server end to end on an ISOLATED second instance (free
 * port, scratch data dir, scratch store; the scripted fake CLI from BUG-187),
 * and crosses a REAL server restart so the adopted-bridge shape is the genuine
 * article, not a stub:
 *   S1  the 7f7e39a1 shape: 5 local_bash lanes (the REAL task ids), no agent
 *   S2  the 4846de18 shape: 1 local_bash lane (a dev server)
 *   S3  control (round 5, 4ea3d0d2 shape): 1 live background SUBAGENT → working
 *   S4  control (round 3): idle-alive, no lanes → not working
 * then stops one of S1's commands through the new strip control's path
 * (`stop-task` → the engine's `stop_task`) and checks it leaves.
 *
 * Every process it starts is killed by pid (servers, brokers, fake CLIs);
 * :4317 and the real service are never touched.
 */
import {
  makeWorld, bootServer, stopServer, registerProject, waitFor, startFakeSession,
  health, cleanupWorld, fakeLog, sleep, makeChecker, hostRecords, pidAlive,
} from './lib/bug-187-harness.mjs';

const k = makeChecker('F154r6');
const POLLERS = ['b5tblidkz', 'bdyk8xzib', 'b0s9i9e1l', 'b0tfqhu9g', 'bipc0pi2p']; // the REAL 7f7e39a1 lane ids
const directive = (lanes) => `[[fake:${JSON.stringify(lanes.map(([id, type]) => ({ op: 'lane_start', id, type })))} ]]`; // the space: the fake's non-greedy match stops at the first "]]"

const liveRow = async (srv, sdk) => ((await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions/live`)).json()).sessions ?? []).find((x) => x.sessionId === sdk) ?? null;
const running = async (srv, sdk) => (await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${encodeURIComponent(sdk)}/running`)).json()).snapshot;
async function stopReq(srv, sid, taskId, { origin, ctype = 'application/json' } = {}) {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${encodeURIComponent(sid)}/running/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST', headers: { 'content-type': ctype, ...(origin ? { origin } : {}) }, body: '{}',
  });
  let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: body ?? {} };
}
const summary = (snap) => (snap?.running ?? []).map((r) => ({ id: r.id, row: r.row, label: r.label, bg: r.background ?? null, startedAt: r.startedAt != null }));

const w = makeWorld('f154r6');
let code = 1;
try {
  const A = await bootServer(w);
  const pid = await registerProject(A, w);
  const S = {};
  S.s1 = await startFakeSession(A, w, pid, `pollers ${directive(POLLERS.map((id) => [id, 'local_bash']))}`);
  S.s2 = await startFakeSession(A, w, pid, `dev server ${directive([['bgj7hkeu4', 'local_bash']])}`);
  S.s3 = await startFakeSession(A, w, pid, `subagent ${directive([['a4ea3d0d2sub', 'local_agent']])}`);
  S.s4 = await startFakeSession(A, w, pid, 'idle, nothing in the background');
  for (const s of Object.values(S)) s.sdk = s.host.sdkSessionId ?? `fake187-${s.cli}`;
  // Let each first turn finish (result) so the MAIN turn is over everywhere.
  await waitFor(async () => {
    const rows = await Promise.all(Object.values(S).map((s) => liveRow(A, s.sdk)));
    return rows.every((r) => r && r.liveness && r.liveness.running === false);
  }, 30_000);

  console.log('\n=== before the restart (lanes born under THIS server: rows exist) ===');
  const a1 = await liveRow(A, S.s1.sdk);
  const a3 = await liveRow(A, S.s3.sdk);
  const sA1 = await running(A, S.s1.sdk);
  k.check('S1 (5 shell pollers, no agent) ⇒ working=false while alive (must-FAIL on round 5: true)',
    a1?.liveness?.live === true && a1.liveness.working === false, a1?.liveness ?? null);
  k.check('S3 control (live background subagent, main turn ended) ⇒ working=true (round-5 guarantee)',
    a3?.liveness?.running === false && a3.liveness.working === true, a3?.liveness ?? null);
  const a4 = await liveRow(A, S.s4.sdk);
  k.check('S4 control (idle-alive, no lanes) ⇒ working=false (round-3 guarantee)',
    a4?.liveness?.live === true && a4.liveness.working === false, a4?.liveness ?? null);
  k.check('S1 running strip lists all 5 shells as background tool rows',
    sA1.running.length === 5 && sA1.running.every((r) => r.row === 'tool' && r.background === true), summary(sA1));

  console.log('\n=== restart the second instance (SIGTERM → survivors) and let the new server ADOPT them ===');
  for (const s of Object.values(S)) s.c.close();
  await stopServer(A);
  await sleep(2_000);
  const B = await bootServer(w);
  const adopted = await waitFor(async () => {
    const hs = (await health(B))?.sessions ?? [];
    // S4 has no background work, so the shutdown hand-off lets it end (product
    // behaviour: nothing holds its drain) — only S1..S3 survive to be adopted.
    const mine = [S.s1, S.s2, S.s3].map((s) => hs.find((x) => x.stationSessionId === s.station));
    return mine.every((x) => x && x.adopted === true && x.adoptState !== 'pending') ? mine : null;
  }, 40_000);
  k.check('the three sessions with background work were adopted by the restarted server',
    !!adopted, (adopted ?? []).map((x) => x?.adoptState ?? null));
  await sleep(1_500);

  const b1 = await liveRow(B, S.s1.sdk);
  const b2 = await liveRow(B, S.s2.sdk);
  const b3 = await liveRow(B, S.s3.sdk);
  k.check('REAL 7f7e39a1 shape (adopted, 5 shell pollers, no agent) ⇒ working=false, live=true (must-FAIL on round 5: true)',
    b1?.liveness?.live === true && b1.liveness.running === false && b1.liveness.working === false, b1?.liveness ?? null);
  k.check('REAL 4846de18 shape (adopted, dev server only) ⇒ working=false (must-FAIL on round 5: true)',
    b2?.liveness?.live === true && b2.liveness.working === false, b2?.liveness ?? null);
  k.check('control: adopted session with a live background SUBAGENT ⇒ working=true (round 5 kept)',
    b3?.liveness?.working === true, b3?.liveness ?? null);

  const sB1 = await running(B, S.s1.sdk);
  const sB2 = await running(B, S.s2.sdk);
  k.check('7f7e39a1 shape: the strip LISTS all 5 inherited shells (must-FAIL on round 5: running:[] — invisible), labelled "background command", with an age',
    sB1.running.length === 5 && POLLERS.every((id) => sB1.running.some((r) => r.id === id))
      && sB1.running.every((r) => r.row === 'tool' && r.label === 'background command' && r.background === true && Number.isFinite(r.startedAt)),
    summary(sB1));
  k.check('4846de18 shape: the dev server is listed in its strip',
    sB2.running.length === 1 && sB2.running[0].id === 'bgj7hkeu4' && sB2.running[0].row === 'tool', summary(sB2));
  k.check('no main row: the session is not claiming a turn', !sB1.running.some((r) => r.row === 'main'), sB1.turn);

  console.log('\n=== round 7: stop is addressed by (session, task) and routed to the OWNING bridge — no socket attached ===');
  // Nothing is attached to S1 on the new server: this is the adopted-after-restart
  // case a VIEWING tab is in (its strip is filled by the HTTP poll). Round 6's
  // ws-only stop answered "no session on this socket" here and never reached the engine.
  const r1 = await stopReq(B, S.s1.station, 'b5tblidkz');
  const engineSaw = await waitFor(() => fakeLog(w, S.s1.cli).find((e) => e.ev === 'stop_task' && e.lane === 'b5tblidkz'), 10_000);
  const gone = await waitFor(async () => { const s = await running(B, S.s1.sdk); return s.running.length === 4 && !s.running.some((r) => r.id === 'b5tblidkz') ? s : null; }, 15_000);
  k.check('ADOPTED bridge after a real restart, NO socket attached: stop is 200 ok and reaches the ENGINE as stop_task for exactly that id (must-FAIL on round 6)',
    r1.status === 200 && r1.body.ok === true && !!engineSaw, { reply: r1, engineSaw: !!engineSaw });
  k.check('after the engine ends it, the stopped command leaves the strip; the other 4 stay',
    !!gone, summary(gone ?? await running(B, S.s1.sdk)));
  // A NON-OPEN session addressed by its SDK id (the other half of the dual lookup):
  // S2's dev server, stopped with no socket anywhere near S2.
  const r2 = await stopReq(B, S.s2.sdk, 'bgj7hkeu4');
  const saw2 = await waitFor(() => fakeLog(w, S.s2.cli).find((e) => e.ev === 'stop_task' && e.lane === 'bgj7hkeu4'), 10_000);
  const gone2 = await waitFor(async () => { const s = await running(B, S.s2.sdk); return s.running.length === 0 ? s : null; }, 15_000);
  k.check('a NON-OPEN session addressed by its SDK id: stop reaches THAT session\'s engine and its strip empties (must-FAIL on round 6: no session id at all)',
    r2.status === 200 && r2.body.ok === true && !!saw2 && !!gone2, { reply: r2, engineSaw: !!saw2 });
  // Cross-session: S1's task addressed to S2 is refused and never forwarded to either engine.
  const r3 = await stopReq(B, S.s2.station, 'bdyk8xzib');
  k.check('a task addressed to the WRONG session is refused 409 not-running and forwarded to no engine',
    r3.status === 409 && r3.body.reason === 'not-running'
      && !fakeLog(w, S.s2.cli).some((e) => e.ev === 'stop_task' && e.lane === 'bdyk8xzib')
      && !fakeLog(w, S.s1.cli).some((e) => e.ev === 'stop_task' && e.lane === 'bdyk8xzib'), r3);
  const r4 = await stopReq(B, S.s1.station, 'not-a-task');
  k.check('an id the session is not running is refused 409 (never forwarded)',
    r4.status === 409 && !fakeLog(w, S.s1.cli).some((e) => e.ev === 'stop_task' && e.lane === 'not-a-task'), r4);
  // The owning bridge is GONE: S4 had no background work, so it ended at the restart.
  const r5 = await stopReq(B, S.s4.station, 'anything');
  k.check('the owning bridge is GONE ⇒ 404 reason:no-bridge with a plain explanation (not a silent no-op)',
    r5.status === 404 && r5.body.reason === 'no-bridge' && /not driving that session/.test(r5.body.error ?? ''), r5);
  const r6 = await stopReq(B, S.s1.station, 'bdyk8xzib', { origin: 'https://evil.example' });
  const r7 = await stopReq(B, S.s1.station, 'bdyk8xzib', { ctype: 'text/plain' });
  k.check('destructive route is guarded: a foreign Origin is 403 and a text/plain POST is 415, and neither reaches the engine',
    r6.status === 403 && r7.status === 415 && !fakeLog(w, S.s1.cli).some((e) => e.ev === 'stop_task' && e.lane === 'bdyk8xzib'), { origin: r6.status, textPlain: r7.status });

  console.log('\n=== stop the other 4: the adopted bridge becomes idle-alive with NO lanes (the round-3 shape) ===');
  for (const id of POLLERS.slice(1)) await stopReq(B, S.s1.station, id);
  const emptied = await waitFor(async () => { const s = await running(B, S.s1.sdk); return s.running.length === 0 ? s : null; }, 20_000);
  const after = await liveRow(B, S.s1.sdk);
  k.check('all stopped ⇒ the strip is empty and the session is still not working (never true once the lanes end)',
    !!emptied && (after === null || after.liveness?.working === false), { strip: summary(emptied), liveness: after?.liveness ?? null });
  code = k.results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error(`FATAL: ${err?.stack ?? err}`);
  code = 1;
} finally {
  const pids = hostRecords(w).flatMap((h) => [h.hostPid, h.claudePid]);
  await cleanupWorld(w);
  const left = pids.filter((p) => pidAlive(p));
  console.log(`\ncleanup: ${pids.length} broker/CLI pids reaped by pid, ${left.length} left alive${left.length ? ` (${left.join(',')})` : ''}`);
  if (left.length) code = 1;
}
const passed = k.results.filter((r) => r.ok).length;
console.log(`\n${passed}/${k.results.length} checks passed`);
process.exit(code);
