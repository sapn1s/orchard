/**
 * FEAT-154 (round 7) — REAL-CLI check of the strip's stop control.
 *
 *   node scripts/verify-feat-154-real-stop.mjs
 *
 * Uses the REAL `claude` CLI (the SDK's bundled binary, haiku, real credentials
 * via an isolated config dir) on an ISOLATED second instance (free port, scratch
 * data dir + store). It:
 *   1. starts a real session that launches a long background shell
 *      (`run_in_background`), marked with a unique token so its PIDs can be found
 *      by /proc ground truth (cmdline + ancestry under the session's CLI pid);
 *   2. RESTARTS the server, so the session is an ADOPTED bridge with no socket
 *      attached (the 7f7e39a1 shape), and reads whether the real CLI re-declared
 *      its level on the repeated initialize (`working` must stay false, and the
 *      shell must be listed in the strip);
 *   3. presses stop through the real HTTP API, addressed by (session, task);
 *   4. confirms by PID that the shell processes are GONE and the row left.
 *
 * Costs a few cents of haiku. Every process it starts is killed by pid.
 */
import * as fs from 'node:fs';
import {
  makeWorld, bootServer, stopServer, registerProject, openWs, waitFor, health,
  cleanupWorld, sleep, makeChecker, hostRecords, hostFor, pidAlive,
} from './lib/bug-187-harness.mjs';

const k = makeChecker('F154r7-real');
const MARK = `f154r7mark${Date.now().toString(36)}`;
const running = async (srv, sid) => (await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${encodeURIComponent(sid)}/running`)).json()).snapshot;
const liveRow = async (srv, sdk) => ((await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions/live`)).json()).sessions ?? []).find((x) => x.sessionId === sdk) ?? null;

function ppidOf(pid) { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch { return 0; } }
function descends(pid, ancestor) { for (let p = pid, i = 0; p > 1 && i < 64; p = ppidOf(p), i++) if (p === ancestor) return true; return false; }
/** Ground truth: every live process whose cmdline carries the marker AND that descends from the session's CLI. */
function markedPids(cliPid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    if (cmd.includes(MARK) && descends(Number(d), cliPid)) out.push({ pid: Number(d), cmd: cmd.slice(0, 120) });
  }
  // …plus every DESCENDANT of a marked shell (the `sleep 900` child carries no marker).
  const roots = out.map((o) => o.pid);
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || roots.includes(Number(d))) continue;
    if (roots.some((r) => descends(Number(d), r))) {
      let cmd = ''; try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
      out.push({ pid: Number(d), cmd: cmd.slice(0, 120), child: true });
    }
  }
  return out;
}

const w = makeWorld('f154r7real', { real: true });
let code = 1;
try {
  const A = await bootServer(w);
  const pid = await registerProject(A, w);
  const c = await openWs(A);
  let ack = null;
  for (let i = 0; i < 40 && !ack; i++) {
    c.send({
      type: 'start', projectId: pid,
      overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
      prompt: `Call the Bash tool exactly once with run_in_background set to true and this exact command: sleep 900; echo ${MARK}\nDo not wait for it, do not check on it, and do not use any other tool. Then reply with the single word STARTED.`,
    });
    ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'start') ?? (c.events.some((e) => e.t === 'error' && e.code === 'runtime-check-pending') ? 'retry' : null), 90_000);
    if (ack === 'retry') { ack = null; c.events.length = 0; await sleep(1500); }
  }
  if (!ack) throw new Error(`start never acked: ${JSON.stringify(c.events.slice(-4))}`);
  const station = ack.stationSessionId;
  const host = await waitFor(() => { const h = hostFor(w, station); return h?.claudePid ? h : null; }, 30_000);
  if (!host) throw new Error('no broker record');
  const cli = host.claudePid;
  const before = await waitFor(() => { const p = markedPids(cli); return p.length ? p : null; }, 120_000);
  k.check('the REAL CLI launched the background shell (found by /proc cmdline marker + ancestry under the CLI pid)',
    !!before, before ?? []);
  // Let the main turn finish.
  await waitFor(() => c.events.find((e) => e.t === 'turn-end' || e.t === 'result'), 120_000);
  await sleep(2_000);
  const sdk = (await waitFor(() => hostFor(w, station)?.sdkSessionId ?? null, 20_000)) ?? station;
  c.close();

  console.log('\n=== restart: the real session becomes an ADOPTED bridge, no socket attached ===');
  await stopServer(A);
  await sleep(2_000);
  const B = await bootServer(w);
  const adopted = await waitFor(async () => { const x = ((await health(B))?.sessions ?? []).find((s) => s.stationSessionId === station); return x && x.adoptState !== 'pending' ? x : null; }, 60_000);
  k.check('the restarted server adopted the real session', !!adopted && adopted.adopted === true, adopted ? { adoptState: adopted.adoptState } : null);
  const snap = await waitFor(async () => { const s = await running(B, station); return s.running.some((r) => r.row === 'tool') ? s : null; }, 30_000);
  const shellRow = snap?.running.find((r) => r.row === 'tool') ?? null;
  const lv = await liveRow(B, sdk);
  k.check('adopted real session: the background shell is LISTED in the strip as a background tool row',
    !!shellRow && shellRow.background === true, snap ? snap.running.map((r) => ({ id: r.id, row: r.row, label: r.label, bg: r.background })) : null);
  k.check('adopted real session with only a shell: working=false (the real CLI\'s level classifies it as a shell, not an agent)',
    lv?.liveness?.live === true && lv.liveness.working === false, lv?.liveness ?? null);

  console.log('\n=== press stop through the real HTTP API, addressed by (session, task) ===');
  const pidsBefore = markedPids(cli);
  const r = await fetch(`http://127.0.0.1:${B.port}/api/sessions/${encodeURIComponent(station)}/running/${encodeURIComponent(shellRow?.id ?? 'none')}/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await r.json().catch(() => ({}));
  k.check('stop is accepted (200 ok) for the adopted session with no socket attached', r.status === 200 && body.ok === true, { status: r.status, body });
  const dead = await waitFor(() => (pidsBefore.length && pidsBefore.every((p) => !pidAlive(p.pid)) ? true : null), 30_000);
  k.check('GROUND TRUTH: every marked shell PID is gone after stop (checked by pid, not by the strip)',
    !!dead, { pidsBefore: pidsBefore.map((p) => p.pid), stillAlive: pidsBefore.filter((p) => pidAlive(p.pid)).map((p) => p.pid) });
  const left = await waitFor(async () => { const s = await running(B, station); return s.running.some((x) => x.id === shellRow?.id) ? null : s; }, 30_000);
  k.check('the stopped shell leaves the strip', !!left, left ? left.running.map((x) => x.id) : null);
  k.check('the session CLI itself is still alive (stop ended one task, not the session)', pidAlive(cli), { cli });
  code = k.results.every((x) => x.ok) ? 0 : 1;
} catch (err) {
  console.error(`FATAL: ${err?.stack ?? err}`);
  code = 1;
} finally {
  const pids = hostRecords(w).flatMap((h) => [h.hostPid, h.claudePid]);
  await cleanupWorld(w);
  const leftAlive = pids.filter((p) => pidAlive(p));
  const strays = (() => { try { return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(MARK); } catch { return false; } }); } catch { return []; } })();
  for (const s of strays) { try { process.kill(Number(s), 'SIGKILL'); } catch { /* gone */ } }
  console.log(`\ncleanup: ${pids.length} broker/CLI pids reaped by pid, ${leftAlive.length} left alive; ${strays.length} marked stray(s) killed by pid`);
  if (leftAlive.length) code = 1;
}
console.log(`\n${k.results.filter((r) => r.ok).length}/${k.results.length} checks passed`);
process.exit(code);
