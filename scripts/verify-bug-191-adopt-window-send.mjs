#!/usr/bin/env node
/**
 * BUG-191 — a message sent while a restarted session's BUG-187 adoption is
 * still settling (`pending`) or has settled `responder-only` was lost: the
 * server acked the reattach-start (the client retired the text as delivered)
 * and only THEN tried `send()`, whose retryable gate refusal went out as a bare
 * non-retryable error nothing acted on. A `send` over an attached socket hit the
 * same gate and lost its `retryable` flag in the socket's catch-all.
 *
 * THE INVARIANT (ticket): a message sent to a session is either delivered
 * EXACTLY ONCE to the session's CLI, or rejected VISIBLY — and the server never
 * acks as delivered a message it did not deliver. An outcome the server cannot
 * establish (the broker never answered) is reported `uncertain` and is never
 * resent automatically.
 *
 *   node scripts/verify-bug-191-adopt-window-send.mjs [--arms=P1,…] [--broken-variant] [--keep]
 *
 *   --broken-variant  run against a scratch COPY of this tree in which the fix is
 *                     explicitly re-broken by exact anchored replacements (the
 *                     must-FAIL baseline; it throws LOUDLY if an anchor is gone,
 *                     so it can never silently become the fixed tree). Not HEAD:
 *                     BUG-187 itself is uncommitted, so no named commit carries
 *                     the pre-fix adoption code.
 *
 * Arms (fake CLI = scripts/fixtures/bug-187/fake-cli.mjs; every server isolated
 * on a free port with a scratch data dir + store; everything killed by pid;
 * SIGSTOP/SIGCONT only on brokers this script's own worlds spawned):
 *   P1  adoption PENDING, then `adopted`: a BUG-045-shaped client ends with the
 *       text in the CLI exactly once; no attempt is acked-then-refused.
 *   P2  adoption PENDING that fails (re-initialize never answered → 30 s): never
 *       acked-then-refused; every refusal retryable; nothing lost.
 *   P3  RESPONDER-ONLY whose broker ended its CLI's input: retryable pre-ack
 *       refusals until the old CLI exits, then exactly one delivery (resume).
 *   P4  a `send` over a socket ATTACHED to that session: refused retryable,
 *       tagged `of:'send'` with the client's `sendId` echoed; nothing written.
 *   P5  gate PASSES on a stale record but the broker has ended stdin: start and
 *       attached-send both refused retryably by the broker's own NO; 0 writes.
 *   P6  UNCERTAIN: a gate-passing responder-only session whose broker is
 *       SIGSTOPped across the delivery → `uncertain` (not retryable, no ack);
 *       after SIGCONT the frame lands exactly once and nothing resends it.
 *   P7  an OLD (pinned 541dd73) broker: adopted responder-only → refused
 *       retryably, zero prompt writes; and FEAT-065's survivor path into an
 *       unadoptable old broker → refused, zero prompt writes.
 *   P10 (lead B5) an OLD broker adopted `adopted` (it was still running): refused
 *       retryably, zero writes; the refusal retires it gracefully and the
 *       queued message resumes from disk on a fresh CLI exactly once; and the
 *       loss it prevents (an ended-input old broker drops a write silently).
 *   P8  the delivery RESERVATION: while one socket's delivery is in flight a
 *       second prompt is refused retryably and a promptless reattach is told
 *       live-elsewhere; the owner disconnecting does not release it early.
 *   P9  a DELIVERED reattach: ack carries `promptDelivered:true` (and busy) only
 *       after the broker's acceptance; exactly one delivery.
 *   B1  brave, real click path, busy-ish fixture: Enter during a pending
 *       adoption → a visible queue row (no bubble claiming delivery) → after
 *       adoption, exactly one delivery and the row retires.
 *   B2  brave: an attached tab's queued BATCH (2 rows, typed during a turn) is
 *       refused at the boundary → both rows recovered, in order, as waiting
 *       rows; bubble gone; nothing delivered.
 *   B4  brave (lead B5): a session an `adopted` OLD broker holds → Enter gives a
 *       visible waiting row naming the older host; it retires; the row
 *       resumes the session on a fresh CLI exactly once.
 *   B3  brave: a retry whose socket dies right after `start` (the server
 *       delivers, the ack is lost) → the row ends DEAD ("never confirmed"),
 *       never re-sent; the CLI has it exactly once.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, FAKE_CLI, sleep, pidAlive, makeChecker, makeWorld, bootServer, stopServer, registerProject, openWs,
  waitFor, waitEv, hostFor, fakeCmd, fakeTap, startFakeSession, health, cleanupWorld, writeSyntheticTranscript,
  spawnBrokerDirect, rawClient, readJson, mkScratch, fakeLog,
} from './lib/bug-187-harness.mjs';
import { materialisePinnedTree } from './lib/pinned-tree.mjs';

const ARGV = process.argv.slice(2);
const arg = (k) => { const a = ARGV.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const KEEP = ARGV.includes('--keep');
const BROKEN = ARGV.includes('--broken-variant');
const ALL_ARMS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'B1', 'B2', 'B3', 'B4'];
const ARMS = (arg('arms') ? arg('arms').split(',') : ALL_ARMS).map((s) => s.trim()).filter(Boolean);

/* ------------------------------------------------ the broken variant (baseline) */
function makeBrokenVariant() {
  const dir = mkScratch('b191-broken');
  for (const d of ['src', 'public', 'scripts']) {
    const r = spawnSync('cp', ['-a', '--reflink=auto', path.join(ROOT, d), path.join(dir, d)]);
    if (r.status !== 0) throw new Error(`broken-variant: copy ${d} failed: ${r.stderr}`);
  }
  for (const f of ['package.json', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(ROOT, 'docs'), path.join(dir, 'docs')); // read-only inputs (template seeds, board)
  const breakAt = (rel, anchor, replacement) => {
    const p = path.join(dir, rel);
    const s = fs.readFileSync(p, 'utf8');
    if (s.split(anchor).length !== 2) throw new Error(`broken-variant: ANCHOR NOT FOUND EXACTLY ONCE in ${rel} — the fix changed shape; update the variant rather than trusting it:\n  ${anchor}`);
    fs.writeFileSync(p, s.replace(anchor, replacement));
  };
  // Server: the reattach decides nothing before the ack (the pre-fix order) …
  breakAt('src/server/index.ts', 'if (prompt && running.adoptGated) {', 'if (false) {');
  // … and a gated `send` loses its retryable flag in the catch-all again.
  breakAt('src/server/index.ts', 'if (session.adoptGated) {', 'if (false) {');
  breakAt('src/server/index.ts', "if (e.retryable) return send({ t: 'error', fatal: false, retryable: true, of: 'send'", "if (false) return send({ t: 'error', fatal: false, retryable: true, of: 'send'");
  // FEAT-065: an old broker is offered delivery again.
  breakAt('src/server/index.ts', '&& (survivor.protocol ?? 0) >= 2', '');
  breakAt('src/server/survivor-delivery.ts', 'BUG-187 speaks protocol 2.)\n         */\n        fail();',
    'BUG-187 speaks protocol 2.)\n         */\n        { const d = establish(); try { socket.write(`${JSON.stringify(frame)}\\n`); } catch { d.finish(\'write failed\'); return resolve(null); } resolve(d); }');
  // Client: a refused attempt is not recovered; a ghost retry is not kept dead.
  breakAt('public/app.js', 'if (e.retryable) queueRefusedSend(attempt, e.drain);', 'if (false) queueRefusedSend(attempt, e.drain);');
  breakAt('public/app.js', 'if (ghost) keepUnconfirmedStart();', '');
  breakAt('public/app.js', 'ghost.dead = UNCONFIRMED_NOTE;\n    ghost.drainWait = null;', '');
  // Round 2 (B5): the protocol gate is consulted only while adopt-gated again, and
  // a prompt-bearing reattach of an ordinary (e.g. `adopted`) session is decided after the ack.
  breakAt('src/server/agent-bridge.ts', 'const oldHost = this.#brokerProtocol !== null && this.#brokerProtocol < 2;', 'const oldHost = this.#brokerProtocol !== null && this.#brokerProtocol < 2 && this.adoptGated;');
  breakAt('src/server/index.ts', 'if (gate && !gate.ok) {', 'if (gate && !gate.ok && running.adoptGated) {');
  console.log(`BROKEN VARIANT materialised at ${dir} (10 anchored re-breaks applied)`);
  return dir;
}
const TREE = BROKEN ? makeBrokenVariant() : ROOT;
console.log(`BUG-191 verifier — tree: ${TREE}${BROKEN ? ' (BROKEN VARIANT — must FAIL)' : ' (working tree)'}; arms: ${ARMS.join(',')}`);

const worlds = [];
const world = (name) => { const w = makeWorld(`b191-${name}`, { tree: TREE }); worlds.push(w); return w; };
const stopped = new Set(); // pids we SIGSTOPped — always SIGCONT'd in cleanup
const sigstop = (pid) => { try { process.kill(pid, 'SIGSTOP'); stopped.add(pid); } catch { /* gone */ } };
const sigcont = (pid) => { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } stopped.delete(pid); };
const liveSession = async (srv, station) => ((await health(srv))?.sessions ?? []).find((x) => x.stationSessionId === station) ?? null;
/** Every user frame on any fake CLI's stdin in this world whose text carries `marker`. */
function deliveries(w, marker) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.dirname(w.tap)).filter((n) => n.startsWith(`${path.basename(w.tap)}.`)); } catch { /* none */ }
  for (const n of names) {
    const pid = Number(n.split('.').pop());
    for (const x of fakeTap(w, pid)) if (x.m?.type === 'user' && JSON.stringify(x.m.message ?? '').includes(marker)) out.push({ pid, at: x.at });
  }
  return out;
}

/**
 * One send attempt shaped like the dashboard's: `start` + resume + prompt on a
 * fresh socket. What the CLIENT would conclude:
 *   acked            — it retires the text as delivered
 *   ackedBusy        — a busy reattach WITHOUT promptDelivered: re-queued for a later boundary `send`
 *   retry            — a retryable pre-ack refusal: it queues + retries
 *   uncertain        — the server could not establish delivery: kept dead, not resent
 *   rejected         — a non-retryable pre-ack refusal: text back to the composer
 *   ackedThenRefused — THE DEFECT: an error after the ack (the text is already retired)
 */
async function attempt(srv, projectId, sdkId, prompt) {
  const c = await openWs(srv);
  c.send({ type: 'start', projectId, resumeSessionId: sdkId, prompt });
  const first = await waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error') ?? null, 20_000);
  let res;
  if (!first) res = { kind: 'timeout' };
  else if (first.t === 'ack') {
    await sleep(1_200);
    const after = c.events.filter((e) => e.t === 'error' && e.at >= first.at);
    res = after.length ? { kind: 'ackedThenRefused', ack: first, errors: after.map((e) => e.message) }
      : (first.busy && !first.promptDelivered) ? { kind: 'ackedBusy', ack: first } : { kind: 'acked', ack: first };
  } else if (first.uncertain) res = { kind: 'uncertain', message: first.message };
  else res = first.retryable === true ? { kind: 'retry', message: first.message, drain: first.drain ?? null, code: first.code } : { kind: 'rejected', message: first.message, fatal: first.fatal, code: first.code };
  return { ...res, c };
}

/** The BUG-045 client loop: retry a retryable refusal every `gapMs` until acked/rejected/uncertain or `untilMs`. */
async function clientSend(srv, projectId, sdkId, prompt, { untilMs = 60_000, gapMs = 2_000 } = {}) {
  const log = [];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < untilMs) {
    const a = await attempt(srv, projectId, sdkId, prompt);
    log.push({ atMs: Date.now() - t0, kind: a.kind, ...(a.message ? { message: a.message.slice(0, 110) } : {}), ...(a.errors ? { errors: a.errors.map((m) => m.slice(0, 110)) } : {}) });
    last = a;
    if (a.kind !== 'retry') break;
    a.c.close();
    await sleep(gapMs);
  }
  return { log, last };
}

/* ------------------------------------------------------------------ fixtures */

/** A normal protocol-2 session with a live lane, surviving a server restart. */
async function seedAdoptable(name, { reinitMs } = {}) {
  const w = world(name);
  const srv1 = await bootServer(w);
  const port = srv1.port;
  const pid = await registerProject(srv1, w);
  const s = await startFakeSession(srv1, w, pid, '[[fake:{"op":"lane_start","id":"L191"}]] seed turn');
  await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
  const sdk = hostFor(w, s.station).sdkSessionId;
  if (reinitMs !== undefined) fakeCmd(w, s.cli, { op: 'reinit_delay', ms: reinitMs });
  await sleep(400);
  s.c.close();
  await sleep(400);
  await stopServer(srv1);
  return { w, port, pid, s, sdk };
}

const KE = {
  CLAUDE_STATION_HOST_DRAIN_TERM_MS: '30000', CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000', CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500',
  CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '1000', CLAUDE_STATION_HOST_REAP_RESULT_WAIT_MS: '1500', FAKE_EOF_MODE: 'ignore',
};
/** A protocol-2 broker whose CLI input has ENDED, adopted `responder-only` by a restarted server. */
async function seedEnded(name, { termMs = '30000', env = {} } = {}) {
  const E = { ...KE, CLAUDE_STATION_HOST_DRAIN_TERM_MS: termMs, ...env };
  const w = world(name);
  const srv1 = await bootServer(w, E);
  const port = srv1.port;
  const pid = await registerProject(srv1, w);
  const s = await startFakeSession(srv1, w, pid, 'seed turn');
  await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
  const h = hostFor(w, s.station);
  writeSyntheticTranscript(w, h.sdkSessionId, ['earlier: the seed turn', 'earlier: more work in this session']);
  fakeCmd(w, s.cli, { op: 'mid_turn_open' });
  await sleep(800);
  s.c.close();
  await stopServer(srv1);
  try { process.kill(h.hostPid, 'SIGTERM'); } catch { /* gone */ }
  const ended = await waitFor(() => (hostFor(w, s.station)?.acceptingInput === false ? true : null), 8_000);
  const srv = await bootServer(w, E, { port });
  const ro = await waitFor(async () => { const x = await liveSession(srv, s.station); return x && x.adoptState && x.adoptState !== 'pending' ? x : null; }, 15_000);
  return { w, srv, port, pid, s, h, ended: !!ended, adoptState: ro?.adoptState ?? null };
}

/**
 * A protocol-2 broker that DECLINES the reclaim (a constructed variant of this
 * tree's session-host.mjs: one anchored line), so a restarted server adopts it
 * `responder-only` while its CLI still takes input — the state in which the
 * gate PASSES and the delivery rides the broker's correlated acceptance.
 */
function decliningBrokerScript(w) {
  const dir = path.join(w.base, 'declining-host');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['session-host.mjs', 'request-floor.mjs', 'path-env.mjs']) fs.copyFileSync(path.join(TREE, 'src', 'server', f), path.join(dir, f));
  const p = path.join(dir, 'session-host.mjs');
  const s = fs.readFileSync(p, 'utf8');
  const anchor = 'else { reclaim(); reply = { ok: true }; }';
  if (s.split(anchor).length !== 2) throw new Error('declining broker: reclaim anchor not found exactly once in session-host.mjs');
  fs.writeFileSync(p, s.replace(anchor, "else { reply = { ok: false, reason: 'declined-by-test-variant' }; }"));
  return p;
}
async function seedDeclining(name, { reinitMs, env = {}, serverEnv = {} } = {}) {
  const w = world(name);
  const srv0 = await bootServer(w);
  const port = srv0.port;
  const pid = await registerProject(srv0, w);
  await stopServer(srv0);
  const station = `b191-${name}-${Date.now().toString(36)}`;
  const b = spawnBrokerDirect(w, { hostScript: decliningBrokerScript(w), command: process.execPath, args: [FAKE_CLI], stationSessionId: station, env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000', ...env } });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const cli = st.claudePid;
  const orig = await rawClient(b.sock); // the "previous server": its initialize makes the adopter's a REPEATED one
  orig.write({ type: 'control_request', request_id: 'orig-init', request: { subtype: 'initialize', hooks: {} } });
  await sleep(300);
  fakeCmd(w, cli, { op: 'lane_start', id: 'LD' });
  const sdk = await waitFor(() => readJson(b.statusPath)?.sdkSessionId ?? null, 8_000);
  if (reinitMs !== undefined) fakeCmd(w, cli, { op: 'reinit_delay', ms: reinitMs });
  await sleep(500);
  orig.close();
  await sleep(300);
  writeSyntheticTranscript(w, sdk, ['earlier: a long-running scrape', 'earlier: checked the results']);
  const srv = await bootServer(w, serverEnv, { port });
  return { w, srv, port, pid, station, b, cli, hostPid: st.hostPid, sdk };
}
const settledAdopt = (srv, station, ms = 20_000) => waitFor(async () => { const x = await liveSession(srv, station); return x && x.adoptState && x.adoptState !== 'pending' ? x : null; }, ms);

/* ---------------------------------------------------------------------- arms */

async function armP1() {
  const k = makeChecker('P1');
  const { w, port, pid, s, sdk } = await seedAdoptable('p1', { reinitMs: 8_000 });
  const srv = await bootServer(w, {}, { port });
  const pend = await waitFor(async () => { const x = await liveSession(srv, s.station); return x?.adoptState === 'pending' ? x : null; }, 10_000, 100);
  k.check('P1 PRECONDITION: the restarted server holds the session in a PENDING adoption', !!pend, { adoptState: pend?.adoptState ?? null });
  const marker = `B191-P1-${Date.now()}`;
  const r = await clientSend(srv, pid, sdk, `${marker} sent during the pending adoption`, { untilMs: 40_000 });
  await sleep(2_500);
  const got = deliveries(w, marker);
  const settled = await liveSession(srv, s.station);
  k.check('P1 no attempt is acked and THEN refused (an ack is only ever sent for a message the server delivered)', !r.log.some((a) => a.kind === 'ackedThenRefused'), { attempts: r.log });
  k.check('P1 the message reaches the CLI EXACTLY ONCE, after the adoption settles', got.length === 1 && r.last?.kind === 'acked', { deliveries: got.length, adoptState: settled?.adoptState ?? null, attempts: r.log.length, last: r.last?.kind });
  k.check('P1 every refusal inside the pending window was retryable (the client queues it, visibly)',
    r.log.some((a) => a.kind === 'retry') && r.log.filter((a) => a.kind !== 'acked').every((a) => a.kind === 'retry'), { kinds: r.log.map((a) => a.kind), firstMessage: r.log[0]?.message });
  r.last?.c?.close();
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'L191' });
  return k.results;
}

async function armP2() {
  const k = makeChecker('P2');
  const { w, port, pid, s, sdk } = await seedAdoptable('p2', { reinitMs: -1 });
  const srv = await bootServer(w, {}, { port });
  const pend = await waitFor(async () => { const x = await liveSession(srv, s.station); return x?.adoptState === 'pending' ? x : null; }, 10_000, 100);
  k.check('P2 PRECONDITION: pending adoption whose CLI never answers the re-initialize', !!pend, { adoptState: pend?.adoptState ?? null });
  const marker = `B191-P2-${Date.now()}`;
  const r = await clientSend(srv, pid, sdk, `${marker} sent while the adoption is doomed`, { untilMs: 45_000, gapMs: 3_000 });
  await sleep(2_000);
  const got = deliveries(w, marker);
  const acked = r.log.filter((a) => a.kind === 'acked').length;
  k.check('P2 across the pending window AND the adoption failure: never acked-then-refused', !r.log.some((a) => a.kind === 'ackedThenRefused'), { attempts: r.log });
  k.check('P2 …and never lost: delivered exactly once on its ack, or still queued (every refusal retryable)',
    (acked === 1 && got.length === 1) || (acked === 0 && got.length === 0 && r.log.length > 0 && r.log.every((a) => a.kind === 'retry')),
    { acked, deliveries: got.length, kinds: r.log.map((a) => a.kind), brokerAlive: pidAlive(hostFor(w, s.station)?.hostPid) });
  r.last?.c?.close();
  try { process.kill(s.cli, 'SIGKILL'); } catch { /* gone */ }
  return k.results;
}

async function armP3() {
  const k = makeChecker('P3');
  const { w, srv, pid, h, ended, adoptState } = await seedEnded('p3', { termMs: '12000' });
  k.check('P3 PRECONDITION: adopted RESPONDER-ONLY over a broker that already ended its CLI\'s input', ended && adoptState === 'responder-only', { stdinEnded: ended, adoptState });
  const marker = `B191-P3-${Date.now()}`;
  const r = await clientSend(srv, pid, h.sdkSessionId, `${marker} sent to a responder-only session`, { untilMs: 50_000, gapMs: 2_500 });
  await sleep(2_500);
  const got = deliveries(w, marker);
  k.check('P3 never acked-then-refused, never acked-busy-without-delivery while responder-only', !r.log.some((a) => a.kind === 'ackedThenRefused' || a.kind === 'ackedBusy'), { attempts: r.log });
  k.check('P3 every attempt before the old CLI exits is a RETRYABLE pre-ack refusal; once it exits the retry lands the text EXACTLY ONCE (not into the old CLI)',
    r.last?.kind === 'acked' && got.length === 1 && r.log.slice(0, -1).every((a) => a.kind === 'retry') && !got.some((d) => d.pid === h.claudePid),
    { kinds: r.log.map((a) => a.kind), deliveries: got, oldCli: h.claudePid, oldCliAlive: pidAlive(h.claudePid) });
  r.last?.c?.close();
  return k.results;
}

async function promptlessReattach(srv, pid, sdk) {
  const c = await openWs(srv);
  c.send({ type: 'start', projectId: pid, resumeSessionId: sdk });
  const first = await waitEv(c, (e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error', 10_000);
  return { c, first };
}

async function armP4() {
  const k = makeChecker('P4');
  const { w, srv, pid, h, adoptState } = await seedEnded('p4');
  const { c, first } = await promptlessReattach(srv, pid, h.sdkSessionId);
  k.check('P4 PRECONDITION: a promptless reattach to the responder-only session is acked (the tab can watch it)', adoptState === 'responder-only' && first?.t === 'ack', { adoptState, first: first?.t ?? null });
  const marker = `B191-P4-${Date.now()}`;
  const t = Date.now();
  c.send({ type: 'send', prompt: `${marker} typed into the attached tab`, sendId: 'sid-p4' });
  const reply = await waitFor(() => c.events.find((e) => e.at >= t && ((e.t === 'ack' && e.of === 'send') || e.t === 'error')) ?? null, 20_000);
  await sleep(800);
  const got = deliveries(w, marker);
  k.check('P4 the refusal of an attached `send` is RETRYABLE, tagged of:send with the sendId echoed, never acked, nothing written',
    reply?.t === 'error' && reply.retryable === true && reply.of === 'send' && reply.sendId === 'sid-p4' && got.length === 0,
    { reply: reply ? { t: reply.t, retryable: reply.retryable ?? null, of: reply.of ?? null, sendId: reply.sendId ?? null, message: String(reply.message ?? '').slice(0, 100) } : null, deliveries: got.length });
  c.close();
  return k.results;
}

/** Overwrite a broker record so the gate reads "accepting, idle, lane held" — a stale record (the broker's truth differs). */
function staleAccepting(w, station) {
  const h = hostFor(w, station);
  fs.writeFileSync(h.status, JSON.stringify({ ...h, acceptingInput: true, midTurn: false, backgroundLifetime: 'yes', backgroundLive: 1, backgroundTaskIds: ['stale-lane'] }));
}

async function armP5() {
  const k = makeChecker('P5');
  const { w, srv, pid, h, s, adoptState } = await seedEnded('p5');
  k.check('P5 PRECONDITION: responder-only over a broker whose input has ended', adoptState === 'responder-only', { adoptState });
  // start path
  sigstop(h.hostPid); // hold its heartbeat so the stale record stays stale while the gate reads it
  staleAccepting(w, s.station);
  const m1 = `B191-P5a-${Date.now()}`;
  const c1 = await openWs(srv);
  c1.send({ type: 'start', projectId: pid, resumeSessionId: h.sdkSessionId, prompt: `${m1} start` });
  await sleep(300);
  sigcont(h.hostPid);
  const r1 = await waitFor(() => c1.events.find((e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error') ?? null, 20_000);
  await sleep(1_000);
  k.check('P5 start: the gate passed on a stale record, the BROKER said no (input ended) → a retryable refusal, no ack, nothing written',
    r1?.t === 'error' && r1.retryable === true && /NOT delivered/.test(r1.message ?? '') && !c1.events.some((e) => e.t === 'ack' && e.of === 'start') && deliveries(w, m1).length === 0,
    { first: r1 ? { t: r1.t, retryable: r1.retryable ?? null, message: String(r1.message ?? '').slice(0, 160) } : null, deliveries: deliveries(w, m1).length });
  c1.close();
  // attached-send path
  const { c } = await promptlessReattach(srv, pid, h.sdkSessionId);
  sigstop(h.hostPid);
  staleAccepting(w, s.station);
  const m2 = `B191-P5b-${Date.now()}`;
  const t = Date.now();
  c.send({ type: 'send', prompt: `${m2} attached`, sendId: 'sid-p5' });
  await sleep(300);
  sigcont(h.hostPid);
  const r2 = await waitFor(() => c.events.find((e) => e.at >= t && ((e.t === 'ack' && e.of === 'send') || e.t === 'error')) ?? null, 20_000);
  await sleep(800);
  k.check('P5 attached send: same — the broker\'s NO becomes a retryable of:send refusal with the sendId, never an ack; nothing written',
    r2?.t === 'error' && r2.retryable === true && r2.of === 'send' && r2.sendId === 'sid-p5' && /NOT delivered/.test(r2.message ?? '') && deliveries(w, m2).length === 0,
    { reply: r2 ? { t: r2.t, retryable: r2.retryable ?? null, of: r2.of ?? null, message: String(r2.message ?? '').slice(0, 160) } : null, deliveries: deliveries(w, m2).length });
  c.close();
  return k.results;
}

async function armP6() {
  const k = makeChecker('P6');
  const d = await seedDeclining('p6', { serverEnv: { CLAUDE_STATION_GATED_DELIVER_ACK_MS: '2000' } });
  const x = await settledAdopt(d.srv, d.station);
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === false ? true : null), 5_000);
  k.check('P6 PRECONDITION: a protocol-2 broker that declined the reclaim → responder-only, CLI input still open', x?.adoptState === 'responder-only' && readJson(d.b.statusPath)?.acceptingInput !== false, { adoptState: x?.adoptState ?? null });
  const marker = `B191-P6-${Date.now()}`;
  const c = await openWs(d.srv);
  // Freeze the broker FIRST: the gate reads its (true, fresh) record file, the envelope goes out, no answer can come back.
  sigstop(d.hostPid);
  c.send({ type: 'start', projectId: d.pid, resumeSessionId: d.sdk, prompt: `${marker} into a frozen broker` });
  const first = await waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error') ?? null, 15_000);
  sigcont(d.hostPid);
  await sleep(3_000);
  const got = deliveries(d.w, marker);
  k.check('P6 an unanswered delivery is reported UNCERTAIN — not retryable, never acked (the client keeps it dead; no blind resend)',
    first?.t === 'error' && first.uncertain === true && first.retryable !== true && !c.events.some((e) => e.t === 'ack' && e.of === 'start'),
    { first: first ? { t: first.t, uncertain: first.uncertain ?? null, retryable: first.retryable ?? null, message: String(first.message ?? '').slice(0, 120) } : null });
  k.check('P6 …and once the broker runs again the frame lands EXACTLY ONCE (the uncertain outcome was honest; nothing resent it)', got.length === 1, { deliveries: got.length });
  c.close();
  fakeCmd(d.w, d.cli, { op: 'lane_end', id: 'LD' });
  return k.results;
}

let PINNED = null;
function oldBrokerScript() {
  if (!PINNED) PINNED = materialisePinnedTree('541dd73', { prefix: 'b191-oldbroker-' });
  return path.join(PINNED.dir, 'src', 'server', 'session-host.mjs');
}
async function spawnOld(w, station, cwd, env = {}) {
  const ob = spawnBrokerDirect(w, { hostScript: oldBrokerScript(), command: process.execPath, args: [FAKE_CLI], stationSessionId: station, cwd, env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000', ...env } });
  const st = await waitFor(() => { const r = readJson(ob.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const orig = await rawClient(ob.sock);
  orig.write({ type: 'control_request', request_id: 'orig-init', request: { subtype: 'initialize', hooks: {} } });
  await sleep(300);
  fakeCmd(w, st.claudePid, { op: 'lane_start', id: `L-${station}` });
  fakeCmd(w, st.claudePid, { op: 'result' }); // the old broker's catch-all took the lane frames as a turn; end it (midTurn false)
  const sdk = await waitFor(() => readJson(ob.statusPath)?.sdkSessionId ?? null, 8_000);
  await sleep(500);
  orig.close();
  await sleep(300);
  return { ob, st, sdk };
}
async function armP7() {
  const k = makeChecker('P7');
  {
    // (a) an OLD broker adopted responder-only (an earlier server's drain decision, held by its lane)
    const w = world('p7a');
    const srv0 = await bootServer(w);
    const port = srv0.port;
    const pid = await registerProject(srv0, w);
    await stopServer(srv0);
    const { ob, st, sdk } = await spawnOld(w, 'b191-p7-old', w.work);
    try { process.kill(st.hostPid, 'SIGTERM'); } catch { /* gone */ }
    await waitFor(() => (readJson(ob.statusPath)?.state === 'draining' ? true : null), 5_000);
    const srv = await bootServer(w, {}, { port });
    const x = await settledAdopt(srv, 'b191-p7-old');
    const marker = `B191-P7a-${Date.now()}`;
    const a = await attempt(srv, pid, sdk, `${marker} into an old broker`);
    await sleep(1_500);
    k.check('P7a an OLD broker adopted responder-only: the message is refused RETRYABLY before any write (it cannot confirm a delivery) — zero prompt writes',
      x?.adoptState === 'responder-only' && a.kind === 'retry' && deliveries(w, marker).length === 0,
      { adoptState: x?.adoptState ?? null, outcome: a.kind, message: a.message?.slice(0, 120), deliveries: deliveries(w, marker).length });
    a.c.close();
    fakeCmd(w, st.claudePid, { op: 'lane_end', id: 'L-b191-p7-old' });
  }
  {
    // (b) FEAT-065's survivor path into an UNADOPTABLE old broker (no registered project owns its cwd)
    const w = world('p7b');
    const srv0 = await bootServer(w);
    const port = srv0.port;
    const pid = await registerProject(srv0, w);
    await stopServer(srv0);
    const elsewhere = path.join(w.base, 'not-a-registered-project');
    fs.mkdirSync(elsewhere, { recursive: true });
    const { ob, st, sdk } = await spawnOld(w, 'b191-p7b-old', elsewhere);
    const srv = await bootServer(w, {}, { port });
    const drained = await waitFor(() => { const r = readJson(ob.statusPath); return r?.state === 'draining' && r.midTurn === false ? r : null; }, 10_000);
    const marker = `B191-P7b-${Date.now()}`;
    const a = await attempt(srv, pid, sdk, `${marker} into an unadoptable old survivor`);
    await sleep(1_500);
    k.check('P7b FEAT-065 into an unadoptable OLD survivor (draining, idle, lane held): refused RETRYABLY — zero prompt writes, never acked as delivered',
      !!drained && a.kind === 'retry' && deliveries(w, marker).length === 0,
      { brokerState: drained?.state ?? readJson(ob.statusPath)?.state ?? 'gone', outcome: a.kind, deliveries: deliveries(w, marker).length });
    a.c.close();
    fakeCmd(w, st.claudePid, { op: 'lane_end', id: 'L-b191-p7b-old' });
  }
  return k.results;
}

/**
 * P10 (round 2, lead B5) — an OLD (pinned 541dd73, protocol 0) broker that was
 * still RUNNING when the server restarted is adopted `adopted` (this server owns
 * it). It has no H7 `deliver_ack`, so nothing it is sent can be confirmed.
 *   (a) a message must be refused RETRYABLY before any write, never acked;
 *   (b) the user is never stuck: the refusal retires the old host (graceful —
 *       its lane finishes first), and the queued message then resumes the
 *       session from disk on a FRESH CLI, exactly once;
 *   (c) the harm the gate prevents: the same adopted old broker after its CLI's
 *       input ended (SIGTERM → drain committed; a CLI wedged after EOF) — a
 *       write there is dropped by the broker with no signal at all.
 */
async function armP10() {
  const k = makeChecker('P10');
  {
    const w = world('p10ab');
    const srv0 = await bootServer(w);
    const port = srv0.port;
    const pid = await registerProject(srv0, w);
    await stopServer(srv0);
    const station = 'b191-p10-old';
    // Drain knobs shortened (the old broker's 90 s result backstop is not a knob, so the
    // turn boundary it waits for is supplied below); the CLI EXITS on EOF, as a real one does.
    const { ob, st, sdk } = await spawnOld(w, station, w.work, { CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500', CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '1000', CLAUDE_STATION_HOST_DRAIN_TERM_MS: '30000' });
    writeSyntheticTranscript(w, sdk, ['earlier: work done by the old host', 'earlier: more of it']);
    const srv = await bootServer(w, {}, { port });
    const x = await settledAdopt(srv, station);
    k.check('P10 PRECONDITION: an OLD (no-hello) broker that was still running is adopted `adopted`, not draining',
      x?.adoptState === 'adopted' && readJson(ob.statusPath)?.state !== 'draining', { adoptState: x?.adoptState ?? null, brokerState: readJson(ob.statusPath)?.state ?? null });
    const mA = `B191-P10a-${Date.now()}`;
    const a = await attempt(srv, pid, sdk, `${mA} into an adopted old broker`);
    await sleep(1_500);
    const gotA = deliveries(w, mA);
    k.check('P10a an ADOPTED old broker (cannot confirm a delivery): refused RETRYABLY before any write — never acked, zero prompt writes',
      a.kind === 'retry' && gotA.length === 0,
      { outcome: a.kind, promptDelivered: a.ack?.promptDelivered ?? null, message: a.message?.slice(0, 160), drainAdoptState: a.drain?.adoptState ?? null, deliveries: gotA.length });
    a.c?.close();
    // (b) the user keeps sending (the BUG-045 loop); the old lane finishes meanwhile.
    const retiring = await waitFor(() => (readJson(ob.statusPath)?.state === 'draining' || !pidAlive(st.hostPid) ? true : null), 5_000);
    k.check('P10b the refusal RETIRES the old host (graceful drain started) instead of leaving the user waiting on a CLI nothing will ever end',
      !!retiring && pidAlive(st.claudePid), { brokerState: readJson(ob.statusPath)?.state ?? 'gone', oldCliAlive: pidAlive(st.claudePid) });
    const mB = `B191-P10b-${Date.now()}`;
    // The old lane finishes 3 s in, then the CLI's turn boundary (a real CLI's `result`;
    // the old broker counts the adopter's initialize answer as a turn and waits for one).
    setTimeout(() => { fakeCmd(w, st.claudePid, { op: 'lane_end', id: `L-${station}` }); fakeCmd(w, st.claudePid, { op: 'result' }); }, 3_000);
    const r = await clientSend(srv, pid, sdk, `${mB} the user keeps talking`, { untilMs: 60_000, gapMs: 2_000 });
    await sleep(2_500);
    const gotB = deliveries(w, mB);
    k.check('P10b …and is never stuck: every attempt before the old CLI exits is a visible RETRYABLE refusal, then the message resumes the session from disk on a FRESH CLI EXACTLY ONCE (never into the old CLI)',
      r.last?.kind === 'acked' && gotB.length === 1 && !gotB.some((d) => d.pid === st.claudePid) && r.log.slice(0, -1).every((q) => q.kind === 'retry') && !pidAlive(st.claudePid),
      { kinds: r.log.map((q) => q.kind), deliveries: gotB, oldCli: st.claudePid, oldCliAlive: pidAlive(st.claudePid), firstMessage: r.log[0]?.message });
    r.last?.c?.close();
  }
  {
    // (c) the silent-loss mechanism: an adopted old broker whose CLI input has
    // ended, with the user's tab ATTACHED (so the detached-close fuse is not what
    // ends it). The SIGTERM stands in for anything that commits the old broker's
    // drain (synthetic trigger; the old broker keeps its client connected).
    const w = world('p10c');
    const srv0 = await bootServer(w);
    const port = srv0.port;
    const pid = await registerProject(srv0, w);
    await stopServer(srv0);
    const station = 'b191-p10c-old';
    const { st, sdk } = await spawnOld(w, station, w.work, { ...KE, CLAUDE_STATION_HOST_ABANDON_MS: '600000' });
    const srv = await bootServer(w, {}, { port });
    const x = await settledAdopt(srv, station);
    const { c, first } = await promptlessReattach(srv, pid, sdk);
    fakeCmd(w, st.claudePid, { op: 'lane_end', id: `L-${station}` });
    fakeCmd(w, st.claudePid, { op: 'result' });
    await sleep(800);
    try { process.kill(st.hostPid, 'SIGTERM'); } catch { /* gone */ }
    const eof = await waitFor(() => (fakeLog(w, st.claudePid).some((e) => e.ev === 'stdin-eof') ? true : null), 15_000);
    const alive = await liveSession(srv, station);
    k.check('P10c PRECONDITION: adopted old broker with a tab attached; its CLI input ended (CLI still alive, bridge still held)',
      x?.adoptState === 'adopted' && first?.t === 'ack' && !!eof && pidAlive(st.claudePid) && alive?.adoptState === 'adopted',
      { adoptState: x?.adoptState ?? null, attached: first?.t ?? null, eof: !!eof, cliAlive: pidAlive(st.claudePid), bridge: alive?.adoptState ?? 'gone' });
    const m = `B191-P10c-${Date.now()}`;
    const t = Date.now();
    c.send({ type: 'send', prompt: `${m} typed into the attached tab`, sendId: 'sid-p10c' });
    const reply = await waitFor(() => c.events.find((e) => e.at >= t && ((e.t === 'ack' && e.of === 'send') || e.t === 'error')) ?? null, 20_000);
    await sleep(1_500);
    const got = deliveries(w, m);
    k.check('P10c a message into it is NEVER acked as delivered (the old broker would drop it with no signal) — refused retryably of:send, zero writes',
      reply?.t === 'error' && reply.retryable === true && reply.of === 'send' && got.length === 0,
      { reply: reply ? { t: reply.t, delivered: reply.delivered ?? null, retryable: reply.retryable ?? null, message: String(reply.message ?? '').slice(0, 120) } : null, deliveries: got.length });
    c.close();
    try { process.kill(st.claudePid, 'SIGKILL'); } catch { /* gone */ }
  }
  return k.results;
}

async function armP8() {
  const k = makeChecker('P8');
  const d = await seedDeclining('p8', { serverEnv: { CLAUDE_STATION_GATED_DELIVER_ACK_MS: '6000' } });
  const x = await settledAdopt(d.srv, d.station);
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === false ? true : null), 5_000);
  k.check('P8 PRECONDITION: responder-only, gate passes', x?.adoptState === 'responder-only', { adoptState: x?.adoptState ?? null });
  const mA = `B191-P8A-${Date.now()}`;
  const cA = await openWs(d.srv);
  sigstop(d.hostPid); // frozen first: the owner's delivery goes out and stays unanswered
  cA.send({ type: 'start', projectId: d.pid, resumeSessionId: d.sdk, prompt: `${mA} owner` });
  await sleep(400);
  const b = await attempt(d.srv, d.pid, d.sdk, `B191-P8B-${Date.now()} second tab`);
  const cP = await promptlessReattach(d.srv, d.pid, d.sdk);
  k.check('P8 while a delivery is in flight: a second tab\'s message is refused RETRYABLY and a promptless reattach is told live-elsewhere',
    b.kind === 'retry' && /another tab is delivering/.test(b.message ?? '') && cP.first?.t === 'error' && cP.first.code === 'live-elsewhere',
    { second: { kind: b.kind, message: b.message?.slice(0, 90) }, promptless: cP.first ? { t: cP.first.t, code: cP.first.code ?? null } : null });
  b.c.close(); cP.c.close();
  cA.close(); // the owner disconnects mid-delivery
  await sleep(300);
  const b2 = await attempt(d.srv, d.pid, d.sdk, `B191-P8C-${Date.now()} after the owner left`);
  k.check('P8 the owner disconnecting does NOT release the reservation while its delivery is still in flight', b2.kind === 'retry' && /another tab is delivering/.test(b2.message ?? ''), { kind: b2.kind, message: b2.message?.slice(0, 90) });
  b2.c.close();
  sigcont(d.hostPid);
  await sleep(7_000); // the owner's delivery settles (its answer reaches a closed socket)
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === false ? true : null), 8_000);
  const cQ = await promptlessReattach(d.srv, d.pid, d.sdk);
  k.check('P8 …and it IS released once that delivery settles (a promptless reattach is acked again); the owner\'s message landed once',
    cQ.first?.t === 'ack' && deliveries(d.w, mA).length === 1, { reattach: cQ.first?.t ?? null, ownerDeliveries: deliveries(d.w, mA).length });
  cQ.c.close();
  fakeCmd(d.w, d.cli, { op: 'lane_end', id: 'LD' });
  return k.results;
}

async function armP9() {
  const k = makeChecker('P9');
  const d = await seedDeclining('p9');
  const x = await settledAdopt(d.srv, d.station);
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === false ? true : null), 5_000);
  const marker = `B191-P9-${Date.now()}`;
  const a = await attempt(d.srv, d.pid, d.sdk, `${marker} delivered through the broker's acceptance`);
  await sleep(1_500);
  const got = deliveries(d.w, marker);
  k.check('P9 a gate-passing responder-only reattach is acked ONLY after the broker accepted: promptDelivered:true, busy:true; delivered exactly once',
    x?.adoptState === 'responder-only' && a.kind === 'acked' && a.ack?.promptDelivered === true && a.ack?.busy === true && got.length === 1,
    { adoptState: x?.adoptState ?? null, kind: a.kind, promptDelivered: a.ack?.promptDelivered ?? null, busy: a.ack?.busy ?? null, deliveries: got.length });
  a.c.close();
  fakeCmd(d.w, d.cli, { op: 'lane_end', id: 'LD' });
  return k.results;
}

/* ------------------------------------------------------------------ browser */
let BROWSER = null;
async function browser() {
  if (BROWSER) return BROWSER;
  const { chromium } = await import('playwright');
  BROWSER = await chromium.launch({ headless: true, executablePath: `${process.env.HOME}/.local/bin/brave`, args: ['--no-sandbox'] });
  return BROWSER;
}
// The broken variant's screenshots are not evidence of the fix — keep them out of docs/bugs/assets.
const SHOTS = BROKEN ? path.join(TREE, 'shots') : path.join(ROOT, 'docs', 'bugs', 'assets');
async function openPage(port, pid, w, sdk) {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    window.__b191 = { sockets: [], closeNextStartMatching: null };
    window.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        const rec = { ws: this, sent: [] };
        window.__b191.sockets.push(rec);
        const send = this.send.bind(this);
        this.send = (d) => {
          rec.sent.push(String(d));
          const r = send(d);
          const m = window.__b191.closeNextStartMatching;
          if (m && String(d).includes('"type":"start"') && String(d).includes(m)) { window.__b191.closeNextStartMatching = null; setTimeout(() => this.close(), 0); }
          return r;
        };
      }
    };
  });
  const enc = w.work.replace(/[^a-zA-Z0-9]/g, '-');
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(pid)}/session/${encodeURIComponent(sdk)}?dir=${encodeURIComponent(enc)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prompt', { timeout: 15_000 });
  await sleep(1_500);
  return page;
}
const dockText = (page) => page.evaluate(() => document.querySelector('#queueBox')?.textContent ?? '');
const bubblesWith = (page, m) => page.evaluate((mm) => [...document.querySelectorAll('.you')].filter((b) => (b.textContent ?? '').includes(mm)).length, m);

async function armB1() {
  const k = makeChecker('B1');
  fs.mkdirSync(SHOTS, { recursive: true });
  const { w, port, pid, s, sdk } = await seedAdoptable('b1', { reinitMs: 12_000 });
  writeSyntheticTranscript(w, sdk, ['earlier: set up the scraper', 'earlier: fix the pagination', 'earlier: add retries', 'earlier: write the summary']);
  writeSyntheticTranscript(w, `other-${Date.now()}`, ['an unrelated older session in the same project']);
  const srv = await bootServer(w, {}, { port });
  const pend = await waitFor(async () => { const x = await liveSession(srv, s.station); return x?.adoptState === 'pending' ? x : null; }, 10_000, 100);
  const page = await openPage(port, pid, w, sdk);
  const marker = `B191-B1-${Date.now()}`;
  await page.fill('#prompt', `${marker} typed while the session re-attaches`);
  await page.press('#prompt', 'Enter');
  const queued = await waitFor(async () => { const t = await dockText(page); return t.includes(marker) ? t : null; }, 10_000, 250);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b1-queued-while-reattaching.png') });
  const bubbleEarly = await bubblesWith(page, marker);
  const stillPending = (await liveSession(srv, s.station))?.adoptState === 'pending';
  k.check('B1.1 inside the pending window the typed text becomes a VISIBLE queue row naming the re-attach (not a bubble claiming delivery)',
    !!pend && stillPending && !!queued && /re-attach/.test(queued) && bubbleEarly === 0, { pending: !!pend, stillPending, dock: queued?.slice(0, 300) ?? null, deliveredBubbles: bubbleEarly });
  const got = await waitFor(() => (deliveries(w, marker).length >= 1 ? true : null), 45_000, 500);
  await sleep(4_000);
  const final = deliveries(w, marker);
  const rowLeft = (await dockText(page)).includes(marker);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b1-delivered-after-adoption.png') });
  k.check('B1.2 once the adoption completes the message reaches the CLI EXACTLY ONCE and its queue row retires', !!got && final.length === 1 && !rowLeft,
    { deliveries: final.length, rowStillQueued: rowLeft, adoptState: (await liveSession(srv, s.station))?.adoptState ?? null });
  await page.close();
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'L191' });
  return k.results;
}

async function armB2() {
  const k = makeChecker('B2');
  fs.mkdirSync(SHOTS, { recursive: true });
  const d = await seedDeclining('b2');
  const x = await settledAdopt(d.srv, d.station);
  fakeCmd(d.w, d.cli, { op: 'mid_turn_open' }); // a turn in flight: the tab queues typed text locally
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === true ? true : null), 5_000);
  const page = await openPage(d.port, d.pid, d.w, d.sdk);
  // the page re-takes the driving socket (promptless reattach) — wait for it
  await waitFor(async () => (await page.evaluate(() => window.__b191.sockets.some((s) => s.sent.some((m) => m.includes('"type":"start"'))))) ? true : null, 15_000, 250);
  await sleep(1_500);
  const m1 = `B191-B2-one-${Date.now()}`;
  const m2 = `B191-B2-two-${Date.now()}`;
  await page.fill('#prompt', `${m1} first queued`); await page.press('#prompt', 'Enter');
  await sleep(300);
  await page.fill('#prompt', `${m2} second queued`); await page.press('#prompt', 'Enter');
  await sleep(800);
  const queuedBefore = await dockText(page);
  // The lane ends, then the turn: the gate now refuses (lifetime no) — the boundary flush is refused.
  fakeCmd(d.w, d.cli, { op: 'lane_end', id: 'LD' });
  await sleep(700);
  fakeCmd(d.w, d.cli, { op: 'result' });
  const sentSend = await waitFor(async () => (await page.evaluate(() => window.__b191.sockets.flatMap((s) => s.sent).find((m) => m.includes('"type":"send"')) ?? null)), 10_000, 200);
  const dock = await waitFor(async () => { const t = await dockText(page); return t.includes(m1) && t.includes(m2) && /waiting/.test(t) ? t : null; }, 10_000, 250);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b2-batch-refused-recovered.png') });
  const order = dock ? dock.indexOf(m1) < dock.indexOf(m2) : false;
  const bubbles = (await bubblesWith(page, m1)) + (await bubblesWith(page, m2));
  k.check('B2 PRECONDITION: responder-only; the tab held both rows during the turn and flushed them as one `send` (with a sendId) at the boundary',
    x?.adoptState === 'responder-only' && queuedBefore.includes(m1) && queuedBefore.includes(m2) && !!sentSend && /"sendId":"s-/.test(sentSend ?? ''),
    { adoptState: x?.adoptState ?? null, queuedBefore: queuedBefore.includes(m1) && queuedBefore.includes(m2), send: (sentSend ?? '').slice(0, 80) });
  k.check('B2 the refused batch comes back as BOTH rows, in their original order, as waiting rows — its bubble gone, nothing delivered',
    !!dock && order && bubbles === 0 && deliveries(d.w, m1).length === 0 && deliveries(d.w, m2).length === 0,
    { dock: (dock ?? (await dockText(page))).slice(0, 400), inOrder: order, bubbles, delivered: deliveries(d.w, m1).length + deliveries(d.w, m2).length });
  await page.close();
  return k.results;
}

async function armB3() {
  const k = makeChecker('B3');
  fs.mkdirSync(SHOTS, { recursive: true });
  const d = await seedDeclining('b3', { reinitMs: 9_000 });
  const pend = await waitFor(async () => { const x = await liveSession(d.srv, d.station); return x?.adoptState === 'pending' ? x : null; }, 10_000, 100);
  const page = await openPage(d.port, d.pid, d.w, d.sdk);
  const marker = `B191-B3-${Date.now()}`;
  await page.fill('#prompt', `${marker} its ack will be lost`);
  await page.press('#prompt', 'Enter');
  const queued = await waitFor(async () => ((await dockText(page)).includes(marker) ? true : null), 10_000, 250);
  const x = await settledAdopt(d.srv, d.station, 30_000);
  await waitFor(() => (readJson(d.b.statusPath)?.midTurn === false ? true : null), 8_000);
  // The next retry's socket is cut the instant its `start` leaves: the server delivers, the ack goes nowhere.
  await page.evaluate((m) => { window.__b191.closeNextStartMatching = m; }, marker);
  const got = await waitFor(() => (deliveries(d.w, marker).length >= 1 ? true : null), 40_000, 500);
  const dead = await waitFor(async () => { const t = await dockText(page); return /never confirmed|check the transcript/.test(t) && t.includes(marker) ? t : null; }, 25_000, 500);
  await sleep(12_000); // two retry periods: nothing may resend it
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b3-lost-ack-kept-dead.png') });
  const starts = await page.evaluate((m) => window.__b191.sockets.flatMap((s) => s.sent).filter((s) => s.includes('"type":"start"') && s.includes(m)).length, marker);
  k.check('B3 PRECONDITION: queued during the pending adoption; the adoption settles responder-only (broker still takes input)', !!pend && !!queued && x?.adoptState === 'responder-only', { pending: !!pend, queued: !!queued, adoptState: x?.adoptState ?? null });
  k.check('B3 a retry whose ack was lost with its socket ends DEAD ("never confirmed"), is never resent, and the CLI has it EXACTLY ONCE',
    !!got && !!dead && deliveries(d.w, marker).length === 1,
    { deliveries: deliveries(d.w, marker).length, deadRow: !!dead, startsSent: starts, dock: (await dockText(page)).slice(0, 300) });
  await page.close();
  fakeCmd(d.w, d.cli, { op: 'lane_end', id: 'LD' });
  return k.results;
}

/**
 * B4 (round 2, lead B5) — brave, the real click path: a session held by an OLD
 * broker that settled `adopted`. Enter → a visible waiting row naming the older
 * host (no bubble claiming delivery) → the old host retires once its lane and
 * turn end → the row resumes the session on a fresh CLI, exactly once, and retires.
 */
async function armB4() {
  const k = makeChecker('B4');
  fs.mkdirSync(SHOTS, { recursive: true });
  const w = world('b4');
  const srv0 = await bootServer(w);
  const port = srv0.port;
  const pid = await registerProject(srv0, w);
  await stopServer(srv0);
  const station = 'b191-b4-old';
  const { st, sdk } = await spawnOld(w, station, w.work, { CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500', CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '1000', CLAUDE_STATION_HOST_DRAIN_TERM_MS: '30000' });
  writeSyntheticTranscript(w, sdk, ['earlier: set up the scraper', 'earlier: fix the pagination', 'earlier: add retries', 'earlier: write the summary']);
  writeSyntheticTranscript(w, `other-${Date.now()}`, ['an unrelated older session in the same project']);
  const srv = await bootServer(w, {}, { port });
  const x = await settledAdopt(srv, station);
  const page = await openPage(port, pid, w, sdk);
  const marker = `B191-B4-${Date.now()}`;
  await page.fill('#prompt', `${marker} typed to a session an older host holds`);
  await page.press('#prompt', 'Enter');
  const queued = await waitFor(async () => { const t = await dockText(page); return t.includes(marker) ? t : null; }, 15_000, 250);
  await sleep(1_000);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b4-old-host-queued.png') });
  const bubbleEarly = await bubblesWith(page, marker);
  k.check('B4.1 an `adopted` OLD broker: the typed text becomes a VISIBLE waiting row naming the older host (no bubble claiming delivery), nothing written',
    x?.adoptState === 'adopted' && !!queued && /older session host/.test(queued) && bubbleEarly === 0 && deliveries(w, marker).length === 0,
    { adoptState: x?.adoptState ?? null, dock: queued?.slice(0, 300) ?? null, deliveredBubbles: bubbleEarly, deliveries: deliveries(w, marker).length });
  fakeCmd(w, st.claudePid, { op: 'lane_end', id: `L-${station}` });
  fakeCmd(w, st.claudePid, { op: 'result' });
  const got = await waitFor(() => (deliveries(w, marker).length >= 1 ? true : null), 90_000, 500);
  await sleep(4_000);
  const final = deliveries(w, marker);
  const rowLeft = (await dockText(page)).includes(marker);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-191-b4-old-host-resumed.png') });
  k.check('B4.2 the user is not stuck: the old host retires, the row resumes the session on a FRESH CLI exactly once, and the row retires',
    !!got && final.length === 1 && final[0].pid !== st.claudePid && !rowLeft && !pidAlive(st.claudePid),
    { deliveries: final, oldCli: st.claudePid, oldCliAlive: pidAlive(st.claudePid), rowStillQueued: rowLeft });
  await page.close();
  return k.results;
}

const ARM_FNS = { P1: armP1, P2: armP2, P3: armP3, P4: armP4, P5: armP5, P6: armP6, P7: armP7, P8: armP8, P9: armP9, P10: armP10, B1: armB1, B2: armB2, B3: armB3, B4: armB4 };
const all = [];
try {
  for (const a of ARMS) {
    const fn = ARM_FNS[a];
    if (!fn) { console.log(`unknown arm ${a}`); all.push({ arm: a, name: 'unknown arm', ok: false }); continue; }
    console.log(`\n== ${a}`);
    try { all.push(...await fn()); } catch (e) { console.log(`  FAIL  [${a}] arm crashed: ${e?.stack ?? e}`); all.push({ arm: a, name: 'arm crashed', ok: false }); }
  }
} finally {
  for (const pid of [...stopped]) sigcont(pid);
  if (BROWSER) { try { await BROWSER.close(); } catch { /* gone */ } }
  for (const w of worlds) await cleanupWorld(w, { keep: KEEP });
  if (PINNED) { try { PINNED.cleanup(); } catch { /* ignore */ } }
  if (BROKEN && !KEEP) { try { fs.rmSync(TREE, { recursive: true, force: true }); } catch { /* ignore */ } }
}
const pass = all.filter((r) => r.ok).length;
console.log(`\nBUG-191${BROKEN ? ' [BROKEN VARIANT]' : ''}: ${pass}/${all.length} passed`);
process.exit(pass === all.length && all.length > 0 ? 0 : 1);
