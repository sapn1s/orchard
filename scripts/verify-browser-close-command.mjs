#!/usr/bin/env node
/**
 * FEAT — "one operational command opens/closes the browser, so no agent improvises a kill".
 *
 * The incident this pins (2026-08-25, container session on /workspace/kenimai-website):
 * two subagents finished with the browser, had no way to close it, and reached for the
 * host process table — `lsof -t -i:3007` (not in the image), then `ps`/`kill` by pattern.
 * The next step down that road is `pkill chromium`, which takes the user's own windows.
 *
 * Two halves are proven here:
 *   1. MECHANISM — `browser_close` exists, closes Chrome, keeps the daemon serving, is
 *      idempotent, starts nothing, and works over the CONTAINER shape (the mounted shim
 *      with SBMCP_AUTOSTART=0), which is where the incident happened.
 *   2. DISCOVERABILITY — a session is TOLD, at launch, that the tool exists and that
 *      killing is never the answer. A mechanism nobody can find is the bug we are fixing.
 *
 * Runs the REAL adapter on this machine against a SCRATCH state dir. Never touches the
 * user's ~/.stealth-browser-mcp, their live daemon, port 4317, or any process it did not
 * start. Chrome runs HEADLESS here only so the run does not pop windows into the user's
 * workspace mid-session; the close path is byte-identical either way, and section F
 * proves the headful window really disappears by diffing X window ids.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.CLAUDE_STATION_SBMCP_REPO
  || path.join(os.homedir(), 'random_projects/stealth-browser-mcp');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'verify-browser-close-'));
const PROJECT = 'vbc-fixture';
const PROJ_DIR = path.join(SCRATCH, 'projects', PROJECT);
const SOCKET = path.join(PROJ_DIR, 'browser.sock');
const PROFILE = path.join(PROJ_DIR, 'chrome-data');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome roots holding OUR scratch profile. Scoped by profile dir, so this can never
 *  see the user's browser or their kenimai daemon's Chrome. */
function chromeRoots() {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout || '';
  return out.split('\n')
    .filter((l) => l.includes(`--user-data-dir=${PROFILE}`) && !/--type=/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter(Boolean);
}
function allChromeProcs() {
  const out = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter((l) => l.includes(`--user-data-dir=${PROFILE}`)).length;
}

// ---- socket RPC, the daemon's own newline-delimited JSON ---------------------
let seq = 0;
function rpc(msg, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(SOCKET);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('rpc timeout')); }, timeoutMs);
    c.on('connect', () => c.write(JSON.stringify({ id: ++seq, ...msg }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(t); c.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
const callTool = (name, args = {}) => rpc({ op: 'tools/call', name, args }, 120_000);
async function status() {
  const r = await callTool('browser_status');
  return JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text ?? '{}');
}

let daemon = null;
let daemonLog = '';
async function startDaemon() {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  daemon = spawn(process.execPath, [path.join(REPO, 'src/daemon.mjs'), '--project', PROJECT],
    { env: { ...process.env, SBMCP_STATE_DIR: SCRATCH, SBMCP_HEADLESS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  daemon.stdout.on('data', (d) => { daemonLog += d; });
  daemon.stderr.on('data', (d) => { daemonLog += d; });
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(SOCKET)) { try { await rpc({ op: 'ping' }, 5000); return; } catch {} }
    await sleep(250);
  }
  throw new Error('daemon never came up');
}

async function main() {
  console.log(`\nscratch state dir: ${SCRATCH}\nadapter repo:      ${REPO}\n`);

  // ================= A. the tool is declared, and declaring it starts nothing ==========
  console.log('=== A. discovery starts no Chrome ===');
  await startDaemon();
  const listed = await rpc({ op: 'tools/list' });
  const names = (listed.result?.tools ?? listed.tools ?? []).map((t) => t.name);
  check('tools/list advertises browser_close', names.includes('browser_close'), `got: ${names.join(',')}`);
  const closeDef = (listed.result?.tools ?? listed.tools ?? []).find((t) => t.name === 'browser_close');
  check('browser_close description names pkill/killall as forbidden',
    /pkill/i.test(closeDef?.description ?? '') && /killall/i.test(closeDef?.description ?? ''),
    closeDef?.description?.slice(0, 120));
  check('browser_close description says it is idempotent/safe',
    /idempotent/i.test(closeDef?.description ?? ''));
  check('listing tools started no Chrome', chromeRoots().length === 0, `roots=${chromeRoots()}`);

  // ================= B. close before any launch: succeeds, starts nothing =============
  console.log('\n=== B. close on a never-launched browser (the improvise trigger) ===');
  const early = await callTool('browser_close');
  const earlyTxt = early.result?.content?.[0]?.text ?? early.content?.[0]?.text ?? '';
  const earlyJson = JSON.parse(earlyTxt || '{}');
  check('browser_close on a never-launched daemon does NOT error',
    !early.error && earlyJson.already_closed === true, JSON.stringify(early).slice(0, 200));
  check('its message tells the model NOT to kill anything',
    /do not try to kill any process/i.test(earlyTxt), earlyTxt.slice(0, 160));
  check('close-before-launch started no Chrome', chromeRoots().length === 0, `roots=${chromeRoots()}`);
  const s0 = await status();
  check('browser_status still reports chrome_running:false', s0.chrome_running === false);

  // The must-fail control for this file exposed a latent one: pre-fix, page() ran
  // BEFORE the tool-name switch, so an unknown name launched Chrome and only then
  // errored. A model guessing "browser_stop"/"browser_quit" popped a window per guess.
  const guessed = await callTool('browser_quit');
  check('a GUESSED tool name errors without launching Chrome',
    !!guessed.error && chromeRoots().length === 0, `err=${guessed.error} roots=${chromeRoots()}`);

  // ================= C. the real cycle: open -> close -> gone, daemon survives =========
  console.log('\n=== C. navigate opens, browser_close closes, daemon keeps serving ===');
  const nav = await callTool('browser_navigate', { url: 'https://example.com', max_chars: 200 });
  check('browser_navigate succeeded', !nav.error, JSON.stringify(nav).slice(0, 200));
  const roots = chromeRoots();
  check('exactly one Chrome root launched', roots.length === 1, `roots=${roots}`);
  const sUp = await status();
  check('browser_status reports chrome_running:true', sUp.chrome_running === true);

  const closed = await callTool('browser_close');
  const closedTxt = closed.result?.content?.[0]?.text ?? closed.content?.[0]?.text ?? '';
  const closedJson = JSON.parse(closedTxt || '{}');
  check('browser_close reports closed:true', closedJson.closed === true, closedTxt.slice(0, 200));

  await sleep(1500);
  check('every Chrome process for this profile is gone (not just the root)',
    allChromeProcs() === 0, `remaining=${allChromeProcs()}`);
  check('the daemon is still alive', daemon.exitCode === null);
  check('the socket still answers after close', (await rpc({ op: 'ping' }, 5000)) != null);
  const sDown = await status();
  check('browser_status reports chrome_running:false after close', sDown.chrome_running === false);
  check('close is observable in the daemon log (an operator can see it happened)',
    /closing chrome \(closed by session request \(browser_close\)\)/.test(daemonLog),
    daemonLog.split('\n').slice(-4).join(' | '));

  // ================= D. idempotence + relaunch ========================================
  console.log('\n=== D. closing twice is safe; the next call transparently reopens ===');
  const again = await callTool('browser_close');
  const againJson = JSON.parse(again.result?.content?.[0]?.text ?? again.content?.[0]?.text ?? '{}');
  check('second browser_close succeeds (idempotent)', !again.error && againJson.already_closed === true);
  check('second close started no Chrome', chromeRoots().length === 0);
  const nav2 = await callTool('browser_navigate', { url: 'https://example.com', max_chars: 200 });
  check('a browser call after close relaunches and works', !nav2.error, JSON.stringify(nav2).slice(0, 160));
  check('relaunch produced exactly one root', chromeRoots().length === 1, `roots=${chromeRoots()}`);
  await callTool('browser_close');
  await sleep(1200);
  check('closed again cleanly', allChromeProcs() === 0);

  // ================= E. the CONTAINER shape, where the incident happened ==============
  // The mounted shim with SBMCP_AUTOSTART=0 — the exact env container-manager gives a
  // containerised session. It speaks MCP stdio, not the socket protocol.
  console.log('\n=== E. container shape: mounted shim, SBMCP_AUTOSTART=0 ===');
  const shim = spawn(process.execPath, [path.join(REPO, 'src/mcp-stdio.mjs')], {
    env: { ...process.env, SBMCP_PROJECT: PROJECT, SBMCP_SOCKET: SOCKET, SBMCP_AUTOSTART: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let sbuf = '';
  shim.stdout.on('data', (d) => {
    sbuf += d;
    let nl;
    while ((nl = sbuf.indexOf('\n')) >= 0) {
      const line = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id != null) replies.set(m.id, m); } catch {}
    }
  });
  function shimSend(id, method, params) {
    shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return (async () => {
      for (let i = 0; i < 480; i++) { if (replies.has(id)) return replies.get(id); await sleep(250); }
      throw new Error(`shim timeout on ${method}`);
    })();
  }
  await shimSend(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } });
  const shimList = await shimSend(2, 'tools/list', {});
  const shimNames = (shimList.result?.tools ?? []).map((t) => t.name);
  check('the mounted shim advertises browser_close to a containerised session',
    shimNames.includes('browser_close'), `got: ${shimNames.join(',')}`);
  check('shim tools/list started no Chrome', chromeRoots().length === 0);

  const shimNav = await shimSend(3, 'tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com', max_chars: 200 } });
  check('container-shape navigate launched the browser on the host',
    !shimNav.error && chromeRoots().length === 1, `roots=${chromeRoots()}`);
  const shimClose = await shimSend(4, 'tools/call', { name: 'browser_close', arguments: {} });
  await sleep(1500);
  check('container-shape browser_close closed it — no CLI, no socket op, no process table',
    !shimClose.error && allChromeProcs() === 0, JSON.stringify(shimClose).slice(0, 200));
  check('the daemon survived the container-shape close (mounted socket stays valid)',
    daemon.exitCode === null && (await rpc({ op: 'ping' }, 5000)) != null);
  shim.kill('SIGTERM');

  // ================= F. the window actually disappears (headful, X ids) ===============
  // A process count is a proxy; the user's complaint is about a WINDOW. Diff real X
  // window ids around one headful open/close. Skipped without a display.
  console.log('\n=== F. headful: the visible window really goes away ===');
  const haveX = !!process.env.DISPLAY && spawnSync('which', ['xdotool']).status === 0;
  if (!haveX) {
    console.log('  SKIP  no DISPLAY or no xdotool — cannot diff window ids');
  } else {
    const ids = () => new Set((spawnSync('xdotool', ['search', '--onlyvisible', '--class', 'chrom'],
      { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean));
    const before = ids();
    const hp = path.join(SCRATCH, 'projects', 'vbc-headful');
    fs.mkdirSync(hp, { recursive: true });
    const hd = spawn(process.execPath, [path.join(REPO, 'src/daemon.mjs'), '--project', 'vbc-headful'],
      { env: { ...process.env, SBMCP_STATE_DIR: SCRATCH, SBMCP_HEADLESS: 'false' }, stdio: 'ignore' });
    const hsock = path.join(hp, 'browser.sock');
    for (let i = 0; i < 120 && !fs.existsSync(hsock); i++) await sleep(250);
    const hrpc = (msg) => new Promise((res, rej) => {
      const c = net.createConnection(hsock); let b = '';
      const t = setTimeout(() => { c.destroy(); rej(new Error('t')); }, 120_000);
      c.on('connect', () => c.write(JSON.stringify({ id: ++seq, ...msg }) + '\n'));
      c.on('data', (d) => { b += d; const n = b.indexOf('\n'); if (n < 0) return; clearTimeout(t); c.end(); res(JSON.parse(b.slice(0, n))); });
      c.on('error', (e) => { clearTimeout(t); rej(e); });
    });
    try {
      await hrpc({ op: 'tools/call', name: 'browser_navigate', args: { url: 'https://example.com', max_chars: 100 } });
      await sleep(1500);
      const during = ids();
      const opened = [...during].filter((i) => !before.has(i));
      check('a real visible window appeared (headful is the shipped default)', opened.length >= 1, `opened=${opened}`);
      await hrpc({ op: 'tools/call', name: 'browser_close', args: {} });
      await sleep(2500);
      const after = ids();
      check('browser_close removed that window from the user\'s workspace',
        opened.every((i) => !after.has(i)), `still present: ${opened.filter((i) => after.has(i))}`);
      check('no window that existed BEFORE the run was disturbed',
        [...before].every((i) => after.has(i)), 'the run destroyed a pre-existing window — this is the pkill failure mode');
    } finally {
      try { await hrpc({ op: 'shutdown' }); } catch {}
      await sleep(800);
      if (hd.exitCode === null) { try { process.kill(hd.pid, 'SIGTERM'); } catch {} }
    }
  }

  // ================= G. DISCOVERABILITY: the session is told, at launch ===============
  console.log('\n=== G. a session is told this at launch (the actual defect) ===');
  const { browserAvailabilityNote } = await import(path.join(ROOT, 'src/server/agent-bridge.ts'));
  const on = browserAvailabilityNote(true);
  check('the note names the exact close tool', /browser_close/.test(on), on.slice(0, 120));
  check('the note forbids pkill by name', /pkill/i.test(on));
  check('the note forbids the discovery commands the incident used (ps/lsof/pgrep)',
    /lsof/i.test(on) && /pgrep/i.test(on) && /\bps\b/.test(on));
  check('the note says the browser is OUTSIDE the sandbox (why guessing cannot work)',
    /outside your sandbox/i.test(on));
  check('the note warns the window is visible to the user', /visible window/i.test(on));
  check('the note refuses rather than inviting a fallback',
    /there is no fallback/i.test(on) && /say so and stop/i.test(on));
  const off = browserAvailabilityNote(false);
  check('a project WITHOUT a browser is told so explicitly (never silence)',
    /NO browser/.test(off) && /never launch or kill a browser process/i.test(off));
  const broken = browserAvailabilityNote(true, 'adapter missing');
  check('enabled-but-unavailable states the reason and forbids improvising',
    /adapter missing/.test(broken) && /do NOT kill any process/i.test(broken));

  // the note must actually reach a launched session's prompt, not just exist
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/server/agent-bridge.ts'), 'utf8');
  check('the note is appended to the composed system prompt at launch',
    /appendToSystemPrompt\(this\.composed\.systemPrompt,\s*browserNote\)/.test(bridgeSrc));
  check('it is gated on the same setting that attaches the tools',
    /browserAvailabilityNote\(browserSettingsOf\(opts\.project\)\.enabled\)/.test(bridgeSrc));

  console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
  if (fail) console.log(`failures:\n  - ${failures.join('\n  - ')}`);
}

async function cleanup() {
  try { if (fs.existsSync(SOCKET)) await rpc({ op: 'shutdown' }, 10_000); } catch {}
  await sleep(800);
  if (daemon && daemon.exitCode === null) { try { process.kill(daemon.pid, 'SIGTERM'); } catch {} }
  await sleep(400);
  // Backstop, scoped strictly to OUR scratch profile dir — never a pattern kill.
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout || '';
  for (const l of out.split('\n')) {
    if (!l.includes(SCRATCH)) continue;
    const pid = Number(l.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}

main().then(async () => { await cleanup(); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { console.error('\nFATAL:', e); await cleanup(); process.exit(1); });
