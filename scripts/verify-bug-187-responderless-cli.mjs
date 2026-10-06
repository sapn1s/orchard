#!/usr/bin/env node
/**
 * BUG-187 — a background agent looped for hours with every tool call failing:
 * its CLI was held alive by a broker with NOBODY attached to answer its control
 * requests. This verifier is the proof bar of the round-3 build spec
 * (docs/bugs/BUG-187-…md, "BUG-187 build spec (round 3)" — the arm table).
 *
 *   node scripts/verify-bug-187-responderless-cli.mjs [--arms=A1,A3,…] [--tree=<dir>] [--pinned=541dd73] [--real] [--keep]
 *
 *   --arms     which arms to run (default: every fake-CLI arm; add --real for the
 *              real-CLI arms A2, A4r, A8, A9, A11, A12, A17)
 *   --pinned   run the arms against a COMPLETE tree materialised at that named
 *              commit (scripts/lib/pinned-tree.mjs) — the must-FAIL baseline.
 *              A HEAD-FAIL arm must fail on its named BEHAVIOURAL assertion there.
 *   --tree     run against an already-materialised tree
 *
 * Every server is isolated (free port, scratch data dir + store), every process
 * is killed by pid, and :4317 / the live service / foreign scopes are never
 * touched (scripts/lib/bug-187-harness.mjs).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import {
  ROOT, FAKE_CLI, REAL_CLI, sleep, pidAlive, makeChecker, makeWorld, bootServer, stopServer, registerProject, openWs,
  waitFor, waitEv, hostFor, hostRecords, hostsDir, fakeCmd, fakeLog, fakeTap, startFakeSession, health, cleanupWorld,
  spawnBrokerDirect, rawClient, readJson, writeSyntheticTranscript,
} from './lib/bug-187-harness.mjs';
import { materialisePinnedTree } from './lib/pinned-tree.mjs';
import { isolatedStoreEnv } from './lib/station-boot.mjs';

const ARGV = process.argv.slice(2);
const arg = (k) => { const a = ARGV.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const flag = (k) => ARGV.includes(`--${k}`);
const KEEP = flag('keep');
const REAL = flag('real');
const FAKE_ARMS = ['FLOOR', 'LEDGER', 'A18', 'A19', 'A20', 'A9r', 'A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A9b', 'A9c', 'A10', 'A13', 'A14', 'A15', 'A16'];
const REAL_ARMS = ['A17', 'A2', 'A11', 'A8', 'A9', 'A12']; // A4r rides inside A2
const ARMS = (arg('arms') ? arg('arms').split(',') : [...FAKE_ARMS, ...(REAL ? REAL_ARMS : [])]).map((s) => s.trim()).filter(Boolean);

let TREE = arg('tree') ? path.resolve(arg('tree')) : ROOT;
let pinned = null;
if (arg('pinned')) { pinned = materialisePinnedTree(arg('pinned')); TREE = pinned.dir; }
const ON_PINNED = TREE !== ROOT;
console.log(`BUG-187 verifier — tree: ${ON_PINNED ? `${TREE} (pinned ${pinned?.rev ?? 'given'})` : `${ROOT} (working tree)`}; arms: ${ARMS.join(',')}`);

const all = [];
const worlds = [];
function world(name, opts = {}) { const w = makeWorld(name, { tree: TREE, ...opts }); worlds.push(w); return w; }
const answersFor = (w, pid, lane) => fakeLog(w, pid).filter((e) => e.ev === 'answer' && (lane === undefined || e.lane === lane));
const requestsFor = (w, pid, lane) => fakeLog(w, pid).filter((e) => e.ev === 'request' && (lane === undefined || e.lane === lane));
const REFUSAL = 'Orchard is not attached';

/* ============================================================================
 * A1 — THE INCIDENT, keep-responder. Revive a finished lane, detach, let the
 * bridge's revival TTL expire, then deliver a level that lists ONLY the vetoed
 * (revived) id — the bridge's filtered level empties, and pre-fix its fuse
 * closed the session, taking the only responder away while the broker (whose
 * raw level still says `yes`) held the CLI forever.
 * Must pass: the session is not closed; every hook of the lane is answered BY
 * THE SERVER; the lane completes and the session then closes cleanly.
 * HEAD-FAIL: closed, and the lane's first request unanswered at 30 s.
 * ========================================================================== */
async function armA1() {
  const k = makeChecker('A1');
  const w = world('a1');
  const srv = await bootServer(w, { CLAUDE_STATION_REVIVED_TTL_MS: '3000' });
  const pid = await registerProject(srv, w);
  const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] start a background lane');
  await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  await sleep(600);
  fakeCmd(w, s.cli, { op: 'revive', id: 'LA', withLevel: true }); // the incident's revival: re-listed in the level
  await sleep(600);
  s.c.close(); // the tab closes: detach (the revival makes the bridge's lifetime `unknown`)
  await sleep(4_000); // > REVIVED_TTL (3 s): the bridge's revival evidence has expired
  fakeCmd(w, s.cli, { op: 'lane_start', id: 'LB' });
  await sleep(400);
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'LB' }); // level → [LA] only; LA is vetoed on the bridge → filtered level empty
  await sleep(3_500); // the fuse's 3 s fire
  fakeCmd(w, s.cli, { op: 'loop', lane: 'LA', everyMs: 1000, count: 8 });
  const firstReq = await waitFor(() => requestsFor(w, s.cli, 'LA')[0], 10_000);
  const firstAns = await waitFor(() => answersFor(w, s.cli, 'LA')[0], ON_PINNED ? 30_000 : 10_000);
  const h = await health(srv);
  const live = (h?.sessions ?? []).find((x) => x.stationSessionId === s.station && x.adopted === true);
  k.check('A1.1 the detached session is NOT closed when the bridge\'s filtered level empties (the broker says the revived lane is live)',
    !!live, { liveBridge: !!live, sessions: (h?.sessions ?? []).map((x) => ({ id: x.stationSessionId, adopted: x.adopted, state: x.state })) });
  await waitFor(() => answersFor(w, s.cli, 'LA').length >= 6 || null, 20_000);
  const ans = answersFor(w, s.cli, 'LA');
  const byServer = ans.filter((a) => a.verdict === 'allow' && a.latencyMs < 5000);
  k.check('A1.2 every hook request of the revived lane is answered BY THE SERVER (allow, < 5 s) — none refused, none left unanswered',
    !!firstReq && !!firstAns && ans.length >= 6 && byServer.length === ans.length,
    { requests: requestsFor(w, s.cli, 'LA').length, answers: ans.map((a) => `${a.verdict}@${a.latencyMs}ms`), firstAnswerAfterMs: firstAns && firstReq ? firstAns.at - firstReq.at : 'UNANSWERED' });
  // The lane finishes (count reached → lane_end). Then nothing outlives the turn: the session closes and the broker exits.
  const gone = await waitFor(() => { const hh = hostFor(w, s.station); return !hh || (!pidAlive(hh.hostPid) && !pidAlive(hh.claudePid)) ? true : null; }, 45_000);
  k.check('A1.3 the lane completes, and only THEN does the session close (the broker drains and exits)',
    !!gone && answersFor(w, s.cli, 'LA').length >= 8, { brokerGone: !!gone, answered: answersFor(w, s.cli, 'LA').length });
  if (ON_PINNED) k.note(`pinned diagnostic: first LA request ${firstReq ? 'emitted' : 'never emitted'}; answered: ${firstAns ? `after ${firstAns.at - firstReq.at} ms` : 'NO (waited 30 s)'}; broker record: ${JSON.stringify(hostFor(w, s.station) && { state: hostFor(w, s.station).state, lifetime: hostFor(w, s.station).backgroundLifetime })}`);
  return k.results;
}


/* ---------------------------------------------------------------- helpers */
const liveSession = async (srv, station) => ((await health(srv))?.sessions ?? []).find((x) => x.stationSessionId === station && x.adopted === true) ?? null;
const brokerState = (w, station) => { const h = hostFor(w, station); return h ? { state: h.state, lifetime: h.backgroundLifetime, cli: pidAlive(h.claudePid), broker: pidAlive(h.hostPid), drainHeldSince: h.drainHeldSince ?? null, responder: h.responder ?? null, refusals: h.refusals ?? null } : null; };
const userFramesAfter = (w, cli, t) => fakeTap(w, cli).filter((x) => x.at >= t && x.m?.type === 'user');
const initsOf = (w, cli) => fakeLog(w, cli).filter((e) => e.ev === 'initialize');
let PINNED_FOR_OLD = null;
function oldBrokerScript() {
  if (ON_PINNED) return path.join(TREE, 'src', 'server', 'session-host.mjs');
  if (!PINNED_FOR_OLD) PINNED_FOR_OLD = materialisePinnedTree('541dd73', { prefix: 'b187-oldbroker-' });
  return path.join(PINNED_FOR_OLD.dir, 'src', 'server', 'session-host.mjs');
}
const THIS_HOST = () => path.join(TREE, 'src', 'server', 'session-host.mjs');
async function importFromTree(rel) { return import(path.join(TREE, rel)); }
function treeHas(rel, needle) { try { return fs.readFileSync(path.join(TREE, rel), 'utf8').includes(needle); } catch { return false; } }

/* ============================================================================
 * A3 — LIFETIME EVIDENCE GAPS. Each must detach or hold, never close/reap.
 * HEAD-FAIL: (a), (c), (e).
 * ========================================================================== */
async function armA3() {
  const k = makeChecker('A3');
  const TTL = { CLAUDE_STATION_REVIVED_TTL_MS: '3000' };
  // (a) a task_started revival with NO level frame
  {
    const w = world('a3a');
    const srv = await bootServer(w, TTL);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] go');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
    await sleep(600);
    fakeCmd(w, s.cli, { op: 'revive', id: 'LA' }); // task_started only — the level is not touched
    await sleep(600);
    s.c.close();
    await sleep(4_000);
    fakeCmd(w, s.cli, { op: 'lane_start', id: 'LB' });
    await sleep(300);
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LB' }); // an empty level nudges the fuse
    await sleep(5_000);
    const live = await liveSession(srv, s.station);
    const b = brokerState(w, s.station);
    k.check('A3(a) a revival with no level frame: the session is neither closed nor reaped (the broker counts the started lane as live)',
      !!live && !!b && b.state !== 'draining' && b.cli, { live: !!live, broker: b });
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  // (b) a background dispatch in the middle of an open turn is published at once
  {
    const w = world('a3b');
    const srv = await bootServer(w, TTL);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, 'plain turn');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'mid_turn_open' });
    await sleep(500);
    const before = hostFor(w, s.station)?.seq ?? null;
    fakeCmd(w, s.cli, { op: 'emit', frame: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-bg', name: 'Agent', input: { run_in_background: true, prompt: 'x' } }] } } });
    const published = await waitFor(() => (hostFor(w, s.station)?.backgroundLifetime === 'unknown' ? true : null), 1_500);
    fakeCmd(w, s.cli, { op: 'result' });
    await sleep(300);
    s.c.close();
    await sleep(5_000);
    const live = await liveSession(srv, s.station);
    k.check('A3(b) a dispatch mid-open-turn is published to the broker record at once (lifetime unknown within 1.5 s, before the turn ends)',
      !!published, { published: !!published, seqBefore: before });
    k.check('A3(b) …and the session detaches rather than closing', !!live && !!hostFor(w, s.station), { live: !!live, broker: brokerState(w, s.station) });
  }
  // (c) the hosts dir is read-only, so a stale `no` record persists while the lane is live
  {
    const w = world('a3c');
    const srv = await bootServer(w, TTL);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] go');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
    await waitFor(() => (hostFor(w, s.station)?.backgroundLifetime === 'no' ? true : null), 5_000);
    fs.chmodSync(hostsDir(w), 0o500);
    try {
      fakeCmd(w, s.cli, { op: 'revive', id: 'LA' });
      await sleep(600);
      s.c.close();
      await sleep(4_000);
      fakeCmd(w, s.cli, { op: 'lane_start', id: 'LB' });
      await sleep(300);
      fakeCmd(w, s.cli, { op: 'lane_end', id: 'LB' });
      await sleep(5_000);
      const rec = hostFor(w, s.station);
      const live = await liveSession(srv, s.station);
      k.check('A3(c) a READABLE-but-stale `no` record (writes failing) does not close the session while the lane is live',
        !!live && rec?.backgroundLifetime === 'no' && pidAlive(rec?.claudePid), { live: !!live, staleRecordSays: rec?.backgroundLifetime, cliAlive: pidAlive(rec?.claudePid) });
    } finally {
      fs.chmodSync(hostsDir(w), 0o700);
    }
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  // (d) unreadable / missing / old-format records never read as `no`
  if (treeHas('src/server/survival.ts', 'brokerLifetimeForClose')) {
    const { brokerLifetimeForClose } = await importFromTree('src/server/survival.ts');
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'b187-a3d-'));
    const f = path.join(dir, 's.json');
    const oldHandle = { statusPath: f, broker: { hello: Promise.resolve(null), lifetimeQuery: async () => null } };
    const now = Date.now();
    const cases = [];
    const run = async (label, content, bridge, expect) => {
      if (content === null) { try { fs.rmSync(f); } catch { /* none */ } } else fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
      const r = await brokerLifetimeForClose(oldHandle, bridge, 300);
      cases.push({ label, got: r.lifetime, expect, ok: r.lifetime === expect });
    };
    await run('missing', null, { lastFrameAt: now, levelRawEmpty: true }, 'unknown');
    await run('garbage', '{not json', { lastFrameAt: now, levelRawEmpty: true }, 'unknown');
    await run('old format (no lifetime field)', { hostPid: 1, state: 'running', updatedAt: new Date(now + 5000).toISOString() }, { lastFrameAt: now, levelRawEmpty: true }, 'unknown');
    await run('`no` older than the last frame', { backgroundLifetime: 'no', updatedAt: new Date(now - 60_000).toISOString() }, { lastFrameAt: now, levelRawEmpty: true }, 'unknown');
    await run('`no`, fresh, but the unfiltered level is not empty', { backgroundLifetime: 'no', updatedAt: new Date(now + 5000).toISOString() }, { lastFrameAt: now, levelRawEmpty: false }, 'unknown');
    await run('NON-VACUITY: `no`, fresh, empty level', { backgroundLifetime: 'no', updatedAt: new Date(now + 5000).toISOString() }, { lastFrameAt: now, levelRawEmpty: true }, 'no');
    const p2 = { statusPath: f, broker: { hello: Promise.resolve({ accepted: true, protocol: 2 }), lifetimeQuery: async () => null } };
    const r2 = await brokerLifetimeForClose(p2, { lastFrameAt: now, levelRawEmpty: true }, 300);
    cases.push({ label: 'protocol 2, lifetime query unanswered', got: r2.lifetime, expect: 'unknown', ok: r2.lifetime === 'unknown' });
    fs.rmSync(dir, { recursive: true, force: true });
    k.check('A3(d) missing / unreadable / old-format / stale / unanswered evidence is `unknown` — never `no` (and a corroborated `no` is still `no`)',
      cases.every((c) => c.ok), cases);
  } else {
    k.note('A3(d) n/a on this tree (no brokerLifetimeForClose — the pre-fix bridge never consulted the broker)');
  }
  // (e) detach after the revival TTL expired, then a restart
  {
    const w = world('a3e');
    const srv = await bootServer(w, TTL);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] go');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
    await sleep(600);
    fakeCmd(w, s.cli, { op: 'revive', id: 'LA', withLevel: true });
    await sleep(300);
    s.c.close();
    await sleep(4_500); // TTL expired; the fuse's next check is ~30 s away
    await stopServer(srv); // the shutdown handoff decides
    const afterStop = brokerState(w, s.station);
    const srv2 = await bootServer(w, TTL);
    await sleep(4_000);
    fakeCmd(w, s.cli, { op: 'loop', lane: 'LA', everyMs: 700, count: 4 });
    const ans = await waitFor(() => (answersFor(w, s.cli, 'LA').length >= 4 ? answersFor(w, s.cli, 'LA') : null), ON_PINNED ? 12_000 : 20_000);
    const live2 = await liveSession(srv2, s.station);
    k.check('A3(e) detach-after-TTL then restart: the shutdown hands the session off (not reaped) and the new server re-attaches',
      afterStop && afterStop.state !== 'draining' && !!live2, { brokerAfterShutdown: afterStop, liveOnNewServer: live2 ? live2.adoptState : null });
    k.check('A3(e) …and the lane\'s tool calls are then answered by the NEW server',
      !!ans && ans.every((a) => a.verdict === 'allow'), { answers: (ans ?? answersFor(w, s.cli, 'LA')).map((a) => `${a.verdict}@${a.latencyMs}ms`) });
  }
  // (f) closeAllSessions: a session with a live lane is handed off; an idle one closes
  {
    const w = world('a3f');
    const srv = await bootServer(w, TTL);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] go');
    const idle = await startFakeSession(srv, w, pid, 'idle turn');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    await waitEv(idle.c, (e) => e.t === 'turn-end', 20_000);
    await stopServer(srv);
    await sleep(1_500);
    const lane = brokerState(w, s.station);
    const idleGone = await waitFor(() => { const h = hostFor(w, idle.station); return !h || !pidAlive(h.hostPid) ? true : null; }, 10_000);
    k.check('A3(f) shutdown: the session with a live lane is handed off (broker running, not draining), the idle session is closed',
      !!lane && lane.state !== 'draining' && lane.cli && !!idleGone, { laneBroker: lane, idleClosed: !!idleGone });
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  return k.results;
}

/* ============================================================================
 * A4 — ATTACH-ONLY: adoption sends ZERO user frames and seeds busy from the
 * broker. Adopt an idle CLI and one in the middle of a foreground turn.
 * ========================================================================== */
async function armA4() {
  const k = makeChecker('A4');
  const w = world('a4');
  const srv = await bootServer(w);
  const pid = await registerProject(srv, w);
  const idle = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] idle one');
  const mid = await startFakeSession(srv, w, pid, 'mid-turn one');
  await waitEv(idle.c, (e) => e.t === 'turn-end', 20_000);
  await waitEv(mid.c, (e) => e.t === 'turn-end', 20_000);
  fakeCmd(w, mid.cli, { op: 'mid_turn_open' }); // a foreground turn in flight, no result
  await sleep(800);
  idle.c.close(); mid.c.close();
  await sleep(500);
  await stopServer(srv);
  const t0 = Date.now();
  const srv2 = await bootServer(w);
  const settled = await waitFor(async () => {
    const a = await liveSession(srv2, idle.station); const b = await liveSession(srv2, mid.station);
    return a && b && a.adoptState !== 'pending' && b.adoptState !== 'pending' ? { a, b } : null;
  }, 20_000);
  await sleep(1_500);
  const uIdle = userFramesAfter(w, idle.cli, t0);
  const uMid = userFramesAfter(w, mid.cli, t0);
  k.check('A4.1 adopting an IDLE CLI writes zero user frames to its stdin (no briefing, no first prompt)',
    !!settled && uIdle.length === 0 && initsOf(w, idle.cli).length >= 2, { adoptState: settled?.a?.adoptState ?? null, userFrames: uIdle.length, initializes: initsOf(w, idle.cli).length });
  k.check('A4.2 adopting a CLI MID-FOREGROUND-TURN writes zero user frames, and busy matches the broker (true)',
    !!settled && uMid.length === 0 && settled.b.busy === true, { adoptState: settled?.b?.adoptState ?? null, busy: settled?.b?.busy, userFrames: uMid.length });
  fakeCmd(w, mid.cli, { op: 'result' });
  const idleAfter = await waitFor(async () => { const b = await liveSession(srv2, mid.station); return b && b.busy === false ? b : null; }, 5_000);
  k.check('A4.3 …and that turn\'s own result clears busy on the adopted session', !!idleAfter, { busyAfterResult: idleAfter?.busy ?? 'still busy / gone' });
  fakeCmd(w, idle.cli, { op: 'lane_end', id: 'LA' });
  return k.results;
}

/* ============================================================================
 * A5 — DRAIN RECLAIM. A protocol-2 broker already draining (held for a live
 * lane / waiting on a turn's result) is reclaimed by its adopter: no EOF, no
 * signal over 3 × DRAIN_TERM. A broker whose stdin already ended cannot be
 * reclaimed: `reclaim ok:false`, and the session is responder-only until exit.
 * HEAD-FAIL: an armed drain + an attached responder + idle ⇒ EOF.
 * ========================================================================== */
async function armA5() {
  const k = makeChecker('A5');
  const KN = {
    CLAUDE_STATION_HOST_DRAIN_TERM_MS: '2000', CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000', CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500',
    CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '1000', CLAUDE_STATION_HOST_REAP_RESULT_WAIT_MS: '1500',
  };
  const reattach = async (srv, sdkId, projectId) => { const c = await openWs(srv); c.send({ type: 'start', resumeSessionId: sdkId, projectId }); await waitEv(c, (e) => (e.t === 'ack' && e.of === 'start') || e.t === 'error', 8_000); return c; };
  const eofOf = (w, cli) => fakeLog(w, cli).find((e) => e.ev === 'stdin-eof') ?? null;
  // drainHeld
  {
    const w = world('a5held');
    const srv = await bootServer(w, KN);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] held');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    await stopServer(srv);
    const h = hostFor(w, s.station);
    try { process.kill(h.hostPid, 'SIGTERM'); } catch { /* gone */ } // an old decision: drain
    const held = await waitFor(() => (hostFor(w, s.station)?.drainHeldSince ? hostFor(w, s.station) : null), 5_000);
    const srv2 = await bootServer(w, KN);
    const adopted = await waitFor(async () => { const x = await liveSession(srv2, s.station); return x && x.adoptState !== 'pending' ? x : null; }, 15_000);
    const rec = hostFor(w, s.station);
    const tab = await reattach(srv2, h.sdkSessionId, pid);
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' }); // the held drain would commit now
    await sleep(6_500); // 3 × DRAIN_TERM
    const eof = eofOf(w, s.cli);
    k.check('A5.1 drain HELD for a live lane, then adopted: the broker is reclaimed (running, no held drain) and the lane\'s end does not EOF the CLI over 3 × DRAIN_TERM',
      !!held && !!adopted && adopted.adoptState === 'adopted' && rec?.state === 'running' && !eof && pidAlive(h.claudePid),
      { wasHeld: !!held, adoptState: adopted?.adoptState ?? null, brokerAfterAdopt: rec ? { state: rec.state, drainHeldSince: rec.drainHeldSince } : null, eof: eof ? `EOF ${eof.at - (held?.updatedAt ? Date.parse(held.updatedAt) : 0)} ms` : null, cliAlive: pidAlive(h.claudePid) });
    tab.close();
  }
  // reapPending (a turn in flight when the old drain was decided)
  {
    const w = world('a5pending');
    const srv = await bootServer(w, KN);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, 'pending');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'mid_turn_open' });
    await sleep(800);
    s.c.close();
    await stopServer(srv);
    const h = hostFor(w, s.station);
    try { process.kill(h.hostPid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(300);
    const srv2 = await bootServer(w, { ...KN, CLAUDE_STATION_HOST_REAP_RESULT_WAIT_MS: '60000' });
    const adopted = await waitFor(async () => { const x = await liveSession(srv2, s.station); return x && x.adoptState !== 'pending' ? x : null; }, 15_000);
    const tab = await reattach(srv2, h.sdkSessionId, pid);
    fakeCmd(w, s.cli, { op: 'result' }); // pre-fix: the pending reap commits on this result → EOF
    await sleep(6_500);
    const eof = eofOf(w, s.cli);
    k.check('A5.2 reap PENDING on an in-flight turn, then adopted: the turn\'s result does not EOF the CLI over 3 × DRAIN_TERM',
      !!adopted && adopted.adoptState === 'adopted' && !eof && pidAlive(h.claudePid), { adoptState: adopted?.adoptState ?? null, eof: !!eof, cliAlive: pidAlive(h.claudePid) });
    tab.close();
  }
  // stdin already ended (escalation armed): reclaim refused → responder-only until exit
  if (!ON_PINNED) {
    const w = world('a5ended');
    const KE = { ...KN, CLAUDE_STATION_HOST_DRAIN_TERM_MS: '15000', FAKE_EOF_MODE: 'ignore' };
    const srv = await bootServer(w, KE);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, 'ended');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    fakeCmd(w, s.cli, { op: 'mid_turn_open' });
    await sleep(800);
    s.c.close();
    await stopServer(srv);
    const h = hostFor(w, s.station);
    try { process.kill(h.hostPid, 'SIGTERM'); } catch { /* gone */ }
    const ended = await waitFor(() => (hostFor(w, s.station)?.acceptingInput === false ? true : null), 8_000);
    const t0 = Date.now();
    const srv2 = await bootServer(w, KE);
    const adopted = await waitFor(async () => { const x = await liveSession(srv2, s.station); return x && x.adoptState !== 'pending' ? x : null; }, 15_000);
    const gone = await waitFor(() => (!pidAlive(h.claudePid) && !pidAlive(h.hostPid) ? true : null), 30_000);
    k.check('A5.3 a broker whose stdin already ended cannot be reclaimed: the session is responder-only, and the old escalation still ends the CLI',
      !!ended && adopted?.adoptState === 'responder-only' && !!gone, { stdinEnded: !!ended, adoptState: adopted?.adoptState ?? null, exitedAfterMs: gone ? Date.now() - t0 : null });
  }
  return k.results;
}

/* ============================================================================
 * A6 — COMPETING ADOPTERS. The loser never reaps; broker and CLI stay alive;
 * the winner answers.
 * ========================================================================== */
async function armA6() {
  const k = makeChecker('A6');
  // restart twice within 1 s
  {
    const w = world('a6twice');
    const srv = await bootServer(w);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] twice');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    await stopServer(srv);
    const states = new Set();
    const sampler = setInterval(() => { const b = brokerState(w, s.station); states.add(b?.state ?? 'gone'); }, 150);
    const srv2 = await bootServer(w);
    await sleep(700);
    await stopServer(srv2);
    const srv3 = await bootServer(w);
    const won = await waitFor(async () => { const x = await liveSession(srv3, s.station); return x && x.adoptState === 'adopted' ? x : null; }, 15_000);
    fakeCmd(w, s.cli, { op: 'loop', lane: 'LA', everyMs: 500, count: 3 });
    const ans = await waitFor(() => (answersFor(w, s.cli, 'LA').length >= 3 ? answersFor(w, s.cli, 'LA') : null), 15_000);
    clearInterval(sampler);
    k.check('A6.1 restart twice within ~1 s: the broker is never put into a drain (the interrupted adopter did not reap), and the third server adopts',
      !states.has('draining') && !!won && pidAlive(s.host.claudePid), { brokerStatesSeen: [...states], winner: won?.adoptState ?? null });
    k.check('A6.1 …the winner answers the lane', !!ans && ans.every((a) => a.verdict === 'allow'), { answers: (ans ?? []).map((a) => a.verdict) });
  }
  // a FEAT-065-style relay holds the socket while the server adopts
  {
    const w = world('a6relay');
    const srv = await bootServer(w, { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '60000' });
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] relay');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    await stopServer(srv);
    const relay = await rawClient(s.host.sock);
    await sleep(300);
    const srv2 = await bootServer(w);
    await sleep(5_000);
    const live = await liveSession(srv2, s.station);
    const b = brokerState(w, s.station);
    k.check('A6.2 an adopter that loses to a relay holding the socket disposes of itself WITHOUT reaping (broker running, CLI alive)',
      !live && !!b && b.state !== 'draining' && b.cli && /adoption FAILED/.test(srv2.log), { liveOnServer: !!live, broker: b, loggedFailure: /adoption FAILED/.test(srv2.log) });
    fakeCmd(w, s.cli, { op: 'hook', lane: 'LA' });
    const req = await waitFor(() => relay.lines.find((l) => l.m?.type === 'control_request')?.m ?? null, 5_000);
    if (req) relay.write({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: {} } });
    const a = await waitFor(() => answersFor(w, s.cli, 'LA')[0] ?? null, 5_000);
    k.check('A6.2 …and the relay (the winner) is the one answering', !!a && a.verdict === 'allow', { answer: a });
    relay.close();
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  // two servers racing to adopt the same broker
  {
    const w = world('a6race');
    const srv = await bootServer(w);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] race');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    await stopServer(srv);
    // BUG-217 round 7: one data dir has ONE server (a kernel lock taken at boot), so the loser of this race is
    // refused at boot (exit 78) instead of booting as a second adopter. Short wait, so the refusal is prompt.
    const LOCK = { CLAUDE_STATION_DATA_LOCK_WAIT_MS: '1000' };
    const raced = await Promise.allSettled([bootServer(w, LOCK), bootServer(w, LOCK)]);
    const up = raced.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const refused = raced.filter((r) => r.status === 'rejected' && /exited early \(78\)[\s\S]*REFUSING TO START/.test(String(r.reason?.message))).length;
    await sleep(6_000);
    const lives = await Promise.all(up.map((x) => liveSession(x, s.station)));
    const winners = lives.filter((x) => x && x.adoptState === 'adopted').length;
    const bs = brokerState(w, s.station);
    k.check('A6.3 two servers racing on one data dir: exactly one boots (the other is refused, exit 78) and adopts; the broker is never reaped (running, CLI alive)',
      up.length === 1 && refused === 1 && winners === 1 && !!bs && bs.state !== 'draining' && bs.cli, { booted: up.length, refused, adopt: lives.map((x) => x?.adoptState ?? null), broker: bs });
    fakeCmd(w, s.cli, { op: 'hook', lane: 'LA' });
    const ans = await waitFor(() => answersFor(w, s.cli, 'LA')[0] ?? null, 5_000);
    k.check('A6.3 …and the winner answers', !!ans && ans.verdict === 'allow', { answer: ans });
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  return k.results;
}

/* ============================================================================
 * A7 — THE REQUEST LEDGER, at the broker (raw clients, fake CLI, this tree's
 * broker). Grace knobs are shrunk: hook 1.5 s, permission 2.5 s.
 * ========================================================================== */
async function armA7() {
  const k = makeChecker('A7');
  const w = world('a7');
  const HG = 1500, PG = 2500;
  const b = spawnBrokerDirect(w, {
    hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a7',
    env: { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: String(HG), CLAUDE_STATION_FLOOR_PERMISSION_GRACE_MS: String(PG), CLAUDE_STATION_LANE_BLOCK_MS: '0', CLAUDE_STATION_HOST_ABANDON_MS: '600000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  if (!st) throw new Error('A7 broker never came up');
  const cli = st.claudePid;
  const ansOf = (id) => fakeLog(w, cli).filter((e) => e.ev === 'answer' && e.id === id);
  const unmatchedOf = (id) => fakeLog(w, cli).filter((e) => e.ev === 'answer-unmatched' && e.id === id);
  const reqIds = () => fakeLog(w, cli).filter((e) => e.ev === 'request').map((e) => e.id);
  const nextReq = async (op) => { const before = reqIds().length; fakeCmd(w, cli, op); return waitFor(() => (reqIds().length > before ? reqIds()[reqIds().length - 1] : null), 3_000); };
  const INIT = (id) => ({ type: 'control_request', request_id: id, request: { subtype: 'initialize', hooks: { PreToolUse: [{ matcher: '*', hookCallbackIds: ['hook_0'] }] } } });
  const allowHook = (id) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } });
  const allowPerm = (id) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: {} } } });

  // 1. ownership by demonstrated redelivery; an omitted id is refused on its ORIGINAL clock
  const p1 = await nextReq({ op: 'perm' });
  const p2 = await nextReq({ op: 'perm' });
  const p1At = fakeLog(w, cli).find((e) => e.ev === 'request' && e.id === p1)?.at;
  fakeCmd(w, cli, { op: 'omit_redeliver', n: 1 });
  await sleep(300);
  const c1 = await rawClient(b.sock);
  c1.write(INIT('i1'));
  const p1Ans = await waitFor(() => ansOf(p1)[0] ?? null, PG + 3_000);
  await sleep(PG + 1_000);
  const p2Early = ansOf(p2).length;
  c1.write(allowPerm(p2));
  await sleep(500);
  k.check('A7.1 a permission the CLI REDELIVERED to the initializing client is owned: never refused past its grace, then answered once by that client',
    p2Early === 0 && ansOf(p2).length === 1 && ansOf(p2)[0].verdict === 'allow', { beforeClientAnswer: p2Early, answers: ansOf(p2).map((a) => a.verdict) });
  k.check('A7.2 a pending id the initialize answer OMITTED is not owned forever: refused on its original clock (grace + 2 s)',
    !!p1Ans && p1Ans.verdict === 'deny' && p1Ans.text.includes(REFUSAL) && (p1Ans.at - p1At) <= PG + 2_000, { answer: p1Ans ? `${p1Ans.verdict} after ${p1Ans.at - p1At} ms` : 'none' });
  c1.close();
  await sleep(300);

  // 2. a cancelled id is never refused
  const h1 = await nextReq({ op: 'hook' });
  fakeCmd(w, cli, { op: 'cancel', id: h1 });
  await sleep(HG + 2_000);
  k.check('A7.3 a request the CLI cancelled is never refused', ansOf(h1).length === 0, { answersAfterCancel: ansOf(h1).length });

  // 3. a late response after the refusal is dropped
  const h2 = await nextReq({ op: 'hook' });
  const h2Ans = await waitFor(() => ansOf(h2)[0] ?? null, HG + 3_000);
  const c2 = await rawClient(b.sock);
  c2.write(allowHook(h2));
  await sleep(800);
  k.check('A7.4 a client response that arrives AFTER the broker refused is dropped (exactly one answer reaches the CLI)',
    !!h2Ans && ansOf(h2).length === 1 && unmatchedOf(h2).length === 0, { answers: ansOf(h2).map((a) => a.verdict), secondDelivered: unmatchedOf(h2).length });
  c2.close();
  await sleep(300);

  // 4. a relay (no initialize) owns only what it saw
  const h3 = await nextReq({ op: 'hook' });
  const c3 = await rawClient(b.sock);
  await sleep(200);
  const h4 = await nextReq({ op: 'hook' });
  await sleep(HG + 2_000);
  const h3a = ansOf(h3)[0] ?? null;
  const h4early = ansOf(h4).length;
  c3.write(allowHook(h4));
  await sleep(500);
  k.check('A7.5 a relay that attaches WITHOUT initialize does not own a request emitted before it connected (still refused at grace)',
    !!h3a && h3a.verdict === 'deny', { h3: h3a ? h3a.verdict : 'unanswered' });
  k.check('A7.5 …but owns one emitted after it connected (not refused; answered once by the relay)',
    h4early === 0 && ansOf(h4).length === 1 && ansOf(h4)[0].verdict === 'allow', { h4BeforeRelayAnswer: h4early, h4: ansOf(h4).map((a) => a.verdict) });

  // 5. a response fragmented at 5 byte offsets is forwarded once
  const h5 = await nextReq({ op: 'hook' });
  const text = `${JSON.stringify(allowHook(h5))}\n`;
  const cuts = [1, 7, 20, 41, text.length - 1];
  let prev = 0;
  for (const cut of [...cuts, text.length]) { c3.writeRaw(text.slice(prev, cut)); prev = cut; await sleep(120); }
  await sleep(500);
  k.check('A7.6 a client response written in 6 fragments (cuts at 1, 7, 20, 41, len-1) reaches the CLI exactly once, intact',
    ansOf(h5).length === 1 && ansOf(h5)[0].verdict === 'allow', { answers: ansOf(h5).map((a) => a.verdict) });
  c3.close();
  await sleep(300);

  // 6. refusal racing a client response: exactly one answer, several offsets around the grace edge
  const raceResults = [];
  for (const off of [-60, -10, 0, 20, 80]) {
    const h = await nextReq({ op: 'hook' });
    const at = fakeLog(w, cli).find((e) => e.ev === 'request' && e.id === h)?.at ?? Date.now();
    await sleep(Math.max(0, at + HG + off - Date.now()));
    const c = await rawClient(b.sock);
    c.write(allowHook(h));
    await sleep(900);
    raceResults.push({ off, answers: ansOf(h).map((a) => a.verdict), extra: unmatchedOf(h).length });
    c.close();
    await sleep(250);
  }
  k.check('A7.7 refusal-vs-client-response races at the grace edge (−60…+80 ms): exactly one answer every time',
    raceResults.every((r) => r.answers.length === 1 && r.extra === 0), raceResults);

  // 7. a control_request split across chunks (CLI → broker) is tracked once
  const sid = `split-${Date.now()}`;
  fakeCmd(w, cli, { op: 'emit_split', at: [3, 17, 40, 90], gapMs: 120, frame: { type: 'control_request', request_id: sid, request: { subtype: 'hook_callback', callback_id: 'hook_0', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } } } } });
  const sa = await waitFor(() => ansOf(sid)[0] ?? null, HG + 4_000);
  await sleep(800);
  k.check('A7.8 a control_request that reaches the broker in 5 chunks is still tracked: refused exactly once at its grace',
    !!sa && sa.verdict === 'deny' && ansOf(sid).length === 1, { answers: ansOf(sid).map((a) => a.verdict) });

  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return k.results;
}

/* ============================================================================
 * A9b / A9c — adoption and hooks_applied.
 * ========================================================================== */
async function armA9b() {
  const k = makeChecker('A9b');
  const w = world('a9b');
  const NOHOOKS = { ORCHARD_ALLOW_GIT_WRITE: '1', ORCHARD_ALLOW_FABLE: '1', ORCHARD_ALLOW_FILE_CLOBBER: '1' };
  const srv = await bootServer(w, NOHOOKS);
  const pid = await registerProject(srv, w);
  // FEAT-096: the orchestrator profile (a PreToolUse hook) is on by default — turn it off for this project.
  const patched = await (await fetch(`http://127.0.0.1:${srv.port}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { orchestratorProfile: { enabled: false } } }),
  })).json();
  if (patched?.project?.settings?.orchestratorProfile?.enabled !== false) k.note(`could not disable the orchestrator profile: ${JSON.stringify(patched).slice(0, 200)}`);
  const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] nohooks');
  await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
  s.c.close();
  await stopServer(srv);
  const srv2 = await bootServer(w, NOHOOKS);
  const x = await waitFor(async () => { const l = await liveSession(srv2, s.station); return l && l.adoptState !== 'pending' ? l : null; }, 15_000);
  const inits = initsOf(w, s.cli);
  k.check('A9b a session with NO hooks (hooks_applied legitimately absent) adopts normally',
    x?.adoptState === 'adopted' && inits.length >= 2 && inits.every((i) => i.carriedHooks === false), { adoptState: x?.adoptState ?? null, inits });
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  return k.results;
}

async function armA9c() {
  const k = makeChecker('A9c');
  // protocol-2 broker, an engine that omits hooks_applied although hooks were sent
  {
    const w = world('a9c-p2');
    const env = { FAKE_OMIT_HOOKS_APPLIED: '1', CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '1500' };
    const srv = await bootServer(w, env);
    const pid = await registerProject(srv, w);
    const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] oldcli');
    await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
    s.c.close();
    await stopServer(srv);
    const srv2 = await bootServer(w, env);
    await sleep(5_000);
    const live = await liveSession(srv2, s.station);
    const b = brokerState(w, s.station);
    k.check('A9c.1 protocol-2 broker + an engine that did not apply the hooks: adoption is refused WITHOUT a reap',
      !live && /adoption FAILED/.test(srv2.log) && !!b && b.state !== 'draining' && b.cli, { live: !!live, broker: b, logged: /adoption FAILED.*hooks/.test(srv2.log) });
    fakeCmd(w, s.cli, { op: 'hook', lane: 'LA' });
    const a = await waitFor(() => answersFor(w, s.cli, 'LA')[0] ?? null, 6_000);
    k.check('A9c.1 …and the broker\'s own floor still answers (refuses) the lane\'s request', !!a && a.verdict === 'deny' && a.text.includes(REFUSAL), { answer: a });
    fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  }
  // an OLD broker (pinned session-host JS), the same engine
  {
    const w = world('a9c-old');
    const env = { FAKE_OMIT_HOOKS_APPLIED: '1', CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '2000' };
    const srv0 = await bootServer(w, env); // registers the project in this data dir
    const pid = await registerProject(srv0, w);
    await stopServer(srv0);
    const ob = spawnBrokerDirect(w, { hostScript: oldBrokerScript(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a9c-old', env });
    const st = await waitFor(() => { const r = readJson(ob.statusPath); return r?.claudePid ? r : null; }, 8_000);
    const first = await rawClient(ob.sock); // the "original server": the CLI's first initialize
    first.write({ type: 'control_request', request_id: 'orig', request: { subtype: 'initialize', hooks: { PreToolUse: [{ matcher: '*', hookCallbackIds: ['hook_0'] }] } } });
    await sleep(300);
    first.close();
    fakeCmd(w, st.claudePid, { op: 'lane_start', id: 'LA' });
    await sleep(600);
    const srv2 = await bootServer(w, env);
    const x = await waitFor(async () => { const l = await liveSession(srv2, 'a9c-old'); return l && l.adoptState !== 'pending' ? l : null; }, 15_000);
    fakeCmd(w, st.claudePid, { op: 'hook', lane: 'LA' });
    const a = await waitFor(() => answersFor(w, st.claudePid, 'LA')[0] ?? null, 8_000);
    k.check('A9c.2 an OLD broker whose engine did not apply the hooks: adopted responder-only, with the floor client-side, and the lane is answered',
      x?.adoptState === 'responder-only' && !!a, { adoptState: x?.adoptState ?? null, answer: a ? `${a.verdict}` : 'unanswered', project: pid });
    fakeCmd(w, st.claudePid, { op: 'lane_end', id: 'LA' });
    await sleep(500);
    try { process.kill(st.claudePid, 'SIGKILL'); } catch { /* gone */ }
  }
  return k.results;
}

/* ============================================================================
 * A10 — DELIVERY ACCEPTANCE. A client is never acked for a frame the broker
 * rejected.
 * ========================================================================== */
async function armA10() {
  const k = makeChecker('A10');
  const w = world('a10');
  const b = spawnBrokerDirect(w, {
    hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a10',
    env: { FAKE_EOF_MODE: 'ignore', CLAUDE_STATION_HOST_DRAIN_TERM_MS: '60000', CLAUDE_STATION_HOST_ABANDON_MS: '600000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const cli = st.claudePid;
  const c = await rawClient(b.sock);
  c.write({ type: 'orchard_broker_deliver', delivery_id: 'd1', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } });
  const ack1 = await waitFor(() => c.lines.find((l) => l.m?.type === 'orchard_broker_deliver_ack' && l.m.delivery_id === 'd1')?.m ?? null, 3_000);
  const got1 = await waitFor(() => fakeLog(w, cli).find((e) => e.ev === 'user-frame') ?? null, 3_000);
  k.check('A10.1 a delivery while the CLI takes input is ACCEPTED (positive ack) and written', ack1?.accepted === true && !!got1, { ack: ack1, written: !!got1 });
  c.close();
  await sleep(300);
  try { process.kill(st.hostPid, 'SIGTERM'); } catch { /* gone */ } // idle → drain commits → stdin ended
  const ended = await waitFor(() => (readJson(b.statusPath)?.acceptingInput === false ? readJson(b.statusPath) : null), 5_000);
  k.check('A10.2 the broker publishes acceptingInput:false the moment it ends the CLI\'s stdin', !!ended, { acceptingInput: readJson(b.statusPath)?.acceptingInput });
  const c2 = await rawClient(b.sock);
  c2.write({ type: 'orchard_broker_deliver', delivery_id: 'd2', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } });
  c2.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'raw after eof' }] } });
  await sleep(800);
  const ack2 = c2.lines.find((l) => l.m?.type === 'orchard_broker_deliver_ack' && l.m.delivery_id === 'd2')?.m ?? null;
  const rawAck = c2.lines.find((l) => l.m?.type === 'orchard_broker_deliver_ack' && l.m.delivery_id === null)?.m ?? null;
  k.check('A10.3 after EOF a delivery is REJECTED (accepted:false, with a reason) and a raw user frame is answered with a rejection, never silently dropped',
    ack2?.accepted === false && rawAck?.accepted === false, { ack2, rawAck });
  c2.close();
  // The status-read vs connect race, end to end through the server's relay: the
  // record the gate read said "accepting", the broker has since ended input.
  if (treeHas('src/server/survivor-delivery.ts', 'orchard_broker_deliver')) {
    const { deliverIntoSurvivor } = await importFromTree('src/server/survivor-delivery.ts');
    const staleRecord = { ...readJson(b.statusPath), acceptingInput: true, state: 'draining', midTurn: false };
    const before = fakeLog(w, cli).filter((e) => e.ev === 'user-frame').length;
    const acks = [];
    const handle = await deliverIntoSurvivor({ survivor: staleRecord, sdkSessionId: 'a10-race', prompt: 'raced', client: (e) => acks.push(e) });
    await sleep(500);
    const after = fakeLog(w, cli).filter((e) => e.ev === 'user-frame').length;
    k.check('A10.4 the gate read a stale "accepting" record, the broker rejects at connect: the relay is NOT established (the caller refuses, retryable) and nothing is written',
      handle === null && after === before, { handle: handle ? 'ESTABLISHED (would ack)' : null, userFramesWritten: after - before });
  } else k.note('A10.4 n/a on this tree (no protocol-2 relay)');
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  // An OLD broker keeps today's path exactly.
  if (treeHas('src/server/survivor-delivery.ts', 'orchard_broker_deliver')) {
    const ob = spawnBrokerDirect(w, { hostScript: oldBrokerScript(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a10-old', env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000' } });
    const ost = await waitFor(() => { const r = readJson(ob.statusPath); return r?.claudePid ? r : null; }, 8_000);
    const { deliverIntoSurvivor } = await importFromTree('src/server/survivor-delivery.ts');
    const handle = await deliverIntoSurvivor({ survivor: ost, sdkSessionId: 'a10-old', prompt: 'old path', client: () => {} });
    const wrote = await waitFor(() => fakeLog(w, ost.claudePid).find((e) => e.ev === 'user-frame') ?? null, 4_000);
    if (treeHas('src/server/survivor-delivery.ts', "'uncertain'")) {
      // BUG-191 changed this policy on purpose: an old broker cannot CONFIRM a
      // delivery (no H7), so it is never written to — the caller refuses
      // retryably and the message waits for that broker to finish.
      k.check('A10.5 an OLD broker (no hello, no acks) is NOT written to (BUG-191: it cannot confirm a delivery) — the relay is refused, nothing written',
        handle === null && !wrote, { handle: handle ? 'ESTABLISHED' : null, written: !!wrote });
    } else {
      k.check('A10.5 an OLD broker (no hello, no acks) keeps today\'s delivery path: established and written', !!handle && !!wrote, { handle: !!handle, written: !!wrote });
    }
    try { process.kill(ost.claudePid, 'SIGKILL'); } catch { /* gone */ }
  }
  return k.results;
}

/* ============================================================================
 * A14 — THE TOMBSTONE. A broker that stops a blocked lane and exits between
 * two polls still gets its reason into the outcome store.
 * ========================================================================== */
async function armA14() {
  const k = makeChecker('A14');
  const w = world('a14');
  const srv0 = await bootServer(w);
  await registerProject(srv0, w);
  await stopServer(srv0);
  const b = spawnBrokerDirect(w, {
    hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a14',
    env: { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '800', CLAUDE_STATION_LANE_BLOCK_MS: '2000', CLAUDE_STATION_HOST_ABANDON_MS: '3000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  fakeCmd(w, st.claudePid, { op: 'lane_start', id: 'LA' });
  fakeCmd(w, st.claudePid, { op: 'loop', lane: 'LA', everyMs: 300 });
  const polls = [];
  const poller = setInterval(() => { const r = readJson(b.statusPath); polls.push({ at: Date.now(), present: !!r, lane: r?.lanes?.find((l) => l.id === 'LA') ?? null }); }, 250);
  const tomb = b.statusPath.replace(/\.json$/, '.ended.json');
  const exited = await waitFor(() => (!pidAlive(st.hostPid) ? true : null), 30_000);
  clearInterval(poller);
  const t = readJson(tomb);
  k.check('A14.1 the broker stopped the blocked lane, exited, and left a tombstone naming why',
    !!exited && !!t && t.lanes?.some((l) => l.id === 'LA' && l.stopRequestedAt) && /stopped/.test(t.reason ?? ''), { exited: !!exited, tombstone: t ? { reason: t.reason, lanes: t.lanes } : null, polls: polls.length, lastPollSawRecord: polls.at(-1)?.present });
  const srv = await bootServer(w);
  const out = await waitFor(async () => {
    try { const r = await (await fetch(`http://127.0.0.1:${srv.port}/api/agent-outcomes`)).json(); const list = r.outcomes ?? r.records ?? r; return (Array.isArray(list) ? list : []).find((o) => o.agentId === 'LA') ?? null; } catch { return null; }
  }, 10_000);
  k.check('A14.2 a server that never saw the stop reads the reason from the tombstone into the outcome store, and consumes the tombstone',
    !!out && /stopped by Orchard/.test(out.detail) && !fs.existsSync(tomb), { outcome: out ? { kind: out.kind, detail: out.detail } : null, tombstoneLeft: fs.existsSync(tomb) });
  return k.results;
}

/* ============================================================================
 * A15 — BOUNDS, measured (grace 2 s, DRAIN_TERM 2 s, KILL_LAG 1 s).
 * ========================================================================== */
async function armA15() {
  const k = makeChecker('A15');
  const w = world('a15');
  const KN = { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '2000', CLAUDE_STATION_HOST_DRAIN_TERM_MS: '2000', CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000', CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500', CLAUDE_STATION_LANE_BLOCK_MS: '0', CLAUDE_STATION_HOST_ABANDON_MS: '600000' };
  const mk = (name, env = {}) => spawnBrokerDirect(w, { hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: name, env: { ...KN, ...env } });
  const up = async (b) => waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const measured = {};
  // idle, no request
  { const b = mk('idle'); const st = await up(b); const t0 = Date.now(); process.kill(st.hostPid, 'SIGTERM');
    const g = await waitFor(() => (!pidAlive(st.hostPid) ? Date.now() - t0 : null), 10_000); measured.idleExitMs = g; }
  // foreground-only turn with an unowned request
  { const b = mk('fg'); const st = await up(b); fakeCmd(w, st.claudePid, { op: 'mid_turn_open' }); await sleep(300);
    fakeCmd(w, st.claudePid, { op: 'hook' });
    const a = await waitFor(() => fakeLog(w, st.claudePid).find((e) => e.ev === 'answer') ?? null, 8_000);
    measured.fgRefusalMs = a?.latencyMs ?? null; measured.fgVerdict = a?.verdict ?? null;
    fakeCmd(w, st.claudePid, { op: 'result' }); await sleep(400);
    measured.fgTurnProceeded = readJson(b.statusPath)?.midTurn === false;
    try { process.kill(st.claudePid, 'SIGKILL'); } catch { /* gone */ } }
  // already draining
  { const b = mk('drain'); const st = await up(b); fakeCmd(w, st.claudePid, { op: 'lane_start', id: 'LA' }); await sleep(400);
    process.kill(st.hostPid, 'SIGTERM'); await waitFor(() => (readJson(b.statusPath)?.state === 'draining' ? true : null), 3_000);
    fakeCmd(w, st.claudePid, { op: 'hook', lane: 'LA' });
    const a = await waitFor(() => fakeLog(w, st.claudePid).find((e) => e.ev === 'answer') ?? null, 8_000);
    measured.drainingRefusalMs = a?.latencyMs ?? null; measured.drainingCliAliveAfter = pidAlive(st.claudePid);
    fakeCmd(w, st.claudePid, { op: 'lane_end', id: 'LA' });
    const g = await waitFor(() => (!pidAlive(st.hostPid) ? true : null), 10_000); measured.drainingExitAfterLaneEnd = !!g; }
  // CLI ignoring TERM
  { const b = mk('term', { FAKE_IGNORE_TERM: '1', FAKE_EOF_MODE: 'ignore' }); const st = await up(b); const t0 = Date.now(); process.kill(st.hostPid, 'SIGTERM');
    const g = await waitFor(() => (!pidAlive(st.claudePid) ? Date.now() - t0 : null), 15_000); measured.ignoreTermExitMs = g; }
  console.log(`  MEASURED ${JSON.stringify(measured)}`);
  k.check('A15.1 idle, no request: the reap is unchanged (exits promptly on EOF)', measured.idleExitMs != null && measured.idleExitMs < 2_000, measured.idleExitMs);
  k.check('A15.2 foreground-only turn, unowned request: refused within grace + 2 s, and the turn then proceeds',
    measured.fgVerdict === 'deny' && measured.fgRefusalMs <= 4_000 && measured.fgTurnProceeded, { refusalMs: measured.fgRefusalMs, proceeded: measured.fgTurnProceeded });
  k.check('A15.3 already draining: same ledger — refused within grace + 2 s; the CLI is not ended by the refusal; the drain completes after the lane',
    measured.drainingRefusalMs != null && measured.drainingRefusalMs <= 4_000 && measured.drainingCliAliveAfter && measured.drainingExitAfterLaneEnd, measured);
  k.check('A15.4 a CLI ignoring TERM: DRAIN_TERM + KILL_LAG still bounds it (≤ 2 s + 1 s + 1.5 s slack)', measured.ignoreTermExitMs != null && measured.ignoreTermExitMs <= 4_500, measured.ignoreTermExitMs);
  return k.results;
}

/* ============================================================================
 * A16 — BUG-159 shape: a long-silent main thread with a quiet lane. No close,
 * no refusal, no stop.
 * ========================================================================== */
async function armA16() {
  const k = makeChecker('A16');
  const w = world('a16');
  const env = { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '2000', CLAUDE_STATION_LANE_BLOCK_MS: '4000' };
  const srv = await bootServer(w, env);
  const pid = await registerProject(srv, w);
  const s = await startFakeSession(srv, w, pid, '[[fake:{"op":"lane_start","id":"LA"}]] quiet');
  await waitEv(s.c, (e) => e.t === 'turn-end', 20_000);
  fakeCmd(w, s.cli, { op: 'mid_turn_open' }); // a main turn that then goes silent
  await sleep(500);
  s.c.close();
  await sleep(20_000);
  const live = await liveSession(srv, s.station);
  const rec = hostFor(w, s.station);
  k.check('A16 a silent main thread + a quiet lane for 20 s (grace 2 s, lane bound 4 s): not closed, nothing refused, nothing stopped',
    !!live && rec && (rec.refusals ?? 0) === 0 && !(rec.lanes ?? []).some((l) => l.stopRequestedAt) && pidAlive(rec.claudePid),
    { live: !!live, refusals: rec?.refusals, lanes: rec?.lanes });
  fakeCmd(w, s.cli, { op: 'hook', lane: 'LA' });
  const a = await waitFor(() => answersFor(w, s.cli, 'LA')[0] ?? null, 5_000);
  k.check('A16 …and when the quiet lane does call a tool, the server answers it', !!a && a.verdict === 'allow', { answer: a });
  fakeCmd(w, s.cli, { op: 'result' });
  fakeCmd(w, s.cli, { op: 'lane_end', id: 'LA' });
  return k.results;
}

/* ============================================================================
 * FLOOR — the pure ledger (request-floor.mjs), with a controlled clock.
 * ========================================================================== */
async function armFLOOR() {
  const k = makeChecker('FLOOR');
  if (!fs.existsSync(path.join(TREE, 'src', 'server', 'request-floor.mjs'))) { k.note('n/a on this tree (no request floor)'); return k.results; }
  const { RequestFloor, laneOf } = await importFromTree('src/server/request-floor.mjs');
  let now = 1_000_000;
  const writes = []; const stops = [];
  const f = new RequestFloor({ grace: { hook_callback: 1000, can_use_tool: 5000, other: 1000 }, laneBlockMs: 3000, now: () => now, write: (x) => writes.push(x), stopLane: (l) => stops.push(l) });
  const hook = (id, lane) => ({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', input: { hook_event_name: 'PreToolUse', ...(lane ? { agent_id: lane } : {}) } } });
  const perm = (id, lane) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...(lane ? { agent_id: lane } : {}) } });
  f.onCliRequest(hook('h1', 'L1'), null); now += 999; f.tick();
  const early = writes.length; now += 2; f.tick();
  k.check('FLOOR.1 an unowned hook is refused at its grace, not before', early === 0 && writes.length === 1 && writes[0].response.response.hookSpecificOutput.permissionDecision === 'deny', { early, writes: writes.length });
  k.check('FLOOR.2 lane attribution: hook → input.agent_id, permission → top-level agent_id, none → main', laneOf(hook('x', 'A').request) === 'A' && laneOf(perm('y', 'B').request) === 'B' && laneOf(hook('z').request) === null, 'ok');
  k.check('FLOOR.3 a response for a refused id is dropped', f.onClientResponse('h1', 1) === false, f.stateOf('h1'));
  f.onCliRequest(perm('p1', 'L2'), 7); now += 60_000; f.tick();
  k.check('FLOOR.4 an owned permission is never refused while its owner is attached (60 s)', !writes.some((w) => w.response.request_id === 'p1'), f.stateOf('p1'));
  f.onClientDetached(7); now += 4_999; f.tick(); const before = writes.length; now += 2; f.tick();
  k.check('FLOOR.5 its owner dropping starts its clock from the drop', before === writes.length - 1 && writes.at(-1).response.request_id === 'p1', { refusedAfterDrop: writes.at(-1)?.response?.request_id });
  now += 3_000; f.tick();
  // L1 was blocked at its first refusal (t0+1 s) and stopped once 3 s had passed; L2 was
  // blocked only when p1 was refused (FLOOR.5) and is stopped only 3 s after THAT.
  k.check('FLOOR.6 a lane blocked for LANE_BLOCK_MS with no adoption is stopped — each lane on its own clock, once',
    stops[0] === 'L1' && stops.length === new Set(stops).size && (stops.length === 1 || stops[1] === 'L2'), stops);
  f.onLaneTerminal('L1');
  const snap = f.snapshot();
  k.check('FLOOR.7 the stopped lane is recorded stopped', !!snap.lanes.find((l) => l.id === 'L1' && l.stoppedAt), snap.lanes);
  const g = new RequestFloor({ grace: { hook_callback: 1000, can_use_tool: 1000, other: 1000 }, laneBlockMs: 0, now: () => now, write: (x) => writes.push(x), stopLane: (l) => stops.push(`g:${l}`) });
  g.onCliRequest(hook('q1', 'LX'), null); now += 1_500; g.tick(); now += 600_000; g.tick();
  k.check('FLOOR.8 LANE_BLOCK_MS = 0 never stops a lane (blocked forever, but visibly)', !stops.some((x) => x.startsWith('g:')) && !!g.snapshot().lanes.find((l) => l.id === 'LX' && l.blockedSince), g.snapshot().lanes);
  return k.results;
}

/* ============================================================================
 * REAL-CLI ARMS (the installed CLI, model haiku). The fake cannot prove what
 * the real engine does with a refusal, a repeated initialize or a redelivery.
 * ========================================================================== */
const REAL_OVR = { model: 'haiku', permissionMode: 'bypassPermissions' };
function hbFile(w, name) { return path.join(w.work, name); }
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function transcriptOf(w, sdkId) {
  const root = path.join(w.base, 'claude-config', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sdkId}.jsonl`);
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch { /* none */ }
  return [];
}
const typedUserPrompts = (entries) => entries.filter((e) => e.type === 'user' && !e.isMeta && e.message && (typeof e.message.content === 'string' || (Array.isArray(e.message.content) && e.message.content.some((b) => b?.type === 'text'))) && !(Array.isArray(e.message.content) && e.message.content.some((b) => b?.type === 'tool_result')));

/** A17 — does `session_state_changed: running` span a live background lane? (decides H9) */
async function armA17() {
  const k = makeChecker('A17');
  const dir = fs.mkdtempSync(path.join('/tmp', 'b187-a17-'));
  const cfg = isolatedStoreEnv(path.join(dir, 'cfg'));
  const t0 = Date.now();
  const tl = [];
  const child = spawn(REAL_CLI, ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--no-session-persistence', '--permission-prompt-tool', 'stdio'],
  { cwd: dir, env: { ...process.env, ...cfg, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const w8 = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* gone */ } };
  /*
   * Round 4 — determinism. The lane's lifetime used to be whatever the model
   * made of `sleep 15`: in the courier run (01a0e330) the subagent put its own
   * sleep in the BACKGROUND, so the agent lane ended at once, a background
   * Bash task outlived it, and the level never emptied before `idle` (a
   * `laneEmptiedAtMs:null` flake, not a finding about the engine). Now the
   * harness holds the lane's FIRST tool call at its PreToolUse hook for
   * LANE_HOLD_MS: the agent lane is deterministically live across the main
   * thread's first result, and its command is a no-op, so nothing it may
   * background outlives it. The assertion is unchanged.
   */
  const LANE_HOLD_MS = 12_000;
  let laneHeld = false;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const at = Date.now() - t0;
      if (m.type === 'control_request') {
        const answer = m.request.subtype === 'hook_callback'
          ? { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }
          : { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } } };
        const laneHook = m.request.subtype === 'hook_callback' && typeof m.request.input?.agent_id === 'string' && m.request.input.agent_id;
        if (laneHook && !laneHeld) {
          laneHeld = true;
          tl.push({ at, ev: 'lane-hook-held', task: m.request.input.agent_id });
          setTimeout(() => w8(answer), LANE_HOLD_MS);
        } else w8(answer);
      } else if (m.type === 'system' && ['session_state_changed', 'background_tasks_changed', 'task_notification'].includes(m.subtype)) {
        tl.push({ at, ev: m.subtype, state: m.state ?? null, tasks: m.tasks?.map((t) => t.task_id) ?? null, task: m.task_id ?? null });
      } else if (m.type === 'result') tl.push({ at, ev: 'result' });
    }
  });
  w8({ type: 'control_request', request_id: 'i1', request: { subtype: 'initialize', hooks: { PreToolUse: [{ matcher: '*', hookCallbackIds: ['hook_0'] }] } } });
  w8({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Use the Agent tool with subagent_type "general-purpose" and run_in_background true. The agent must run the Bash command `echo A` in the foreground (not in the background) and then reply DONE. Do not wait for it; after dispatching, reply exactly DISPATCHED.' }] } });
  await waitFor(() => tl.find((e) => e.ev === 'session_state_changed' && e.state === 'idle') ?? null, 150_000, 500);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
  const firstResult = tl.find((e) => e.ev === 'result');
  const laneEnd = tl.find((e) => e.ev === 'background_tasks_changed' && Array.isArray(e.tasks) && e.tasks.length === 0 && firstResult && e.at > firstResult.at);
  const idleBetween = tl.find((e) => e.ev === 'session_state_changed' && e.state === 'idle' && firstResult && laneEnd && e.at > firstResult.at && e.at < laneEnd.at);
  const spans = !!firstResult && !!laneEnd && !idleBetween;
  console.log(`  TIMELINE ${JSON.stringify(tl)}`);
  k.check(`A17 probe ran to the idle signal; decision: \`running\` ${spans ? 'SPANS' : 'does NOT span'} the background lane → H9 takes the ${spans ? 'FALLBACK (boundary logic kept; system frames no longer reopen midTurn)' : 'session-state'} branch`,
    !!firstResult && !!laneEnd, { spansLane: spans, firstResultAtMs: firstResult?.at ?? null, laneEmptiedAtMs: laneEnd?.at ?? null, idleBetween: !!idleBetween });
  const implementsFallback = treeHas('src/server/session-host.mjs', "m.type === 'system' || NON_TURN_TYPES.has(m.type)");
  k.check('A17 the broker implements the branch the probe decided', spans ? implementsFallback : !implementsFallback, { spans, implementsFallback });
  return k.results;
}

/**
 * Start a real haiku session whose background agent runs `n` sequential Bash
 * beats (each one its own tool call → its own PreToolUse hook callback) and
 * then writes DONE.
 */
async function startRealBeatSession(srv, w, projectId, { hb, n = 6, sleepS = 8, ovr = REAL_OVR, retryOnRefusal = false } = {}) {
  const c = await openWs(srv);
  const retry = retryOnRefusal ? ' If a Bash call is refused or blocked, retry the SAME call until it succeeds — do not give up and do not skip any.' : '';
  const prompt =
    'Dispatch ONE subagent with the Agent tool, subagent_type "general-purpose", run_in_background true. ' +
    `Its task: run these ${n} Bash commands ONE AT A TIME, each as its own separate Bash tool call, in order:\n` +
    Array.from({ length: n }, (_, i) => `${i + 1}. sleep ${sleepS}; echo beat${i + 1} >> ${hb}`).join('\n') +
    `\nthen a final separate Bash call: echo DONE >> ${hb}\n${retry}\n` +
    'Do NOT run any of these yourself and do NOT wait for the agent. Once dispatched, reply exactly: BG-DISPATCHED';
  let ack = null;
  for (let i = 0; i < 40 && !ack; i++) {
    c.send({ type: 'start', projectId, prompt, overrides: ovr });
    ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'start') ?? (c.events.some((e) => e.t === 'error' && /runtime check/.test(e.message ?? '')) ? 'retry' : null), 90_000);
    if (ack === 'retry') { ack = null; c.events.length = 0; await sleep(1500); }
  }
  if (!ack) throw new Error('real session never acked');
  const station = ack.stationSessionId;
  const host = await waitFor(() => { const h = hostFor(w, station); return h?.claudePid && h.sdkSessionId ? h : null; }, 60_000);
  return { c, station, host };
}

/** A2 — restart re-attach, real CLI: a hook pending across the restart is cancelled and retried against the NEW server. */
async function armA2() {
  const k = makeChecker('A2');
  const w = world('a2', { real: true });
  const env = { CLAUDE_STATION_HOOK_TIMEOUT_S: '20' };
  const srv = await bootServer(w, env);
  const pid = await registerProject(srv, w);
  const hb = hbFile(w, 'a2-hb.txt');
  const s = await startRealBeatSession(srv, w, pid, { hb, n: 6, sleepS: 8 });
  const began = await waitFor(() => (readText(hb).includes('beat1') ? true : null), 180_000, 1000);
  if (!began) throw new Error('the real background agent never started beating');
  const promptsBefore = typedUserPrompts(transcriptOf(w, s.host.sdkSessionId)).length;
  s.c.close();
  await stopServer(srv);
  const gapStart = Date.now();
  await sleep(18_000); // the agent's next Bash call is issued into the gap: its hook callback has nobody to answer it
  const srv2 = await bootServer(w, env);
  const adopted = await waitFor(async () => { const x = await liveSession(srv2, s.station); return x && x.adoptState !== 'pending' ? x : null; }, 30_000);
  const done = await waitFor(() => (readText(hb).includes('DONE') ? true : null), 240_000, 2000);
  const recs = hostRecords(w).filter((h) => h.stationSessionId === s.station);
  const promptsAfter = typedUserPrompts(transcriptOf(w, s.host.sdkSessionId)).length;
  const beats = readText(hb).split('\n').filter((l) => l.startsWith('beat')).length;
  k.check('A2.1 after a restart with a hook call in the gap, the NEW server adopts the running CLI and the background agent runs to DONE',
    !!adopted && adopted.adoptState === 'adopted' && !!done, { adoptState: adopted?.adoptState ?? null, done: !!done, beats, secondsAfterRestart: Math.round((Date.now() - gapStart) / 1000) });
  k.check('A2.2 exactly one CLI process — the adopter spawned nothing (same pid, one broker record)',
    recs.length <= 1 && (recs[0]?.claudePid ?? s.host.claudePid) === s.host.claudePid, { records: recs.length, pidBefore: s.host.claudePid, pidNow: recs[0]?.claudePid ?? 'record gone (exited)' });
  // Evidence the gap really held a pending hook: the CLI's own retry notice, in the subagent's transcript.
  const grepStore = (needle) => { const hits = []; const walk = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.jsonl') && readText(f).includes(needle)) hits.push(path.relative(w.base, f)); } }; walk(path.join(w.base, 'claude-config', 'projects')); return hits; };
  const retried = grepStore('reconnected before its PreToolUse hook answered');
  k.check('A2.3 the gap really held an unanswered hook: the CLI cancelled it on the re-initialize and the agent retried (the CLI\'s own notice is in the transcript)',
    retried.length > 0, { transcriptsWithRetryNotice: retried });
  k.check('A4r adoption of the REAL CLI wrote no user prompt (the transcript\'s typed user prompts are unchanged)',
    promptsAfter === promptsBefore, { before: promptsBefore, after: promptsAfter });
  if (ON_PINNED) k.note(`pinned: beats ${beats}/6, DONE ${!!done}, server2 log mentions re-adopt: ${/re-adopting/.test(srv2.log)}`);
  return k.results;
}

/** A11 — a permission prompt pending across a restart is REDELIVERED (same request id), answered once, and the tool runs. */
async function armA11() {
  const k = makeChecker('A11');
  const w = world('a11', { real: true });
  const srv = await bootServer(w);
  const pid = await registerProject(srv, w);
  const target = hbFile(w, 'a11-written.txt');
  const c = await openWs(srv);
  let ack = null;
  for (let i = 0; i < 40 && !ack; i++) {
    c.send({ type: 'start', projectId: pid, overrides: { model: 'haiku', permissionMode: 'default' }, prompt: `Use the Write tool to create the file ${target} containing exactly the text A11-OK. Do nothing else and do not use any other tool.` });
    ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'start') ?? (c.events.some((e) => e.t === 'error' && /runtime check/.test(e.message ?? '')) ? 'retry' : null), 90_000);
    if (ack === 'retry') { ack = null; c.events.length = 0; await sleep(1500); }
  }
  const card = await waitEv(c, (e) => e.t === 'approval-request' && e.toolName === 'Write', 120_000);
  if (!card) throw new Error('no Write approval card before the restart');
  const host = hostFor(w, ack.stationSessionId);
  c.close();
  await stopServer(srv);
  await sleep(3_000);
  const srv2 = await bootServer(w);
  const adopted = await waitFor(async () => { const x = await liveSession(srv2, ack.stationSessionId); return x && x.adoptState !== 'pending' ? x : null; }, 30_000);
  const c2 = await openWs(srv2);
  c2.send({ type: 'start', projectId: pid, resumeSessionId: host.sdkSessionId });
  const re = await waitEv(c2, (e) => e.t === 'ack' && e.of === 'start', 15_000);
  await sleep(1_500);
  const cards = c2.events.filter((e) => e.t === 'approval-request' && e.requestId === card.requestId);
  const snap = c2.events.find((e) => e.t === 'approvals-snapshot' && e.complete === true);
  k.check('A11.1 after the restart the SAME permission request id is redelivered to the new server and replayed to the reconnecting tab exactly once',
    !!adopted && !!re && cards.length === 1 && !!snap && snap.requestIds.includes(card.requestId), { adoptState: adopted?.adoptState ?? null, reattached: !!re?.reattached, cardsForId: cards.length, snapshot: snap ?? null });
  c2.send({ type: 'approval-response', requestId: card.requestId, allow: true });
  const matched = await waitEv(c2, (e) => e.t === 'ack' && e.of === 'approval-response' && e.requestId === card.requestId, 10_000);
  const written = await waitFor(() => (readText(target).includes('A11-OK') ? true : null), 60_000, 1000);
  k.check('A11.2 answering it allows the tool: the file is written', matched?.matched === true && !!written, { matched: matched?.matched ?? null, written: !!written });
  return k.results;
}

/** A12 — a human waiting on a card (server attached, browser gone) is never refused by the broker. */
async function armA12() {
  const k = makeChecker('A12');
  const waitMs = Number(arg('a12-wait-ms') ?? 300_000);
  const w = world('a12', { real: true });
  const srv = await bootServer(w, { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '10000', CLAUDE_STATION_FLOOR_PERMISSION_GRACE_MS: '30000' });
  const pid = await registerProject(srv, w);
  const target = hbFile(w, 'a12-written.txt');
  const c = await openWs(srv);
  let ack = null;
  for (let i = 0; i < 40 && !ack; i++) {
    c.send({ type: 'start', projectId: pid, overrides: { model: 'haiku', permissionMode: 'default' }, prompt: `Use the Write tool to create the file ${target} containing exactly the text A12-OK. Do nothing else and do not use any other tool.` });
    ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'start') ?? (c.events.some((e) => e.t === 'error' && /runtime check/.test(e.message ?? '')) ? 'retry' : null), 90_000);
    if (ack === 'retry') { ack = null; c.events.length = 0; await sleep(1500); }
  }
  const card = await waitEv(c, (e) => e.t === 'approval-request' && e.toolName === 'Write', 120_000);
  if (!card) throw new Error('no Write approval card');
  const host = hostFor(w, ack.stationSessionId);
  c.close(); // the browser goes away; the server stays attached to the broker
  console.log(`  (A12 waiting ${Math.round(waitMs / 1000)} s with the card unanswered…)`);
  await sleep(waitMs);
  const rec = hostFor(w, ack.stationSessionId);
  const c2 = await openWs(srv);
  c2.send({ type: 'start', projectId: pid, resumeSessionId: host.sdkSessionId });
  await waitEv(c2, (e) => e.t === 'ack' && e.of === 'start', 15_000);
  const replay = await waitEv(c2, (e) => e.t === 'approval-request' && e.requestId === card.requestId, 5_000);
  c2.send({ type: 'approval-response', requestId: card.requestId, allow: true });
  const written = await waitFor(() => (readText(target).includes('A12-OK') ? true : null), 60_000, 1000);
  k.check(`A12 a permission left unanswered ${Math.round(waitMs / 1000)} s (grace 30 s) with the server attached is NEVER refused by the broker; answered later, the tool runs`,
    (rec?.refusals ?? 0) === 0 && !!replay && !!written, { brokerRefusals: rec?.refusals ?? null, pendingOwned: rec?.pendingRequests ?? null, replayed: !!replay, written: !!written });
  return k.results;
}

/** A8 — mixed lanes, no server: the hook-looping lane A is stopped on the elapsed-time bound; the background shell B lives and finishes. */
async function armA8() {
  const k = makeChecker('A8');
  const shellS = Number(arg('a8-shell-s') ?? 300);
  const w = world('a8', { real: true });
  /*
   * The bound is short on purpose. Measured on haiku (2026-09-24): after TWO
   * refusals the real subagent obeys the refusal text and ends itself (~20 s
   * after its first refusal), so a 30 s bound was never reached — the product
   * ended the loop even sooner, but `stop_task` on a REAL lane went unproven.
   * A 2 s bound lands between the first refusal and the model's next call.
   */
  const LANE_BLOCK = Number(arg('a8-block-ms') ?? 2000);
  /*
   * The server is SIGKILLed below, and it is an ISOLATED (test) server, so
   * BUG-114's orphan bound (owner dead → ORPHAN_GRACE 120 s + ABANDON 120 s)
   * would drain this broker at ~240 s — a TEST-ONLY bound that never applies to
   * the production (shared-owner) service. Round-2 verify saw exactly that with
   * a 300 s shell. Pin it out of the way so the arm measures BUG-187's floor, not
   * BUG-114's (`--a8-orphan-default` restores it, to reproduce the artifact).
   */
  const env = {
    CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '5000', CLAUDE_STATION_LANE_BLOCK_MS: String(LANE_BLOCK),
    ...(flag('a8-orphan-default') ? {} : { CLAUDE_STATION_HOST_ORPHAN_GRACE_MS: '3600000' }),
  };
  const srv = await bootServer(w, env);
  const pid = await registerProject(srv, w);
  const hbA = hbFile(w, 'a8-laneA.txt');
  const doneB = hbFile(w, 'a8-laneB.txt');
  const c = await openWs(srv);
  const prompt =
    'Do exactly two things, then end your turn:\n' +
    `1. Start a background Bash command with the Bash tool and run_in_background true: sleep ${shellS}; echo DONE >> ${doneB}\n` +
    '2. Dispatch ONE subagent with the Agent tool, subagent_type "general-purpose", run_in_background true. Its task: run 40 Bash commands one at a time, ' +
    `each as its own separate Bash tool call: "sleep 3; echo tick >> ${hbA}". If a Bash call is refused or blocked, retry the SAME call — do not stop, do not skip.\n` +
    'Do not wait for either. Reply exactly: BOTH-STARTED';
  let ack = null;
  for (let i = 0; i < 40 && !ack; i++) {
    c.send({ type: 'start', projectId: pid, overrides: REAL_OVR, prompt });
    ack = await waitFor(() => c.events.find((e) => e.t === 'ack' && e.of === 'start') ?? (c.events.some((e) => e.t === 'error' && /runtime check/.test(e.message ?? '')) ? 'retry' : null), 90_000);
    if (ack === 'retry') { ack = null; c.events.length = 0; await sleep(1500); }
  }
  const started = await waitFor(() => (readText(hbA).includes('tick') ? true : null), 180_000, 1000);
  if (!started) throw new Error('lane A never started ticking');
  const host = hostFor(w, ack.stationSessionId);
  c.close();
  await stopServer(srv, 'SIGKILL'); // a crash: nobody will come back
  const tKill = Date.now();
  // Observe the broker's own record until B is done.
  let firstRefusalAt = null, stopAt = null, stoppedAt = null, laneA = null, bAliveAtStop = null;
  const timeline = [];
  const until = tKill + (shellS + 120) * 1000;
  while (Date.now() < until) {
    const r = readJson(host.status);
    timeline.push({ t: Math.round((Date.now() - tKill) / 1000), st: r ? { state: r.state, lifetime: r.backgroundLifetime, level: (r.backgroundTasks ?? []).map((x) => `${x.id}:${x.type}`), lanes: r.lanes, refusals: r.refusals, cli: pidAlive(host.claudePid) } : 'gone' });
    if (r) {
      const lanes = r.lanes ?? [];
      const a = lanes.find((l) => l.blockedSince) ?? lanes[0] ?? null;
      if (a) { laneA = a; firstRefusalAt ??= a.blockedSince ? Date.parse(a.blockedSince) : null; if (a.stopRequestedAt && !stopAt) { stopAt = Date.parse(a.stopRequestedAt); bAliveAtStop = !readText(doneB).includes('DONE') && pidAlive(host.claudePid); } if (a.stoppedAt) stoppedAt = Date.parse(a.stoppedAt); }
    }
    if (readText(doneB).includes('DONE')) break;
    await sleep(2000);
  }
  const bDone = readText(doneB).includes('DONE');
  const cliAliveAtB = pidAlive(host.claudePid) || bDone; // if B finished, the CLI was alive to finish it
  const stopDelay = firstRefusalAt && stopAt ? stopAt - firstRefusalAt : null;
  k.check('A8.1 lane A (looping on refused tool calls, nobody attached) is stopped at LANE_BLOCK_MS ± 3 s after its first refusal, and reaches a terminal frame',
    stopDelay != null && Math.abs(stopDelay - LANE_BLOCK) <= 3_000 && !!stoppedAt, { laneA, laneBlockMs: LANE_BLOCK, stopDelayMs: stopDelay, stopped: !!stoppedAt });
  k.check('A8.2 lane B (a background shell needing no callback) is alive at A\'s stop and writes DONE; the CLI lives until B ends',
    bAliveAtStop === true && bDone && cliAliveAtB, { bAliveAtStop, bDone, ticksA: readText(hbA).split('\n').filter(Boolean).length });
  if (KEEP || !(bAliveAtStop && bDone)) console.log(`  A8 TIMELINE ${JSON.stringify(timeline.filter((x, i, a) => i === 0 || JSON.stringify(x.st) !== JSON.stringify(a[i - 1].st)))}`);
  return k.results;
}

/** A9 — an OLD broker (pinned 541dd73 JS, real CLI), draining and running: adopted; hooks answered; the old drain completes after the lane. */
async function armA9() {
  const k = makeChecker('A9');
  if (ON_PINNED) { k.note('A9 runs a pinned OLD broker under THIS tree\'s server — not meaningful on the pinned tree itself'); return k.results; }
  if (!PINNED_FOR_OLD) PINNED_FOR_OLD = materialisePinnedTree('541dd73', { prefix: 'b187-oldbroker-' });
  const w = makeWorld('a9', { tree: PINNED_FOR_OLD.dir, real: true });
  worlds.push(w);
  const oldSrv = await bootServer(w); // the OLD server spawns OLD brokers
  const pid = await registerProject(oldSrv, w);
  const hbR = hbFile(w, 'a9-running.txt');
  const hbD = hbFile(w, 'a9-draining.txt');
  const r = await startRealBeatSession(oldSrv, w, pid, { hb: hbR, n: 5, sleepS: 8 });
  const d = await startRealBeatSession(oldSrv, w, pid, { hb: hbD, n: 5, sleepS: 8 });
  await waitFor(() => (readText(hbR).includes('beat1') && readText(hbD).includes('beat1') ? true : null), 180_000, 1000);
  r.c.close(); d.c.close();
  await stopServer(oldSrv); // handoff: both old brokers keep running
  try { process.kill(d.host.hostPid, 'SIGTERM'); } catch { /* gone */ } // one of them was told to drain
  await sleep(2_000);
  w.tree = ROOT; // deploy: the NEW server boots on the same data dir
  const srv = await bootServer(w);
  const ar = await waitFor(async () => { const x = await liveSession(srv, r.station); return x && x.adoptState !== 'pending' ? x : null; }, 30_000);
  const ad = await waitFor(async () => { const x = await liveSession(srv, d.station); return x && x.adoptState !== 'pending' ? x : null; }, 30_000);
  const doneR = await waitFor(() => (readText(hbR).includes('DONE') ? true : null), 240_000, 2000);
  const doneD = await waitFor(() => (readText(hbD).includes('DONE') ? true : null), 240_000, 2000);
  const goneD = await waitFor(() => (!pidAlive(d.host.hostPid) ? true : null), 240_000, 2000);
  k.check('A9.1 an OLD RUNNING broker is adopted and its lane runs to DONE', ar?.adoptState === 'adopted' && !!doneR, { adoptState: ar?.adoptState ?? null, done: !!doneR });
  k.check('A9.2 an OLD DRAINING broker is adopted responder-only: its hooks are answered, its lane runs to DONE, and the old drain then completes (broker exits)',
    ad?.adoptState === 'responder-only' && !!doneD && !!goneD, { adoptState: ad?.adoptState ?? null, done: !!doneD, brokerExited: !!goneD });
  return k.results;
}

/** A8 wants a long shell; A12 a long wait. Both accept knobs: --a8-shell-s=N, --a12-wait-ms=N. */

/* ============================================================================
 * A13 — THE BROWSER (real headless brave, busy fixture). One adopted healthy
 * session, an unadopted survivor with a BLOCKED lane, one with a STOPPED lane,
 * one running a delivered (relayed) turn. The running strip must never draw a
 * blocked or stopped lane as running. Cards: a real card is answered through
 * the page; then the client's reconciliation is driven with server frames
 * injected into the page's own driving socket (the handlers are the real
 * client code): a duplicate delivery is upserted, a `complete:false` snapshot
 * expires nothing, a `complete:true` one expires what it omits and keeps what
 * it lists answerable, and a click answered `matched:false` after a complete
 * snapshot settles expired. Screenshots go to docs/bugs/assets/ (unpublished).
 * ========================================================================== */
async function armA13() {
  const k = makeChecker('A13');
  if (ON_PINNED) { k.note('A13 exercises the post-fix client; n/a on the pinned tree'); return k.results; }
  const { chromium } = await import('playwright');
  const shots = path.join(ROOT, 'docs', 'bugs', 'assets');
  fs.mkdirSync(shots, { recursive: true });
  const w = world('a13');
  const srv1 = await bootServer(w);
  const port = srv1.port;
  const pid = await registerProject(srv1, w);
  const X = await startFakeSession(srv1, w, pid, '[[fake:{"op":"lane_start","id":"LX"}]] healthy');
  await waitEv(X.c, (e) => e.t === 'turn-end', 20_000);
  X.c.close();
  await sleep(500);
  await stopServer(srv1);
  const srv = await bootServer(w, {}, { port });
  await waitFor(async () => { const x = await liveSession(srv, X.station); return x && x.adoptState === 'adopted' ? x : null; }, 20_000);
  const xSdk = hostFor(w, X.station).sdkSessionId;
  // Unadopted survivors (spawned after this server booted, so nothing adopts them).
  const mk = async (name, env) => {
    const b = spawnBrokerDirect(w, { hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: `a13-${name}`, env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000', ...env } });
    const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
    return { b, cli: st.claudePid, hostPid: st.hostPid };
  };
  const Y = await mk('blocked', { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '800', CLAUDE_STATION_LANE_BLOCK_MS: '600000' });
  const Z = await mk('stopped', { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '800', CLAUDE_STATION_LANE_BLOCK_MS: '2000', FAKE_IGNORE_STOP: '1' });
  const R = await mk('relayed', {});
  fakeCmd(w, Y.cli, { op: 'lane_start', id: 'lane-blocked-Y' }); fakeCmd(w, Y.cli, { op: 'loop', lane: 'lane-blocked-Y', everyMs: 500 });
  fakeCmd(w, Z.cli, { op: 'lane_start', id: 'lane-stopped-Z' }); fakeCmd(w, Z.cli, { op: 'loop', lane: 'lane-stopped-Z', everyMs: 500 });
  fakeCmd(w, R.cli, { op: 'lane_start', id: 'lane-live-R' });
  const sdkOf = async (b) => waitFor(() => readJson(b.statusPath)?.sdkSessionId ?? null, 8_000);
  const [ySdk, zSdk, rSdk] = [await sdkOf(Y.b), await sdkOf(Z.b), await sdkOf(R.b)];
  await waitFor(() => (readJson(Y.b.statusPath)?.lanes?.some((l) => l.blockedSince) ? true : null), 8_000);
  await waitFor(() => (readJson(Z.b.statusPath)?.lanes?.some((l) => l.stopRequestedAt) ? true : null), 12_000);
  process.kill(R.hostPid, 'SIGTERM'); // draining, held by its live lane, foreground idle: FEAT-065 deliverable
  await waitFor(() => (readJson(R.b.statusPath)?.state === 'draining' ? true : null), 5_000);
  for (const [sdk, label] of [[xSdk, 'healthy adopted session'], [ySdk, 'survivor with a blocked lane'], [zSdk, 'survivor with a stopped lane'], [rSdk, 'survivor running a relayed turn']]) {
    writeSyntheticTranscript(w, sdk, [`BUG-187 fixture: ${label}`, 'earlier work in this session', 'more earlier work']);
  }
  const rc = await openWs(srv);
  rc.send({ type: 'start', projectId: pid, resumeSessionId: rSdk, prompt: '[[fake:{"op":"sleep","ms":120000}]] a message delivered into the draining survivor' });
  const delivered = await waitEv(rc, (e) => e.t === 'ack' && e.of === 'start' && e.deliveredVia === 'survivor', 15_000);
  k.check('A13.0 fixture: the relayed survivor accepted a delivered turn (protocol-2 acceptance)', !!delivered, { delivered: !!delivered });

  const browser = await chromium.launch({ headless: true, executablePath: `${process.env.HOME}/.local/bin/brave`, args: ['--no-sandbox'] });
  const enc = w.work.replace(/[^a-zA-Z0-9]/g, '-');
  const stripOf = async (page) => page.evaluate(() => ({
    rows: [...document.querySelectorAll('#strip .lag, .strip .lag')].map((r) => ({ cls: r.className, ty: r.querySelector('.ty')?.textContent ?? '', gl: r.querySelector('.gl')?.textContent ?? '', de: r.querySelector('.de')?.textContent ?? '', title: r.getAttribute('title') ?? '' })),
    sum: document.querySelector('#stripSum')?.textContent ?? '',
    lbl: document.querySelector('#strip .strip-top .lbl')?.textContent ?? '',
  }));
  const open = async (sdk) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.__b187 = { sockets: [] };
      window.WebSocket = class extends Orig {
        constructor(...a) { super(...a); const rec = { ws: this, sent: [] }; window.__b187.sockets.push(rec); const send = this.send.bind(this); this.send = (d) => { rec.sent.push(String(d)); return send(d); }; }
      };
    });
    await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(pid)}/session/${encodeURIComponent(sdk)}?dir=${encodeURIComponent(enc)}`, { waitUntil: 'domcontentloaded' });
    return page;
  };
  const rowsFor = async (page, pred, ms = 15_000) => waitFor(async () => { const st = await stripOf(page); return pred(st) ? st : null; }, ms, 500);

  // Y — a blocked lane
  const py = await open(ySdk);
  const sy = await rowsFor(py, (st) => st.rows.some((r) => r.ty.includes('local_agent') || r.cls.includes('blocked')));
  await py.screenshot({ path: path.join(shots, 'BUG-187-a13-strip-blocked.png') });
  const yRow = sy?.rows.find((r) => r.cls.includes('blocked')) ?? null;
  k.check('A13.1 a survivor lane its broker declares BLOCKED is drawn blocked (⊘, the broker\'s reason), never with the running glyph or class',
    !!yRow && !yRow.cls.includes(' run') && yRow.gl === '⊘' && /not attached/.test(yRow.de + yRow.title) && !(sy.rows.some((r) => r.cls.includes(' run') && r.ty !== 'main'))
      && sy.lbl === 'Blocked' && /0 agents running/.test(sy.sum),
    { rows: sy?.rows ?? null, sum: sy?.sum ?? null, header: sy?.lbl ?? null });
  // Z — a stopped (stop requested, engine slow to confirm) lane
  const pz = await open(zSdk);
  const sz = await rowsFor(pz, (st) => st.rows.some((r) => r.cls.includes('stopped')));
  await pz.screenshot({ path: path.join(shots, 'BUG-187-a13-strip-stopped.png') });
  const zRow = sz?.rows.find((r) => r.cls.includes('stopped')) ?? null;
  k.check('A13.2 a lane its broker STOPPED is drawn stopped (■), never as running (nor the header)', !!zRow && zRow.gl === '■' && !zRow.cls.includes(' run') && sz.lbl === 'Stopped', { rows: sz?.rows ?? null, sum: sz?.sum ?? null, header: sz?.lbl ?? null });
  // R — a relayed turn: the main row runs, its healthy lane runs
  const pr = await open(rSdk);
  const sr = await rowsFor(pr, (st) => st.rows.some((r) => r.cls.includes('main') && r.cls.includes('run')));
  await pr.screenshot({ path: path.join(shots, 'BUG-187-a13-strip-relayed.png') });
  k.check('A13.3 a relayed survivor turn and its healthy lane are still drawn running (no over-suppression)',
    !!sr && sr.rows.some((r) => r.cls.includes('main') && r.cls.includes('run')) && sr.rows.some((r) => r.cls.includes('lag run') && !r.cls.includes('main')) && sr.lbl === 'Running', { rows: sr?.rows ?? null, header: sr?.lbl ?? null });

  // X — the adopted session: the page re-takes the driving socket; cards.
  const px = await open(xSdk);
  const driving = await waitFor(async () => (await px.evaluate(() => window.__b187.sockets.findIndex((s) => s.sent.some((m) => m.includes('"type":"start"'))))) >= 0 ? true : null, 20_000);
  const reattached = await waitFor(async () => (await px.evaluate(() => document.body.innerText.includes('reattach') || document.body.innerText.includes('running'))) ? true : null, 5_000);
  fakeCmd(w, X.cli, { op: 'perm', tool: 'Write', toolInput: { file_path: '/tmp/b187-a13-real.txt', content: 'x' } });
  const realCard = await waitFor(async () => (await px.$$('.ask')).length >= 1 ? true : null, 15_000);
  if (realCard) await px.click('.ask .acts button.solid');
  const realAns = await waitFor(() => fakeLog(w, X.cli).find((e) => e.ev === 'answer' && e.kind === 'perm') ?? null, 10_000);
  k.check('A13.4 a REAL permission card on the adopted session is shown in the page and answered by a click (the engine gets allow)',
    !!driving && !!realCard && realAns?.verdict === 'allow', { driving: !!driving, card: !!realCard, answer: realAns?.verdict ?? null, reattachedText: !!reattached });
  await sleep(3_000); // the confirmed card leaves the panel
  const inject = (ev) => px.evaluate((e) => { const rec = window.__b187.sockets.filter((s) => s.sent.some((m) => m.includes('"type":"start"'))).at(-1); rec.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(e) })); }, ev);
  const cards = () => px.evaluate(() => [...document.querySelectorAll('.ask')].map((b) => ({ id: b.dataset.requestId, done: b.dataset.done ?? null, buttons: b.querySelectorAll('.acts button').length, enabled: [...b.querySelectorAll('.acts button')].some((x) => !x.disabled), verdict: b.querySelector('.verdict')?.textContent ?? '' })));
  const card = (id, extra = {}) => ({ t: 'approval-request', requestId: id, toolName: 'Write', input: { file_path: `/tmp/${id}.txt` }, title: 'wants permission to run', agentId: null, ...extra });
  await inject(card('Q1'));
  await inject(card('Q1')); // a redelivery / replay of the same request
  const c1 = await cards();
  k.check('A13.5 the same request delivered twice renders ONE card (upsert by request id)', c1.filter((c) => c.id === 'Q1').length === 1, c1);
  await inject({ t: 'approvals-snapshot', requestIds: [], complete: false });
  await sleep(300);
  const c2 = await cards();
  k.check('A13.6 a complete:false snapshot (an adoption still recovering) expires NOTHING', c2.find((c) => c.id === 'Q1')?.done == null, c2);
  await inject(card('Q2'));
  await inject({ t: 'approvals-snapshot', requestIds: ['Q2'], complete: true });
  await sleep(300);
  const c3 = await cards();
  await px.screenshot({ path: path.join(shots, 'BUG-187-a13-cards-after-snapshot.png') });
  k.check('A13.7 a complete:true snapshot expires the card it omits (the request no longer exists) and keeps the listed one ANSWERABLE',
    c3.find((c) => c.id === 'Q1')?.done === 'expired' && c3.find((c) => c.id === 'Q2')?.done == null && c3.find((c) => c.id === 'Q2')?.enabled === true, c3);
  // Q2 is not a real pending request on the server: the click is answered matched:false → after a complete snapshot, it settles expired.
  await px.click('.ask[data-request-id="Q2"] .acts button.solid');
  const c4 = await waitFor(async () => { const c = await cards(); return c.find((x) => x.id === 'Q2')?.done === 'expired' ? c : null; }, 8_000);
  k.check('A13.8 a click the server answers matched:false after a complete snapshot settles EXPIRED (not re-armed)', !!c4, c4 ?? await cards());
  await px.screenshot({ path: path.join(shots, 'BUG-187-a13-cards-expired.png') });
  await browser.close();
  rc.close();
  k.note(`screenshots: ${['strip-blocked', 'strip-stopped', 'strip-relayed', 'cards-after-snapshot', 'cards-expired'].map((n) => `docs/bugs/assets/BUG-187-a13-${n}.png`).join(', ')}`);
  fakeCmd(w, X.cli, { op: 'lane_end', id: 'LX' });
  for (const z of [Y, Z, R]) { try { process.kill(z.cli, 'SIGKILL'); } catch { /* gone */ } }
  return k.results;
}

/* ============================================================================
 * A9r — a REALISTIC OLD broker (the pinned 541dd73 session-host JS, i.e. the
 * live stuck session's shape) holding a live background lane AND a hook
 * request that went out while nobody was attached. A new server must adopt it,
 * re-attach a responder, and the lane's tool calls must then be answered.
 * HEAD-FAIL: the pre-fix server reaps it; the hook is never answered.
 * Also: a record that declares NOTHING about its work is adopted, not reaped.
 * ========================================================================== */
async function armA9r() {
  const k = makeChecker('A9r');
  const w = world('a9r');
  const srv0 = await bootServer(w);
  await registerProject(srv0, w);
  await stopServer(srv0);
  const ob = spawnBrokerDirect(w, { hostScript: oldBrokerScript(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a9r-old', env: { CLAUDE_STATION_HOST_ABANDON_MS: '600000' } });
  const st = await waitFor(() => { const r = readJson(ob.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const cli = st.claudePid;
  const orig = await rawClient(ob.sock); // the original (pre-restart) server
  orig.write({ type: 'control_request', request_id: 'orig-init', request: { subtype: 'initialize', hooks: { PreToolUse: [{ matcher: '*', hookCallbackIds: ['hook_0'] }] } } });
  await sleep(300);
  fakeCmd(w, cli, { op: 'lane_start', id: 'LOLD' });
  await sleep(500);
  orig.close(); // the server dies
  await sleep(300);
  fakeCmd(w, cli, { op: 'hook', lane: 'LOLD' }); // emitted with nobody attached: the old broker drops it
  await sleep(800);
  const rec = readJson(ob.statusPath);
  k.check('A9r PRECONDITION: an OLD-format broker (no protocol field) holds a live lane and an unanswered hook',
    !!rec && rec.protocol === undefined && (rec.backgroundTaskIds ?? []).includes('LOLD') && requestsFor(w, cli, 'LOLD').length === 1 && answersFor(w, cli, 'LOLD').length === 0,
    { protocol: rec?.protocol, lanes: rec?.backgroundTaskIds, lifetime: rec?.backgroundLifetime, requests: requestsFor(w, cli, 'LOLD').length });
  const srv = await bootServer(w);
  const x = await waitFor(async () => { const l = await liveSession(srv, 'a9r-old'); return l && l.adoptState !== 'pending' ? l : null; }, 20_000);
  const cancelled = await waitFor(() => fakeLog(w, cli).find((e) => e.ev === 'cancelled' && e.lane === 'LOLD' && e.byReinit) ?? null, ON_PINNED ? 5_000 : 10_000);
  fakeCmd(w, cli, { op: 'loop', lane: 'LOLD', everyMs: 400, count: 3 });
  const ans = await waitFor(() => (answersFor(w, cli, 'LOLD').length >= 3 ? answersFor(w, cli, 'LOLD') : null), 15_000);
  k.check('A9r the new server ADOPTS the old broker, and the pending hook is resolved by the CLI on the re-initialize (not left for its 600 s timeout)',
    !!x && ['adopted', 'responder-only'].includes(x.adoptState) && !!cancelled, { adoptState: x?.adoptState ?? null, pendingHookCancelledOnReinit: !!cancelled, brokerState: readJson(ob.statusPath)?.state ?? 'gone' });
  k.check('A9r …and the lane\'s retried tool calls are answered by the new server', !!ans && ans.every((a) => a.verdict === 'allow'), { answers: (ans ?? answersFor(w, cli, 'LOLD')).map((a) => a.verdict) });
  if (treeHas('src/server/survival.ts', 'survivorNeedsAdoption')) {
    const { survivorNeedsAdoption } = await importFromTree('src/server/survival.ts');
    const bare = { hostPid: 1, claudePid: 2, sock: '/x', status: '/x.json', state: 'running', exitCode: null, signal: null };
    const idle = { ...bare, protocol: 2, backgroundLifetime: 'no', midTurn: false, backgroundTasks: [], pendingRequests: 0 };
    const a = survivorNeedsAdoption(bare), b = survivorNeedsAdoption(idle), c = survivorNeedsAdoption({ ...bare, backgroundLifetime: 'no', midTurn: false });
    k.check('A9r a record that declares NOTHING about its work is ADOPTED (absence of evidence is not idleness); a declared-idle one is still reaped (non-vacuity)',
      a.adopt === true && b.adopt === false && c.adopt === false, { declaresNothing: a, protocol2Idle: b, oldIdle: c });
  }
  fakeCmd(w, cli, { op: 'lane_end', id: 'LOLD' });
  await sleep(500);
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return k.results;
}

/* ============================================================================
 * LEDGER — a refused id is never forgotten while its CLI lives: cross the old
 * 4000-entry cap (4500 settled ids after the refusal), then deliver a late
 * client response for the refused id. It must be DROPPED, not forwarded.
 * ========================================================================== */
async function armLEDGER() {
  const k = makeChecker('LEDGER');
  const w = world('ledger');
  const b = spawnBrokerDirect(w, {
    hostScript: THIS_HOST(), command: process.execPath, args: [FAKE_CLI], stationSessionId: 'ledger',
    env: { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '800', CLAUDE_STATION_LANE_BLOCK_MS: '0', CLAUDE_STATION_HOST_ABANDON_MS: '600000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  const cli = st.claudePid;
  fakeCmd(w, cli, { op: 'hook' });
  const first = await waitFor(() => fakeLog(w, cli).find((e) => e.ev === 'answer') ?? null, 5_000);
  fakeCmd(w, cli, { op: 'burst', n: 4500 });
  await waitFor(() => fakeLog(w, cli).find((e) => e.ev === 'burst-done') ?? null, 30_000);
  await sleep(1_500);
  const c = await rawClient(b.sock);
  c.write({ type: 'control_response', response: { subtype: 'success', request_id: first?.id, response: {} } });
  await sleep(1_000);
  const unmatched = fakeLog(w, cli).filter((e) => e.ev === 'answer-unmatched' && e.id === first?.id);
  k.check('LEDGER a refused id stays remembered past 4500 later settled requests: a late client response for it is DROPPED (no second answer reaches the CLI)',
    first?.verdict === 'deny' && unmatched.length === 0, { firstAnswer: first ? `${first.verdict} for ${first.id}` : null, secondDeliveries: unmatched.length });
  c.close();
  if (fs.existsSync(path.join(TREE, 'src', 'server', 'request-floor.mjs'))) {
    const { RequestFloor } = await importFromTree('src/server/request-floor.mjs');
    let now = 0; const writes = [];
    const f = new RequestFloor({ grace: { hook_callback: 10, can_use_tool: 10, other: 10 }, laneBlockMs: 0, now: () => now, write: (x) => writes.push(x) });
    f.onCliRequest({ type: 'control_request', request_id: 'R0', request: { subtype: 'hook_callback', input: {} } }, null); now += 20; f.tick();
    for (let i = 0; i < 10_000; i++) { f.onCliRequest({ type: 'control_request', request_id: `x${i}`, request: { subtype: 'hook_callback', input: {} } }, null); f.onCliCancel(`x${i}`); }
    f.onCliRequest({ type: 'control_request', request_id: 'R0', request: { subtype: 'hook_callback', input: {} } }, null); now += 20; f.tick();
    k.check('LEDGER (unit) after 10 000 settled ids: a late response for R0 is dropped, and a replayed request with R0 is not refused a second time',
      f.onClientResponse('R0', 1) === false && writes.filter((x) => x.response.request_id === 'R0').length === 1, { refusalsForR0: writes.filter((x) => x.response.request_id === 'R0').length });
  }
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return k.results;
}

/* ============================================================================
 * A18 — a lane waiting on a card a LIVE responder owns is never stopped by the
 * lane backstop (plan review round 1, point 5: responder loss is not human
 * waiting). The shape the openai verifier found (run 01a0e330): lane LA's
 * hook is refused with nobody attached (LA blocked), THEN a responder attaches
 * WITHOUT an adopting initialize — exactly FEAT-065's delivery relay, which
 * relays `can_use_tool` to the dashboard as an ordinary card — and LA asks a
 * permission that responder owns. Pre-fix the floor cleared `blockedSince`
 * only on an answer, an adoption or the lane's end, so the backstop fired
 * LANE_BLOCK_MS after the old refusal and stopped LA under the deciding human.
 * Self-anchored: every scenario also runs on the pinned pre-round-4 floor
 * (scripts/fixtures/bug-187/request-floor.pre-round4.mjs) and must FAIL there.
 * ========================================================================== */
const PRE_ROUND4_FLOOR = path.join(ROOT, 'scripts', 'fixtures', 'bug-187', 'request-floor.pre-round4.mjs');
function floorScenario(RequestFloor) {
  let now = 1_000_000; const writes = []; const stops = [];
  const f = new RequestFloor({ grace: { hook_callback: 1000, can_use_tool: 5000, other: 1000 }, laneBlockMs: 3000, now: () => now, write: (x) => writes.push(x), stopLane: (l) => stops.push(l) });
  f.onCliRequest({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', input: { hook_event_name: 'PreToolUse', agent_id: 'LA' } } }, null);
  now += 1_001; f.tick(); // refused: LA blocked
  f.onCliRequest({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', agent_id: 'LA' } }, 7); // an attached responder owns LA's card
  for (let i = 0; i < 20; i++) { now += 1_000; f.tick(); } // the human decides for 20 s (> 6 × LANE_BLOCK_MS)
  const heldStops = stops.length;
  const answered = f.onClientResponse('p1', 7);
  // non-vacuity: responder LOSS still stops the lane — a new card, its owner drops, grace, then the bound
  f.onCliRequest({ type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', agent_id: 'LA' } }, 7);
  f.onClientDetached(7);
  for (let i = 0; i < 10; i++) { now += 1_000; f.tick(); }
  return { heldStops, answered, refusedP1: writes.some((w) => w.response.request_id === 'p1'), lossStops: stops.length - heldStops };
}
async function a18Broker(w, hostScript, tag) {
  const LB = 3000;
  const b = spawnBrokerDirect(w, {
    hostScript, command: process.execPath, args: [FAKE_CLI], stationSessionId: `a18-${tag}`,
    env: { CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '1000', CLAUDE_STATION_FLOOR_PERMISSION_GRACE_MS: '2000', CLAUDE_STATION_LANE_BLOCK_MS: String(LB), CLAUDE_STATION_HOST_ABANDON_MS: '600000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  if (!st) throw new Error(`A18 (${tag}) broker never came up`);
  const cli = st.claudePid;
  const log = () => fakeLog(w, cli);
  fakeCmd(w, cli, { op: 'hook', lane: 'LA' }); // nobody attached
  const refusal = await waitFor(() => log().find((e) => e.ev === 'answer' && e.lane === 'LA' && e.verdict === 'deny') ?? null, 6_000);
  const c = await rawClient(b.sock); // a responder attaches, no initialize (the relay's wire shape)
  await waitFor(() => c.lines.find((l) => l.m?.type === 'orchard_broker_hello') ?? null, 3_000);
  fakeCmd(w, cli, { op: 'perm', lane: 'LA' });
  const card = await waitFor(() => c.lines.find((l) => l.m?.type === 'control_request' && l.m.request?.subtype === 'can_use_tool') ?? null, 3_000);
  await sleep(2 * LB + 2_000); // the human is still deciding, well past the backstop
  const stopsWhileHeld = log().filter((e) => e.ev === 'stop_task').length;
  const lane = (readJson(b.statusPath)?.lanes ?? []).find((l) => l.id === 'LA') ?? null;
  if (card) c.write({ type: 'control_response', response: { subtype: 'success', request_id: card.m.request_id, response: { behavior: 'allow', updatedInput: {} } } });
  const ans = card ? await waitFor(() => log().find((e) => e.ev === 'answer' && e.id === card.m.request_id) ?? null, 3_000) : null;
  c.close();
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return { refused: !!refusal, card: !!card, stopsWhileHeld, stopRequestedAt: lane?.stopRequestedAt ?? null, answer: ans?.verdict ?? null };
}
async function armA18() {
  const k = makeChecker('A18');
  if (!fs.existsSync(path.join(TREE, 'src', 'server', 'request-floor.mjs'))) { k.note('n/a on this tree (no request floor)'); return k.results; }
  const cur = floorScenario((await importFromTree('src/server/request-floor.mjs')).RequestFloor);
  const pre = floorScenario((await import(PRE_ROUND4_FLOOR)).RequestFloor);
  k.check('A18.1 (floor) a lane blocked by an earlier refusal is NOT stopped while an attached responder owns its permission card (held 20 s, bound 3 s); the human\'s answer is forwarded',
    cur.heldStops === 0 && !cur.refusedP1 && cur.answered === true, cur);
  k.check('A18.2 (floor) non-vacuity: once that responder is LOST, the same lane is still stopped at the bound', cur.lossStops === 1, cur);
  k.check('A18.3 (floor) must-FAIL anchor: the pinned pre-round-4 floor stops the lane under the deciding human', pre.heldStops >= 1, pre);
  const w = world('a18');
  const r = await a18Broker(w, THIS_HOST(), 'tree');
  k.check('A18.4 (broker + fake CLI) LA refused with nobody attached, then a responder attaches (no initialize) and owns LA\'s card: no stop_task while it is held past 2 × LANE_BLOCK_MS; the allow reaches the CLI',
    r.refused && r.card && r.stopsWhileHeld === 0 && !r.stopRequestedAt && r.answer === 'allow', r);
  // must-FAIL anchor end to end: the same broker source over the pinned pre-round-4 floor
  // (round 5: through the same compat adapter as A19 — the current broker reads
  // onCliRequest's return and calls isSettled, which a pinned floor predates.)
  const w2 = world('a18pre');
  const r0 = await a18Broker(w2, pinnedFloorHost(w2, PRE_ROUND4_FLOOR, 'pre-round4-host'), 'pre');
  k.check('A18.5 (broker) must-FAIL anchor: over the pre-round-4 floor the broker DOES stop the lane under the held card', r0.refused && r0.card && r0.stopsWhileHeld >= 1, r0);
  return k.results;
}

/* ============================================================================
 * A19 — a pending card is never lost, whatever the order of the 10 s handover
 * timeout and a LATE initialize answer (BUG-187 round 5; the openai verify run
 * 01a0e4d9 `late-initialize-ownership`). Pre-fix, the timeout reverted the
 * entry to unowned and a successful initialize that landed after it skipped
 * the entry (it was no longer `handover`), so the card was refused, its lane
 * stopped and the person's answer dropped. The invariant, per ordering: the
 * card has exactly one owner at every instant, is shown at most once, and is
 * answered exactly once (by the person, or by the floor's refusal — never
 * both, never neither).
 * Self-anchored: the scenarios also run on the pinned pre-round-5 floor
 * (scripts/fixtures/bug-187/request-floor.pre-round5.mjs) and the named ones
 * must FAIL there.
 * ========================================================================== */
const PRE_ROUND5_FLOOR = path.join(ROOT, 'scripts', 'fixtures', 'bug-187', 'request-floor.pre-round5.mjs');
const A19_GRACE = { hook_callback: 30_000, can_use_tool: 120_000, other: 30_000 }; // the product defaults
const a19Card = (id, lane = 'L') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Write', agent_id: lane, tool_use_id: `tu-${id}` } });
function a19Floor(RequestFloor) {
  const o = { now: 1_000_000, writes: [], stops: [] };
  o.f = new RequestFloor({ grace: A19_GRACE, laneBlockMs: 90_000, now: () => o.now, write: (x) => o.writes.push(x), stopLane: (l) => o.stops.push(l) });
  o.step = (ms, every = 250) => { for (let t = 0; t < ms; t += every) { o.now += Math.min(every, ms - t); o.f.tick(); } };
  o.refusalsOf = (id) => o.writes.filter((w) => w.response?.request_id === id).length;
  const settled = (id) => ['answered', 'refused', 'cancelled'].includes(o.f.stateOf(id));
  /** Shown to the adopter = redelivered by a successful initialize and not already settled (the broker strips a settled id). */
  o.shown = (id) => (settled(id) ? 0 : 1);
  return o;
}
/** The card's life after a scenario: hold past every clock, then the person answers once (if it was shown), then a duplicate. */
function a19Finish(o, id, client, shown) {
  const states = [];
  for (let i = 0; i < 40; i++) { o.step(10_000); states.push(o.f.stateOf(id)); } // 400 s: past grace and the lane bound many times
  const personAnswer = shown ? o.f.onClientResponse(id, client) : null;
  const duplicate = o.f.onClientResponse(id, client);
  const refusals = o.refusalsOf(id);
  const answers = refusals + (personAnswer === true ? 1 : 0);
  const ownerless = states.filter((s) => s === null || s === undefined).length; // a live card nobody holds
  return { held: states.every((s) => s === 'owned'), refusals, personAnswer, duplicate, answers, ownerless, stops: o.stops.length, finalState: o.f.stateOf(id) };
}
function a19Scenarios(RequestFloor) {
  const r = {};
  // S1 — late SUCCESS just after the timeout (the verifier's case, WITHOUT the replay frame it also sent).
  for (const delay of [9_999, 10_001, 10_250, 60_000]) {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    o.f.onClientInitialize(9, 'init');
    o.step(delay);
    const beforeAnswer = o.f.stateOf('card');
    o.f.onInitResponse('init', ['card'], true);
    const shown = o.shown('card');
    r[`late-success-${delay}`] = { beforeAnswer, afterInit: o.f.stateOf('card'), shown, ...a19Finish(o, 'card', 9, shown) };
  }
  // S2 — late FAILURE after the timeout: the fallback keeps the card and answers it at its ORIGINAL grace, once.
  {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    const t0 = o.now;
    o.f.onClientInitialize(9, 'init');
    o.step(10_250);
    o.f.onInitResponse('init', null, false);
    const afterInit = o.f.stateOf('card');
    o.step(A19_GRACE.can_use_tool - (o.now - t0) - 250);
    const justBefore = o.f.stateOf('card');
    o.step(500);
    const justAfter = o.f.stateOf('card');
    r['late-failure'] = { afterInit, justBefore, justAfter, ...a19Finish(o, 'card', 9, 0) };
  }
  // S3 — late SUCCESS after the fallback already REFUSED the card (grace spent before the initialize).
  {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    o.step(115_000);
    o.f.onClientInitialize(9, 'init');
    o.step(10_250); // timeout at 10 s; the original clock is past 120 s: refused in that tick
    const beforeAnswer = o.f.stateOf('card');
    o.f.onInitResponse('init', ['card'], true); // the CLI built its answer before it read the refusal
    const shown = o.shown('card');
    r['late-success-after-refusal'] = { beforeAnswer, afterInit: o.f.stateOf('card'), shown, lateAnswerDropped: o.f.onClientResponse('card', 9) === false, ...a19Finish(o, 'card', 9, 0) };
  }
  // S4 — second RE-ATTACH: C1's initialize times out, C1 drops, C2 attaches and initializes; C1's answer lands late.
  for (const c2Late of [false, true]) {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    o.f.onClientInitialize(1, 'init1');
    o.step(10_250);
    o.f.onClientDetached(1);
    o.f.onClientInitialize(2, 'init2');
    if (c2Late) o.step(10_250); // C2's own handover times out too
    const stale = o.f.onInitResponse('init1', ['card'], true); // to a client that is gone: transfers nothing
    const afterStale = o.f.stateOf('card');
    o.f.onInitResponse('init2', ['card'], true);
    const shown = o.shown('card');
    r[`reattach${c2Late ? '-both-late' : ''}`] = { staleReturned: stale ?? null, afterStale, afterInit2: o.f.stateOf('card'), shown, ...a19Finish(o, 'card', 2, shown) };
  }
  // S5 — ONE client, TWO initializes in flight: the older answer omits the card, the newer redelivers it.
  {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    o.f.onClientInitialize(9, 'initA');
    o.f.onClientInitialize(9, 'initB');
    o.f.onInitResponse('initA', [], true);
    const afterA = o.f.stateOf('card');
    o.f.onInitResponse('initB', ['card'], true);
    const shown = o.shown('card');
    r['two-inits'] = { afterA, afterB: o.f.stateOf('card'), shown, ...a19Finish(o, 'card', 9, shown) };
  }
  // S6 — non-vacuity: a successful initialize that does NOT redeliver the card leaves it to the fallback (refused once).
  {
    const o = a19Floor(RequestFloor);
    o.f.onCliRequest(a19Card('card'), null);
    o.f.onClientInitialize(9, 'init');
    o.step(10_250);
    o.f.onInitResponse('init', [], true);
    r['not-redelivered'] = { afterInit: o.f.stateOf('card'), ...a19Finish(o, 'card', 9, 0) };
  }
  return r;
}
/**
 * The current broker over a PINNED floor, adapted to the current broker's calls
 * exactly as the pre-round-5 broker behaved (every replay forwarded, nothing
 * stripped). Used by A18.5 (pre-round-4 floor) and A19 (pre-round-5 floor).
 */
function pinnedFloorHost(w, pinnedFloor, name) {
  const hostDir = path.join(w.base, name);
  fs.mkdirSync(hostDir, { recursive: true });
  for (const f of ['session-host.mjs', 'path-env.mjs']) fs.copyFileSync(path.join(TREE, 'src', 'server', f), path.join(hostDir, f));
  fs.copyFileSync(pinnedFloor, path.join(hostDir, 'request-floor.pinned.mjs'));
  fs.writeFileSync(path.join(hostDir, 'request-floor.mjs'), [
    "export * from './request-floor.pinned.mjs';",
    "import { RequestFloor as Pinned } from './request-floor.pinned.mjs';",
    'export class RequestFloor extends Pinned {',
    '  onCliRequest(f, c) { super.onCliRequest(f, c); return true; }',
    '  isSettled() { return false; }',
    '  hasOwned() { return false; }', // round 6: the pre-round-6 broker never held its drain for an owned card
    '}',
    '',
  ].join('\n'));
  return path.join(hostDir, 'session-host.mjs');
}
/**
 * The broker end to end, with the fake CLI. `mode`:
 *  - 'late-success': the fake holds its answer to the adopter's initialize 11 s (past the
 *    handover timeout) and redelivers the card; permission grace 15 s. The card must be held
 *    past its grace and the person's `allow` must reach the CLI — never a refusal.
 *  - 'after-refusal': the initialize is never answered by the fake; the card is refused at
 *    the timeout (grace 3 s); THEN an initialize answer that still lists the card is emitted,
 *    and the CLI replays the card's control_request. Neither may show the card to the adopter.
 *  - 'late-failure': as 'after-refusal', but the late answer is an ERROR at ~11 s (grace 15 s):
 *    the fallback keeps the card and refuses it once at its grace.
 */
async function a19Broker(w, hostScript, mode) {
  const grace = mode === 'after-refusal' ? 3000 : 15_000;
  const b = spawnBrokerDirect(w, {
    hostScript, command: process.execPath, args: [FAKE_CLI], stationSessionId: `a19-${mode}`,
    env: {
      CLAUDE_STATION_FLOOR_HOOK_GRACE_MS: '3000', CLAUDE_STATION_FLOOR_PERMISSION_GRACE_MS: String(grace), CLAUDE_STATION_LANE_BLOCK_MS: '0',
      CLAUDE_STATION_HOST_ABANDON_MS: '600000', FAKE_REINIT_DELAY_MS: mode === 'late-success' ? '11000' : '-1',
    },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  if (!st) throw new Error(`A19 (${mode}) broker never came up`);
  const cli = st.claudePid;
  const log = () => fakeLog(w, cli);
  // The ORIGINAL server's first initialize (answered at once), then it goes away.
  const c0 = await rawClient(b.sock);
  c0.write({ type: 'control_request', request_id: 'init-0', request: { subtype: 'initialize', hooks: {} } });
  await waitFor(() => c0.lines.find((l) => l.m?.type === 'control_response' && l.m.response?.request_id === 'init-0') ?? null, 4_000);
  c0.close();
  await sleep(300);
  fakeCmd(w, cli, { op: 'perm', lane: 'LA' }); // nobody attached: the card is emitted to no one
  const req = await waitFor(() => log().find((e) => e.ev === 'request' && e.kind === 'perm') ?? null, 4_000);
  const cardId = req?.id;
  const t0 = Date.now();
  const c = await rawClient(b.sock); // the restarted server adopts
  await waitFor(() => c.lines.find((l) => l.m?.type === 'orchard_broker_hello') ?? null, 3_000);
  c.write({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {} } });
  const cardFrame = { type: 'control_request', request_id: cardId, request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/tmp/x', content: 'x' }, tool_use_id: `tu-${cardId}`, agent_id: 'LA' } };
  if (mode === 'after-refusal') {
    await waitFor(() => log().find((e) => e.ev === 'answer' && e.id === cardId) ?? null, 15_000);
    fakeCmd(w, cli, { op: 'emit', frames: [
      { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: { commands: [], pending_permission_requests: [cardFrame] }, pending_permission_requests: [cardFrame] } },
      cardFrame,
    ] });
    await sleep(1500);
  } else if (mode === 'late-failure') {
    await sleep(Math.max(0, 11_000 - (Date.now() - t0)));
    fakeCmd(w, cli, { op: 'emit', frame: { type: 'control_response', response: { subtype: 'error', request_id: 'init-1', error: 'initialize failed late' } } });
    await sleep(Math.max(0, grace + 2_000 - (Date.now() - t0)));
  } else {
    await waitFor(() => c.lines.find((l) => l.m?.type === 'control_response' && l.m.response?.request_id === 'init-1') ?? null, 15_000);
    await sleep(Math.max(0, grace + 4_000 - (Date.now() - t0))); // the person is still deciding, past the card's grace
  }
  const initAns = c.lines.find((l) => l.m?.type === 'control_response' && l.m.response?.request_id === 'init-1')?.m ?? null;
  const redeliveredIds = (x) => (Array.isArray(x) ? x.map((f) => f?.request_id) : []);
  const shownInInit = initAns ? redeliveredIds(initAns.response?.pending_permission_requests).filter((id) => id === cardId).length : 0;
  const shownInInner = initAns ? redeliveredIds(initAns.response?.response?.pending_permission_requests).filter((id) => id === cardId).length : 0;
  const shownAsFrame = c.lines.filter((l) => l.m?.type === 'control_request' && l.m.request_id === cardId).length;
  const answersBefore = log().filter((e) => e.ev === 'answer' && e.id === cardId);
  const shown = shownInInit > 0 || shownAsFrame > 0;
  if (shown) c.write({ type: 'control_response', response: { subtype: 'success', request_id: cardId, response: { behavior: 'allow', updatedInput: {} } } });
  if (shown) await waitFor(() => log().filter((e) => e.ev === 'answer' && e.id === cardId).length > answersBefore.length || null, 3_000);
  const answers = log().filter((e) => e.ev === 'answer' && e.id === cardId).map((e) => e.verdict);
  const refusals = readJson(b.statusPath)?.refusals ?? null;
  c.close();
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return { cardId: cardId ?? null, initAnswered: !!initAns, shownInInit, shownInInner, shownAsFrame, answers, refusals };
}
async function armA19() {
  const k = makeChecker('A19');
  if (!fs.existsSync(path.join(TREE, 'src', 'server', 'request-floor.mjs'))) { k.note('n/a on this tree (no request floor)'); return k.results; }
  const cur = a19Scenarios((await importFromTree('src/server/request-floor.mjs')).RequestFloor);
  const pre = a19Scenarios((await import(PRE_ROUND5_FLOOR)).RequestFloor);
  const once = (s) => s.answers === 1 && s.duplicate === false && s.ownerless === 0;
  for (const d of [9_999, 10_001, 10_250, 60_000]) {
    const s = cur[`late-success-${d}`];
    k.check(`A19.1 (floor) initialize answered ${d} ms after the handover began, redelivering the card: owned by the adopter, held 400 s with no refusal and no lane stop, the person's answer forwarded exactly once`,
      s.afterInit === 'owned' && s.held && s.refusals === 0 && s.stops === 0 && s.personAnswer === true && s.shown === 1 && once(s), s);
  }
  k.check('A19.2 (floor) must-FAIL anchor: on the pinned pre-round-5 floor the 10 001 ms answer loses the card (refused, the person\'s answer dropped)',
    pre['late-success-10001'].afterInit !== 'owned' && pre['late-success-10001'].refusals === 1 && pre['late-success-10001'].personAnswer === false, pre['late-success-10001']);
  const lf = cur['late-failure'];
  k.check('A19.3 (floor) late FAILURE after the timeout: the fallback keeps the card and refuses it exactly once, at its ORIGINAL grace (not before)',
    lf.afterInit === 'unowned' && lf.justBefore === 'unowned' && lf.justAfter === 'refused' && lf.refusals === 1 && once(lf), lf);
  const ar = cur['late-success-after-refusal'];
  k.check('A19.4 (floor) late SUCCESS after the fallback already refused: stays refused, is not re-claimed (settled → not shown), and a late answer is dropped — one answer in all',
    ar.beforeAnswer === 'refused' && ar.afterInit === 'refused' && ar.shown === 0 && ar.lateAnswerDropped && ar.refusals === 1 && ar.answers === 1, ar);
  for (const key of ['reattach', 'reattach-both-late']) {
    const s = cur[key];
    k.check(`A19.5 (floor) second re-attach (${key}): the gone client's late answer transfers nothing; the new adopter's answer claims the card; held, answered once by the person`,
      s.staleReturned === null && s.afterInit2 === 'owned' && s.held && s.refusals === 0 && s.personAnswer === true && once(s), s);
  }
  k.check('A19.6 (floor) must-FAIL anchor: on the pinned pre-round-5 floor the both-late re-attach loses the card', pre['reattach-both-late'].afterInit2 !== 'owned' && pre['reattach-both-late'].refusals === 1, pre['reattach-both-late']);
  const ti = cur['two-inits'];
  k.check('A19.7 (floor) one client, two initializes in flight: the older answer (card omitted) does not release it while the newer one still claims it; the newer redelivery owns it',
    ti.afterA === 'handover' && ti.afterB === 'owned' && ti.held && ti.refusals === 0 && once(ti), ti);
  k.check('A19.8 (floor) must-FAIL anchor: on the pinned pre-round-5 floor the older answer releases the card and the newer one cannot re-claim it', pre['two-inits'].afterB !== 'owned' && pre['two-inits'].refusals === 1, pre['two-inits']);
  const nr = cur['not-redelivered'];
  k.check('A19.9 (floor) non-vacuity: a successful initialize that does NOT redeliver the card leaves it to the fallback — refused exactly once', nr.afterInit === 'unowned' && nr.refusals === 1 && nr.answers === 1, nr);
  // End to end on the real broker (fake CLI), current tree vs. the pinned pre-round-5 floor, in parallel.
  const w = world('a19'); const wp = world('a19pre');
  const preHost = pinnedFloorHost(wp, PRE_ROUND5_FLOOR, 'pre-round5-host');
  const [ls, lsPre] = await Promise.all([a19Broker(w, THIS_HOST(), 'late-success'), a19Broker(wp, preHost, 'late-success')]);
  k.check('A19.10 (broker + fake CLI) the adopter\'s initialize is answered 11 s later (past the handover timeout) redelivering the card: shown once, held past its 15 s grace, and the person\'s allow is the ONLY answer the CLI gets',
    ls.initAnswered && ls.shownInInit === 1 && ls.shownAsFrame === 0 && ls.answers.length === 1 && ls.answers[0] === 'allow' && ls.refusals === 0, ls);
  k.check('A19.11 (broker) must-FAIL anchor: over the pinned pre-round-5 floor the same run refuses the card the person is deciding',
    lsPre.initAnswered && lsPre.answers[0] === 'deny', lsPre);
  const w2 = world('a19b'); const wp2 = world('a19bpre');
  const preHost2 = pinnedFloorHost(wp2, PRE_ROUND5_FLOOR, 'pre-round5-host');
  const [af, afPre] = await Promise.all([a19Broker(w2, THIS_HOST(), 'after-refusal'), a19Broker(wp2, preHost2, 'after-refusal')]);
  k.check('A19.12 (broker) an initialize answer (and a replayed request) listing a card the floor ALREADY refused: forwarded without it, so the adopter never shows a card whose answer would be dropped; the CLI got exactly one answer (the refusal)',
    af.initAnswered && af.shownInInit === 0 && af.shownInInner === 0 && af.shownAsFrame === 0 && af.answers.length === 1 && af.answers[0] === 'deny', af);
  k.check('A19.13 (broker) must-FAIL anchor: the pre-round-5 broker shows the already-refused card to the adopter',
    afPre.shownInInit + afPre.shownAsFrame >= 1, afPre);
  const w3 = world('a19c');
  const lfb = await a19Broker(w3, THIS_HOST(), 'late-failure');
  k.check('A19.14 (broker) a late initialize FAILURE after the timeout: the card stays with the fallback and is refused exactly once at its grace (never left unanswered)',
    lfb.shownInInit === 0 && lfb.answers.length === 1 && lfb.answers[0] === 'deny', lfb);
  return k.results;
}

/* ============================================================================
 * A20 — owned / live evidence is never overridden by a timer or a record
 * (BUG-187 round 6; openai verify run 01a0e69e, cases `own` and `hold-default`).
 *  - the close gate: a fresh older-broker `no` record + an empty raw level, while
 *    the bridge holds a LIVE revived lane, must not read `no` (the engine keeps a
 *    revived lane out of its level) — conflicting evidence is `unknown`;
 *  - the FEAT-065 relay: a card an ATTACHED person owns waits for them; only
 *    responder LOSS (or no dashboard at all) denies it;
 *  - the sibling that made the relay's 30 s bound necessary: the broker's drain
 *    commit ended stdin after its 90 s midTurn window under an owned card, so the
 *    person's answer could never reach the CLI.
 * Anchors: the verifier's own repros ran against pre-round-6 copies (exit 1);
 * here the broker anchor is a CONSTRUCTED variant with the owned-card hold removed.
 * ========================================================================== */
async function a20Relay(mod, { holds, knobMs, holdMs, detach = false, noClient = false }) {
  const prev = process.env.CLAUDE_STATION_DELIVERY_APPROVAL_MS;
  process.env.CLAUDE_STATION_DELIVERY_APPROVAL_MS = String(knobMs);
  const dir = fs.mkdtempSync(path.join('/tmp', 'b187-a20-'));
  const sock = path.join(dir, 'relay.sock');
  const wire = []; const events = []; let conn = null;
  const server = net.createServer((c) => {
    conn = c;
    c.write(`${JSON.stringify({ type: 'orchard_broker_hello', accepted: true, protocol: 2, ...(holds ? { holdsOwnedCards: true } : {}) })}\n`);
    let buf = '';
    c.on('data', (b) => {
      buf += b; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); wire.push(m);
        if (m.type === 'orchard_broker_deliver') c.write(`${JSON.stringify({ type: 'orchard_broker_deliver_ack', delivery_id: m.delivery_id, accepted: true })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  let handle = null;
  try {
    handle = await mod.deliverIntoSurvivor({ survivor: { sock, protocol: 2 }, sdkSessionId: `a20-${Math.random()}`, prompt: 'ask-me', client: (e) => events.push(e) });
    if (!handle || handle === 'uncertain') return { delivered: false };
    if (noClient) handle.attachClient(null);
    conn.write(`${JSON.stringify({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { t: 1 } } })}\n`);
    await sleep(30);
    if (detach) handle.attachClient(null);
    await sleep(holdMs);
    const answered = handle.answerApproval('p', true);
    await sleep(20);
    const answers = wire.filter((x) => x.type === 'control_response').map((x) => x.response.response.behavior);
    return { delivered: true, shown: events.filter((e) => e.t === 'approval-request').length, answers, personAnswerAccepted: answered };
  } finally {
    if (handle && handle !== 'uncertain') handle.finish();
    conn?.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CLAUDE_STATION_DELIVERY_APPROVAL_MS; else process.env.CLAUDE_STATION_DELIVERY_APPROVAL_MS = prev;
  }
}
async function a20Drain(w, hostScript) {
  const b = spawnBrokerDirect(w, {
    hostScript, command: process.execPath, args: [FAKE_CLI], stationSessionId: 'a20-drain',
    env: { CLAUDE_STATION_HOST_REAP_RESULT_WAIT_MS: '800', CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS: '1500', CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '250', CLAUDE_STATION_LANE_BLOCK_MS: '0', CLAUDE_STATION_HOST_ABANDON_MS: '600000' },
  });
  const st = await waitFor(() => { const r = readJson(b.statusPath); return r?.claudePid ? r : null; }, 8_000);
  if (!st) throw new Error('A20 broker never came up');
  const cli = st.claudePid;
  const log = () => fakeLog(w, cli);
  const c = await rawClient(b.sock); // the relay's wire shape: hello, no initialize
  const hello = await waitFor(() => c.lines.find((l) => l.m?.type === 'orchard_broker_hello')?.m ?? null, 3_000);
  fakeCmd(w, cli, { op: 'mid_turn_open' });
  fakeCmd(w, cli, { op: 'perm' });
  const card = await waitFor(() => c.lines.find((l) => l.m?.type === 'control_request' && l.m.request?.subtype === 'can_use_tool')?.m ?? null, 4_000);
  try { process.kill(b.proc.pid, 'SIGTERM'); } catch { /* gone */ } // a restart drains this broker
  await sleep(6_000); // > 3 × (result wait + midTurn window): the person is still deciding
  const eofWhileHeld = log().some((e) => e.ev === 'exit');
  if (card) c.write({ type: 'control_response', response: { subtype: 'success', request_id: card.request_id, response: { behavior: 'allow', updatedInput: {} } } });
  const ans = card ? await waitFor(() => log().find((e) => e.ev === 'answer' && e.id === card.request_id) ?? null, 3_000) : null;
  fakeCmd(w, cli, { op: 'result' }); // the turn completes — the drain must now finish (non-vacuity)
  const drained = await waitFor(() => log().find((e) => e.ev === 'exit') ?? null, 8_000);
  c.close();
  try { process.kill(cli, 'SIGKILL'); } catch { /* gone */ }
  return { holdsOwnedCards: hello?.holdsOwnedCards === true, card: !!card, eofWhileHeld, answer: ans?.verdict ?? null, drainedAfter: !!drained };
}
async function armA20() {
  const k = makeChecker('A20');
  const surv = await importFromTree('src/server/survival.ts');
  const dir = fs.mkdtempSync(path.join('/tmp', 'b187-a20s-'));
  const status = path.join(dir, 'status.json');
  const fresh = new Date().toISOString();
  const oldH = { statusPath: status, broker: { hello: Promise.resolve(null) } };
  const bridge = (revivedLive) => ({ lastFrameAt: Date.now() - 1000, levelRawEmpty: true, levelSeenSinceAttach: true, revivedLive });
  fs.writeFileSync(status, JSON.stringify({ backgroundLifetime: 'no', updatedAt: fresh }));
  const oldLive = await surv.brokerLifetimeForClose(oldH, bridge(true));
  const oldIdle = await surv.brokerLifetimeForClose(oldH, bridge(false));
  const p2H = { statusPath: status, broker: { hello: Promise.resolve({ accepted: true, protocol: 2 }), lifetimeQuery: async () => ({ lifetime: 'no', seq: 7 }) } };
  const p2Live = await surv.brokerLifetimeForClose(p2H, bridge(true));
  const p2Idle = await surv.brokerLifetimeForClose(p2H, bridge(false));
  fs.rmSync(dir, { recursive: true, force: true });
  k.check('A20.1 (close gate) an older broker\'s FRESH `no` record + empty raw level, while the bridge holds a LIVE revived lane: never `no` (verifier case `own`)', oldLive.lifetime !== 'no', oldLive);
  k.check('A20.2 (close gate) a protocol-2 broker answering `no` while the bridge holds a live revived lane: conflicting → `unknown`, never `no`', p2Live.lifetime === 'unknown', p2Live);
  k.check('A20.3 (close gate) non-vacuity: with NO revived lane the same evidence still reads `no` (an idle session still closes)', oldIdle.lifetime === 'no' && p2Idle.lifetime === 'no', { oldIdle, p2Idle });
  const rel = await importFromTree('src/server/survivor-delivery.ts');
  const held = await a20Relay(rel, { holds: true, knobMs: 200, holdMs: 1_000 });
  k.check('A20.4 (relay) a card an ATTACHED person owns, on a broker that declares holdsOwnedCards, is held 5 × the legacy bound; their allow is the ONLY answer (verifier case `hold-default`, knob shrunk)',
    held.shown === 1 && held.personAnswerAccepted === true && held.answers.length === 1 && held.answers[0] === 'allow', held);
  const lost = await a20Relay(rel, { holds: true, knobMs: 200, holdMs: 100, detach: true });
  k.check('A20.5 (relay) responder LOSS: the dashboard detaches → the card is denied at once, and a later answer is rejected — one answer',
    lost.answers.length === 1 && lost.answers[0] === 'deny' && lost.personAnswerAccepted === false, lost);
  const none = await a20Relay(rel, { holds: true, knobMs: 200, holdMs: 200, noClient: true });
  k.check('A20.6 (relay) no dashboard attached at all: denied at once (the retained legitimate purpose)', none.answers.length === 1 && none.answers[0] === 'deny' && none.personAnswerAccepted === false, none);
  const legacy = await a20Relay(rel, { holds: false, knobMs: 200, holdMs: 1_000 });
  k.check('A20.7 (relay) a pre-round-6 broker that does NOT declare the hold keeps the bounded deny (its drain would end the CLI\'s input under the card anyway)',
    legacy.answers.length === 1 && legacy.answers[0] === 'deny' && legacy.personAnswerAccepted === false, legacy);
  const w = world('a20');
  const r = await a20Drain(w, THIS_HOST());
  k.check('A20.8 (broker + fake CLI) a DRAINING broker, midTurn, with a card the attached relay owns: no stdin EOF while the person decides (> 3 × the midTurn window); their allow reaches the CLI; after the turn\'s result the drain completes',
    r.holdsOwnedCards && r.card && !r.eofWhileHeld && r.answer === 'allow' && r.drainedAfter, r);
  // Anchor: the same broker with the owned-card hold removed (a constructed pre-round-6 variant).
  const wp = world('a20pre');
  const preDir = path.join(wp.base, 'pre-round6-host');
  fs.mkdirSync(preDir, { recursive: true });
  for (const f of ['path-env.mjs', 'request-floor.mjs']) fs.copyFileSync(path.join(TREE, 'src', 'server', f), path.join(preDir, f));
  const hostSrc = fs.readFileSync(THIS_HOST(), 'utf8');
  const broken = hostSrc.replace('  if (floor.hasOwned()) {', '  if (false) {');
  if (broken === hostSrc) { k.check('A20.9 (broker) must-FAIL anchor: the owned-card hold must exist in session-host.mjs to construct the variant', false, 'the hold was not found — this tree has no owned-card hold'); return k.results; }
  fs.writeFileSync(path.join(preDir, 'session-host.mjs'), broken);
  const r0 = await a20Drain(wp, path.join(preDir, 'session-host.mjs'));
  k.check('A20.9 (broker) must-FAIL anchor: without the hold the drain ends stdin under the held card and the person\'s allow never reaches the CLI',
    r0.card && r0.eofWhileHeld && r0.answer !== 'allow', r0);
  return k.results;
}

const ARM_FNS = { A1: armA1, A3: armA3, A4: armA4, A5: armA5, A6: armA6, A7: armA7, A9b: armA9b, A9c: armA9c, A10: armA10, A14: armA14, A15: armA15, A16: armA16, FLOOR: armFLOOR, A17: armA17, A2: armA2, A11: armA11, A12: armA12, A8: armA8, A9: armA9, A13: armA13, A9r: armA9r, LEDGER: armLEDGER, A18: armA18, A19: armA19, A20: armA20 };

async function main() {
  for (const a of ARMS) {
    const fn = ARM_FNS[a];
    if (!fn) { console.log(`\n=== ${a}: (not implemented in this build) ===`); all.push({ arm: a, name: 'not implemented', ok: false, observed: 'no arm' }); continue; }
    console.log(`\n=== ${a} ===`);
    const t0 = Date.now();
    try {
      all.push(...await fn());
    } catch (err) {
      console.log(`  FAIL  [${a}] arm crashed: ${err.stack ?? err}`);
      all.push({ arm: a, name: 'arm crashed (harness error — NOT a behavioural failure)', ok: false, observed: String(err.message ?? err), crashed: true });
    }
    console.log(`  (${a} took ${Math.round((Date.now() - t0) / 1000)} s)`);
    for (const w of worlds.splice(0)) await cleanupWorld(w, { keep: KEEP });
  }
  const pass = all.filter((r) => r.ok).length;
  console.log(`\n${pass}/${all.length} checks passed${ON_PINNED ? ' (on the PINNED baseline)' : ''}`);
  const failed = all.filter((r) => !r.ok);
  if (failed.length) console.log(`failed: ${failed.map((r) => `${r.arm}: ${r.name.split(' ').slice(0, 1).join(' ')}${r.crashed ? ' (CRASH)' : ''}`).join(' | ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error(`FATAL: ${err.stack ?? err}`); process.exitCode = 1; }).finally(async () => {
  for (const w of worlds) await cleanupWorld(w, { keep: KEEP });
  if (pinned && !KEEP) pinned.cleanup();
  if (PINNED_FOR_OLD && !KEEP) PINNED_FOR_OLD.cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
