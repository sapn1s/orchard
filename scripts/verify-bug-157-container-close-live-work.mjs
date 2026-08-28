#!/usr/bin/env node
/**
 * BUG-157 — CONTAINER sessions must not kill live work. REAL docker container +
 * REAL `claude` CLI (the only faithful way to exercise the container-specific
 * paths: `close()` EOFs stdin into the *container* CLI and a `reapExec` HARD-KILLS
 * the tagged `docker exec` — there is no survival-broker grace here, unlike a
 * direct session, which is exactly why the ticket's headline is CONTAINER work
 * dying). Modelled on scripts/verify-container.mjs (real container project, real
 * server on a free port, scratch CLAUDE_STATION_DATA) and the background-agent
 * dispatch of scripts/verify-close-background-detach.mjs.
 *
 * WHAT IS PROVEN HERE (reliably drivable with the real CLI):
 *   A. SOCKET-DROP WITH A LIVE BACKGROUND AGENT — a container session dispatches a
 *      real background subagent (a long heartbeat into the mounted cwd), the turn
 *      ends, then the socket DROPS. The server must DETACH, not close: the exec
 *      must stay alive (its tagged process still in the container), the background
 *      agent must run to completion, and the container exec must NOT be reaped
 *      mid-work. This is the socket-drop path releaseSocketSession() routes through
 *      for a container session with unsettled work.
 *   B. NON-VACUITY — a genuinely finished container session (a turn with no
 *      background work) still CLOSES and REAPS its exec on the socket drop. Proves
 *      the fuse/close is not disabled for containers.
 *
 * HONEST LIMIT: the container-specific empty-level QUIET gate (#containerQuietToClose)
 * and the reapExec RESCHEDULE fire only when the engine's background LEVEL is
 * wrongly empty while work is live — the round-1 open question, which the real CLI
 * does not emit on demand. Those cannot be driven frame-precisely with a real CLI;
 * the SHARED mechanism the container fuse consults (busy pinning on a woken turn,
 * revival visibility, workLifetime) is proven deterministically at that exact code
 * layer in scripts/verify-bug-157-woken-turn-and-revival.mjs.
 *
 * SAFETY: free port, scratch dataDir, throwaway container removed at the end,
 * every process killed BY PID/name we created. :4317 / the real service / scopes
 * not ours untouched.
 *
 * Usage: node scripts/verify-bug-157-container-close-live-work.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b157c-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b157c-work-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`); ok ? pass++ : (fail++, failures.push(n)); };

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const PORT = Number(process.env.VERIFY_B157C_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += String(d); if (process.env.VERIFY_B157C_DEBUG) process.stdout.write(`  [server] ${d}`); });
server.stderr.on('data', (d) => { serverLog += String(d); if (process.env.VERIFY_B157C_DEBUG) process.stderr.write(`  [server!] ${d}`); });

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function events(ws) { const a = []; ws.on('message', (m) => a.push(JSON.parse(String(m)))); return a; }
const waitEv = async (a, pred, ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = a.find(pred); if (h) return h; await sleep(150); } return null; };
const openWs = async () => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const ev = events(ws); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); return { ws, ev }; };

/** Count the tagged CLI execs alive INSIDE the container — the exec-reap ground truth. */
function execCount(cname) {
  try {
    const out = execFileSync('docker', ['exec', cname, 'sh', '-c',
      'c=0; for p in /proc/[0-9]*; do grep -qz CLAUDE_STATION_EXEC "$p/environ" 2>/dev/null && c=$((c+1)); done; echo $c'],
      { encoding: 'utf8', timeout: 15000 });
    return Number(out.trim()) || 0;
  } catch { return -1; }
}
const hbBeats = (hb) => { try { return fs.readFileSync(hb, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const hbDone = (hb) => { try { return fs.readFileSync(hb, 'utf8').includes('DONE'); } catch { return false; } };
const sessionListed = async (sdk) => { try { return (await api('/api/sessions')).body.sessions.some((s) => s.sdkSessionId === sdk); } catch { return false; } };

let cname = null;
try {
  for (let i = 0; i < 120; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(250); } }
  fs.writeFileSync(path.join(WORK, 'README.md'), 'b157c\n');
  const created = await api('/api/projects', 'POST', { hostPath: WORK, name: 'B157C', isolation: 'container' });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const pid = created.body.project.id;
  cname = `claude-station-${pid}`;
  console.log(`project=${pid} container=${cname} work=${WORK}`);

  /* ============ A: socket drop with a LIVE background agent ============ */
  console.log('\n=== A: socket drop while a real background agent is still working ===');
  const BEATS = Number(process.env.B157C_BEATS ?? 90);   // seconds; must outlive a wrong reap
  const hb = 'hb.txt';                                    // relative to the container cwd (mounted = WORK)
  const hbHost = path.join(WORK, hb);
  const cmd = `for i in $(seq 1 ${BEATS}); do date +%s >> ${hb}; sleep 1; done; echo DONE >> ${hb}`;
  const a = await openWs();
  a.ws.send(JSON.stringify({
    type: 'start', projectId: pid, overrides: { permissionMode: 'bypassPermissions' },
    prompt:
      'Dispatch ONE subagent with the Task tool, subagent_type "general-purpose", run_in_background set to true. ' +
      'Its ENTIRE task is to run this one Bash command verbatim from your current working directory and nothing else:\n\n' +
      cmd + '\n\nDo NOT run the command yourself and do NOT wait for the agent. The instant it is dispatched, ' +
      'end your turn by replying with exactly: BG-DISPATCHED',
  }));
  const init = await waitEv(a.ev, (e) => e.t === 'session-init', 180000);
  if (!init) throw new Error(`container session never initialised. tail=${JSON.stringify(a.ev.slice(-6))}`);
  const sdk = init.sessionId;
  const started = await waitEv(a.ev, (e) => e.t === 'agent-started', 180000);
  const end = await waitEv(a.ev, (e) => e.t === 'turn-end', 180000);
  await sleep(8000);
  const beatsAtEnd = hbBeats(hbHost);
  await sleep(6000);
  const beatsBeforeDrop = hbBeats(hbHost);
  const execBefore = execCount(cname);
  check('A precondition: a real background subagent was dispatched, the turn ended, and its heartbeat OUTLIVES the turn',
    !!started && !!end && beatsBeforeDrop > beatsAtEnd && execBefore > 0,
    { agentStarted: !!started, turnEnded: !!end, beatsAtEnd, beatsBeforeDrop, execProcesses: execBefore });

  const logAt = serverLog.length;
  try { a.ws.send(JSON.stringify({ type: 'close' })); a.ws.close(); } catch {}   // the socket drop
  await sleep(2500);
  const listedAfterDrop = await sessionListed(sdk);
  const detachLogged = /detached instead of closed/.test(serverLog.slice(logAt));
  const execAfterDrop = execCount(cname);
  check('A: the container session DETACHED on the socket drop (still live, logged), it was NOT closed',
    listedAfterDrop && detachLogged, { stillListed: listedAfterDrop, detachLogged, execProcesses: execAfterDrop });
  check('A: the container exec was NOT reaped by the drop — its tagged CLI process is still alive',
    execAfterDrop >= 1, { execProcessesAfterDrop: execAfterDrop, before: execBefore });

  // Let the background agent run to its own DONE marker; sample the exec meanwhile.
  const deadline = Date.now() + (BEATS * 1000) + 60000;
  let minExec = execAfterDrop;
  while (Date.now() < deadline) {
    const e = execCount(cname);
    if (e >= 0) minExec = Math.min(minExec, e);
    if (hbDone(hbHost)) break;
    await sleep(2000);
  }
  const done = hbDone(hbHost);
  check('A LOAD-BEARING: the background agent RAN TO COMPLETION after the socket dropped (heartbeat reached DONE)',
    done, { done, beats: hbBeats(hbHost), of: BEATS, minExecSeenDuringRun: minExec });

  // No leak: once the work ends the detached container session closes and reaps.
  let reaped = false;
  const rd = Date.now() + 120000;
  while (Date.now() < rd) { if (!(await sessionListed(sdk))) { reaped = true; break; } await sleep(2000); }
  let execGone = false;
  const ed = Date.now() + 60000;
  while (Date.now() < ed) { const e = execCount(cname); if (e === 0) { execGone = true; break; } await sleep(2000); }
  check('A NO LEAK: after the background work ended the session closed and the exec was reaped',
    reaped && execGone, { leftRegistry: reaped, execProcesses: execCount(cname) });

  /* ============ B: NON-VACUITY — a finished container session closes+reaps ==== */
  console.log('\n=== B: a genuinely finished container session STILL closes and reaps its exec ===');
  const b = await openWs();
  b.ws.send(JSON.stringify({ type: 'start', projectId: pid, overrides: { permissionMode: 'bypassPermissions' }, prompt: 'Reply with exactly: ok. Do not use any tools.' }));
  const initB = await waitEv(b.ev, (e) => e.t === 'session-init', 180000);
  const endB = await waitEv(b.ev, (e) => e.t === 'turn-end', 180000);
  if (!initB) throw new Error('B: finished container session never initialised');
  const sdkB = initB.sessionId;
  await sleep(1500);
  const execBeforeB = execCount(cname);
  check('B precondition: a no-background container session finished a turn and has a live exec',
    endB?.subtype === 'success' && execBeforeB > 0, { subtype: endB?.subtype, execProcesses: execBeforeB });
  try { b.ws.send(JSON.stringify({ type: 'close' })); b.ws.close(); } catch {}
  let closedB = false;
  const cd = Date.now() + 60000;
  while (Date.now() < cd) { if (!(await sessionListed(sdkB))) { closedB = true; break; } await sleep(1500); }
  let execGoneB = false;
  const ed2 = Date.now() + 60000;
  while (Date.now() < ed2) { if (execCount(cname) === 0) { execGoneB = true; break; } await sleep(2000); }
  check('B: the finished session closed on the socket drop and its exec was reaped (fuse not disabled for containers)',
    closedB && execGoneB, { closed: closedB, execReaped: execGoneB, execProcesses: execCount(cname) });

} catch (err) {
  fail++;
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  try { if (cname) execFileSync('docker', ['rm', '-f', cname], { stdio: 'pipe' }); } catch {}
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  await sleep(1500);
  try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', '-workspace-b157c'), { recursive: true, force: true }); } catch {}
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exit(fail ? 1 : 0);
}
