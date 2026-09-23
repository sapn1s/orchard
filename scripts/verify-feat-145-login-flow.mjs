#!/usr/bin/env node
/**
 * verify-feat-145-login-flow.mjs — FEAT-145 step 3 ("Add account" login flow).
 *
 * Grades `src/server/claude-login.ts` + its WS route against a scratch HOME (a
 * FAKE `~/.claude` with a canary) and a scratch `CLAUDE_STATION_DATA`. The
 * user's real `~/.claude` is never read, written or linked to.
 *
 * NO REAL OAUTH LOGIN IS PERFORMED. `scripts/fixtures/feat-145/claude-stub.mjs`
 * replays the RECORDED REAL OUTPUT of claude 2.1.273 on plain pipes, including
 * its two traps (the authorize host is `claude.com/cai/…`; `auth status --json`
 * exits 1 when logged out while still printing valid JSON). Completing a real
 * login would need a human at a browser and would spend a real subscription.
 *
 * Load-bearing checks, each printing its OBSERVED value:
 *   §2  the URL is scraped from the recorded real output, and from a URL SPLIT
 *       across two reads (a per-chunk scraper emits a truncated, dead link)
 *   §3  unrecognised output degrades to "no URL found" + the raw output, twice
 *       over: at the paste prompt, and via the grace timer when nothing is
 *       printed at all. Neither hangs.
 *   §4  cancel kills the CLI's PROCESS GROUP — anchored by a must-FAIL twin in
 *       which a naive single-pid kill IS shown to leave an orphan alive
 *   §5  `state` flips to 'ready' ONLY on `loggedIn:true`, in BOTH directions:
 *       exit 0 + logged out does NOT flip; exit 3 + logged in DOES
 *   §6  the exit-code trap: logged out exits 1 with valid JSON, parsed correctly
 *   §7  the timeout path kills the group and removes the half-made account
 *   §8  a second concurrent login is refused; §9 'default' and 'ready' refused
 *   §10 the pasted code never appears in any event or any file under the data
 *       dir — even when the CLI echoes it back — while the stub PROVES it was
 *       genuinely delivered (so the check is not vacuous)
 *   §11 the same flow end-to-end over a LIVE server's WebSocket, and a dropped
 *       socket killing the group + removing the account
 *
 * Run: node scripts/verify-feat-145-login-flow.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STUB = path.join(HERE, 'fixtures', 'feat-145', 'claude-stub.mjs');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5_000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}
const alive = (pid) => {
  if (!pid || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/* ── scratch layout: a FAKE ~/.claude, a scratch data dir ─────────────────── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-login-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const WORK = path.join(SCRATCH, 'work');            // stub side-channel files
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
const CANARY = path.join(REAL_PROJECTS, 'CANARY-do-not-delete.txt');
const CANARY_BODY = 'the shared transcript store — a login must never touch it\n';

fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(CANARY, CANARY_BODY);
fs.writeFileSync(REAL_SETTINGS, `${JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2)}\n`);

process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;
process.env.CLAUDE_STATION_CLAUDE_BIN = STUB;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_PROJECTS_DIR;
// A desktop the child must NOT inherit (the whole point of the BROWSER pin).
process.env.DISPLAY = ':99';
process.env.WAYLAND_DISPLAY = 'wayland-99';

/** Every pid this run started, so cleanup can never leave one behind. */
const started = new Set();
let server = null;
function cleanup() {
  for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);

const accounts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
const login = await import(path.join(ROOT, 'src', 'server', 'claude-login.ts'));

function newPending(label) {
  const row = accounts.createAccount(label);
  return row;
}
/** Start a login and collect every event it emits. */
function runLogin(id, opts = {}) {
  const events = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const info = login.startClaudeLogin(id, (e) => {
    events.push(e);
    if (e.t === 'claude-login-done') resolveDone(e);
  }, opts);
  started.add(info.pid);
  return { info, events, done };
}
const firstEvent = (events, t) => events.find((e) => e.t === t);
const outputText = (events) => events.filter((e) => e.t === 'claude-login-output').map((e) => e.text).join('');
/** Recursively collect every file body under a dir (for the leak sweep). */
function readAllFiles(dir) {
  const out = {};
  const walk = (p, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(p, e.name);
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) continue;          // never follow into the real store
      if (e.isDirectory()) walk(abs, r);
      else { try { out[r] = fs.readFileSync(abs, 'utf8'); } catch { /* binary */ } }
    }
  };
  walk(dir, '');
  return out;
}

async function main() {
  /* ── 1. preconditions ──────────────────────────────────────────────────── */
  section('1. preconditions — the stub is the CLI under test, the real store is fake');
  ok(fs.existsSync(STUB), 'the recorded-output stub exists (no real OAuth is performed)', STUB);
  ok(accounts.resolveAccountDir('default') === REAL_CLAUDE,
    'the default account resolves to the SCRATCH ~/.claude, not the real one', accounts.resolveAccountDir('default'));

  /* ── 2. URL scraping from the recorded real output ─────────────────────── */
  section('2. authorize-URL scraping against recorded real CLI output');
  const a1 = newPending('recorded real output');
  const envOut = path.join(WORK, 'env1.json');
  const codeOut = path.join(WORK, 'code1.txt');
  const SECRET = `ZQ-${crypto.randomBytes(12).toString('hex')}-CODE`;
  process.env.STUB_MODE = 'real';
  process.env.STUB_ENV_OUT = envOut;
  process.env.STUB_CODE_OUT = codeOut;
  process.env.STUB_ECHO_CODE = '1';               // worst case: the CLI echoes the code
  const r1 = runLogin(a1.id, { timeoutMs: 30_000, urlGraceMs: 25_000 });
  const gotUrl = await until(() => firstEvent(r1.events, 'claude-login-url'), 8_000);
  ok(!!gotUrl, 'a claude-login-url event was emitted', gotUrl?.url ?? '(none)');
  const printedUrl = (outputText(r1.events).match(/https:\S+/) ?? [])[0];
  ok(!!gotUrl && gotUrl.url === printedUrl,
    'the scraped URL is BYTE-IDENTICAL to the line the CLI printed (no truncation, no re-encoding)',
    { scraped: gotUrl?.url?.slice(0, 60), printed: printedUrl?.slice(0, 60), equal: gotUrl?.url === printedUrl });
  ok(!!gotUrl && /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(gotUrl.url),
    'the URL is the REAL host form (claude.com/cai/…, not claude.ai/oauth/…)', gotUrl?.url?.slice(0, 48));

  /* the child env: no browser on the server's own desktop */
  const childEnv = JSON.parse(await until(() => fs.existsSync(envOut) && fs.readFileSync(envOut, 'utf8'), 5_000) || '{}');
  ok(childEnv.CLAUDE_CONFIG_DIR === accounts.resolveAccountDir(a1.id),
    'the child ran with CLAUDE_CONFIG_DIR = the account overlay', childEnv.CLAUDE_CONFIG_DIR);
  ok(childEnv.BROWSER === '/usr/bin/true' && childEnv.DISPLAY === null && childEnv.WAYLAND_DISPLAY === null,
    'BROWSER is a no-op and DISPLAY/WAYLAND_DISPLAY were stripped (parent had both set)',
    { BROWSER: childEnv.BROWSER, DISPLAY: childEnv.DISPLAY, WAYLAND_DISPLAY: childEnv.WAYLAND_DISPLAY, parentDISPLAY: process.env.DISPLAY });
  ok(childEnv.pid === childEnv.pgid,
    'the child is its OWN process-group LEADER (pid === pgid) — what makes a group kill possible',
    { pid: childEnv.pid, pgid: childEnv.pgid });

  /* finish this login: paste the code, expect ready */
  await until(() => outputText(r1.events).includes('Paste code here'), 5_000);
  login.submitClaudeLoginCode(a1.id, SECRET);
  const d1 = await r1.done;
  ok(d1.ok === true && d1.loggedIn === true && d1.subscriptionType === 'max',
    'done: ok, loggedIn from `auth status --json`, plan reported', d1);
  const row1 = accounts.readAccounts().find((r) => r.id === a1.id);
  ok(row1?.state === 'ready' && row1?.lastStatus?.loggedIn === true && row1?.lastStatus?.subscriptionType === 'max',
    'the registry row flipped to ready with the plan written down', row1);

  /* ── 3. the pasted code never leaks ────────────────────────────────────── */
  section('3. the pasted code never appears in an event or in any persisted file');
  ok(fs.existsSync(codeOut) && fs.readFileSync(codeOut, 'utf8') === SECRET,
    'PRECONDITION (non-vacuity): the CLI genuinely RECEIVED the code on stdin', { delivered: fs.existsSync(codeOut) });
  const eventDump = JSON.stringify(r1.events);
  ok(!eventDump.includes(SECRET), 'the code appears in NO emitted event (the whole event stream was grepped)',
    { events: r1.events.length, bytes: eventDump.length, hits: eventDump.split(SECRET).length - 1 });
  ok(outputText(r1.events).includes('«code redacted»'),
    'the CLI DID echo the code back and the relay redacted it (the hard case, exercised)',
    outputText(r1.events).split('\n').filter((l) => l.includes('redacted')).join(' | '));
  const dataFiles = readAllFiles(DATA);
  const leaks = Object.entries(dataFiles).filter(([, body]) => body.includes(SECRET)).map(([k]) => k);
  ok(leaks.length === 0, 'the code appears in NO file under the data dir', { filesScanned: Object.keys(dataFiles).length, leaks });

  /* ── 4. a URL split across two reads is not truncated ──────────────────── */
  section('4. a URL split across two chunk reads is scraped WHOLE');
  const a2 = newPending('split url');
  process.env.STUB_MODE = 'split-url';
  delete process.env.STUB_ECHO_CODE;
  const r2 = runLogin(a2.id, { timeoutMs: 20_000, urlGraceMs: 15_000 });
  const url2 = await until(() => firstEvent(r2.events, 'claude-login-url'), 8_000);
  const printed2 = (outputText(r2.events).match(/https:\S+/) ?? [])[0];
  ok(!!url2 && url2.url === printed2 && url2.url.endsWith('&state=9SxT1nQ0bZ-4hVLmKpWcYr7dEaJgUu2Fi3XoRnAvBlM'),
    'the scraped URL is the WHOLE URL, including the tail that arrived in the second read',
    { len: url2?.url?.length, tail: url2?.url?.slice(-24) });
  login.cancelClaudeLogin(a2.id, 'test cleanup');
  await r2.done;

  /* ── 5. unrecognised output degrades, and never hangs ──────────────────── */
  section('5. unrecognised CLI output degrades to "no URL found" + raw output');
  const a3 = newPending('no url printed');
  process.env.STUB_MODE = 'no-url';
  const r3 = runLogin(a3.id, { timeoutMs: 20_000, urlGraceMs: 15_000 });
  const st3 = await until(() => r3.events.find((e) => e.t === 'claude-login-status' && e.urlFound === false), 8_000);
  ok(!!st3, 'reaching the paste prompt with no URL emits urlFound:false PROMPTLY (not a hang)', st3?.message);
  ok(!!st3 && typeof st3.raw === 'string' && st3.raw.includes('Paste code here'),
    'the degraded report carries the RAW CLI output so the user can act on it', st3?.raw?.trim());
  ok(!firstEvent(r3.events, 'claude-login-url'), 'no bogus URL was invented from unrecognised output', r3.events.map((e) => e.t));
  login.cancelClaudeLogin(a3.id, 'test cleanup');
  await r3.done;

  const a4 = newPending('silent cli');
  process.env.STUB_MODE = 'silent';
  const t4 = Date.now();
  const r4 = runLogin(a4.id, { timeoutMs: 20_000, urlGraceMs: 900 });
  const st4 = await until(() => r4.events.find((e) => e.t === 'claude-login-status' && e.urlFound === false), 8_000);
  ok(!!st4, 'a CLI that prints NOTHING recognisable is reported by the grace timer, not left hanging',
    { afterMs: Date.now() - t4, message: st4?.message });
  login.cancelClaudeLogin(a4.id, 'test cleanup');
  await r4.done;

  /* ── 6. cancel kills the PROCESS GROUP (with a must-FAIL twin) ─────────── */
  section('6. cancel kills the process GROUP, leaves no stray process and no dir');
  const a5 = newPending('cancel me');
  const a5dir = accounts.resolveAccountDir(a5.id);
  const kidPidFile = path.join(WORK, 'kid5.pid');
  process.env.STUB_MODE = 'hang';
  process.env.STUB_CHILD_PID_OUT = kidPidFile;
  const r5 = runLogin(a5.id, { timeoutMs: 60_000, urlGraceMs: 30_000 });
  await until(() => firstEvent(r5.events, 'claude-login-url'), 8_000);
  const kid5 = Number(await until(() => fs.existsSync(kidPidFile) && fs.readFileSync(kidPidFile, 'utf8'), 5_000));
  started.add(kid5);
  ok(alive(r5.info.pid) && alive(kid5),
    'PRECONDITION: both the CLI and a grandchild it spawned are alive', { leader: r5.info.pid, grandchild: kid5 });
  ok(fs.existsSync(a5dir), 'PRECONDITION: the pending account dir exists', a5dir);
  login.cancelClaudeLogin(a5.id, 'cancelled by the test');
  const d5 = await r5.done;
  ok(d5.cancelled === true && d5.ok === false, 'done reports a cancel, not a success', d5);
  const bothDead = await until(() => !alive(r5.info.pid) && !alive(kid5), 8_000);
  ok(bothDead, 'BOTH the CLI and its grandchild are gone (a group kill, not a pid kill)',
    { leaderAlive: alive(r5.info.pid), grandchildAlive: alive(kid5) });
  ok(!fs.existsSync(a5dir), 'the half-made account dir is gone from the accounts root', { exists: fs.existsSync(a5dir) });
  ok(!accounts.readAccounts().some((r) => r.id === a5.id), 'and its registry row is gone',
    accounts.readAccounts().map((r) => r.label));
  const stray = Object.entries(readAllFiles(DATA)).filter(([k]) => k.includes(a5.id) && k.endsWith('.credentials.json'));
  ok(stray.length === 0, 'no credential file survives anywhere under the data dir for that account', stray);

  /* must-FAIL twin, anchored to a FIXED broken variant: kill only the leader
     pid, exactly as `kill $!` would, and show the orphan survives. */
  const twinPidFile = path.join(WORK, 'twin.pid');
  const twin = spawn(process.execPath, [STUB, 'auth', 'login', '--claudeai'], {
    env: { ...process.env, STUB_MODE: 'hang', STUB_CHILD_PID_OUT: twinPidFile, CLAUDE_CONFIG_DIR: path.join(WORK, 'twincfg') },
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  started.add(twin.pid);
  const twinKid = Number(await until(() => fs.existsSync(twinPidFile) && fs.readFileSync(twinPidFile, 'utf8'), 5_000));
  started.add(twinKid);
  ok(alive(twin.pid) && alive(twinKid), 'twin PRECONDITION: leader + grandchild alive', { leader: twin.pid, grandchild: twinKid });
  try { process.kill(twin.pid, 'SIGKILL'); } catch { /* gone */ }   // the NAIVE kill
  await until(() => !alive(twin.pid), 5_000);
  await sleep(400);
  ok(!alive(twin.pid) && alive(twinKid),
    'must-FAIL twin: a naive single-PID kill leaves the grandchild ORPHANED and running (this test is non-vacuous)',
    { leaderAlive: alive(twin.pid), grandchildAlive: alive(twinKid) });
  try { process.kill(twinKid, 'SIGKILL'); } catch { /* gone */ }

  /* ── 7. state flips ONLY on loggedIn:true — both directions ────────────── */
  section('7. state flips to ready ONLY on loggedIn:true (never on an exit code)');
  delete process.env.STUB_CHILD_PID_OUT;
  const a6 = newPending('exits 0 but never signed in');
  process.env.STUB_MODE = 'exit-immediately';
  const r6 = runLogin(a6.id, { timeoutMs: 20_000, urlGraceMs: 15_000 });
  const d6 = await r6.done;
  const row6 = accounts.readAccounts().find((r) => r.id === a6.id);
  ok(d6.ok === false && d6.loggedIn === false, 'a CLI that EXITS 0 without signing in is reported as NOT signed in', d6.reason);
  ok(row6?.state === 'pending', 'the row stayed pending — exit 0 did NOT flip it', row6);

  const a7 = newPending('exits 3 but IS signed in');
  process.env.STUB_MODE = 'exit-nonzero-but-logged-in';
  const r7 = runLogin(a7.id, { timeoutMs: 20_000, urlGraceMs: 15_000 });
  const d7 = await r7.done;
  const row7 = accounts.readAccounts().find((r) => r.id === a7.id);
  ok(d7.ok === true && d7.loggedIn === true, 'a CLI that EXITS 3 while genuinely signed in IS accepted (the inverse trap)', d7);
  ok(row7?.state === 'ready', 'the row flipped on the STATUS report, not the exit code', row7);

  let markRefusal = null;
  try { accounts.markAccountReady(a6.id, { loggedIn: false, subscriptionType: null, checkedAt: Date.now() }); }
  catch (e) { markRefusal = e.message; }
  ok(!!markRefusal && /loggedIn:true/.test(markRefusal),
    'markAccountReady REFUSES a health that does not say loggedIn:true', markRefusal);

  /* ── 8. the exit-code trap on `auth status --json` ─────────────────────── */
  section('8. `claude auth status --json` exits 1 when logged out — parsed anyway');
  const a8 = newPending('logged out probe');
  const a8dir = accounts.materialiseAccountDir(a8.id).dir;
  const probe = await new Promise((resolve) => {
    const c = spawn(process.execPath, [STUB, 'auth', 'status', '--json'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: a8dir, STUB_STATUS_LOGGED_IN: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  let parsedProbe = null; try { parsedProbe = JSON.parse(probe.out); } catch { /* graded below */ }
  ok(probe.code === 1 && parsedProbe && parsedProbe.loggedIn === false,
    'PRECONDITION: the trap is real — exit code 1 WITH valid JSON on stdout', { exitCode: probe.code, json: parsedProbe });
  process.env.STUB_STATUS_LOGGED_IN = '0';
  const health = await accounts.readAccountHealth(a8.id);
  delete process.env.STUB_STATUS_LOGGED_IN;
  ok(health.loggedIn === false && !health.error && health.configDirectory === a8dir,
    'readAccountHealth PARSED the exit-1 output (no "produced no output" error, config dir read back)', health);
  accounts.deleteAccount(a8.id);

  /* ── 9. the timeout path cleans up ─────────────────────────────────────── */
  section('9. the hard timeout kills the group and removes the half-made account');
  const a9 = newPending('times out');
  const a9dir = accounts.resolveAccountDir(a9.id);
  const kid9File = path.join(WORK, 'kid9.pid');
  process.env.STUB_MODE = 'hang';
  process.env.STUB_CHILD_PID_OUT = kid9File;
  const t9 = Date.now();
  const r9 = runLogin(a9.id, { timeoutMs: 1_200, urlGraceMs: 30_000 });
  const kid9 = Number(await until(() => fs.existsSync(kid9File) && fs.readFileSync(kid9File, 'utf8'), 5_000));
  started.add(kid9);
  const d9 = await r9.done;
  ok(d9.timedOut === true && d9.ok === false, 'done reports a timeout', { afterMs: Date.now() - t9, reason: d9.reason });
  ok(await until(() => !alive(r9.info.pid) && !alive(kid9), 8_000),
    'the whole group is gone after the timeout', { leaderAlive: alive(r9.info.pid), grandchildAlive: alive(kid9) });
  ok(!fs.existsSync(a9dir) && !accounts.readAccounts().some((r) => r.id === a9.id),
    'the half-made account (dir + row) was removed', { dirExists: fs.existsSync(a9dir), accountRemoved: d9.accountRemoved });
  delete process.env.STUB_CHILD_PID_OUT;

  /* ── 10. refusals ──────────────────────────────────────────────────────── */
  section('10. refusals — one at a time, pending only, never the default');
  const b1 = newPending('holder');
  const b2 = newPending('second attempt');
  process.env.STUB_MODE = 'hang';
  const rb = runLogin(b1.id, { timeoutMs: 60_000, urlGraceMs: 30_000 });
  await until(() => firstEvent(rb.events, 'claude-login-url'), 8_000);
  let e2 = null;
  try { login.startClaudeLogin(b2.id, () => {}); } catch (e) { e2 = e; }
  ok(!!e2 && e2.status === 409 && /already in progress/.test(e2.message),
    'a SECOND concurrent login is refused with 409', { status: e2?.status, message: e2?.message });
  ok(login.activeClaudeLogin()?.accountId === b1.id, 'the first login is still the active one', login.activeClaudeLogin());
  login.cancelClaudeLogin(b1.id, 'test cleanup');
  await rb.done;

  let eDefault = null;
  try { login.startClaudeLogin('default', () => {}); } catch (e) { eDefault = e; }
  ok(!!eDefault && eDefault.status === 400 && /default/.test(eDefault.message),
    "login is refused for the implicit 'default' account", { status: eDefault?.status, message: eDefault?.message });

  let eReady = null;
  try { login.startClaudeLogin(a7.id, () => {}); } catch (e) { eReady = e; }
  ok(!!eReady && eReady.status === 409 && /already logged in/.test(eReady.message),
    'login is refused for an account already in state:ready', { status: eReady?.status, message: eReady?.message });

  let eMissing = null;
  try { login.startClaudeLogin('deadbeefdeadbeefdeadbeef', () => {}); } catch (e) { eMissing = e; }
  ok(!!eMissing && eMissing.status === 404, 'login is refused for an id that names no account', { status: eMissing?.status });

  let eCode = null;
  try { login.submitClaudeLoginCode(a7.id, 'whatever'); } catch (e) { eCode = e; }
  ok(!!eCode && eCode.status === 409, 'a code submitted with no login in progress is refused', { status: eCode?.status });

  accounts.deleteAccount(b2.id);

  /* ── 11. the same flow over a LIVE server WebSocket ────────────────────── */
  section('11. end-to-end over a live server WebSocket (the real route)');
  const net = await import('node:net');
  const PORT = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STUB_MODE: 'real', STUB_CODE_OUT: path.join(WORK, 'code-ws.txt') },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => { if (/Error|error/.test(String(d))) process.stderr.write(`  [server!] ${d}`); });
  const up = await until(async () => { try { await fetch(`${BASE}/api/health`); return true; } catch { return false; } }, 25_000);
  ok(up, 'the live server booted on the scratch HOME/DATA', { port: PORT, up });
  if (up) {
    const { WebSocket } = await import('ws');
    const post = await fetch(`${BASE}/api/claude-accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'over the wire' }),
    });
    const wsAcct = (await post.json()).account;
    ok(post.status === 201 && wsAcct.state === 'pending', 'POST created a pending account over HTTP', { status: post.status, state: wsAcct?.state });

    const wsEvents = [];
    const WS_SECRET = `WS-${crypto.randomBytes(10).toString('hex')}`;
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
    const wsDone = new Promise((resolve) => {
      sock.on('message', (m) => {
        const e = JSON.parse(String(m));
        wsEvents.push(e);
        if (e.t === 'claude-login-url') sock.send(JSON.stringify({ type: 'claude-login-code', code: WS_SECRET }));
        if (e.t === 'claude-login-done') resolve(e);
      });
    });
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'claude-login-start', accountId: wsAcct.id }));
    const dws = await Promise.race([wsDone, sleep(20_000).then(() => null)]);
    ok(dws?.ok === true && dws?.loggedIn === true, 'the login completed over the WebSocket route', dws ?? { frames: wsEvents });
    ok(wsEvents.some((e) => e.t === 'claude-login-url' && /claude\.com\/cai\/oauth\/authorize/.test(e.url)),
      'the authorize URL arrived as a distinct structured event on the socket',
      wsEvents.filter((e) => e.t === 'claude-login-url').map((e) => e.url.slice(0, 44)));
    ok(!JSON.stringify(wsEvents).includes(WS_SECRET), 'the pasted code appears in NO frame the socket sent back',
      { frames: wsEvents.length });
    const listed = await (await fetch(`${BASE}/api/claude-accounts`)).json();
    const wsRow = listed.accounts.find((a) => a.id === wsAcct.id);
    ok(wsRow?.state === 'ready', 'GET /api/claude-accounts now reports it ready', wsRow);
    sock.close();

    /* a dropped socket must kill the CLI and remove the half-made account */
    const post2 = await fetch(`${BASE}/api/claude-accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'dropped socket' }),
    });
    const dropAcct = (await post2.json()).account;
    const kidFile = path.join(WORK, 'kid-ws.pid');
    // The server child inherits STUB_MODE from the server env, so restart-free
    // control of the mode is not available; drive the drop against the SAME
    // 'real' stub, which blocks on stdin after printing its prompt.
    const sock2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
    const urlSeen = new Promise((resolve) => {
      sock2.on('message', (m) => { const e = JSON.parse(String(m)); if (e.t === 'claude-login-url') resolve(e); });
    });
    await new Promise((r) => sock2.on('open', r));
    sock2.send(JSON.stringify({ type: 'claude-login-start', accountId: dropAcct.id }));
    await Promise.race([urlSeen, sleep(10_000)]);
    sock2.terminate();
    const goneAfterDrop = await until(async () => {
      const l = await (await fetch(`${BASE}/api/claude-accounts`)).json();
      return !l.accounts.some((a) => a.id === dropAcct.id);
    }, 10_000);
    ok(goneAfterDrop, 'closing the socket mid-login removed the half-made account (and stopped the CLI)',
      { accountStillListed: !goneAfterDrop });
    ok(!fs.existsSync(path.join(DATA, 'claude-accounts', dropAcct.id)),
      'its overlay dir is gone from the accounts root too', { exists: fs.existsSync(path.join(DATA, 'claude-accounts', dropAcct.id)) });
    void kidFile;
  }

  /* ── 12. the shared transcript store is untouched ──────────────────────── */
  section('12. the fake ~/.claude is byte-unchanged across the whole run');
  ok(fs.existsSync(CANARY) && fs.readFileSync(CANARY, 'utf8') === CANARY_BODY,
    'the shared-store canary is intact (no login ever wrote through the overlay symlinks)', fs.existsSync(CANARY));
  ok(!fs.existsSync(path.join(REAL_CLAUDE, '.credentials.json')),
    'no credential was written into the shared store — only into account overlays',
    fs.readdirSync(REAL_CLAUDE));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode ?? 0));
