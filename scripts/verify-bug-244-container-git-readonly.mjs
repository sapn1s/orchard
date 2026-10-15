#!/usr/bin/env node
/**
 * BUG-244 — an UNGRANTED container cannot rewrite the real repo; a GRANTED one still can; and the
 * change never recreates, removes or refuses a container that sessions hold.
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-bug-244-container-git-readonly.mjs            # post + must-FAIL runs
 *   node scripts/verify-bug-244-container-git-readonly.mjs --single --tree <dir>   # one tree only
 *
 * The default run executes the scenario suite three times, each against its own tree copy, and
 * checks every expectation both ways:
 *   post    the working tree                         -> every check PASSES
 *   pre     pinned pre-fix container-manager (.pin)  -> P1 kernel checks FAIL (each operation
 *           (scripts/fixtures/bug-244/, == HEAD at     really succeeded and changed the repo),
 *           filing time)                               P2 control still PASSES
 *   mutant  post with the one line that makes a       -> P3 FAILS (a held container's launch is
 *           `gitguard:` reason informational removed     refused, or an idle one is recreated)
 *
 * ISOLATION (FEAT-158): destructive — sandbox daemon only, under its lock (`assertIsolatedDocker`).
 * Base images are confined to per-run scratch repos through a docker shim (the BUG-214 suite's
 * technique). Fixture repos are built and reset by helper containers on the sandbox daemon, in this
 * run's own /tmp dir: an agent session's git shim refuses host scratch git (BUG-240), and the
 * sandbox shares host /tmp at the same paths so the product's binds resolve.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';
import { repoIdentityOf } from './lib/repo-identity.mjs';

assertIsolatedDocker('verify-bug-244-container-git-readonly');

const REPO = path.resolve(import.meta.dirname, '..');
const PRE_FILE = path.join(REPO, 'scripts', 'fixtures', 'bug-244', 'pre-container-manager.ts.pin');
const MUTANT_LINE = "for (let i = reasons.length - 1; i >= 0; i--) if (reasons[i]!.startsWith('gitguard:')) reasons.splice(i, 1);";
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

/* ============================================================ driver === */
if (!argv.includes('--single')) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug244-drv-'));
  const mk = (name, edit) => {
    const t = path.join(TMP, name);
    fs.mkdirSync(path.join(t, 'scripts'), { recursive: true });
    fs.cpSync(path.join(REPO, 'src'), path.join(t, 'src'), { recursive: true });
    fs.cpSync(path.join(REPO, 'scripts', 'lib'), path.join(t, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(t, 'package.json'));
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(t, 'node_modules'));
    if (edit) edit(path.join(t, 'src', 'server', 'container-manager.ts'));
    return t;
  };
  const post = mk('post');
  const pre = mk('pre', (f) => fs.copyFileSync(PRE_FILE, f));
  let mutantOk = false;
  const mutant = mk('mutant', (f) => {
    const s = fs.readFileSync(f, 'utf8');
    mutantOk = s.split(MUTANT_LINE).length === 2;
    fs.writeFileSync(f, s.replace(MUTANT_LINE, '/* BUG-244 mutant: gitguard treated as an ordinary drift reason */'));
  });
  const run = (label, tree) => {
    console.log(`\n=============== ${label} (${tree}) ===============`);
    const r = spawnSync(process.execPath, ['--no-warnings', import.meta.filename, '--single', '--tree', tree, '--pre-tree', pre], { encoding: 'utf8', env: process.env, timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout ?? ''); if (r.status !== 0 && r.stderr) process.stdout.write(`[stderr tail] ${(r.stderr).slice(-1500)}\n`);
    const res = {};
    for (const m of (r.stdout ?? '').matchAll(/^  (PASS|FAIL)  (\S+)/gm)) res[m[2]] = m[1];
    return { code: r.status, res };
  };
  const R = { post: run('POST (working tree)', post), pre: run('PRE (pinned pre-fix)', pre), mutant: run('MUTANT (gitguard not informational)', mutant) };
  let pass = 0, fail = 0;
  const want = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };
  console.log('\n=============== must-FAIL / pass-after matrix ===============');
  const keys = (o, re) => Object.keys(o).filter((k) => re.test(k));
  const postAll = Object.keys(R.post.res);
  want('M0 post run: every check passes', postAll.length > 30 && postAll.every((k) => R.post.res[k] === 'PASS'), `${postAll.filter((k) => R.post.res[k] === 'PASS').length}/${postAll.length} pass, exit ${R.post.code}`);
  const p1pre = keys(R.pre.res, /^P1\./);
  const p1preEff = keys(R.pre.res, /^P1\..*\.effective$/);
  want('M1 pre run: every P1 refusal check FAILS (the attack works on the old code)', p1pre.filter((k) => !/effective$|^P1\.reads/.test(k)).every((k) => R.pre.res[k] === 'FAIL') && p1pre.length > 10, `${p1pre.filter((k) => R.pre.res[k] === 'FAIL').length}/${p1pre.length} P1 checks fail on pre`);
  want('M1b pre run: every attack is shown to really change the repo on the old code (genuine control)', p1preEff.length > 10 && p1preEff.every((k) => R.pre.res[k] === 'PASS'), `${p1preEff.filter((k) => R.pre.res[k] === 'PASS').length}/${p1preEff.length}`);
  const p2 = keys(R.pre.res, /^P2\.granted/);
  want('M2 pre run: the granted control passes on the old code too (a regression control, not a must-FAIL)', p2.length >= 2 && p2.every((k) => R.pre.res[k] === 'PASS'), p2.map((k) => `${k}=${R.pre.res[k]}`).join(' '));
  const p3m = keys(R.mutant.res, /^P3\.(live|start|restart|idle)/);
  want('M3 mutant run: at least one P3 no-recreate/no-refusal check FAILS', p3m.some((k) => R.mutant.res[k] === 'FAIL') && mutantOk, `mutant line found=${mutantOk}; ${p3m.map((k) => `${k}=${R.mutant.res[k]}`).join(' ')}`);
  want('M3b mutant run: P1 still passes (the mutant differs only in drift handling)', keys(R.mutant.res, /^P1\./).every((k) => R.mutant.res[k] === 'PASS'), `${keys(R.mutant.res, /^P1\./).filter((k) => R.mutant.res[k] === 'PASS').length}/${keys(R.mutant.res, /^P1\./).length}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nBUG-244 matrix: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ============================================================ single === */
const TREE = path.resolve(flag('--tree') ?? REPO);
const PRE_TREE = path.resolve(flag('--pre-tree') ?? TREE);
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug244-'));
const DATA = path.join(TMP, 'data');
const FX = path.join(TMP, 'fx');          // live fixture repos (bound into containers)
const PRISTINE = path.join(TMP, 'pristine');
fs.mkdirSync(DATA, { recursive: true });
const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SCRATCH_REPO = `claude-station-b244-${RUN_ID}`;
const SCRATCH_RT = `claude-station-b244rt-${RUN_ID}`;
const SEED_DIR = path.join(TMP, 'seedctx');
fs.mkdirSync(SEED_DIR);
const UIDG = `${process.getuid()}:${process.getgid()}`;

const dk = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const dkTry = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };

function seedId() {
  const out = dk(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']);
  const line = out.split('\n').find((l) => /^claude-station-base:u\d+-g\d+-[0-9a-f]{12} /.test(l)) ?? out.split('\n').find((l) => l.startsWith('claude-station-base:'));
  if (!line) throw new Error('no claude-station-base image in the sandbox to seed from (npm run sandbox:docker -- up preloads one)');
  return line.trim().split(/\s+/)[1];
}
const SEED = seedId();
const SEED_REF = `b244seed-${RUN_ID}:seed`;
dk(['tag', SEED, SEED_REF]);
fs.writeFileSync(path.join(SEED_DIR, 'Dockerfile'), `FROM ${SEED_REF}\n`);

// The BUG-214 suite's docker shim: base/runtime repos renamed to per-run scratch repos both ways,
// and a base `build` becomes a one-line FROM <seed> build that keeps the real argv's labels and tags.
const SHIM = path.join(TMP, 'docker-shim');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const REAL = 'claude-station-base', SCRATCH = ${JSON.stringify(SCRATCH_REPO)};
const REAL_RT = 'claude-station-rt', SCRATCH_RT = ${JSON.stringify(SCRATCH_RT)};
let argv = process.argv.slice(2).map((a) => a.split(REAL).join(SCRATCH).split(REAL_RT + ':').join(SCRATCH_RT + ':').replace(/^claude-station-rt$/, SCRATCH_RT));
if (argv[0] === 'build' && argv.some((a) => a.startsWith(SCRATCH + ':'))) {
  const keep = ['build'];
  for (let i = 1; i < argv.length; i++) if (argv[i] === '--label' || argv[i] === '-t') { keep.push(argv[i], argv[i + 1]); i++; }
  keep.push('--label', 'b244.build-nonce=' + Math.random().toString(36).slice(2));
  keep.push(${JSON.stringify(SEED_DIR)});
  argv = keep;
}
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => s.split(SCRATCH_RT).join(REAL_RT).split(SCRATCH).join(REAL);
child.stdout.on('data', (d) => process.stdout.write(argv[0] === 'cp' ? d : back(String(d))));
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
process.stdout.on('error', () => process.exit(1));
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1)));
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.ORCHARD_ALLOW_GIT_WRITE;

const createdContainers = [];
function cleanup() {
  for (const n of createdContainers) dkTry(['rm', '-f', '-v', n]);
  dkTry(['rmi', SEED_REF]);
  for (const repo of [SCRATCH_REPO, SCRATCH_RT]) {
    for (const ref of dkTry(['images', repo, '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').filter((r) => r && !r.endsWith(':<none>'))) dkTry(['rmi', ref]);
  }
  // Fixture files were written by helper containers as this uid; remove them the same way, then the dir.
  dkTry(['run', '--rm', '--network', 'none', '--user', UIDG, '-v', `${TMP}:${TMP}`, SEED, 'rm', '-rf', FX, PRISTINE, path.join(TMP, 'adv'), path.join(TMP, 'p5'), path.join(TMP, 'p6')]);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Run a shell script in a throwaway helper container that binds this run's TMP (fixture git lives here). */
function helper(script) {
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', UIDG, '-e', 'HOME=/tmp', '-v', `${TMP}:${TMP}`, '-w', TMP, SEED, 'sh', '-ec', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`helper failed (${r.status}): ${(r.stderr || r.stdout).slice(-800)}\n--- script ---\n${script}`);
  return (r.stdout ?? '').trim();
}

/** sha256 over every path, mode, symlink target and file byte below `dir`; 'MISSING' when absent. */
function digest(dir) {
  if (!fs.existsSync(dir)) return 'MISSING';
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n); const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}\0${st.mode}\0`);
      if (st.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (st.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
      h.update('\0');
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------- fixture repos */
// Every repo: main with 2 commits, branch `side`, a staged new file, an untracked file, and an unreachable
// loose blob — so commit / add / reset / update-ref / branch -D / gc --prune each have a real effect.
const REPOS = {
  proj: 'p1/proj',                 // P1 project dir
  sub: 'p1/proj/sub',              // nested one level below the project root
  deep: 'p1/proj/deep/a/b',        // nested three levels below (documented residual)
  other: 'p1/other',               // unregistered repo, rw user mount of P1
  gproj: 'p2/gproj',               // P2 project dir (permanent grant)
  q: 'p2/q',                       // registered project Q (NOT granted), rw user mount of P2
  u: 'p2/u',                       // unregistered repo, rw user mount of P2
  p3: 'p3/proj',                   // P3 project dir
  p4: 'p4/proj',                   // P4 project dir (ungranted), with a BARE origin mounted rw (IV r4)
};
const BARE = 'p4/origin.git';
const mkRepo = (rel) => `mkdir -p ${rel} && cd ${rel} && git init -q -b main . && G='git -c user.name=t -c user.email=t@t' &&
  echo one > f && $G add f && $G commit -qm c1 && echo two > f && $G commit -qam c2 && $G branch side &&
  echo staged > s && $G add s && echo untracked > new.txt && echo dangling-${rel.replace(/\//g, '-')} | $G hash-object -w --stdin >/dev/null && cd - >/dev/null`;
const ALL = Object.values(REPOS);
// Parents first so a nested repo is created inside its parent's work tree (as untracked content).
helper(['cd ' + FX.replace(/\/fx$/, ''), `mkdir -p ${FX} && cd ${FX}`, ...ALL.slice().sort((a, b) => a.length - b.length).map(mkRepo), `git clone -q --bare ${FX}/${REPOS.p4} ${FX}/${BARE}`, `cp -a ${FX} ${PRISTINE}`].join(' && '));
/** Reset every fixture repo to pristine IN PLACE (each .git dir keeps its inode, so a container's overlay stays the live dir). */
function restore() {
  helper([
    ...ALL.map((r) => `mkdir -p ${FX}/${r}/.git && find ${FX}/${r}/.git -mindepth 1 -delete`),
    `mkdir -p ${FX}/${BARE} && find ${FX}/${BARE} -mindepth 1 -delete`,
    `tar -C ${PRISTINE} -cf - . | tar -C ${FX} -xf -`,
  ].join(' && '));
}
const gitDir = (k) => path.join(FX, REPOS[k], '.git');
/** FEAT-164 grant binding: a REAL standing grant records the repo identity it is given for (setGitWritePolicy
 * stores `repo` inside the seal; the container plan opens only that repository). Fixtures grant the same way. */
const granted = (dir, extra = {}) => ({ permanent: true, ...extra, repo: repoIdentityOf(dir) });

const DEV_PIN = { pinned: 'dev', skipped: [], deferred: null };
const baseProject = (id, hostPath, extra = {}) => ({
  id, name: `BUG-244 ${id}`, hostPath, isolation: 'container', createdAt: new Date().toISOString(),
  settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [], container: { gpu: 'off', base: DEV_PIN }, ...extra },
});
const P1 = baseProject(`b244p1-${RUN_ID}`, path.join(FX, REPOS.proj), {
  mounts: [
    { hostPath: path.join(FX, REPOS.other), containerPath: '/workspace/other', readOnly: false },
    { hostPath: path.join(FX, 'p1'), containerPath: '/workspace/parent', readOnly: false },
  ],
});
const Q = baseProject(`b244q-${RUN_ID}`, path.join(FX, REPOS.q));
const P2 = baseProject(`b244p2-${RUN_ID}`, path.join(FX, REPOS.gproj), {
  gitWrite: granted(path.join(FX, REPOS.gproj), { grantedAt: new Date().toISOString(), grantedVia: 'test' }),
  mounts: [
    { hostPath: path.join(FX, REPOS.q), containerPath: '/workspace/q', readOnly: false },
    { hostPath: path.join(FX, REPOS.u), containerPath: '/workspace/u', readOnly: false },
  ],
});
const P3 = baseProject(`b244p3-${RUN_ID}`, path.join(FX, REPOS.p3));
const P4 = baseProject(`b244p4-${RUN_ID}`, path.join(FX, REPOS.p4), {
  mounts: [{ hostPath: path.join(FX, BARE), containerPath: '/workspace/origin.git', readOnly: false }],
});
// Q is a REGISTERED project (no grant): P2's grant must not unlock Q's repo.
fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q] }, null, 2));

const { bootAuthority, runAsServerProcess } = await import('./lib/lifecycle-harness.mjs');
const baseOf = (m, proj) => (typeof m.baseRefFor === 'function' ? m.baseRefFor(proj) : m.imageNameFor(proj));
const scratchRef = (ref) => ref.replace('claude-station-base', SCRATCH_REPO).replace(/^claude-station-rt:/, `${SCRATCH_RT}:`);
// ONE base for every project in the run (they share the dev pin), owned by this instance so a Rebuild may act on it.
let minted = false;
async function mintImage(ref) {
  if (minted) return;
  minted = true;
  // The instance identity is created when a server first claims the data dir; until then ownerKey() is a path key.
  const r = await runAsServerProcess(PRE_TREE, `const io = await import(V.f); return { key: io.ownerKey() };`, { f: path.join(PRE_TREE, 'src/server/instance-owner.ts') });
  if (!r?.key) throw new Error(`could not read this instance's owner key: ${JSON.stringify(r)}`);
  const ownerKey = () => r.key;
  const c = dk(['create', SEED, 'true']);
  try { dk(['commit', '--change', `LABEL claude-station.owner=${ownerKey()}`, '--change', `LABEL b244.nonce=${crypto.randomUUID()}`, c, ref]); } finally { dkTry(['rm', '-f', c]); }
}
const cid = (name) => dkTry(['inspect', name, '--format', '{{.Id}}']).out || null;
const running = (name) => dkTry(['inspect', name, '--format', '{{.State.Running}}']).out === 'true';
const binds = (name) => { try { return JSON.parse(dkTry(['inspect', name, '--format', '{{json .HostConfig.Binds}}']).out) ?? []; } catch { return []; } };
const ex = (name, script, wd) => {
  const r = spawnSync('docker', ['exec', ...(wd ? ['-w', wd] : []), name, 'sh', '-c', script], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? '' };
};

console.log(`BUG-244 container .git read-only\n  tree under test: ${TREE}\n  pre tree (P3 step 1): ${PRE_TREE}\n`);
let exitCode = 0;
let H = null;
try {
  /* ------------------------------------------------ P3 step 1 (old code) */
  // A container created by the PRE-FIX code with a session live in it (a tagged process), before this
  // server boots: exactly the state of a real project when the change is deployed under a live session.
  const cmPre = await import(path.join(PRE_TREE, 'src/server/container-manager.ts') + `?v=${crypto.randomUUID()}`);
  // The host runtime's boot check (`claude --version`, async with a timeout) starts at import. Let it finish
  // BEFORE the blocking spawnSync steps below, or its timer fires while the event loop is blocked and the
  // check reads as failed (an artifact of this suite, not of the product).
  const settleRuntime = async (tree) => (await import(path.join(tree, 'src/server/runtime/runtime-update.ts'))).whenRuntimeChecked();
  await settleRuntime(PRE_TREE);
  const name3 = cmPre.containerName(P3.id);
  createdContainers.push(name3, `${name3}.next`, `${name3}-next`);
  await mintImage(scratchRef(baseOf(cmPre, P3)));
  const t3live = `b244live-${RUN_ID}`;
  const made = await runAsServerProcess(PRE_TREE, `const st = await cm.admitContainer(V.p, V.t, {}); return { state: st.state };`, { p: P3, t: t3live });
  const id30 = cid(name3);
  dk(['exec', '-d', '-e', `CLAUDE_STATION_EXEC=${t3live}`, name3, 'sh', '-c', 'echo $$ > /tmp/b244-live.pid; exec sleep 1800']);
  for (let i = 0; i < 20 && ex(name3, 'test -s /tmp/b244-live.pid').code !== 0; i++) await new Promise((r) => setTimeout(r, 200));
  const preHasGuard = binds(name3).some((b) => b.endsWith('/.git:ro'));

  /* ------------------------------------------------ boot the server under test */
  H = await bootAuthority(TREE);
  const lanesMod = H.lc ? await import(path.join(TREE, 'src/server/lanes.ts')) : null;
  const cm = PRE_TREE === TREE ? cmPre : await import(path.join(TREE, 'src/server/container-manager.ts') + `?v=${crypto.randomUUID()}`);
  await settleRuntime(TREE);
  const NEW = typeof cm.gitGuardOn === 'function';
  let seq = 0; const tag = (w) => `${w}-${RUN_ID}-${++seq}`;
  const admit = async (p, t) => { const st = await cm.admitContainer(p, t, { onLog: () => {} }); H.lc?.attachLease(t, `sess-${t}`); return st; };
  const close = async (p, t) => { if (!H.lc) return; H.lc.drainLease(t); for (let i = 0; i < 80 && H.lc.leasesOf(p.id).some((l) => l.id === t); i++) await new Promise((r) => setTimeout(r, 250)); };

  /* ======================================================= P1 ===== */
  console.log('--- P1: an ungranted container cannot rewrite the real repo (kernel-enforced)');
  const name1 = cm.containerName(P1.id);
  createdContainers.push(name1, `${name1}.next`, `${name1}-next`);
  await mintImage(scratchRef(baseOf(cm, P1)));
  const t1 = tag('p1');
  await admit(P1, t1);
  const wd1 = cm.containerWorkdir(P1);
  const b1 = binds(name1);
  check('P1.created the ungranted container runs, with a read-only overlay over its own .git', running(name1) && b1.includes(`${fs.realpathSync(gitDir('proj'))}:${wd1}/.git:ro`), JSON.stringify(b1.filter((b) => /\.git/.test(b))));
  const G = "git -c user.name=t -c user.email=t@t";
  // [label, target repo key, cwd in the container, command]
  const OPS = [
    ['add', 'proj', wd1, `${G} add new.txt`],
    ['commit', 'proj', wd1, `${G} commit -qm agent`],
    ['reset-hard', 'proj', wd1, `${G} reset -q --hard HEAD~1`],
    ['update-ref', 'proj', wd1, `${G} update-ref refs/heads/main HEAD~1`],
    ['branch-D', 'proj', wd1, `${G} branch -D side`],
    ['gc-prune', 'proj', wd1, `${G} reflog expire --expire=now --all && ${G} gc -q --prune=now`],
    ['tag-via-sh-script', 'proj', wd1, `printf '%s\\n' "${G} tag v9" > /tmp/s.sh && sh /tmp/s.sh`],
    ['commit-via-python', 'proj', wd1, `python3 -c "import subprocess,sys; sys.exit(subprocess.call(['git','-c','user.name=t','-c','user.email=t@t','commit','--allow-empty','-qm','py']))"`],
    ['raw-ref-write', 'proj', wd1, `echo 0000000000000000000000000000000000000000 > .git/refs/heads/main`],
    ['rm-rf-dotgit', 'proj', wd1, `rm -rf .git`],
    ['nested-commit', 'sub', `${wd1}/sub`, `${G} commit -qm agent`],
    ['nested-rm-rf-dotgit', 'sub', `${wd1}/sub`, `rm -rf .git`],
    ['user-mount-commit', 'other', '/workspace/other', `${G} commit -qm agent`],
    ['user-mount-update-ref', 'other', '/workspace/other', `${G} update-ref refs/heads/main HEAD~1`],
    ['alias-commit', 'proj', '/workspace/parent/proj', `${G} commit -qm agent`],
    ['alias-reset-hard', 'proj', '/workspace/parent/proj', `${G} reset -q --hard HEAD~1`],
    ['alias-rm-rf-dotgit', 'other', '/workspace/parent/other', `rm -rf .git`],
  ];
  for (const [label, key, wd, cmd] of OPS) {
    restore();
    const before = digest(gitDir(key));
    const r = ex(name1, cmd, wd);
    const after = digest(gitDir(key));
    // `.effective` is the control: on the pre-fix code the attack must really succeed AND change the repo.
    check(`P1.${label}.effective`, r.code === 0 ? after !== before : true, `exit ${r.code}, repo ${before} -> ${after}`);
    check(`P1.${label}`, r.code !== 0 && after === before, `exit ${r.code} (${r.out.slice(0, 110)}), repo ${before} -> ${after}`);
  }
  restore();
  {
    const st = ex(name1, `git status --porcelain >/dev/null && git log --oneline -1 >/dev/null && git diff --cached --stat >/dev/null && echo READS-OK`, wd1);
    check('P1.reads git status/log/diff still work under the overlay (no false lockout)', st.code === 0 && /READS-OK/.test(st.out), `exit ${st.code} ${st.out}`);
  }
  {
    const deep = cm.desiredBinds(P1).some((b) => b.containerPath.endsWith('/deep/a/b/.git'));
    // FEAT-164 (verify 1659cb7f): the guard's discovery is a capped walk (depth 8), so the old depth-1 residual is
    // retired: a repo three levels below a bind root now gets its read-only overlay too.
    check('R1 a repo three levels below a bind root gets a read-only overlay (capped walk; the depth-1 residual is retired)', deep, `deep overlay=${deep}`);
    const cr = ex(name1, 'test ! -e "$HOME/.ssh" && test -z "$SSH_AUTH_SOCK" && test ! -e "$HOME/.git-credentials" && test ! -e "$HOME/.config/gh" && echo NO-CREDS');
    check('R2 push residual: the container is given no host git credentials (no ~/.ssh, agent socket, credential store, gh config)', /NO-CREDS/.test(cr.out), cr.out);
  }

  {
    // BUG-244 IV r4 (run 9914222c): a bare repo that is itself the ROOT of a rw bind (a local origin).
    const name4 = cm.containerName(P4.id);
    createdContainers.push(name4, `${name4}.next`, `${name4}-next`);
    await admit(P4, tag('p4'));
    const wd4 = cm.containerWorkdir(P4);
    for (const [label, cmd] of [
      ['bare-origin-force-push', `${G} push -q -f /workspace/origin.git HEAD~1:main`],
      ['bare-origin-update-ref-delete', `git --git-dir=/workspace/origin.git update-ref -d refs/heads/main`],
      ['bare-origin-rm-rf', `rm -rf /workspace/origin.git/refs /workspace/origin.git/objects`],
    ]) {
      restore();
      const before = digest(path.join(FX, BARE));
      const r = ex(name4, cmd, wd4);
      const after = digest(path.join(FX, BARE));
      check(`P1.${label}.effective`, r.code === 0 ? after !== before : true, `exit ${r.code}, repo ${before} -> ${after}`);
      check(`P1.${label}`, r.code !== 0 && after === before, `exit ${r.code} (${r.out.slice(0, 110)}), repo ${before} -> ${after}`);
    }
    if (NEW) {
      // BUG-244 IV r6 (run 33d49218): a grant flip on a project whose rw mount ROOT is a bare repo is a
      // gitguard-only (informational) change: not refused under a live lease, not recreated at an idle Start.
      const id4 = cid(name4);
      const P4g = { ...P4, settings: { ...P4.settings, gitWrite: granted(P4.hostPath) } };
      cm.invalidate(P4.id);
      const r4g = cm.statusOf(P4g).driftReasons ?? [];
      const a4g = await admit(P4g, tag('p4g')).then(() => null, (e) => e);
      check('P3.bare-root-grant-flip-live a grant flip on a bare-root mount is reported only as gitguard:, and a live launch is not refused', r4g.length > 0 && r4g.every((r) => r.startsWith('gitguard:')) && !a4g && cid(name4) === id4,
        `reasons=${JSON.stringify(r4g)} err=${a4g && a4g.code} id -> ${cid(name4)?.slice(0, 12)}`);
      for (const l of H.lc ? H.lc.leasesOf(P4.id) : []) await close(P4, l.id);
      const s4g = await cm.ensureContainer(P4g, { onLog: () => {} }).then(() => null, (e) => e);
      check('P3.bare-root-grant-flip-idle the same flip with nobody live: a manual Start keeps the container', !s4g && cid(name4) === id4, `err=${s4g && s4g.code} id -> ${cid(name4)?.slice(0, 12)}`);
      const P4m = { ...P4, settings: { ...P4.settings, mounts: [{ hostPath: path.join(FX, REPOS.p4), containerPath: '/workspace/origin.git', readOnly: false }] } };
      cm.invalidate(P4.id);
      const r4m = cm.statusOf(P4m).driftReasons ?? [];
      check('U.bare-root-repoint re-pointing the bare-root mount is a REAL bind change (not hidden as gitguard:)', r4m.some((r) => /^(missing|unexpected) bind/.test(r)), JSON.stringify(r4m));
      const pb2 = baseProject(`b244pb-${RUN_ID}`, path.join(FX, BARE));
      const db = cm.desiredBinds(pb2);
      check('U.bare-project-dir a project whose directory IS a bare repo gets its project bind read-only, and no rw bind at that path remains',
        db.some((b) => b.containerPath === cm.containerWorkdir(pb2) && b.readOnly && b.why === cm.GIT_GUARD_WHY) && !db.some((b) => b.containerPath === cm.containerWorkdir(pb2) && !b.readOnly),
        JSON.stringify(db.filter((b) => b.containerPath === cm.containerWorkdir(pb2))));
    }
  }

  {
    // BUG-244 IV r5 (run 16d31ab3): a guarded .git whose objects/ and refs/ are SYMLINKS into the rw project tree.
    const P5dir = path.join(TMP, 'p5', 'proj');
    helper([`mkdir -p ${P5dir}`, `cd ${P5dir} && git init -q -b main . && echo a > f && git add f && git -c user.name=t -c user.email=t@t commit -qm c1`,
      `mv .git/objects .store-objects && ln -s ../.store-objects .git/objects && mv .git/refs .store-refs && ln -s ../.store-refs .git/refs`].join(' && '));
    const P5 = baseProject(`b244p5-${RUN_ID}`, P5dir);
    const name5 = cm.containerName(P5.id);
    createdContainers.push(name5, `${name5}.next`, `${name5}-next`);
    await admit(P5, tag('p5'));
    const store = () => `${digest(path.join(P5dir, '.store-objects'))}/${digest(path.join(P5dir, '.store-refs'))}`;
    for (const [label, cmd] of [
      ['symlinked-store-truncate-ref', `: > .git/refs/heads/main`],
      ['symlinked-store-rm-objects', `rm -rf .git/objects/*`],
    ]) {
      const before = store();
      const r = ex(name5, cmd, cm.containerWorkdir(P5));
      const after = store();
      check(`P1.${label}.effective`, r.code === 0 ? after !== before : true, `exit ${r.code}, store ${before} -> ${after}`);
      check(`P1.${label}`, r.code !== 0 && after === before, `exit ${r.code} (${r.out.slice(0, 110)}), store ${before} -> ${after}`);
      if (r.code === 0) break; // the store is damaged now (pre-fix code): the next case would measure nothing
    }
  }

  /* ======================================================= P2 ===== */
  console.log('--- P2: a granted container still can; P2\'s grant never unlocks registered project Q');
  const name2 = cm.containerName(P2.id);
  createdContainers.push(name2, `${name2}.next`, `${name2}-next`);
  await mintImage(scratchRef(baseOf(cm, P2)));
  const t2 = tag('p2');
  await admit(P2, t2);
  const wd2 = cm.containerWorkdir(P2);
  for (const [label, key, wd, cmd] of [
    ['granted.commit', 'gproj', wd2, `${G} commit -qm agent`],
    ['granted.update-ref', 'gproj', wd2, `${G} update-ref refs/heads/side HEAD~1`],
  ]) {
    restore();
    const before = digest(gitDir(key));
    const r = ex(name2, cmd, wd);
    check(`P2.${label}`, r.code === 0 && digest(gitDir(key)) !== before, `exit ${r.code} ${r.out.slice(0, 100)}`);
  }
  // FEAT-164 single authority (verify 1659cb7f): P2's grant covers ONLY the repository it was given for. An
  // UNREGISTERED repo P2 mounts rw (u) is another repository, so it is read-only too. On the pre-fix code the
  // grant unlocked it: a must-FAIL there (M1), with its effectiveness twin (M1b).
  {
    restore();
    const before = digest(gitDir('u'));
    const r = ex(name2, `${G} commit -qm agent`, '/workspace/u');
    const after = digest(gitDir('u'));
    check('P1.granted-unregistered-mount-commit.effective', r.code === 0 ? after !== before : true, `exit ${r.code}, repo ${before} -> ${after}`);
    check('P1.granted-unregistered-mount-commit', r.code !== 0 && after === before, `exit ${r.code} (${r.out.slice(0, 110)})`);
  }
  for (const [label, cmd] of [['commit', `${G} commit -qm agent`], ['update-ref', `${G} update-ref refs/heads/main HEAD~1`]]) {
    restore();
    const before = digest(gitDir('q'));
    const r = ex(name2, cmd, '/workspace/q');
    const after = digest(gitDir('q'));
    check(`P1.cross-project-Q-${label}.effective`, r.code === 0 ? after !== before : true, `exit ${r.code}, repo ${before} -> ${after}`);
    check(`P1.cross-project-Q-${label}`, r.code !== 0 && after === before, `exit ${r.code} (${r.out.slice(0, 110)})`);
  }
  check('P2.bindlist a granted project with no foreign repo mounts has a bind list without any overlay (unchanged)', NEW
    ? cm.desiredBinds({ ...P2, settings: { ...P2.settings, mounts: [] } }).every((b) => !b.containerPath.endsWith('/.git'))
    : true, 'desiredBinds(P2 without mounts)');

  /* ======================================================= U ===== */
  console.log('--- U: churn — a container just created reports no drift, repeatedly');
  for (const [nm, p] of [[name1, P1], [name2, P2], [cm.containerName(P4.id), P4]]) {
    const rs = [0, 1, 2].map(() => { cm.invalidate(p.id); return cm.statusOf(p).driftReasons ?? []; });
    check(`U.no-churn ${p.id.split('-')[0]}: three status reads right after create report zero drift`, rs.every((r) => r.length === 0), JSON.stringify(rs));
  }
  {
    const lnk = path.join(TMP, 'p1-link');
    fs.symlinkSync(path.join(FX, REPOS.proj), lnk);
    const a = cm.desiredBinds(P1).filter((b) => b.containerPath.endsWith('.git')).map((b) => `${b.hostPath}:${b.containerPath}`).sort();
    const b = cm.desiredBinds({ ...P1, hostPath: `${lnk}/` }).filter((x) => x.containerPath.endsWith('.git')).map((x) => `${x.hostPath}:${x.containerPath}`).sort();
    check('U.symlink a symlinked project path with a trailing slash yields the identical overlays (realpaths)', a.length > 0 && JSON.stringify(a) === JSON.stringify(b), `${a.length} vs ${b.length}`);
  }
  {
    const nonGit = path.join(TMP, 'nongit'); fs.mkdirSync(nonGit);
    const pn = baseProject(`b244n-${RUN_ID}`, nonGit);
    const cmP = cmPre;
    const same = JSON.stringify(cm.desiredBinds(pn)) === JSON.stringify(cmP.desiredBinds(pn));
    check('U.non-git a non-git project\'s bind list is byte-identical to the pre-fix code (no drift for it)', same, `identical=${same}`);
    const pg = { ...P3, settings: { ...P3.settings, gitWrite: granted(P3.hostPath) } };
    const sameG = JSON.stringify(cm.desiredBinds(pg)) === JSON.stringify(cmP.desiredBinds(pg));
    check('U.granted a granted project\'s bind list is byte-identical to the pre-fix code (granted keeps today\'s behaviour)', sameG, `identical=${sameG}`);
  }

  if (NEW) {
    // BUG-244 IV r1 (run 6846e653): two layouts the first suite missed.
    //  (a) a nested repo whose dir name is a build/dependency name (dist/, build/, target/, venv/)
    //  (b) a REGISTERED, ungranted project Q that is a submodule checkout inside GRANTED project G
    //      (Q/.git is a gitfile into G/.git/modules/q): G's grant must not unlock Q's git dir.
    const A = path.join(TMP, 'adv');
    helper([`mkdir -p ${A}/p ${A}/g`, `cd ${A}/p && git init -q -b main .`,
      ...['dist', 'build', 'target', 'venv'].map((d) => `git init -q -b main ${A}/p/${d}`),
      `cd ${A}/g && git init -q -b main .`, `mkdir -p ${A}/g/.git/modules`, `git init -q -b main --separate-git-dir=${A}/g/.git/modules/q ${A}/g/q`].join(' && '));
    const pa = baseProject(`b244a-${RUN_ID}`, path.join(A, 'p'));
    const got = cm.desiredBinds(pa).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath);
    const wdA = cm.containerWorkdir(pa);
    for (const d of ['dist', 'build', 'target', 'venv']) check(`U.nested-name-${d} a repo at <project>/${d} gets a read-only overlay`, got.includes(`${wdA}/${d}/.git`), JSON.stringify(got));
    const Qs = baseProject(`b244qs-${RUN_ID}`, path.join(A, 'g', 'q'));
    fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q, Qs] }, null, 2));
    const pg = baseProject(`b244g-${RUN_ID}`, path.join(A, 'g'), { gitWrite: granted(path.join(A, 'g')) });
    const gg = cm.desiredBinds(pg).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => `${b.hostPath} -> ${b.containerPath}`);
    const qReal = fs.realpathSync(path.join(A, 'g', '.git', 'modules', 'q'));
    check('U.submodule-project registered ungranted submodule project Q inside granted G: Q\'s git dir (G/.git/modules/q) is overlaid read-only, G\'s own .git is not', gg.some((s) => s.startsWith(`${qReal} -> `)) && !gg.some((s) => s.startsWith(`${fs.realpathSync(path.join(A, 'g', '.git'))} -> `)), JSON.stringify(gg));
    // BUG-244 IV r2 (run e1a5f657): (c) registered ungranted Q is a LINKED WORKTREE of a repo granted G mounts rw;
    // (d) registered ungranted Q is a SUBFOLDER of a monorepo granted G mounts rw; (e) a BARE repo one level below.
    helper([`mkdir -p ${A}/g2/main ${A}/g2/mono/svc ${A}/p2`,
      `cd ${A}/g2/main && git init -q -b main . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m c1 && git worktree add -q ${A}/q-wt -b qwt`,
      `cd ${A}/g2/mono && git init -q -b main .`,
      `cd ${A}/p2 && git init -q -b main . && git init -q --bare ${A}/p2/origin.git`].join(' && '));
    const Qwt = baseProject(`b244qwt-${RUN_ID}`, path.join(A, 'q-wt'));
    const Qmono = baseProject(`b244qmono-${RUN_ID}`, path.join(A, 'g2', 'mono', 'svc'));
    fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q, Qwt, Qmono] }, null, 2));
    const pg2 = baseProject(`b244g2-${RUN_ID}`, path.join(A, 'g2'), { gitWrite: granted(path.join(A, 'g2')) });
    const g2 = cm.desiredBinds(pg2).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.hostPath);
    check('U.worktree-project registered ungranted worktree project Q: the shared git dir it uses (main/.git) is read-only in granted G', g2.includes(fs.realpathSync(path.join(A, 'g2', 'main', '.git'))), JSON.stringify(g2));
    check('U.monorepo-project registered ungranted project Q in a monorepo subfolder: the monorepo .git is read-only in granted G', g2.includes(fs.realpathSync(path.join(A, 'g2', 'mono', '.git'))), JSON.stringify(g2));
    const pb = baseProject(`b244b-${RUN_ID}`, path.join(A, 'p2'));
    const gb = cm.desiredBinds(pb).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath);
    check('U.bare-repo a bare repo one level below an ungranted project gets a read-only overlay', gb.includes(`${cm.containerWorkdir(pb)}/origin.git`), JSON.stringify(gb));
    // BUG-244 IV r3 (run e4c8001a): a nested repo dir with ':' in its name must not break the bind list.
    helper(`git init -q -b main '${A}/p2/snap:2024'`);
    const gc = cm.desiredBinds(pb);
    check('U.colon-path a nested repo whose name contains ":" yields no unwritable -v spec (skipped, recorded residual); the rest stay', !gc.some((b) => /[:,]/.test(b.hostPath) || /[:,]/.test(b.containerPath)) && gc.some((b) => b.containerPath.endsWith('/origin.git')), JSON.stringify(gc.filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath)));
    // BUG-244 IV r7 (run 9ff97062): a repo ONE LEVEL BELOW a registered ungranted project's folder (q3/dist), and
    // below a registered non-git umbrella folder (umb/api), must stay read-only in a granted G that mounts them.
    helper([`mkdir -p ${A}/g3 ${A}/q3 ${A}/umb`, `cd ${A}/g3 && git init -q -b main .`, `cd ${A}/q3 && git init -q -b main . && git init -q -b main dist`, `git init -q -b main ${A}/umb/api`].join(' && '));
    const Q3 = baseProject(`b244q3-${RUN_ID}`, path.join(A, 'q3'));
    const Qu = baseProject(`b244qu-${RUN_ID}`, path.join(A, 'umb'));
    fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q, Q3, Qu] }, null, 2));
    const pg3 = baseProject(`b244g3-${RUN_ID}`, path.join(A, 'g3'), {
      gitWrite: granted(path.join(A, 'g3')),
      mounts: [{ hostPath: path.join(A, 'q3'), containerPath: '/workspace/q3', readOnly: false }, { hostPath: path.join(A, 'umb'), containerPath: '/workspace/umb', readOnly: false }],
    });
    const g3 = cm.desiredBinds(pg3).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath);
    check('U.below-registered a repo one level below an ungranted registered project (q3/dist) and below a non-git registered umbrella (umb/api) stay read-only in granted G',
      g3.includes('/workspace/q3/dist/.git') && g3.includes('/workspace/umb/api/.git') && g3.includes('/workspace/q3/.git') && !g3.includes(`${cm.containerWorkdir(pg3)}/.git`), JSON.stringify(g3));
    // BUG-244 IV r8 (run on candidate bc9632f0): a GRANTED project nested one level below an ungranted registered
    // folder (non-git umbrella umb2/api, or repo site/dist) keeps its own repo writable (direct user outranks).
    helper([`mkdir -p ${A}/umb2 ${A}/site`, `git init -q -b main ${A}/umb2/api`, `cd ${A}/site && git init -q -b main . && git init -q -b main dist`].join(' && '));
    fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q, baseProject(`b244u2-${RUN_ID}`, path.join(A, 'umb2')), baseProject(`b244st-${RUN_ID}`, path.join(A, 'site'))] }, null, 2));
    for (const [nm, dir] of [['umbrella', path.join(A, 'umb2', 'api')], ['repo', path.join(A, 'site', 'dist')]]) {
      const pgN = baseProject(`b244gn${nm}-${RUN_ID}`, dir, { gitWrite: granted(dir) });
      const gN = cm.desiredBinds(pgN).filter((b) => b.why === cm.GIT_GUARD_WHY);
      check(`U.granted-nested-under-${nm} a granted project one level below an ungranted registered ${nm} keeps its own .git writable (no overlay)`, gN.length === 0, JSON.stringify(gN.map((b) => b.containerPath)));
    }
    // BUG-244 IV r9 (run 5c26f90e): a rw user mount at <workdir>/data SHADOWS the project's data/ repo; no overlay
    // may be emitted inside that mount (Docker would create a root-owned .git in the mounted host dir).
    helper([`mkdir -p ${A}/p9 ${A}/hostdata`, `cd ${A}/p9 && git init -q -b main . && git init -q -b main data`].join(' && '));
    const p9 = baseProject(`b244p9-${RUN_ID}`, path.join(A, 'p9'));
    const wd9 = cm.containerWorkdir(p9);
    p9.settings.mounts = [{ hostPath: path.join(A, 'hostdata'), containerPath: `${wd9}/data`, readOnly: false }];
    const g9 = cm.desiredBinds(p9).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath);
    check('U.shadowed-by-user-mount no overlay is emitted inside a deeper user mount that shadows a nested repo; the project .git is still overlaid',
      !g9.some((c) => c.startsWith(`${wd9}/data/`)) && g9.includes(`${wd9}/.git`), JSON.stringify(g9));
    // IV r10 (run eecfb1d3): the same mount spelled with a trailing slash, a double slash or a /./ segment.
    for (const sp of [`${wd9}/data/`, `${wd9}//data`, `${wd9}/./data`]) {
      p9.settings.mounts = [{ hostPath: path.join(A, 'hostdata'), containerPath: sp, readOnly: false }];
      const gs = cm.desiredBinds(p9).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.containerPath);
      check(`U.shadowed-spelling ${JSON.stringify(sp.slice(wd9.length))}: no overlay inside the shadowing user mount`, !gs.some((c) => c.startsWith(`${wd9}/data/`)), JSON.stringify(gs));
    }
    const pg2u = { ...pg2, id: `b244g2u-${RUN_ID}` };
    fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [Q] }, null, 2));
    // FEAT-164 single authority (verify 1659cb7f): with no registered user of them, the repos nested under granted G
    // are STILL other repositories, so they are read-only; only G's own repository stays writable.
    const gu = cm.desiredBinds(pg2u).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.hostPath);
    let g2own = null; try { g2own = fs.realpathSync(path.join(A, 'g2', '.git')); } catch { /* g2 is not itself a repo */ }
    check('U.granted-unregistered unregistered repos nested under granted G are read-only too (the grant covers only G\'s repository)',
      gu.includes(fs.realpathSync(path.join(A, 'g2', 'main', '.git'))) && gu.includes(fs.realpathSync(path.join(A, 'g2', 'mono', '.git'))) && (g2own === null || !gu.includes(g2own)), JSON.stringify(gu));
  }

  /* ======================================================= P3 ===== */
  console.log('--- P3: the change never recreates, removes or refuses a container sessions hold');
  check('P3.setup a container made by the pre-fix code is running with a live (tagged) session and no overlay', made?.state === 'running' && !!id30 && running(name3) && !preHasGuard, `made=${JSON.stringify(made)} id=${id30?.slice(0, 12)} guard=${preHasGuard}`);
  const leased = H.lc ? H.lc.leasesOf(P3.id).map((l) => l.id) : [];
  check('P3.setup boot recovery found the live session as a lease', leased.includes(t3live), JSON.stringify(leased));
  cm.invalidate(P3.id);
  const r30 = cm.statusOf(P3).driftReasons ?? [];
  check('P3.reported status reports the pending overlay as a gitguard: reason, and nothing else', r30.length > 0 && r30.every((r) => r.startsWith('gitguard:')), JSON.stringify(r30));
  const t31 = tag('p3a');
  const a31 = await admit(P3, t31).then(() => null, (e) => e);
  check('P3.live-admit a second launch while the session is live: not refused, same container, running', !a31 && cid(name3) === id30 && running(name3), `err=${a31 && `${a31.code} ${a31.message.slice(0, 120)}`} id ${id30?.slice(0, 12)} -> ${cid(name3)?.slice(0, 12)}`);
  const s32 = await cm.ensureContainer(P3, { onLog: () => {} }).then(() => null, (e) => e);
  check('P3.start-live a manual Start while the session is live: not refused, same container', !s32 && cid(name3) === id30 && running(name3), `err=${s32 && `${s32.code} ${s32.message.slice(0, 120)}`} id -> ${cid(name3)?.slice(0, 12)}`);
  // A RESTARTED server (fresh process, boot recovery) admitting a session in the held project.
  if (lanesMod) lanesMod.releaseWriter();
  const rr = await runAsServerProcess(TREE, `try { await cm.admitContainer(V.p, V.t, {}); return { ok: true }; } catch (e) { return { ok: false, err: String(e.code) + ' ' + String(e.message).slice(0, 160) }; }`, { p: P3, t: tag('p3r') });
  if (lanesMod) { const c = await lanesMod.claimDataDir({ port: null, waitMs: 10_000 }); if (!c.ok) throw new Error(`could not re-claim the data dir: ${c.reason}`); }
  check('P3.restart-admit a restarted server admitting a session while the old one is live: not refused, same container', rr?.ok === true && cid(name3) === id30 && running(name3), `${JSON.stringify(rr)} id -> ${cid(name3)?.slice(0, 12)}`);
  // Every session gone: the next launch is still NOT a natural creation, so the container stays as it is.
  ex(name3, 'kill $(cat /tmp/b244-live.pid) 2>/dev/null; true');
  for (const t of [t3live, t31]) await close(P3, t);
  for (let i = 0; i < 80 && H.lc && H.lc.hasLeases(P3.id); i++) await new Promise((r) => setTimeout(r, 250));
  const idleLeases = H.lc ? H.lc.leasesOf(P3.id).map((l) => l.id) : [];
  const t33 = tag('p3idle');
  const a33 = await admit(P3, t33).then(() => null, (e) => e);
  check('P3.idle-admit with no session live, a launch still keeps the container (the overlay waits for a natural create or Rebuild)', !a33 && cid(name3) === id30 && running(name3), `leases before=${JSON.stringify(idleLeases)} err=${a33 && `${a33.code} ${a33.message.slice(0, 100)}`} id -> ${cid(name3)?.slice(0, 12)}`);
  await close(P3, t33);
  // Explicit user action: Rebuild with nobody live applies it.
  const rb = await cm.rebuildContainer(P3, { onLog: () => {} }).then(() => null, (e) => e);
  const id34 = cid(name3);
  const wd3 = cm.containerWorkdir(P3);
  restore();
  const before3 = digest(gitDir('p3'));
  const c34 = ex(name3, `${G} commit -qm agent`, wd3);
  check('P3.rebuild an explicit Rebuild with nobody live recreates it WITH the overlay, and a commit is then refused', !rb && !!id34 && id34 !== id30 && binds(name3).some((b) => b.endsWith(`${wd3}/.git:ro`)) && c34.code !== 0 && digest(gitDir('p3')) === before3,
    `err=${rb && `${rb.code} ${rb.message.slice(0, 100)}`} id ${id30?.slice(0, 12)} -> ${id34?.slice(0, 12)} commit exit ${c34.code}`);
  // A grant given while a session is live: kept; it rides the next natural recreate (a memory change, idle).
  const t35 = tag('p3g');
  await admit(P3, t35);
  const P3g = { ...P3, settings: { ...P3.settings, gitWrite: granted(P3.hostPath) } };
  cm.invalidate(P3.id);
  const r35 = cm.statusOf(P3g).driftReasons ?? [];
  const a35 = await admit(P3g, tag('p3g2')).then(() => null, (e) => e);
  check('P3.live-grant a grant flipped while a session is live: reported as gitguard:, launch not refused, container kept', NEW && r35.some((r) => r.startsWith('gitguard:')) && !a35 && cid(name3) === id34,
    `reasons=${JSON.stringify(r35)} err=${a35 && a35.code} id -> ${cid(name3)?.slice(0, 12)}`);
  for (const l of H.lc ? H.lc.leasesOf(P3.id) : []) await close(P3, l.id);
  const P3m = { ...P3g, settings: { ...P3g.settings, container: { ...P3g.settings.container, memoryMb: 4096 } } };
  const a36 = await admit(P3m, tag('p3m')).then(() => null, (e) => e);
  const id36 = cid(name3);
  check('P3.mixed idle + another real reason (memory): recreated, and the granted overlay removal rides along', !a36 && id36 !== id34 && !binds(name3).some((b) => b.endsWith('/.git:ro')),
    `err=${a36 && a36.code} id ${id34?.slice(0, 12)} -> ${id36?.slice(0, 12)} binds=${JSON.stringify(binds(name3).filter((b) => /\.git/.test(b)))}`);
  /* BUG-244 IV r11 (run d40eea90): the host re-clones a guarded nested repo while the container RUNS. */
  if (NEW) {
    const name1 = cm.containerName(P1.id);
    const wd1 = cm.containerWorkdir(P1);
    const tl = tag('p1lapse');
    await admit(P1, tl);
    const idL = cid(name1);
    helper(`rm -rf ${FX}/${REPOS.sub} && cp -a ${PRISTINE}/${REPOS.sub} ${FX}/${REPOS.sub}`);
    const subGit = path.join(FX, REPOS.sub, '.git');
    const b0 = digest(subGit);
    const probe = ex(name1, `${G} commit -qm lapse`, `${wd1}/sub`);
    const lapsedWritable = probe.code === 0 && digest(subGit) !== b0;
    cm.invalidate(P1.id);
    const rl = cm.statusOf(P1).driftReasons ?? [];
    check('P1.lapse-detected after a host-side re-clone of a guarded nested repo, status reports gitguard-lapsed (the lapse is real: the probe commit landed)',
      rl.some((r) => r.startsWith('gitguard-lapsed:')), `probe writable=${lapsedWritable} -w=${ex(name1, `[ -w ${wd1}/sub/.git ] && echo W || echo RO`).out} reasons=${JSON.stringify(rl).slice(0, 300)}`);
    const aL = await admit(P1, tag('p1lapse2')).then(() => null, (e) => e);
    check('P3.lapse-live with a session live, the lapse neither removes the container nor refuses the launch', !aL && cid(name1) === idL && running(name1), `err=${aL && aL.code} id -> ${cid(name1)?.slice(0, 12)}`);
    for (const l of H.lc ? H.lc.leasesOf(P1.id) : []) await close(P1, l.id);
    const aR = await admit(P1, tag('p1repair')).then(() => null, (e) => e);
    const b1 = digest(subGit);
    const c1 = ex(name1, `${G} commit -qm after-repair`, `${wd1}/sub`);
    check('P1.lapse-repaired with nobody live, the next launch recreates it and the re-cloned repo is read-only again',
      !aR && cid(name1) !== idL && c1.code !== 0 && digest(subGit) === b1, `err=${aR && aR.code} id ${idL?.slice(0, 12)} -> ${cid(name1)?.slice(0, 12)} commit exit ${c1.code}`);
  }

  /* BUG-244 IV r12: the same, through the FEAT-157 RECOVERY branch (unusable base pin keeps the container as it is). */
  if (NEW) {
    const P6dir = path.join(TMP, 'p6', 'proj');
    helper([`mkdir -p ${P6dir}`, `cd ${P6dir} && git init -q -b main . && git init -q -b main sub`].join(' && '));
    const P6 = baseProject(`b244p6-${RUN_ID}`, P6dir);
    const name6 = cm.containerName(P6.id);
    createdContainers.push(name6, `${name6}.next`, `${name6}-next`);
    const t6 = tag('p6');
    await admit(P6, t6);
    await close(P6, t6);
    dkTry(['stop', '-t', '2', name6]);
    const id6 = cid(name6);
    helper(`rm -rf ${P6dir}/sub/.git`);
    const P6r = { ...P6, settings: { ...P6.settings, container: { ...P6.settings.container, base: { pinned: 'v999-no-such-release', skipped: [], deferred: null } } } };
    const plan = cm.imagePlanOf(P6r);
    const s6 = await cm.ensureContainer(P6r, { onLog: () => {} }).then(() => null, (e) => e);
    let own6 = 'absent';
    try { own6 = String(fs.statSync(path.join(P6dir, 'sub', '.git')).uid); } catch { /* absent is right */ }
    check('P3.recovery-missing-source the recovery branch (unusable base pin) recreates a stopped container whose overlay source is gone instead of starting it; no root-owned dir',
      plan.target?.kind === 'recovery' && !s6 && cid(name6) !== id6 && running(name6) && own6 === 'absent',
      `target=${plan.target?.kind} err=${s6 && `${s6.code} ${s6.message.slice(0, 100)}`} id ${id6?.slice(0, 12)} -> ${cid(name6)?.slice(0, 12)} sub/.git uid=${own6}`);
  }

  /* BUG-244 IV r3 (run e4c8001a), BUG-136 class: an overlaid nested repo deleted while its container is STOPPED. */
  if (NEW) {
    const name1 = cm.containerName(P1.id);
    dkTry(['stop', '-t', '2', name1]);
    // A stopped container's sessions are gone; their leases drain (with one still held the authority refuses the
    // remove, and the launch is refused instead: also safe, the container is never started into the phantom dir).
    for (const l of H.lc ? H.lc.leasesOf(P1.id) : []) await close(P1, l.id);
    const idS = cid(name1);
    helper(`rm -rf ${FX}/${REPOS.sub}/.git`);
    const preAdmit = fs.existsSync(path.join(FX, REPOS.sub, '.git'));
    cm.invalidate(P1.id);
    const rS = cm.statusOf(P1).driftReasons ?? [];
    const aS = await admit(P1, tag('p1s')).then(() => null, (e) => e);
    const bS = binds(name1).filter((b) => /sub/.test(b));
    const sg = path.join(FX, REPOS.sub, '.git');
    let owner = 'absent';
    try { owner = String(fs.statSync(sg).uid); } catch { /* absent is the right answer */ }
    check('P3.stopped-missing-source a stopped container whose overlay source was deleted is recreated, not started; Docker creates no root-owned dir in the user tree',
      !aS && running(name1) && cid(name1) !== idS && owner === 'absent', `err=${aS && `${aS.code} ${aS.message.slice(0, 100)}`} id ${idS?.slice(0, 12)} -> ${cid(name1)?.slice(0, 12)} sub/.git uid=${owner} preAdmitExists=${preAdmit} reasons=${JSON.stringify(rS).slice(0, 400)} newSubBinds=${JSON.stringify(bS)}`);
  }
} catch (e) {
  console.log(`  FAIL  suite-error\n        observed: ${String(e?.stack ?? e).slice(0, 1500)}`);
  fail++;
} finally {
  try { H?.dispose(); } catch { /* best effort */ }
  cleanup();
}
console.log(`\nBUG-244 (${TREE}): ${pass} passed, ${fail} failed`);
process.exit(fail || exitCode ? 1 : 0);
