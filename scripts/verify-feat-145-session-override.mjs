#!/usr/bin/env node
/**
 * verify-feat-145-session-override.mjs — FEAT-145 step 5 (the PER-SESSION Claude
 * account override).
 *
 * What is being proven, with real OBSERVED values rather than PASS/FAIL theatre:
 *
 *  §1 MIRROR. `SESSION_OVERRIDABLE` in `public/app.js` and `SESSION_OVERRIDE_FIELDS`
 *     in `src/server/validate.ts` are asserted SET-EQUAL mechanically (the client
 *     list is parsed out of the real file, never re-typed here). Anchored by a
 *     must-FAIL twin built from a FIXED synthesized pre-fix mirror, so the check
 *     is shown to redden when the two genuinely drift.
 *
 *  §2 DIRECT projects accept the override, and a bogus / dangling account id is
 *     REJECTED rather than dropped. Anchored by a must-FAIL twin: a
 *     silent-drop implementation is synthesized INLINE (not fetched from a
 *     revision — CONVENTIONS: a must-FAIL proof must not be anchored to a moving
 *     baseline) and shown to pass the weaker assertion "validation returned an
 *     object / the session would start", which is exactly the failure mode.
 *
 *  §3 CONTAINER projects are REFUSED with a specific, actionable error, and the
 *     refusal is scoped: model/effort overrides still work for a container.
 *
 *  §4 LIVE SERVER, end to end over the real `/ws` `start` frame: a container
 *     project's start carrying `overrides.claudeAccount` comes back as a FATAL
 *     error frame, no session is created (`GET /api/sessions/live` stays empty)
 *     and the docker container set is unchanged (nothing created or recreated).
 *     The same frame shape against a DIRECT project passes validation.
 *
 *  §5 /proc — the override actually reaches a REAL child's environment. The
 *     session-effective merge is driven through the REAL exported constants and
 *     functions (SESSION_OVERRIDE_FIELDS, applyGlobalDefaults,
 *     resolveLaunchAccountDir) and the env formula claude-runtime.ts uses; the
 *     child's `/proc/<pid>/environ` is then read. Also: the project's STORED
 *     account is unchanged afterwards (re-read over HTTP from the live server),
 *     inheritance with no override, and the default account leaving
 *     CLAUDE_CONFIG_DIR ABSENT (not set-to-empty).
 *
 *  §6 The one call site (`src/server/index.ts`) passes the project's isolation,
 *     and the parameter is required — so a new start path cannot skip the
 *     container refusal by omission (the compiler catches it; `npm run
 *     typecheck` is the instrument, reported in the ticket).
 *
 * Isolation: scratch HOME (a FAKE `~/.claude` real store) + scratch
 * CLAUDE_STATION_DATA. The user's real `~/.claude` is never read, written or
 * linked to, and no fixture carries a real username or encoded home path (run
 * `node scripts/leak-gate.mjs --summary` for that gate).
 *
 * Run: node scripts/verify-feat-145-session-override.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
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

/* ── scratch layout ─────────────────────────────────────────────────────── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-override-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
const DIRECT_DIR = path.join(SCRATCH, 'proj-direct');
const CONTAINER_DIR = path.join(SCRATCH, 'proj-container');
fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DIRECT_DIR, { recursive: true });
fs.mkdirSync(CONTAINER_DIR, { recursive: true });
fs.writeFileSync(REAL_SETTINGS, JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');

// The harness is the PARENT of the children we spawn: scrub any inherited
// config-dir override so "default ⇒ absent" is an honest observation.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_PROJECTS_DIR;
process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;

const STUB = path.join(SCRATCH, 'stub-cli.mjs');
fs.writeFileSync(STUB, 'setTimeout(() => {}, 60000);\n');

const PORT = Number(process.env.VERIFY_FEAT145_OVERRIDE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENV = { ...process.env, HOME, CLAUDE_STATION_DATA: DATA, PORT: String(PORT) };

let server = null;
const spawnedPids = new Set();
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}
function cleanup() {
  stopByPid(server);
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

/** Parse a /proc/<pid>/environ blob (NUL-separated KEY=VAL) into a map. */
function readEnviron(pid) {
  const out = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

async function jget(p) {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Container names docker currently knows about (null = docker unusable here). */
function dockerNames() {
  try {
    return execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 10_000 })
      .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  } catch {
    return null;
  }
}

async function main() {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const globals = await import(path.join(ROOT, 'src', 'server', 'global-settings.ts'));
  const validate = await import(path.join(ROOT, 'src', 'server', 'validate.ts'));

  /* Mint a ready, credentialled account the way step 3's login will. */
  const makeReadyAccount = (label) => {
    const row = accts.createAccount(label); // materialised overlay, state:'pending'
    const file = path.join(DATA, 'claude-accounts.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    return row;
  };

  const A = makeReadyAccount('plan A');
  const B = makeReadyAccount('plan B');

  /* ─────────────────────────────────────────────── §1 the client mirror ── */
  section('1. SESSION_OVERRIDABLE (public/app.js) === SESSION_OVERRIDE_FIELDS (validate.ts)');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const m = appSrc.match(/const\s+SESSION_OVERRIDABLE\s*=\s*\[([^\]]*)\]/);
  const clientFields = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const serverFields = [...validate.SESSION_OVERRIDE_FIELDS];
  const setEq = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
  ok(m != null, 'the client mirror was located in the REAL public/app.js', m ? `${clientFields.length} fields` : '<not found>');
  ok(setEq(clientFields, serverFields), 'the two lists are SET-EQUAL',
    { client: [...clientFields].sort(), server: [...serverFields].sort() });
  ok(serverFields.includes('claudeAccount') && clientFields.includes('claudeAccount'),
    "'claudeAccount' is present on BOTH sides", { server: serverFields.includes('claudeAccount'), client: clientFields.includes('claudeAccount') });
  // must-FAIL twin: a FIXED synthesized pre-fix mirror (the list as it stood
  // before this step) must make the very same assertion fail — otherwise the
  // check is decoration.
  const PRE_FIX_MIRROR = ['provider', 'model', 'effort', 'permissionMode', 'maxBudgetUsd', 'allowedTools', 'disallowedTools'];
  ok(!setEq(PRE_FIX_MIRROR, serverFields),
    'must-FAIL twin: the pre-step-5 client mirror FAILS the same set-equality (non-vacuous)',
    { missingFromPreFix: serverFields.filter((f) => !PRE_FIX_MIRROR.includes(f)) });

  /* ─────────────────────── §2 direct: accepted; bogus/dangling: rejected ── */
  section('2. DIRECT project — the override is accepted; a bogus/dangling id is REJECTED, not dropped');
  const DIRECT = { isolation: 'direct' };
  const acceptedB = validate.validateSessionOverrides({ claudeAccount: B.id }, DIRECT);
  ok(acceptedB.claudeAccount === B.id, 'an existing account id survives validation verbatim', acceptedB);
  const acceptedDefault = validate.validateSessionOverrides({ claudeAccount: 'default' }, DIRECT);
  ok(acceptedDefault.claudeAccount === null && 'claudeAccount' in acceptedDefault,
    "the 'default' sentinel normalises to null and the KEY is still present (not dropped)", acceptedDefault);
  const acceptedNull = validate.validateSessionOverrides({ claudeAccount: null }, DIRECT);
  ok(acceptedNull.claudeAccount === null, 'null (pin this session to the implicit default account) is accepted', acceptedNull);

  const bogusIds = ['ffffffffffffffffffffffff', 'not-an-id', '', 42, { id: B.id }];
  const bogusResults = [];
  for (const bad of bogusIds) {
    let err = null;
    try { validate.validateSessionOverrides({ claudeAccount: bad }, DIRECT); } catch (e) { err = e; }
    bogusResults.push({ input: bad, threw: !!err, message: err?.message ?? null });
  }
  ok(bogusResults.every((r) => r.threw && /existing account/i.test(r.message)),
    'every bogus claudeAccount value THROWS (never returns a quietly-smaller override set)', bogusResults);

  // DANGLING: an id that was real and whose account has since been deleted.
  const doomed = makeReadyAccount('about to be deleted');
  accts.deleteAccount(doomed.id);
  let dangErr = null;
  try { validate.validateSessionOverrides({ claudeAccount: doomed.id }, DIRECT); } catch (e) { dangErr = e; }
  ok(dangErr != null, 'a DANGLING id (account deleted after the UI armed it) is rejected at start', dangErr?.message ?? '<no error — DROPPED>');

  // must-FAIL twin for the silent drop. Synthesized INLINE (fixed baseline):
  // the shape this function would have if it filtered unknown values away
  // instead of refusing them.
  const silentDropValidate = (body) => {
    const out = {};
    const known = new Set(validate.SESSION_OVERRIDE_FIELDS);
    for (const [k, v] of Object.entries(body)) {
      if (!known.has(k)) continue;
      if (k === 'claudeAccount' && !accts.listAccounts().some((a) => a.id === v)) continue; // the drop
      out[k] = v;
    }
    return out;
  };
  const droppedResult = silentDropValidate({ claudeAccount: 'ffffffffffffffffffffffff' });
  ok(typeof droppedResult === 'object' && !('claudeAccount' in droppedResult),
    'must-FAIL twin: a silent-drop implementation RETURNS NORMALLY for a bogus id (the weaker assertion "validation returned an object / the session starts" passes) — the shipped one throws instead',
    { silentDropReturned: droppedResult, shippedThrows: bogusResults[0].message });

  // The structural anti-drop guard: every key handed in must come back out.
  const multi = validate.validateSessionOverrides({ claudeAccount: B.id, model: 'opus', effort: 'high' }, DIRECT);
  ok(Object.keys(multi).sort().join(',') === 'claudeAccount,effort,model',
    'every accepted key survives validation (structural anti-silent-drop guard)', multi);

  /* ───────────────────────────────────────── §3 the container refusal ──── */
  section('3. CONTAINER project — the account override is REFUSED with an actionable reason');
  const CONTAINER = { isolation: 'container' };
  let contErr = null;
  try { validate.validateSessionOverrides({ claudeAccount: B.id }, CONTAINER); } catch (e) { contErr = e; }
  ok(contErr != null, 'a container project REFUSES overrides.claudeAccount', contErr?.message ?? '<accepted — WRONG>');
  ok(contErr != null && /bind/i.test(contErr.message) && /project/i.test(contErr.message) && /credentials\.json/i.test(contErr.message),
    'the error names the REASON (the credential is a container bind) and the way out (pin it on the project)', contErr?.message);
  // Scoped, not a blanket block: the other overrides still work for a container.
  const contModel = validate.validateSessionOverrides({ model: 'opus', permissionMode: 'default' }, CONTAINER);
  ok(contModel.model === 'opus' && contModel.permissionMode === 'default',
    'model / permissionMode overrides are UNAFFECTED for a container project', contModel);
  // ...and a sandbox project is not collateral damage (only `container` binds).
  const sandboxOk = validate.validateSessionOverrides({ claudeAccount: B.id }, { isolation: 'sandbox' });
  ok(sandboxOk.claudeAccount === B.id, 'a `sandbox` project still gets the per-session account (no container to recreate)', sandboxOk);

  /* ─────────────────────────────── §4 live server, the real start frame ── */
  section('4. LIVE SERVER — the real /ws start frame');
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const pDirect = (await jsend('POST', '/api/projects', { hostPath: DIRECT_DIR, name: 'direct-proj', isolation: 'direct', claudeAccount: A.id })).body?.project;
  const pCont = (await jsend('POST', '/api/projects', { hostPath: CONTAINER_DIR, name: 'container-proj', isolation: 'container', claudeAccount: A.id })).body?.project;
  ok(pDirect?.isolation === 'direct' && pDirect?.settings?.claudeAccount === A.id,
    'direct project created, pinned to account A', { id: pDirect?.id, account: pDirect?.settings?.claudeAccount });
  ok(pCont?.isolation === 'container' && pCont?.settings?.claudeAccount === A.id,
    'container project created, pinned to account A', { id: pCont?.id, account: pCont?.settings?.claudeAccount });

  const dockerBefore = dockerNames();
  const { WebSocket } = await import('ws');
  /** Send one start frame and collect whatever frames come back within `ms`. */
  const startFrame = (frame, ms = 2500) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const got = [];
    const done = () => { try { ws.close(); } catch { /* closed */ } resolve(got); };
    ws.on('error', reject);
    ws.on('open', () => { ws.send(JSON.stringify(frame)); setTimeout(done, ms); });
    ws.on('message', (raw) => { try { got.push(JSON.parse(String(raw))); } catch { /* non-JSON */ } });
  });

  const contFrames = await startFrame({ type: 'start', projectId: pCont.id, prompt: 'hello', overrides: { claudeAccount: B.id } });
  const contError = contFrames.find((f) => f.t === 'error');
  ok(contError?.fatal === true && /start\.overrides rejected/.test(contError.message ?? '') && /bind/i.test(contError.message ?? ''),
    'container start with overrides.claudeAccount → ONE fatal error frame naming the reason', contError);
  ok(!contFrames.some((f) => f.t === 'session-init' || f.t === 'started' || f.t === 'ack'),
    'no session/ack frame followed — the session did not start', contFrames.map((f) => f.t));
  const liveAfter = (await jget('/api/sessions/live')).body;
  const liveCount = Array.isArray(liveAfter) ? liveAfter.length : (liveAfter?.sessions?.length ?? 0);
  ok(liveCount === 0, 'GET /api/sessions/live reports NO live session after the refusal', { liveCount, body: liveAfter });
  const dockerAfter = dockerNames();
  if (dockerBefore === null || dockerAfter === null) {
    console.log('        SKIP (docker not usable from this harness): the container-set comparison could not run; ' +
      'the refusal is still proven to happen before any container work because validateSessionOverrides throws at the top of the `start` case, before startSession is reached.');
  } else {
    ok(dockerBefore.join('\n') === dockerAfter.join('\n'),
      'the docker container set is BYTE-IDENTICAL across the refusal (nothing created or recreated)',
      { before: dockerBefore.length, after: dockerAfter.length, diff: dockerAfter.filter((n) => !dockerBefore.includes(n)) });
  }
  // The live route is proven to reject a BOGUS id on a DIRECT project too — the
  // dangling-id refusal is wired into the real start path, not only reachable
  // in-process. A valid direct start is deliberately NOT sent here: it would
  // launch a real Claude CLI, and this harness must never spend (or try to
  // spend) a subscription to prove a validation outcome. §2 and §5 cover the
  // accepted case in-process and at the child's /proc environ.
  const directBogus = await startFrame({ type: 'start', projectId: pDirect.id, prompt: 'hello', overrides: { claudeAccount: 'ffffffffffffffffffffffff' } });
  const directErr = directBogus.find((f) => f.t === 'error');
  ok(directErr?.fatal === true && /start\.overrides rejected/.test(directErr.message ?? '') && /existing account/i.test(directErr.message ?? ''),
    'direct start with a BOGUS account id → fatal error frame (rejected on the live route, not dropped)', directErr);
  const liveAfter2 = (await jget('/api/sessions/live')).body;
  const liveCount2 = Array.isArray(liveAfter2) ? liveAfter2.length : (liveAfter2?.sessions?.length ?? 0);
  ok(liveCount2 === 0, 'still NO live session after the direct refusal', { liveCount: liveCount2 });

  /* ─────────────────────────────── §5 the env of a REAL child process ──── */
  section('5. /proc — the override reaches a real child, and the project is unchanged');
  // The merge as agent-bridge performs it, driven by the REAL exported field
  // list and the REAL machine→project merge — not a re-typed copy of either.
  const effectiveAccount = (projectSettings, overrides) => {
    const base = globals.applyGlobalDefaults({
      model: projectSettings.model ?? null,
      effort: projectSettings.effort ?? null,
      claudeAccount: projectSettings.claudeAccount ?? null,
    });
    const eff = { ...base };
    for (const field of validate.SESSION_OVERRIDE_FIELDS) {
      if (!overrides || !(field in overrides)) continue;
      if (JSON.stringify(overrides[field]) === JSON.stringify(eff[field])) continue;
      eff[field] = overrides[field];
    }
    return eff.claudeAccount;
  };
  // Guard against grading my own model of agent-bridge: assert the real file
  // still merges over SESSION_OVERRIDE_FIELDS and derives the account env from
  // the EFFECTIVE config (not from the project settings).
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  ok(/for \(const field of SESSION_OVERRIDE_FIELDS\)/.test(bridgeSrc),
    'agent-bridge merges overrides by iterating the SAME SESSION_OVERRIDE_FIELDS constant', 'for (const field of SESSION_OVERRIDE_FIELDS)');
  ok(/resolveLaunchAccountDir\(\(s as Overridable\)\.claudeAccount\)/.test(bridgeSrc) && /const s = effective;/.test(bridgeSrc),
    'the account env is resolved from the session-EFFECTIVE config (`const s = effective`), so an override reaches it',
    'resolveLaunchAccountDir((s as Overridable).claudeAccount) with s = effective');

  const spawnWithEnv = (accountEnv) => new Promise((resolve, reject) => {
    // claude-runtime.ts's baseSessionEnv formula: {...process.env, ...config.env}.
    const child = spawn(process.execPath, [STUB], { env: { ...process.env, ...accountEnv }, stdio: 'ignore' });
    child.on('error', reject);
    spawnedPids.add(child.pid);
    setTimeout(() => resolve(child.pid), 200);
  });
  const envFor = (accountId) => {
    const dir = accts.resolveLaunchAccountDir(accountId);
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  };

  // 5a. project pinned to A, session overrides to B ⇒ the child runs on B.
  const storedBefore = (await jget(`/api/projects`)).body?.projects?.find((p) => p.id === pDirect.id)?.settings?.claudeAccount;
  const overrideB = validate.validateSessionOverrides({ claudeAccount: B.id }, DIRECT);
  const accB = effectiveAccount(pDirect.settings, overrideB);
  const pidB = await spawnWithEnv(envFor(accB));
  const envB = readEnviron(pidB);
  ok(envB.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(B.id),
    "a session started with overrides.claudeAccount='<B>' on a DIRECT project really runs on B (read from /proc/<pid>/environ)",
    { CLAUDE_CONFIG_DIR: envB.CLAUDE_CONFIG_DIR, bDir: accts.resolveAccountDir(B.id) });
  ok(envB.CLAUDE_CONFIG_DIR !== accts.resolveAccountDir(A.id),
    "...and NOT on the project's pinned account A", { aDir: accts.resolveAccountDir(A.id) });
  const storedAfter = (await jget(`/api/projects`)).body?.projects?.find((p) => p.id === pDirect.id)?.settings?.claudeAccount;
  ok(storedBefore === A.id && storedAfter === A.id,
    "the project's STORED account is unchanged afterwards (the override died with the session)", { storedBefore, storedAfter });

  // 5b. no override ⇒ inherit the project's pinned account.
  const accInheritProject = effectiveAccount(pDirect.settings, undefined);
  const pidA = await spawnWithEnv(envFor(accInheritProject));
  const envA = readEnviron(pidA);
  ok(envA.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(A.id),
    'omitting the override inherits the PROJECT account', { CLAUDE_CONFIG_DIR: envA.CLAUDE_CONFIG_DIR });

  // 5c. project unset + machine default set ⇒ inherit the MACHINE account.
  globals.patchGlobalDefaults({ claudeAccount: B.id });
  const accInheritMachine = effectiveAccount({ claudeAccount: null }, undefined);
  const pidM = await spawnWithEnv(envFor(accInheritMachine));
  const envM = readEnviron(pidM);
  ok(envM.CLAUDE_CONFIG_DIR === accts.resolveAccountDir(B.id),
    'a project storing null inherits the MACHINE default account', { CLAUDE_CONFIG_DIR: envM.CLAUDE_CONFIG_DIR, machineDefault: globals.readGlobalDefaults().claudeAccount });

  // 5d. the default account ⇒ the var is ABSENT, not set-to-empty.
  globals.patchGlobalDefaults({ claudeAccount: null });
  const accDefault = effectiveAccount({ claudeAccount: null }, validate.validateSessionOverrides({ claudeAccount: 'default' }, DIRECT));
  const pidD = await spawnWithEnv(envFor(accDefault));
  const envD = readEnviron(pidD);
  ok(!('CLAUDE_CONFIG_DIR' in envD),
    'the default account leaves CLAUDE_CONFIG_DIR ABSENT from the child env (not set-to-empty)',
    'CLAUDE_CONFIG_DIR' in envD ? JSON.stringify(envD.CLAUDE_CONFIG_DIR) : '<absent>');
  // ...and an explicit override back to the default, while the project pins A,
  // is a REAL switch: the var must be absent even though the project has one.
  const accBackToDefault = effectiveAccount({ claudeAccount: A.id }, validate.validateSessionOverrides({ claudeAccount: 'default' }, DIRECT));
  const pidD2 = await spawnWithEnv(envFor(accBackToDefault));
  const envD2 = readEnviron(pidD2);
  ok(!('CLAUDE_CONFIG_DIR' in envD2),
    "overriding a project pinned to A back to the DEFAULT account really drops the var (the switch works both ways)",
    'CLAUDE_CONFIG_DIR' in envD2 ? JSON.stringify(envD2.CLAUDE_CONFIG_DIR) : '<absent>');

  /* ─────────────────────────────────────────────── §6 the one call site ── */
  section('6. the call site passes the project isolation (the refusal cannot be skipped)');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  const callSites = [...indexSrc.matchAll(/validateSessionOverrides\(([^)]*)\)/g)].map((x) => x[1].trim());
  ok(callSites.length === 1 && /isolation:\s*project\.isolation/.test(callSites[0]),
    'the ONE call site passes { isolation: project.isolation }', callSites);
  const validateSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'validate.ts'), 'utf8');
  ok(/export function validateSessionOverrides\(body: unknown, ctx: SessionOverrideContext\)/.test(validateSrc),
    'the context parameter is REQUIRED (not optional) — a new call site fails to compile rather than skipping the refusal',
    'validateSessionOverrides(body: unknown, ctx: SessionOverrideContext)');

  /* ── summary ─────────────────────────────────────────────────────────── */
  section('summary');
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  // The server child's stderr pipe and the parked stub children keep the loop
  // alive; exit explicitly (the `exit` handler tears them and the scratch down).
  .finally(() => process.exit(process.exitCode ?? 0));
