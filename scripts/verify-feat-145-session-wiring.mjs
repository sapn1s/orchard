#!/usr/bin/env node
/**
 * verify-feat-145-session-wiring.mjs — FEAT-145 step 4 (global default account,
 * session env wiring, machine→project inheritance).
 *
 * Proof bar (real OBSERVED values, not PASS/FAIL theatre):
 *
 *  A. Module-level resolution, exercised against the REAL modules
 *     (claude-accounts.ts / global-settings.ts / validate.ts) with a scratch
 *     HOME (fake ~/.claude real store) and scratch CLAUDE_STATION_DATA:
 *       - default account  ⇒ resolveLaunchAccountDir returns null (caller sets
 *         NO env var — today's behaviour, byte-identical);
 *       - a not-logged-in (pending) account fails the start LOUDLY;
 *       - a ready account whose credential is gone fails LOUDLY (never a silent
 *         fall back to the default plan's quota);
 *       - a ready+credentialled account resolves to its overlay dir;
 *       - a machine-default id whose account was DELETED normalises back to null
 *         rather than dangling;
 *       - machine → project inheritance: a project storing null LIVE-inherits the
 *         machine default; a non-null project value wins;
 *       - the project PATCH validator accepts null / the default sentinel /
 *         an existing id and rejects an unknown id;
 *       - the overlay's `projects` symlink resolves onto the ONE real store, so a
 *         transcript written by a non-default-account session is readable through
 *         the normal path with ZERO reader changes.
 *
 *  B. The env actually reaches a REAL child process, read from /proc/<pid>/environ
 *     (NOT a mock of the env object):
 *       - DIRECT: a real child spawned with baseSessionEnv exactly as
 *         claude-runtime.ts:573 builds it ({...process.env, ...config.env}) —
 *         non-default ⇒ CLAUDE_CONFIG_DIR present and === the overlay dir; default
 *         ⇒ CLAUDE_CONFIG_DIR ABSENT (not set-to-empty).
 *       - SURVIVAL (the ticket's flagged single-most-likely silent break): the CLI
 *         is launched through the REAL spawnSurvivable → systemd-run --scope →
 *         session-host.mjs path, and CLAUDE_CONFIG_DIR is read from the environ of
 *         the process running under the real `claude-station-host-t-*.scope`. If it
 *         does NOT survive that hop, that is a real finding reported here.
 *
 * Isolation: scratch HOME + scratch CLAUDE_STATION_DATA (isolated data-dir mode,
 * so survival hosts are named `-t-` and reaped by pid only what we spawned). The
 * user's real ~/.claude and real session hosts are never touched.
 *
 * Run: node scripts/verify-feat-145-session-wiring.mjs
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

// ── scratch layout ──────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-wiring-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(REAL_SETTINGS, JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');

// The harness process itself is the parent of the real children we spawn; scrub
// any inherited CLAUDE_CONFIG_DIR so the "default ⇒ absent" assertion is honest
// (a child must not inherit the var from us).
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_PROJECTS_DIR;
process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;

// A stub "CLI" that just parks so /proc/<pid>/environ can be read while it lives.
const STUB = path.join(SCRATCH, 'stub-cli.mjs');
fs.writeFileSync(STUB, 'setTimeout(() => {}, 60000);\n');

const spawnedPids = new Set();
const reapers = [];
function cleanup() {
  for (const r of reapers) { try { r(); } catch { /* ignore */ } }
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

/** Parse a /proc/<pid>/environ blob (NUL-separated KEY=VAL) into a map. */
function readEnviron(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  const out = {};
  for (const kv of raw.split('\0')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

async function main() {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const globals = await import(path.join(ROOT, 'src', 'server', 'global-settings.ts'));
  const validate = await import(path.join(ROOT, 'src', 'server', 'validate.ts'));
  const survival = await import(path.join(ROOT, 'src', 'server', 'survival.ts'));

  // Helper: mint a ready, credentialled account the way step 3's login WILL —
  // createAccount() materialises the overlay + writes a pending row; we then flip
  // it to ready and drop a credential file (exactly what login produces).
  const makeReadyAccount = (label) => {
    const row = accts.createAccount(label); // materialised, state:'pending'
    // flip to ready in the registry (login's job in step 3)
    const file = path.join(DATA, 'claude-accounts.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    return row;
  };

  // ── A1. default ⇒ no env var ───────────────────────────────────────────────
  section('A1. the default account sets NO CLAUDE_CONFIG_DIR');
  ok(accts.resolveLaunchAccountDir(null) === null, 'resolveLaunchAccountDir(null) === null (implicit default)', accts.resolveLaunchAccountDir(null));
  ok(accts.resolveLaunchAccountDir('default') === null, "resolveLaunchAccountDir('default') === null", accts.resolveLaunchAccountDir('default'));

  // ── A2. a not-logged-in (pending) account fails LOUDLY ─────────────────────
  section('A2. a pending (not-logged-in) account refuses the start, loudly');
  const pending = accts.createAccount('pending plan'); // state:'pending'
  let pendErr = null; try { accts.resolveLaunchAccountDir(pending.id); } catch (e) { pendErr = e; }
  ok(pendErr && /not logged in/i.test(pendErr.message) && pendErr.status === 409,
    'pending account throws AccountError(409) mentioning "not logged in"', pendErr?.message);

  // ── A3. ready-but-no-credential fails LOUDLY (no silent default fallback) ───
  section('A3. a ready account whose credential is gone refuses, loudly');
  const noCreds = accts.createAccount('ready but credential-less');
  {
    const file = path.join(DATA, 'claude-accounts.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of reg.accounts) if (r.id === noCreds.id) r.state = 'ready';
    fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
  }
  let credErr = null; try { accts.resolveLaunchAccountDir(noCreds.id); } catch (e) { credErr = e; }
  ok(credErr && /credential/i.test(credErr.message) && /missing/i.test(credErr.message),
    'ready-but-no-.credentials.json throws mentioning the missing credential', credErr?.message);

  // ── A4. a ready + credentialled account resolves to its overlay dir ────────
  section('A4. a ready, credentialled account resolves to its overlay dir');
  const good = makeReadyAccount('My second Max plan');
  const goodDir = accts.resolveLaunchAccountDir(good.id);
  ok(goodDir === path.join(DATA, 'claude-accounts', good.id), 'resolves to <accountsRoot>/<id>', goodDir);
  ok(fs.realpathSync(path.join(goodDir, 'projects')) === fs.realpathSync(REAL_PROJECTS),
    'the overlay `projects` symlink resolves onto the ONE real store', { link: fs.realpathSync(path.join(goodDir, 'projects')), store: fs.realpathSync(REAL_PROJECTS) });

  // ── A5. a machine-default id normalises to null once its account is deleted ─
  section('A5. a dangling machine-default account id normalises to null');
  const doomed = accts.createAccount('will be deleted');
  const setDoomed = globals.patchGlobalDefaults({ claudeAccount: doomed.id });
  ok(setDoomed.ok && setDoomed.value.claudeAccount === doomed.id, 'machine default set to a real id', setDoomed.ok ? setDoomed.value.claudeAccount : setDoomed.error);
  accts.deleteAccount(doomed.id); // the account row is gone; the stored id now dangles
  ok(globals.readGlobalDefaults().claudeAccount === null,
    'readGlobalDefaults() reconciles the deleted id back to null', globals.readGlobalDefaults().claudeAccount);
  // and a stored garbage id normalises to null too (write it raw, bypass patch)
  {
    const gsFile = path.join(DATA, 'global-settings.json');
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(gsFile, 'utf8')); } catch { /* none */ }
    fs.writeFileSync(gsFile, JSON.stringify({ ...cur, claudeAccount: 'deadbeefdeadbeef' }, null, 2) + '\n');
  }
  ok(globals.readGlobalDefaults().claudeAccount === null, 'a hand-written unknown id also normalises to null', globals.readGlobalDefaults().claudeAccount);

  // ── A6. machine → project inheritance (the merge authority) ────────────────
  section('A6. machine → project inheritance via applyGlobalDefaults');
  globals.patchGlobalDefaults({ claudeAccount: good.id }); // machine default = good
  const inherited = globals.applyGlobalDefaults({ model: null, effort: null, claudeAccount: null });
  ok(inherited.claudeAccount === good.id, 'project storing null LIVE-inherits the machine default', inherited.claudeAccount);
  const pinnedProject = makeReadyAccount('project-pinned plan');
  const overridden = globals.applyGlobalDefaults({ model: null, effort: null, claudeAccount: pinnedProject.id });
  ok(overridden.claudeAccount === pinnedProject.id, 'a non-null project value WINS over the machine default', overridden.claudeAccount);

  // ── A7. project PATCH validator ────────────────────────────────────────────
  section('A7. the project settings PATCH validator');
  const vOk = validate.validateProjectPatch({ settings: { claudeAccount: good.id } });
  ok(vOk.settings.claudeAccount === good.id, 'an existing id is accepted', vOk.settings.claudeAccount);
  const vNull = validate.validateProjectPatch({ claudeAccount: null });
  ok(vNull.settings.claudeAccount === null, 'null is accepted (inherit)', vNull.settings.claudeAccount);
  const vDflt = validate.validateProjectPatch({ claudeAccount: 'default' });
  ok(vDflt.settings.claudeAccount === null, "the 'default' sentinel normalises to null", vDflt.settings.claudeAccount);
  let vBad = null; try { validate.validateProjectPatch({ claudeAccount: 'ffffffffffffffffffffffff' }); } catch (e) { vBad = e; }
  ok(vBad && /not .*known|existing account/i.test(vBad.message), 'an unknown id is rejected', vBad?.message);

  // ── A8. one transcript store: a file written to the real store is readable
  //        through a non-default account's overlay path (zero reader changes) ──
  section('A8. a transcript is readable through the overlay (one shared store)');
  const encoded = '-tmp-scratch-project';
  fs.mkdirSync(path.join(REAL_PROJECTS, encoded), { recursive: true });
  fs.writeFileSync(path.join(REAL_PROJECTS, encoded, 'abc.jsonl'), '{"type":"summary"}\n');
  const throughOverlay = path.join(goodDir, 'projects', encoded, 'abc.jsonl');
  ok(fs.existsSync(throughOverlay) && fs.readFileSync(throughOverlay, 'utf8').includes('summary'),
    'the transcript written to ~/.claude/projects is visible through <account>/projects', throughOverlay);

  // ── B1. DIRECT: the env reaches a REAL child (read from /proc) ─────────────
  section('B1. DIRECT — CLAUDE_CONFIG_DIR reaches a real child (baseSessionEnv)');
  // Mirror claude-runtime.ts:573 exactly: baseSessionEnv = {...process.env, ...config.env}.
  // config.env is the accountEnv agent-bridge builds from resolveLaunchAccountDir.
  const runChild = (accountEnv) => new Promise((resolve, reject) => {
    const baseSessionEnv = { ...process.env, ...accountEnv };
    const child = spawn(process.execPath, [STUB], { env: baseSessionEnv, stdio: 'ignore' });
    child.on('error', reject);
    spawnedPids.add(child.pid);
    setTimeout(() => resolve(child.pid), 200);
  });
  const nonDefaultEnv = accts.resolveLaunchAccountDir(good.id) ? { CLAUDE_CONFIG_DIR: goodDir } : {};
  const pidNonDefault = await runChild(nonDefaultEnv);
  const envNonDefault = readEnviron(pidNonDefault);
  ok(envNonDefault.CLAUDE_CONFIG_DIR === goodDir,
    'non-default child /proc environ carries CLAUDE_CONFIG_DIR === overlay dir', envNonDefault.CLAUDE_CONFIG_DIR);
  const defaultAccountEnv = accts.resolveLaunchAccountDir(null) ? { CLAUDE_CONFIG_DIR: '?' } : {};
  const pidDefault = await runChild(defaultAccountEnv);
  const envDefault = readEnviron(pidDefault);
  ok(!('CLAUDE_CONFIG_DIR' in envDefault),
    'default-account child /proc environ has NO CLAUDE_CONFIG_DIR (absent, not empty)', 'CLAUDE_CONFIG_DIR' in envDefault ? envDefault.CLAUDE_CONFIG_DIR : '<absent>');

  // ── B2. SURVIVAL: does the var survive systemd-run --scope → session-host? ──
  section('B2. SURVIVAL — CLAUDE_CONFIG_DIR under the claude-station-host-t-*.scope');
  if (!survival.survivalEnabled()) {
    console.log('        SKIP: survivalEnabled() is false in this environment (no user systemd / XDG_RUNTIME_DIR)');
  } else {
    const { handle } = survival.spawnSurvivable(
      {
        command: process.execPath,
        args: [STUB],
        cwd: SCRATCH,
        // exactly the env the runtime hands the survival spawn: process.env + the
        // account var. If the hop drops it, the child environ below won't have it.
        env: { ...process.env, CLAUDE_CONFIG_DIR: goodDir },
      },
      { stationSessionId: 'feat145-verify' },
    );
    reapers.push(() => handle.reap());
    // Poll the status file the broker writes for the real claudePid.
    const hostsDir = survival.hostsDir();
    let claudePid = null, hostPid = null, statusFile = null;
    for (let i = 0; i < 80 && claudePid == null; i++) {
      await sleep(150);
      const files = fs.existsSync(hostsDir) ? fs.readdirSync(hostsDir).filter((f) => f.endsWith('.json')) : [];
      for (const f of files) {
        try {
          const st = JSON.parse(fs.readFileSync(path.join(hostsDir, f), 'utf8'));
          if (st.claudePid) { claudePid = st.claudePid; hostPid = st.hostPid; statusFile = f; }
        } catch { /* partial write — try again */ }
      }
    }
    if (claudePid) { spawnedPids.add(claudePid); if (hostPid) spawnedPids.add(hostPid); }
    ok(claudePid != null, 'the broker reported a claudePid under the scope', { claudePid, statusFile });
    // Prove it is genuinely under the transient scope, not a stray host child.
    let underScope = false;
    try {
      const cg = fs.readFileSync(`/proc/${claudePid}/cgroup`, 'utf8');
      underScope = /claude-station-host-t-.*\.scope/.test(cg);
      console.log(`        cgroup: ${cg.trim().split('\n').pop()}`);
    } catch { /* race: process may have exited */ }
    ok(underScope, 'claudePid runs under a claude-station-host-t-*.scope cgroup', underScope);
    let survEnv = {};
    try { survEnv = readEnviron(claudePid); } catch (e) { console.log(`        environ read failed: ${e.message}`); }
    ok(survEnv.CLAUDE_CONFIG_DIR === goodDir,
      'the survived child environ carries CLAUDE_CONFIG_DIR === overlay dir (the hop DOES survive)',
      survEnv.CLAUDE_CONFIG_DIR ?? '<absent>');
  }

  // ── summary ────────────────────────────────────────────────────────────────
  section('summary');
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
