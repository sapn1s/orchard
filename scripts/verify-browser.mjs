/**
 * Stealth-browser integration checks.
 *
 * Requires the adapter repo + a Chrome binary; the container section also needs
 * docker. Creates throwaway projects, drives a REAL session that uses a browser
 * tool, and proves per-project socket isolation. Cleans up everything it makes.
 *
 *   npm run verify:browser
 *
 * PROCESS COUNTING (§C): Chrome processes are counted the way the adapter itself
 * does — scanning /proc/<pid>/cmdline for `--user-data-dir=<that project's
 * profile>`. NOT pgrep: a pgrep pattern matches this script's own command line
 * and the shell running it, which has produced false "orphans remain" twice.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BROWSER_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
// The adapter is a separate project this repo neither bundles nor publishes, so
// there is no default location to fall back to (FEAT-049): this live suite needs
// CLAUDE_STATION_SBMCP_REPO pointed at a real checkout, and says so rather than
// probing one machine's layout.
const SBMCP = process.env.CLAUDE_STATION_SBMCP_REPO?.trim();
if (!SBMCP) {
  console.log('SKIP verify-browser: CLAUDE_STATION_SBMCP_REPO is not set — point it at a browser-adapter checkout to run this live suite.');
  process.exit(0);
}
const STATE = path.join(os.homedir(), '.stealth-browser-mcp');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-br-data-'));
const WORK_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-br-a-'));
const WORK_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-br-b-'));
/*
 * Target choice: Indeed sits behind Cloudflare and returns 403 to curl with no
 * body, but renders fully in real Chrome. Zillow (PerimeterX) was the first
 * choice and is a WORSE control: it is stochastic — it served real listings to a
 * fresh profile twice and a "Press & Hold" wall on the next run, which makes a
 * verification that flaps rather than one that fails honestly. Zillow-class
 * sites still work; they are just not something to assert on.
 */
const BLOCKED_URL = 'https://www.indeed.com/jobs?q=software+engineer&l=Seattle';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };
const section = (t) => console.log(`\n=== ${t} ===`);

/** Exactly the adapter's own method — cannot match this script or another project. */
function chromePids(projectId) {
  const needle = `--user-data-dir=${path.join(STATE, 'projects', projectId, 'chrome-data')}`;
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.includes(needle)) out.push(Number(d));
  }
  return out;
}

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function events(ws) { const a = []; ws.on('message', (m) => a.push(JSON.parse(String(m)))); return a; }
const waitEv = async (a, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = a.find(pred); if (h) return h; await sleep(200); } return null; };

let server = null;
const projects = [];

try {
  section('0. preconditions and baseline');
  if (!fs.existsSync(path.join(SBMCP, 'src', 'cli.mjs'))) throw new Error(`precondition failed: adapter CLI missing at ${SBMCP}`);
  const baseA = chromePids('br-a'), baseB = chromePids('br-b');
  check('PRECONDITION: no Chrome running for either test project at start', baseA.length === 0 && baseB.length === 0, `br-a: ${JSON.stringify(baseA)}, br-b: ${JSON.stringify(baseB)}`);

  // Paired control for "the browser can reach what curl cannot".
  let curlCode = 0;
  try {
    curlCode = Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-A', 'Mozilla/5.0 (X11; Linux x86_64)', BLOCKED_URL], { encoding: 'utf8' }).trim());
  } catch { curlCode = -1; }
  check('CONTROL: plain curl is BLOCKED on the target site', curlCode === 403, `curl ${BLOCKED_URL} -> HTTP ${curlCode}`);

  server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  for (let i = 0; i < 80; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(250); } }

  section('1. settings go through the one validator');
  const a = (await api('/api/projects', 'POST', { hostPath: WORK_A, name: 'Br A' })).body.project;
  const b = (await api('/api/projects', 'POST', { hostPath: WORK_B, name: 'Br B' })).body.project;
  projects.push(a.id, b.id);
  const bad = await api(`/api/projects/${a.id}`, 'PATCH', { browser: { enabled: 'yes' } });
  // 30s is below the floor: shorter than that and the shared host daemon can
  // close Chrome inside the ~6s gap between a session starting and its first
  // browser call. See the provenance note in validate.ts.
  const bad2 = await api(`/api/projects/${a.id}`, 'PATCH', { browser: { idleMs: 30000 } });
  const bad3 = await api(`/api/projects/${a.id}`, 'PATCH', { browser: { nonsense: 1 } });
  check(
    'browser settings are validated by the same dialect as everything else',
    bad.status === 400 && bad2.status === 400 && bad3.status === 400,
    `enabled:"yes" -> ${bad.status} ${JSON.stringify(bad.body.error)}; idleMs:30000 -> ${bad2.status} ${JSON.stringify(bad2.body.error)}; unknown -> ${bad3.status} ${JSON.stringify(bad3.body.error)}`,
  );
  await api(`/api/projects/${a.id}`, 'PATCH', { browser: { enabled: true, idleMs: 900000 } });
  const merged = (await api(`/api/projects/${a.id}`, 'PATCH', { browser: { enabled: true } })).body.project.settings.browser;
  check('a partial browser patch merges instead of dropping idleMs', merged.idleMs === 900000 && merged.enabled === true, JSON.stringify(merged));

  section('2. status endpoint is honest before anything is running');
  const st0 = (await api(`/api/projects/${a.id}/browser/status`)).body;
  check('status reports enabled-but-not-running, with the socket path', st0.enabled === true && st0.running === false && typeof st0.socket === 'string' && st0.socket.includes(a.id), JSON.stringify({ enabled: st0.enabled, running: st0.running, socket: st0.socket, chrome_procs_live: st0.chrome_procs_live }));
  const stB = (await api(`/api/projects/${b.id}/browser/status`)).body;
  check('a project without the browser enabled says so rather than erroring', stB.enabled === false && stB.running === false, JSON.stringify({ enabled: stB.enabled, running: stB.running }));
  const startB = await api(`/api/projects/${b.id}/browser/start`, 'POST');
  check('starting a browser on a project that has not enabled it is a 409', startB.status === 409 && startB.body.code === 'not-enabled', `HTTP ${startB.status} ${JSON.stringify(String(startB.body.error).slice(0, 120))}`);

  section('3. a REAL session uses a browser tool on a site curl cannot reach');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ev = events(ws);
  /*
   * ANSWER APPROVALS. The project runs at permissionMode 'default', so an MCP
   * browser tool is routed through canUseTool exactly like any other risky tool.
   * An earlier version of this harness did not answer, and the turn hung for
   * seven minutes waiting — which looked like a browser fault and was not.
   * Auto-approving also proves the approval path covers MCP tools.
   */
  const approvals = [];
  ws.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.t === 'approval-request') {
      approvals.push(e);
      ws.send(JSON.stringify({ type: 'approval-response', requestId: e.requestId, allow: true }));
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({
    type: 'start',
    projectId: a.id,
    prompt:
      `Use the stealth browser tools to navigate to ${BLOCKED_URL}. ` +
      `If the page shows a bot check or interstitial, wait 5 seconds using browser_wait_for and re-read with ` +
      `browser_read; repeat at most twice. Then tell me in one line: the page title, and one concrete job ` +
      `posting you can see (its job title and company). Use only the browser tools.`,
  }));
  const init = await waitEv(ev, (e) => e.t === 'session-init', 240000);
  if (!init) throw new Error(`precondition failed: session never initialised. events=${JSON.stringify(ev.slice(-6))}`);
  const end = await waitEv(ev, (e) => e.t === 'turn-end', 420000);
  const toolCalls = ev.filter((e) => e.t === 'tool-call');
  const browserCalls = toolCalls.filter((e) => /stealth-browser/.test(e.name));
  const navCall = browserCalls.find((e) => /browser_navigate/.test(e.name));
  const results = ev.filter((e) => e.t === 'tool-result' && browserCalls.some((c) => c.toolUseId === e.toolUseId));
  const text = ev.filter((e) => e.t === 'text' && !e.agentId).map((e) => e.text).join('\n');

  check(
    'the browser MCP server was attached and the model actually CALLED a browser tool',
    !!navCall,
    `tool calls: ${JSON.stringify(toolCalls.map((t) => t.name))}`,
  );
  check(
    'the navigate call targeted the blocked URL',
    !!navCall && JSON.stringify(navCall.input ?? {}).includes(new URL(BLOCKED_URL).hostname),
    `input=${JSON.stringify(navCall?.input ?? null).slice(0, 200)}`,
  );
  const good = results.filter((r) => !r.isError);
  check(
    'the browser tool call was routed through the approval channel like any other tool',
    approvals.some((q) => /stealth-browser/.test(q.toolName ?? '')),
    `approval requests: ${JSON.stringify(approvals.map((q) => q.toolName))}`,
  );
  const allPreview = good.map((r) => r.preview ?? '').join('\n');
  const challenged = /press & hold|access to this page has been denied|just a moment|checking your browser/i.test(allPreview);
  /*
   * The strong claim, and the one that must not pass on a bot-check page:
   * the real rendered page (site name + the searched location + job wording),
   * which curl could not obtain at all — it got 403 with no body, asserted above.
   */
  const gotListings = /indeed/i.test(allPreview) && /seattle/i.test(allPreview) && /job|employment|hiring/i.test(allPreview);
  check(
    'the browser tool RETURNED THE REAL RENDERED PAGE (curl got 403 with no body for the same URL)',
    good.length > 0 && gotListings,
    `${results.length} browser tool result(s), ${good.length} ok; bot-challenge seen at some point=${challenged}; ` +
      `preview=${JSON.stringify(allPreview.replace(/\s+/g, ' ').slice(0, 260))}`,
  );
  check(
    'the turn completed and the model reported concrete page content',
    end?.subtype === 'success' && /engineer|developer|inc\.|llc|amazon|microsoft|jobs/i.test(text),
    `subtype=${end?.subtype}; reply=${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 240))}`,
  );
  const liveA = chromePids('br-a');
  check('a real Chrome is running for project A on the HOST', liveA.length > 0, `${liveA.length} chrome process(es) with A's --user-data-dir`);

  section('4. isolation: A can never be handed B\'s socket');
  await api(`/api/projects/${b.id}`, 'PATCH', { browser: { enabled: true } });
  const bindsA = (await api(`/api/projects/${a.id}/browser/status`)).body.containerMounts;
  await api(`/api/projects/${a.id}`, 'PATCH', { isolation: 'container' });
  await api(`/api/projects/${b.id}`, 'PATCH', { isolation: 'container' });
  const cbA = (await api(`/api/projects/${a.id}/browser/status`)).body.containerMounts;
  const cbB = (await api(`/api/projects/${b.id}/browser/status`)).body.containerMounts;
  check(
    'each container gets exactly its OWN socket and nothing else browser-related',
    cbA.length === 2 && cbB.length === 2 &&
      cbA.every((m) => !m.hostPath.includes(`/projects/${b.id}/`)) &&
      cbB.every((m) => !m.hostPath.includes(`/projects/${a.id}/`)) &&
      cbA.some((m) => m.hostPath.includes(`/projects/${a.id}/browser.sock`) && m.containerPath === '/sb/browser.sock') &&
      cbB.some((m) => m.hostPath.includes(`/projects/${b.id}/browser.sock`) && m.containerPath === '/sb/browser.sock'),
    `A -> ${JSON.stringify(cbA.map((m) => `${m.hostPath}:${m.containerPath}`))}\n        B -> ${JSON.stringify(cbB.map((m) => `${m.hostPath}:${m.containerPath}`))}`,
  );
  check('a direct-isolation project reports no container mounts', Array.isArray(bindsA) && bindsA.length === 0, `direct containerMounts=${JSON.stringify(bindsA)}`);

  // The mount guard must not become the bypass. B's state dir is created first so
  // the check exercises the BROWSER guard, not the "host path does not exist" one.
  fs.mkdirSync(path.join(STATE, 'projects', b.id), { recursive: true });
  const bypass1 = await api(`/api/projects/${a.id}`, 'PATCH', { mounts: [{ hostPath: path.join(STATE, 'projects', b.id), containerPath: '/stolen', readOnly: false }] });
  const bypass2 = await api(`/api/projects/${a.id}`, 'PATCH', { mounts: [{ hostPath: WORK_B, containerPath: '/sb', readOnly: false }] });
  const bypass3 = await api(`/api/projects/${a.id}`, 'PATCH', { mounts: [{ hostPath: WORK_B, containerPath: '//sb/browser.sock', readOnly: false }] });
  const bypass4 = await api(`/api/projects/${a.id}`, 'PATCH', { mounts: [{ hostPath: WORK_B, containerPath: '/opt/sbmcp/mcp-stdio.mjs', readOnly: true }] });
  check(
    'a user mount cannot reach another project\'s browser state, nor claim /sb or /opt/sbmcp (incl. the `//` form)',
    [bypass1, bypass2, bypass3, bypass4].every((r) => r.status === 400) &&
      /stealth-browser state directory/.test(String(bypass1.body.error)) &&
      [bypass2, bypass3, bypass4].every((r) => /managed by Claude Station \(stealth browser\)/.test(String(r.body.error))),
    [bypass1, bypass2, bypass3, bypass4].map((r) => `${r.status}:${JSON.stringify(String(r.body.error).slice(0, 110))}`).join('\n        '),
  );

  section('5. stop refuses while a session has the browser attached');
  const stopLive = await api(`/api/projects/${a.id}/browser/stop`, 'POST');
  check(
    'stopping the browser under a live attached session is a 409',
    stopLive.status === 409 && stopLive.body.code === 'live-sessions',
    `HTTP ${stopLive.status} ${JSON.stringify(String(stopLive.body.error).slice(0, 140))}`,
  );
  ws.close();
  await sleep(2500);

  section('6. inside a REAL container: A reaches A, and B\'s socket is simply not there');
  let containerTested = false;
  try {
    execFileSync('docker', ['version'], { stdio: 'pipe' });
    const up = await api(`/api/projects/${a.id}/container/start`, 'POST');
    if (up.status !== 200) throw new Error(`container start -> ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`);
    const probe = `
      const net=require('node:net');
      const fs=require('node:fs');
      const out={sbExists:fs.existsSync('/sb/browser.sock'),shim:fs.existsSync('/opt/sbmcp/mcp-stdio.mjs'),
                 bHostPathVisible:fs.existsSync(${JSON.stringify(path.join(STATE, 'projects', b.id, 'browser.sock'))}),
                 stateDirVisible:fs.existsSync(${JSON.stringify(path.join(STATE, 'projects'))})};
      const c=net.connect('/sb/browser.sock');
      c.on('connect',()=>{c.write(JSON.stringify({id:1,op:'ping'})+'\\n')});
      c.on('data',(d)=>{out.ping=String(d).slice(0,80);console.log(JSON.stringify(out));process.exit(0)});
      c.on('error',(e)=>{out.err=e.code;console.log(JSON.stringify(out));process.exit(0)});
      setTimeout(()=>{out.err='timeout';console.log(JSON.stringify(out));process.exit(0)},8000);
    `;
    const raw = execFileSync('docker', ['exec', '-i', '--user', `${os.userInfo().uid}:${os.userInfo().gid}`, `claude-station-${a.id}`, 'node', '-e', probe], { encoding: 'utf8', timeout: 30000 });
    const o = JSON.parse(raw.trim().split('\n').pop());
    containerTested = true;
    check(
      "A's container reaches A's browser through /sb/browser.sock",
      o.sbExists === true && o.shim === true && !!o.ping && !o.err,
      JSON.stringify(o),
    );
    check(
      "and B's socket path does not exist inside A's container at all",
      o.bHostPathVisible === false && o.stateDirVisible === false,
      `B socket visible=${o.bHostPathVisible}, host browser state dir visible=${o.stateDirVisible}`,
    );
  } catch (err) {
    console.log(`  note  container section skipped: ${String(err.message).slice(0, 200)}`);
  }
  if (!containerTested) console.log('  note  the container isolation assertions did NOT run — treat them as unverified');

  section('7. stop is honest, and leaves no orphaned Chrome');
  const stopped = await api(`/api/projects/${a.id}/browser/stop`, 'POST');
  check(
    'once the session is closed, stop succeeds and reports no orphans',
    stopped.status === 200 && stopped.body.stopped === true && stopped.body.orphans === null,
    `HTTP ${stopped.status} ${JSON.stringify(stopped.body).slice(0, 220)}`,
  );
  const afterA = chromePids('br-a');
  check(
    'ZERO Chrome processes remain for the project (counted by /proc --user-data-dir, not pgrep)',
    afterA.length === 0,
    `before=${JSON.stringify(baseA)} during=${JSON.stringify(liveA)} after=${JSON.stringify(afterA)}`,
  );
  const stFinal = (await api(`/api/projects/${a.id}/browser/status`)).body;
  check('and status agrees that it is no longer running', stFinal.running === false && stFinal.chrome_procs_live === 0, JSON.stringify({ running: stFinal.running, chrome_procs_live: stFinal.chrome_procs_live, daemon_alive: stFinal.daemon_alive }));

  section('8. a missing adapter is a real error, never a silent start');
  server.kill('SIGTERM'); await sleep(1200);
  const server2 = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT + 1), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_SBMCP_REPO: '/nonexistent/sbmcp' },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT + 1}/api/health`); break; } catch { await sleep(250); } }
    const r = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/projects/${a.id}/browser/status`)).json();
    check('status reports the adapter as unavailable with a reason instead of pretending', r.available === false && /not found/.test(r.reason), JSON.stringify({ available: r.available, reason: r.reason }));
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws`);
    const ev2 = events(ws2);
    await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
    ws2.send(JSON.stringify({ type: 'start', projectId: a.id, prompt: 'hello' }));
    const fatal = await waitEv(ev2, (e) => e.t === 'error' && e.fatal, 30000);
    const inited = ev2.find((e) => e.t === 'session-init');
    check(
      'a session on a browser-enabled project REFUSES to start when the browser cannot be provided',
      !!fatal && /stealth browser unavailable/.test(fatal.message) && !inited,
      `fatal=${JSON.stringify(String(fatal?.message ?? '(none)').slice(0, 160))}; session-init seen=${!!inited}`,
    );
    ws2.close();
  } finally {
    try { process.kill(-server2.pid, 'SIGKILL'); } catch { /* gone */ }
  }
} catch (err) {
  fail++;
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  section('cleanup');
  for (const id of projects) {
    try { execFileSync('docker', ['rm', '-f', `claude-station-${id}`], { stdio: 'pipe' }); } catch { /* none */ }
    try { execFileSync(process.execPath, [path.join(SBMCP, 'src/cli.mjs'), 'stop', id], { stdio: 'pipe' }); } catch { /* not running */ }
    fs.rmSync(path.join(STATE, 'projects', id), { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${id}`), { recursive: true, force: true });
  }
  const leftovers = projects.flatMap((id) => chromePids(id));
  console.log(`  leftover chrome processes for test projects: ${JSON.stringify(leftovers)}`);
  if (leftovers.length) { fail++; console.log('  CLEANUP FAILED — orphaned Chrome remains'); }
  try { if (server?.pid) process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(1200);
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  for (const d of [DATA, WORK_A, WORK_B]) fs.rmSync(d, { recursive: true, force: true });
  // Section 3 ran a DIRECT-isolation browser session in WORK_A, so the CLI wrote
  // a `-tmp-cs-br-a-*` transcript dir into the real store. Sweep it.
  const store = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(store).filter((n) => /^-tmp-cs-br-[ab]-/.test(n))) {
      fs.rmSync(path.join(store, d), { recursive: true, force: true });
    }
  } catch { /* store unreadable — nothing to sweep */ }
  console.log(`\n============ browser checks: ${pass} passed, ${fail} failed ============`);
  process.exit(fail ? 1 : 0);
}
