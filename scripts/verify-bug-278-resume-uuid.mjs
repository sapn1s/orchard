#!/usr/bin/env node
/**
 * BUG-278 r14 — a send identity (uuid) is NEVER reused within a session's
 * transcript, EVEN ACROSS A RESUME.
 *
 * THE EDGE (independent-verify run e132b141, r13 IV#4): the server's send-uuid
 * uniqueness guard (`AgentSession.#sentUuids`) lived only in the live session
 * OBJECT. A fresh AgentSession — which every RESUME creates — started that set
 * empty, so a resumed/replayed client uuid ALREADY PRESENT in the session's
 * transcript was adopted verbatim and WRITTEN A SECOND TIME: one identity, two
 * transcript entries, which the r13 identity-keyed optimistic-bubble reconcile
 * cannot tell apart.
 *
 * THE FIX (close by construction, ARCH-010): `startSession` SEEDS `#sentUuids`
 * from the transcript the resume continues (`collectTranscriptUuids`, reading
 * the transcript that OWNS which ids are taken). A duplicate is then rejected
 * server-side and replaced with a freshly minted uuid, echoed on the ack so the
 * client rebinds its optimistic bubble.
 *
 * CONTRACT PROVEN HERE: a uuid is never reused within a session's transcript —
 * across the first turn, a resume that replays the first uuid, a send into the
 * resumed session that replays it, and two sends carrying one id into a live
 * session. Driven at the REAL WS protocol against a REAL server + the
 * schema-validated fake codex app-server (Orchard-recorded transcript — the
 * exact engine the e132b141 verifier reproduced on, where Orchard owns the
 * entry uuid). The Claude-CLI persistedTranscript path is covered by the SAME
 * transcript read in `collectTranscriptUuids` but is not runnable in-lane (real
 * CLI); noted, not asserted.
 *
 *   node scripts/verify-bug-278-resume-uuid.mjs            # the FIX (all PASS)
 *   node scripts/verify-bug-278-resume-uuid.mjs --broken   # the must-FAIL witness
 *
 * `--broken` spawns the server from a scratch COPY of the tree with the r14 seed
 * line removed by an anchored replacement (throws LOUDLY if the anchor is gone,
 * so it can never silently run the fixed code). Not a HEAD export: the r14 fix
 * is uncommitted, so no named commit carries the pre-fix bridge.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const ARGV = process.argv.slice(2);
const BROKEN = ARGV.includes('--broken');
const KEEP = ARGV.includes('--keep');
const RESUME_THREAD = 'thr_fixture_0001'; // the fake's thread/start id (codex-app-server.fixtures.json)

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const tmpDirs = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `b278ru-${tag}-`)); tmpDirs.add(d); return d; }

const servers = new Set();
function startServer(entry, cwd, port, dataDir, env = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function registerProject(port, workDir, name) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: workDir, name, isolation: 'direct' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'openai', model: null, permissionMode: 'bypassPermissions' } }),
  });
  return reg.project.id;
}

/* A thin WS client: collects frames, waits for a predicate, sends commands. */
async function openWs(port) {
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* non-JSON */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ws, frames,
    send(obj) { ws.send(JSON.stringify(obj)); },
    async waitFor(pred, ms = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
    close() { try { ws.terminate(); } catch { /* */ } },
    /*
     * Send a `start` and wait for its ack, RETRYING while the server reports the
     * transient boot-time `runtime-check-pending` block (the browser client does
     * the same — it retries on the structured code, never on the prose). Returns
     * the ack frame, or null on timeout.
     */
    async startAcked(frame, ms = 45000) {
      const t0 = Date.now();
      let fromIdx = 0;
      while (Date.now() - t0 < ms) {
        this.send(frame);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const ack = frames.slice(fromIdx).find((f) => f.t === 'ack' && f.of === 'start');
          if (ack) return ack;
          const pend = frames.slice(fromIdx).find((f) => f.t === 'error' && f.code === 'runtime-check-pending');
          if (pend) { fromIdx = frames.length; break; } // boot check not done — resend
          const fatal = frames.slice(fromIdx).find((f) => f.t === 'error' && f.fatal && f.code !== 'runtime-check-pending');
          if (fatal) return null;
          await sleep(100);
        }
      }
      return null;
    },
  };
}

/* The Orchard-owned transcript on disk: all persisted entries {type,uuid}, in order. */
function transcriptEntries(dataDir) {
  const base = path.join(dataDir, 'transcripts', 'openai');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  const entries = [];
  for (const d of dirs) {
    const file = path.join(base, d, `${RESUME_THREAD}.jsonl`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { const o = JSON.parse(s); if (typeof o.uuid === 'string') entries.push({ type: o.type, uuid: o.uuid }); } catch { /* partial */ }
    }
  }
  return entries;
}
function transcriptUuids(dataDir) { return transcriptEntries(dataDir).map((e) => e.uuid); }
async function waitUuidCount(dataDir, n, ms = 20000) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < ms) {
    last = transcriptUuids(dataDir);
    if (last.length >= n) return last;
    await sleep(100);
  }
  return last;
}

/* Build a scratch copy of the tree with the r14 seed removed (must-FAIL). */
function buildBrokenTree() {
  const dst = mkTmp('broken');
  // Copy only what the server needs to run; symlink node_modules (one dir).
  const rc = spawnSync('cp', ['-a',
    path.join(ROOT, 'src'), path.join(ROOT, 'scripts'), path.join(ROOT, 'public'),
    path.join(ROOT, 'package.json'), path.join(ROOT, 'tsconfig.json'),
    dst], { stdio: 'inherit' });
  if (rc.status !== 0) throw new Error('cp of tree failed');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dst, 'node_modules'));
  // docs are read at boot (seedTemplates reads docs/prompts); copy all of docs
  // EXCEPT the 92MB docs/bugs board (not needed to start a scratch session).
  fs.mkdirSync(path.join(dst, 'docs'));
  for (const name of fs.readdirSync(path.join(ROOT, 'docs'))) {
    if (name === 'bugs') continue;
    const rcd = spawnSync('cp', ['-a', path.join(ROOT, 'docs', name), path.join(dst, 'docs', name)], { stdio: 'inherit' });
    if (rcd.status !== 0) throw new Error(`cp of docs/${name} failed`);
  }
  // Re-break: delete the r14 guarantees by exact anchored replacement. Each
  // anchor MUST be present or the harness throws, so it can never silently run
  // the fixed tree. Three anchors reproduce the pre-r14 state:
  //   (1) the resume seed, (2) the recorder onEntry keep-current, (3) the
  //   persistedTranscript live keep-current.
  const bridge = path.join(dst, 'src', 'server', 'agent-bridge.ts');
  let src = fs.readFileSync(bridge, 'utf8');
  const ANCHORS = [
    ['      for (const u of collectTranscriptUuids(dirCandidates, rid)) this.#sentUuids.add(u);',
     '      /* r14 resume-seed removed for the must-FAIL witness */'],
    ['        onEntry: (uuid) => { this.#sentUuids.add(uuid); },',
     '        /* r14 onEntry keep-current removed for the must-FAIL witness */'],
    ['    if (this.#runtime.capabilities.persistedTranscript && isCanonicalUuid(m.uuid)) this.#sentUuids.add(m.uuid);',
     '    /* r14 live keep-current removed for the must-FAIL witness */'],
  ];
  for (const [a, repl] of ANCHORS) {
    if (!src.includes(a)) throw new Error(`broken-mode anchor missing — an r14 line changed; update this harness so it can never silently run the fixed tree:\n  ${a}`);
    src = src.replace(a, repl);
  }
  fs.writeFileSync(bridge, src);
  // (4) the non-gated reattach uuid echo (index.ts): drop the echo so a replayed
  // id the guard replaced is NOT reported back (the r14 IV#2 finding).
  const index = path.join(dst, 'src', 'server', 'index.ts');
  let isrc = fs.readFileSync(index, 'utf8');
  const IDX_ANCHOR = '                reattach(running, startUuid && sent.uuid !== startUuid ? { uuid: sent.uuid } : {});';
  if (!isrc.includes(IDX_ANCHOR)) throw new Error(`broken-mode anchor missing (index.ts reattach echo) — update this harness:\n  ${IDX_ANCHOR}`);
  fs.writeFileSync(index, isrc.replace(IDX_ANCHOR, '                reattach(running); /* r14 reattach echo removed for the must-FAIL witness */'));
  return { entry: path.join(dst, 'src', 'server', 'index.ts'), cwd: dst };
}

async function main() {
  console.log(`\n===== BUG-278 r14 — resume/replay send-uuid uniqueness (${BROKEN ? 'BROKEN witness' : 'FIX'}) =====`);
  const { entry, cwd } = BROKEN ? buildBrokenTree() : { entry: path.join(ROOT, 'src', 'server', 'index.ts'), cwd: ROOT };

  const port = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  fs.writeFileSync(path.join(WORK, 'CLAUDE.md'), '# scratch\n');
  fs.writeFileSync(path.join(WORK, 'package.json'), '{"name":"b278ru-work","version":"0.0.0"}\n');

  const srv = startServer(entry, cwd, port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE,
    CLAUDE_STATION_SURVIVE: '0',
    CLAUDE_STATION_WS_PING_MS: '0',
    CODEX_FAKE_EXPECT_RESUME: RESUME_THREAD,
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b278ru');

  const U1 = '11111111-2222-4333-8444-555555555555'; // the e132b141 duplicate id (canonical)

  // ---- First turn: a plain prompt carrying U1. ----
  const a = await openWs(port);
  const ack1 = await a.startAcked({ type: 'start', projectId, prompt: 'turn one', uuid: U1 });
  if (!ack1) console.log('DEBUG frames:', JSON.stringify(a.frames.slice(0, 20)));
  check('L0: a unique canonical client uuid is adopted VERBATIM on the first start', ack1?.uuid === U1, { acked: ack1?.uuid, sent: U1 });
  const after1 = await waitUuidCount(DATA, 1);
  check('L0: the first user entry carrying U1 is persisted', after1.includes(U1), { uuids: after1 });
  a.close();
  await sleep(1200); // let the first session's engine child exit (SURVIVE=0)

  // ---- Resume the SAME session, replaying U1 on the resume start frame. ----
  const encodedDir = fs.readdirSync(path.join(DATA, 'transcripts', 'openai'))[0];
  const b = await openWs(port);
  const ack2 = await b.startAcked({ type: 'start', projectId, prompt: 'turn two (resumed)', resumeSessionId: RESUME_THREAD, resumeEncodedDir: encodedDir, uuid: U1 });
  const resumedUuid = ack2?.uuid;
  if (BROKEN) {
    check('L1 (BROKEN witness): the resumed duplicate U1 is adopted verbatim — NOT replaced', resumedUuid === U1, { resumedUuid });
  } else {
    check('L1 (FIX): the resumed duplicate U1 is REPLACED with a fresh canonical uuid',
      typeof resumedUuid === 'string' && CANON.test(resumedUuid) && resumedUuid !== U1, { resumedUuid });
  }
  const after2 = await waitUuidCount(DATA, after1.length + 1, 25000);
  const u1Count = after2.filter((u) => u === U1).length;
  check(`L1: U1 appears EXACTLY ONCE in the transcript (observed ${u1Count}×)`, u1Count === 1, { u1Count, total: after2.length });

  // Wait for the resumed turn to finish so a follow-up send is a clean turn.
  await b.waitFor((f) => f.t === 'turn-end', 25000);

  // ---- Replay U1 AGAIN as a `send` into the resumed (now-seeded) session. ----
  b.send({ type: 'send', prompt: 'replay U1 on send', uuid: U1, sendId: 'sR1' });
  const ackS = await b.waitFor((f) => f.t === 'ack' && f.of === 'send' && f.sendId === 'sR1', 25000);
  check('L2 (FIX): a replayed U1 on a send into the resumed session is REPLACED',
    typeof ackS?.uuid === 'string' && CANON.test(ackS.uuid) && ackS.uuid !== U1, { sendUuid: ackS?.uuid });
  await b.waitFor((f) => f.t === 'turn-end', 25000);

  // ---- Two sends carrying ONE id into the live session (two tabs colliding). ----
  const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  b.send({ type: 'send', prompt: 'tab A', uuid: U2, sendId: 'sA' });
  const ackA = await b.waitFor((f) => f.t === 'ack' && f.of === 'send' && f.sendId === 'sA', 25000);
  await b.waitFor((f) => f.t === 'turn-end', 25000);
  b.send({ type: 'send', prompt: 'tab B (same id)', uuid: U2, sendId: 'sB' });
  const ackB = await b.waitFor((f) => f.t === 'ack' && f.of === 'send' && f.sendId === 'sB', 25000);
  check('L3: the first use of U2 is adopted verbatim', ackA?.uuid === U2, { a: ackA?.uuid });
  check('L3 (FIX / r13 invariant held): the second send carrying U2 is REPLACED',
    typeof ackB?.uuid === 'string' && CANON.test(ackB.uuid) && ackB.uuid !== U2, { b: ackB?.uuid });
  await b.waitFor((f) => f.t === 'turn-end', 25000);

  // ---- Replay an ASSISTANT entry's uuid on a LIVE send (r14 IV finding:
  //      the guard must stay current as the recorder appends, not just at
  //      resume — an assistant uuid already written must not be re-handed). ----
  const assistantUuid = transcriptEntries(DATA).find((e) => e.type === 'assistant' && CANON.test(e.uuid))?.uuid;
  check('L4: PRECONDITION — an assistant entry carrying a canonical uuid is on disk to replay', !!assistantUuid, { assistantUuid });
  if (assistantUuid) {
    b.send({ type: 'send', prompt: 'replay an assistant uuid', uuid: assistantUuid, sendId: 'sAsst' });
    const ackAsst = await b.waitFor((f) => f.t === 'ack' && f.of === 'send' && f.sendId === 'sAsst', 25000);
    if (BROKEN) {
      check('L4 (BROKEN witness): a replayed ASSISTANT uuid on a live send is adopted verbatim — NOT replaced', ackAsst?.uuid === assistantUuid, { sendUuid: ackAsst?.uuid, assistantUuid });
    } else {
      check('L4 (FIX): a replayed ASSISTANT uuid on a live send is REPLACED (guard kept current as the recorder appends)',
        typeof ackAsst?.uuid === 'string' && CANON.test(ackAsst.uuid) && ackAsst.uuid !== assistantUuid, { sendUuid: ackAsst?.uuid, assistantUuid });
    }
    await b.waitFor((f) => f.t === 'turn-end', 25000);
  }
  // ---- Reattach with a replayed uuid (r14 IV#2 finding): drop the socket so the
  //      bridge is detached-but-live, then reattach with a prompt carrying a uuid
  //      already in the transcript. The replacement must be ECHOED on the ack so
  //      the client rebinds its optimistic bubble. ----
  b.close();
  const e = await openWs(port);
  const ackRe = await e.startAcked({ type: 'start', projectId, prompt: 'reattach replay', resumeSessionId: RESUME_THREAD, resumeEncodedDir: encodedDir, uuid: U1 }, 40000);
  const viaReattach = ackRe?.reattached === true;
  console.log(`  (L5 path: ${viaReattach ? 'non-gated REATTACH (detached-live bridge)' : 'full RESUME (bridge was reaped)'})`);
  if (BROKEN && viaReattach) {
    check('L5 (BROKEN witness): the reattach ack OMITS the replaced uuid — the client cannot rebind', ackRe?.uuid == null, { ackUuid: ackRe?.uuid, reattached: viaReattach });
  } else {
    check('L5 (FIX): a replayed uuid on a reattach/resume start is REPLACED and the resolved id is ECHOED on the ack',
      typeof ackRe?.uuid === 'string' && CANON.test(ackRe.uuid) && ackRe.uuid !== U1, { ackUuid: ackRe?.uuid, reattached: viaReattach });
  }
  await e.waitFor((f) => f.t === 'turn-end', 25000);
  e.close();

  // ---- THE CONTRACT: no uuid is EVER reused within the session's transcript. ----
  const finalUuids = await waitUuidCount(DATA, after1.length + 1, 5000);
  const seen = new Set();
  const dup = finalUuids.filter((u) => (seen.has(u) ? true : (seen.add(u), false)));
  if (BROKEN) {
    check('CONTRACT (BROKEN witness): the transcript DOES reuse an identity', dup.length >= 1, { duplicates: dup, uuids: finalUuids });
  } else {
    check('CONTRACT (FIX): every uuid in the session transcript is DISTINCT — no identity is reused',
      dup.length === 0, { duplicates: dup, count: finalUuids.length });
  }

  stopByPid(srv.pid);
  await sleep(800);
}

main()
  .catch((e) => { console.error('FATAL', e); fail++; failures.push(`FATAL: ${e.message}`); })
  .finally(async () => {
    for (const c of servers) stopByPid(c.pid);
    await sleep(500);
    if (!KEEP) for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — FAILURES:\n  - ${failures.join('\n  - ')}` : ''}`);
    process.exit(fail ? 1 : 0);
  });
