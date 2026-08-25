/**
 * BUG-018 — the client's EXPLICIT `{type:'close'}` (sent on EVERY session
 * switch/reopen by closeSocket() at the top of openSession()) must be no more
 * destructive than a raw socket drop: a BUSY session with an open, unanswered
 * permission card must DETACH (survive in the live registry, keep its pending
 * approvals for reattach/replay — the BUG-008 contract), NOT close+auto-deny.
 *
 *   node scripts/verify-close-busy-detach.mjs
 *
 * Before the fix: `case 'close'` in index.ts called `session.close()` with NO
 * busy check. `AgentSession.close()` synchronously (a) `sessions.delete(id)` —
 * vacating the live-bridge registry while the turn is still finishing — and
 * (b) `p.resolve({behavior:'deny'})` for every pending approval — silently
 * rejecting a card the user never answered. A reattach then can't find the
 * live session (falls to a not-yet-flushed transcript resume and fails), and
 * the card is gone forever.
 *
 * This drives the REAL server over raw ws with REAL haiku sessions and sends
 * the EXACT client sequence — `ws.send({type:'close'})` then `ws.close()`:
 *
 *  BUSY case (the fix):
 *   1. default-mode Write -> a real `approval-request` card; turn is busy,
 *      blocked in canUseTool awaiting the answer.
 *   2. Send the exact client close sequence WHILE the card is pending.
 *   (a) ASSERT the session is STILL in the live registry (GET /api/sessions
 *       lists its sdkSessionId, busy) — it did not vanish.
 *   (c) Re-attach with a NEW socket (resumeSessionId) -> ASSERT the SAME
 *       approval-request (same requestId) is replayed to it.
 *   (a') Answer it over the new socket -> ASSERT the turn unblocks and the
 *       Write lands on disk (REATTACHED). If it had been auto-denied the id
 *       would be gone, nothing replays, and the file never appears.
 *   (b) ASSERT the session stayed in the registry the whole time until the
 *       turn actually ended.
 *
 *  IDLE control (must still close normally, before AND after the fix):
 *   3. A session whose turn has finished (idle). Send the exact client close
 *      sequence -> ASSERT the session leaves the registry (closes normally).
 *
 * FAILS on current code: registry vacated immediately, no replay, Write denied.
 * PASSES after: detach preserves the session + card; reattach replays + answers.
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
const PORT = Number(process.env.VERIFY_CLOSE_BUSY_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cbd-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cbd-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cbd-store-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const cleanupDirs = [DATA, WORK, STORE];
const strays = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 240_000, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.slice(from).find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
};
const sessionsList = async () => (await (await fetch(`${BASE}/api/sessions`)).json()).sessions ?? [];
const inRegistry = async (sid) => (await sessionsList()).some((s) => s.sdkSessionId === sid);

/**
 * The EXACT sequence public/app.js closeSocket() sends: an explicit `{type:'close'}`
 * command over the socket, immediately followed by ws.close(). This is what fires
 * on every in-app session switch AND every reopen of the driven session.
 */
function clientCloseSocket(conn) {
  try { conn.ws.send(JSON.stringify({ type: 'close' })); conn.ws.close(); } catch { /* already gone */ }
}

async function startBusyWriteCard(pid, target, label) {
  const c = await openWs();
  c.send({
    type: 'start', projectId: pid, overrides: { model: 'haiku' },
    prompt: `Use the Write tool to create the file ${target} containing exactly the word: REATTACHED. Do nothing else first, then say exactly: WRITE-DONE.`,
  });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 120_000);
  if (!init) throw new Error(`[${label}] session never initialised`);
  const ask = await waitEv(c.events, (e) => e.t === 'approval-request' && e.toolName === 'Write', 240_000);
  if (!ask) throw new Error(`[${label}] no approval-request — cannot test the busy-close path`);
  if (typeof ask.input?.file_path === 'string' && !ask.input.file_path.startsWith(WORK)) strays.push(ask.input.file_path);
  return { c, sdkSessionId: init.sessionId, reqId: ask.requestId };
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'close-busy-detach' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'default' }),
  })).json();

  const target = path.join(WORK, 'close-busy-detach.txt');

  console.log('\n=== 1. a default-mode Write raises a real approval card (turn is busy, blocked) ===');
  const { c: a, sdkSessionId, reqId } = await startBusyWriteCard(pid, target, 'busy');
  check('PRECONDITION: the Write produced an approval-request card with a requestId (turn busy, blocked)',
    typeof reqId === 'string' && reqId.length > 0, { requestId: reqId });
  check('PRECONDITION: the busy session is in the live registry before the close',
    await inRegistry(sdkSessionId), { sdkSessionId, sessions: (await sessionsList()).map((s) => s.sdkSessionId) });

  console.log('\n=== 2. send the EXACT client close sequence ({type:close} then ws.close()) WHILE the card is pending ===');
  clientCloseSocket(a);
  await sleep(1200); // let the server fully process both the 'close' command and the ws close.

  // (b) The session must NOT have vanished from the live registry — the whole
  // point of the bug. On buggy code close() ran sessions.delete() synchronously.
  const stillListed = await inRegistry(sdkSessionId);
  const listedBusy = (await sessionsList()).find((s) => s.sdkSessionId === sdkSessionId)?.busy;
  check('THE FIX (registry): the busy session STAYED in the live registry after the explicit close (did not vacate)',
    stillListed, { stillListed, busy: listedBusy, sessions: (await sessionsList()).map((s) => ({ id: s.sdkSessionId, busy: s.busy })) });
  check('THE FIX (busy): the surviving session is still busy — the turn was NOT resolved by an auto-deny',
    listedBusy === true, { busy: listedBusy });

  console.log('\n=== 3. re-attach with a NEW socket — the SAME pending card must be replayed (not auto-denied) ===');
  const b = await openWs();
  b.send({ type: 'start', projectId: pid, resumeSessionId: sdkSessionId, overrides: { model: 'haiku' } });
  const ack = await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'start', 30_000);
  check('re-attach ack arrives with reattached:true and busy:true (the turn is still live and blocked)',
    ack?.reattached === true && ack?.busy === true, ack && { reattached: ack.reattached, busy: ack.busy });

  // The new socket sent NO prompt, so ANY approval-request it gets is the replay
  // of the still-open card. On buggy code the card was auto-denied and cleared
  // from #approvals, so nothing replays.
  const replayed = await waitEv(b.events, (e) => e.t === 'approval-request' && e.requestId === reqId, 20_000);
  check('THE FIX (not-denied): the still-open approval card is REPLAYED to the re-attached socket (same requestId)',
    !!replayed && replayed.toolName === 'Write',
    replayed ? { t: replayed.t, requestId: replayed.requestId, toolName: replayed.toolName } : 'no approval-request replayed — the card was auto-denied by close()');

  console.log('\n=== 4. answering over the new socket unblocks the turn; the Write lands (proves it was never denied) ===');
  const answerReqId = replayed?.requestId ?? null;
  const before = b.events.length;
  if (answerReqId) b.send({ type: 'approval-response', requestId: answerReqId, allow: true });
  const ansAck = answerReqId
    ? await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === answerReqId, 15_000, before)
    : null;
  check('the re-attached socket answers the replayed card (acked, matched the still-pending request)',
    ansAck?.matched === true, answerReqId ? JSON.stringify(ansAck) : 'no card was replayed — nothing to answer; turn blocked (or already denied)');

  const end = answerReqId ? await waitEv(b.events, (e) => e.t === 'turn-end', 240_000, before) : null;
  check('the turn ends after the answer, and was NOT interrupted',
    !!end && end.interrupted === false,
    answerReqId ? (end && { subtype: end.subtype, interrupted: end.interrupted }) : 'no answer was possible');

  const landed = fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('REATTACHED');
  check('LOAD-BEARING: the approved Write actually ran — proof the pending approval was preserved, not auto-denied',
    landed, `exists=${fs.existsSync(target)}, content=${fs.existsSync(target) ? JSON.stringify(fs.readFileSync(target, 'utf8').trim()) : 'n/a'}`);

  // Exactly-once: a second answer for the resolved request is refused — the
  // preserved pending promise settled exactly once (BUG-008 contract intact).
  if (answerReqId) {
    b.send({ type: 'approval-response', requestId: answerReqId, allow: true });
    const dup = await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === answerReqId && e !== ansAck, 10_000, before);
    check('a duplicate answer for the resolved card is refused (matched:false) — settled exactly once',
      dup?.matched === false, JSON.stringify(dup));
  } else {
    check('a duplicate answer for the resolved card is refused (matched:false) — settled exactly once',
      false, 'skipped — the card was never replayed');
  }

  // Now that the turn actually ended, close the reattached session cleanly.
  b.send({ type: 'close' });
  await waitEv(b.events, (e) => e.t === 'session-closed', 30_000, before);
  b.ws.close();

  console.log('\n=== 5. CONTROL: an explicit close of an IDLE session still closes normally ===');
  const idle = await openWs();
  idle.send({
    type: 'start', projectId: pid, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Reply with exactly the word: IDLEDONE. Do not use any tools.',
  });
  const idleInit = await waitEv(idle.events, (e) => e.t === 'session-init', 120_000);
  if (!idleInit) throw new Error('idle session never initialised');
  const idleEnd = await waitEv(idle.events, (e) => e.t === 'turn-end', 240_000);
  check('CONTROL PRECONDITION: the idle session finished its turn (not busy)',
    !!idleEnd && idleEnd.interrupted === false, idleEnd && { subtype: idleEnd.subtype, interrupted: idleEnd.interrupted });
  // give the bridge a beat to reflect busy=false, then confirm it is idle.
  await sleep(400);
  const idleSid = idleInit.sessionId;
  const idleRow = (await sessionsList()).find((s) => s.sdkSessionId === idleSid);
  check('CONTROL PRECONDITION: the idle session is in the registry and not busy before the close',
    !!idleRow && idleRow.busy === false, idleRow && { sdkSessionId: idleSid, busy: idleRow.busy });

  clientCloseSocket(idle);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { if (!(await inRegistry(idleSid))) { gone = true; break; } await sleep(150); }
  check('CONTROL (regression guard): the IDLE session leaves the registry — explicit close still closes normally',
    gone, { stillListed: await inRegistry(idleSid) });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(server);
  setTimeout(() => {
    for (const f of strays) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
