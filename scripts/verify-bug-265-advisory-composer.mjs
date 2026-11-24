/**
 * BUG-265 — a sent message must NOT reappear in the composer as a duplicate
 * when the session-start snapshot fails.
 *
 * The user's reality, verbatim: "every msg i send gets sent but also stays in
 * composer as duplicate" — in a session that also "consistently shows a
 * 'session-start snapshot FAILED (copy-failed)' error".
 *
 * ROOT CAUSE (client). The server emits a snapshot failure as a NON-FATAL error
 * event, BEFORE the start ack, and the session proceeds (agent-bridge
 * snapshotOnSessionStart → onError, "The session is starting anyway"). The
 * client's `onEvent` error handler fell through every fatal/refusal check and
 * landed in the generic "a start refused BEFORE its ack" branch
 * (`else if (state.pendingStart != null) … rollBackPendingStart()`), which
 * REMOVES the optimistic bubble, CLOSES the socket, and — the reported bug —
 * puts the just-cleared composer text BACK. The message was really sent, so the
 * user saw it sent AND duplicated in the composer. It self-perpetuates: the
 * rollback closes the socket, so the next send is a fresh start that
 * re-snapshots, re-fails, and re-rolls-back — "every msg".
 *
 * FIX. The server now marks these advisory "insurance failed" errors
 * `advisory: true` (events.ts StationEvent error variant); the client returns on
 * `e.advisory && !e.fatal` before the rollback chain, leaving the start pending
 * for its real ack. Both halves are load-bearing — the guard is a no-op without
 * the flag, and the flag is inert without the guard.
 *
 * WHAT THIS DRIVES. A REAL isolated scratch server, the REAL public/app.js in a
 * REAL headless browser, the REAL composer send path (startNew → #prompt →
 * submit), and a REAL non-fatal session-start snapshot failure emitted by the
 * REAL server. The snapshot is made to fail deterministically by pointing the
 * snapshot store (CLAUDE_STATION_DATA) at a DIFFERENT filesystem (/dev/shm,
 * tmpfs) than the project (btrfs $HOME) — a genuine SnapshotError('cross-
 * filesystem') that takes the identical onError → advisory path the user's
 * 'copy-failed' took. (Synthetic only in WHICH snapshot error fires; the error,
 * its non-fatal advisory framing, and the whole client path are real.)
 *
 * ASSERTED, in the user's terms:
 *   FIXED  — the advisory snapshot error IS received (proved via the client's
 *            own console.warn), the start stays pending/healthy, and the
 *            composer is EMPTY (no duplicate).
 *   PRE-FIX (MUST-FAIL) — the SAME run against a synthesized pre-fix client (the
 *            advisory guard line mechanically removed) refills the composer with
 *            the sent text: the reported duplicate, reproduced.
 *
 *   node scripts/verify-bug-265-advisory-composer.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug265-'));
const WORK = path.join(SCRATCH, 'work');          // project dir — on $HOME (btrfs)
const PROJECTS = path.join(SCRATCH, 'projects');  // isolated transcript store
const PROFILE = path.join(SCRATCH, 'chrome');
for (const d of [WORK, PROJECTS, PROFILE]) fs.mkdirSync(d, { recursive: true });
// The snapshot store must be on a DIFFERENT filesystem than WORK so the real
// session-start snapshot fails for real. /dev/shm is tmpfs on Linux.
const SHM = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
const DATA = fs.mkdtempSync(path.join(SHM, 'bug265-data-'));
fs.writeFileSync(path.join(WORK, 'README.md'), '# bug265 fixture project\n');

const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const MSG = 'Reply with exactly: BUG-265-COMPOSER-MESSAGE';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ------------------------------------------------------------------- CDP */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && c.on.has(m.method)) c.on.get(m.method)(m.params);
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* navigating */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/*
 * The MUST-FAIL baseline, CONSTRUCTED rather than checked out: remove the
 * advisory guard line so an advisory frame falls into the generic pre-ack
 * refusal branch exactly as it did before this fix. The hit count is asserted,
 * so a transform that stops matching throws instead of quietly proving nothing.
 */
function preFixClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const from = `      if (e.advisory && !e.fatal) return;`;
  const to = `      if (false && e.advisory && !e.fatal) return; /* PRE-FIX: advisory falls into the rollback branch */`;
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`pre-fix transform matched ${hits}x (expected 1) — the guard line moved`);
  return src.replace(from, to);
}

let server, browser;
function killChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const PORT = Number(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  // Precondition: WORK and the snapshot store really are on different devices,
  // or the snapshot would SUCCEED and this test would prove nothing.
  const devWork = fs.statSync(WORK).dev;
  const devData = fs.statSync(DATA).dev;
  check('PRECONDITION: project and snapshot store are on DIFFERENT filesystems (snapshot will fail for real)',
    devWork !== devData, { devWork, devData, work: WORK, data: DATA });
  if (devWork === devData) throw new Error('cannot stage a cross-filesystem snapshot failure — /dev/shm shares a device with $HOME here');

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJECTS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'bug265-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  // Turn session-start snapshots ON for this project (default off for direct
  // projects) so the real start path takes a real — and here, failing — snapshot.
  const patchRes = await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { snapshots: { enabled: true } } }),
  });
  const patched = await patchRes.json();
  check('snapshots ENABLED for the fixture project',
    patchRes.ok && patched?.project?.settings?.snapshots?.enabled === true,
    { status: patchRes.status, snapshots: patched?.project?.settings?.snapshots });

  /* --- the browser, the user's seat -------------------------------------- */
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 160 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('the browser never opened a devtools port');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const legs = [
    { name: 'FIXED (this working tree)', fixed: true },
    { name: 'PRE-FIX (advisory guard removed)', fixed: false },
  ];
  const results = {};

  for (const leg of legs) {
    console.log(`\n########## ${leg.name} ##########`);
    if (!leg.fixed) {
      const body = preFixClient();
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*app.js*', requestStage: 'Request' }] });
      cdp.on.set('Fetch.requestPaused', (p) => {
        void cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from(body).toString('base64'),
        }).catch(() => { /* raced a nav */ });
      });
    }
    results[leg.fixed ? 'fixed' : 'prefix'] = await runLeg(cdp, pid, leg.fixed);
    if (!leg.fixed) {
      cdp.on.delete('Fetch.requestPaused');
      await cdp.send('Fetch.disable');
    }
  }

  /* --- the must-FAIL comparison ------------------------------------------ */
  console.log('\n=== MUST-FAIL: the pre-fix client refills the composer (the reported duplicate) ===');
  const fix = results.fixed, pre = results.prefix;
  check('FIXED: the advisory snapshot error WAS received (client logged it)', fix.advisorySeen, fix.warnSample);
  check('FIXED: the composer is EMPTY after the send — no duplicate', fix.composer === '', JSON.stringify(fix.composer));
  check('FIXED: the start is still pending/healthy (socket open, not rolled back)',
    fix.pendingStart === true && fix.live === true, { pendingStart: fix.pendingStart, live: fix.live });

  check('PRE-FIX: the advisory snapshot error WAS received here too (same stimulus)', pre.advisorySeen, pre.warnSample);
  check('PRE-FIX (MUST-FAIL): the composer is REFILLED with the sent text — the duplicate',
    pre.composer === MSG, JSON.stringify(pre.composer));
  check('The difference is the fix, not the fixture: FIXED empty vs PRE-FIX refilled',
    fix.composer === '' && pre.composer === MSG, { fixed: fix.composer, prefix: pre.composer });

  cdp.close();
}

/** One end-to-end pass of the user's story. Returns the composer + start state. */
async function runLeg(cdp, pid, fixed) {
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`, 45_000);
  await cdp.eval(`localStorage.clear()`);
  await cdp.waitFor('reboot after clear', `window.__station !== undefined`, 10_000);

  // Collect the client's own console.warn stream, race-free (say(isErr) logs
  // "[station] <msg>"). This is the durable proof the advisory frame arrived.
  await cdp.eval(`(() => {
    window.__bug265warns = [];
    const w = console.warn.bind(console);
    console.warn = (...a) => { try { window.__bug265warns.push(a.map(String).join(' ')); } catch {} ; return w(...a); };
  })()`);

  // Arm a NEW-session composer for the fixture project (the real path a project
  // click takes), type the message, and submit — the real composer send path.
  await cdp.eval(`window.__station.startNew(${JSON.stringify(pid)})`);
  await cdp.waitFor('a new-session composer armed',
    `window.__station.currentProject() && window.__station.state.current.sessionId === null`, 20_000);
  await cdp.eval(`(() => {
    const ta = document.querySelector('#prompt');
    ta.value = ${JSON.stringify(MSG)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const typed = await cdp.eval(`document.querySelector('#prompt').value`);
  if (typed !== MSG) throw new Error(`could not type into the composer (got ${JSON.stringify(typed)})`);

  await cdp.eval(`window.__station.submit()`);

  // Wait for the real server to deliver the non-fatal snapshot advisory. Poll
  // the client's warn stream (race-free), up to 25s (server start + snapshot).
  const t0 = Date.now();
  let advisorySeen = false;
  while (Date.now() - t0 < 25_000 && !advisorySeen) {
    const warns = await cdp.eval(`window.__bug265warns ?? []`);
    advisorySeen = Array.isArray(warns) && warns.some((w) => /snapshot/i.test(w));
    if (advisorySeen) break;
    await sleep(200);
  }
  // Give the error handler's synchronous branch (rollback, in the pre-fix leg) a
  // beat to run after the frame is logged, then read the composer + start state.
  await sleep(300);

  const snap = await cdp.eval(`(() => ({
    composer: document.querySelector('#prompt').value,
    pendingStart: window.__station.state.pendingStart != null,
    live: window.__station.state.live === true,
    youBubbles: document.querySelectorAll('#thread .you, .you').length,
    warns: window.__bug265warns ?? [],
  }))()`);

  const warnSample = (snap.warns.find((w) => /snapshot/i.test(w)) ?? '(no snapshot warn seen)').slice(0, 140);
  console.log(`  (${fixed ? 'fixed' : 'pre-fix'}) composer=${JSON.stringify(snap.composer)} pendingStart=${snap.pendingStart} live=${snap.live} advisorySeen=${advisorySeen}`);
  console.log(`        warn: ${warnSample}`);
  return { composer: snap.composer, pendingStart: snap.pendingStart, live: snap.live, advisorySeen, warnSample };
}

main()
  .then(() => {
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
    if (fail) console.log('  failed:', failures.join(' | '));
  })
  .catch((e) => { console.error('\nFATAL', e); fail++; })
  .finally(() => {
    killChild(browser);
    killChild(server);
    setTimeout(() => {
      try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
      process.exit(fail === 0 ? 0 : 1);
    }, 500).unref();
  });
