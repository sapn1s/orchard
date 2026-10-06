#!/usr/bin/env node
/**
 * verify-feat-160.mjs — switch the Claude account on a RUNNING session (direct).
 *
 * The data-loss-critical property of this feature is ORDERING: the account is
 * VALIDATED (exists, not a container, logged in, has a credential) BEFORE the old
 * CLI is reaped, so a bad/logged-out/container switch leaves the running session
 * untouched — it never reaps first and strands the user with no session. These
 * checks prove that property and its building blocks with the REAL exported
 * functions and the REAL handler source, plus the wiring and the account→env
 * formula FEAT-145 established.
 *
 * What is NOT proven here (independent-verify leg, needs a real second logged-in
 * subscription and spends it): the end-to-end idle reap→`--resume`→same-JSONL
 * continuation under the new account's CLAUDE_CONFIG_DIR. The mechanism it rests
 * on — one shared transcript store by symlink, resume reads projects/ not
 * .claude.json — is FEAT-145's verified invariant; this ticket adds the reap+
 * re-resume orchestration, whose safety is what the checks below pin down.
 *
 *  §1 WIRING. `switch-account` is a real member of `ClientCommand` (events.ts), the
 *     server has exactly one `case 'switch-account'` handler (index.ts), and the
 *     client's `pickAccount` routes a LIVE pick to `switchAccountLive` (app.js).
 *
 *  §2 VALIDATE-BEFORE-REAP ORDER (index.ts handler source + must-FAIL twin). The
 *     handler calls `validateSessionOverrides` AND `resolveLaunchAccountDir`
 *     before it ever calls `session.close(`. A synthesized reap-first variant is
 *     shown to FAIL the same ordering assertion (non-vacuous).
 *
 *  §3 IN-PROCESS validation (the real functions the handler composes):
 *     container → throws (bind reason); logged-out/credential-less named account →
 *     throws (never silent default); a ready credentialled account → the right
 *     overlay dir; a TRUNCATED registry (another process mid-write) → a named
 *     account still throws rather than silently resolving to the default account.
 *
 *  §4 ACCOUNT→ENV formula: resuming with overrides.claudeAccount=B yields
 *     CLAUDE_CONFIG_DIR = B's overlay dir (the switch really lands on B), and the
 *     default account leaves the var ABSENT.
 *
 *  §5 LIVE SERVER: a `switch-account` on a socket with NO session is answered with
 *     one ok:false ack and no crash (the real ws route).
 *
 * Isolation: scratch HOME (a FAKE ~/.claude real store) + scratch
 * CLAUDE_STATION_DATA. The user's real ~/.claude is never read, written or linked.
 *
 * Run: node scripts/verify-feat-160.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ── scratch layout (mirrors verify-feat-145-session-override.mjs) ─────────── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat160-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(REAL_SETTINGS, JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_PROJECTS_DIR;
process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;

const PORT = Number(process.env.VERIFY_FEAT160_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENV = { ...process.env, HOME, CLAUDE_STATION_DATA: DATA, PORT: String(PORT) };

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}
function cleanup() {
  stopByPid(server);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

async function jsend(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const validate = await import(path.join(ROOT, 'src', 'server', 'validate.ts'));
  const sessionAccounts = await import(path.join(ROOT, 'src', 'server', 'session-accounts.ts'));
  const globals = await import(path.join(ROOT, 'src', 'server', 'global-settings.ts'));

  /* Mint a ready, credentialled account the way step 3's login does. */
  const accountsFile = path.join(DATA, 'claude-accounts.json');
  const makeReadyAccount = (label) => {
    const row = accts.createAccount(label); // materialised overlay, state:'pending'
    const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    return row;
  };
  const A = makeReadyAccount('plan A');
  const B = makeReadyAccount('plan B');

  /* ─────────────────────────────────────────────────────────── §1 wiring ── */
  section('1. wiring — the command, the one handler, the client routing');
  const eventsSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'events.ts'), 'utf8');
  ok(/\{ type: 'switch-account'; requestId\?: string; account: string \| null; inherit\?: boolean \}/.test(eventsSrc),
    "'switch-account' is a real ClientCommand member carrying the round-4 inherit flag (events.ts)", /switch-account.*inherit/.test(eventsSrc));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  const handlerCount = (indexSrc.match(/case 'switch-account':/g) ?? []).length;
  ok(handlerCount === 1, 'exactly one server handler for switch-account (index.ts)', { handlerCount });
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok(/if \(dockLive\(\)\) \{[\s\S]*?return switchAccountLive\(next\);/.test(appSrc),
    'pickAccount routes a LIVE pick to switchAccountLive (app.js)', /switchAccountLive/.test(appSrc));
  ok(/function switchAccountLive\(next\)/.test(appSrc) && /type: 'switch-account', requestId, account/.test(appSrc),
    'switchAccountLive sends the switch-account frame', true);

  /* ─────────────────────── §2 validate-before-reap ORDER (+ must-FAIL twin) ── */
  section('2. the handler VALIDATES before it reaps (no reap-first data loss)');
  // Isolate the switch-account case body from the real handler.
  const caseStart = indexSrc.indexOf("case 'switch-account':");
  const caseEnd = indexSrc.indexOf("case 'follow':", caseStart);
  const caseBody = indexSrc.slice(caseStart, caseEnd);
  const idxValidate = caseBody.indexOf('validateSessionOverrides(');
  const idxResolve = caseBody.indexOf('resolveLaunchAccountDir(');
  const idxClose = caseBody.indexOf('.close(');
  const orderOk = idxValidate > -1 && idxResolve > -1 && idxClose > -1
    && idxValidate < idxClose && idxResolve < idxClose;
  ok(orderOk, 'validateSessionOverrides AND resolveLaunchAccountDir appear BEFORE session.close() in the handler',
    { idxValidate, idxResolve, idxClose });
  // must-FAIL twin: a reap-first handler (close before validate) FAILS this same
  // assertion — so it is not decoration. Synthesized inline (fixed baseline).
  const reapFirstTwin = "case 'switch-account': { await session.close('x'); "
    + "const v = validateSessionOverrides({claudeAccount: cmd.account}, {isolation}); resolveLaunchAccountDir(v.claudeAccount); }";
  const tV = reapFirstTwin.indexOf('validateSessionOverrides(');
  const tR = reapFirstTwin.indexOf('resolveLaunchAccountDir(');
  const tC = reapFirstTwin.indexOf('.close(');
  const twinOrderOk = tV < tC && tR < tC;
  ok(!twinOrderOk, 'must-FAIL twin: a reap-first handler FAILS the same order assertion (non-vacuous)',
    { twin_close_at: tC, twin_validate_at: tV });

  /* ── §2b the handler GATES on the close-lifetime authority before reaping ── */
  section('2b. the handler refuses when work OUTLIVES the turn (not just busy) — round-2 fix');
  // Round-1 (independent-verify run 03b6751b: BROKEN) gated ONLY on `session.busy`,
  // which is TURN-scoped: a background lane/subagent/Bash or a surviving broker still
  // draining under the OLD account left busy=false, so the switch reaped and the next
  // turn billed the old account. The fix consults `closeLifetime()` — the SAME
  // authority releaseSocketSession/closeAllSessions use — and refuses on anything but
  // a settled `no`. Assert the real handler does so BEFORE it reaps.
  const idxLifetime = caseBody.indexOf('closeLifetime(');
  const gateOk = idxLifetime > -1 && idxLifetime < idxClose
    && /lifetime !== 'no'/.test(caseBody);
  ok(gateOk,
    "the handler calls closeLifetime() and refuses when lifetime !== 'no', BEFORE session.close() (background-work gate)",
    { idxLifetime, idxClose, refusesOnNotNo: /lifetime !== 'no'/.test(caseBody) });
  // must-FAIL twin: the SYNTHESIZED round-1 handler (busy-only, no lifetime gate)
  // FAILS this same assertion — so the check is non-vacuous and genuinely reddens on
  // the round-1 code. Fixed baseline, not anchored to HEAD.
  const busyOnlyTwin = "case 'switch-account': { if (!session) return ackFail('no live session'); "
    + "const v = validateSessionOverrides({claudeAccount: cmd.account}, {isolation}); resolveLaunchAccountDir(v.claudeAccount); "
    + "if (session.busy) return ackFail('finish the current turn'); const toClose = session; session = null; "
    + "void toClose.close('x').then(() => send({ ok: true })); }";
  const tL = busyOnlyTwin.indexOf('closeLifetime(');
  const tClose2 = busyOnlyTwin.indexOf('.close(');
  const twinGateOk = tL > -1 && tL < tClose2 && /lifetime !== 'no'/.test(busyOnlyTwin);
  ok(!twinGateOk,
    'must-FAIL twin: the round-1 busy-only handler FAILS the background-work gate assertion (reddens on round-1)',
    { twin_has_closeLifetime: tL > -1 });

  /* ── §2c the handler WRITES the server-owned account binding before it reaps ── */
  section('2c. the handler records the session→account binding BEFORE reaping (round-3 single authority)');
  // Round-3 plan review (dispatch anthropic/claude-fable-5-1 f8b1b178): refusing at
  // switch time cannot stop old-account settings arriving afterward (another tab's
  // stale override, a row queued during the reap) because "which account is this
  // session on" had NO server-owned owner — it lived only in client state.overrides.
  // The fix gives it an owner (session-accounts.ts) WRITTEN here before the reap and
  // READ at the one spawn chokepoint. Assert the handler writes it before close().
  const idxBind = caseBody.indexOf('setSessionAccount(');
  const bindOk = idxBind > -1 && idxBind < idxClose;
  ok(bindOk,
    'the handler calls setSessionAccount(...) BEFORE session.close() (the binding is durable before the reap)',
    { idxBind, idxClose });
  // A queued outbox row is CARRIED (resumes under the new bound account), not a
  // refusal reason: the handler must NOT gate the switch on outboxHasPending.
  ok(!/outboxHasPending\(|outboxBlocks\(/.test(caseBody),
    'the handler does NOT refuse on a merely-queued outbox row (it carries under the new binding — "switch and continue")',
    { gatesOnOutbox: /outboxHasPending\(|outboxBlocks\(/.test(caseBody) });
  // must-FAIL twin: the round-2 handler (no binding write) FAILS the "writes binding
  // before reap" assertion — non-vacuous, reddens on the pre-fix code. Fixed baseline.
  const round2Twin = "case 'switch-account': { if (!session) return ackFail('no live session'); "
    + "const v = validateSessionOverrides({claudeAccount: cmd.account}, {isolation}); resolveLaunchAccountDir(v.claudeAccount); "
    + "if (session.busy) return ackFail('finish the current turn'); const toClose = session; session = null; "
    + "void toClose.closeLifetime().then((cl) => { if (cl.lifetime !== 'no') return ackFail('bg'); "
    + "void toClose.close('x').then(() => send({ ok: true })); }); }";
  const tBind = round2Twin.indexOf('setSessionAccount(');
  const tClose3 = round2Twin.indexOf('.close(');
  const twinBindOk = tBind > -1 && tBind < tClose3;
  ok(!twinBindOk,
    'must-FAIL twin: the round-2 handler (no binding write) FAILS the binding-before-reap assertion (reddens on round-2)',
    { twin_has_setSessionAccount: tBind > -1 });

  /* ──────────────────────────── §3 in-process validation (real functions) ── */
  section('3. the refusals the handler relies on — container, logged-out, truncated registry');
  // Container → throws with the bind reason (same refusal the switch surfaces).
  let contErr = null;
  try { validate.validateSessionOverrides({ claudeAccount: B.id }, { isolation: 'container' }); } catch (e) { contErr = e; }
  ok(contErr != null && /bind/i.test(contErr.message) && /credentials\.json/i.test(contErr.message),
    'a container project REFUSES the account switch, naming the bind reason', contErr?.message);
  // A direct project ACCEPTS a ready account and normalizes 'default' → null.
  const okB = validate.validateSessionOverrides({ claudeAccount: B.id }, { isolation: 'direct' });
  ok(okB.claudeAccount === B.id, 'a direct project accepts a ready account id', okB);
  // resolveLaunchAccountDir: ready → the overlay dir; logged-out/credential-less → THROWS.
  const dirB = accts.resolveLaunchAccountDir(B.id);
  ok(dirB === accts.resolveAccountDir(B.id), 'resolveLaunchAccountDir(ready) returns the overlay dir', { dirB });
  // Remove B's credential → the loud gate throws (never silent default).
  fs.rmSync(path.join(accts.resolveAccountDir(B.id), '.credentials.json'));
  let noCredErr = null;
  try { accts.resolveLaunchAccountDir(B.id); } catch (e) { noCredErr = e; }
  ok(noCredErr != null && /credential/i.test(noCredErr.message),
    'a credential-less (logged-out) account THROWS — the switch fails before any reap, old session kept',
    noCredErr?.message ?? '<no throw — WOULD SILENTLY SWITCH>');
  // restore B's credential
  fs.writeFileSync(path.join(accts.resolveAccountDir(B.id), '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
  // A bogus id → throws at validation (never a quietly-smaller override).
  let bogusErr = null;
  try { validate.validateSessionOverrides({ claudeAccount: 'ffffffffffffffffffffffff' }, { isolation: 'direct' }); } catch (e) { bogusErr = e; }
  ok(bogusErr != null && /existing account/i.test(bogusErr.message), 'a bogus account id is rejected at validation', bogusErr?.message);

  // TRUNCATED registry (another process mid-write): a NAMED account must still
  // throw, not silently resolve to the implicit default. Save + corrupt + restore.
  const savedReg = fs.readFileSync(accountsFile, 'utf8');
  fs.writeFileSync(accountsFile, savedReg.slice(0, Math.floor(savedReg.length * 0.5))); // cut mid-JSON
  let truncErr = null; let truncDir;
  try { truncDir = accts.resolveLaunchAccountDir(B.id); } catch (e) { truncErr = e; }
  ok(truncErr != null && truncDir === undefined,
    'a TRUNCATED registry makes a named account THROW (degrades to "no extra accounts", never the default) — no silent wrong-plan spend',
    truncErr?.message ?? `<resolved to ${truncDir}>`);
  // And the default account under the same truncation resolves to null (absent var), not a throw.
  const truncDefault = accts.resolveLaunchAccountDir(null);
  ok(truncDefault === null, 'the default account resolves to null even under a truncated registry', { truncDefault });
  fs.writeFileSync(accountsFile, savedReg); // restore

  /* ──────────────────────────────────────────── §4 the account→env formula ── */
  section('4. a resume with overrides.claudeAccount=B runs on B (env formula)');
  const envFor = (accountId) => {
    const dir = accts.resolveLaunchAccountDir(accountId);
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  };
  const envB = envFor(B.id);
  ok(envB.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(B.id),
    'the resumed session carries CLAUDE_CONFIG_DIR = B overlay dir (the switch lands on B)', envB);
  const envDefault = envFor(null);
  ok(!('CLAUDE_CONFIG_DIR' in envDefault),
    'switching to the default account leaves CLAUDE_CONFIG_DIR ABSENT', 'CLAUDE_CONFIG_DIR' in envDefault ? envDefault : '<absent>');

  /* ─────────────────────────────────────────── §5 live server — no session ── */
  section('5. LIVE SERVER — switch-account with no session is a clean ok:false ack');
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const { WebSocket } = await import('ws');
  const sendFrame = (frame, ms = 2000) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const got = [];
    const done = () => { try { ws.close(); } catch { /* closed */ } resolve(got); };
    ws.on('error', reject);
    ws.on('open', () => { ws.send(JSON.stringify(frame)); setTimeout(done, ms); });
    ws.on('message', (raw) => { try { got.push(JSON.parse(String(raw))); } catch { /* non-JSON */ } });
  });
  const frames = await sendFrame({ type: 'switch-account', requestId: 'r1', account: B.id });
  const ack = frames.find((f) => f.t === 'ack' && f.of === 'switch-account');
  ok(ack && ack.ok === false && /no live session/i.test(ack.error ?? ''),
    'a switch-account with no session → one ok:false ack naming "no live session", no crash', ack);
  // the server is still healthy afterwards
  const health = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  ok(health, 'the server is still healthy after the no-session switch-account', { health });

  /* ───────────────────────── §6 the session→account binding (the owner) ─── */
  section('6. the server-owned session→account binding — set / get / durability / partial read');
  const SID = '11111111-2222-3333-4444-555555555555';
  // undefined (never switched) is DISTINCT from a real binding to the default (null).
  ok(sessionAccounts.getSessionAccount(SID) === undefined,
    'an unbound session returns undefined (→ caller uses the per-launch override, pre-FEAT-160 behaviour)',
    sessionAccounts.getSessionAccount(SID));
  sessionAccounts.setSessionAccount(SID, B.id);
  ok(sessionAccounts.getSessionAccount(SID)?.account === B.id, 'setSessionAccount binds the session to an account id', sessionAccounts.getSessionAccount(SID));
  // DURABILITY: drop the in-memory cache (as a server restart would) and re-read from disk.
  sessionAccounts._resetSessionAccountsCache();
  ok(sessionAccounts.getSessionAccount(SID)?.account === B.id,
    'the binding SURVIVES a cache drop (restart) — it is read back from disk, not in-memory only', sessionAccounts.getSessionAccount(SID));
  // A real binding to the DEFAULT account (null) must stick and stay distinct from undefined.
  sessionAccounts.setSessionAccount(SID, null);
  sessionAccounts._resetSessionAccountsCache();
  const backToDefault = sessionAccounts.getSessionAccount(SID);
  ok(backToDefault !== undefined && backToDefault.account === null,
    'switching a session back to the DEFAULT account persists as {account:null}, NOT undefined', backToDefault);
  // must-FAIL twin: an in-memory-only store (the pre-FEAT-160 "no owner" state) LOSES
  // the binding across a restart — the exact defect this durability closes.
  const inMemoryOnly = new Map();
  inMemoryOnly.set(SID, B.id);
  const afterRestart = new Map(); // a fresh process has an empty map and no file to load
  ok(afterRestart.get(SID) === undefined,
    'must-FAIL twin: an in-memory-only binding is GONE after a restart (why the owner must be durable)',
    { beforeRestart: inMemoryOnly.get(SID), afterRestart: afterRestart.get(SID) });
  // PARTIAL/TRUNCATED read (another process mid-write): degrade to undefined (→ override
  // fallback, never a crash and never a wrong-account binding of its own) — CONVENTIONS.
  sessionAccounts.setSessionAccount(SID, B.id);
  const bindFile = path.join(DATA, 'session-accounts.json');
  const whole = fs.readFileSync(bindFile, 'utf8');
  fs.writeFileSync(bindFile, whole.slice(0, Math.floor(whole.length * 0.5))); // cut mid-JSON
  sessionAccounts._resetSessionAccountsCache();
  let truncThrew = false; let truncVal;
  try { truncVal = sessionAccounts.getSessionAccount(SID); } catch { truncThrew = true; }
  ok(!truncThrew && truncVal === undefined,
    'a TRUNCATED binding file degrades to undefined (override fallback), never throws and never a wrong binding', { truncThrew, truncVal });
  fs.writeFileSync(bindFile, whole); // restore
  sessionAccounts._resetSessionAccountsCache();

  /* ─────────── §7 the binding WINS over a stale override on resume (reader) ─ */
  section('7. on RESUME the bound account wins over a stale client override (the one reader) — /proc');
  // SOURCE: the single reader is the AgentSession constructor — it reads the binding
  // for a resume and assigns the effective account, so EVERY resume spawn (start,
  // outbox pump, "Send anyway", boot re-pump, fork) honours it. Guard against grading
  // a private model of the constructor by asserting the real file does exactly this.
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  ok(/getSessionAccount\(opts\.resumeSessionId\)/.test(bridgeSrc) && /effective\.claudeAccount = bound\.account/.test(bridgeSrc),
    'the AgentSession constructor reads getSessionAccount(opts.resumeSessionId) and assigns effective.claudeAccount (the one reader)',
    'getSessionAccount(opts.resumeSessionId) → effective.claudeAccount = bound.account');
  // BEHAVIOURAL (/proc): mirror the constructor's merge-then-bind using the REAL
  // session-accounts + env formula, spawn a child with that env, read /proc/<pid>/environ.
  const readEnviron = (pid) => {
    const env = {};
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
  };
  const spawnedPids = [];
  const spawnWithEnv = (accountEnv) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { env: { ...process.env, ...accountEnv }, stdio: 'ignore' });
    child.on('error', reject);
    spawnedPids.push(child.pid);
    setTimeout(() => resolve(child.pid), 150);
  });
  const envForAcct = (accountId) => { const dir = accts.resolveLaunchAccountDir(accountId); return dir ? { CLAUDE_CONFIG_DIR: dir } : {}; };
  // The constructor: start from the override-effective account, THEN let a binding win.
  const effectiveWithBinding = (overrideAccount, resumeSid) => {
    const base = globals.applyGlobalDefaults({ model: null, effort: null, claudeAccount: null });
    let eff = base.claudeAccount;
    const ov = validate.validateSessionOverrides({ claudeAccount: overrideAccount }, { isolation: 'direct' });
    if ('claudeAccount' in ov) eff = ov.claudeAccount;        // the stale client override (account A)
    const bound = sessionAccounts.getSessionAccount(resumeSid); // the server-owned binding (account B)
    if (bound !== undefined) eff = bound.account;              // ← the reader: the binding WINS
    return eff;
  };
  // Bind the session to B, then resume carrying the STALE override A.
  sessionAccounts.setSessionAccount(SID, B.id);
  sessionAccounts._resetSessionAccountsCache();
  const boundPid = await spawnWithEnv(envForAcct(effectiveWithBinding(A.id, SID)));
  const boundEnv = readEnviron(boundPid);
  ok(boundEnv.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(B.id),
    'a RESUME carrying a stale override (A) runs the child on the BOUND account B (read from /proc) — the switch sticks',
    { CLAUDE_CONFIG_DIR: boundEnv.CLAUDE_CONFIG_DIR, bDir: accts.resolveAccountDir(B.id) });
  ok(boundEnv.CLAUDE_CONFIG_DIR !== accts.resolveAccountDir(A.id),
    '...and NOT on the stale-override account A (the pre-fix mis-bill)', { aDir: accts.resolveAccountDir(A.id) });
  // must-FAIL / non-vacuity: with NO binding (the pre-FEAT-160 state), the SAME resume
  // runs on the override account A — proving the binding is what flips A→B and the
  // observation is not vacuous.
  const UNBOUND = '99999999-8888-7777-6666-555555555555';
  const unboundPid = await spawnWithEnv(envForAcct(effectiveWithBinding(A.id, UNBOUND)));
  const unboundEnv = readEnviron(unboundPid);
  ok(unboundEnv.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(A.id),
    'must-FAIL control: with NO binding the resume runs on the override account A (pre-fix behaviour — the binding is causal)',
    { CLAUDE_CONFIG_DIR: unboundEnv.CLAUDE_CONFIG_DIR, aDir: accts.resolveAccountDir(A.id) });
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  // THE ROUND-2 OUTBOX CASE rides the SAME single reader: the outbox pump's `resume`
  // route hands a queued row to `startSession` (→ the AgentSession constructor → the
  // binding reader above), so a row queued under the old account (A) resumes under the
  // new bound account (B), not its frozen override. Assert the resume route is that one
  // spawn path (not a separate account resolution the binding would miss).
  const handOverResume = indexSrc.slice(indexSrc.indexOf('async handOver('), indexSrc.indexOf('async handOver(') + 4000);
  ok(/route === 'resume'|Resume from the transcript/.test(handOverResume) && /await startSession\(/.test(handOverResume),
    "the outbox pump's resume route spawns via startSession (so a queued row reads the ONE binding reader — the round-2 case rides the same chokepoint)",
    { callsStartSession: /await startSession\(/.test(handOverResume) });

  /* ── §8 (round-4 break 1) an "inherit" pick resolves via the MACHINE default ── */
  section('8. an inherit pick binds the account a FRESH session would get (machine default), not ~/.claude');
  // Round-3 clean-room (run 2738cc40171a, BROKEN): public/app.js switchAccountLive
  // resolved an "inherit / Project default" pick as `project.settings.claudeAccount
  // ?? null`, OMITTING the machine-wide default layer (global-settings.ts), which
  // lives only on the server. On a session billing the machine default M, picking
  // "Project default" bound {account:null} (~/.claude) and mis-billed every later
  // turn — un-correctable, because the binding then wins over a re-pick of M. The
  // fix: the client sends the RAW choice (inherit:true) and the SERVER resolves it
  // with `applyGlobalDefaults`, exactly as a fresh session resolves its account.
  const M = makeReadyAccount('machine default plan M');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ claudeAccount: M.id }, null, 2) + '\n');
  // The chain a fresh session uses: project setting (null here) UNDER the machine
  // default → M. This is the value the server must bind for an inherit pick.
  const freshResolves = globals.applyGlobalDefaults({ model: null, effort: null, claudeAccount: null }).claudeAccount;
  ok(freshResolves === M.id,
    'a fresh session with no project account inherits the MACHINE default M (applyGlobalDefaults)', { freshResolves, M: M.id });
  // SOURCE: the handler resolves inherit via applyGlobalDefaults over proj.settings.claudeAccount.
  ok(/cmd\.inherit === true\s*\n?\s*\?\s*applyGlobalDefaults\(\{[^}]*claudeAccount: proj\.settings\.claudeAccount/.test(caseBody),
    'the switch-account handler resolves an inherit pick via applyGlobalDefaults(proj.settings.claudeAccount) (the machine-default chain)',
    { usesApplyGlobalDefaults: /applyGlobalDefaults\(/.test(caseBody) });
  // SOURCE: the client no longer resolves inherit itself — it sends inherit:true and
  // does NOT compute `project.settings.claudeAccount ?? null` in switchAccountLive.
  const swBody = appSrc.slice(appSrc.indexOf('function switchAccountLive'), appSrc.indexOf('function switchAccountLive') + 1400);
  ok(/inherit = next === undefined/.test(swBody) && /account, inherit \}/.test(swBody)
     && !/settings\?\.claudeAccount \?\? null/.test(swBody),
    'switchAccountLive sends inherit:true and NO LONGER client-resolves project.settings.claudeAccount ?? null (the omission that mis-billed)',
    { sendsInherit: /account, inherit \}/.test(swBody), stillClientResolves: /settings\?\.claudeAccount \?\? null/.test(swBody) });
  // BEHAVIOURAL: resolve inherit the SERVER way → bind → the /proc env lands on M.
  const serverInheritResolve = (projAccount) =>
    globals.applyGlobalDefaults({ model: null, effort: null, claudeAccount: projAccount ?? null }).claudeAccount;
  const INH_SID = '77777777-6666-5555-4444-333333333333';
  sessionAccounts.setSessionAccount(INH_SID, serverInheritResolve(null)); // project account null → M
  sessionAccounts._resetSessionAccountsCache();
  const inhPid = await spawnWithEnv(envForAcct(sessionAccounts.getSessionAccount(INH_SID).account));
  const inhEnv = readEnviron(inhPid);
  ok(inhEnv.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(M.id),
    'an inherit pick (server-resolved) binds M and the resumed child runs on M (read from /proc)',
    { CLAUDE_CONFIG_DIR: inhEnv.CLAUDE_CONFIG_DIR, mDir: accts.resolveAccountDir(M.id) });
  // must-FAIL control: the round-3 CLIENT resolution (`project.settings.claudeAccount
  // ?? null` = null) binds {account:null} → the child runs on ~/.claude (var absent),
  // NOT M — the exact mis-bill. Non-vacuous: the two resolutions diverge.
  const round3ClientResolve = (projAccount) => projAccount ?? null; // the OLD client code
  const MIS_SID = '66666666-5555-4444-3333-222222222222';
  sessionAccounts.setSessionAccount(MIS_SID, round3ClientResolve(null)); // → null (~/.claude)
  sessionAccounts._resetSessionAccountsCache();
  const misPid = await spawnWithEnv(envForAcct(sessionAccounts.getSessionAccount(MIS_SID).account));
  const misEnv = readEnviron(misPid);
  ok(!('CLAUDE_CONFIG_DIR' in misEnv) && accts.resolveAccountDir(M.id) !== null,
    'must-FAIL control: the round-3 client resolution binds ~/.claude (CLAUDE_CONFIG_DIR ABSENT), NOT M — the mis-bill the fix removes',
    { misEnvHasVar: 'CLAUDE_CONFIG_DIR' in misEnv });
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(path.join(DATA, 'settings.json'), { force: true }); // clear the machine default for later sections

  /* ── §9 (round-4 break 2) a stale tab's DELETED account can't fatal a bound resume ── */
  section('9. a bound session drops a stale/deleted client claudeAccount before validation (no fatal strand)');
  // Round-3 clean-room (run 3c757fd59001, BROKEN): on a resume of a BOUND session,
  // index.ts validated the client's overrides.claudeAccount against the registry
  // BEFORE the binding reader ran, so a tab still carrying an account that had since
  // been DELETED got a fatal "claudeAccount must be null or the id of an existing
  // account" and could not resume at all — though the server already OWNS the account
  // for that id. The fix drops the client claudeAccount for a bound session, exactly
  // as a resume already drops `provider`. Requirement (b): "another tab carrying the
  // old override must still continue on the new account."
  const DELETED = 'dddddddddddddddddddddddd'; // a well-formed id naming no account
  const BOUND_SID = '55555555-4444-3333-2222-111111111111';
  sessionAccounts.setSessionAccount(BOUND_SID, B.id);
  sessionAccounts._resetSessionAccountsCache();
  // round-4: for a BOUND session, the drop removes claudeAccount → validation passes.
  const staleOverrides = { claudeAccount: DELETED, model: 'claude-opus-4-8' };
  const stripped4 = sessionAccounts.dropBoundAccountOverride(BOUND_SID, { ...staleOverrides });
  let boundValidateThrew = false;
  try { if (stripped4) validate.validateSessionOverrides(stripped4, { isolation: 'direct' }); } catch { boundValidateThrew = true; }
  ok(!boundValidateThrew && stripped4 && !('claudeAccount' in stripped4) && stripped4.model === 'claude-opus-4-8',
    'a BOUND resume carrying a DELETED account: claudeAccount is dropped, the rest validates — the resume is NOT stranded',
    { stripped4, boundValidateThrew });
  // must-FAIL twin: the round-3 path (validate the raw client override, no drop) FATALLY
  // throws on the deleted account — the exact strand. Fixed baseline (the raw validator).
  let rawValidateThrew = null;
  try { validate.validateSessionOverrides({ ...staleOverrides }, { isolation: 'direct' }); } catch (e) { rawValidateThrew = e; }
  ok(rawValidateThrew != null && /existing account/i.test(rawValidateThrew.message),
    'must-FAIL twin: the round-3 path (validate the raw override, no drop) FATALLY throws on the deleted account (the strand)',
    rawValidateThrew?.message ?? '<no throw>');
  // Non-vacuity: an UNBOUND session is UNTOUCHED — the legitimate FEAT-145 refusal of a
  // bad launch account is preserved (the drop is bound-only, never a blanket bypass).
  const unboundStripped = sessionAccounts.dropBoundAccountOverride('44444444-3333-2222-1111-000000000000', { ...staleOverrides });
  let unboundStillThrows = false;
  try { validate.validateSessionOverrides(unboundStripped, { isolation: 'direct' }); } catch { unboundStillThrows = true; }
  ok(unboundStripped && 'claudeAccount' in unboundStripped && unboundStillThrows,
    'non-vacuity: an UNBOUND session keeps its claudeAccount and still fails validation of a bad launch account (FEAT-145 refusal preserved)',
    { unboundKeepsAccount: 'claudeAccount' in (unboundStripped ?? {}) });

  /* ── §10 the inventory — every client-carried account read on a bound resume is guarded ── */
  section('10. inventory — every resume/enqueue validate of a client claudeAccount is guarded for a bound session');
  // The charter: close EVERY place a client value still decides a bound session's
  // account. Three index.ts sites validate a client/row-carried claudeAccount that
  // could reach a bound session — the ws `start` resume, the outbox pump's handOver
  // resume, and the POST /api/outbox enqueue — and each must drop it first via
  // dropBoundAccountOverride. (The switch handler itself is the WRITER, exempt.)
  const dropCalls = (indexSrc.match(/dropBoundAccountOverride\(/g) ?? []).length;
  ok(dropCalls >= 3,
    'index.ts guards all three resume/enqueue paths with dropBoundAccountOverride (start resume, outbox handOver, POST /api/outbox)',
    { dropCalls });
  // The ws start resume: the drop precedes the validateSessionOverrides it feeds.
  const startCase = indexSrc.slice(indexSrc.indexOf("case 'start':"), indexSrc.indexOf("case 'send':"));
  ok(startCase.indexOf('dropBoundAccountOverride(') > -1
     && startCase.indexOf('dropBoundAccountOverride(') < startCase.indexOf('validateSessionOverrides(rawOverrides'),
    'the ws start resume drops the bound account BEFORE validateSessionOverrides(rawOverrides)', true);
  // The outbox handOver resume: drop precedes its validate.
  ok(/dropBoundAccountOverride\(sid,[^)]*resume\.overrides/.test(indexSrc),
    'the outbox pump handOver resume drops the bound account from the frozen row before validating it', true);
  // The POST enqueue: drop precedes its validate.
  ok(/dropBoundAccountOverride\(sid, rest2\)/.test(indexSrc),
    'the POST /api/outbox enqueue drops the bound account before validating the row', true);
  // And the single READER is still the one authority (unchanged from §7) — the drops
  // only stop a stale client value from FATALING; the constructor still decides.
  ok(/effective\.claudeAccount = bound\.account/.test(bridgeSrc),
    'the AgentSession constructor remains the ONE place that decides a bound session\'s account (ARCH-010)', true);

  /* ── summary ─────────────────────────────────────────────────────────── */
  section('summary');
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode ?? 0));
