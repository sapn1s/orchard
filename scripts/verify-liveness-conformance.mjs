/**
 * ARCH-001 — ONE authority answers "is this thing alive / mid-turn right now".
 *
 *   node scripts/verify-liveness-conformance.mjs            # ENFORCE (the gate)
 *   node scripts/verify-liveness-conformance.mjs --record   # document, never fail
 *   node scripts/verify-liveness-conformance.mjs --runs=5   # intermittency shape
 *   node scripts/verify-liveness-conformance.mjs --guard-only [--guard-root=DIR]
 *
 * WHY THIS FILE EXISTS. Eight tickets (BUG-004/017/020/027/030/033/034/038) are
 * the same defect: a surface asserted "running" or "not running" from a partial
 * signal it computed itself. BUG-033 fixed the bridge site; the IDENTICAL bug
 * survived at the survivor site and had to be rediscovered by BUG-038 days
 * later. The sites agreed only by construction, never by enforcement. This test
 * IS the enforcement.
 *
 * THE CONTRACT IT ENFORCES (declared here, in the test, not read off the
 * implementation — so the implementation is what has to move):
 *
 *   R-A  AGREEMENT. Every site that answers the session-level question ("is a
 *        turn running behind this claim") must give the SAME answer for the
 *        same world: same `running`, same ground-truth `state`.
 *   R-B  NO COERCION. `unknown` is a first-class answer. No site may report
 *        `dead` for a world whose ground truth is `unknown` (that is how a
 *        live turn gets reaped), and none may report `alive` either.
 *   R-C  EVIDENCE SITES MAY NOT KILL. A site that observes only ONE signal
 *        (transcript mtime) may answer `alive` or `unknown` — NEVER `dead`.
 *        Silence on disk is not proof of death (BUG-033's whole lesson).
 *   R-D  NO REGROWTH. No new ad-hoc liveness check may appear outside the
 *        authority (the mechanical guard, layer 4).
 *
 * LAYERS
 *   L1  pure matrix, in-process: the real exported functions, real fixtures on
 *       a scratch dataDir / scratch transcript root. No mocks of station
 *       internals — the inputs are real HostStatus files and real file mtimes.
 *   L2a live scratch server + planted survivor records → /api/health's view.
 *   L2b live scratch server + a REAL bridge on the CodexRuntime fixture seam
 *       (a real turn that goes silent — no API cost, no pid to check) →
 *       /api/health, /api/sessions, /api/sessions/live.
 *   L3  the two directions of the send guard: a stale survivor must NEVER block
 *       a send; a genuinely mid-turn one must ALWAYS block it.
 *   L4  the regrowth guard (mechanical; also runnable standalone).
 *
 * SAFETY: free ports, scratch dataDirs, scratch CLAUDE_PROJECTS_DIR, kill by
 * pid only. :4317 and the user's real service are never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

const ARGV = process.argv.slice(2);
const RECORD = ARGV.includes('--record');
const GUARD_ONLY = ARGV.includes('--guard-only');
const GUARD_ROOT = (ARGV.find((a) => a.startsWith('--guard-root=')) ?? '').split('=')[1] || path.join(ROOT, 'src', 'server');
const RUNS = Number((ARGV.find((a) => a.startsWith('--runs=')) ?? '--runs=1').split('=')[1]) || 1;
const ONLY = (ARGV.find((a) => a.startsWith('--layer=')) ?? '').split('=')[1] || null;

let pass = 0, fail = 0;
const failures = [];
/** In --record mode a violation is REPORTED, never failed: that output is the ticket's evidence. */
const findings = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  if (!ok && RECORD) {
    findings.push({ name, observed: line });
    console.log(`  DISAGREE  ${name}\n        observed: ${line}`);
    return;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ scratch */

const tmpDirs = new Set();
const dummies = new Set();
const servers = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-arch1-${tag}-`)); tmpDirs.add(d); return d; }
/** A guaranteed-dead pid: an exited pid can be recycled by the OS mid-test. */
const DEAD_PID = 1999999;
function liveDummy() {
  const p = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  p.unref();
  dummies.add(p);
  return p.pid;
}
function stopByPid(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
function cleanup() {
  for (const p of dummies) stopByPid(p.pid);
  for (const s of servers) if (s.exitCode === null) stopByPid(s.pid);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('exit', cleanup);

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ============================================================================
 * THE MATRIX — worlds and the contract they must produce.
 *
 * Each world is a real on-disk / in-memory situation. `expect` is the CONTRACT,
 * in TWO parts, because there are two questions and conflating them is itself
 * one of this class's mistakes:
 *   process: is a live PROCESS behind this record? 'alive'|'dead'|'unknown' —
 *            what the probe-class sites (S3/S4/S5, processProbe) answer.
 *   running: is a TURN in flight right now? true|false|null(moot) — what the
 *            session-class sites (S1, S7, S8, the authority) answer, together
 *            with `state`, the ground truth their verdict must carry.
 * Each site is compared ONLY against the question it exists to answer; an
 * evidence-only site (S6, transcript mtime) is held to R-C alone.
 * ==========================================================================*/

const MIN = 60_000;

/**
 * host(kind) builds a real HostStatus record.
 *  live   — broker + CLI both alive, mid-turn: the ONLY genuinely-running shape.
 *  exited — broker recorded its CLI's exit (BUG-038's live incident).
 *  deadCli— broker process lingers, CLI gone (BUG-038's planted repro).
 *  gone   — broker process itself gone.
 */
function makeHost(kind, hostsDir, sdkSessionId) {
  const key = `h-${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const statusPath = path.join(hostsDir, `${key}.json`);
  const brokerAlive = kind !== 'gone';
  const st = {
    hostPid: brokerAlive ? liveDummy() : DEAD_PID,
    claudePid: kind === 'deadCli' ? DEAD_PID : (kind === 'gone' ? DEAD_PID : liveDummy()),
    sock: path.join(hostsDir, `${key}.sock`),
    status: statusPath,
    sdkSessionId,
    resumeHint: sdkSessionId,
    state: kind === 'exited' ? 'exited' : 'draining',
    exitCode: kind === 'exited' ? 0 : null,
    signal: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(hostsDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(st), { mode: 0o600 });
  return st;
}

/**
 * The worlds. `bridge` describes an in-memory AgentSession claim; `host` names
 * the HostStatus shape backing it (also the survivor record on disk);
 * `transcriptAgeMs` the last append to its .jsonl.
 */
const WORLDS = [
  {
    id: 'W01-alive-and-chatty',
    what: 'a real turn: CLI alive, frames flowing, transcript being appended',
    bridge: { busy: true, closed: false, silentMs: 2_000 }, host: 'live', transcriptAgeMs: 2_000,
    expect: { process: 'alive', running: true, state: 'alive' },
  },
  {
    id: 'W02-alive-but-silent',
    what: 'BUG-033 false-positive guard: CLI verified alive, 20min inside one silent tool call, disk quiet',
    bridge: { busy: true, closed: false, silentMs: 20 * MIN }, host: 'live', transcriptAgeMs: 20 * MIN,
    expect: { process: 'alive', running: true, state: 'alive' },
  },
  {
    id: 'W03-dead-pid',
    what: 'the reported incident: CLI killed mid-turn, no terminal frame, bridge still says busy',
    bridge: { busy: true, closed: false, silentMs: 30_000 }, host: 'deadCli', transcriptAgeMs: 30_000,
    expect: { process: 'dead', running: false, state: 'dead' },
  },
  {
    id: 'W04-broker-exited',
    what: "BUG-038 live incident: the broker recorded its CLI's exit; its own process still lingers",
    bridge: { busy: true, closed: false, silentMs: 30_000 }, host: 'exited', transcriptAgeMs: 5 * MIN,
    expect: { process: 'dead', running: false, state: 'dead' },
  },
  {
    id: 'W05-broker-gone',
    what: 'the broker process itself is gone (its record has not been swept yet)',
    bridge: null, host: 'gone', transcriptAgeMs: 30 * MIN,
    expect: { process: 'dead', running: false, state: 'dead' },
  },
  {
    id: 'W06-survivor-mid-turn',
    what: 'a genuinely draining survivor after a restart — must keep blocking a second CLI (BUG-022)',
    bridge: null, host: 'live', transcriptAgeMs: 3_000,
    expect: { process: 'alive', running: true, state: 'alive' },
  },
  {
    id: 'W07-unknown-in-window',
    what: 'SDK-owned child: no pid knowable, last frame 10s ago — unknown, and NOT to be reaped',
    bridge: { busy: true, closed: false, silentMs: 10_000, probe: 'unknown' }, host: null, transcriptAgeMs: 10_000,
    expect: { process: 'unknown', running: true, state: 'unknown' },
  },
  {
    id: 'W08-unknown-frameless',
    what: 'SDK-owned child silent past the frameless window: still NOT proven dead — refuse, do not race',
    bridge: { busy: true, closed: false, silentMs: 20 * MIN, probe: 'unknown' }, host: null, transcriptAgeMs: 20 * MIN,
    expect: { process: 'unknown', running: false, state: 'unknown' },
  },
  {
    id: 'W09-idle-bridge',
    what: 'a live bridge with no turn in flight — alive, but nothing running',
    bridge: { busy: false, closed: false, silentMs: 5 * MIN }, host: 'live', transcriptAgeMs: 5 * MIN,
    expect: { process: 'alive', running: false, state: 'alive' },
  },
  {
    id: 'W10-closed-bridge',
    what: 'a closed bridge — nothing may still claim to run (close() reaps its broker, so no record survives it)',
    bridge: { busy: true, closed: true, silentMs: 1_000 }, host: null, transcriptAgeMs: 1_000,
    expect: { process: 'unknown', running: false, state: 'dead' },
  },
  {
    id: 'W11-status-absent-after-connect',
    what: 'the broker deleted its status file on the way out (BUG-023) — absence AFTER a connect is proof',
    handle: { everConnected: true, status: null }, transcriptAgeMs: 10 * MIN,
    expect: { process: 'dead', running: false, state: 'dead' },
  },
  {
    id: 'W12-status-absent-before-connect',
    what: 'the broker has not reported yet — absence BEFORE any connect proves nothing',
    handle: { everConnected: false, status: null }, transcriptAgeMs: 1_000,
    expect: { process: 'unknown', running: null, state: 'unknown' },
  },
  {
    id: 'W13-transcript-only-fresh',
    what: 'an external terminal appending right now: something IS writing, no process we can name',
    bridge: null, host: null, transcriptAgeMs: 2_000,
    expect: { process: 'unknown', running: true, state: 'alive' },
  },
  {
    id: 'W14-transcript-only-stale',
    what: 'no bridge, no host, quiet file — UNKNOWN, never "dead" (R-C)',
    bridge: null, host: null, transcriptAgeMs: 30 * MIN,
    expect: { process: 'unknown', running: false, state: 'unknown' },
  },
];

/* ------------------------------------------------- site answer normalisation
 * Every site is reduced to {running, state}. Sites that can only return a
 * BOOLEAN are mapped the way their CALLERS read them: true → alive/running,
 * false → dead/not-running. That mapping is not a rhetorical trick — it is
 * exactly the coercion this whole class of bug is made of, and naming it is
 * the point.
 */
const NA = { running: null, state: null, na: true };

/* ============================================================== L1 pure matrix */

async function layer1(iteration) {
  console.log(`\n===== L1 — the matrix, in-process against the real exports (run ${iteration}) =====`);
  const DATA = mkTmp('l1-data');
  const PROJ = mkTmp('l1-proj');
  process.env.CLAUDE_STATION_DATA = DATA;
  process.env.CLAUDE_PROJECTS_DIR = PROJ;

  const survival = await import(path.join(ROOT, 'src', 'server', 'survival.ts'));
  const watcher = await import(path.join(ROOT, 'src', 'server', 'watcher.ts'));
  const bridgeMod = await import(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'));
  let authority = null;
  try { authority = await import(path.join(ROOT, 'src', 'server', 'liveness.ts')); } catch { /* pre-refactor */ }

  const hostsDir = path.join(DATA, 'session-hosts');
  const encodedDir = 'arch001-scratch';
  fs.mkdirSync(path.join(PROJ, encodedDir), { recursive: true });

  for (const w of WORLDS) {
    // Every world gets its OWN hosts dir + transcript so sites cannot see each
    // other's fixtures (scanSurvivingHosts reads the whole directory).
    const wDir = path.join(hostsDir, w.id);
    fs.mkdirSync(wDir, { recursive: true });
    process.env.CLAUDE_STATION_DATA = path.join(DATA, w.id);
    fs.mkdirSync(path.join(DATA, w.id, 'session-hosts'), { recursive: true });
    const myHosts = path.join(DATA, w.id, 'session-hosts');

    const sdkSessionId = `arch001-${w.id}`;
    const st = w.host ? makeHost(w.host, myHosts, sdkSessionId) : null;

    // Real transcript file with a real mtime.
    const tFile = path.join(PROJ, encodedDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(tFile, '{"type":"user"}\n');
    if (w.transcriptAgeMs != null) {
      const when = new Date(Date.now() - w.transcriptAgeMs);
      fs.utimesSync(tFile, when, when);
    }

    const answers = {};

    /* --- S4: the survivor probe over a HostStatus. Pre-ARCH-001 this was
     *        `survival.probeSurvivorHost()`, a second implementation of the
     *        bridge site's rungs; it is now the authority's `livenessOfSurvivor`
     *        and the survival module has no probe of its own left. */
    if (st) {
      const p = (authority?.livenessOfSurvivor ?? survival.probeSurvivorHost)(st);
      answers.S4_survivorProbe = { cls: 'probe', running: p.state === 'alive', state: p.state, detail: p.reason ?? p.detail };
    } else answers.S4_survivorProbe = NA;

    /* --- S5: scanSurvivingHosts() membership — a survivor in this list is
     *        presented (by /api/health and by the send guard's lookup) as a
     *        session still finishing its turn. Membership IS a liveness claim. */
    if (st) {
      const member = survival.scanSurvivingHosts().some((h) => h.sdkSessionId === sdkSessionId);
      answers.S5_scanSurvivingHosts = { cls: 'probe', running: member, state: member ? 'alive' : 'dead' };
    } else answers.S5_scanSurvivingHosts = NA;

    /* --- S1: AgentSession.livenessVerdict() — called on a structural stand-in
     *        so the world's process probe is the REAL one for that world
     *        (probeSurvivorHost over the planted record), not a mock verdict. */
    const probeOf = () => {
      if (w.bridge?.probe === 'unknown' || !st) return { state: 'unknown', detail: 'this engine child is owned by the SDK and exposes no pid to check' };
      const v = (authority?.livenessOfSurvivor ?? survival.probeSurvivorHost)(st);
      return { state: v.state, detail: v.reason ?? v.detail };
    };
    if (w.bridge) {
      const now = Date.now();
      const fake = {
        closed: w.bridge.closed,
        busy: w.bridge.busy,
        lastFrameAt: now - w.bridge.silentMs,
        turnStartedAt: w.bridge.busy ? now - w.bridge.silentMs : null,
        processProbe: probeOf,
      };
      const v = bridgeMod.AgentSession.prototype.livenessVerdict.call(fake, now);
      answers.S1_livenessVerdict = {
        cls: 'session',
        running: v.running ?? (v.live && !!w.bridge.busy && !w.bridge.closed),
        state: v.state ?? stateFromKind(v.kind, probeOf().state),
        kind: v.kind,
      };
    } else answers.S1_livenessVerdict = NA;

    /* --- S3: SurvivalHandle.probe()'s rungs (exit latch / status-file absence).
     *        Pre-refactor this site lives inside a closure created only by a
     *        real systemd-run spawn and CANNOT be called by a test — recorded
     *        as such, which is itself a finding. Post-refactor it is a pure
     *        delegation to the authority and becomes checkable. */
    if (w.handle) {
      if (authority?.livenessOfSurvivalHandle) {
        const p = authority.livenessOfSurvivalHandle({ exitLatched: false, everConnected: w.handle.everConnected, status: w.handle.status });
        answers.S3_survivalHandleProbe = { cls: 'probe', running: p.state === 'alive', state: p.state };
      } else {
        answers.S3_survivalHandleProbe = { ...NA, unreachable: true };
      }
    } else answers.S3_survivalHandleProbe = NA;

    /* --- S6: watcher mtime liveness. An EVIDENCE site (R-C): it observes disk
     *        writes only, so it may say alive or unknown — never dead. */
    if (w.transcriptAgeMs != null) {
      if (authority?.transcriptLiveness) {
        const p = authority.transcriptLiveness({ lastWriteMs: Date.now() - w.transcriptAgeMs });
        answers.S6_mtimeLiveness = { cls: 'evidence', running: p.state === 'alive', state: p.state, evidenceOnly: true };
      } else {
        const b = watcher.isSessionLive(encodedDir, sdkSessionId);
        answers.S6_mtimeLiveness = { cls: 'evidence', running: b, state: b ? 'alive' : 'dead', evidenceOnly: true };
      }
    } else answers.S6_mtimeLiveness = NA;

    /* --- S0: THE AUTHORITY itself (absent pre-refactor). */
    if (authority?.liveness) {
      const target = w.handle
        ? { kind: 'survival-handle', exitLatched: false, everConnected: w.handle.everConnected, status: w.handle.status }
        : w.bridge
          ? {
            kind: 'bridge',
            session: {
              closed: w.bridge.closed, busy: w.bridge.busy,
              lastFrameAt: Date.now() - w.bridge.silentMs,
              turnStartedAt: w.bridge.busy ? Date.now() - w.bridge.silentMs : null,
              processProbe: probeOf,
            },
          }
          : st
            ? { kind: 'survivor', status: st }
            : { kind: 'transcript', lastWriteMs: Date.now() - w.transcriptAgeMs };
      const v = authority.liveness(target);
      answers.S0_authority = { cls: w.handle || (!w.bridge && st) ? 'probe' : 'session', running: v.running, state: v.state, kind: v.kind, reason: v.reason };
    }

    reportWorld(w, answers);
  }

  process.env.CLAUDE_STATION_DATA = DATA;
}

/** Map a pre-refactor `livenessVerdict` kind onto the tri-state ground truth. */
function stateFromKind(kind, probeState) {
  if (kind === 'dead-process') return 'dead';
  if (kind === 'closed') return 'dead';
  if (kind === 'frameless') return 'unknown';
  return probeState; // 'ok' / 'idle' — its state is whatever the probe proved
}

/**
 * Compare every applicable site to the contract — and thereby to each other,
 * since the contract has exactly one answer per question per world.
 *
 * A site is judged only on the question it exists to answer:
 *   probe-class    → ground truth about the PROCESS (`expect.process`)
 *   session-class  → is a TURN running (`expect.running`) + the `state` its
 *                    verdict carries
 *   evidence-class → R-C only: it may never assert death from one signal
 */
function reportWorld(w, answers) {
  const applicable = Object.entries(answers).filter(([, a]) => a && !a.na);
  const shown = Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a?.na ? (a.unreachable ? 'UNREACHABLE' : 'n/a') : `${a.state}/${a.running}`]));
  console.log(`\n  ${w.id} — ${w.what}\n    expect process=${w.expect.process} running=${w.expect.running} state=${w.expect.state}   sites: ${JSON.stringify(shown)}`);

  for (const [site, a] of applicable) {
    if (a.cls === 'evidence') {
      // R-C: an evidence-only site may never assert death.
      check(`${w.id} · R-C ${site} never asserts 'dead' (silence on disk is not proof)`, a.state !== 'dead', { state: a.state });
      continue;
    }
    if (a.cls === 'probe') {
      check(`${w.id} · R-A ${site} agrees on the PROCESS (${w.expect.process})`, a.state === w.expect.process,
        { got: a.state, expected: w.expect.process, detail: a.detail ?? null });
      if (w.expect.process === 'unknown') {
        check(`${w.id} · R-B ${site} does not coerce unknown into a verdict`, a.state === 'unknown', { got: a.state });
      }
      continue;
    }
    // session-class
    check(`${w.id} · R-A ${site} agrees on ground truth (${w.expect.state})`, a.state === w.expect.state,
      { got: a.state, expected: w.expect.state, detail: a.detail ?? a.kind ?? null });
    if (w.expect.running !== null) {
      check(`${w.id} · R-A ${site} agrees on running (${w.expect.running})`, a.running === w.expect.running,
        { got: a.running, expected: w.expect.running, kind: a.kind ?? null });
    }
    if (w.expect.state === 'unknown') {
      check(`${w.id} · R-B ${site} does not coerce unknown into a verdict`, a.state === 'unknown', { got: a.state });
    }
  }
}

/* ==================================================== scratch server plumbing */

function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = [];
  child.stderr?.on('data', (d) => { log.push(String(d)); });
  child.__log = log;
  servers.add(child);
  return child;
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
const getJson = async (port, p) => (await (await fetch(`http://127.0.0.1:${port}${p}`)).json());
async function registerProject(port, workDir, name, settings = {}) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  if (Object.keys(settings).length) {
    await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }),
    });
  }
  return reg.project.id;
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
};

/* ================================= L2a — the health route's view of survivors */

async function layer2a(iteration, jitterMs) {
  console.log(`\n===== L2a — /api/health's survivor view vs the probe (run ${iteration}) =====`);
  const port = await freePort();
  const DATA = mkTmp('l2a-data');
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });

  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  // Planted AFTER boot, deliberately: boot's `adoptSurvivingHosts` SIGTERMs
  // every broker it finds, so a record planted before boot would be reaped and
  // this layer would test nothing. Three survivor records, no engine involved:
  // one genuinely mid-turn, one whose broker recorded the CLI's exit, one whose
  // CLI pid is gone.
  const live = makeHost('live', hostsDir, 'arch001-h-live');
  const exited = makeHost('exited', hostsDir, 'arch001-h-exited');
  const deadCli = makeHost('deadCli', hostsDir, 'arch001-h-deadcli');
  if (jitterMs) await sleep(jitterMs); // intermittency: vary WHEN we look

  const h = await getJson(port, '/api/health');
  const entryFor = (sdk) => (h.sessions ?? []).find((s) => s.sdkSessionId === sdk) ?? null;
  const survival = await import(path.join(ROOT, 'src', 'server', 'survival.ts'));
  let authority = null;
  try { authority = await import(path.join(ROOT, 'src', 'server', 'liveness.ts')); } catch { /* pre-refactor */ }
  const probeOf = authority?.livenessOfSurvivor ?? survival.probeSurvivorHost;

  for (const [label, st, expectRunning] of [
    ['mid-turn survivor', live, true],
    ['broker-recorded-exit survivor', exited, false],
    ['dead-CLI survivor', deadCli, false],
  ]) {
    const e = entryFor(st.sdkSessionId);
    // The route's own claim: an entry with a running state IS a claim that a
    // turn is still finishing (doctor prints it as "SURVIVED a restart … turn
    // draining"; the send guard refuses behind it).
    const routeRunning = !!e && (e.state === 'surviving-unadopted' || e.state === 'busy' || e.state === 'detached-running');
    const probe = probeOf(st);
    check(`L2a ${label}: /api/health's view agrees with the ground-truth probe`,
      routeRunning === expectRunning && (probe.state === 'alive') === expectRunning,
      { routeState: e?.state ?? '(absent)', routeRunning, probe: probe.state, expectRunning });
    if (e?.liveness) {
      check(`L2a ${label}: the entry carries the authority's verdict`,
        e.liveness.running === expectRunning, { liveness: e.liveness });
    }
  }
  stopByPid(srv.pid);
}

/* ============ L2b — a REAL bridge whose stream goes silent (no pid, no cost) */

async function layer2b(iteration) {
  console.log(`\n===== L2b — a real bridge, real turn, real silence: every route must agree (run ${iteration}) =====`);
  const port = await freePort();
  const DATA = mkTmp('l2b-data');
  const WORK = mkTmp('l2b-work');
  const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
  // Sweep OFF so nothing here can be a background-timer artifact; a short
  // frameless window so the "past the window" half is reachable in seconds.
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_REAP_SWEEP_MS: '0', CLAUDE_STATION_FRAMELESS_MS: '4000',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, `arch001-l2b-${iteration}`, { provider: 'openai', model: null });

  const c = await openWs(port);
  c.send({ type: 'start', projectId, prompt: 'HANG until stopped' });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 60000);
  check('L2b PRECONDITION: a real turn started on a real runtime, then went silent', !!init, { sessionId: init?.sessionId });
  if (!init) { stopByPid(srv.pid); return; }
  const sdk = init.sessionId;

  const snapshot = async (phase, expectRunning) => {
    const [h, list, liveList] = await Promise.all([
      getJson(port, '/api/health'), getJson(port, '/api/sessions'), getJson(port, '/api/sessions/live'),
    ]);
    const hs = (h.sessions ?? []).find((s) => s.sdkSessionId === sdk);
    const ls = (list.sessions ?? []).find((s) => s.sdkSessionId === sdk);
    const vs = (liveList.sessions ?? []).find((s) => s.sessionId === sdk);
    const sites = {
      'S7_health.state': hs ? (hs.state === 'busy' || hs.state === 'detached-running') : false,
      'S7_health.liveness': hs?.liveness ? (hs.liveness.running ?? hs.liveness.live) === true : null,
      'S8_sessions.busy': ls ? !!ls.busy : false,
      'S8_live.busy': vs ? !!vs.busy : false,
    };
    for (const [site, running] of Object.entries(sites)) {
      if (running === null) continue;
      check(`L2b ${phase}: ${site} agrees the turn is ${expectRunning ? 'RUNNING' : 'NOT running'}`,
        running === expectRunning, { site, running, expectRunning, healthState: hs?.state, liveness: hs?.liveness });
    }
    return { hs, ls, vs };
  };

  await sleep(2500);
  await snapshot('inside the frameless window', true);
  await sleep(6000);
  await snapshot('past the frameless window', false);

  try { c.ws.close(); } catch { /* ignore */ }
  stopByPid(srv.pid);
}

/* ================== L3 — both directions of the send guard (ARCH-001 bar #3) */

async function layer3(iteration, jitterMs) {
  console.log(`\n===== L3 — a stale survivor must never block a send; a live one always must (run ${iteration}) =====`);
  const port = await freePort();
  const DATA = mkTmp('l3-data');
  const WORK = mkTmp('l3-work');
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, `arch001-l3-${iteration}`);
  if (jitterMs) await sleep(jitterMs);

  const REFUSAL = /still finishing its previous turn/;

  // (1) STALE — a corpse must NOT block. The guard runs BEFORE any engine
  // spawn, so no CLI is needed to prove the guard's disposition.
  const staleId = 'arch001-l3-stale';
  makeHost('exited', hostsDir, staleId);
  const c1 = await openWs(port);
  c1.send({ type: 'start', projectId, prompt: 'ARCH-001 stale probe', resumeSessionId: staleId });
  await sleep(2500);
  const refused1 = c1.events.find((e) => e.t === 'error' && REFUSAL.test(String(e.message)));
  check('L3 STALE: a dead survivor does NOT block the send', !refused1, { message: refused1?.message?.slice(0, 140) ?? '(not refused)' });
  const swept = !fs.existsSync(path.join(hostsDir, fs.readdirSync(hostsDir).find((n) => n.includes('exited')) ?? 'none.json'));
  check('L3 STALE: the corpse was swept from disk rather than left to block again', swept || !fs.readdirSync(hostsDir).some((n) => n.includes('exited')),
    { hostsDir: fs.readdirSync(hostsDir) });
  try { c1.ws.close(); } catch { /* ignore */ }

  // (2) ALIVE — a genuinely mid-turn survivor MUST block (BUG-022).
  const aliveId = 'arch001-l3-alive';
  makeHost('live', hostsDir, aliveId);
  const c2 = await openWs(port);
  c2.send({ type: 'start', projectId, prompt: 'ARCH-001 alive probe', resumeSessionId: aliveId });
  const refused2 = await waitEv(c2.events, (e) => e.t === 'error' && REFUSAL.test(String(e.message)), 20000);
  check('L3 ALIVE: a genuinely mid-turn survivor DOES block the send, retryably', !!refused2 && refused2.retryable === true && refused2.fatal === false,
    { message: refused2?.message?.slice(0, 160) ?? '(never refused)', retryable: refused2?.retryable, fatal: refused2?.fatal });
  check('L3 ALIVE: the refusal names its evidence (pids / broker state), not just an assertion',
    /pid \d+/.test(String(refused2?.message ?? '')), { message: String(refused2?.message ?? '').slice(0, 200) });
  const ackedStart = c2.events.some((e) => e.t === 'ack' && e.of === 'start');
  check('L3 ALIVE: refused BEFORE any start ack, so the composer keeps the text (BUG-029)', !ackedStart, { sawStartAck: ackedStart });
  try { c2.ws.close(); } catch { /* ignore */ }

  stopByPid(srv.pid);
}

/* ================================================ L4 — the regrowth guard (R-D)
 *
 * WHAT STOPS THE CLASS FROM COMING BACK. Every pattern below is a way somebody
 * has ALREADY answered "is it alive?" locally in this repo. Any occurrence
 * outside the authority — or any occurrence beyond the recorded, justified
 * allowlist — fails this verify. Adding a genuinely-needed new one is a
 * one-line allowlist edit that a reviewer sees; adding one by accident is not
 * possible.
 */
const GUARD_PATTERNS = [
  {
    id: 'pid-liveness',
    re: /process\.kill\s*\(\s*[^,)]+,\s*(0|'0')\s*\)/g,
    what: 'a raw pid-liveness check (`process.kill(pid, 0)`) — ask the authority instead',
  },
  {
    id: 'broker-verdict',
    re: /\.state\s*===\s*['"]exited['"]/g,
    what: "a local read of the broker's own exit verdict — ask the authority instead",
  },
  {
    id: 'mtime-window',
    re: /(Date\.now\(\)|\bnow\b)\s*-\s*[A-Za-z0-9_.$\[\]]*\.?mtimeMs/g,
    what: 'a hand-rolled mtime recency window — transcript liveness lives in the authority',
  },
  {
    id: 'frameless-window',
    re: /FRAMELESS_MS/g,
    what: 'the frameless backstop window used outside the authority',
  },
  {
    // Narrow on purpose: it hunts things that ANSWER the question, not things
    // that act on the answer (`reapAsZombie`, `sweepZombieSessions` are
    // reapers — they consult the authority and are supposed to exist).
    id: 'liveness-shaped-declaration',
    re: /(?:function|const|let)\s+[A-Za-z0-9_]*(?:Alive|Liveness)[A-Za-z0-9_]*\s*[=(]/g,
    what: 'a new liveness-answering function declared outside the authority',
  },
  {
    id: 'is-live-predicate',
    re: /(?:function|const|let)\s+is[A-Za-z0-9_]*Live\b/g,
    what: 'a new "is it live" predicate declared outside the authority',
  },
  {
    id: 'running-state-ternary',
    re: /['"]detached-running['"]/g,
    what: 'the running/idle state label derived locally — the authority owns the label',
  },
];

/**
 * The allowlist: `file → {patternId: count}`. Everything here is a KNOWN,
 * justified occurrence; the count is exact, so a second one in the same file
 * still fails. `src/server/liveness.ts` is the authority and is exempt.
 */
const GUARD_ALLOW = {
  'liveness.ts': '*', // the authority itself
  // The broker is a standalone process (its own argv/exec context) that cannot
  // import server modules; it minds exactly one CLI and reports it. Its checks
  // are the SOURCE of the ground truth, not a second opinion about it.
  'session-host.mjs': '*',
  /*
   * watcher.ts owns the transcript LISTING, but even the listing asks the
   * authority whether a file counts as live — so it holds no window of its
   * own. What remains is the boolean adapter `isSessionLive`, whose whole body
   * delegates to `transcriptLiveness`. Counted exactly: a second one fails.
   */
  'watcher.ts': { 'is-live-predicate': 1 },
  /*
   * survival.ts's socket-close handler reads the broker's recorded exit CODE
   * and signal so it can synthesise the transport's own exit event. That is an
   * exit-code read, not a liveness decision — the liveness decision on the same
   * record goes through `livenessOfSurvivalHandle`.
   */
  'survival.ts': { 'broker-verdict': 1 },
  /*
   * BUG-157 (round 4) — the CONTAINER GROUND-TRUTH SOURCE, the container arm's
   * parallel to the direct arm's broker (session-host.mjs, allowlisted '*' above).
   * `classifyContainerLiveness` / `probeContainerLiveness` report RAW process facts
   * — which tagged processes the container currently holds — by scanning /proc, the
   * same source `reapExec` kills by. They are the source of ground truth for a
   * container, not a second opinion about it: the keep/close DECISION still lives in
   * agent-bridge's detached-close fuse (which consults these facts + the authority's
   * probe rung). Counted exactly at two declarations; a third fails.
   */
  'container-manager.ts': { 'liveness-shaped-declaration': 2 },
  'index.ts': {},
  'agent-bridge.ts': {},
};

function guardScan(rootDir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(ts|mts|mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  walk(rootDir);
  const violations = [];
  for (const f of files) {
    const rel = path.relative(rootDir, f);
    const base = path.basename(f);
    const allow = GUARD_ALLOW[base] ?? GUARD_ALLOW[rel] ?? {};
    if (allow === '*') continue;
    const src = fs.readFileSync(f, 'utf8');
    // Comments are documentation, not code: strip them so a ticket reference
    // in a comment can never trip (or silence) the guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const p of GUARD_PATTERNS) {
      const hits = [...code.matchAll(p.re)];
      const budget = allow[p.id] ?? 0;
      if (hits.length > budget) {
        violations.push({ file: rel, pattern: p.id, what: p.what, found: hits.length, allowed: budget, sample: hits[budget]?.[0]?.slice(0, 80) ?? hits[0][0].slice(0, 80) });
      }
    }
  }
  return violations;
}

function layer4() {
  console.log('\n===== L4 — regrowth guard: no NEW ad-hoc liveness check may appear (R-D) =====');
  const v = guardScan(GUARD_ROOT);
  check('L4 no ad-hoc liveness check exists outside the authority',
    v.length === 0,
    v.length ? v.map((x) => `${x.file}: ${x.pattern} (${x.found} > ${x.allowed}) — ${x.what} [${x.sample}]`).join(' | ') : `scanned ${GUARD_ROOT}, clean`);
  return v;
}

/* --------------------------------------------------------------------- main */

async function main() {
  if (GUARD_ONLY) {
    layer4();
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exitCode = fail ? 1 : 0;
    return;
  }
  for (let i = 1; i <= RUNS; i++) {
    // INTERMITTENCY (BUG-034's implication): correctness must not depend on
    // when we happen to look. Each run varies the observation point.
    const jitter = i === 1 ? 0 : Math.floor(Math.random() * 900) + 100;
    if (!ONLY || ONLY === '1') await layer1(i);
    if (!ONLY || ONLY === '2a') await layer2a(i, jitter);
    if (!ONLY || ONLY === '2b') await layer2b(i);
    if (!ONLY || ONLY === '3') await layer3(i, jitter);
  }
  if (!ONLY || ONLY === '4') layer4();

  if (RECORD) {
    console.log(`\n===== RECORDED DISAGREEMENTS (${findings.length}) =====`);
    for (const f of findings) console.log(`  · ${f.name}\n      ${f.observed}`);
    console.log(`\n${pass} agreements, ${findings.length} disagreements recorded (--record: never fails)`);
    return;
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
