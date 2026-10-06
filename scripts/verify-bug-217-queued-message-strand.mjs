#!/usr/bin/env node
/**
 * BUG-217 — a message queued while Claude was working must be delivered to the
 * session EXACTLY ONCE, after the running turn, whatever the tabs do (reload,
 * switch away, close, two or three open at once) and whatever the server does
 * (restart, SIGKILL at any step, a damaged file).
 *
 * Round 5 moved the queue to the SERVER (src/server/outbox.ts): a queued message
 * is a row the server minted and wrote to disk before it answered; only the
 * server moves it (queued → sending → delivered | uncertain | failed, or
 * discarded by the user) and it delivers it itself when the session can take a
 * turn — with or without a tab. Four earlier rounds each broke "exactly once"
 * because a reader inferred delivery from something that can lie or forget.
 *
 * Every server here is an ISOLATED scratch server (scripts/lib/bug-187-harness:
 * its own CLAUDE_STATION_DATA + store, a free port, the scripted fake CLI), and
 * every browser is a real headless brave. "At the CLI" is the fake CLI's stdin
 * tap — the ground truth of what reached the session.
 *
 *   ── the round-5 design, on the CURRENT tree ──
 *   N.  queued with NO tab open is delivered when the turn ends (API and browser).
 *   A/B the incident: queued mid-turn, the page reloaded / switched away, the
 *       turn ended and the host closed — sent once, visible, answered.
 *   C.  reload while the turn still runs — once, after the turn, never into it.
 *   D.  another tab drives: this tab's typed Enter is NOT sent from here; the dock
 *       says so and offers Send now, which queues it for that session's pause.
 *   E.  (round-1 attack) two real tabs — once; both docks agree.
 *   F.  order: three queued rows go as one turn in the order typed; rows across
 *       a server restart keep their order.
 *   G.  Edit / Discard racing the delivery at the turn boundary — never both,
 *       never twice; the server's answer and the CLI agree.
 *   I.  Interrupt & send (FEAT-031): the server interrupts the turn; that row goes first, alone, once.
 *   J.  (round-2 attack #1) the tab dies mid-POST (the server got it / did not).
 *   K.  (round-2 attack #2) the same words as an earlier message — sent once.
 *   L.  the same text queued twice on purpose arrives twice.
 *   M.  three tabs replay one pending request and press Send anyway together — once.
 *   R3. (round-3 attack) 4,800 rows flooded into this and another session, restart,
 *       the delivered row's request replayed — once (nothing is evicted).
 *   R4. (round-4 attacks) the replay carries a forged `queueNow`/`now`, a corrected
 *       tab clock, and another project's scope; a round-4 frame with `queueIds`
 *       is refused — once.
 *   S.  SIGKILL of the server at each transition (created, sending, handed over,
 *       delivered, edited, discarded, requeued) — never twice, never silently lost.
 *   X.  a truncated, a garbled and a torn outbox file: loud, rows "not confirmed",
 *       none sent by itself, a damaged notice until dismissed.
 *   U.  the "not confirmed" UI: Send anyway (exactly once, even double-clicked) and
 *       Discard; plain status text, visible actions, Discard set apart, no clipping
 *       at 1280/640/520/420 px, light and dark.
 *   LG. rows a round-4 tab kept in the browser: known-delivered not brought back, the rest
 *       "not confirmed", one server row even when two tabs import at once, none sent.
 *   Z.  misc: unknown session → 404 and no file; nonce reuse with other text → 409;
 *       discard-on-create floods never deliver.
 *
 *   ── MUST-FAIL: each round's failure against a SYNTHESIZED prior-round state ──
 *   The round-4 tree is PINNED (scripts/fixtures/bug-217/round4/*.gz, sha256-listed):
 *   its app.js, api.js, index.ts, queue-ledger.ts and events.ts are laid over a
 *   scratch copy of the current tree and booted as a server. Never `git show HEAD`:
 *   committing this fix cannot turn these proofs into decoration.
 *   P4a/b/c  round 4 (pinned): scope mismatch after eviction, a corrected clock, a
 *            forged queueNow=1 — each reaches the CLI twice.
 *   P3       round 3 (the pinned ledger + the round-3 transform): flood + restart — twice.
 *   PJ/PK    round 2 (pinned app.js minus round 3's hunks): the sender dies — stranded;
 *            the same words — dropped.
 *   PE       round 1 (round 2 minus its store merge): two tabs — twice.
 *   PA       round 0 (the incident client): reload after idle — stranded.
 *
 *   ── round 6: the journal's commit point is ONE step, and one row per nonce survives a restart ──
 *   W.   in-process (scripts/fixtures/bug-217/outbox-harness.mjs): every lifecycle transition
 *        (create ×5 kinds, edit, discard, Send anyway / now / Interrupt, delivery with each
 *        outcome, compaction, dismiss-damage, every load-time rewrite, recovery, confirmation)
 *        with a disk fault at EVERY write op in it — ENOSPC once, EIO once, EIO from then on,
 *        a short write on a filling disk — then the tab replays, delivery, restart, delivery:
 *        never twice, never silently lost, the user sees Orchard's own words or "not confirmed".
 *        Plus the clean-room's round-5 attack (the `.head` rename ENOSPC) — once.
 *   DN.  journals ALREADY holding one nonce twice (every mix of states): the extra copy is never
 *        delivered, a copy that may have gone makes the kept row ask, loud, idempotent on reload.
 *   WE.  the same, end to end on a scratch server (a preload fails the real server's fs call):
 *        the head-rename ENOSPC, a journal-fsync EIO, and a synthesized round-5 outbox — once.
 *   P5 / P5E  MUST-FAIL on the PINNED round-5 outbox.ts (scripts/fixtures/bug-217/round5/,
 *        sha256-listed): the head-rename attack and the synthesized round-5 outbox — CLI ×2,
 *        in-process and on a server booted from a scratch tree carrying the pinned file.
 *
 *   ── round 7: one server per data dir; a cut-off last line is not damage ──
 *   L1.  a second server on a data dir another server holds refuses to start (exit 78, naming the holder's
 *        pid and port); a row both would have loaded reaches the CLI once.
 *   P6   MUST-FAIL on the round-6 state SYNTHESIZED from today's tree (no boot lock, an outbox that checks
 *        none; anchors must match once): both servers boot and the CLI gets the row twice.
 *   L2.  kill -9 of the holder: a new server takes the lock with no wait and delivers once.
 *   L3.  a restart overlap: the new server waits (naming the holder), serves nothing until the old one
 *        exits, then boots; once.
 *   L4.  a non-server process on a held data dir (the clean-room's two-instance case): cannot take the lock,
 *        writes nothing, hands nothing over.
 *   T / P6T  a cut-off LAST line (a later create the process died in): the earlier saved row still goes by
 *        itself, once, no damage; MUST-FAIL on the pinned round-5 outbox (the same branch round 6 shipped).
 *
 *   ── round 8: the data dir's lock is a flock on a file inside it, so it follows the INODE ──
 *   M1 / M2  a second server reaching the dir through a BIND MOUNT (a container volume) / from another NETWORK
 *        NAMESPACE (unshare) refuses, exit 78, naming the holder's pid and port; the queued row goes once.
 *   P7B / P7N  MUST-FAIL on the PINNED round-7 lanes.ts (scripts/fixtures/bug-217/round7/, sha256-listed): the same
 *        two boot a second server and the CLI gets the row twice.
 *   M3 / M4  a symlink / a relative path: refused, once.   M5  a SIGSTOPped holder: refused in bounded time, still
 *        named (read from the lock file).   M6  two different data dirs both start.   M7  kill -9 leaves the file,
 *        which blocks nothing. (L2 = kill -9 frees the lock; L3 = the restart overlap; both still run.)
 *
 *   ── round 9: the lock is a flock on the data DIRECTORY itself; a holder whose path drifts stops ──
 *   D1 / D2  the holder's file in the dir unlinked / replaced by a rename while held: the second server still refuses,
 *        once.   D3  the dir moved away and a cp -a copy put back: the drifted holder stops (exit 75, loud), the row
 *        goes at most once, and the moved dir keeps it "not confirmed".   D4  the move lands mid-save of `sending`
 *        (in-process, scripts/fixtures/bug-217/drift-child.mjs): the save goes to the held dir, nothing is handed over,
 *        the copy's server sends it once.   P8U / P8R / P8D / P8I  MUST-FAIL on the PINNED round-8 lanes.ts
 *        (scripts/fixtures/bug-217/round8/): the same four, ×2 (or written into the copy and handed over).
 *        F1  the lock fd does not reach a session host or CLI: a restart with them still alive takes the lock at once.
 *
 *   node scripts/verify-bug-217-queued-message-strand.mjs [--only N,A,S,W,DN,WE,P5,L1,…] [--shots <dir>] [--debug]
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  ROOT, sleep, pidAlive, makeWorld, bootServer, stopServer, registerProject, openWs, waitFor, fakeTap, hostRecords,
  writeSyntheticTranscript, cleanupWorld, mkScratch, FAKE_CLI, freePort,
} from './lib/bug-187-harness.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { spawn, execFileSync } from 'node:child_process';

const BRAVE = process.env.BRAVE_BIN || path.join(os.homedir(), '.local', 'bin', 'brave');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DEBUG = process.argv.includes('--debug');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',').map((x) => x.trim().toUpperCase())) : null;
const want = (id) => !ONLY || ONLY.has(id) || (id.startsWith('P') && ONLY.has('MUSTFAIL'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
  return !!ok;
}

/* ============================================ the pinned round-4 baseline tree */
const PIN = path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'round4');
const PINNED = ['public/app.js', 'public/lib/api.js', 'src/server/index.ts', 'src/server/queue-ledger.ts', 'src/server/events.ts'];
function pinned(rel) {
  const sums = Object.fromEntries(fs.readFileSync(path.join(PIN, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
  const body = zlib.gunzipSync(fs.readFileSync(path.join(PIN, `${rel.replaceAll('/', '__')}.gz`)));
  const h = crypto.createHash('sha256').update(body).digest('hex');
  if (h !== sums[rel]) throw new Error(`pinned baseline ${rel}: sha256 ${h} does not match SHA256SUMS (${sums[rel]}) — the fixture is damaged`);
  return body.toString('utf8');
}
/** A scratch copy of the current tree with the round-4 files laid over it. src/ and public/ are copied; the rest is linked. */
function round4Tree() {
  const dir = mkScratch('b217-round4-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  fs.rmSync(path.join(dir, 'src', 'server', 'outbox.ts'), { force: true }); // round 4 had none
  for (const rel of PINNED) fs.writeFileSync(path.join(dir, rel), pinned(rel));
  for (const rel of PINNED.filter((r) => r.startsWith('src/'))) {
    const stubs = stubMissingImports(dir, rel);
    if (stubs.length) console.log(`        (round-4 baseline: ${rel} imports names today's tree no longer exports — stubbed, each throws if called: ${stubs.join('; ')})`);
  }
  return dir;
}
/**
 * The pinned round-4 files are laid over TODAY's tree, which other work keeps changing: a named export
 * they import that has since been removed (e.g. FEAT-157 dropped provisioning.ts `claudeCodePin`) would
 * stop the baseline booting at all. Each missing name gets a stub in the scratch copy that throws if
 * called — none is on the queue path these baselines exercise, and a call would fail loudly, not quietly.
 */
function stubMissingImports(treeDir, rel) {
  const file = path.join(treeDir, rel);
  const out = [];
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) continue;
    const body = fs.readFileSync(target, 'utf8');
    const add = [];
    for (let spec of m[1].split(',')) {
      spec = spec.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const name = spec.split(/\s+as\s+/)[0].trim();
      const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`);
      if (!re.test(body)) add.push(name);
    }
    if (add.length) {
      fs.appendFileSync(target, `\n${add.map((n) => `export const ${n} = (..._a: unknown[]): never => { throw new Error('BUG-217 round-4 baseline stub: ${n} is gone from the current tree'); };`).join('\n')}\n`);
      out.push(`${m[2]}: ${add.join(', ')}`);
    }
  }
  return out;
}
/* The prior clients, each synthesized from the PINNED round-4 app.js. Every anchor must match exactly once. */
function swapAll(src, swaps, label) {
  let out = src;
  for (const [from, to] of swaps) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`${label}: anchor matches ${n} times, not once — regenerate the baseline:\n${from}`);
    out = out.replace(from, () => to);
  }
  return out;
}
let R4APP = null;
const round4App = () => (R4APP ??= pinned('public/app.js'));
/** Round 2's client: round 4's minus round 3's pinned client hunks (round 4's six edits are already on the `current` side). */
const round2App = () => swapAll(round4App(), JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'round3-client-hunks.json'), 'utf8')).map((h) => [h.current, h.round2]), 'round-2 baseline');
/** Round 1's client: round 2's with its shared-store merge disabled (a tab never re-reads the store). */
const round1App = () => swapAll(round2App(), [
  ['    if (done.has(q.id) && !queueRowInFlight(q) && q !== state.forceSend) {', '    if (false) {'],
  ['    if (!r || queueRowMine(q)) continue;', '    continue;'],
  ['    if (inHeap.has(id) || done.has(id) || sync.seen.has(id)) continue;', '    continue;'],
  ["  if (e.key !== QUEUE_KEY || !queueTargetKey()) return;", '  return;'],
], 'round-1 baseline');
/** Round 0 — the incident's client: not driving → paint and stop; nothing ever acquires the drive. */
const round0App = () => swapAll(round4App(), [
  ['  if (!isDriving()) { if (!driveQueue()) paintQueue(); return; }\n  if (state.busy || state.dropped) { paintQueue(); return; }',
    '  if (!isDriving() || state.busy || state.dropped) { paintQueue(); return; }'],
  ['function driveQueue({ force = false } = {}) {\n', 'function driveQueue({ force = false } = {}) {\n  return false;\n'],
], 'round-0 baseline');

/* ================================================================== a world */
function newWorld(name, { tree = ROOT } = {}) {
  const w = makeWorld(name, { tree });
  w.SDK = `b217${name.slice(-3)}${Date.now().toString(36)}-0000-4000-8000-000000000217`.slice(0, 36);
  w.OTHER = `b217o${name.slice(-3)}${Date.now().toString(36)}-0000-4000-8000-0000000002`.slice(0, 36);
  w.enc = w.work.replace(/[^a-zA-Z0-9]/g, '-');
  writeSyntheticTranscript(w, w.SDK, ['earlier: pick a sticker', 'earlier: which charm']);
  writeSyntheticTranscript(w, w.OTHER, ['another session entirely']);
  w.env = { FAKE_SDK_ID: w.SDK, FAKE_TRANSCRIPT_DIR: path.join(w.store, w.enc) };
  w.transcript = (sid = w.SDK) => path.join(w.store, w.enc, `${sid}.jsonl`);
  return w;
}
/** Push the transcript's mtime out of the 30 s "another program is writing it" window. */
function ageTranscript(w, sid = w.SDK, byMs = 120_000) {
  const t = (Date.now() - byMs) / 1000;
  fs.utimesSync(w.transcript(sid), t, t);
}
/** Make the transcript look freshly written by something this server does not hold (a terminal). */
function touchTranscript(w, sid = w.SDK) { const t = Date.now() / 1000; fs.utimesSync(w.transcript(sid), t, t); }
function appendPriorTurn(w, text, sid = w.SDK) {
  const t = Date.now() - 5000;
  const u = { type: 'user', uuid: `u-prior-${t}`, parentUuid: null, sessionId: sid, cwd: w.work, timestamp: new Date(t).toISOString(), message: { role: 'user', content: text } };
  const a = { type: 'assistant', uuid: `a-prior-${t}`, parentUuid: u.uuid, sessionId: sid, cwd: w.work, timestamp: new Date(t + 500).toISOString(), message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ack: that earlier message' }] } };
  fs.appendFileSync(w.transcript(sid), `${JSON.stringify(u)}\n${JSON.stringify(a)}\n`);
}
/** Every user frame a world's fake CLI(s) read, in order. */
function cliFrames(w) {
  const out = [];
  const pids = new Set(hostRecords(w).map((h) => h.claudePid).filter(Boolean));
  for (const f of fs.readdirSync(path.dirname(w.tap))) { const m = /^fake\.tap\.(\d+)$/.exec(f); if (m) pids.add(Number(m[1])); }
  for (const pid of pids) {
    for (const { at, m } of fakeTap(w, pid)) {
      if (m?.type !== 'user') continue;
      const c = m.message?.content;
      out.push({ pid, at: at ?? 0, text: Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : String(c ?? '') });
    }
  }
  return out.sort((a, b) => (a.at > b.at ? 1 : a.at < b.at ? -1 : 0));
}
const countIn = (w, needle) => cliFrames(w).filter((f) => f.text.includes(needle)).length;
const occurrences = (w, needle) => cliFrames(w).reduce((n, f) => n + (f.text.split(needle).length - 1), 0);

async function http(w, srv, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let j = null;
  try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
}
const outboxGet = (w, srv, sid = w.SDK) => http(w, srv, 'GET', `/api/outbox?session=${encodeURIComponent(sid)}`).then((r) => r.body);
const createRow = (w, srv, nonce, text, extra = {}) => http(w, srv, 'POST', '/api/outbox', { session: w.SDK, dir: w.enc, project: w.projectId, nonce, text, ...extra });
const act = (w, srv, verb, id, extra = {}) => http(w, srv, 'POST', `/api/outbox/${verb}`, { session: w.SDK, id, ...extra });
const nonce = (tag) => `n-${tag}-${crypto.randomUUID()}`;
const journal = (w, sid = w.SDK) => path.join(w.data, 'outbox', `${sid}.jsonl`);
const rowOnDisk = (w, id, sid = w.SDK) => {
  let last = null;
  try { for (const l of fs.readFileSync(journal(w, sid), 'utf8').split('\n')) { try { for (const r of JSON.parse(l).rows ?? []) if (r.id === id) last = r; } catch { /* torn */ } } } catch { /* none */ }
  return last;
};

async function bridgeHeld(w, srv, sid = w.SDK) {
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions`)).json();
    return (Array.isArray(r) ? r : (r.sessions ?? [])).some((b) => b.sdkSessionId === sid || b.projectId === w.projectId);
  } catch { return true; }
}
/** No bridge in the project, no live broker for the session: the incident's "nothing to reattach to" state. */
async function hostGone(w, srv) {
  if (await bridgeHeld(w, srv)) return false;
  return !hostRecords(w).some((h) => h.sdkSessionId === w.SDK && pidAlive(h.hostPid));
}
const waitIdleNoBridge = (w, srv, ms = 45_000) => waitFor(async () => ((await hostGone(w, srv)) ? true : null), ms, 400);

/** A raw `start` over a socket — a tab with no memory; retries the boot runtime check. */
async function rawStart(srv, frame) {
  for (let i = 0; i < 40; i++) {
    const c = await openWs(srv);
    c.send(frame);
    const e = await waitFor(() => c.events.find((x) => x.t === 'error' || (x.t === 'ack' && x.of === 'start')), 20_000);
    if (e?.code === 'runtime-check-pending') { c.close(); await sleep(1000); continue; }
    return { c, e };
  }
  return { c: null, e: null };
}
/** A long turn in the session, driven by a socket that then goes away (no tab). */
async function longTurnNoTab(w, srv, tag, ms = 4000) {
  const { c, e } = await rawStart(srv, { type: 'start', projectId: w.projectId, prompt: `seed ${tag} [[fake:{"op":"sleep","ms":${ms}}]]`, resumeSessionId: w.SDK, resumeEncodedDir: w.enc, overrides: { permissionMode: 'default' } });
  if (e?.t !== 'ack') throw new Error(`[${tag}] the seed turn did not start: ${JSON.stringify(e)}`);
  c.close();
  return e;
}
/** A fresh server refuses new host sessions until its boot runtime check is done (BUG-190): wait it out with one throwaway turn. */
async function warmUp(w, srv) {
  const { c, e } = await rawStart(srv, { type: 'start', projectId: w.projectId, prompt: 'warm-up', resumeSessionId: w.SDK, resumeEncodedDir: w.enc, overrides: { permissionMode: 'default' } });
  if (e?.t !== 'ack') throw new Error(`warm-up did not start: ${JSON.stringify(e)}`);
  await waitFor(() => (c.events.some((x) => x.t === 'turn-end') ? true : null), 20_000);
  c.close();
  await waitIdleNoBridge(w, srv);
  ageTranscript(w);
}
async function restart(w, srv, { kill = false, env = {} } = {}) {
  if (kill) { try { process.kill(srv.proc.pid, 'SIGKILL'); } catch { /* gone */ } for (let i = 0; i < 40 && pidAlive(srv.proc.pid); i++) await sleep(100); }
  else await stopServer(srv);
  return bootServer(w, { ...w.env, ...env }, { port: srv.port });
}
/** Wait for a server started with a crash point to kill itself. */
const waitDead = (srv, ms = 30_000) => waitFor(() => (srv.proc.exitCode !== null || srv.proc.signalCode ? true : null), ms, 100);

/* ============== round 6: the journal's commit point under disk faults (no browser needed) ============== */
const R6 = ['W', 'DN', 'WE', 'P5', 'P5E', 'L1', 'L2', 'L3', 'L4', 'T', 'P6', 'P6T', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'P7B', 'P7N', 'D1', 'D2', 'D3', 'D4', 'P8U', 'P8R', 'P8D', 'P8I', 'F1'];
const needMain = !ONLY || [...ONLY].some((x) => !R6.includes(x));
const H = await import('./fixtures/bug-217/outbox-harness.mjs');
const HOOK = path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'fs-fault.mjs');
const rowsOfNonce = (f, n) => { const out = new Map(); try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { const o = JSON.parse(l); for (const r of o.rows ?? []) if (r.nonce === n) out.set(r.id, r.state); } catch { /* torn */ } } } catch { /* none */ } return [...out.values()]; };
/** A scratch copy of the current tree with the PINNED round-5 outbox.ts laid over it. */
function round5Tree() {
  const dir = mkScratch('b217-round5-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  const { file, dir: tmp } = H.pinnedRound5Outbox();
  fs.writeFileSync(path.join(dir, 'src', 'server', 'outbox.ts'), fs.readFileSync(file, 'utf8').replace(/from 'file:[^']*\/src\/lib\/paths\.ts'/, `from '../lib/paths.ts'`));
  fs.rmSync(tmp, { recursive: true, force: true });
  return dir;
}
/** A scratch server whose fs calls a preload can fail (B217_FAULT_MARKER names the one call). */
async function faultWorld(tree, tag) {
  const w = newWorld(`b217${tag}`, { tree });
  w.marker = path.join(w.base, 'b217-fault-marker');
  w.faultEnv = { B217_FAULT_MARKER: w.marker, NODE_OPTIONS: `--import=${pathToFileURL(HOOK).href}` };
  const s = await bootServer(w, { ...w.env, ...w.faultEnv });
  w.projectId = await registerProject(s, w);
  await warmUp(w, s);
  return { w, s };
}
/** (1) ENOSPC on the `.head` rename right after the journal fsync — the round-5 break — then a restart. */
async function e2eHead(tree, tag) {
  let { w, s } = await faultWorld(tree, `${tag}h`);
  try {
    const t = `E2E-HEAD-${tag} the head rename fails`;
    const n = nonce('weh');
    fs.writeFileSync(w.marker, JSON.stringify({ op: 'renameSync', suffix: '.head', code: 'ENOSPC' }));
    const p = await createRow(w, s, n, t);
    const r = await createRow(w, s, n, t); // the tab's pending store replays the request
    await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250);
    await sleep(2500);
    const out = { fired: !fs.existsSync(w.marker) && /injected ENOSPC on renameSync/.test(s.log), first: p.status, firstErr: p.body?.error ?? null, replay: r.status, replayCreated: r.body?.created, sameRow: !!p.body?.row?.id && p.body.row.id === r.body?.row?.id, before: countIn(w, t), onDisk: rowsOfNonce(journal(w), n) };
    await waitIdleNoBridge(w, s);
    s = await restart(w, s);
    ageTranscript(w);
    await sleep(7000);
    out.after = countIn(w, t);
    return out;
  } finally { await cleanupWorld(w); }
}
/** (2) EIO on the journal fsync itself — BEFORE the commit point — then the replay, then a restart. */
async function e2eFsync(tree, tag) {
  let { w, s } = await faultWorld(tree, `${tag}f`);
  try {
    const t = `E2E-FSYNC-${tag} the journal fsync fails`;
    const n = nonce('wef');
    fs.writeFileSync(w.marker, JSON.stringify({ op: 'fsyncSync', suffix: '', code: 'EIO' }));
    const p = await createRow(w, s, n, t);
    const disk = rowsOfNonce(journal(w), n);
    const r = await createRow(w, s, n, t);
    await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250);
    await sleep(2500);
    const out = { fired: !fs.existsSync(w.marker), first: p.status, firstErr: p.body?.error ?? null, onDiskAfterError: disk, replay: r.status, replayCreated: r.body?.created, before: countIn(w, t) };
    await waitIdleNoBridge(w, s);
    s = await restart(w, s);
    ageTranscript(w);
    await sleep(7000);
    out.after = countIn(w, t);
    out.damaged = (await outboxGet(w, s)).damaged?.detail ?? null;
    return out;
  } finally { await cleanupWorld(w); }
}
/** (3) The round-5 outbox, synthesized: one nonce recorded twice — queued first, then delivered (the CLI already had it). */
async function e2eDup(tree, tag) {
  let { w, s } = await faultWorld(tree, `${tag}d`);
  try {
    await stopServer(s);
    const t = `E2E-DUP-${tag} recorded twice`;
    const n = nonce('wed');
    const now = Date.now();
    const A = {
      id: `q${crypto.randomBytes(8).toString('hex')}`, nonce: n, seq: 1, text: t, origin: 'queued', state: 'queued', reason: null,
      createdAt: now - 60_000, updatedAt: now - 60_000, forced: false, overrideExternal: false, via: null, confirmed: false, sentAt: null, sizeAtSend: null,
      resume: { projectId: w.projectId, encodedDir: w.enc, overrides: null, templateIds: null }, payload: 'synthesized-round5',
    };
    const B = { ...A, id: `q${crypto.randomBytes(8).toString('hex')}`, seq: 2, state: 'delivered', via: 'resume', confirmed: true, sentAt: now - 50_000, updatedAt: now - 50_000 };
    fs.mkdirSync(path.join(w.data, 'outbox'), { recursive: true });
    fs.writeFileSync(journal(w), `${JSON.stringify({ lsn: 1, rows: [A] })}\n${JSON.stringify({ lsn: 2, rows: [B] })}\n`);
    fs.writeFileSync(path.join(w.data, 'outbox', `${w.SDK}.head`), JSON.stringify({ lsn: 2 }));
    ageTranscript(w);
    s = await bootServer(w, w.env, { port: s.port });
    await sleep(8000);
    const v = await outboxGet(w, s);
    const once = { prior: 1, atCli: countIn(w, t), total: 1 + countIn(w, t), damaged: v.damaged?.detail ?? null, rows: v.rows.filter((r) => r.nonce === n).map((r) => r.state), loud: /duplicate/i.test(s.log) };
    // and a second restart: the settled journal loads clean and still sends nothing
    await waitIdleNoBridge(w, s);
    s = await restart(w, s);
    ageTranscript(w);
    await sleep(5000);
    once.afterSecondRestart = countIn(w, t);
    return once;
  } finally { await cleanupWorld(w); }
}
async function round6() {
  if (want('W')) {
    console.log('\n=== W. a disk fault at EVERY write op of every outbox transition — ENOSPC once, EIO once, EIO from then on, a short write ===');
    const res = await H.runMatrix(H.LIVE_OUTBOX);
    const byT = new Map();
    for (const r of res) { if (!byT.has(r.t)) byT.set(r.t, []); byT.get(r.t).push(r); }
    for (const [t, rs] of byT) {
      const base = rs.find((r) => r.k === 0);
      const faulted = rs.filter((r) => r.k > 0);
      const bad = faulted.filter((r) => r.violations.length);
      check(`W ${t}: a fault at each of its ${base.ops} write ops × ${H.MODES.length} modes — never twice, never silently lost, never stuck, Orchard's own words`,
        base.ops > 0 && !base.violations.length && faulted.length === base.ops * H.MODES.length && faulted.every((r) => r.fired) && !bad.length,
        bad.length ? { failing: bad.length, of: faulted.length, first: bad.slice(0, 4).map((r) => `k=${r.k} ${r.op} ${r.mode}: ${r.violations.join('; ')}`) } : { runs: faulted.length, ops: base.trace.join(' | ') });
    }
    const faulted = res.filter((r) => r.k > 0);
    check('W: not vacuous — every transition was exercised and every one of the injected faults actually fired', byT.size === H.TRANSITIONS.length && faulted.length > 500 && faulted.every((r) => r.fired), { transitions: byT.size, faultRuns: faulted.length, fired: faulted.filter((r) => r.fired).length });
    const a = await H.round5Attack(H.LIVE_OUTBOX);
    check('W round-5 attack: ENOSPC on the head rename after the journal fsync — the row is saved and acknowledged, the replay finds the SAME row, the CLI gets it once, and once after a restart',
      a.fired && a.firstOk && a.replayCreated === false && a.sameRow && a.beforeRestart === 1 && a.after === 1 && a.live === 0, a);
  }
  if (want('DN')) {
    console.log('\n=== DN. a journal that ALREADY holds one message twice (one nonce, two rows) ===');
    const shapes = [['queued', 'delivered'], ['delivered', 'queued'], ['queued', 'queued'], ['queued', 'queued', 'queued'], ['discarded', 'queued'], ['queued', 'discarded'], ['sending', 'queued'], ['queued', 'uncertain'], ['failed', 'delivered'], ['uncertain', 'queued', 'delivered']];
    for (const sh of shapes) {
      const d = await H.dupJournal(H.LIVE_OUTBOX, sh);
      const allQueued = sh.every((x) => x === 'queued');
      const keepLive = ['queued', 'sending', 'uncertain', 'failed'].includes(sh[0]);
      const expectLive = allQueued ? [] : keepLive ? ['uncertain'] : [];
      const ok = d.totalA <= 1 && (allQueued ? d.newA === 1 : d.newA === 0)
        && JSON.stringify(d.liveA1) === JSON.stringify(expectLive) && JSON.stringify(d.liveA2) === JSON.stringify(expectLive)
        && d.cAt === 1 && !!d.damaged && d.loud && d.logs2.length === 0;
      check(`DN ${d.shape}${d.prior ? ' (one copy already reached the CLI)' : ''}: the message goes at most once in all${allQueued ? ' (exactly once — no copy ever went)' : ', the kept row asks instead of sending'}; the unrelated row still goes once; loud, and the settled journal reloads clean`, ok, d);
    }
  }
  if (want('P5')) {
    console.log('\n=== MUST-FAIL P5 (pinned round-5 outbox.ts, in-process): the head-rename ENOSPC, and a journal holding one nonce twice ===');
    const { file, dir } = H.pinnedRound5Outbox();
    try {
      const a = await H.round5Attack(file);
      check('PRE-FIX P5: ENOSPC on the head rename — the POST fails with the row already on disk, the replay mints a SECOND row, and the CLI gets the message twice across a restart', a.fired && !a.firstOk && a.replayCreated === true && a.beforeRestart === 1 && a.after >= 2, a);
      const d = await H.dupJournal(file, ['queued', 'delivered']);
      check('PRE-FIX P5: the synthesized round-5 outbox (queued + delivered under one nonce) loads with no damage noticed and sends the queued copy — twice in all', d.totalA >= 2 && !d.damaged, d);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (want('WE')) {
    console.log('\n=== WE. end to end on a scratch server: head-rename ENOSPC, journal-fsync EIO, a synthesized round-5 outbox ===');
    const h = await e2eHead(ROOT, 'we');
    check('WE head: ENOSPC on the real server\'s head rename after the journal fsync — 201 (the row is saved), the replay is the same row, the CLI gets it once, and still once after a restart',
      h.fired && h.first === 201 && h.replay === 200 && h.replayCreated === false && h.sameRow && h.before === 1 && h.after === 1, h);
    const f = await e2eFsync(ROOT, 'we');
    check('WE fsync: EIO on the journal fsync — the POST answers 500 in Orchard\'s words, nothing of it is left on disk, the replay creates it, the CLI gets it once, and still once after a restart',
      f.fired && f.first === 500 && /could not save this to disk/.test(f.firstErr ?? '') && f.onDiskAfterError.length === 0 && f.replay === 201 && f.before === 1 && f.after === 1 && !f.damaged, f);
    const d = await e2eDup(ROOT, 'we');
    check('WE round-5 outbox: a journal holding one nonce twice (queued, then delivered) boots without sending it again — once in all, the kept row "not confirmed", a damage notice, loud; a second restart sends nothing either',
      d.atCli === 0 && d.total === 1 && JSON.stringify(d.rows) === '["uncertain"]' && !!d.damaged && d.loud && d.afterSecondRestart === 0, d);
  }
  if (want('P5E')) {
    console.log('\n=== MUST-FAIL P5E (a server booted from a scratch tree carrying the PINNED round-5 outbox.ts) ===');
    const tree = round5Tree();
    try {
      const h = await e2eHead(tree, 'p5e');
      check('PRE-FIX P5E head: the round-5 server answers 500 with the row already on disk, the replay mints a second row — the CLI gets the message twice across a restart', h.fired && h.first === 500 && h.onDisk.length === 2 && h.replayCreated === true && h.after >= 2, h);
      const d = await e2eDup(tree, 'p5e');
      check('PRE-FIX P5E round-5 outbox: the round-5 server loads one nonce twice without noticing and sends the queued copy — twice in all', d.total >= 2 && !d.damaged, d);
    } finally { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* */ } }
  }
}
try { await round6(); } catch (e) { fail++; failures.push(`FATAL (round 6): ${e.message}`); console.log(`  FATAL  ${e.stack}`); }

/* ============== round 7: one server per data dir (the kernel's lock), and a cut-off last line is not damage ============== */
/**
 * The round-6 state, SYNTHESIZED from today's tree (never HEAD): no data-dir lock at boot and an outbox that
 * checks no lock. `claimDataDir` answers "taken" without taking anything, and the outbox's `isWriter` is
 * always true. Every anchor must match exactly once, or this throws — it never quietly tests the fix.
 */
function round6Tree() {
  const dir = mkScratch('b217-round6-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  const patch = (rel, swaps) => { const f = path.join(dir, rel); fs.writeFileSync(f, swapAll(fs.readFileSync(f, 'utf8'), swaps, `round-6 baseline ${rel}`)); };
  patch('src/server/lanes.ts', [['export async function claimDataDir({ port, waitMs, pollMs = 200, onWait }: { port: number | null; waitMs: number; pollMs?: number; onWait?: (holder: ClaimIdentity | null) => void }): Promise<DataDirClaim> {\n',
    'export async function claimDataDir({ port, waitMs, pollMs = 200, onWait }: { port: number | null; waitMs: number; pollMs?: number; onWait?: (holder: ClaimIdentity | null) => void }): Promise<DataDirClaim> {\n  return { ok: true, name: \'round-6: no lock\', waitedMs: 0 };\n']]);
  patch('src/server/outbox.ts', [["import { isWriter, holdsLock, onWriterLost, writerDataDir } from './lanes.ts';\n",
    'const isWriter = (): boolean => true; // round 6: the outbox took no lock\nconst holdsLock = (): boolean => true;\nconst onWriterLost = (_fn: (why: string) => void): void => {};\nconst writerDataDir = (): string => dataDir();\n']]);
  return dir;
}
/** Boot a server that may refuse: never throws; resolves once it is healthy or has exited. */
async function bootMaybe(w, env = {}) {
  let srv = null, err = null;
  try { srv = await bootServer(w, { ...w.env, ...env }); } catch (e) { err = e; srv = w.servers[w.servers.length - 1]; }
  if (err) for (let i = 0; i < 40 && srv.proc.exitCode === null && srv.proc.signalCode === null; i++) await sleep(100);
  return { srv, healthy: !err, exit: srv.proc.exitCode, log: () => srv.log };
}
/** A row created while nothing may go ("another program is writing" the transcript), so a second server's boot loads it too. */
async function heldRow(w, s, tag) {
  touchTranscript(w);
  const t = `R7-${tag} one data dir, one sender`;
  const r = await createRow(w, s, nonce(tag), t);
  if (r.status !== 201) throw new Error(`[${tag}] could not queue the row: ${r.status} ${JSON.stringify(r.body)}`);
  return t;
}
/** L1 / P6: a second server on the same data dir while the first holds a queued row. */
async function twoServers(tree, tag) {
  const w = newWorld(`b217${tag}`, { tree });
  try {
    const a = await bootServer(w, w.env);
    w.projectId = await registerProject(a, w);
    await warmUp(w, a);
    const t = await heldRow(w, a, tag);
    const b = await bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' });
    ageTranscript(w);
    await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250);
    // The first delivery's turn writes the transcript, which holds the other server back ("another program is
    // writing"); once that turn is over and the transcript quiet again, a second holder of the row sends it too.
    await waitIdleNoBridge(w, a);
    ageTranscript(w);
    await sleep(8000);
    await waitIdleNoBridge(w, a);
    ageTranscript(w);
    await sleep(5000);
    const refusal = (b.log().match(/REFUSING TO START[^\n]*/) ?? [''])[0];
    return { atCli: countIn(w, t), bHealthy: b.healthy, bExit: b.exit, aPid: a.proc.pid, aPort: a.port, refusal: refusal.slice(0, 240),
      namesHolder: refusal.includes(`pid ${a.proc.pid}`) && refusal.includes(`port ${a.port}`), aAlive: a.proc.exitCode === null };
  } finally { await cleanupWorld(w); }
}
async function round7() {
  if (want('L1')) {
    console.log('\n=== L1. two servers on ONE data dir (the round-6 clean-room break) — the second refuses; the message goes once ===');
    const r = await twoServers(ROOT, 'l1');
    check('L1: the second server refuses to start — exit 78, "REFUSING TO START", naming the holder\'s pid and port — and the queued message reaches the CLI exactly once',
      !r.bHealthy && r.bExit === 78 && r.namesHolder && r.aAlive && r.atCli === 1, r);
  }
  if (want('P6')) {
    console.log('\n=== MUST-FAIL P6 (the round-6 state, synthesized: no data-dir lock, an outbox that checks none) ===');
    const tree = round6Tree();
    try {
      const r = await twoServers(tree, 'p6');
      check('PRE-FIX P6: both servers boot on one data dir, each sends the row from its own memory — the CLI gets it twice', r.bHealthy && r.atCli === 2, r);
    } finally { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* */ } }
  }
  if (want('L2')) {
    console.log('\n=== L2. kill -9 of the holder frees the lock at once — a new server starts without waiting, and delivers once ===');
    const w = newWorld('b217l2');
    try {
      const a = await bootServer(w, w.env);
      w.projectId = await registerProject(a, w);
      await warmUp(w, a);
      const t = await heldRow(w, a, 'l2');
      process.kill(a.proc.pid, 'SIGKILL');
      await waitFor(() => (!pidAlive(a.proc.pid) ? true : null), 10_000, 50);
      const t0 = Date.now();
      const b = await bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '0' });
      const bootMs = Date.now() - t0;
      if (b.healthy) { ageTranscript(w); await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250); await sleep(5000); }
      check('L2: after kill -9 of the holder a new server takes the lock with NO wait (the kernel freed it) and delivers the queued row once',
        b.healthy && !/waiting up to/.test(b.log()) && countIn(w, t) === 1, { healthy: b.healthy, exit: b.exit, bootMs, waited: /waiting up to/.test(b.log()), atCli: countIn(w, t), tail: b.healthy ? '' : b.log().slice(-300) });
    } finally { await cleanupWorld(w); }
  }
  if (want('L3')) {
    console.log('\n=== L3. a restart overlap: the new server starts while the old one still runs — it waits, then takes over ===');
    const w = newWorld('b217l3');
    try {
      const a = await bootServer(w, w.env);
      w.projectId = await registerProject(a, w);
      await warmUp(w, a);
      const t = await heldRow(w, a, 'l3');
      const n0 = w.servers.length;
      const bP = bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '30000' });
      await waitFor(() => (w.servers.length > n0 ? true : null), 10_000, 20); // bootServer registers it after picking a port
      const b = w.servers[w.servers.length - 1];
      const waiting = await waitFor(() => (/waiting up to 30s/.test(b.log) ? true : null), 20_000, 100);
      let bAnsweredEarly = false;
      try { bAnsweredEarly = (await fetch(`http://127.0.0.1:${b.port}/api/health`)).ok; } catch { /* not listening: right */ }
      const waitLine = (b.log.match(/data dir [^\n]*waiting up to[^\n]*/) ?? [''])[0];
      await stopServer(a); // what systemd's restart sends; the new process is already up and waiting
      const r = await bP;
      if (r.healthy) { ageTranscript(w); await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250); await sleep(5000); }
      check('L3: the overlapping server waits (says for whom), does not serve while the old one lives, then boots once it exits — and the queued row goes once',
        !!waiting && !bAnsweredEarly && waitLine.includes(`pid ${a.proc.pid}`) && r.healthy && /data dir lock taken after waiting/.test(r.log()) && countIn(w, t) === 1,
        { waiting: !!waiting, bAnsweredEarly, waitLine: waitLine.slice(0, 200), healthy: r.healthy, exit: r.exit, atCli: countIn(w, t) });
    } finally { await cleanupWorld(w); }
  }
  if (want('L4')) {
    console.log('\n=== L4. a NON-server process reaching the outbox (the clean-room\'s two-instance case) while a server holds the data dir ===');
    const w = newWorld('b217l4');
    const saved = process.env.CLAUDE_STATION_DATA;
    try {
      const a = await bootServer(w, w.env);
      w.projectId = await registerProject(a, w);
      await warmUp(w, a);
      const t = await heldRow(w, a, 'l4');
      const before = fs.readFileSync(journal(w));
      process.env.CLAUDE_STATION_DATA = w.data;
      const lanes = await H.lanesModule();
      const claim = await lanes.claimWriter();
      const holder = await lanes.claimHolder();
      const m = await H.loadOutbox(H.LIVE_OUTBOX);
      const ctl = H.makeCtl();
      ctl.go = true;
      m.startOutbox(ctl.wiring);
      await sleep(3000);
      let err = null;
      try { m.createOutboxRow(w.SDK, { nonce: nonce('l4x'), text: 'R7-L4 from a second process', resume: { projectId: w.projectId, encodedDir: w.enc, overrides: null, templateIds: null } }); } catch (e) { err = e; }
      const view = m.outboxView(w.SDK);
      m.stopOutbox();
      const after = fs.readFileSync(journal(w));
      check('L4: the second process cannot take the lock (the holder names itself), writes NOTHING, and hands nothing to its CLI — even with the queued row loaded and the session free',
        !claim.ok && holder?.pid === a.proc.pid && holder?.port === a.port && err?.status === 503 && /does not hold the lock/.test(err?.message ?? '')
          && Buffer.compare(before, after) === 0 && ctl.prompts.length === 0 && view.rows.some((r) => r.text === t && r.state === 'queued'),
        { claim: claim.ok ? 'TAKEN' : claim.reason, holder, err: err ? `${err.status} ${String(err.message).slice(0, 100)}` : null, journalUnchanged: Buffer.compare(before, after) === 0, prompts: ctl.prompts.length, hold: view.hold });
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = saved;
      await cleanupWorld(w);
    }
  }
  /** A saved, never-sent row, then a LATER create cut off mid-line by a crash (no newline, head not advanced). */
  const tornWorld = async (file) => {
    const q = { logs: [] };
    const w = new H.World(file, 'torn');
    await w.start();
    w.create('a');                  // saved; the session is busy, so it waits
    await H.settle();
    const saved = fs.readFileSync(w.journal, 'utf8');
    w.stop();
    const later = JSON.stringify({ lsn: saved.trim().split('\n').length + 1, rows: [w.rowRecord('b', 'queued', { seq: 2 })] });
    w.msg('b').intent = 'none';
    fs.appendFileSync(w.journal, later.slice(0, Math.floor(later.length / 2)));
    const err = console.error; console.error = (...a) => { q.logs.push(a.join(' ')); };
    try {
      await w.restart();
      const v0 = w.m.outboxView(w.sid);
      await w.deliver();
      await w.deliver();
      const a1 = w.atCli('a').total;
      w.create('c');
      await w.deliver();
      await w.restart();
      await w.deliver();
      const v2 = w.m.outboxView(w.sid);
      return { stateAfterLoad: v0.rows.find((r) => r.nonce === w.msg('a').nonce)?.state ?? null, damagedAfterLoad: v0.damaged?.detail ?? null,
        aAtCli: a1, aTotal: w.atCli('a').total, cAtCli: w.atCli('c').total, damagedAfterNext: v2.damaged?.detail ?? null,
        journalWhole: fs.readFileSync(w.journal, 'utf8').split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
        logged: q.logs.some((l) => /dropped a cut-off last line/.test(l)) };
    } finally { console.error = err; w.cleanup(); }
  };
  if (want('T')) {
    console.log('\n=== T. a cut-off LAST line (a later create the process died in the middle of) — the earlier saved row still goes by itself ===');
    const r = await tornWorld(H.LIVE_OUTBOX);
    check('T: the earlier saved, never-sent row stays queued and goes by itself exactly once; no damage notice; the fragment is dropped (logged) so the next line and the next restart load clean',
      r.stateAfterLoad === 'queued' && !r.damagedAfterLoad && r.aAtCli === 1 && r.aTotal === 1 && r.cAtCli === 1 && !r.damagedAfterNext && r.journalWhole && r.logged, r);
  }
  if (want('P6T')) {
    console.log('\n=== MUST-FAIL P6T (the PINNED round-5 outbox.ts — the same cut-off-line branch round 6 shipped) ===');
    const { file, dir } = H.pinnedRound5Outbox();
    try {
      const pinnedSrc = fs.readFileSync(file, 'utf8');
      const r = await tornWorld(file);
      check('PRE-FIX P6T: the cut-off later line marks the earlier saved row "not confirmed" and it is NOT sent by itself',
        pinnedSrc.includes("'its last line is cut off'") && r.stateAfterLoad === 'uncertain' && !!r.damagedAfterLoad && r.aAtCli === 0, r);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
try { await round7(); } catch (e) { fail++; failures.push(`FATAL (round 7): ${e.message}`); console.log(`  FATAL  ${e.stack}`); }

/* ============== round 8: the data dir's lock follows its INODE — bind mounts, other namespaces, a stopped holder ============== */
/**
 * The round-7 state, PINNED (scripts/fixtures/bug-217/round7/, sha256-listed): the real round-7 lanes.ts — an abstract
 * unix socket named from the data dir's realpath — laid over a scratch copy of today's tree. It lacks today's
 * `describeHolder`, so the round-7 index.ts wording is appended as that export, and today's "held" reason is mapped back
 * to round 7's EADDRINUSE. Every anchor must match once, or this throws.
 */
/**
 * Round 9 added three lanes exports that today's outbox and index.ts import. An OLDER lanes.ts laid over today's
 * tree gets them as the older behaviour: no loss is ever detected, the outbox is reached by its path, and "holds
 * the lock" is just "is the writer". Nothing else of the older file changes.
 */
const ROUND9_SHIMS = `
export function onWriterLost(_fn: (why: string) => void): void { /* before round 9: a holder never noticed losing its dir */ }
export function writerLostReason(): string | null { return null; }
export function holdsLock(): boolean { return isWriter(); }
export function writerDataDir(): string { return path.resolve(dataDir()); }
`;
function round7Tree() {
  const pin = path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'round7');
  const sums = Object.fromEntries(fs.readFileSync(path.join(pin, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
  const body = zlib.gunzipSync(fs.readFileSync(path.join(pin, 'src__server__lanes.ts.gz')));
  const h = crypto.createHash('sha256').update(body).digest('hex');
  if (h !== sums['src/server/lanes.ts']) throw new Error(`pinned round-7 lanes.ts: sha256 ${h} does not match SHA256SUMS — the fixture is damaged`);
  const src = body.toString('utf8');
  if (!src.includes("if (process.platform === 'linux') return `\\0orchard-lanes-${key}`;")) throw new Error('pinned round-7 lanes.ts is not the abstract-socket claim');
  const dir = mkScratch('b217-round7-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, 'src', 'server', 'lanes.ts'), `${src}\nexport function describeHolder(h: ClaimIdentity | null): string { return h ? \`pid \${h.pid}\${h.port != null ? \`, port \${h.port}\` : ''}\` : 'a process that did not say who it is'; }\n${ROUND9_SHIMS}`);
  const f = path.join(dir, 'src', 'server', 'index.ts');
  fs.writeFileSync(f, swapAll(fs.readFileSync(f, 'utf8'), [["  if (!lock.ok && lock.reason === 'held') {\n", "  if (!lock.ok && lock.reason === 'EADDRINUSE') {\n"]], 'round-7 baseline index.ts'));
  return dir;
}
/**
 * Boot a second server on this world's data dir behind a command prefix (`unshare …`), reaching the dir as `data`.
 * From another network namespace its port cannot be probed, so "up" is its listen line. Never throws.
 */
async function bootWrapped(w, { data = w.data, prefix = [], env = {}, waitMs = 45_000 } = {}) {
  const p = await freePort();
  const full = isolatedServerEnv({
    PORT: String(p), CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: w.store, CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI,
    FAKE_CMD_DIR: w.cmd, FAKE_LOG: w.log, FAKE_TAP: w.tap, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...w.env, ...env,
  });
  const entry = path.join(w.tree, 'src', 'server', 'index.ts');
  const proc = prefix.length
    ? spawn(prefix[0], [...prefix.slice(1), process.execPath, entry], { cwd: w.tree, env: full, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [entry], { cwd: w.tree, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { port: p, proc, log: '' };
  proc.stdout.on('data', (d) => { srv.log += String(d); });
  proc.stderr.on('data', (d) => { srv.log += String(d); });
  w.servers.push(srv);
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < waitMs) {
    if (proc.exitCode !== null || proc.signalCode) break;
    if (srv.log.includes(`[orchard] http://`)) { up = true; break; }
    await sleep(200);
  }
  return { srv, healthy: up, exit: proc.exitCode, log: () => srv.log };
}
/** The two spellings round 7's name could not see. Each returns the boot of a second server reaching w.data. */
const SPELLINGS = {
  bind: (w) => {
    const alias = path.join(w.base, 'data-bind');
    fs.mkdirSync(alias, { recursive: true });
    return bootWrapped(w, { data: alias, prefix: ['unshare', '-rm', '--', 'sh', '-c', `mount --bind '${w.data}' '${alias}' && exec "$0" "$@"`], env: { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' } });
  },
  netns: (w) => bootWrapped(w, { prefix: ['unshare', '-rn', '--', 'sh', '-c', 'ip link set lo up && exec "$0" "$@"'], env: { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' } }),
  symlink: (w) => { const l = path.join(w.base, 'data-link'); fs.symlinkSync(w.data, l); return bootWrapped(w, { data: l, env: { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' } }); },
  relative: (w) => bootWrapped(w, { data: `${path.relative(w.tree, w.base)}/work/../data/`, env: { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' } }),
};
/** A holds a queued row; a second server reaches the same dir by `how`. Then give a second holder every chance to send it. */
async function secondBy(tree, tag, how, { stopA = false } = {}) {
  const w = newWorld(`b217${tag}`, { tree });
  try {
    const a = await bootServer(w, w.env);
    w.projectId = await registerProject(a, w);
    await warmUp(w, a);
    const t = await heldRow(w, a, tag);
    if (stopA) process.kill(a.proc.pid, 'SIGSTOP');
    const t0 = Date.now();
    const b = await SPELLINGS[how](w);
    const decidedMs = Date.now() - t0;
    if (stopA) process.kill(a.proc.pid, 'SIGCONT');
    ageTranscript(w);
    await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250);
    for (let i = 0; i < 2; i++) { await waitIdleNoBridge(w, a); ageTranscript(w); await sleep(7000); }
    const refusal = (b.log().match(/REFUSING TO START[^\n]*/) ?? [''])[0];
    return { atCli: countIn(w, t), bHealthy: b.healthy, bExit: b.srv.proc.exitCode, decidedMs, aPid: a.proc.pid, aPort: a.port, refusal: refusal.slice(0, 400),
      namesHolder: refusal.includes(`pid ${a.proc.pid}`) && refusal.includes(`port ${a.port}`), aAlive: a.proc.exitCode === null,
      bTail: b.healthy || b.srv.proc.exitCode === 78 ? '' : b.log().slice(-600) };
  } finally { await cleanupWorld(w); }
}
/** Round 9: the lock is on the data DIRECTORY; this sidecar only names the holder (round 8 wrote it into its lock file). */
const HOLDER_FILE = '.orchard-server.holder';
async function round8() {
  const refuses = (r) => !r.bHealthy && r.bExit === 78 && r.namesHolder && r.aAlive && r.atCli === 1;
  for (const [id, how, what] of [['M1', 'bind', 'a BIND MOUNT at another path (a container volume)'], ['M2', 'netns', 'the same path from another NETWORK NAMESPACE']]) {
    if (want(id)) {
      console.log(`\n=== ${id}. a second server reaching the data dir through ${what} — refused, naming the holder; the row goes once ===`);
      const r = await secondBy(ROOT, id.toLowerCase(), how);
      check(`${id}: through ${what} the second server refuses (exit 78, naming the holder's pid and port) and the queued row reaches the CLI exactly once`, refuses(r)
        && (how !== 'netns' || /network namespace net:\[/.test(r.refusal)), r);
    }
  }
  for (const [id, how, what] of [['P7B', 'bind', 'a bind mount'], ['P7N', 'netns', 'another network namespace']]) {
    if (want(id)) {
      console.log(`\n=== MUST-FAIL ${id} (the PINNED round-7 lanes.ts: a lock named from the realpath, in the per-netns abstract namespace) — ${what} ===`);
      const tree = round7Tree();
      try {
        const r = await secondBy(tree, id.toLowerCase(), how);
        check(`PRE-FIX ${id}: through ${what} the round-7 lock is not seen — the second server boots and the CLI gets the row twice`, r.bHealthy && r.atCli === 2, r);
      } finally { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* */ } }
    }
  }
  for (const [id, how, what] of [['M3', 'symlink', 'a SYMLINK to it'], ['M4', 'relative', 'a RELATIVE path with .. and a trailing slash']]) {
    if (want(id)) {
      console.log(`\n=== ${id}. a second server reaching the data dir through ${what} ===`);
      const r = await secondBy(ROOT, id.toLowerCase(), how);
      check(`${id}: through ${what} the second server refuses (exit 78, naming the holder's pid and port) and the row goes once`, refuses(r), r);
    }
  }
  if (want('M5')) {
    console.log('\n=== M5. the holder is SIGSTOPped — it cannot answer anything, yet the refusal names its pid and port ===');
    const r = await secondBy(ROOT, 'm5', 'symlink', { stopA: true });
    check('M5: with the holder stopped, the second server refuses in bounded time, naming the holder\'s pid and port (read from the lock file, not asked), and the row goes once after SIGCONT',
      refuses(r) && r.decidedMs < 15_000, r);
  }
  if (want('M6')) {
    console.log('\n=== M6. two DIFFERENT data dirs both start (the lock is per directory, not per host) ===');
    const w1 = newWorld('b217m6a'), w2 = newWorld('b217m6b');
    try {
      const a = await bootMaybe(w1), b = await bootMaybe(w2);
      const locks = [w1, w2].map((w) => JSON.parse(fs.readFileSync(path.join(w.data, HOLDER_FILE), 'utf8')));
      check('M6: two servers on two different data dirs both boot, each holding (and naming itself in) its own dir\'s lock',
        a.healthy && b.healthy && locks[0].pid === a.srv.proc.pid && locks[1].pid === b.srv.proc.pid && locks[0].port === a.srv.port && locks[1].port === b.srv.port,
        { a: a.healthy, b: b.healthy, locks: locks.map((l) => ({ pid: l.pid, port: l.port })) });
    } finally { await cleanupWorld(w1); await cleanupWorld(w2); }
  }
  if (want('M7')) {
    console.log('\n=== M7. kill -9 leaves the holder record on disk — and it blocks nothing ===');
    const w = newWorld('b217m7');
    try {
      const a = await bootServer(w, w.env);
      process.kill(a.proc.pid, 'SIGKILL');
      await waitFor(() => (!pidAlive(a.proc.pid) ? true : null), 10_000, 50);
      const lockFile = path.join(w.data, HOLDER_FILE);
      const left = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null;
      const t0 = Date.now();
      const b = await bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '0' });
      const now = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      check('M7: the dead holder\'s file and record are still there, and the next server boots with no wait and rewrites the record as itself',
        left?.pid === a.proc.pid && b.healthy && !/waiting up to/.test(b.log()) && now.pid === b.srv.proc.pid,
        { leftPid: left?.pid, deadPid: a.proc.pid, healthy: b.healthy, bootMs: Date.now() - t0, nowPid: now.pid });
    } finally { await cleanupWorld(w); }
  }
}
try { await round8(); } catch (e) { fail++; failures.push(`FATAL (round 8): ${e.message}`); console.log(`  FATAL  ${e.stack}`); }

/* ============== round 9: the lock is on the data DIRECTORY; a holder whose path drifts stops and exits ============== */
/**
 * The round-8 state, PINNED (scripts/fixtures/bug-217/round8/, sha256-listed): the real round-8 lanes.ts — a flock on
 * `<data dir>/.orchard-server.lock`, checked against the path only when taken — laid over a scratch copy of today's
 * tree, with round 9's three new exports shimmed as round-8 behaviour (ROUND9_SHIMS). Never HEAD, never "current".
 */
function round8Tree() {
  const pin = path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'round8');
  const sums = Object.fromEntries(fs.readFileSync(path.join(pin, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
  const body = zlib.gunzipSync(fs.readFileSync(path.join(pin, 'src__server__lanes.ts.gz')));
  const h = crypto.createHash('sha256').update(body).digest('hex');
  if (h !== sums['src/server/lanes.ts']) throw new Error(`pinned round-8 lanes.ts: sha256 ${h} does not match SHA256SUMS — the fixture is damaged`);
  const src = body.toString('utf8');
  if (!src.includes("export const DATA_DIR_LOCK_FILE = '.orchard-server.lock';") || src.includes('onWriterLost')) throw new Error('pinned round-8 lanes.ts is not the lock-FILE claim');
  const dir = mkScratch('b217-round8-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, 'src', 'server', 'lanes.ts'), `${src}\n${ROUND9_SHIMS}`);
  return dir;
}
const rowsOfText = (f, text) => { const out = new Map(); try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { for (const r of JSON.parse(l).rows ?? []) if (r.text === text) out.set(r.id, r.state); } catch { /* torn */ } } } catch { /* none */ } return [...out.values()]; };
/**
 * The round-8 verifier's three attacks on a LIVE holder (A holds a queued row): the file the holder wrote into the
 * data dir is unlinked, or replaced by a rename; or the whole dir is moved away and a `cp -a` copy put back at its
 * path. Then a second server starts on the path, and both get every chance to send the row.
 */
async function disturbed(tree, tag, how) {
  const w = newWorld(`b217${tag}`, { tree });
  const moved = `${w.data}-moved`;
  try {
    const a = await bootServer(w, w.env);
    w.projectId = await registerProject(a, w);
    await warmUp(w, a);
    const t = await heldRow(w, a, tag);
    const file = [path.join(w.data, '.orchard-server.lock'), path.join(w.data, HOLDER_FILE)].find((f) => fs.existsSync(f));
    if (!file && how !== 'movedir') throw new Error(`[${tag}] precondition: the holder wrote no file into the data dir`);
    if (how === 'unlink') fs.unlinkSync(file);
    if (how === 'replace') { fs.writeFileSync(`${file}.new`, ''); fs.renameSync(`${file}.new`, file); }
    if (how === 'movedir') { fs.renameSync(w.data, moved); execFileSync('cp', ['-a', moved, w.data]); }
    const b = await bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1500' });
    ageTranscript(w);
    await waitFor(() => (countIn(w, t) >= 1 ? true : null), 30_000, 250);
    // Give BOTH every chance: the first delivery's turn holds the other back until the transcript is quiet again.
    for (let i = 0; i < 3; i++) { await waitIdleNoBridge(w, b.healthy ? b.srv : a); ageTranscript(w); await sleep(6000); }
    const refusal = (b.log().match(/REFUSING TO START[^\n]*/) ?? [''])[0];
    return {
      atCli: countIn(w, t), bHealthy: b.healthy, bExit: b.srv.proc.exitCode, refusal: refusal.slice(0, 300),
      aAlive: a.proc.exitCode === null && !a.proc.signalCode, aExit: a.proc.exitCode,
      aSaidLost: /DATA DIR LOST/.test(a.log) && /EXITING/.test(a.log),
      movedRows: how === 'movedir' ? rowsOfText(path.join(moved, 'outbox', `${w.SDK}.jsonl`), t) : null,
      pathRows: rowsOfText(path.join(w.data, 'outbox', `${w.SDK}.jsonl`), t),
      aLost: (a.log.match(/DATA DIR LOST[^\n]*/) ?? [''])[0].slice(0, 200),
    };
  } finally {
    if (fs.existsSync(moved)) { const saved = w.data; w.data = moved; for (const h of hostRecords(w)) for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } w.data = saved; }
    await cleanupWorld(w);
  }
}
/** Run the in-process drift child (scripts/fixtures/bug-217/drift-child.mjs): the dir moves mid-save of `sending`. */
function driftChild(tree) {
  const run = (...a) => { const o = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'drift-child.mjs'), ...a], { encoding: 'utf8', timeout: 60_000 }); return JSON.parse(o.trim().split('\n').pop()); };
  const h = run('holder', ...(tree ? [tree] : []));
  try {
    const c = run('copy', h.data, h.sid, h.text, ...(tree ? [tree] : []));
    return { ...h, copyPrompts: c.copyPrompts, copyRowsAfter: c.rows, total: h.holderPrompts + c.copyPrompts };
  } finally { for (const d of [h.data, h.moved]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } }
}
async function round9() {
  for (const [id, how, what] of [['D1', 'unlink', 'the holder\'s file in the data dir UNLINKED'], ['D2', 'replace', 'the holder\'s file REPLACED by a rename']]) {
    if (want(id)) {
      console.log(`\n=== ${id}. ${what} while a server holds the dir — the lock is the directory, so a second server is still refused ===`);
      const r = await disturbed(ROOT, id.toLowerCase(), how);
      check(`${id}: with ${what}, the second server still refuses (exit 78, REFUSING TO START), the holder keeps running, and the queued row reaches the CLI exactly once`,
        !r.bHealthy && r.bExit === 78 && !!r.refusal && r.aAlive && r.atCli === 1, r);
    }
  }
  if (want('D3')) {
    console.log('\n=== D3. the data dir MOVED away and a cp -a copy put back at its path, while a server holds it ===');
    const r = await disturbed(ROOT, 'd3', 'movedir');
    check('D3: the copy at the path is a new directory, so a server may start there — but the drifted holder stops (loud, exit 75), the row reaches the CLI at most once (here exactly once), and the moved dir keeps the row as "not confirmed" (uncertain), not lost',
      r.atCli === 1 && !r.aAlive && r.aExit === 75 && r.aSaidLost && Array.isArray(r.movedRows) && r.movedRows.length === 1 && r.movedRows[0] === 'uncertain', r);
  }
  for (const [id, how, what] of [['P8U', 'unlink', 'the lock file unlinked'], ['P8R', 'replace', 'the lock file replaced by a rename'], ['P8D', 'movedir', 'the data dir moved and copied back']]) {
    if (want(id)) {
      console.log(`\n=== MUST-FAIL ${id} (the PINNED round-8 lanes.ts: a flock on a FILE, checked only when taken) — ${what} ===`);
      const tree = round8Tree();
      try {
        const r = await disturbed(tree, id.toLowerCase(), how);
        check(`PRE-FIX ${id}: with ${what}, the round-8 holder never notices — a second server boots, both stay up, and the CLI gets the row twice`, r.bHealthy && r.aAlive && r.atCli === 2, r);
      } finally { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* */ } }
    }
  }
  if (want('D4')) {
    console.log('\n=== D4. the dir moves and a copy lands at its path in the MIDDLE of saving "sending" (after the first ownership check) ===');
    const r = driftChild(null);
    check('D4: the save lands in the dir this process holds (never the copy), the re-check before handover finds the drift and hands NOTHING over, the held dir keeps the row "not confirmed", and the copy\'s own server sends it once — once in all',
      r.fired && r.holderPrompts === 0 && !!r.lost && r.loggedLost && r.loggedNothingHanded && r.movedRows.join() === 'uncertain' && r.copyRows.join() === 'queued' && r.copyPrompts === 1 && r.total === 1, r);
  }
  if (want('P8I')) {
    console.log('\n=== MUST-FAIL P8I (the PINNED round-8 lanes.ts) — the same mid-save move ===');
    const tree = round8Tree();
    try {
      const r = driftChild(tree);
      check('PRE-FIX P8I: the round-8 holder writes its "sending"/"delivered" lines into the COPY at the path (a directory it does not hold) and hands the row over anyway',
        r.fired && r.holderPrompts === 1 && ['sending', 'delivered'].includes(r.copyRows.join()) && r.movedRows.join() === 'queued', r);
    } finally { try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* */ } }
  }
  if (want('F1')) {
    console.log('\n=== F1. the lock fd does not leak into children: a restart is not held up by a surviving session host / CLI ===');
    const w = newWorld('b217f1');
    try {
      const a = await bootServer(w, w.env);
      w.projectId = await registerProject(a, w);
      await warmUp(w, a);
      const { c, e } = await rawStart(a, { type: 'start', projectId: w.projectId, prompt: 'F1 a long turn [[fake:{"op":"sleep","ms":60000}]]', resumeSessionId: w.SDK, resumeEncodedDir: w.enc, overrides: { permissionMode: 'default' } });
      await sleep(2500);
      const hosts = hostRecords(w).filter((h) => pidAlive(h.hostPid) || pidAlive(h.claudePid));
      const dir = fs.statSync(w.data);
      /** Every process with an fd on the data DIRECTORY's inode (what the lock is on). */
      const holders = () => {
        const out = [];
        for (const p of fs.readdirSync('/proc')) {
          if (!/^\d+$/.test(p)) continue;
          let fds = [];
          try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { continue; }
          for (const f of fds) { try { const st = fs.statSync(`/proc/${p}/fd/${f}`); if (st.ino === dir.ino && st.dev === dir.dev) out.push(Number(p)); } catch { /* gone */ } }
        }
        return [...new Set(out)];
      };
      const before = holders();
      const childPids = hosts.flatMap((h) => [h.hostPid, h.claudePid]).filter(Boolean);
      c?.close();
      await stopServer(a); // what systemd's restart sends; the session host and its CLI outlive it by design
      await waitFor(() => (!pidAlive(a.proc.pid) ? true : null), 10_000, 50);
      const survivors = childPids.filter((p) => pidAlive(p));
      const after = holders();
      const t0 = Date.now();
      const b = await bootMaybe(w, { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '0' });
      check('F1: while a session host and its CLI survive the server, no process but the server ever had an fd on the locked dir, and the restarted server takes the lock at once (no wait, no refusal)',
        e?.t === 'ack' && survivors.length > 0 && before.length === 1 && before[0] === a.proc.pid && after.length === 0 && b.healthy && !/waiting up to/.test(b.log()) && !/REFUSING/.test(b.log()),
        { started: e?.t, childPids, survivors, holdersBefore: before, serverPid: a.proc.pid, holdersAfter: after, healthy: b.healthy, bootMs: Date.now() - t0 });
    } finally { await cleanupWorld(w); }
  }
}
try { await round9(); } catch (e) { fail++; failures.push(`FATAL (round 9): ${e.message}`); console.log(`  FATAL  ${e.stack}`); }
if (!needMain) {
  console.log(`\nBUG-217: ${pass} passed / ${fail} failed`);
  if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

/* ================================================================== browser */
const browser = await chromium.launch({ headless: true, executablePath: BRAVE, args: ['--no-sandbox'] });
async function newTab(ctx, { body = null } = {}) {
  const page = await ctx.newPage({ viewport: { width: 1280, height: 860 } });
  if (body) await page.route('**/app.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
  page.on('pageerror', (e) => console.log(`        (page error: ${e.message.slice(0, 160)})`));
  return page;
}
const urlOf = (w, srv, sid) => `http://127.0.0.1:${srv.port}/#/project/${encodeURIComponent(w.projectId)}/session/${sid}?dir=${encodeURIComponent(w.enc)}`;
async function openAt(page, w, srv, sid = w.SDK) {
  await page.goto(urlOf(w, srv, sid), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((s) => window.__station?.state?.current?.sessionId === s, sid, { timeout: 45_000 });
  await page.waitForFunction(() => !document.querySelector('#panes .hint-row')?.textContent?.includes('reading the transcript'), null, { timeout: 30_000 }).catch(() => {});
}
async function typeSend(page, text) {
  await page.evaluate((t) => {
    const p = document.querySelector('#prompt');
    p.value = t;
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, text);
}
const dock = (page) => page.evaluate(() => ({
  hidden: document.querySelector('#queueBox').hidden,
  label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  rows: [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({
    text: r.querySelector('.qedit')?.value ?? '',
    status: r.querySelector('.qs')?.textContent ?? '',
    acts: [...r.querySelectorAll('.qracts button')].map((b) => b.textContent),
  })),
  queue: window.__station.state.queue.length,
}));
const youHas = (page, needle) => page.evaluate((n) => [...document.querySelectorAll('#panes .you')].filter((b) => b.textContent.includes(n)).length, needle);
/** Queue a message mid-turn from the real composer (the seed turn sleeps `sleepMs` in the fake CLI). */
async function queueMidTurn(page, tag, { sleepMs = 5000, more = [] } = {}) {
  await typeSend(page, `seed ${tag} [[fake:{"op":"sleep","ms":${sleepMs}}]]`);
  const busy = await page.waitForFunction(() => window.__station.state.busy === true && window.__station.state.live, null, { timeout: 45_000 }).then(() => true, () => false);
  if (!busy) throw new Error(`[${tag}] the seed turn never started`);
  for (const t of [`QUEUED-${tag} btw when trying to buy it says 403`, ...more]) {
    await typeSend(page, t);
    const ok = await page.waitForFunction((x) => window.__station.state.queue.some((q) => q.text === x && q.state !== 'pending'), t, { timeout: 8000 }).then(() => true, () => false);
    if (!ok) throw new Error(`[${tag}] the mid-turn message never reached the server outbox: ${t}`);
  }
}
/** Round 1…4 clients: the same helper, but their rows are acknowledged by nothing but the tab itself. */
async function queueMidTurnOld(page, tag, { sleepMs = 5000 } = {}) {
  await typeSend(page, `seed ${tag} [[fake:{"op":"sleep","ms":${sleepMs}}]]`);
  const busy = await page.waitForFunction(() => window.__station.state.busy === true && window.__station.state.live, null, { timeout: 45_000 }).then(() => true, () => false);
  if (!busy) throw new Error(`[${tag}] the seed turn never started`);
  const t = `QUEUED-${tag} btw when trying to buy it says 403`;
  await typeSend(page, t);
  const ok = await page.waitForFunction((x) => window.__station.state.queue.some((q) => q.text === x), t, { timeout: 5000 }).then(() => true, () => false);
  if (!ok) throw new Error(`[${tag}] the mid-turn message was not queued`);
}
/** Hold (never forward) this tab's `start`/`send` frames whose prompt carries `needle` while `gate.hold()` says so. */
async function gateWs(page, needle, gate) {
  gate.held ??= [];
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      let f = null;
      try { f = JSON.parse(String(message)); } catch { /* not JSON */ }
      if (f && (f.type === 'start' || f.type === 'send') && String(f.prompt ?? '').includes(needle) && gate.hold(f)) { gate.held.push(() => server.send(message)); return; }
      server.send(message);
    });
  });
}

/* ================================================================ the worlds */
const W = newWorld('bug217');
let srv = await bootServer(W, W.env);
W.projectId = await registerProject(srv, W);
ageTranscript(W);
await warmUp(W, srv);
console.log(`scratch server :${srv.port}  data=${W.data}  session=${W.SDK}`);

try {
  /* ═══ N. queued with NO tab open is delivered when the turn ends ═══ */
  if (want('N')) {
    console.log('\n=== N. a message queued while no tab is open is delivered when the turn ends ===');
    await longTurnNoTab(W, srv, 'N', 4000);
    const n1 = nonce('n');
    const r = await createRow(W, srv, n1, 'QUEUED-N while nobody is watching');
    const midTurn = countIn(W, 'QUEUED-N');
    const view0 = r.body?.view;
    const got = await waitFor(() => (countIn(W, 'QUEUED-N') >= 1 ? true : null), 30_000, 250);
    await sleep(3000);
    const after = await outboxGet(W, srv);
    check('N: the server minted and stored the row, and said why it waits (Claude is working)', r.status === 201 && view0?.rows?.[0]?.state === 'queued' && view0?.hold?.kind === 'busy', { status: r.status, view: view0 });
    check('N: nothing went into the running turn', midTurn === 0, { midTurn });
    check('N: with no tab anywhere, it reached the session once the turn ended — exactly once', !!got && countIn(W, 'QUEUED-N') === 1, { atCli: countIn(W, 'QUEUED-N') });
    check('N: the outbox shows it delivered (not pending, not asked again)', after.rows.length === 0 && after.recent.some((x) => x.nonce === n1 && x.state === 'delivered'), after);
    const f = cliFrames(W).find((x) => x.text.includes('QUEUED-N'));
    check('N: the delivered prompt carries the row ref the transcript confirms it by', !!f && f.text.includes(`ref ${r.body?.row?.id}`), f?.text?.slice(0, 160));
    await waitIdleNoBridge(W, srv);

    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    try {
      await openAt(page, W, srv);
      await queueMidTurn(page, 'N2', { sleepMs: 5000 });
      await ctx.close(); // every tab gone, mid-turn
      const g2 = await waitFor(() => (countIn(W, 'QUEUED-N2') >= 1 ? true : null), 30_000, 250);
      await sleep(3000);
      check('N: queued in a real tab that then CLOSED mid-turn — delivered at the turn end, once', !!g2 && countIn(W, 'QUEUED-N2') === 1, { atCli: countIn(W, 'QUEUED-N2') });
    } finally { await ctx.close().catch(() => {}); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ A / B. the incident ═══ */
  for (const how of ['A', 'B']) {
    if (!want(how)) continue;
    console.log(`\n=== ${how}. queued mid-turn, ${how === 'A' ? 'the page reloaded' : 'switched to another session and back'} after the session went idle and its host closed ===`);
    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    const needle = `QUEUED-${how}`;
    try {
      await openAt(page, W, srv);
      await queueMidTurn(page, how, { sleepMs: 4000 });
      if (how === 'A') await page.goto('about:blank');
      else {
        await page.evaluate((o) => { location.hash = o; }, `#/project/${encodeURIComponent(W.projectId)}/session/${W.OTHER}?dir=${encodeURIComponent(W.enc)}`);
        await page.waitForFunction((s) => window.__station.state.current.sessionId === s, W.OTHER, { timeout: 20_000 });
      }
      const gone = await waitIdleNoBridge(W, srv);
      if (how === 'A') await openAt(page, W, srv);
      else {
        await page.evaluate((o) => { location.hash = o; }, `#/project/${encodeURIComponent(W.projectId)}/session/${W.SDK}?dir=${encodeURIComponent(W.enc)}`);
        await page.waitForFunction((s) => window.__station.state.current.sessionId === s, W.SDK, { timeout: 20_000 });
      }
      const shown = await page.waitForFunction((t) => window.__station.state.queue.length === 0 && document.querySelector('#queueBox').hidden
        && [...document.querySelectorAll('#panes .you')].some((b) => b.textContent.includes(t)), needle, { timeout: 30_000 }).then(() => true, () => false);
      const replied = await page.waitForFunction((t) => {
        const b = [...document.querySelectorAll('#panes .you')].find((x) => x.textContent.includes(t));
        if (!b) return false;
        const walker = document.createTreeWalker(document.querySelector('#panes'), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/turn \d+:/.test(n.textContent) && (b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && !b.contains(n)) return true;
        return false;
      }, needle, { timeout: 15_000 }).then(() => true, () => false);
      await sleep(1500);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${how}.png`) });
      check(`${how}: the host closed with the message queued (the incident's state)`, !!gone, { gone });
      check(`${how}: it was sent — the dock is empty and it is a sent bubble in the conversation`, shown, await dock(page));
      check(`${how}: Claude's reply to it renders`, replied, { replied });
      check(`${how}: it reached the session exactly once`, countIn(W, needle) === 1, { atCli: countIn(W, needle) });
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ C. reload while the turn still runs ═══ */
  if (want('C')) {
    console.log('\n=== C. reload while the turn is still running — once, after the turn, never into it ===');
    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    try {
      await openAt(page, W, srv);
      await queueMidTurn(page, 'C', { sleepMs: 7000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction((s) => window.__station?.state?.current?.sessionId === s, W.SDK, { timeout: 45_000 });
      const midTurn = countIn(W, 'QUEUED-C');
      const restoredInDock = await page.waitForFunction(() => window.__station.state.queue.some((q) => q.text.includes('QUEUED-C')), null, { timeout: 10_000 }).then(() => true, () => false);
      const delivered = await page.waitForFunction(() => window.__station.state.queue.length === 0
        && [...document.querySelectorAll('#panes .you')].some((b) => b.textContent.includes('QUEUED-C')), null, { timeout: 40_000 }).then(() => true, () => false);
      await sleep(1500);
      const fr = cliFrames(W);
      const iSeed = fr.findIndex((f) => f.text.includes('seed C'));
      const iQ = fr.findIndex((f) => f.text.includes('QUEUED-C'));
      if (DEBUG) console.log('C frames', JSON.stringify(cliFrames(W).slice(-3).map((f) => [f.at, f.text.slice(0, 50)])));
      check('C: not delivered into the running turn', midTurn === 0, { midTurn });
      check('C: the reloaded tab shows it waiting (the server\'s row), then sent', restoredInDock && delivered, await dock(page));
      check('C: exactly once, and after the seed turn', countIn(W, 'QUEUED-C') === 1 && iSeed >= 0 && iQ > iSeed, { count: countIn(W, 'QUEUED-C'), iSeed, iQ });
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ D. another tab drives ═══ */
  if (want('D')) {
    console.log('\n=== D. another tab drives the session — this tab\'s Enter is not sent from here; Send now queues it ===');
    const ctx = await browser.newContext();
    const driver = await newTab(ctx);
    const other = await newTab(ctx);
    try {
      await openAt(driver, W, srv);
      await typeSend(driver, 'seed D [[fake:{"op":"sleep","ms":6000}]]');
      await driver.waitForFunction(() => window.__station.state.busy === true && window.__station.state.live, null, { timeout: 45_000 });
      await openAt(other, W, srv);
      await sleep(800);
      await typeSend(other, 'QUEUED-D typed in the tab that does not drive');
      const row = await other.waitForFunction(() => [...document.querySelectorAll('#queueBox .qrow')].some((r) => r.querySelector('.qedit')?.value.includes('QUEUED-D')), null, { timeout: 15_000 }).then(() => true, () => false);
      await sleep(8000); // the seed turn ends; a `failed` row is never sent by itself
      const dd = await dock(other);
      check('D: while the other tab drives, the row is NOT sent from here (CLI never saw it)', row && countIn(W, 'QUEUED-D') === 0, { atCli: countIn(W, 'QUEUED-D') });
      check('D: the dock says, in plain words, that another tab is driving — and offers Send again (the user\'s call)',
        dd.rows.some((r) => r.text.includes('QUEUED-D') && /another tab is driving/.test(r.status) && r.acts.includes('Send again')), dd);
      await other.evaluate(() => [...document.querySelectorAll('#queueBox .qrow')].find((r) => r.querySelector('.qedit')?.value.includes('QUEUED-D'))?.querySelector('.qgo')?.click());
      const went = await waitFor(() => (countIn(W, 'QUEUED-D') >= 1 ? true : null), 30_000, 250);
      await sleep(2500);
      check('D: the user\'s Send again queued it for that session — sent once, into the session the other tab drives', !!went && countIn(W, 'QUEUED-D') === 1, { atCli: countIn(W, 'QUEUED-D') });
      const driverSaw = await driver.waitForFunction(() => [...document.querySelectorAll('#panes .you')].some((b) => b.textContent.includes('QUEUED-D')), null, { timeout: 10_000 }).then(() => true, () => false);
      check('D: the driving tab shows the delivered message as a turn it now runs (outbox-turn)', driverSaw, { driverSaw });
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ E. two real tabs (the round-1 attack) ═══ */
  if (want('E')) {
    console.log('\n=== E. (round-1 attack) two real tabs share the session; the driver closes — once ===');
    const ctx = await browser.newContext();
    const t0 = await newTab(ctx);
    const t1 = await newTab(ctx);
    try {
      await openAt(t0, W, srv);
      await queueMidTurn(t0, 'E', { sleepMs: 6000 });
      await t0.reload({ waitUntil: 'domcontentloaded' });
      await t0.waitForFunction((s) => window.__station?.state?.current?.sessionId === s, W.SDK, { timeout: 45_000 });
      await openAt(t1, W, srv);
      const bothShow = await t1.waitForFunction(() => window.__station.state.queue.some((q) => q.text.includes('QUEUED-E')), null, { timeout: 10_000 }).then(() => true, () => false)
        && await t0.waitForFunction(() => window.__station.state.queue.some((q) => q.text.includes('QUEUED-E')), null, { timeout: 10_000 }).then(() => true, () => false);
      const first = await waitFor(() => (countIn(W, 'QUEUED-E') >= 1 ? true : null), 40_000, 250);
      await sleep(3000);
      const d0 = await dock(t0), d1 = await dock(t1);
      await t0.close();
      await sleep(35_000); // a follower that still held the row would send it once the driver is gone
      check('E: both tabs showed the same one row (the server\'s)', bothShow, { bothShow });
      check('E: it was sent, and both docks emptied', !!first && d0.queue === 0 && d1.queue === 0, { d0, d1 });
      check('E: after the driver closed nothing more was sent — exactly once', countIn(W, 'QUEUED-E') === 1, { atCli: countIn(W, 'QUEUED-E'), follower: await dock(t1) });
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ F. order ═══ */
  if (want('F')) {
    console.log('\n=== F. order — three rows go as one turn in the order typed; rows across a restart keep their order ===');
    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    try {
      await openAt(page, W, srv);
      await queueMidTurn(page, 'F', { sleepMs: 5000, more: ['SECOND-F the middle one', 'THIRD-F the last one'] });
      await ctx.close();
      await waitFor(() => (countIn(W, 'THIRD-F') >= 1 ? true : null), 30_000, 250);
      await sleep(2000);
      const f = cliFrames(W).find((x) => x.text.includes('QUEUED-F'));
      const i1 = f?.text.indexOf('QUEUED-F') ?? -1, i2 = f?.text.indexOf('SECOND-F') ?? -1, i3 = f?.text.indexOf('THIRD-F') ?? -1;
      check('F: all three reached the session once, together, in the order typed', [countIn(W, 'QUEUED-F'), countIn(W, 'SECOND-F'), countIn(W, 'THIRD-F')].every((c) => c === 1) && i1 >= 0 && i1 < i2 && i2 < i3, { i1, i2, i3 });
    } finally { await ctx.close().catch(() => {}); await waitIdleNoBridge(W, srv); }
    // Across a restart: two rows while held, restart, a third — delivered in creation order.
    await sleep(3000); // past this server's own last write, so the touch below reads as "another program"
    touchTranscript(W); // "another program is writing" holds the rows
    const a = await createRow(W, srv, nonce('f1'), 'ORDER-1 first');
    const b = await createRow(W, srv, nonce('f2'), 'ORDER-2 second');
    const heldBefore = await outboxGet(W, srv);
    srv = await restart(W, srv);
    touchTranscript(W);
    const c = await createRow(W, srv, nonce('f3'), 'ORDER-3 third');
    const held = await outboxGet(W, srv);
    ageTranscript(W);
    await waitFor(() => (countIn(W, 'ORDER-3') >= 1 ? true : null), 30_000, 250);
    await sleep(2000);
    const fr = cliFrames(W).find((x) => x.text.includes('ORDER-1'));
    check('F: held rows said why ("another program is writing"), and survived the restart in order',
      heldBefore.hold?.kind === 'external' && held.hold?.kind === 'external' && held.rows.map((r) => `${r.text}:${r.state}`).join('|') === 'ORDER-1 first:queued|ORDER-2 second:queued|ORDER-3 third:queued', { before: heldBefore.hold?.kind, hold: held.hold?.kind, rows: held.rows.map((r) => `${r.text}:${r.state}`) });
    check('F: after the restart they went once each, in creation order', !!fr && fr.text.indexOf('ORDER-1') < fr.text.indexOf('ORDER-2') && fr.text.indexOf('ORDER-2') < fr.text.indexOf('ORDER-3')
      && ['ORDER-1', 'ORDER-2', 'ORDER-3'].every((t) => countIn(W, t) === 1), { a: a.status, b: b.status, c: c.status, frame: fr?.text?.slice(0, 300) });
    await waitIdleNoBridge(W, srv);
  }

  /* ═══ G. Edit / Discard racing the delivery ═══ */
  if (want('G')) {
    console.log('\n=== G. Edit and Discard fired at the turn boundary — the server\'s single thread decides; never both, never twice ===');
    const TURN = 1500;
    for (const verb of ['discard', 'edit']) {
      for (const off of [-150, 0, 150, 300, 600]) {
        const tag = `G${verb[0].toUpperCase()}${off < 0 ? 'm' : ''}${Math.abs(off)}`;
        const ORIG = `RACE-${tag} original`, EDIT = `RACE-${tag} EDITED`;
        await longTurnNoTab(W, srv, tag, TURN);
        const r = await createRow(W, srv, nonce(tag), ORIG);
        const id = r.body?.row?.id;
        // The boundary is the fake CLI's own clock: when it read the seed, plus the seed's sleep.
        const seed = await waitFor(() => cliFrames(W).find((f) => f.text.includes(`seed ${tag} `)) ?? null, 20_000, 20);
        const at = (seed?.at ? (typeof seed.at === 'number' ? seed.at : Date.parse(seed.at)) : Date.now()) + TURN + off;
        await sleep(Math.max(0, at - Date.now()));
        const ans = await act(W, srv, verb, id, verb === 'edit' ? { text: EDIT } : {});
        await waitFor(() => ((countIn(W, ORIG) + countIn(W, EDIT)) >= 1 ? true : null), 8000, 200);
        await sleep(2500);
        const o = countIn(W, ORIG), e = countIn(W, EDIT);
        const ok = verb === 'discard'
          ? (ans.status === 200 ? o === 0 : (ans.status === 409 && o === 1))
          : (ans.status === 200 ? (e === 1 && o === 0) : (ans.status === 409 && o === 1 && e === 0));
        check(`G: ${verb} at boundary${off >= 0 ? '+' : ''}${off} ms — the answer (${ans.status}) and the CLI agree, never twice`, ok && o + e <= 1, { status: ans.status, error: ans.body?.error, original: o, edited: e });
        await waitIdleNoBridge(W, srv);
      }
    }
  }

  /* ═══ I. Interrupt & send (FEAT-031), carried out by the server ═══ */
  if (want('I')) {
    console.log('\n=== I. Interrupt & send — the server interrupts the running turn and sends THAT row first, alone, once ===');
    await longTurnNoTab(W, srv, 'I', 8000);
    const r1 = await createRow(W, srv, nonce('i1'), 'QUEUED-I1 waits its turn');
    const r2 = await createRow(W, srv, nonce('i2'), 'QUEUED-I2 interrupt for this one');
    const t0 = Date.now();
    const x = await act(W, srv, 'send', r2.body.row.id, { interrupt: true });
    const again = await act(W, srv, 'send', r2.body.row.id, { interrupt: true });
    await waitFor(() => (countIn(W, 'QUEUED-I1') >= 1 ? true : null), 40_000, 250);
    await sleep(2500);
    const fr = cliFrames(W);
    const f2 = fr.findIndex((f) => f.text.includes('QUEUED-I2'));
    const f1 = fr.findIndex((f) => f.text.includes('QUEUED-I1'));
    const interrupted = (() => { let n = 0; for (const f of fs.readdirSync(path.dirname(W.tap))) { const m = /^fake\.tap\.(\d+)$/.exec(f); if (m) for (const { m: y } of fakeTap(W, Number(m[1]))) if (y?.type === 'control_request' && y.request?.subtype === 'interrupt' && (y.at ?? Date.now()) >= 0) n++; } return n; })();
    check('I: the request was accepted and asked the running turn to stop ONCE (a second press adds no second interrupt)', x.status === 200 && again.status === 200 && interrupted === 1, { status: x.status, again: again.status, interrupts: interrupted });
    check('I: the forced row went FIRST, ALONE, with the force-sent header; the other row after it; each once',
      f2 >= 0 && f1 > f2 && !fr[f2].text.includes('QUEUED-I1') && /^\[Force-sent/.test(fr[f2].text) && countIn(W, 'QUEUED-I2') === 1 && countIn(W, 'QUEUED-I1') === 1, { f2, f1, head: fr[f2]?.text?.slice(0, 80), tookMs: Date.now() - t0 });
    await waitIdleNoBridge(W, srv);
  }

  /* ═══ J. (round-2 attack #1) the tab dies mid-POST ═══ */
  if (want('J')) {
    console.log('\n=== J. (round-2 attack) the sending tab dies mid-POST — once (the server got it) / once after the reload (it did not) ===');
    for (const reached of [true, false]) {
      const tag = reached ? 'J1' : 'J2';
      const ctx = await browser.newContext();
      let page = await newTab(ctx);
      try {
        await openAt(page, W, srv);
        await typeSend(page, `seed ${tag} [[fake:{"op":"sleep","ms":5000}]]`);
        await page.waitForFunction(() => window.__station.state.busy === true && window.__station.state.live, null, { timeout: 45_000 });
        let posted = 0;
        await page.route('**/api/outbox', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          posted++;
          if (reached) { await route.fetch().catch(() => {}); return; } // the server has it; the tab never hears back
          return route.abort('connectionreset'); // the server never got it
        });
        await typeSend(page, `QUEUED-${tag} the tab that dies`);
        await waitFor(() => (posted ? true : null), 10_000, 50);
        const t0 = Date.now();
        if (reached) await ctx.close();
        else {
          await page.unroute('**/api/outbox');
          await page.reload({ waitUntil: 'domcontentloaded' }); // the filed request is replayed from the tab's store
          await page.waitForFunction((s) => window.__station?.state?.current?.sessionId === s, W.SDK, { timeout: 45_000 });
        }
        await waitFor(() => (countIn(W, `QUEUED-${tag}`) >= 1 ? true : null), 40_000, 250);
        const took = Date.now() - t0;
        await sleep(3000);
        check(`J: ${reached ? 'the server got the POST and the tab died' : 'the POST never reached the server and the tab reloaded'} — delivered exactly once, within 40 s`,
          countIn(W, `QUEUED-${tag}`) === 1 && took <= 40_000, { atCli: countIn(W, `QUEUED-${tag}`), took, posted });
      } finally { await ctx.close().catch(() => {}); await waitIdleNoBridge(W, srv); }
    }
  }

  /* ═══ K. (round-2 attack #2) the same words as an earlier message ═══ */
  if (want('K')) {
    console.log('\n=== K. (round-2 attack) the same words as an earlier message, lost in the network, then a reload — once ===');
    const text = 'QUEUED-K btw when trying to buy it says 403';
    appendPriorTurn(W, text);
    ageTranscript(W);
    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    try {
      await openAt(page, W, srv);
      await typeSend(page, 'seed K [[fake:{"op":"sleep","ms":5000}]]');
      await page.waitForFunction(() => window.__station.state.busy === true && window.__station.state.live, null, { timeout: 45_000 });
      await page.route('**/api/outbox', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()));
      await typeSend(page, text);
      await sleep(800);
      await page.unroute('**/api/outbox');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction((s) => window.__station?.state?.current?.sessionId === s, W.SDK, { timeout: 45_000 });
      await waitFor(() => (countIn(W, text) >= 1 ? true : null), 40_000, 250);
      await sleep(3000);
      check('K: delivered exactly once — an older identical message is not this one', countIn(W, text) === 1, { atCli: countIn(W, text), dock: await dock(page) });
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ L. the same text twice on purpose ═══ */
  if (want('L')) {
    console.log('\n=== L. the same text queued twice on purpose arrives twice ===');
    const T = 'SAME-L please check the cart again';
    await longTurnNoTab(W, srv, 'L', 3000);
    await createRow(W, srv, nonce('l1'), T);
    await createRow(W, srv, nonce('l2'), T);
    await waitFor(() => (occurrences(W, T) >= 2 ? true : null), 30_000, 250);
    await sleep(2500);
    check('L: two rows, two nonces — the text reached the session exactly twice', occurrences(W, T) === 2, { occurrences: occurrences(W, T) });
    await waitIdleNoBridge(W, srv);
  }

  /* ═══ M. three tabs at once ═══ */
  if (want('M')) {
    console.log('\n=== M. three tabs replay one pending request, and three press Send anyway, in the same instant — once each ===');
    await longTurnNoTab(W, srv, 'M', 2500);
    const nm = nonce('m');
    const reps = await Promise.all([0, 1, 2].map(() => createRow(W, srv, nm, 'QUEUED-M one request, three replays')));
    const ids = new Set(reps.map((x) => x.body?.row?.id));
    await waitFor(() => (countIn(W, 'QUEUED-M') >= 1 ? true : null), 30_000, 250);
    await sleep(2500);
    check('M: three simultaneous replays of one nonce made ONE row, delivered once', ids.size === 1 && reps.filter((x) => x.body?.created).length === 1 && countIn(W, 'QUEUED-M') === 1, { statuses: reps.map((x) => x.status), ids: [...ids], atCli: countIn(W, 'QUEUED-M') });
    await waitIdleNoBridge(W, srv);
    const u = await createRow(W, srv, nonce('mu'), 'QUEUED-MU not confirmed', { initial: 'uncertain', origin: 'direct' });
    const presses = await Promise.all([0, 1, 2].map(() => act(W, srv, 'send', u.body.row.id)));
    await waitFor(() => (countIn(W, 'QUEUED-MU') >= 1 ? true : null), 30_000, 250);
    await sleep(3000);
    check('M: three simultaneous Send anyway presses — one accepted, the rest refused, delivered once', presses.filter((p) => p.status === 200).length === 1 && presses.filter((p) => p.status === 409).length === 2 && countIn(W, 'QUEUED-MU') === 1, { statuses: presses.map((p) => p.status), atCli: countIn(W, 'QUEUED-MU') });
    await waitIdleNoBridge(W, srv);
  }

  /* ═══ R3. (round-3 attack) flood + restart ═══ */
  if (want('R3')) {
    console.log('\n=== R3. (round-3 attack) 4,800 rows flooded into this and another session, restart, the delivered row replayed — once ===');
    await waitIdleNoBridge(W, srv);
    const nx = nonce('r3');
    const x = await createRow(W, srv, nx, 'QUEUED-R3X delivered before the flood');
    await waitFor(() => (countIn(W, 'QUEUED-R3X') >= 1 ? true : null), 30_000, 250);
    await sleep(2000);
    const flood = async (sid) => {
      const st = new Set();
      for (let i = 0; i < 2400; i += 50) {
        const batch = await Promise.all(Array.from({ length: 50 }, (_, j) => http(W, srv, 'POST', '/api/outbox', { session: sid, dir: W.enc, project: W.projectId, nonce: nonce(`fl${i + j}`), text: `flood ${i + j}`, discard: true })));
        for (const b of batch) st.add(b.status);
      }
      return [...st];
    };
    const f1 = await flood(W.OTHER);
    const f2 = await flood(W.SDK);
    srv = await restart(W, srv);
    const again = await createRow(W, srv, nx, 'QUEUED-R3X delivered before the flood');
    await sleep(6000);
    check('R3: the floods were accepted (discarded on arrival — none delivered)', f1.join() === '201' && f2.join() === '201' && countIn(W, 'flood ') === 0, { f1, f2, floodAtCli: countIn(W, 'flood ') });
    check('R3: after the flood and a restart the replayed request is the SAME delivered row — never sent again', again.status === 200 && again.body?.created === false && again.body?.row?.id === x.body?.row?.id && again.body?.row?.state === 'delivered' && countIn(W, 'QUEUED-R3X') === 1, { status: again.status, row: again.body?.row && { id: again.body.row.id, state: again.body.row.state }, atCli: countIn(W, 'QUEUED-R3X') });
    check('R3: nothing was evicted — the journal still holds the delivered row', rowOnDisk(W, x.body?.row?.id)?.state === 'delivered', rowOnDisk(W, x.body?.row?.id)?.state);
  }

  /* ═══ R4. (round-4 attacks) forged / corrected clocks, another scope, a round-4 frame ═══ */
  if (want('R4')) {
    console.log('\n=== R4. (round-4 attacks) the replay carries a forged queueNow, a corrected clock and another project\'s scope; a round-4 frame — once ===');
    await waitIdleNoBridge(W, srv);
    fs.mkdirSync(path.join(W.base, 'work2'), { recursive: true });
    const other = await http(W, srv, 'POST', '/api/projects', { hostPath: path.join(W.base, 'work2'), name: 'b217-other', isolation: 'direct' }).catch(() => null);
    const nx = nonce('r4');
    const x = await createRow(W, srv, nx, 'QUEUED-R4X the row the attacks replay');
    await waitFor(() => (countIn(W, 'QUEUED-R4X') >= 1 ? true : null), 30_000, 250);
    await sleep(2000);
    const forged = await createRow(W, srv, nx, 'QUEUED-R4X the row the attacks replay', { queueNow: 1, now: 1 });
    const skewed = await createRow(W, srv, nx, 'QUEUED-R4X the row the attacks replay', { queueNow: Date.now() + 3_600_000, now: Date.now() - 3_600_000 });
    const scoped = await http(W, srv, 'POST', '/api/outbox', { session: W.SDK, dir: W.enc, project: other?.body?.project?.id ?? W.projectId, nonce: nx, text: 'QUEUED-R4X the row the attacks replay' });
    // Corrupt the journal and restart: the round-4 clock attack needed the ledger to forget first.
    await stopServer(srv);
    const lines = fs.readFileSync(journal(W), 'utf8').split('\n');
    fs.writeFileSync(journal(W), lines.map((l, i) => (i === 1 ? `${l.slice(0, 12)}#garbled#` : l)).join('\n'));
    srv = await bootServer(W, W.env, { port: srv.port });
    const afterDamage = await createRow(W, srv, nx, 'QUEUED-R4X the row the attacks replay', { queueNow: 1 });
    const { c, e } = await rawStart(srv, { type: 'start', projectId: W.projectId, prompt: 'QUEUED-R4X the row the attacks replay', resumeSessionId: W.SDK, resumeEncodedDir: W.enc, overrides: { permissionMode: 'default' }, queueIds: ['qt-legacy-r4x'], queueNow: 1 });
    c?.close();
    await sleep(6000);
    check('R4: a forged queueNow=1, a skewed clock and another scope on the replay change nothing — the same delivered row', [forged, skewed, scoped].every((r) => r.body?.row?.id === x.body?.row?.id && r.body?.created === false) || scoped.status === 404,
      { forged: forged.body?.row?.state, skewed: skewed.body?.row?.state, scoped: scoped.status });
    check('R4: after the journal was damaged and the server restarted, the replay is still not delivered again', countIn(W, 'QUEUED-R4X') === 1 && afterDamage.body?.row?.state !== 'queued', { state: afterDamage.body?.row?.state, created: afterDamage.body?.created, atCli: countIn(W, 'QUEUED-R4X') });
    check('R4: a round-4 frame (queueIds + queueNow) is refused as an outdated client and nothing is sent', e?.code === 'client-outdated' && countIn(W, 'QUEUED-R4X') === 1, { e: e?.code ?? e?.t });
    await http(W, srv, 'POST', '/api/outbox/dismiss-damage', { session: W.SDK });
  }

  /* ═══ S. SIGKILL of the server at each transition ═══ */
  if (want('S')) {
    console.log('\n=== S. SIGKILL of the server at each transition — never twice, never silently lost ===');
    await waitIdleNoBridge(W, srv);
    ageTranscript(W);
    const crashAt = async (point, fn, { age = true } = {}) => {
      if (!age) touchTranscript(W);
      srv = await restart(W, srv, { env: { ORCHARD_TEST_OUTBOX_CRASH_AT: point } });
      if (age) ageTranscript(W);
      const r = await fn();
      const dead = await waitDead(srv);
      srv = await bootServer(W, W.env, { port: srv.port });
      return { r, dead: !!dead };
    };
    // created: the POST's answer never comes; the row is on disk; the replay finds it; delivered once.
    {
      const n = nonce('sc');
      const { dead } = await crashAt('created', () => createRow(W, srv, n, 'QUEUED-SC created then killed').catch(() => null));
      const rep = await createRow(W, srv, n, 'QUEUED-SC created then killed');
      await waitFor(() => (countIn(W, 'QUEUED-SC') >= 1 ? true : null), 30_000, 250);
      await sleep(3000);
      check('S created: killed right after the row hit disk — the replayed POST finds it, delivered once', dead && rep.body?.created === false && countIn(W, 'QUEUED-SC') === 1, { dead, created: rep.body?.created, atCli: countIn(W, 'QUEUED-SC') });
      await waitIdleNoBridge(W, srv);
    }
    // sending: on disk as sending, nothing handed over → uncertain, not sent by itself; Send anyway → once.
    {
      const n = nonce('ss');
      const { dead } = await crashAt('sending', () => createRow(W, srv, n, 'QUEUED-SS killed while sending'));
      await sleep(5000);
      const v = await outboxGet(W, srv);
      const row = v.rows.find((r) => r.nonce === n);
      check('S sending: killed after "sending" was written, before the handover — 0 at the CLI, and it comes back "not confirmed"', dead && countIn(W, 'QUEUED-SS') === 0 && row?.state === 'uncertain', { dead, state: row?.state, reason: row?.reason, atCli: countIn(W, 'QUEUED-SS') });
      const s = await act(W, srv, 'send', row?.id);
      await waitFor(() => (countIn(W, 'QUEUED-SS') >= 1 ? true : null), 30_000, 250);
      await sleep(3000);
      check('S sending: the user\'s Send anyway delivers it once', s.status === 200 && countIn(W, 'QUEUED-SS') === 1, { status: s.status, atCli: countIn(W, 'QUEUED-SS') });
      await waitIdleNoBridge(W, srv);
    }
    // handed-over / delivered: the CLI has it once; the transcript's ref settles the row as delivered; never resent.
    for (const point of ['handed-over', 'delivered']) {
      const n = nonce('sh');
      const needle = `QUEUED-S${point === 'delivered' ? 'D' : 'H'}`;
      const { dead } = await crashAt(point, () => createRow(W, srv, n, `${needle} killed after ${point}`));
      await waitFor(() => (countIn(W, needle) >= 1 ? true : null), 15_000, 250);
      await sleep(8000);
      const disk = rowOnDisk(W, (await createRow(W, srv, n, `${needle} killed after ${point}`)).body?.row?.id);
      // Either the CLI took it before the kill (then the transcript's ref settles it delivered), or the kill beat the
      // runtime's write (then it is "not confirmed" — plan review B1: "delivered" on disk is never trusted over the receiver).
      const settled = (countIn(W, needle) === 1 && disk?.state === 'delivered' && disk?.confirmed === true) || (countIn(W, needle) === 0 && disk?.state === 'uncertain');
      check(`S ${point}: killed after the handover — never twice, never resent, and its state matches what the CLI got`, dead && countIn(W, needle) <= 1 && settled, { dead, atCli: countIn(W, needle), state: disk?.state, confirmed: disk?.confirmed });
      await waitIdleNoBridge(W, srv);
      ageTranscript(W);
    }
    // The receiver's record, both ways: a row delivered on disk but not yet confirmed when the server died.
    for (const inTranscript of [true, false]) {
      await waitIdleNoBridge(W, srv);
      ageTranscript(W);
      const tag = inTranscript ? 'QUEUED-SV' : 'QUEUED-SW';
      const r = await createRow(W, srv, nonce('sv'), `${tag} delivered, confirmation lost`);
      const id = r.body?.row?.id;
      await waitFor(() => (countIn(W, tag) >= 1 && fs.readFileSync(W.transcript(), 'utf8').includes(id) ? true : null), 30_000, 250);
      await waitIdleNoBridge(W, srv);
      try { process.kill(srv.proc.pid, 'SIGKILL'); } catch { /* gone */ }
      await waitDead(srv);
      // Put the row back to "delivered, not yet confirmed, just now" — the state a kill leaves between handover and confirmation.
      const j = fs.readFileSync(journal(W), 'utf8').split('\n').filter(Boolean);
      const last = { ...rowOnDisk(W, id), state: 'delivered', confirmed: false, sentAt: Date.now() - 2000 };
      const lsn = JSON.parse(j[j.length - 1]).lsn + 1;
      fs.appendFileSync(journal(W), `${JSON.stringify({ lsn, rows: [last] })}\n`);
      fs.writeFileSync(path.join(W.data, 'outbox', `${W.SDK}.head`), JSON.stringify({ lsn }));
      if (!inTranscript) fs.writeFileSync(W.transcript(), fs.readFileSync(W.transcript(), 'utf8').replaceAll(`ref ${id}`, 'ref (scrubbed)'));
      ageTranscript(W);
      srv = await bootServer(W, W.env, { port: srv.port });
      await sleep(5000);
      const disk = rowOnDisk(W, id);
      check(inTranscript
        ? 'S recover: delivered-but-unconfirmed at the kill, and the transcript holds its ref — settled delivered, never resent'
        : 'S recover: delivered-but-unconfirmed at the kill, and the transcript lacks its ref — "not confirmed" for the user, never resent',
      (inTranscript ? (disk?.state === 'delivered' && disk?.confirmed === true) : disk?.state === 'uncertain') && countIn(W, tag) === 1, { state: disk?.state, confirmed: disk?.confirmed, atCli: countIn(W, tag) });
      if (!inTranscript) await act(W, srv, 'discard', id);
    }
    // edited / discarded: under a hold (another program writing), so the row cannot go first.
    {
      touchTranscript(W);
      const n = nonce('se');
      const r = await createRow(W, srv, n, 'QUEUED-SE original words');
      const id = r.body?.row?.id;
      const { dead } = await crashAt('edited', async () => { touchTranscript(W); return act(W, srv, 'edit', id, { text: 'QUEUED-SE EDITED words' }).catch(() => null); }, { age: false });
      ageTranscript(W);
      await waitFor(() => (countIn(W, 'QUEUED-SE') >= 1 ? true : null), 30_000, 250);
      await sleep(3000);
      check('S edited: killed right after the edit hit disk — the EDITED words go, once; the original never', dead && countIn(W, 'QUEUED-SE EDITED') === 1 && countIn(W, 'QUEUED-SE original') === 0, { dead, edited: countIn(W, 'QUEUED-SE EDITED'), original: countIn(W, 'QUEUED-SE original') });
      await waitIdleNoBridge(W, srv);
    }
    {
      touchTranscript(W);
      const n = nonce('sx');
      const r = await createRow(W, srv, n, 'QUEUED-SX discarded then killed');
      const id = r.body?.row?.id;
      const { dead } = await crashAt('discarded', async () => { touchTranscript(W); return act(W, srv, 'discard', id).catch(() => null); }, { age: false });
      ageTranscript(W);
      await sleep(8000);
      check('S discarded: killed right after the discard hit disk — never sent', dead && countIn(W, 'QUEUED-SX') === 0 && rowOnDisk(W, id)?.state === 'discarded', { dead, atCli: countIn(W, 'QUEUED-SX'), state: rowOnDisk(W, id)?.state });
    }
    {
      const u = await createRow(W, srv, nonce('sr'), 'QUEUED-SR requeued then killed', { initial: 'uncertain', origin: 'direct' });
      const id = u.body?.row?.id;
      const { dead } = await crashAt('requeued', () => act(W, srv, 'send', id).catch(() => null));
      await waitFor(() => (countIn(W, 'QUEUED-SR') >= 1 ? true : null), 30_000, 250);
      await sleep(3000);
      check('S requeued: killed right after Send anyway hit disk — delivered once after the restart', dead && countIn(W, 'QUEUED-SR') === 1, { dead, atCli: countIn(W, 'QUEUED-SR') });
      await waitIdleNoBridge(W, srv);
    }
  }

  /* ═══ X. a damaged outbox file ═══ */
  if (want('X')) {
    console.log('\n=== X. a truncated, a garbled and a torn outbox file — loud, "not confirmed", none sent by itself, none dropped silently ===');
    for (const kind of ['truncated', 'garbled', 'torn']) {
      await waitIdleNoBridge(W, srv);
      const w2 = newWorld(`b217x${kind.slice(0, 3)}`);
      let s2 = await bootServer(w2, w2.env);
      w2.projectId = await registerProject(s2, w2);
      try {
        touchTranscript(w2); // nothing goes: "another program is writing"
        const a = await createRow(w2, s2, nonce('xa'), `DAMAGE-${kind} A`);
        const u = await createRow(w2, s2, nonce('xu'), `DAMAGE-${kind} U`, { initial: 'uncertain', origin: 'direct' });
        const b = await createRow(w2, s2, nonce('xb'), `DAMAGE-${kind} B`);
        await stopServer(s2);
        const f = journal(w2);
        const txt = fs.readFileSync(f, 'utf8');
        const lines = txt.split('\n').filter(Boolean);
        if (kind === 'truncated') fs.writeFileSync(f, `${lines.slice(0, -1).join('\n')}\n`); // B's line gone, at a line boundary
        if (kind === 'garbled') fs.writeFileSync(f, `${lines.map((l, i) => (i === 1 ? l.replace('"rows"', '"r~ws') : l)).join('\n')}\n`); // U's line
        if (kind === 'torn') fs.writeFileSync(f, txt.slice(0, txt.length - Math.floor(lines[lines.length - 1].length / 2)));
        ageTranscript(w2);
        s2 = await bootServer(w2, w2.env, { port: s2.port });
        const v = await outboxGet(w2, s2);
        await sleep(6000);
        const loud = /DAMAGED/.test(s2.log);
        const aside = fs.readdirSync(path.dirname(f)).some((n) => n.startsWith(`${w2.SDK}.jsonl.corrupt-`));
        const states = Object.fromEntries(v.rows.map((r) => [r.text, r.state]));
        const survivors = [a, u, b].map((x) => x.body.row.text).filter((t) => t in states);
        check(`X ${kind}: the server says so loudly, keeps the damaged copy, and the dock shows a damage notice`, loud && aside && !!v.damaged, { loud, aside, damaged: v.damaged?.detail });
        check(`X ${kind}: every surviving row is "not confirmed", and nothing was sent by itself`, survivors.length >= 2 && survivors.every((t) => states[t] === 'uncertain') && countIn(w2, `DAMAGE-${kind}`) === 0, { states, atCli: countIn(w2, `DAMAGE-${kind}`) });
        const fresh = await createRow(w2, s2, nonce('xn'), `DAMAGE-${kind} new while damaged`);
        await http(w2, s2, 'POST', '/api/outbox/dismiss-damage', { session: w2.SDK });
        const fresh2 = await createRow(w2, s2, nonce('xn2'), `DAMAGE-${kind} new after dismiss`);
        await waitFor(() => (countIn(w2, `${kind} new after dismiss`) >= 1 ? true : null), 30_000, 250);
        check(`X ${kind}: while damaged a new request arrives "not confirmed"; after the user dismisses the notice, rows go again`, fresh.body?.row?.state === 'uncertain' && fresh2.body?.row?.state === 'queued' && countIn(w2, `${kind} new after dismiss`) === 1 && countIn(w2, `${kind} new while damaged`) === 0, { fresh: fresh.body?.row?.state, fresh2: fresh2.body?.row?.state });
      } finally { await cleanupWorld(w2); }
    }
  }

  /* ═══ U. the "not confirmed" UI, and the round-1 visual contract ═══ */
  if (want('U')) {
    console.log('\n=== U. the "not confirmed" row: Send anyway (once, even double-clicked) and Discard; plain status, visible actions, Discard set apart, no clipping ===');
    await waitIdleNoBridge(W, srv);
    ageTranscript(W);
    for (const r of (await outboxGet(W, srv)).rows) await act(W, srv, 'discard', r.id); // earlier scenarios' leftovers
    const u1 = await createRow(W, srv, nonce('u1'), 'QUEUED-U1 this may already have been sent — the user decides', { initial: 'uncertain', origin: 'direct' });
    const u2 = await createRow(W, srv, nonce('u2'), 'QUEUED-U2 a longer row that should wrap cleanly and keep every action visible even in a narrow window', { initial: 'uncertain', origin: 'direct' });
    const ctx = await browser.newContext();
    const page = await newTab(ctx);
    try {
      await openAt(page, W, srv);
      await page.waitForFunction(() => document.querySelectorAll('#queueBox .qrow').length >= 2, null, { timeout: 15_000 });
      await sleep(6000);
      const d0 = await dock(page);
      check('U: both rows are shown "Not confirmed" with Send anyway, Edit and Discard — and neither was sent by itself',
        d0.rows.length === 2 && d0.rows.every((r) => /^Not confirmed/.test(r.status) && ['Send anyway', 'Edit', 'Discard'].every((a) => r.acts.includes(a))) && countIn(W, 'QUEUED-U') === 0, d0);
      const style = await page.evaluate(() => {
        const r = document.querySelector('#queueBox .qrow');
        const qs = r.querySelector('.qs');
        const cs = getComputedStyle(qs);
        const drop = r.querySelector('.qdrop');
        const edit = [...r.querySelectorAll('.qracts button')].find((b) => b.textContent === 'Edit');
        return { tag: qs.tagName, cursor: cs.cursor, border: cs.borderTopStyle, dropGap: parseFloat(getComputedStyle(drop).marginLeft), dropColor: getComputedStyle(drop).color, editColor: getComputedStyle(edit).color, details: !!document.querySelector('#queueBox details') };
      });
      check('U: the status is plain text (not a button, no pointer, no border), no <details>; Discard is set apart (a gap, its own colour)',
        style.tag !== 'BUTTON' && style.cursor !== 'pointer' && style.border === 'none' && !style.details && style.dropGap > 0 && style.dropColor !== style.editColor, style);
      const layout = [];
      for (const [width, theme] of [[1280, 'light'], [640, 'light'], [520, 'dark'], [420, 'dark']]) {
        await page.setViewportSize({ width, height: 860 });
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await sleep(300);
        const m = await page.evaluate(() => [...document.querySelectorAll('#queueBox .qrow')].map((r) => {
          const rr = r.getBoundingClientRect();
          const btns = [...r.querySelectorAll('.qracts button')].map((b) => b.getBoundingClientRect());
          return { overflow: r.scrollWidth - r.clientWidth, clipped: btns.some((b) => b.right > rr.right + 1 || b.left < rr.left - 1 || b.width < 8) };
        }));
        layout.push({ width, theme, ok: m.every((x) => x.overflow <= 1 && !x.clipped), m });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `U-${width}-${theme}.png`) });
      }
      check('U: no clipping, no overflow, every action visible at 1280/640/520/420 px, light and dark', layout.every((l) => l.ok), layout);
      await page.setViewportSize({ width: 1280, height: 860 });
      // Send anyway, double-clicked.
      await page.evaluate(() => { const b = [...document.querySelectorAll('#queueBox .qrow')].find((r) => r.querySelector('.qedit').value.includes('QUEUED-U1')).querySelector('.qgo'); b.click(); b.click(); });
      await waitFor(() => (countIn(W, 'QUEUED-U1') >= 1 ? true : null), 30_000, 250);
      await sleep(4000);
      check('U: Send anyway (clicked twice) delivered it exactly once', countIn(W, 'QUEUED-U1') === 1, { atCli: countIn(W, 'QUEUED-U1') });
      await page.evaluate(() => [...document.querySelectorAll('#queueBox .qrow')].find((r) => r.querySelector('.qedit').value.includes('QUEUED-U2'))?.querySelector('.qdrop')?.click());
      const undo = await page.waitForFunction(() => !!document.querySelector('#queueBox .q-undo-b'), null, { timeout: 5000 }).then(() => true, () => false);
      await sleep(5000);
      const v = await outboxGet(W, srv);
      check('U: Discard removed the other one — never sent, gone from the server, and Undo was offered', undo && countIn(W, 'QUEUED-U2') === 0 && !v.rows.some((r) => r.id === u2.body.row.id) && rowOnDisk(W, u2.body.row.id)?.state === 'discarded', { undo, atCli: countIn(W, 'QUEUED-U2') });
      check('U: the dock is empty of rows afterwards', (await dock(page)).rows.length === 0, await dock(page));
      void u1;
    } finally { await ctx.close(); await waitIdleNoBridge(W, srv); }
  }

  /* ═══ LG. rows an older client kept in the browser ═══ */
  if (want('LG')) {
    console.log('\n=== LG. rows a round-4 tab kept in localStorage: a row the old ledger knew was delivered is not brought back; the rest come back "not confirmed" — none sent by itself ===');
    await waitIdleNoBridge(W, srv);
    ageTranscript(W);
    for (const r of (await outboxGet(W, srv)).rows) await act(W, srv, 'discard', r.id);
    const key = `s\x00${W.enc}\x00${W.SDK}`;
    const delivered = `qt-${Date.now().toString(36)}-legacy-delivered`;
    const unknown = `qt-${Date.now().toString(36)}-legacy-unknown`;
    fs.mkdirSync(path.join(W.data, 'queue-ledger'), { recursive: true });
    fs.writeFileSync(path.join(W.data, 'queue-ledger', `s_${W.SDK}.json`), JSON.stringify({ horizon: 0, floor: 0, entries: { [delivered]: { s: 'delivered', at: Date.now() - 60_000 } } }));
    const legacy = { [key]: { at: Date.now(), rows: [
      { id: delivered, text: 'LEGACY-D the old ledger says this went', composedAt: Date.now() - 90_000, dead: null },
      { id: unknown, text: 'LEGACY-U nobody knows about this one', composedAt: Date.now() - 80_000, dead: null, sending: true },
    ], outbox: null, done: [] } };
    const ctx = await browser.newContext();
    // Both tabs find the old rows on their first load (each seeds once), and open at the same instant.
    await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, ['cs.queue.v1', JSON.stringify(legacy)]);
    const t1 = await newTab(ctx);
    const t2 = await newTab(ctx);
    try {
      await Promise.all([openAt(t1, W, srv), openAt(t2, W, srv)]);
      await t1.waitForFunction(() => window.__station.state.queue.some((q) => q.text.startsWith('LEGACY-U') && q.state === 'uncertain'), null, { timeout: 15_000 }).catch(() => {});
      await sleep(6000);
      const v = await outboxGet(W, srv);
      const d1 = await dock(t1);
      const left = await t1.evaluate(() => localStorage.getItem('cs.queue.v1'));
      check('LG: the row the old ledger recorded as delivered is not brought back; the unknown one is ONE server row, "not confirmed"',
        !v.rows.some((r) => r.text.startsWith('LEGACY-D')) && v.rows.filter((r) => r.text.startsWith('LEGACY-U')).length === 1 && v.rows.find((r) => r.text.startsWith('LEGACY-U'))?.state === 'uncertain',
        { rows: v.rows.map((r) => `${r.text.slice(0, 10)}:${r.state}`), dock: d1.rows.map((r) => r.status.slice(0, 40)) });
      check('LG: neither was sent by itself, and the old store no longer holds them', countIn(W, 'LEGACY-') === 0 && !String(left ?? '').includes('LEGACY-'), { atCli: countIn(W, 'LEGACY-'), left });
    } finally { await ctx.close(); }
  }

  /* ═══ Z. misc attacks ═══ */
  if (want('Z')) {
    console.log('\n=== Z. misc — unknown session, nonce reuse, discard-on-create ===');
    const ghost = `b217ghost${Date.now().toString(36)}-0000-4000-8000-00000000`.slice(0, 36);
    const g = await http(W, srv, 'POST', '/api/outbox', { session: ghost, dir: W.enc, project: W.projectId, nonce: nonce('zg'), text: 'to nowhere' });
    check('Z: a session that does not exist is 404, and no journal is created for it', g.status === 404 && !fs.existsSync(journal(W, ghost)), { status: g.status });
    touchTranscript(W);
    const n = nonce('zr');
    const r1 = await createRow(W, srv, n, 'QUEUED-Z first words');
    const r2 = await createRow(W, srv, n, 'QUEUED-Z different words');
    check('Z: the same nonce with different words is refused (409), never merged', r1.status === 201 && r2.status === 409, { r1: r1.status, r2: r2.status });
    await act(W, srv, 'discard', r1.body.row.id);
    const gu = await http(W, srv, 'GET', `/api/outbox?session=${encodeURIComponent(ghost)}`);
    check('Z: reading an unknown session\'s outbox is empty and creates nothing', gu.status === 200 && gu.body.rows.length === 0 && !fs.existsSync(journal(W, ghost)), gu.body);
    ageTranscript(W);
  }

  /* ═══════════════════ MUST-FAIL: the prior rounds, synthesized ═══════════════════ */
  const needBase = ['P4A', 'P4B', 'P4C', 'P3', 'PJ', 'PK', 'PE', 'PA'].some(want);
  if (needBase) {
    const tree = round4Tree();
    const baseWorld = async (name, extraEnv = {}) => {
      const b = newWorld(name, { tree });
      b.env = { FAKE_SDK_ID: b.SDK, ...extraEnv }; // round 4 read no transcript refs
      const s = await bootServer(b, b.env);
      b.projectId = await registerProject(s, b);
      ageTranscript(b);
      await warmUp(b, s);
      return { b, s };
    };
    const born = (tag, at = Date.now()) => `qt-${Math.floor(at).toString(36)}-${tag}-${Math.random().toString(36).slice(2, 10)}`;
    const ledgerDiscard = (b, s, ids, scope) => http(b, s, 'POST', '/api/queue-ledger/discard', { ...scope, now: Date.now(), ids });
    const flood = async (b, s, n, scope, tag) => { const st = new Set(); for (let i = 0; i < n; i += 200) st.add((await ledgerDiscard(b, s, Array.from({ length: Math.min(200, n - i) }, (_, j) => born(`${tag}${i + j}`)), scope)).status); return [...st]; };
    const deliverRaw = async (b, s, { sid = b.SDK, fresh = false, id, text, qnow = Date.now() }) => {
      const { c, e } = await rawStart(s, { type: 'start', projectId: b.projectId, prompt: text, ...(fresh ? {} : { resumeSessionId: sid, resumeEncodedDir: b.enc }), overrides: { permissionMode: 'default' }, queueIds: [id], queueNow: qnow });
      if (e?.t === 'ack') await waitFor(() => (c.events.some((x) => x.t === 'turn-end') ? true : null), 30_000);
      c?.close();
      return e;
    };

    /* P4a — scope mismatch after eviction */
    if (want('P4A')) {
      console.log('\n=== MUST-FAIL P4a (pinned round 4): a row delivered under the project scope, evicted, then resumed under the session scope — twice ===');
      const { b, s } = await baseWorld('b217p4a');
      try {
        const X = born('p4a');
        const d1 = await deliverRaw(b, s, { fresh: true, id: X, text: 'QUEUED-P4A project scope' });
        await waitIdleNoBridge(b, s);
        const fl = await flood(b, s, 2200, { project: b.projectId }, 'pa');
        const d2 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P4A project scope' });
        await sleep(2500);
        check('PRE-FIX P4a: the round-4 server lets the evicted project-scope row through a session-scope resume — CLI has it twice', d1?.t === 'ack' && fl.join() === '200' && d2?.t === 'ack' && countIn(b, 'QUEUED-P4A') === 2, { d1: d1?.t, flood: fl, d2: d2?.code ?? d2?.t, atCli: countIn(b, 'QUEUED-P4A') });
      } finally { await cleanupWorld(b); }
    }
    /* P4b — corrected clock after the ledger forgot */
    if (want('P4B')) {
      console.log('\n=== MUST-FAIL P4b (pinned round 4): a tab clock an hour fast, corrected after the ledger forgot — twice ===');
      const { b, s: s0 } = await baseWorld('b217p4b');
      let s = s0;
      try {
        const fast = Date.now() + 3_600_000;
        const X = born('p4b', fast);
        const d1 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P4B corrected clock', qnow: fast });
        await waitIdleNoBridge(b, s);
        await stopServer(s);
        const lf = path.join(b.data, 'queue-ledger', `s_${b.SDK}.json`);
        fs.writeFileSync(lf, '{"corrupt');
        s = await bootServer(b, b.env, { port: s.port });
        await sleep(6000); // past the 5 s birth margin
        const d2 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P4B corrected clock', qnow: Date.now() });
        await sleep(2500);
        check('PRE-FIX P4b: with the clock corrected after the ledger forgot, the round-4 server re-sends — CLI has it twice', d1?.t === 'ack' && d2?.t === 'ack' && countIn(b, 'QUEUED-P4B') === 2, { d1: d1?.t, d2: d2?.code ?? d2?.t, atCli: countIn(b, 'QUEUED-P4B') });
      } finally { await cleanupWorld(b); }
    }
    /* P4c — forged queueNow=1 */
    if (want('P4C')) {
      console.log('\n=== MUST-FAIL P4c (pinned round 4): an evicted delivered row claimed with a forged queueNow=1 — twice ===');
      const { b, s } = await baseWorld('b217p4c');
      try {
        const X = born('p4c');
        const d1 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P4C forged clock' });
        await waitIdleNoBridge(b, s);
        const fl = await flood(b, s, 2200, { session: b.SDK, dir: b.enc, project: b.projectId }, 'pc');
        const d2 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P4C forged clock', qnow: 1 });
        await sleep(2500);
        check('PRE-FIX P4c: a forged queueNow=1 ages the evicted row to "never sent" — CLI has it twice', d1?.t === 'ack' && fl.join() === '200' && d2?.t === 'ack' && countIn(b, 'QUEUED-P4C') === 2, { d1: d1?.t, flood: fl, d2: d2?.code ?? d2?.t, atCli: countIn(b, 'QUEUED-P4C') });
      } finally { await cleanupWorld(b); }
    }
    /* P3 — the round-3 ledger: flood into another session + restart */
    if (want('P3')) {
      console.log('\n=== MUST-FAIL P3 (round-3 ledger over the pinned round-4 file): a flood into another session + a restart — twice ===');
      const swaps = [
        ['  // Absent. That is evidence only for a row born after everything this scope has forgotten.\n', "  return 'none'; // round 3: no record read as never delivered\n"],
        ['function scope(key: string): Scope {\n  const l = ledger();', "function scope(key: string): Scope {\n  key = 's:round3-global'; // round 3: one ledger, every session\n  const l = ledger();"],
      ];
      const env3 = { NODE_OPTIONS: `--import=${path.join(ROOT, 'scripts', 'fixtures', 'bug-217', 'ledger-transform-hook.mjs')}`, BUG217_LEDGER_SWAPS: JSON.stringify(swaps) };
      const { b, s: s0 } = await baseWorld('b217p3', env3);
      let s = s0;
      try {
        const X = born('p3');
        const d1 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P3 round-3 eviction' });
        await waitIdleNoBridge(b, s);
        const fl = await flood(b, s, 20_400, { session: b.OTHER, dir: b.enc, project: b.projectId }, 'p3');
        await stopServer(s);
        s = await bootServer(b, b.env, { port: s.port });
        const d2 = await deliverRaw(b, s, { id: X, text: 'QUEUED-P3 round-3 eviction' });
        await sleep(2500);
        check('PRE-FIX P3: the round-3 ledger evicts X under a flood into another session, and after a restart X reaches the CLI twice', d1?.t === 'ack' && fl.join() === '200' && d2?.t === 'ack' && countIn(b, 'QUEUED-P3') === 2, { d1: d1?.t, flood: fl, d2: d2?.code ?? d2?.t, atCli: countIn(b, 'QUEUED-P3') });
      } finally { await cleanupWorld(b); }
    }
    /* PJ / PK — the round-2 client */
    if (want('PJ') || want('PK')) {
      const { b, s } = await baseWorld('b217p2');
      try {
        if (want('PJ')) {
          console.log('\n=== MUST-FAIL PJ (round-2 client over the pinned round-4 server): the sender dies mid-send — stranded ===');
          const ctx = await browser.newContext();
          const body = round2App();
          const driver = await newTab(ctx, { body });
          const follower = await newTab(ctx, { body });
          try {
            await openAt(driver, b, s);
            await queueMidTurnOld(driver, 'PJ', { sleepMs: 3000 });
            await driver.goto('about:blank');
            await waitIdleNoBridge(b, s);
            ageTranscript(b);
            const gate = { hold: () => true };
            await gateWs(driver, 'QUEUED-PJ', gate);
            await openAt(driver, b, s);
            await waitFor(() => (gate.held.length ? true : null), 65_000);
            await openAt(follower, b, s);
            await driver.close();
            await waitFor(() => (countIn(b, 'QUEUED-PJ') >= 1 ? true : null), 40_000, 500);
            const fd = await dock(follower);
            check('PRE-FIX PJ: 40 s after the sender died nothing reached the CLI, and the row is parked with no Send now',
              gate.held.length >= 1 && countIn(b, 'QUEUED-PJ') === 0 && fd.rows.some((r) => r.text.includes('QUEUED-PJ') && !r.acts.includes('Send now')), { held: gate.held.length, atCli: countIn(b, 'QUEUED-PJ'), dock: fd });
          } finally { await ctx.close(); await waitIdleNoBridge(b, s, 30_000); }
        }
        if (want('PK')) {
          console.log('\n=== MUST-FAIL PK (round-2 client): the same words as an earlier message make the new one vanish ===');
          const text = 'QUEUED-PK btw when trying to buy it says 403';
          const ctx = await browser.newContext();
          const page = await newTab(ctx, { body: round2App() });
          try {
            await openAt(page, b, s);
            await queueMidTurnOld(page, 'PK', { sleepMs: 3000 });
            await page.goto('about:blank');
            await waitIdleNoBridge(b, s);
            appendPriorTurn(b, text);
            ageTranscript(b);
            let holding = true;
            const gate = { hold: () => holding };
            await gateWs(page, text, gate);
            await openAt(page, b, s);
            await waitFor(() => (gate.held.length ? true : null), 65_000);
            holding = false;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction((x) => window.__station?.state?.current?.sessionId === x, b.SDK, { timeout: 45_000 });
            await waitFor(() => (countIn(b, text) >= 1 ? true : null), 40_000, 500);
            const d = await dock(page);
            check('PRE-FIX PK: never delivered, and gone from the dock', gate.held.length >= 1 && countIn(b, text) === 0 && !d.rows.some((r) => r.text.includes('QUEUED-PK')), { held: gate.held.length, atCli: countIn(b, text), dock: d });
          } finally { await ctx.close(); await waitIdleNoBridge(b, s, 30_000); }
        }
      } finally { await cleanupWorld(b); }
    }
    /* PE — the round-1 client, two tabs */
    if (want('PE')) {
      console.log('\n=== MUST-FAIL PE (round-1 client): two tabs restore one row; the driver sends it; closing it sends it again ===');
      const { b, s } = await baseWorld('b217pe');
      const ctx = await browser.newContext();
      try {
        const body = round1App();
        const t0 = await newTab(ctx, { body });
        const t1 = await newTab(ctx, { body });
        await openAt(t0, b, s);
        await queueMidTurnOld(t0, 'PE', { sleepMs: 15_000 });
        await t0.reload({ waitUntil: 'domcontentloaded' });
        await t0.waitForFunction((x) => window.__station?.state?.current?.sessionId === x, b.SDK, { timeout: 45_000 });
        await openAt(t1, b, s);
        await sleep(1500);
        const drives = [await t0.evaluate(() => !!(window.__station.state.live && !window.__station.state.liveElsewhere)), await t1.evaluate(() => !!(window.__station.state.live && !window.__station.state.liveElsewhere))];
        const driver = drives[1] && !drives[0] ? t1 : t0;
        await waitFor(() => (countIn(b, 'QUEUED-PE') >= 1 ? true : null), 45_000);
        await sleep(2000);
        await driver.close();
        await waitFor(() => (countIn(b, 'QUEUED-PE') > 1 ? true : null), 65_000, 500);
        check('PRE-FIX PE: the round-1 client double-sends — the follower sent the delivered row again', countIn(b, 'QUEUED-PE') >= 2, { atCli: countIn(b, 'QUEUED-PE'), drives });
      } finally { await ctx.close(); await cleanupWorld(b); }
    }
    /* PA — the incident client */
    if (want('PA')) {
      console.log('\n=== MUST-FAIL PA (the incident client): queued mid-turn, reloaded after the host closed — stranded ===');
      const { b, s } = await baseWorld('b217pa');
      const ctx = await browser.newContext();
      try {
        const page = await newTab(ctx, { body: round0App() });
        await openAt(page, b, s);
        await queueMidTurnOld(page, 'PA', { sleepMs: 4000 });
        await page.goto('about:blank');
        await waitIdleNoBridge(b, s);
        await openAt(page, b, s);
        const restored = await page.waitForFunction(() => window.__station.state.queue.some((q) => q.text.includes('QUEUED-PA')), null, { timeout: 15_000 }).then(() => true, () => false);
        await sleep(35_000);
        check('PRE-FIX PA: restored, never sent, never reached the CLI', restored && countIn(b, 'QUEUED-PA') === 0, { restored, atCli: countIn(b, 'QUEUED-PA') });
      } finally { await ctx.close(); await cleanupWorld(b); }
    }
    try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} catch (e) {
  fail++; failures.push(`FATAL: ${e.message}`);
  console.log(`  FATAL  ${e.stack}`);
} finally {
  if (DEBUG) console.log(`\n--- server log (tail) ---\n${srv.log.slice(-8000)}`);
  await browser.close().catch(() => {});
  await cleanupWorld(W);
}

console.log(`\nBUG-217: ${pass} passed / ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
