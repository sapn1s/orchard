#!/usr/bin/env node
/**
 * BUG-253 — a NEW session's first message is on disk before the start goes on, and it is either
 * delivered once to the session it started or shown in the project's dock (Send again / Discard) —
 * on every exit path. Before the fix it lived only in memory until the CLI recorded it, so a start
 * that never got that far lost it without a trace (user report 2026-10-12, a container project
 * whose container was being recreated).
 *
 * Every server is an ISOLATED scratch server (scripts/lib/bug-187-harness: its own CLAUDE_STATION_DATA
 * and transcript store, a free port, the scripted fake CLI). "At the CLI" is the fake's stdin tap.
 * The ground truth of "lost" is independent of the fix's own route: the marker text is searched for
 * in EVERY file under the scratch data dir and transcript store.
 *
 *   N   normal path: the first message reaches the CLI once, is in the transcript once, the dock is
 *       empty, the start box is removed, and `recent` names the session it started.
 *   A   admission failure (the project directory is missing): the fatal frame says `kept`; the dock
 *       shows it `failed` with its exact words.
 *   B   the CLI dies after taking the prompt, before `system:init`: the dock shows it `uncertain`.
 *   C   the server dies between accepting the start and init (SIGKILL right after the record is saved):
 *       after a reboot the dock shows it `uncertain`.
 *   D   the tab closes after the ack, before init (init held 6 s): delivered once, or shown — never lost.
 *   H   (IV 268766ea BROKEN) the tab closes after the ack while the CLI holds the prompt and has NOT reached init
 *       (init held 25 s): the message must be in the dock AT ONCE (a "starting" row, `sending`), never offered for a
 *       resend while that CLI lives (IV 4720fd59: a resend then reached two sessions), and `delivered` on init.
 *   F   Send again on A's row: exactly one new session, once at the CLI; a second press is refused (409).
 *   G   Discard: gone from the dock, never sent.
 *   V   the real click-path in headless brave, on a busy project (earlier sessions + two kept first messages, one
 *       long): typed into the new-session composer while admission fails → the composer is NOT refilled, the dock
 *       shows all three as "Not sent" with Send again / Edit / Discard; Send again from the dock starts one
 *       session (once at the CLI); Discard removes one. Screenshots at 1280/520 px, light and dark (--shots <dir>).
 *   U   in-process (src/server/outbox.ts with a controllable wiring): an OLDER attempt's late init never lands on
 *       a Send-again attempt (recorded as alsoStartedAs, the row is not marked delivered); a settled row ignores
 *       a second settle; a `sending` start row reloads `uncertain` with the restart reason; Send again is once.
 *   K   container project on the FEAT-158 sandbox (skipped with a loud NOTE if the sandbox is down):
 *       K1 `docker create` fails (admission) → `failed`; K2 a slow `docker create` and the tab closed
 *       mid-admission (the incident) → shown, never lost.
 *
 *   MUST-FAIL (P-arms): the same A, B, C on a SYNTHESIZED pre-fix tree — a scratch copy of this tree
 *   whose start handler never records the message (one anchor, must match exactly once). Each must
 *   lose the marker. Never `git show HEAD`, so committing the fix cannot turn this into decoration.
 *
 *   --against-prefix runs the ordinary arms (not the P demonstration) on that synthesized pre-fix tree, so the
 *   suite itself must exit 1 there — the literal must-FAIL.
 *
 *   node scripts/verify-bug-253-first-prompt-durable.mjs [--only N,A,B,C,D,F,G,K,P] [--no-container] [--against-prefix]
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, sleep, makeWorld, bootServer, stopServer, registerProject, openWs, waitFor, fakeTap, cleanupWorld, mkScratch,
} from './lib/bug-187-harness.mjs';

const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',').map((x) => x.trim().toUpperCase())) : null;
const want = (id) => !ONLY || ONLY.has(id);
const NO_CONTAINER = process.argv.includes('--no-container');
const AGAINST_PREFIX = process.argv.includes('--against-prefix');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
  return ok;
}
const mark = (tag) => `B253-${tag}-${crypto.randomBytes(4).toString('hex')}`;

/* ------------------------------------------------------------------ ground truth */
function filesHolding(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { if (fs.readFileSync(p).includes(needle)) hits.push(p); } catch { /* raced */ } }
    }
  };
  walk(dir);
  return hits;
}
const onDisk = (w, m) => [...filesHolding(w.data, m), ...filesHolding(w.store, m)].map((f) => path.relative(w.base, f));
const transcriptDir = (w) => path.join(w.store, w.work.replace(/[^a-zA-Z0-9]/g, '-'));
/** Every user frame carrying `m` that ANY fake CLI of this world read on stdin. */
function tapHits(w, m) {
  const dir = path.dirname(w.tap);
  const base = path.basename(w.tap);
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`${base}.`))) {
    const pid = Number(f.slice(base.length + 1));
    for (const t of fakeTap(w, pid)) if (t.m?.type === 'user' && JSON.stringify(t.m.message).includes(m)) n++;
  }
  return n;
}
/** User rows carrying `m` in the transcript of `sdk` (the CLI's own record). */
function transcriptUserHits(w, sdk, m) {
  try {
    return fs.readFileSync(path.join(transcriptDir(w), `${sdk}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r?.type === 'user' && JSON.stringify(r.message).includes(m)).length;
  } catch { return 0; }
}

/* ------------------------------------------------------------------ server helpers */
const api = async (srv, p, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const starts = async (srv, pid) => (await api(srv, `/api/outbox/starts?project=${encodeURIComponent(pid)}`)).body ?? { rows: [], recent: [] };
const rowOf = async (srv, pid, m) => (await starts(srv, pid)).rows?.find((r) => r.text === m) ?? null;

/**
 * Wait until the server's boot runtime check lets host sessions start (FEAT-151), WITHOUT a first message:
 * a blank-prompt start records nothing, so the arms' counts are not polluted by `runtime check pending`.
 */
async function waitReady(srv, pid) {
  for (let i = 0; i < 60; i++) {
    const c = await openWs(srv);
    c.send({ type: 'start', projectId: pid, prompt: '', overrides: { permissionMode: 'default' } });
    const r = await waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || (e.t === 'error' && e.fatal)), 20_000);
    c.send({ type: 'close' });
    await sleep(200);
    c.close();
    if (r && r.t === 'ack') return true;
    await sleep(1000);
  }
  throw new Error('the scratch server never let a host session start');
}
async function startWith(srv, pid, prompt) {
  const c = await openWs(srv);
  c.send({ type: 'start', projectId: pid, prompt, overrides: { permissionMode: 'default' } });
  return c;
}
const firstOf = (c, ms = 30_000) => waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || (e.t === 'error' && e.fatal)), ms);

/* ------------------------------------------------------------------ the world */
function fixedEnv(w) {
  return { FAKE_TRANSCRIPT_DIR: transcriptDir(w) };
}
async function world(name, tree = ROOT) {
  const w = makeWorld(name, { tree });
  const srv = await bootServer(w, fixedEnv(w));
  const pid = await registerProject(srv, w);
  await waitReady(srv, pid);
  return { w, srv, pid };
}

const scratchTrees = [];
/** A scratch copy of this tree whose start handler never records the first message (the pre-fix state). */
function preFixTree() {
  const dir = mkScratch('b253-prefix-tree');
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    if (name === 'src' || name === 'public') fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    else fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  }
  const f = path.join(dir, 'src', 'server', 'index.ts');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = "if (!cmd.resumeSessionId && typeof cmd.prompt === 'string' && cmd.prompt.trim()) {\n            try {\n              startRow = mintStartRow({";
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`pre-fix synthesis: the anchor matched ${n} times (must be exactly 1) — refusing to test the fix as the baseline`);
  fs.writeFileSync(f, src.replace(anchor, anchor.replace("!cmd.resumeSessionId && typeof cmd.prompt === 'string' && cmd.prompt.trim()", 'false /* BUG-253 pre-fix: no record */')));
  scratchTrees.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ arms */
async function armN(ctx) {
  console.log('\n--- N: the normal path — delivered once, nothing left in the dock');
  const { w, srv, pid } = ctx;
  const m = mark('NORMAL');
  const c = await startWith(srv, pid, m);
  const init = await waitFor(() => c.events.find((e) => e.t === 'session-init'), 30_000);
  await waitFor(() => c.events.find((e) => e.t === 'result'), 30_000);
  const sdk = init?.sessionId ?? null;
  await sleep(500);
  const v = await starts(srv, pid);
  const rec = v.recent?.find((r) => r.startedAs === sdk) ?? null;
  const boxFile = rec ? fs.existsSync(path.join(w.data, 'outbox', `${rec.box}.jsonl`)) : null;
  check('N session started; the first message reached the CLI exactly once', !!sdk && tapHits(w, m) === 1, { sdk, atCli: tapHits(w, m) });
  check('N the transcript holds the first message exactly once (no duplicate)', transcriptUserHits(w, sdk, m) === 1, { inTranscript: transcriptUserHits(w, sdk, m) });
  check('N the dock holds nothing; recent says delivered with startedAs = the session', !v.rows?.some((r) => r.text === m) && rec?.state === 'delivered', { dockRows: v.rows?.length, recent: rec });
  check('N the finished start box was removed from disk', boxFile === false, { boxFile, outboxFilesWithMarker: filesHolding(path.join(w.data, 'outbox'), m).length });
  c.send({ type: 'close' }); c.close();
}

async function armA(ctx, { mustFail = false } = {}) {
  const tag = mustFail ? 'P-A' : 'A';
  console.log(`\n--- ${tag}: admission failure (the project directory is missing)${mustFail ? ' — PRE-FIX tree' : ''}`);
  const { w, srv, pid } = ctx;
  const m = mark('ADMIT');
  fs.renameSync(w.work, `${w.work}.moved`);
  let first;
  try {
    const c = await startWith(srv, pid, m);
    first = await firstOf(c);
    await sleep(500);
    c.close();
  } finally { fs.renameSync(`${w.work}.moved`, w.work); }
  await sleep(500);
  const disk = onDisk(w, m);
  if (mustFail) return { lost: disk.length === 0, disk, first: first?.t };
  const row = await rowOf(srv, pid, m);
  check('A the start was refused (fatal) and the frame says the words are kept', first?.t === 'error' && !!first.kept?.box, { t: first?.t, kept: first?.kept, msg: String(first?.message ?? '').slice(0, 60) });
  check('A the dock shows it failed, with its exact words and a reason', row?.state === 'failed' && row.text === m && /did not start/.test(row.reason ?? ''), row && { state: row.state, reason: row.reason?.slice(0, 90), box: row.box });
  check('A the message is on disk (ground truth, not the route)', disk.length > 0, disk);
  return row;
}

async function armB(ctx, { mustFail = false } = {}) {
  const tag = mustFail ? 'P-B' : 'B';
  console.log(`\n--- ${tag}: the CLI dies after taking the prompt, before system:init${mustFail ? ' — PRE-FIX tree' : ''}`);
  const { w } = ctx;
  await stopServer(ctx.srv);
  const srv = await bootServer(w, { ...fixedEnv(w), FAKE_EXIT_BEFORE_INIT: '1' });
  ctx.srv = srv;
  await waitReady(srv, ctx.pid);
  const m = mark('CRASH');
  const c = await startWith(srv, ctx.pid, m);
  await firstOf(c);
  const settled = await waitFor(async () => { const r = await rowOf(srv, ctx.pid, m); return r && r.state !== 'sending' ? r : null; }, mustFail ? 8000 : 60_000);
  c.close();
  const disk = onDisk(w, m);
  const atCli = tapHits(w, m);
  await stopServer(srv);
  ctx.srv = await bootServer(w, fixedEnv(w));
  await waitReady(ctx.srv, ctx.pid);
  if (mustFail) return { lost: disk.length === 0, disk, atCli };
  check('B the CLI took the prompt (stdin tap) and died before init', atCli === 1, { atCli });
  check('B the dock shows it uncertain (not confirmed), exact words', settled?.state === 'uncertain' && settled.text === m, settled && { state: settled.state, reason: settled.reason?.slice(0, 110) });
  check('B the message is on disk', disk.length > 0, disk);
}

async function armC(ctx, { mustFail = false } = {}) {
  const tag = mustFail ? 'P-C' : 'C';
  console.log(`\n--- ${tag}: the server dies between accepting the start and init${mustFail ? ' — PRE-FIX tree' : ''}`);
  const { w } = ctx;
  await stopServer(ctx.srv);
  // Fixed tree: SIGKILL itself right after the record is saved (the outbox's test crash point). Pre-fix tree has no
  // record to crash after, so it is SIGKILLed from outside right after the start frame — the same moment.
  const srv = await bootServer(w, { ...fixedEnv(w), FAKE_INIT_DELAY_MS: '20000', ...(mustFail ? {} : { ORCHARD_TEST_OUTBOX_CRASH_AT: 'start-minted' }) });
  await waitReady(srv, ctx.pid);
  const m = mark('RESTART');
  const c = await startWith(srv, ctx.pid, m);
  if (mustFail) { await sleep(300); await stopServer(srv, 'SIGKILL'); }
  const died = await waitFor(() => srv.proc.exitCode !== null || srv.proc.signalCode !== null, 15_000);
  c.close();
  if (!died) await stopServer(srv, 'SIGKILL'); // no crash point fired (a tree with no record): kill it at the same moment
  ctx.srv = await bootServer(w, fixedEnv(w));
  await sleep(1000);
  const disk = onDisk(w, m);
  if (mustFail) return { lost: disk.length === 0, disk };
  const row = await rowOf(ctx.srv, ctx.pid, m);
  check('C the server died at the crash point (right after the record was saved)', !!died && srv.proc.signalCode === 'SIGKILL', { signal: srv.proc.signalCode, exit: srv.proc.exitCode });
  check('C after the reboot the dock shows it uncertain, exact words, restart reason', row?.state === 'uncertain' && row.text === m && /restarted/.test(row.reason ?? ''), row && { state: row.state, reason: row.reason?.slice(0, 80) });
  check('C the message never reached a CLI (nothing was spawned)', tapHits(w, m) === 0, { atCli: tapHits(w, m) });
  await waitReady(ctx.srv, ctx.pid);
}

async function armD(ctx) {
  console.log('\n--- D: the tab closes after the ack, before system:init (init held 6 s)');
  const { w } = ctx;
  await stopServer(ctx.srv);
  const srv = await bootServer(w, { ...fixedEnv(w), FAKE_INIT_DELAY_MS: '6000' });
  ctx.srv = srv;
  await waitReady(srv, ctx.pid);
  const m = mark('TABCLOSE');
  const c = await startWith(srv, ctx.pid, m);
  const ack = await firstOf(c);
  c.close();
  const fin = await waitFor(async () => {
    const v = await starts(srv, ctx.pid);
    const row = v.rows?.find((r) => r.text === m);
    if (row && row.state !== 'sending') return { where: 'dock', state: row.state, reason: row.reason?.slice(0, 90) };
    const rec = v.recent?.find((r) => r.state === 'delivered' && r.startedAs && transcriptUserHits(w, r.startedAs, m) > 0);
    if (rec) return { where: 'delivered', startedAs: rec.startedAs, inTranscript: transcriptUserHits(w, rec.startedAs, m) };
    return null;
  }, 40_000);
  check('D acked, then the tab closed before init', ack?.t === 'ack', { first: ack?.t });
  check('D the message was delivered once, or is shown in the dock — never lost', !!fin && (fin.where === 'dock' ? true : fin.inTranscript === 1) && tapHits(w, m) <= 1, { fin, atCli: tapHits(w, m) });
  await stopServer(srv);
  ctx.srv = await bootServer(w, fixedEnv(w));
  await waitReady(ctx.srv, ctx.pid);
}

async function armH(ctx) {
  console.log('\n--- H: tab closed after the ack, CLI holds the prompt before init (init 25 s)');
  const { w } = ctx;
  await stopServer(ctx.srv);
  const srv = await bootServer(w, { ...fixedEnv(w), FAKE_INIT_DELAY_MS: '25000' });
  ctx.srv = srv;
  await waitReady(srv, ctx.pid);
  const m = mark('HUNG');
  const c = await startWith(srv, ctx.pid, m);
  const ack = await firstOf(c);
  await waitFor(() => tapHits(w, m) > 0 || null, 10_000);
  c.close();
  const t0 = Date.now();
  const seen = [];
  let firstVisibleMs = null, uncertainMs = null, delivered = null;
  while (Date.now() - t0 < 45_000) {
    const v = await starts(srv, ctx.pid);
    const row = v.rows?.find((r) => r.text === m);
    const rec = v.recent?.find((r) => r.state === 'delivered' && r.startedAs && transcriptUserHits(w, r.startedAs, m) > 0);
    const at = Date.now() - t0;
    seen.push(row ? row.state : rec ? 'delivered' : 'INVISIBLE');
    if (row && firstVisibleMs == null) firstVisibleMs = at;
    if (row?.state === 'uncertain' && uncertainMs == null) uncertainMs = at;
    if (rec) { delivered = { at, startedAs: rec.startedAs, inTranscript: transcriptUserHits(w, rec.startedAs, m) }; break; }
    await sleep(1000);
  }
  check('H acked; the CLI took the prompt before the tab closed', ack?.t === 'ack' && tapHits(w, m) === 1, { first: ack?.t, atCli: tapHits(w, m) });
  check('H visible in the dock within 3 s of the tab closing (never invisible while the CLI sits before init)', firstVisibleMs != null && firstVisibleMs <= 3000, { firstVisibleMs, timeline: seen.join(',') });
  check('H while that CLI lives it is never offered for a resend (stays `sending`, never uncertain/failed)', uncertainMs == null && seen.every((x) => x === 'sending' || x === 'delivered' || x === 'INVISIBLE'), { uncertainMs, timeline: seen.join(',') });
  check('H when init finally comes, the row becomes delivered (once in the transcript)', !!delivered && delivered.inTranscript === 1, delivered);
  await stopServer(srv);
  ctx.srv = await bootServer(w, fixedEnv(w));
  await waitReady(ctx.srv, ctx.pid);
}

/** Every transcript file (of any session) that holds `m` as a user row — exactly-once is "this is 1". */
function sessionsHolding(w, m) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(transcriptDir(w)).filter((f) => f.endsWith('.jsonl')); } catch { return 0; }
  for (const f of names) if (transcriptUserHits(w, f.slice(0, -6), m) > 0) n++;
  return n;
}

async function armR(ctx, signal) {
  const tag = signal === 'SIGKILL' ? 'R2' : 'R1';
  console.log(`\n--- ${tag}: the server is ${signal === 'SIGKILL' ? 'SIGKILLed' : 'restarted (SIGTERM)'} while the CLI holds the first message before init, and that CLI survives the restart (init 20 s)`);
  const { w } = ctx;
  await stopServer(ctx.srv);
  const srv = await bootServer(w, { ...fixedEnv(w), FAKE_INIT_DELAY_MS: '20000' });
  await waitReady(srv, ctx.pid);
  const m = mark(`SURVIVE-${tag}`);
  const c = await startWith(srv, ctx.pid, m);
  const ack = await firstOf(c);
  await waitFor(() => tapHits(w, m) > 0 || null, 10_000);
  const tTook = Date.now();
  await stopServer(srv, signal);
  c.close();
  ctx.srv = await bootServer(w, fixedEnv(w));
  // The attacker is the user: whenever the dock OFFERS a resend (the session list has no session with it yet), press it.
  const seen = [];
  const presses = [];
  let box = null, delivered = null;
  while (Date.now() - tTook < 60_000) {
    const v = await starts(ctx.srv, ctx.pid);
    const row = v.rows?.find((r) => r.text === m);
    if (row) box = row.box;
    const rec = box ? v.recent?.find((r) => r.box === box && r.state === 'delivered') : null;
    seen.push(row ? row.state : rec ? 'delivered' : 'INVISIBLE');
    if (row && (row.state === 'uncertain' || row.state === 'failed') && presses.length < 3) {
      const r = await api(ctx.srv, '/api/outbox/send', 'POST', { session: row.box, id: row.id });
      presses.push({ at: Date.now() - tTook, state: row.state, status: r.status });
    } else if (row?.state === 'sending' && !presses.some((p) => p.state === 'sending')) {
      const r = await api(ctx.srv, '/api/outbox/send', 'POST', { session: row.box, id: row.id });
      presses.push({ at: Date.now() - tTook, state: row.state, status: r.status });
    }
    if (rec && sessionsHolding(w, m) > 0 && Date.now() - tTook > 30_000) { delivered = rec; break; }
    await sleep(1000);
  }
  await sleep(2000);
  const holding = sessionsHolding(w, m);
  check(`${tag} acked; the CLI took the first message before the server went down`, ack?.t === 'ack', { first: ack?.t });
  check(`${tag} after the reboot the message is visible until it is delivered (never INVISIBLE)`, seen.length > 0 && !seen.slice(0, seen.indexOf('delivered') < 0 ? seen.length : seen.indexOf('delivered')).includes('INVISIBLE'), { timeline: seen.join(',') });
  check(`${tag} EXACTLY ONCE: the message is in exactly one session's transcript, however the dock was pressed`, holding === 1, { sessionsHolding: holding, atCli: tapHits(w, m), presses });
  check(`${tag} a resend is never accepted while the surviving CLI may still start the session`, !presses.some((p) => p.status === 200), { presses });
  await stopServer(ctx.srv);
  ctx.srv = await bootServer(w, fixedEnv(w));
  await waitReady(ctx.srv, ctx.pid);
}

async function armS(ctx) {
  console.log('\n--- S: a start that hangs before init (init 10 min) — visible, not resendable while it lives, Stop ends it, then Send anyway is exactly once');
  const { w } = ctx;
  await stopServer(ctx.srv);
  let srv = await bootServer(w, { ...fixedEnv(w), FAKE_INIT_DELAY_MS: '600000' });
  ctx.srv = srv;
  await waitReady(srv, ctx.pid);
  const m = mark('STOP');
  const c = await startWith(srv, ctx.pid, m);
  const ack = await firstOf(c);
  await waitFor(() => tapHits(w, m) > 0 || null, 10_000);
  c.close();
  const row = await waitFor(async () => rowOf(srv, ctx.pid, m), 5000);
  const early = row ? await api(srv, '/api/outbox/send', 'POST', { session: row.box, id: row.id }) : null;
  const stop = row ? await api(srv, '/api/outbox/stop', 'POST', { session: row.box, id: row.id }) : null;
  const after = await waitFor(async () => { const r = await rowOf(srv, ctx.pid, m); return r && r.state !== 'sending' ? r : null; }, 60_000);
  check('S visible as starting while the CLI hangs before init; a resend is refused (409) while it lives', row?.state === 'sending' && early?.status === 409, { state: row?.state, early: early?.status, err: early?.body?.error });
  check('S Stop is accepted and the row becomes not-confirmed (Send anyway / Discard) once that CLI is gone', [200, 202].includes(stop?.status) && after?.state === 'uncertain', { stop: stop?.status, stopErr: stop?.body?.error, after: after && { state: after.state, reason: after.reason?.slice(0, 100) } });
  // A healthy server again (init not delayed); Send anyway starts exactly one session.
  await stopServer(srv);
  srv = await bootServer(w, fixedEnv(w));
  ctx.srv = srv;
  await waitReady(srv, ctx.pid);
  const r2 = await rowOf(srv, ctx.pid, m);
  const send = r2 ? await api(srv, '/api/outbox/send', 'POST', { session: r2.box, id: r2.id }) : null;
  await waitFor(() => sessionsHolding(w, m) > 0 || null, 30_000);
  await sleep(2000);
  check('S Send anyway after Stop: one session holds the message, exactly once', send?.status === 200 && sessionsHolding(w, m) === 1, { send: send?.status, sessionsHolding: sessionsHolding(w, m), atCli: tapHits(w, m) });
}

async function armF(ctx, row) {
  console.log('\n--- F: Send again on the admission-failure row → exactly one new session');
  const { w, srv, pid } = ctx;
  if (!row?.box) { check('F needs arm A\'s row', false, row); return; }
  const before = tapHits(w, row.text);
  const r1 = await api(srv, '/api/outbox/send', 'POST', { session: row.box, id: row.id });
  const r2 = await api(srv, '/api/outbox/send', 'POST', { session: row.box, id: row.id });
  const rec = await waitFor(async () => (await starts(srv, pid)).recent?.find((x) => x.id === row.id && x.state === 'delivered') ?? null, 60_000);
  await waitFor(() => (rec?.startedAs && transcriptUserHits(w, rec.startedAs, row.text) > 0) || null, 20_000);
  await sleep(1500);
  check('F first Send again accepted (200); second press refused (409)', r1.status === 200 && r2.status === 409, { first: r1.status, second: r2.status, secondErr: r2.body?.error });
  check('F the row is delivered with startedAs; the dock no longer shows it', !!rec?.startedAs && !(await starts(srv, pid)).rows.some((x) => x.id === row.id), rec);
  check('F at the CLI exactly once; in the new session\'s transcript exactly once, as typed (no header)', tapHits(w, row.text) - before === 1 && transcriptUserHits(w, rec?.startedAs, row.text) === 1
    && !/\[Held /.test(JSON.stringify(fakeFirstUser(w, row.text) ?? '')), { atCli: tapHits(w, row.text) - before, inTranscript: transcriptUserHits(w, rec?.startedAs, row.text), firstLine: String(fakeFirstUser(w, row.text) ?? '').slice(0, 60) });
}
function fakeFirstUser(w, m) {
  const dir = path.dirname(w.tap); const base = path.basename(w.tap);
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`${base}.`))) {
    for (const t of fakeTap(w, Number(f.slice(base.length + 1)))) {
      if (t.m?.type !== 'user') continue;
      const c = t.m.message?.content;
      const text = Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : String(c ?? '');
      if (text.includes(m)) return text;
    }
  }
  return null;
}

async function armG(ctx) {
  console.log('\n--- G: Discard a failed first message');
  const { w, srv, pid } = ctx;
  const m = mark('DISCARD');
  fs.renameSync(w.work, `${w.work}.moved`);
  try { const c = await startWith(srv, pid, m); await firstOf(c); await sleep(400); c.close(); } finally { fs.renameSync(`${w.work}.moved`, w.work); }
  const row = await rowOf(srv, pid, m);
  const d = row ? await api(srv, '/api/outbox/discard', 'POST', { session: row.box, id: row.id }) : null;
  await sleep(1500);
  const v = await starts(srv, pid);
  check('G discarded: 200, gone from the dock, never at a CLI, its file removed', d?.status === 200 && !v.rows.some((r) => r.text === m) && tapHits(w, m) === 0
    && !fs.existsSync(path.join(w.data, 'outbox', `${row?.box}.jsonl`)), { status: d?.status, inDock: v.rows.some((r) => r.text === m), atCli: tapHits(w, m) });
}

async function armV(ctx) {
  console.log('\n--- V: the real click-path in headless brave (busy project: earlier sessions, kept first messages)');
  const { w, srv, pid } = ctx;
  const { chromium } = await import('playwright');
  const os = await import('node:os');
  const BRAVE = process.env.BRAVE_BIN || path.join(os.homedir(), '.local', 'bin', 'brave');
  // Busy state: two ordinary sessions already exist (arm N / F ran), plus two kept first messages, one long.
  const long = `${mark('V-LONG')} please refactor the uploader so that retries back off exponentially, the progress bar survives a reload, and the error toast names the file that failed — then run the tests and tell me what broke.\nSecond paragraph with more detail about the edge cases we hit last week.`;
  const short = mark('V-SHORT');
  const typed = mark('V-TYPED');
  fs.renameSync(w.work, `${w.work}.moved`);
  let browser = null;
  try {
    for (const t of [long, short]) { const c = await startWith(srv, pid, t); await firstOf(c); await sleep(300); c.close(); }
    browser = await chromium.launch({ headless: true, executablePath: BRAVE, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
    await page.goto(`http://127.0.0.1:${srv.port}/#/project/${encodeURIComponent(pid)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((p) => window.__station?.state?.current?.projectId === p && !window.__station.state.current.sessionId, pid, { timeout: 45_000 });
    const dockRows = () => page.evaluate(() => [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({
      text: r.querySelector('.qedit')?.value ?? '', status: r.querySelector('.qs')?.textContent ?? '',
      acts: [...r.querySelectorAll('.qracts button')].map((b) => b.textContent),
    })));
    const seen = await page.waitForFunction((ts) => { const v = [...document.querySelectorAll('#queueBox .qrow .qedit')].map((x) => x.value); return ts.every((t) => v.includes(t)); }, [long, short], { timeout: 20_000 }).then(() => true, () => false);
    check('V the new-session view\'s dock shows the project\'s kept first messages (no reload of the sending tab needed)', seen, await dockRows());
    // Type a first message into the real composer while admission fails.
    await page.evaluate((t) => { const p = document.querySelector('#prompt'); p.value = t; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, typed);
    const inDock = await page.waitForFunction((t) => [...document.querySelectorAll('#queueBox .qrow .qedit')].some((x) => x.value === t), typed, { timeout: 20_000 }).then(() => true, () => false);
    const composer = await page.evaluate(() => document.querySelector('#prompt').value);
    const rows = await dockRows();
    const mine = rows.find((r) => r.text === typed);
    check('V the refused start: the words are in the dock as "Not sent" with Send again / Edit / Discard, and the composer is NOT refilled',
      inDock && composer === '' && /^Not sent/.test(mine?.status ?? '') && ['Send again', 'Edit', 'Discard'].every((a) => mine?.acts.includes(a)), { composer, mine, rowCount: rows.length });
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [520, 'light'], [520, 'dark']]) {
        await page.setViewportSize({ width, height: 860 });
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await sleep(300);
        await page.screenshot({ path: path.join(SHOTS, `BUG-253-dock-${width}-${theme}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 860 });
    }
    const layout = await page.evaluate(() => [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({ over: r.scrollWidth - r.clientWidth })));
    check('V no dock row overflows horizontally at 1280 px', layout.every((x) => x.over <= 1), layout);
    // Restore the project dir, then Send again from the dock on the typed row.
    fs.renameSync(`${w.work}.moved`, w.work);
    const before = tapHits(w, typed);
    await page.evaluate((t) => {
      const row = [...document.querySelectorAll('#queueBox .qrow')].find((r) => r.querySelector('.qedit')?.value === t);
      [...row.querySelectorAll('.qracts button')].find((b) => b.textContent === 'Send again').click();
    }, typed);
    const gone = await page.waitForFunction((t) => ![...document.querySelectorAll('#queueBox .qrow .qedit')].some((x) => x.value === t), typed, { timeout: 60_000 }).then(() => true, () => false);
    await waitFor(() => tapHits(w, typed) > before || null, 30_000);
    await sleep(1500);
    check('V Send again from the dock: the row leaves the dock, the message reaches a CLI exactly once', gone && tapHits(w, typed) - before === 1, { gone, atCli: tapHits(w, typed) - before });
    // Discard the short one from the dock.
    await page.evaluate((t) => {
      const row = [...document.querySelectorAll('#queueBox .qrow')].find((r) => r.querySelector('.qedit')?.value === t);
      [...row.querySelectorAll('.qracts button')].find((b) => b.textContent === 'Discard').click();
    }, short);
    const dropped = await page.waitForFunction((t) => ![...document.querySelectorAll('#queueBox .qrow .qedit')].some((x) => x.value === t), short, { timeout: 15_000 }).then(() => true, () => false);
    await sleep(1500);
    const sv = await starts(srv, pid);
    check('V Discard from the dock: gone in the tab and on the server, never sent', dropped && !sv.rows.some((r) => r.text === short) && tapHits(w, short) === 0, { dropped, serverRows: sv.rows.map((r) => r.text.slice(0, 20)) });
    check('V no page errors', errs.length === 0, errs);
  } finally {
    if (fs.existsSync(`${w.work}.moved`)) fs.renameSync(`${w.work}.moved`, w.work);
    if (browser) await browser.close();
  }
}

async function armU() {
  console.log('\n--- U: in-process — attempts, first-settle-wins, reload, Send again once');
  const os = await import('node:os');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'b253-u-'));
  const savedData = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = data;
  const quiet = console.error; console.error = () => {};
  try {
    const lanes = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'lanes.ts')).href);
    const c = await lanes.claimWriter();
    if (!c.ok) throw new Error(`could not take the scratch data dir lock: ${c.reason}`);
    let n = 0;
    const load = () => import(`${pathToFileURL(path.join(ROOT, 'src', 'server', 'outbox.ts')).href}?b253u=${++n}`);
    let release = null;
    const handed = [];
    const wiring = {
      probe: () => ({ kind: 'go', route: 'new' }),
      reserve: () => () => {},
      handOver: (sid, go, prompt) => { handed.push(prompt); return new Promise((r) => { release = r; }); },
      transcriptHas: () => null, transcriptSize: () => null, interrupt: () => null, announce: () => {},
    };
    let m = await load();
    m.startOutbox(wiring);
    const req = { projectId: 'p-u', text: 'U-first-message', overrides: null, templateIds: null };
    // U1: attempt 1 fails before init → Send again (attempt 2 in flight) → attempt 1's orphan inits late.
    const r1 = m.mintStartRow(req);
    m.settleStartRow(r1.box, r1.id, 1, { kind: 'uncertain', reason: 'test' });
    m.sendOutboxRow(r1.box, r1.id);
    await waitFor(() => release, 3000, 20);
    const midRow = m.outboxRow(r1.box, r1.id);
    m.settleStartRow(r1.box, r1.id, 1, { kind: 'started', sdkSessionId: 'orphan-1' });
    const afterLate = m.outboxRow(r1.box, r1.id);
    release({ kind: 'failed', reason: 'attempt 2 did not start' });
    await sleep(100);
    const fin = m.outboxRow(r1.box, r1.id);
    check('U1 an older attempt\'s late init does not settle the Send-again attempt (recorded as alsoStartedAs)',
      midRow?.state === 'sending' && midRow?.attempt === 2 && afterLate?.state === 'sending' && JSON.stringify(afterLate?.alsoStartedAs) === '["orphan-1"]' && fin?.state === 'failed',
      { mid: midRow && { state: midRow.state, attempt: midRow.attempt }, afterLate: afterLate && { state: afterLate.state, alsoStartedAs: afterLate.alsoStartedAs }, final: fin?.state, handedAsTyped: handed[0] === 'U-first-message' });
    // U2: first settle wins; a delivered start leaves no file.
    const r2 = m.mintStartRow({ ...req, text: 'U-second' });
    m.settleStartRow(r2.box, r2.id, 1, { kind: 'started', sdkSessionId: 'sess-2' });
    m.settleStartRow(r2.box, r2.id, 1, { kind: 'uncertain', reason: 'late close' });
    const r2row = m.outboxRow(r2.box, r2.id);
    check('U2 first settle wins (delivered stays delivered) and the finished box file is removed',
      r2row?.state === 'delivered' && r2row?.startedAs === 'sess-2' && !fs.existsSync(path.join(data, 'outbox', `${r2.box}.jsonl`)), { state: r2row?.state, startedAs: r2row?.startedAs });
    // U3: a `sending` start row survives a restart as uncertain; Send again is once.
    const r3 = m.mintStartRow({ ...req, text: 'U-third' });
    m.stopOutbox();
    m = await load();
    let holdForever = false;
    m.startOutbox({ ...wiring, probe: () => (holdForever ? { kind: 'wait', hold: { kind: 'test', text: 'held' } } : { kind: 'go', route: 'new' }) });
    holdForever = true;
    const reloaded = m.startsView('p-u').rows.find((r) => r.id === r3.id);
    let second = null;
    m.sendOutboxRow(r3.box, r3.id);
    try { m.sendOutboxRow(r3.box, r3.id); } catch (e) { second = e.status; }
    check('U3 a sending start row reloads uncertain (restart reason, exact words); a second Send again is 409',
      reloaded?.state === 'uncertain' && /restarted/.test(reloaded?.reason ?? '') && reloaded?.text === 'U-third' && second === 409, { state: reloaded?.state, second });
    // U4: a client can never mint a start-box row through the ordinary create.
    let refused = null;
    try { m.createOutboxRow(r3.box, { nonce: 'n-forged-123456', text: 'forged', resume: { projectId: 'p-u', encodedDir: null, overrides: null, templateIds: null } }); } catch (e) { refused = e.status; }
    check('U4 createOutboxRow refuses a start box id (400)', refused === 400, { refused });
    m.stopOutbox();
  } catch (e) {
    check('U ran', false, String(e?.stack ?? e));
  } finally {
    console.error = quiet;
    if (savedData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = savedData;
  }
}

/* ------------------------------------------------------------------ main */
const t0 = Date.now();
let ctx = null;
let pctx = null;
try {
  if (want('U') && !AGAINST_PREFIX) await armU();
  if (['N', 'A', 'B', 'C', 'D', 'F', 'G', 'V', 'H', 'R', 'S'].some(want)) {
    if (AGAINST_PREFIX) console.log('=== --against-prefix: every arm below runs on the SYNTHESIZED pre-fix tree and must FAIL');
    ctx = await world('b253', AGAINST_PREFIX ? preFixTree() : ROOT);
    if (want('N')) await armN(ctx);
    let aRow = null;
    if (want('A') || want('F')) aRow = await armA(ctx);
    if (want('F')) await armF(ctx, aRow);
    if (want('G')) await armG(ctx);
    if (want('V')) await armV(ctx);
    if (want('B')) await armB(ctx);
    if (want('C')) await armC(ctx);
    if (want('D')) await armD(ctx);
    if (want('H')) await armH(ctx);
    if (want('R')) { await armR(ctx, 'SIGTERM'); await armR(ctx, 'SIGKILL'); }
    if (want('S')) await armS(ctx);
  }
  if (want('P') && !AGAINST_PREFIX) {
    console.log('\n=== MUST-FAIL: the same failure paths on a SYNTHESIZED pre-fix tree (the start records nothing)');
    pctx = await world('b253-prefix', preFixTree());
    const pa = await armA(pctx, { mustFail: true });
    const pb = await armB(pctx, { mustFail: true });
    const pc = await armC(pctx, { mustFail: true });
    check('P pre-fix LOSES the message on admission failure (found nowhere on disk)', pa.lost, pa);
    check('P pre-fix LOSES the message when the CLI dies before init', pb.lost, pb);
    check('P pre-fix LOSES the message when the server dies before init', pc.lost, pc);
  }
  if (want('K') && !AGAINST_PREFIX) {
    const { runContainerArms } = await import('./lib/bug-253-container-arms.mjs');
    await runContainerArms({ check, mark, filesHolding, skip: NO_CONTAINER });
  }
} catch (err) {
  check('the suite ran to completion', false, (err && err.stack) || String(err));
} finally {
  for (const c of [ctx, pctx]) if (c) await cleanupWorld(c.w);
  for (const d of scratchTrees) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(`\nBUG-253 verify: ${pass} passed, ${fail} failed (${Math.round((Date.now() - t0) / 1000)}s)`);
if (failures.length) console.log(`FAILED: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
