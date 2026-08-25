/**
 * BUG-008 — a permission/question/plan card open when the socket drops must be
 * REPLAYED to a re-attaching socket, so the still-open turn can be answered.
 *
 *   node scripts/verify-reattach-approval.mjs
 *
 * Before the fix: the pending control request lived only in the session's
 * in-memory `#approvals` map. It is NOT written to the transcript file, so a
 * file-follower can never surface it. On reload the old socket closes, the busy
 * session detaches with the request still unanswered, and the reattach path
 * re-emitted only ack + a synthetic session-init — never the card. The reloaded
 * page showed "still working / following live" while the turn was blocked
 * forever on a request the user could no longer see. Only a manual interrupt
 * escaped.
 *
 * This drives the REAL server over a raw ws with a REAL haiku session:
 *  1. default-mode session issues a `Write` -> a real `approval-request` card;
 *     the turn is busy, blocked in canUseTool awaiting the answer.
 *  2. Drop the driving socket (the reload/switch-away moment) -> the busy
 *     session detaches, the card stays pending and unanswered.
 *  3. PROVE the card is not recoverable from the transcript: it is absent from
 *     the session's .jsonl on disk. Replay is the only way back.
 *  4. Re-attach with a NEW socket (resumeSessionId) -> ASSERT the SAME
 *     approval-request (same requestId) is replayed to it.
 *  5. Answer it over the new socket -> ASSERT the turn unblocks: the Write
 *     lands on disk, the turn ends without an interrupt marker, and a
 *     duplicate answer for the now-resolved request is refused (answered once).
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
const PORT = Number(process.env.VERIFY_REATTACH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reat-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reat-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reat-store-'));

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
const health = async () => (await (await fetch(`${BASE}/api/health`)).json());

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
    body: JSON.stringify({ hostPath: WORK, name: 'reattach-approval' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // default mode: a Write MUST route through canUseTool and raise a card. (echo
  // is auto-approved, so a Write is used deliberately.)
  await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'default' }),
  })).json();

  const target = path.join(WORK, 'reattach-approval.txt');

  console.log('\n=== 1. a default-mode Write raises a real approval card (turn is busy, blocked) ===');
  const a = await openWs();
  a.send({
    type: 'start', projectId: pid, overrides: { model: 'haiku' },
    prompt: `Use the Write tool to create the file ${target} containing exactly the word: REATTACHED. Do nothing else first, then say exactly: WRITE-DONE.`,
  });
  const init = await waitEv(a.events, (e) => e.t === 'session-init', 120_000);
  if (!init) throw new Error('session never initialised');
  const ask = await waitEv(a.events, (e) => e.t === 'approval-request' && e.toolName === 'Write', 240_000);
  check('PRECONDITION: the Write produced an approval-request card with a requestId',
    !!ask && typeof ask.requestId === 'string' && ask.requestId.length > 0,
    ask && { toolName: ask.toolName, requestId: ask.requestId, file: ask.input?.file_path });
  if (!ask) throw new Error('no approval-request — cannot test replay of a pending card');
  if (typeof ask.input?.file_path === 'string' && !ask.input.file_path.startsWith(WORK)) strays.push(ask.input.file_path);
  const sdkSessionId = init.sessionId;
  const reqId = ask.requestId;

  console.log('\n=== 2. drop the driving socket mid-card — the busy session detaches, card stays pending ===');
  a.ws.close();
  // The server observes the TCP close and detaches the busy session. Poll the
  // reattach precondition (detached) instead of guessing the gap: an
  // un-detached session refuses reattach with "live in another tab".
  let detached = false;
  for (let i = 0; i < 40 && !detached; i++) {
    const h = await health();
    // liveBridges stays 1 (the session lives on, detached); we can only observe
    // detachment by attempting reattach, so just give the close a moment and
    // rely on the reattach ack below to confirm reattached:true.
    if (h.liveBridges >= 1) detached = true;
    if (!detached) await sleep(150);
  }
  await sleep(600);
  check('the session survives its socket dying (still a live bridge to re-attach to)',
    (await health()).liveBridges >= 1, `liveBridges=${(await health()).liveBridges}`);

  // The transcript-absence assertion runs at the END (below), once the turn has
  // completed and the .jsonl is fully flushed — that is when "the requestId is
  // nowhere in the transcript" is a fair test that a file-follower could never
  // have surfaced the pending card. Locate the file across the possible stores.
  const findJsonl = () => {
    const roots = [STORE, path.join(os.homedir(), '.claude', 'projects')];
    const walk = (dir) => {
      let found = null;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const ent of ents) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { found = walk(p); if (found) return found; }
        else if (ent.name === `${sdkSessionId}.jsonl`) return p;
      }
      return found;
    };
    for (const r of roots) { const hit = walk(r); if (hit) return hit; }
    return null;
  };

  console.log('\n=== 4. re-attach with a NEW socket — the SAME card must be replayed to it ===');
  const b = await openWs();
  b.send({ type: 'start', projectId: pid, resumeSessionId: sdkSessionId, overrides: { model: 'haiku' } });
  const ack = await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'start', 30_000);
  check('re-attach ack arrives with reattached:true and busy:true (the turn is still blocked)',
    ack?.reattached === true && ack?.busy === true, ack && { reattached: ack.reattached, busy: ack.busy });

  // The new socket sent NO prompt, so ANY approval-request it receives is the
  // replay of the still-open card — this is the core BUG-008 assertion.
  const replayed = await waitEv(b.events, (e) => e.t === 'approval-request' && e.requestId === reqId, 20_000);
  check('THE FIX: the still-open approval card is REPLAYED to the re-attached socket (same requestId)',
    !!replayed && replayed.toolName === 'Write',
    replayed ? { t: replayed.t, requestId: replayed.requestId, toolName: replayed.toolName } : 'no approval-request replayed to the new socket');

  console.log('\n=== 5. answering over the new socket unblocks the turn (and answers exactly once) ===');
  /*
   * CRUCIAL: answer using ONLY the requestId the re-attached socket was GIVEN by
   * the replay — never the id captured from the dead socket A. A real reloaded
   * user has no memory of the old id; the card (with its id) is the only way to
   * answer. If replay did not happen (the bug), `replayed` is null and there is
   * nothing to answer with, so the turn stays blocked forever — which is exactly
   * the honest failure this ticket describes, and these checks then fail.
   */
  const answerReqId = replayed?.requestId ?? null;
  const before = b.events.length;
  if (answerReqId) b.send({ type: 'approval-response', requestId: answerReqId, allow: true });
  const ansAck = answerReqId
    ? await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === answerReqId, 15_000, before)
    : null;
  check('the re-attached socket can answer the card it was shown (acked, matched the pending request)',
    ansAck?.matched === true, answerReqId ? JSON.stringify(ansAck) : 'no card was replayed, so the socket had no requestId to answer with — turn is blocked forever');

  // Only wait for the turn boundary if we actually answered — with no card to
  // answer (the bug) the turn is blocked forever; a short probe avoids sitting
  // on a 240s timeout to conclude what is already known.
  const end = answerReqId ? await waitEv(b.events, (e) => e.t === 'turn-end', 240_000, before) : null;
  check('the turn ends after the answer (no longer blocked forever), and was not interrupted',
    !!end && end.interrupted === false,
    answerReqId ? (end && { subtype: end.subtype, interrupted: end.interrupted }) : 'no answer was possible — turn never ended (blocked forever), the exact BUG-008 symptom');

  const landed = fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('REATTACHED');
  check('LOAD-BEARING: the approved Write actually ran — the file the blocked tool would create is on disk',
    landed, `exists=${fs.existsSync(target)}, content=${fs.existsSync(target) ? JSON.stringify(fs.readFileSync(target, 'utf8').trim()) : 'n/a'}`);

  // Exactly-once: a second answer for the now-resolved request must be refused,
  // proving the pending promise settled once (no double-answer hazard).
  if (answerReqId) {
    b.send({ type: 'approval-response', requestId: answerReqId, allow: true });
    const dup = await waitEv(b.events, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === answerReqId && e !== ansAck, 10_000, before);
    check('a duplicate answer for the resolved card is refused (matched:false) — the promise settled exactly once',
      dup?.matched === false, JSON.stringify(dup));
  } else {
    check('a duplicate answer for the resolved card is refused (matched:false) — the promise settled exactly once',
      false, 'skipped — the card was never replayed, so there was nothing to answer once, let alone twice');
  }

  const jsonlPath = findJsonl();
  const raw = (() => { try { return jsonlPath ? fs.readFileSync(jsonlPath, 'utf8') : ''; } catch { return ''; } })();
  if (jsonlPath) cleanupDirs.push(path.dirname(jsonlPath));
  check('PRECONDITION: the completed turn wrote a non-empty transcript to disk',
    raw.length > 0, `transcript=${jsonlPath ? path.basename(jsonlPath) : 'NOT FOUND'}, bytes=${raw.length}`);
  check('the pending approval requestId is NOWHERE in the transcript — a file-follower could never have surfaced it, so replay was the only way back',
    raw.length > 0 && !raw.includes(reqId), `contains requestId=${raw.includes(reqId)}`);
  check('no "[Request interrupted by user]" was ever written — the turn completed honestly',
    !raw.includes('[Request interrupted by user]'), `interrupt marker present=${raw.includes('[Request interrupted by user]')}`);

  b.send({ type: 'close' });
  await waitEv(b.events, (e) => e.t === 'session-closed', 30_000, before);
  b.ws.close();

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
