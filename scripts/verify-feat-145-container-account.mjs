#!/usr/bin/env node
/**
 * FEAT-145 step 6 — container isolation is account-aware.
 *
 * What is under test: `src/server/container-manager.ts` — `desiredBinds()` now
 * binds the project's EFFECTIVE Claude account's `.credentials.json` instead of
 * a hardcoded `~/.claude/.credentials.json`, and refuses LOUDLY (never falls
 * back to the default account) when that account cannot be used.
 *
 * Shape of the proof, in order:
 *   §1  bind-level, no Docker — byte-identical default, account resolution,
 *       machine→project inheritance, and the loud refusals, each anchored by a
 *       SYNTHESIZED pre-change / naive-fallback baseline built inline (never
 *       `git show HEAD:…`, which stops being a pre-fix state the moment the fix
 *       is committed — docs/CONVENTIONS "a must-FAIL proof must not be anchored
 *       to a moving baseline").
 *   §2  `execArgv` — `CLAUDE_CONFIG_DIR` must NOT cross into the container.
 *   §3  REAL Docker — recreate-exactly-once on an account switch, no recreate
 *       loop on a no-op ensure, `docker inspect` showing the new credentials
 *       path, the inode the container actually holds, a REAL session
 *       authenticating as the selected account (and failing on an account whose
 *       credential is invalid, rather than silently succeeding on the default),
 *       and the transcript landing in `containerHistoryDir()` where Orchard's
 *       readers look.
 *
 * Isolation: `CLAUDE_STATION_DATA` is a scratch dir (the accounts registry +
 * global settings.json live there). `HOME` is the REAL home ON PURPOSE — the
 * account overlay symlinks into the real store by design, the default account
 * IS `~/.claude`, and §3 needs the real image + the real credential to prove a
 * live session. Nothing in `~/.claude` is written except this test project's own
 * container session-history dir, which is removed at the end under a guard.
 *
 * No real path or username is written into this file: every path is derived at
 * runtime, and printed values are redacted to `~`.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------- harness */

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
/** Never print a real home path or username into the log. */
const HOME = os.homedir();
const red = (s) => String(s).split(HOME).join('~');
function show(label, value) {
  console.log(`      ${label}: ${red(value)}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feat145-ctr-'));
process.env.CLAUDE_STATION_DATA = path.join(scratch, 'data');
fs.mkdirSync(process.env.CLAUDE_STATION_DATA, { recursive: true });

const cm = await import('../src/server/container-manager.ts');
const accounts = await import('../src/server/claude-accounts.ts');
const paths = await import('../src/lib/paths.ts');

const settingsFile = paths.globalSettingsFile();
function setMachineDefaultAccount(id) {
  fs.writeFileSync(settingsFile, `${JSON.stringify({ claudeAccount: id }, null, 2)}\n`);
}
function clearMachineDefaultAccount() {
  try { fs.rmSync(settingsFile); } catch { /* absent is the cleared state */ }
}

/* ----------------------------------------------------- preconditions (§C) */

const realStore = path.join(HOME, '.claude');
const realCred = path.join(realStore, '.credentials.json');
assert.ok(fs.existsSync(path.join(realStore, 'projects')), `precondition: ${red(realStore)}/projects must exist`);
assert.ok(fs.existsSync(path.join(realStore, 'settings.json')), 'precondition: the real settings.json must exist');
assert.ok(fs.existsSync(realCred), 'precondition: the real default-account credential must exist');
assert.equal(paths.dataDirMode(), 'isolated', 'precondition: this run must use a scratch CLAUDE_STATION_DATA');
assert.ok(paths.accountsDir().startsWith(scratch), 'precondition: the accounts root must be inside the scratch dir');

/* ------------------------------------------------------ account fixtures */

/**
 * Build an account the way step 2/3 would: mint + materialise the overlay, put a
 * `.credentials.json` in it, then flip the row to `ready` (what the login step
 * does). `cred` is one of:
 *   'invalid' — a syntactically-fine file the API will reject (proves the CLI
 *               inside the container really reads THIS file);
 *   'link'    — a symlink to the real default credential, so a named account can
 *               be exercised END TO END with a credential that actually works
 *               without a second subscription existing on this machine, and
 *               without ever copying a real token anywhere;
 *   'none'    — no credential file at all.
 */
function makeAccount(label, cred) {
  const row = accounts.createAccount(label);
  const dir = accounts.resolveAccountDir(row.id);
  const credPath = path.join(dir, '.credentials.json');
  if (cred === 'invalid') {
    fs.writeFileSync(
      credPath,
      `${JSON.stringify({ claudeAiOauth: { accessToken: 'feat145-verify-not-a-real-token', refreshToken: 'feat145-verify-not-a-real-token', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } else if (cred === 'link') {
    fs.symlinkSync(realCred, credPath);
  }
  if (cred !== 'none') {
    const raw = JSON.parse(fs.readFileSync(paths.accountsFile(), 'utf8'));
    for (const r of raw.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(paths.accountsFile(), `${JSON.stringify(raw, null, 2)}\n`);
  }
  return { ...row, dir, credPath };
}

const acctInvalid = makeAccount('verify-invalid-cred', 'invalid');
const acctWorking = makeAccount('verify-working-cred', 'link');
const acctPending = makeAccount('verify-never-logged-in', 'none');
const acctLostCred = makeAccount('verify-lost-cred', 'invalid');
fs.rmSync(acctLostCred.credPath); // ready on paper, credential gone from disk
const MISSING_ID = 'deadbeefdeadbeefdeadbeef'; // well-formed id, no row anywhere

/* --------------------------------------------------------------- projects */

const hostDir = path.join(scratch, 'proj');
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'README.md'), 'feat-145 container account verification fixture\n');

const PROJECT_ID = `feat145v-${Math.random().toString(16).slice(2, 8)}`;
function project(claudeAccount, over = {}) {
  return {
    id: PROJECT_ID,
    name: 'feat145 verify',
    hostPath: hostDir,
    isolation: 'container',
    settings: {
      provider: 'anthropic',
      model: null,
      effort: null,
      claudeAccount,
      mounts: [],
      tools: { serena: false, playwright: false, openaiDispatch: false },
      browser: { enabled: false },
      ...over,
    },
  };
}

const CRED_IN_CONTAINER = `${cm.CONTAINER_HOME}/.claude/.credentials.json`;
const bindString = (b) => `${b.hostPath}:${b.containerPath}${b.readOnly ? ':ro' : ''}`;

/**
 * SYNTHESIZED PRE-CHANGE BASELINE. The pre-FEAT-145 `desiredBinds` differed from
 * today's in exactly one entry — the credentials bind, whose host side was the
 * hardcoded `~/.claude/.credentials.json`. Reconstructed here rather than read
 * from a revision, so this comparison keeps meaning after the fix is committed.
 */
function preChangeBinds(p) {
  return cm.desiredBinds(p).map((b) =>
    b.containerPath === CRED_IN_CONTAINER
      ? { hostPath: path.join(os.homedir(), '.claude', '.credentials.json'), containerPath: CRED_IN_CONTAINER, readOnly: false, why: 'Claude credentials' }
      : b,
  );
}

/** The NAIVE "just resolve the dir, no gate" implementation the fix must not be. */
function naiveFallbackCred(id) {
  try {
    return path.join(accounts.resolveAccountDir(id ?? 'default'), '.credentials.json');
  } catch {
    return realCred; // the naive shape degrades to the default — the failure mode under test
  }
}

let dockerProject = null; // set in §3 so cleanup can find the container

try {
  /* ==================================================================== §1 */
  console.log('\n--- §1 desiredBinds(): resolution, inheritance, and the loud refusals ---');

  const defBinds = cm.desiredBinds(project(null));
  const defCred = defBinds.find((b) => b.containerPath === CRED_IN_CONTAINER);
  show('default-account credentials bind', bindString(defCred));
  check('default-account bind list is byte-identical to the synthesized pre-change list', () => {
    const before = preChangeBinds(project(null)).map(bindString);
    const after = defBinds.map(bindString);
    assert.deepEqual(after, before);
    assert.equal(defCred.hostPath, realCred);
    assert.equal(defCred.readOnly, false);
    assert.equal(defCred.why, 'Claude credentials');
  });

  check('MUST-FAIL anchor: that same comparison DIFFERS for a named account (it is not vacuous)', () => {
    const p = project(acctInvalid.id);
    const before = preChangeBinds(p).map(bindString);
    const after = cm.desiredBinds(p).map(bindString);
    assert.notDeepEqual(after, before);
    const diff = after.filter((b, i) => b !== before[i]);
    assert.equal(diff.length, 1, `exactly one bind may move, got ${diff.length}`);
    assert.ok(diff[0].startsWith(acctInvalid.dir), 'the moved bind must be the account credential');
    show('the one moved bind', diff[0]);
  });

  check('a project pinned to an account binds THAT account credential, container path unchanged', () => {
    const b = cm.desiredBinds(project(acctInvalid.id)).find((x) => x.containerPath === CRED_IN_CONTAINER);
    assert.equal(b.hostPath, acctInvalid.credPath);
    assert.equal(b.hostPath, path.join(accounts.resolveAccountDir(acctInvalid.id), '.credentials.json'));
    assert.equal(b.containerPath, CRED_IN_CONTAINER);
    assert.equal(b.readOnly, false, 'rw, or an in-container token refresh never reaches the host (BUG-136)');
    assert.match(b.why, /account/);
    show('observed', `${bindString(b)}  why="${b.why}"`);
  });

  check('the account overlay dir is NOT bound wholesale (its projects/settings.json are host-only symlinks)', () => {
    const binds = cm.desiredBinds(project(acctInvalid.id));
    assert.ok(!binds.some((b) => b.hostPath === acctInvalid.dir), 'the account dir itself must never be a bind source');
    assert.ok(!binds.some((b) => b.hostPath.startsWith(`${acctInvalid.dir}/projects`)), 'the overlay projects symlink must never be bound');
    const hist = binds.find((b) => b.why === 'session history');
    assert.equal(hist.hostPath, cm.containerHistoryDir(project(acctInvalid.id)), 'history must stay in the ONE real transcript store');
    assert.ok(hist.hostPath.startsWith(path.join(HOME, '.claude', 'projects')));
    show('session-history bind (unchanged by the account)', bindString(hist));
  });

  check('machine default is inherited by a project that has not pinned one', () => {
    setMachineDefaultAccount(acctInvalid.id);
    const b = cm.desiredBinds(project(null)).find((x) => x.containerPath === CRED_IN_CONTAINER);
    assert.equal(b.hostPath, acctInvalid.credPath);
    show('project claudeAccount=null + machine default set', bindString(b));
  });

  check('a project pin OVERRIDES the machine default', () => {
    setMachineDefaultAccount(acctInvalid.id);
    const b = cm.desiredBinds(project(acctWorking.id)).find((x) => x.containerPath === CRED_IN_CONTAINER);
    assert.equal(b.hostPath, acctWorking.credPath);
    show('project pin wins', bindString(b));
  });

  check('clearing the machine default returns the bind list to the pre-change one', () => {
    clearMachineDefaultAccount();
    assert.deepEqual(cm.desiredBinds(project(null)).map(bindString), preChangeBinds(project(null)).map(bindString));
  });

  for (const [label, id, expect] of [
    ['an account that does not exist', MISSING_ID, /does not exist/],
    ['an account that has never been logged in', acctPending.id, /not logged in/],
    ['a ready account whose credential is gone', acctLostCred.id, /credential/],
    // A path-shaped id never matches a registry row, so the "does not exist"
    // gate fires before `resolveAccountDir`'s id validation ever sees it —
    // either way it is refused, and no filesystem path is built from it.
    ['a malformed, path-shaped account id', '../../../etc', /does not exist/],
  ]) {
    check(`LOUD REFUSAL, no silent fallback: ${label}`, () => {
      let err = null;
      try { cm.desiredBinds(project(id)); } catch (e) { err = e; }
      assert.ok(err, 'desiredBinds must throw rather than return a bind list');
      assert.equal(err.name, 'ContainerError');
      assert.equal(err.code, 'account-unavailable');
      assert.match(err.message, expect);
      assert.ok(!err.message.includes(realCred) && !err.detail.includes(realCred), 'the refusal must not point at the default credential');
      // MUST-FAIL anchor: the naive implementation this replaces returns a path
      // — and for two of these cases it is the DEFAULT account's credential,
      // i.e. the other subscription's quota, spent silently.
      const naive = naiveFallbackCred(id);
      assert.equal(typeof naive, 'string');
      show('refusal', `${err.code}: ${err.message}`);
      show('naive (pre-fix) behaviour would have bound', naive);
    });
  }

  let ensureRefusal = null;
  if (cm.dockerAvailable().ok) {
    try { await cm.ensureContainer(project(acctPending.id)); } catch (e) { ensureRefusal = e; }
    check('the refusal also stops ensureContainer, never starting it on the default account', () => {
      assert.ok(ensureRefusal, 'ensureContainer must reject');
      assert.equal(ensureRefusal.code, 'account-unavailable');
      assert.match(ensureRefusal.detail, /would silently[\s\S]*spend the wrong subscription/);
      assert.equal(spawnSync('docker', ['inspect', cm.containerName(PROJECT_ID), '--format', '{{.Id}}'], { encoding: 'utf8' }).status !== 0, true, 'no container may have been created');
      show('ensureContainer refusal', `${ensureRefusal.code}: ${ensureRefusal.message}`);
    });
  }

  /* ==================================================================== §2 */
  console.log('\n--- §2 execArgv(): CLAUDE_CONFIG_DIR must not cross the container boundary ---');

  const argv = cm.execArgv(project(acctWorking.id), {
    command: cm.CONTAINER_CLAUDE_BIN,
    args: ['-p', 'x'],
    env: { CLAUDE_CONFIG_DIR: acctWorking.dir, ORCHARD_SESSION: 'feat145-verify', HOME: HOME },
    execId: 'feat145verify',
  });
  check('CLAUDE_CONFIG_DIR is dropped (it names a HOST path that does not exist in the container)', () => {
    assert.ok(!argv.some((a) => a.startsWith('CLAUDE_CONFIG_DIR=')), argv.join(' '));
    assert.ok(!argv.join(' ').includes(acctWorking.dir));
  });
  check('HOME is forced to the container home and the allowlisted marker still travels', () => {
    assert.ok(argv.includes(`HOME=${cm.CONTAINER_HOME}`));
    assert.ok(argv.includes('ORCHARD_SESSION=feat145-verify'));
    show('env args', argv.filter((a) => /^[A-Z_]+=/.test(a)).map((a) => a.split('=')[0]).join(', '));
  });

  /* ==================================================================== §3 */
  console.log('\n--- §3 REAL Docker: drift, recreate-exactly-once, live auth, transcript ---');

  const dockerOk = cm.dockerAvailable();
  if (!dockerOk.ok) {
    console.log(`SKIP §3 — Docker is not usable here: ${dockerOk.message}`);
    console.log('SKIP §3 — UNPROVEN: recreate-exactly-once, docker inspect binds, live auth, transcript landing.');
    fail++; // a skipped §3 must never read as a pass
    failures.push('§3 Docker section did not run');
  } else {
    show('docker server', dockerOk.message);
    const name = cm.containerName(PROJECT_ID);
    dockerProject = project(null);
    const dk = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
    const idOf = () => dk(['inspect', name, '--format', '{{.Id}}']).stdout.trim();
    const bindsOf = () => JSON.parse(dk(['inspect', name, '--format', '{{json .HostConfig.Binds}}']).stdout.trim() || 'null') ?? [];
    const credBindOf = () => bindsOf().find((b) => b.includes(CRED_IN_CONTAINER)) ?? '';
    dk(['rm', '-f', name]); // a leftover from an aborted earlier run must not be inherited

    async function ensure(p) {
      let log = '';
      const st = await cm.ensureContainer(p, { onLog: (s) => { log += s; } });
      return { st, log, recreates: (log.match(/recreating/g) ?? []).length, id: idOf() };
    }

    const e1 = await ensure(project(null));
    check('ensure #1 on the default account starts a running container', () => {
      assert.equal(e1.st.state, 'running');
      assert.ok(e1.id);
    });
    check('docker inspect shows the DEFAULT account credential bound rw at the container path', () => {
      assert.equal(credBindOf(), `${realCred}:${CRED_IN_CONTAINER}`);
      show('live bind', credBindOf());
    });

    const e2 = await ensure(project(null));
    check('ensure #2 with no change does NOT recreate (no loop)', () => {
      assert.equal(e2.recreates, 0, e2.log);
      assert.equal(e2.id, e1.id, 'the container id must be unchanged');
      show('container id stable', `${e1.id.slice(0, 12)} == ${e2.id.slice(0, 12)}`);
    });

    // A real session on the default account: proves the whole path end to end,
    // and is the control the invalid-account run below is compared against.
    const r1 = runSession(project(null));
    check('a real session in the default-account container authenticates and answers', () => {
      assert.equal(r1.isError, false, `${r1.exit} ${r1.tail}`);
      assert.match(r1.text, /\S/);
      show('CLI result', r1.text.slice(0, 60));
    });
    check('its transcript lands in containerHistoryDir(), where Orchard readers look', () => {
      const dir = cm.containerHistoryDir(project(null));
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      assert.ok(files.length >= 1, `no transcript in ${red(dir)}`);
      const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      assert.match(body, /"cwd":"\/workspace\//);
      show('transcript', `${files.length} file(s) under ~/.claude/projects/${path.basename(dir)}`);
    });

    // ---- switch the PROJECT's account: must recreate exactly once ----------
    const e3 = await ensure(project(acctWorking.id));
    check('switching the project account is DRIFT and recreates the container exactly once', () => {
      assert.equal(e3.recreates, 1, e3.log);
      assert.match(e3.log, /missing bind|unexpected bind|bind list differs/);
      assert.notEqual(e3.id, e1.id, 'a recreate must produce a new container id');
      show('drift reason', e3.log.trim().split('\n').pop());
    });
    check('docker inspect now shows the SELECTED account credential path', () => {
      assert.equal(credBindOf(), `${acctWorking.credPath}:${CRED_IN_CONTAINER}`);
      assert.ok(!bindsOf().some((b) => b.startsWith(`${realCred}:`)), 'the default credential must no longer be bound');
      show('live bind', credBindOf());
    });

    const e4 = await ensure(project(acctWorking.id));
    check('MUST-FAIL-anchored: a second ensure after the switch does NOT recreate again', () => {
      // Non-vacuity: this exact comparison (id equality) DID redden across the
      // real recreate at ensure #3 — e3.id !== e1.id above — so a recreate loop
      // could not pass here silently.
      assert.equal(e4.recreates, 0, e4.log);
      assert.equal(e4.id, e3.id);
      assert.notEqual(e3.id, e1.id, 'anchor: the same check detected the genuine recreate');
      show('container id stable across the no-op ensure', `${e3.id.slice(0, 12)} == ${e4.id.slice(0, 12)}`);
    });

    check('the container holds the SELECTED account file itself (inode identity, not just a path)', () => {
      const inside = dk(['exec', name, 'stat', '-c', '%i', CRED_IN_CONTAINER]).stdout.trim();
      const host = String(fs.statSync(acctWorking.credPath).ino);
      assert.equal(inside, host);
      show('inode inside == host inode', `${inside} == ${host}`);
    });

    const r2 = runSession(project(acctWorking.id));
    check('a real session in the named-account container authenticates and answers', () => {
      assert.equal(r2.isError, false, `${r2.exit} ${r2.tail}`);
      show('CLI result', r2.text.slice(0, 60));
    });
    check('its transcript also lands in containerHistoryDir()', () => {
      const dir = cm.containerHistoryDir(project(acctWorking.id));
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      assert.ok(files.length >= 2, `expected a second transcript in ${red(dir)}, saw ${files.length}`);
      show('transcripts', `${files.length} file(s) under ~/.claude/projects/${path.basename(dir)}`);
    });

    // ---- an account whose credential is invalid must FAIL, not fall back ---
    const e5 = await ensure(project(acctInvalid.id));
    check('switching to a third account recreates once more and rebinds', () => {
      assert.equal(e5.recreates, 1, e5.log);
      assert.equal(credBindOf(), `${acctInvalid.credPath}:${CRED_IN_CONTAINER}`);
    });
    check('the container holds THIS account dir\'s own credential file, distinct from the default one', () => {
      const inside = dk(['exec', name, 'stat', '-c', '%i', CRED_IN_CONTAINER]).stdout.trim();
      const host = String(fs.statSync(acctInvalid.credPath).ino);
      const def = String(fs.statSync(realCred).ino);
      assert.equal(inside, host);
      assert.notEqual(inside, def, 'it must NOT be the default account file');
      show('inode inside == account file, != default file', `${inside} == ${host}, != ${def}`);
    });

    const r3 = runSession(project(acctInvalid.id));
    check('a session on an account with an INVALID credential fails — it does not silently use the default', () => {
      assert.ok(r3.isError !== false, `the CLI answered successfully with a deliberately invalid credential: ${r3.text.slice(0, 200)}`);
      show('observed failure', `exit=${r3.exit} ${(r3.text || r3.tail).replace(/\s+/g, ' ').slice(0, 120)}`);
    });

    // ---- back to the default: the live bind returns to today's value -------
    const e6 = await ensure(project(null));
    check('returning the project to the default account restores the original bind exactly', () => {
      assert.equal(e6.recreates, 1, e6.log);
      assert.equal(credBindOf(), `${realCred}:${CRED_IN_CONTAINER}`);
      assert.deepEqual(bindsOf().slice().sort(), cm.desiredBinds(project(null)).map(bindString).sort());
      assert.deepEqual(bindsOf().slice().sort(), preChangeBinds(project(null)).map(bindString).sort());
      show('live binds == synthesized pre-change binds', `${bindsOf().length} bind(s)`);
    });
  }
} finally {
  /* ------------------------------------------------------------- cleanup */
  try {
    if (dockerProject) spawnSync('docker', ['rm', '-f', cm.containerName(PROJECT_ID)], { encoding: 'utf8', timeout: 60_000 });
  } catch { /* best effort */ }
  // Remove ONLY this run's own container session-history dir from the real
  // store, under a strict guard: it must be the path containerHistoryDir()
  // derives for THIS random test project id, and nothing else.
  try {
    const hist = cm.containerHistoryDir({ id: PROJECT_ID, settings: {} });
    const expected = path.join(HOME, '.claude', 'projects', cm.encodeCwdForStore(cm.containerWorkdir(PROJECT_ID)));
    if (hist === expected && path.basename(hist).includes(PROJECT_ID) && PROJECT_ID.startsWith('feat145v-')) {
      fs.rmSync(hist, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${failures.length ? `\n  failed: ${failures.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);

/* --------------------------------------------------------------- helpers */

/**
 * Run ONE real, non-interactive CLI turn inside the project's container, using
 * the product's OWN argv builder (`execArgv`) rather than a hand-rolled command,
 * so what is exercised is the path a session actually takes.
 */
function runSession(p) {
  const argv = cm.execArgv(p, {
    command: cm.CONTAINER_CLAUDE_BIN,
    args: ['-p', 'Reply with exactly: OK', '--output-format', 'json'],
    env: { CLAUDE_CODE_ENTRYPOINT: 'feat145-verify' },
    execId: `feat145verify${Math.random().toString(16).slice(2, 8)}`,
  });
  const r = spawnSync('docker', argv, { encoding: 'utf8', timeout: 180_000, input: '' });
  const out = `${r.stdout ?? ''}`;
  let isError = null;
  let text = '';
  try {
    const j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    if (typeof j.is_error === 'boolean') isError = j.is_error;
    text = String(j.result ?? j.error ?? '');
  } catch {
    text = out.trim();
  }
  if (r.status !== 0 && isError === null) isError = true;
  return { exit: r.status, isError, text, tail: `${out}\n${r.stderr ?? ''}`.trim().slice(-400) };
}
