/**
 * Detach/reattach — navigating away from a running session must NOT kill it.
 * (Observed live: switching sessions wrote "[Request interrupted by user]"
 * into a working session, because socket close closed the bridge.)
 *
 *   node scripts/verify-detach.mjs      (runs ~3 cheap haiku turns)
 *
 * Scenarios:
 *  A. socket closes MID-TURN → session detaches, turn FINISHES, transcript
 *     holds the full answer with no interrupt marker, bridge self-closes.
 *  B. socket closes mid-turn, a new socket re-attaches while busy → events
 *     flow to the new socket (turn-end arrives there), and a follow-up send
 *     lands in the SAME session.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_DETACH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-det-data-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const cleanupDirs = [DATA];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
    ws.once('open', () => res({ ws, events }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 180_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};
const health = async () => (await (await fetch(`${BASE}/api/health`)).json());

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-det-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'detach-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const store = path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[/.]/g, '-'));
  cleanupDirs.push(store);

  console.log('\n=== A: close mid-turn → work finishes, no interrupt, self-close ===');
  const a = await openWs();
  a.ws.send(JSON.stringify({ type: 'start', projectId: pid,
    prompt: 'Write a 150-word story about mountains, then end with exactly: STORY-DONE-A',
    overrides: { model: 'haiku' } }));
  const initA = await waitEv(a.events, (e) => e.t === 'session-init');
  if (!initA) throw new Error('turn A never initialised');
  await sleep(1500); // firmly mid-turn
  a.ws.close();      // ← the "user switched sessions" moment
  // The session must survive the socket: poll the transcript file for the end marker.
  const fileA = path.join(store, `${initA.sessionId}.jsonl`);
  let doneA = false;
  for (let i = 0; i < 240 && !doneA; i++) {
    try { doneA = fs.readFileSync(fileA, 'utf8').includes('STORY-DONE-A'); } catch { /* not yet */ }
    if (!doneA) await sleep(1000);
  }
  const rawA = fs.readFileSync(fileA, 'utf8');
  check('the turn FINISHED after its socket died (end marker on disk)', doneA, `marker found=${doneA}`);
  check('no "[Request interrupted by user]" was written', !rawA.includes('[Request interrupted by user]'),
    `interrupt marker present=${rawA.includes('[Request interrupted by user]')}`);
  // The end marker lands in the FILE before the SDK's `result` message, and
  // the self-close grace is 3s after result — poll rather than guess the gap.
  let selfClosed = false;
  for (let i = 0; i < 30 && !selfClosed; i++) {
    selfClosed = (await health()).liveBridges === 0;
    if (!selfClosed) await sleep(1000);
  }
  check('the detached bridge closed itself at the boundary', selfClosed,
    `liveBridges=${(await health()).liveBridges}`);

  console.log('\n=== B: close mid-turn, RE-ATTACH while busy, then continue ===');
  const b1 = await openWs();
  b1.ws.send(JSON.stringify({ type: 'start', projectId: pid,
    prompt: 'Write a 150-word story about oceans, then end with exactly: STORY-DONE-B',
    overrides: { model: 'haiku' } }));
  const initB = await waitEv(b1.events, (e) => e.t === 'session-init');
  if (!initB) throw new Error('turn B never initialised');
  await sleep(1500);
  b1.ws.close();
  await sleep(500);
  const b2 = await openWs();
  b2.ws.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'ignored while busy',
    resumeSessionId: initB.sessionId, overrides: { model: 'haiku' } }));
  const ackB = await waitEv(b2.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  check('re-attach ack arrives with reattached:true and the busy flag',
    ackB?.reattached === true && typeof ackB?.busy === 'boolean', JSON.stringify(ackB && { reattached: ackB.reattached, busy: ackB.busy }));
  const endB = await waitEv(b2.events, (e) => e.t === 'turn-end', 240_000);
  check('the NEW socket receives the running turn\'s turn-end (stream handed over)',
    !!endB && endB.interrupted === false, JSON.stringify(endB && { subtype: endB.subtype, interrupted: endB.interrupted }));
  // Continue in the SAME session over the new socket.
  b2.ws.send(JSON.stringify({ type: 'send', prompt: 'Reply with exactly: REATTACH-OK' }));
  const endB2 = await waitEv(b2.events, (e) => e.t === 'turn-end' && e !== endB, 180_000);
  const gotText = b2.events.some((e) => e.t === 'text' && String(e.text ?? '').includes('REATTACH-OK'));
  check('a follow-up send works in the SAME re-attached session', !!endB2 && gotText,
    JSON.stringify({ end2: !!endB2, gotText }));
  const rawB = fs.readFileSync(path.join(store, `${initB.sessionId}.jsonl`), 'utf8');
  check('session B transcript: full story, follow-up, and no interrupt marker',
    rawB.includes('STORY-DONE-B') && rawB.includes('REATTACH-OK') && !rawB.includes('[Request interrupted by user]'),
    JSON.stringify({ story: rawB.includes('STORY-DONE-B'), followup: rawB.includes('REATTACH-OK') }));
  b2.ws.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
