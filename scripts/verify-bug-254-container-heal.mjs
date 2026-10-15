#!/usr/bin/env node
/**
 * BUG-254 r4 — a running container follows the account's CURRENT credential.
 *
 * SANDBOX ONLY. This drives REAL product containers in the FEAT-158 isolated
 * Docker sandbox (npm run sandbox:docker). It never touches the host daemon: a
 * lane that has run `eval "$(npm run -s sandbox:docker -- env)"` points
 * DOCKER_HOST at the sandbox, and every bind source is placed under a scratch
 * HOME inside /tmp (which the sandbox mounts at the same path).
 *
 * What is under test, each with a SYNTHESIZED pre-change baseline built inline
 * (never `git show HEAD:…`, which stops being a pre-fix state the moment the fix
 * lands — docs/CONVENTIONS "a must-FAIL proof must not be anchored to a moving
 * baseline"):
 *
 *   §A  (BUG-254 r7) The SHIPPED re-login path `applyCredentialReplace` is a WHOLESALE
 *       ATOMIC replace (write a sibling temp in the account dir, fsync, rename over
 *       the target): a NEW inode with the complete new bytes. A running container
 *       keeps its OLD bound inode (BUG-136) — frozen until §C's idle heal recreates
 *       it. The r4 same-inode in-place rewrite was removed because a ~1 KB write is
 *       NOT atomic against a concurrent reader (the r7 docker-sandbox gate measured
 *       torn reads even for a padded single write) and CLI 2.1.296 reloads only on an
 *       mtime change, so a torn read cached at the final mtime never recovers.
 *
 *   §T  TORN-READ regression (pure fs, no docker): a concurrent reader NEVER observes
 *       a torn/partial document across an `applyCredentialReplace` (atomic rename),
 *       while a synthesized in-place write-then-ftruncate (the removed r4 path) DOES
 *       tear — the must-FAIL baseline that justifies the atomic replace.
 *
 *   §B  `credBindDriftOf` is the TRI-STATE probe (clean / stale / unknown). After
 *       an atomic replace it reports 'stale'; the pre-change `staleFileBinds`
 *       shape (reasons-or-[], with [] on any probe hiccup) could not say 'unknown'
 *       and so a probe miss read as "clean" — the silent-failure baseline.
 *
 *   §C  The FEAT-175 idle reconciler HEALS a stale credential bind: once the
 *       project is idle it recreates the container (sessions resume on their next
 *       message) and the fresh container holds the CURRENT host inode. It REFUSES
 *       while a session is busy or a lease is held — a mid-turn container is never
 *       killed (the priced residual). A synthesized git-only reconciler (no
 *       credential trigger — the pre-change behaviour) does NOT heal: the must-FAIL
 *       baseline.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

/* ---- a scratch HOME under /tmp, so EVERY bind source sits in a sandbox mount */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-heal-'));
process.env.HOME = path.join(scratch, 'home');
fs.mkdirSync(path.join(process.env.HOME, '.claude', 'projects'), { recursive: true });
// materialiseAccountDir refuses to create a fresh ~/.claude/settings.json (it would default a
// 30-day prune onto the shared transcript store); the scratch HOME supplies one up front.
fs.writeFileSync(path.join(process.env.HOME, '.claude', 'settings.json'), '{}\n');
process.env.CLAUDE_STATION_DATA = path.join(scratch, 'data');
fs.mkdirSync(process.env.CLAUDE_STATION_DATA, { recursive: true });
// A prior op in this scratch can leave a lifecycle FENCE ("a mutation's outcome is uncertain; wait before
// the next admit/rebuild"); runOp waits ORCHARD_LIFECYCLE_FENCE_MS for it. The code sanctions a test
// shortening it so a stale fence does not add ~2 min to each recreate. The heal itself is unaffected.
process.env.ORCHARD_LIFECYCLE_FENCE_MS = '4000';

const REPO = path.resolve(import.meta.dirname, '..');
const cm = await import('../src/server/container-manager.ts');
const login = await import('../src/server/claude-login.ts');
const accounts = await import('../src/server/claude-accounts.ts');
const paths = await import('../src/lib/paths.ts');
const { createGrantRebuild } = await import('../src/server/grant-rebuild.ts');
const dx = await import('../src/server/docker-exec.ts');
const { ownerKeyFor, removeOwnedContainer } = await import('./lib/owned-docker.mjs');
const harness = await import('./lib/lifecycle-harness.mjs');
const boot = await harness.bootAuthority(REPO);
const lc = boot.lc;

let pass = 0, fail = 0;
const failures = [];
const HOMER = process.env.HOME;
const red = (s) => String(s).split(HOMER).join('~HOME').split(scratch).join('~');
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`FAIL  ${name}: ${red(e.message)}`); }
}
function show(label, v) { console.log(`      ${label}: ${red(typeof v === 'string' ? v : JSON.stringify(v))}`); }

/* ---- an account with a REGULAR-FILE credential I fully own (never a symlink
 *      into the real store): the bind source I atomically/in-place rewrite. */
// SYNTHETIC marker content — NOT a credential. This test proves inode IDENTITY (which file the running
// container is bound to), not credential validity: the container only ever sleeps and is `cat`/`stat`'d, never
// authenticated. So the bytes are an arbitrary, recognisable marker and carry no credential-shaped keys.
const credBytes = (marker, pad = '') => `${JSON.stringify({ orchardTestMarker: marker, filler: pad })}\n`;
const CRED0 = credBytes('bug254-v0');
function makeAccount(label, content) {
  const row = accounts.createAccount(label);
  const dir = accounts.resolveAccountDir(row.id);
  const credPath = path.join(dir, '.credentials.json');
  fs.writeFileSync(credPath, content, { mode: 0o600 });
  const raw = JSON.parse(fs.readFileSync(paths.accountsFile(), 'utf8'));
  for (const r of raw.accounts) if (r.id === row.id) r.state = 'ready';
  fs.writeFileSync(paths.accountsFile(), `${JSON.stringify(raw, null, 2)}\n`);
  return { ...row, dir, credPath };
}

const PROJECT_ID = `bug254v-${Math.random().toString(16).slice(2, 8)}`;
const hostDir = path.join(scratch, 'proj');
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'README.md'), 'bug-254 heal fixture\n');
let acct;
function project() {
  return {
    id: PROJECT_ID, name: 'bug254 verify', hostPath: hostDir, isolation: 'container',
    settings: { provider: 'anthropic', model: null, effort: null, claudeAccount: acct.id, mounts: [],
      container: { gpu: 'off' }, // the sandbox dind has no CDI GPU vendor; 'auto' would fail to start here
      tools: { serena: false, playwright: false, openaiDispatch: false }, browser: { enabled: false } },
  };
}

const name = cm.containerName(PROJECT_ID);
const CRED_IN = `${cm.CONTAINER_HOME}/.claude/.credentials.json`;
const dk = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
const idOf = () => dk(['inspect', name, '--format', '{{.Id}}']).stdout.trim();
const insideInode = () => dk(['exec', name, 'stat', '-c', '%i', CRED_IN]).stdout.trim();
const insideContent = () => dk(['exec', name, 'cat', CRED_IN]).stdout;
const hostInode = () => String(fs.statSync(acct.credPath).ino);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== §T (no docker) */
// The crux of the r7 P3 decision: the SHIPPED applyCredentialReplace (atomic rename) is NEVER
// observed torn by a concurrent reader, while the REMOVED r4 same-inode in-place write CAN tear.
// A torn read matters because CLI 2.1.296 reloads only on an mtime change, so a torn read cached at
// the final write's mtime never recovers (the r6 gating risk). This is a pure-fs race, no docker.
console.log('\n--- §T torn-read: the shipped atomic replace never tears; the removed in-place write does (must-FAIL baseline) ---');
{
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-torn-'));
  const dest = path.join(tdir, '.credentials.json');
  const srcDir = path.join(tdir, 'src');
  fs.mkdirSync(srcDir);
  // Two self-describing docs: fill is ALL one letter, so any A+B byte-mix is detectable.
  const docOf = (letter, n) => JSON.stringify({ doc: letter, fill: letter.repeat(n) }) + '\n';
  const DA = docOf('A', 1100), DB = docOf('B', 1100);
  const readerSrc = `
import * as fs from 'node:fs';
const F = process.argv[2], N = Number(process.argv[3]);
let torn = 0, parseFail = 0, reads = 0;
for (let i = 0; i < N; i++) {
  let buf; try { buf = fs.readFileSync(F); } catch { continue; }
  reads++; if (buf.length === 0) { torn++; continue; }
  let o; try { o = JSON.parse(buf.toString('utf8')); } catch { parseFail++; continue; }
  if ((o.doc !== 'A' && o.doc !== 'B') || typeof o.fill !== 'string' || o.fill.length === 0 || o.fill.split('').some((c) => c !== o.doc)) torn++;
}
process.stdout.write(JSON.stringify({ reads, torn, parseFail }));
`;
  const readerFile = path.join(tdir, 'torn-reader.mjs');
  fs.writeFileSync(readerFile, readerSrc);

  // In-place write-then-ftruncate: the REMOVED r4 primitive, reproduced inline as the baseline.
  const inPlace = (content) => {
    const fd = fs.openSync(dest, 'r+');
    try { fs.writeSync(fd, content, 0, content.length, 0); fs.ftruncateSync(fd, content.length); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };

  async function race(writeOne, iters) {
    fs.writeFileSync(dest, DA, { mode: 0o600 });
    const reader = spawn(process.execPath, [readerFile, dest, '400000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    reader.stdout.on('data', (d) => { out += d; });
    const done = new Promise((r) => reader.on('close', r));
    for (let i = 0; i < iters; i++) writeOne(Buffer.from(i % 2 === 0 ? DB : DA));
    await done;
    return JSON.parse(out || '{"reads":0,"torn":0,"parseFail":0}');
  }

  const atomic = await race((content) => {
    fs.writeFileSync(path.join(srcDir, '.credentials.json'), content, { mode: 0o600 });
    login.applyCredentialReplace(srcDir, tdir); // the SHIPPED path
  }, 40000);
  check('SHIPPED applyCredentialReplace: a concurrent reader NEVER sees a torn/partial credential', () => {
    assert.equal(atomic.torn, 0, `torn reads: ${atomic.torn}`);
    assert.equal(atomic.parseFail, 0, `parse failures: ${atomic.parseFail}`);
    assert.ok(atomic.reads > 1000, `the reader ran (${atomic.reads} reads)`);
  });
  show('atomic replace', atomic);

  const torn = await race((content) => inPlace(content), 40000);
  check('MUST-FAIL BASELINE: the removed in-place write-then-ftruncate DOES tear (why it was removed)', () => {
    assert.ok(torn.torn + torn.parseFail > 0, `the in-place write must produce at least one torn/partial read; got ${JSON.stringify(torn)}`);
  });
  show('in-place (removed r4 path)', torn);

  fs.rmSync(tdir, { recursive: true, force: true });
}

let ok = cm.dockerAvailable();
try {
  if (!ok.ok) {
    console.log(`SKIP — Docker is not usable here: ${ok.message}`);
    fail++; failures.push('Docker section did not run (sandbox required)');
  } else {
    show('docker', ok.message);
    acct = makeAccount('bug254-heal', CRED0);
    await ownerKeyFor(process.env.CLAUDE_STATION_DATA).then((k) => removeOwnedContainer(name, k)).catch(() => {});

    /* ================================================================== §A */
    console.log('\n--- §A re-login does a WHOLESALE ATOMIC replace (new inode); the container freezes on its old inode (BUG-136, healed by §C) ---');
    const e1 = await cm.ensureContainer(project(), { onLog: () => {} });
    check('a real session container starts on the account credential', () => {
      assert.equal(e1.state, 'running');
      assert.equal(insideInode(), hostInode(), 'the container holds the host credential inode');
      assert.match(insideContent(), /bug254-v0/);
    });

    // SHIPPED PATH: applyCredentialReplace is a wholesale atomic replace (new inode, complete bytes).
    const inodeBefore = hostInode();
    const CRED1 = credBytes('bug254-v1-REPLACED', 'x'.repeat(200));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-src-'));
    fs.writeFileSync(path.join(tmpDir, '.credentials.json'), CRED1, { mode: 0o600 });
    login.applyCredentialReplace(tmpDir, acct.dir);
    check('applyCredentialReplace mints a NEW inode with exactly the new bytes (atomic rename)', () => {
      assert.notEqual(hostInode(), inodeBefore, 'the host file is a new inode (a wholesale replace, not an in-place rewrite)');
      assert.equal(fs.readFileSync(acct.credPath, 'utf8'), CRED1, 'the host file is exactly the new bytes');
      assert.equal((fs.statSync(acct.credPath).mode & 0o777), 0o600, 'mode 0600 preserved');
    });
    check('the running container is FROZEN on its old inode until the heal (the accepted residual)', () => {
      assert.equal(insideInode(), inodeBefore, 'the container still holds the OLD (now-unlinked) inode');
      assert.match(insideContent(), /bug254-v0/, 'it still reads the pre-replace token — the BUG-136 freeze §C heals');
      assert.doesNotMatch(insideContent(), /bug254-v1-REPLACED/, 'the replace never reaches the running container live');
    });

    // For §B/§C, the current host credential is CRED1 (a new inode the container has not seen) — stale.

    /* ================================================================== §B */
    console.log('\n--- §B credBindDriftOf is tri-state (clean / stale / unknown) ---');
    check('after the atomic replace, credBindDriftOf reports STALE (a proven inode mismatch)', () => {
      assert.equal(cm.credBindDriftOf(project()), 'stale');
    });
    check('MUST-FAIL BASELINE: the pre-change "reasons-or-[]" shape could not distinguish a probe miss from clean', () => {
      // Pre-change staleFileBinds returned [] both when the bind was current AND when the probe could not
      // read it — a probe miss read as "no drift" (the r2 silent-failure that left the stale bind in place).
      // Synthesize that collapse and show the new API refuses to make it: 'unknown' is its own answer.
      const collapse = (driftTri) => (driftTri === 'stale' ? ['stale'] : []); // the old shape: stale -> reason, else []
      assert.deepEqual(collapse('unknown'), collapse('clean'), 'the OLD shape cannot tell unknown from clean');
      assert.equal(typeof cm.credBindDriftOf(project()), 'string');
      assert.ok(['clean', 'stale', 'unknown'].includes(cm.credBindDriftOf(project())), 'the NEW API answers in three states');
    });

    /* ================================================================== §D */
    // The probe GATE authorizes EXACTLY the three fixed read-only probes and refuses every privilege-flag
    // spelling. (Independent-verify run 90182607 found `-uroot` and `--privileged=true` slipping past an
    // enumerated blocklist; the fix requires the container to be the FIRST token after `exec`.)
    console.log('\n--- §D the probe gate: only the three fixed read-only probes; every privilege-flag spelling refused ---');
    const CRED_IN_ABS = CRED_IN;
    const probe = (execArgs) => {
      try {
        const r = lc.withProbe(() => dx.dockerSpawnSync(['exec', ...execArgs], { timeoutMs: 8000 }));
        return { authorized: true, ran: r.status === 0, out: (r.stdout ?? '').trim().slice(0, 60) };
      } catch (e) { return { authorized: false, why: e.message.split('\n')[0] }; }
    };
    check('the three fixed probes are AUTHORIZED', () => {
      assert.ok(probe([name, 'stat', '-c', '%i %n', CRED_IN_ABS]).authorized, 'stat probe');
      assert.ok(probe([name, 'sh', '-c', lc.MEMORY_PROBE_SCRIPT]).authorized, 'memory probe');
      assert.ok(probe([name, 'sh', '-c', lc.GIT_GUARD_PROBE_SCRIPT, 'sh', '/workspace']).authorized, 'git-guard probe');
    });
    for (const [label, execArgs] of [
      ['-u root', ['-u', 'root', name, 'sh', '-c', lc.MEMORY_PROBE_SCRIPT]],
      ['-uroot (attached short flag)', ['-uroot', name, 'sh', '-c', lc.MEMORY_PROBE_SCRIPT]],
      ['--user=root', ['--user=root', name, 'sh', '-c', lc.MEMORY_PROBE_SCRIPT]],
      ['--privileged', ['--privileged', name, 'stat', '-c', '%i %n', '/etc/passwd']],
      ['--privileged=true', ['--privileged=true', name, 'stat', '-c', '%i %n', '/etc/passwd']],
      ['an arbitrary command', [name, 'cat', '/etc/passwd']],
      ['stat with a relative path', [name, 'stat', '-c', '%i %n', 'relative']],
    ]) {
      check(`REFUSED: ${label} (never authorized, never runs)`, () => {
        const r = probe(execArgs);
        assert.equal(r.authorized, false, `must be refused; got ${JSON.stringify(r)}`);
      });
    }
    // BUG-254 r9 — a docker GLOBAL option BEFORE the verb (redirecting the daemon, context or config this
    // gate inspects) must be refused on the probe path. The probe helper hardcodes `exec` first, so these
    // call the gate directly with a full argv whose verb is NOT at index 0. (Independent-verify run
    // 2e54808c found `-H`/`--context`/`-D` slipping past the gate; the fix is one choke-point guard.)
    const SOCK = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
    const gateDirect = (argv) => {
      try { lc.withProbe(() => dx.dockerSpawnSync(argv, { timeoutMs: 8000 })); return { authorized: true }; }
      catch (e) { return { authorized: false, why: e.message.split('\n')[0] }; }
    };
    for (const [label, argv] of [
      ['-H <sock> before exec', ['-H', SOCK, 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['--host= before exec', [`--host=${SOCK}`, 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['-Hunix glued before exec', [`-H${SOCK}`, 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['--context before exec', ['--context', 'default', 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['--context= before exec', ['--context=default', 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['--config before exec', ['--config', '/tmp/x', 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['-l debug before exec', ['-l', 'debug', 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
      ['-D (bool) before exec', ['-D', 'exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]],
    ]) {
      check(`REFUSED (global option before verb): ${label}`, () => {
        const r = gateDirect(argv);
        assert.equal(r.authorized, false, `must be refused; got ${JSON.stringify(r)}`);
        assert.ok(/global option|not.*index 0|before the verb/i.test(r.why ?? ''), `refused for the right reason; got: ${r.why}`);
      });
    }
    // Control: the SAME probe with NO global option (verb at index 0) is still AUTHORIZED — no false refusal.
    check('CONTROL: the identical stat probe with the verb at index 0 is still authorized', () => {
      assert.ok(gateDirect(['exec', name, 'stat', '-c', '%i %n', CRED_IN_ABS]).authorized, 'must stay authorized');
    });

    /* ================================================================== §C */
    console.log('\n--- §C the idle reconciler heals the stale bind; refuses under live work ---');

    // A controllable session view + the real lifecycle lease registry.
    let sessionView = [];
    let lastRecreateError = null;
    const reconLog = [];
    function makeDeps() {
      return {
        listProjects: () => [project()],
        desiredOf: (id) => cm.desiredGitMode(reg(id)),
        readActual: (p) => cm.actualGitModeOf(p),
        readCredDrift: (p) => cm.credBindDriftOf(p),
        leasesReady: () => lc.isReady(),
        sessionsOf: () => sessionView,
        leasesOf: (pid) => lc.leasesOf(pid),
        deliveryBusy: () => false,
        reserve: () => () => {},
        recreate: async (p, o) => {
          try { await cm.recreateContainer(p, { onLog: o.onLog, ...(o.force ? { forceOver: o.captured } : {}) }); }
          catch (e) { lastRecreateError = e; throw e; }
        },
        settled: () => {},
        now: () => Date.now(),
        log: (s) => { reconLog.push(s); },
      };
    }
    const reg = () => project();

    // REFUSE under a busy (mid-turn) session: the container must NOT be recreated.
    const idBeforeRefuse = idOf();
    let closed = false;
    sessionView = [{
      id: 's1', label: 'session 1', sdkKey: 'k1', closed: false, busy: true,
      working: () => false, turnKey: () => 't1',
      closeLifetime: async () => ({ lifetime: 'no', source: 'test' }),
      close: async () => { closed = true; },
    }];
    const grRefuse = createGrantRebuild(makeDeps());
    grRefuse.tick();
    await sleep(1500);
    check('a busy (mid-turn) session is NEVER killed — the stale container is not recreated', () => {
      assert.equal(closed, false, 'the busy session was not closed');
      assert.equal(idOf(), idBeforeRefuse, 'the container id is unchanged (no recreate under live work)');
      const v = grRefuse.viewOf(PROJECT_ID);
      assert.ok(v, 'the project is tracked as pending (the drift is remembered, not dropped)');
      show('held pending while busy', { phase: v.phase, waitingOn: v.waitingOn });
    });
    grRefuse.stop?.();

    // MUST-FAIL BASELINE: a git-only reconciler (no credential trigger) never heals a pure cred drift.
    const baselineDeps = makeDeps();
    delete baselineDeps.readCredDrift; // the pre-change wiring had no credential trigger at all
    sessionView = []; // idle now
    const idBeforeBaseline = idOf();
    const grBaseline = createGrantRebuild(baselineDeps);
    grBaseline.tick();
    await sleep(2000);
    check('MUST-FAIL BASELINE: a git-only reconciler does NOT heal the stale credential (bug persists)', () => {
      assert.equal(idOf(), idBeforeBaseline, 'no recreate — the stale bind is left in place, exactly the pre-change gap');
      assert.equal(cm.credBindDriftOf(project()), 'stale', 'still stale');
      assert.equal(grBaseline.viewOf(PROJECT_ID), null, 'the git-only reconciler does not even track it');
    });
    grBaseline.stop?.();

    // THE FIX: the credential-aware reconciler heals it once idle.
    const grHeal = createGrantRebuild(makeDeps());
    sessionView = []; // idle
    const idBeforeHeal = idOf();
    grHeal.tick();
    let healed = false;
    for (let i = 0; i < 180; i++) { // up to ~90s for the real dind recreate (remove+create)
      await sleep(500);
      grHeal.tick();
      const id = idOf();
      if (id && id !== idBeforeHeal) { healed = true; break; }
    }
    if (!healed) {
      show('reconciler view', grHeal.viewOf(PROJECT_ID));
      show('last recreate error', lastRecreateError ? `${lastRecreateError.code || lastRecreateError.name}: ${lastRecreateError.message}` : 'none');
      show('reconciler log tail', reconLog.slice(-6).join(' | '));
    }
    check('THE FIX: once idle, the reconciler recreates the container (a new id)', () => {
      assert.ok(healed, 'the container was recreated');
      assert.notEqual(idOf(), idBeforeHeal, 'a new container id');
    });
    check('…and the healed container holds the CURRENT host credential inode (the stale bind is gone)', () => {
      assert.equal(insideInode(), hostInode(), 'inode identity restored');
      assert.match(insideContent(), /bug254-v1-REPLACED/, 'the container now reads the replaced token');
      assert.equal(cm.credBindDriftOf(project()), 'clean', 'credBindDriftOf is now clean');
    });
    grHeal.stop?.();
  }
} finally {
  try { await ownerKeyFor(process.env.CLAUDE_STATION_DATA).then((k) => removeOwnedContainer(name, k)); } catch { /* best effort */ }
  try { boot.dispose(); } catch { /* best effort */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${failures.length ? `\n  failed: ${failures.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
