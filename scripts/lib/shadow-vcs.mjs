/**
 * shadow-vcs.mjs — FEAT-170 shadow-repo pilot. Per-ticket lane repos for agents, an
 * explicit LANDING step into the shared working tree that refuses overlaps, and the
 * bridge to FEAT-170 candidates for promotion. Plan + review dispositions: FEAT-170
 * "Shadow-repo pilot" and "Plan review 1".
 *
 * Layout (under the shadow root; the git shim allows git writes only in repos that
 * RESOLVE inside it — shadow-guard.mjs):
 *   <root>/<slug>/lanes/<T>/          the lane's own git repo + work tree (fresh base)
 *   <root>/<slug>/lanes/<T>.json      lane meta: seed, base, pendingBase, landings
 *   <root>/<slug>/landings/<T>.jsonl  journal per landing: typed pre/post per path
 *   <root>/<slug>/objects/<sha256>    content-addressed pre/post bytes (undo source)
 *   <root>/<slug>/metrics.jsonl       pilot metrics
 *
 * Every git call goes through `git` on PATH — in an agent session that is the shim —
 * so this module has NO authority of its own: lane writes pass because the shim
 * resolved them into the root; real-repo calls are reads. The shared tree is written
 * only by land / unland / recover, by plain file operations, after the checks.
 *
 * Entries are TYPED everywhere: {exists, kind: file|link|other, mode, bytes}.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultShadowRoot } from './shadow-guard.mjs';
import * as CS from './candidate-store.mjs';

export class ShadowError extends Error {
  constructor(code, message, detail = [], exit = 1) { super(message); this.code = code; this.detail = detail; this.exit = exit; }
}
const fail = (code, msg, detail = [], exit = 1) => { throw new ShadowError(code, msg, detail, exit); };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const TICKET_RE = CS.TICKET_RE;
const newId = () => randomBytes(6).toString('hex');

/* ───────────────────────────────────────────── eligibility + locations */

function registryFile(env) {
  if (env.ORCHARD_SHADOW_REGISTRY) return env.ORCHARD_SHADOW_REGISTRY;
  const d = env.CLAUDE_STATION_DATA?.trim() ? path.resolve(env.CLAUDE_STATION_DATA)
    : path.join(env.XDG_DATA_HOME?.trim() ? path.resolve(env.XDG_DATA_HOME) : path.join(os.homedir(), '.local', 'share'), 'claude-station');
  return path.join(d, 'registry.json');
}

/** The registered project that contains `top` (longest hostPath prefix), or null. */
export function registeredProject(top, env = process.env) {
  let reg;
  try { reg = JSON.parse(fs.readFileSync(registryFile(env), 'utf8')); } catch { return null; }
  const ps = Array.isArray(reg?.projects) ? reg.projects : Object.values(reg?.projects ?? {});
  let best = null;
  for (const p of ps) {
    if (!p?.hostPath) continue;
    let hp; try { hp = fs.realpathSync(p.hostPath); } catch { continue; }
    if ((top === hp || top.startsWith(hp + path.sep)) && (!best || hp.length > best.hp.length)) best = { hp, p };
  }
  return best?.p ?? null;
}

/** Why the pilot is unavailable here (a REFUSAL of the pilot — not a claim of protection). */
export function environmentRefusal(env = process.env) {
  if (process.platform === 'win32') return 'native Windows is not supported (Orchard runs on Linux or WSL2) — the pilot is refused; keep today\'s flow';
  const inContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  if (inContainer && env.ORCHARD_SHADOW_TEST_IN_CONTAINER !== '1') {
    return 'refused inside a container: the shadow root is a host directory that is not mounted here, and container git is not shimmed (no protection is claimed for containers) — keep today\'s flow';
  }
  return null;
}

export function shadowRootFor(env = process.env) {
  return env.ORCHARD_SHADOW_ROOT && path.isAbsolute(env.ORCHARD_SHADOW_ROOT) ? env.ORCHARD_SHADOW_ROOT : defaultShadowRoot(env);
}

/** Filesystem capability of the shared tree: /mnt/c-style mounts carry no trustworthy mode bits and fold case. */
export function fsCaps(top) {
  let best = { mp: '', type: '' };
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [, mp0, type] = line.split(' ');
      if (!mp0) continue;
      const mp = mp0.replace(/\\040/g, ' ');
      if ((top === mp || top.startsWith(mp.endsWith('/') ? mp : mp + '/')) && mp.length > best.mp.length) best = { mp, type };
    }
  } catch { /* no /proc: assume a normal Linux FS */ }
  const foreign = ['9p', 'drvfs', 'v9fs', 'fuseblk', 'vfat', 'exfat', 'ntfs', 'ntfs3'].includes(best.type);
  return { fsType: best.type || 'unknown', modes: !foreign, caseInsensitive: foreign };
}

function git(cwd, args, { env = null, input = null, buffer = false, allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: buffer ? 'buffer' : 'utf8', env: env ? { ...process.env, ...env } : process.env,
    input: input ?? undefined, maxBuffer: 1024 * 1024 * 1024,
  });
  if ((r.status ?? 1) !== 0 && !allowFail) {
    fail('git-failed', `git ${args[0]} failed in ${cwd}: ${String(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
  return r;
}
const gitOut = (cwd, args, o) => String(git(cwd, args, o).stdout).trim();

/** Facts about the shared (real) repo — reads only — and this project's shadow locations. */
export function projectOf(repo, env = process.env) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if ((r.status ?? 1) !== 0) fail('not-a-repo', `${repo} is not a git repository — the pilot needs git to list the shared tree (refused; keep today's flow)`);
  let top = fs.realpathSync(r.stdout.trim());
  const root = shadowRootFor(env);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Called from INSIDE a lane (cwd = <root>/<slug>/lanes/<T>): the project is the lane's.
  const rootReal = fs.realpathSync(root);
  if (top.startsWith(rootReal + path.sep)) {
    const m = /^([^/]+)\/lanes\/([^/]+)$/.exec(path.relative(rootReal, top).split(path.sep).join('/'));
    let laneTop = null;
    if (m) { try { laneTop = JSON.parse(fs.readFileSync(path.join(rootReal, m[1], 'lanes', `${m[2]}.json`), 'utf8')).top; } catch { /* not a lane */ } }
    if (!laneTop) fail('not-a-project', `${top} is inside the shadow root but is not a lane — pass --repo <project>`);
    top = fs.realpathSync(laneTop);
  }
  const hasHead = (spawnSync('git', ['-C', top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'], { encoding: 'utf8' }).status ?? 1) === 0;
  const slug = `${path.basename(top).replace(/[^A-Za-z0-9._-]/g, '_')}-${sha256(Buffer.from(top)).slice(0, 12)}`;
  const base = path.join(rootReal, slug);
  for (const d of ['lanes', 'landings', 'objects', 'tmp']) fs.mkdirSync(path.join(base, d), { recursive: true, mode: 0o700 });
  return {
    top, hasHead, root, slug, base, caps: fsCaps(top),
    laneDir: (T) => path.join(base, 'lanes', T),
    metaFile: (T) => path.join(base, 'lanes', `${T}.json`),
    landingsFile: (T) => path.join(base, 'landings', `${T}.jsonl`),
    metricsFile: path.join(base, 'metrics.jsonl'),
    lockFile: path.join(base, 'land.lock'),
  };
}

const checkId = (T) => { if (!TICKET_RE.test(String(T))) fail('bad-id', `${T} is not a ticket id`); };
/**
 * Verify 0b8d47da: with no HEAD there is no line provenance (every base line is
 * "uncommitted"), so REVERTS-FOREIGN cannot tell another lane's landed line from the
 * lane's own; a land there could silently drop it. The pilot needs a base commit.
 */
const requireHead = (P) => { if (!P.hasHead) fail('no-base-commit', `${P.top} has no commit yet — the pilot needs a base commit (to tell uncommitted work from committed lines, and to promote); refused, keep today's flow`); };

function readMeta(P, T) {
  try { return JSON.parse(fs.readFileSync(P.metaFile(T), 'utf8')); } catch { fail('no-lane', `${T} has no shadow lane in this project (node scripts/shadow.mjs lane-new ${T})`); }
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function appendJsonl(file, obj) { fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); }
function metric(P, ev) { try { appendJsonl(P.metricsFile, { at: new Date().toISOString(), ...ev }); } catch { /* a metric must never break the verb */ } }
function putObj(P, bytes) {
  const h = sha256(bytes); const f = path.join(P.base, 'objects', h);
  if (!fs.existsSync(f)) { const t = `${f}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`; fs.writeFileSync(t, bytes, { mode: 0o444 }); fs.renameSync(t, f); }
  return h;
}
function getObj(P, h) {
  const b = fs.readFileSync(path.join(P.base, 'objects', h));
  if (sha256(b) !== h) fail('object-corrupt', `stored object ${h.slice(0, 12)} does not match its hash`);
  return b;
}

/* ───────────────────────────────────────────── typed entries */

/** {exists:false} | {exists, kind:'file'|'link'|'other', mode, bytes} for an absolute path. */
function readAbs(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return { exists: false }; }
  if (st.isSymbolicLink()) return { exists: true, kind: 'link', mode: '120000', bytes: Buffer.from(fs.readlinkSync(abs)) };
  if (!st.isFile()) return { exists: true, kind: 'other', mode: null, bytes: Buffer.alloc(0) };
  return { exists: true, kind: 'file', mode: (st.mode & 0o111) ? '100755' : '100644', perm: st.mode & 0o7777, bytes: fs.readFileSync(abs) };
}
export const readLive = (top, rel) => readAbs(path.join(top, ...rel.split('/')));
const kindOfMode = (m) => (m === '120000' ? 'link' : m === '160000' ? 'gitlink' : 'file');
/** Equal as typed entries. `modes:false` ignores the exec bit (a /mnt/c-style FS has none). */
export function sameEntry(a, b, { modes = true } = {}) {
  if (!a?.exists && !b?.exists) return true;
  if (!a?.exists || !b?.exists) return false;
  if (a.kind !== b.kind || Buffer.compare(a.bytes, b.bytes) !== 0) return false;
  return !modes || a.kind !== 'file' || a.mode === b.mode;
}
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const recOf = (P, e) => (e.exists ? { sha: putObj(P, e.bytes), kind: e.kind, mode: e.mode, ...(e.perm != null ? { perm: e.perm } : {}) } : null);
const entryOf = (P, r) => (r ? { exists: true, kind: r.kind, mode: r.mode, ...(r.perm != null ? { perm: r.perm } : {}), bytes: getObj(P, r.sha) } : { exists: false });
/** Permission bits for a written file: the replaced file's own bits, exec bits set per the git mode. */
function permFor(entry, prev) {
  let p = entry.perm ?? (prev?.exists && prev.kind === 'file' ? prev.perm : null);
  if (p == null) p = 0o666 & ~process.umask();
  if (entry.mode === '100755' && !(p & 0o111)) p |= (p & 0o444) >> 2;
  if (entry.mode === '100644') p &= ~0o111;
  return p;
}

/* ───────────────────────────────────────────── line provenance checks */

const linesOf = (b) => b.toString('utf8').split('\n');
function bag(lines) { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) || 0) + 1); return m; }
/** Lines of a minus lines of b, as a multiset. */
function minus(a, b) { const B = bag(b); const out = []; for (const l of a) { const n = B.get(l) || 0; if (n > 0) B.set(l, n - 1); else out.push(l); } return out; }

/**
 * Merge-preservation check: every line either side ADDED since the base is in the
 * result (a line both sides added identically is needed once — git merges it once).
 */
function mergeDropped(b, l, t, result) {
  const R = bag(linesOf(result));
  const A = bag(minus(linesOf(l), linesOf(b)));
  const B = bag(minus(linesOf(t), linesOf(b)));
  const dropped = [];
  for (const x of new Set([...A.keys(), ...B.keys()])) {
    const need = Math.max(A.get(x) || 0, B.get(x) || 0);
    if ((R.get(x) || 0) < need) dropped.push(x);
  }
  return dropped;
}

/* ───────────────────────────────────────────── snapshot of the shared tree */

function snapshotOnce(P, laneDir) {
  const list = String(git(P.top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { buffer: true }).stdout).split('\0').filter(Boolean);
  const files = []; const links = []; let bytes = 0; const skipped = [];
  for (const rel of [...new Set(list)]) {
    if (rel.includes('\n')) { skipped.push(`${rel} (newline in name)`); continue; }
    const abs = path.join(P.top, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; } // tracked but deleted in the shared tree
    if (st.isSymbolicLink()) links.push({ rel, target: fs.readlinkSync(abs) });
    else if (st.isFile()) { files.push({ rel, abs, mode: P.caps.modes && (st.mode & 0o111) ? '100755' : '100644' }); bytes += st.size; }
    else skipped.push(`${rel} (${st.isDirectory() ? 'directory / submodule' : 'special file'})`);
  }
  const shas = files.length ? gitOut(laneDir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: files.map((f) => f.abs).join('\n') + '\n' }).split('\n') : [];
  if (shas.length !== files.length) fail('snapshot-failed', `hash-object returned ${shas.length} ids for ${files.length} files`);
  const recs = files.map((f, i) => `${f.mode} ${shas[i]}\t${f.rel}`);
  for (const l of links) recs.push(`120000 ${gitOut(laneDir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: l.target })}\t${l.rel}`);
  const idx = path.join(P.base, 'tmp', `index-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    if (recs.length) git(laneDir, ['update-index', '-z', '--index-info'], { env: { GIT_INDEX_FILE: idx }, input: recs.map((r) => `${r}\0`).join('') });
    const tree = gitOut(laneDir, ['write-tree'], { env: { GIT_INDEX_FILE: idx } });
    return { tree, files: files.length + links.length, bytes, skipped };
  } finally { fs.rmSync(idx, { force: true }); }
}
/** Snapshot until two consecutive passes agree (no mixed generation of a file being written). */
function snapshotShared(P, laneDir) {
  let prev = snapshotOnce(P, laneDir);
  for (let i = 0; i < 4; i++) {
    const cur = snapshotOnce(P, laneDir);
    if (cur.tree === prev.tree) return cur;
    prev = cur;
  }
  fail('unstable', 'the shared tree kept changing while it was being snapshotted — try again in a moment');
}

/* ───────────────────────────────────────────── lane-new */

export function laneNew({ repo, id, deps = [], env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  requireHead(P);
  const proj = registeredProject(P.top, env);
  if (proj?.isolation === 'container') fail('container-project', `${proj.id ?? P.top} is a container project — the pilot is refused there (its sessions run unshimmed container git and cannot see the host shadow root); keep today's flow`);
  const laneDir = P.laneDir(id);
  if (fs.existsSync(laneDir) || fs.existsSync(P.metaFile(id))) fail('lane-exists', `${id} already has a shadow lane at ${laneDir} (sync it, or drop it first)`);
  const t0 = Date.now();
  fs.mkdirSync(laneDir, { recursive: true, mode: 0o700 });
  try {
    git(laneDir, ['init', '-q']);
    for (const [k, v] of [['user.name', `orchard lane ${id}`], ['user.email', `${id.toLowerCase()}@lane.orchard.invalid`],
      ['core.autocrlf', 'false'], ['core.symlinks', 'true'], ['core.fileMode', P.caps.modes ? 'true' : 'false'], ['commit.gpgsign', 'false'], ['gc.auto', '0']]) git(laneDir, ['config', k, v]);
    // Raw bytes in, raw bytes out: no eol/filter conversion inside the lane.
    fs.mkdirSync(path.join(laneDir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(laneDir, '.git', 'info', 'attributes'), '* -text -filter -ident\n');
    const snap = snapshotShared(P, laneDir);
    const seed = gitOut(laneDir, ['commit-tree', snap.tree, '-m', `seed: shared tree of ${path.basename(P.top)} at ${new Date().toISOString()}`]);
    git(laneDir, ['update-ref', 'refs/heads/lane', seed]);
    git(laneDir, ['symbolic-ref', 'HEAD', 'refs/heads/lane']);
    git(laneDir, ['reset', '-q', '--hard', 'refs/heads/lane']);
    git(laneDir, ['update-ref', 'refs/orchard/base', seed]);
    const seedMs = Date.now() - t0;
    let depsMs = 0;
    for (const d of deps) {
      const rel = CS.repoRel(P.top, d);
      const src = path.join(P.top, rel);
      if (!fs.existsSync(src)) continue;
      const t1 = Date.now();
      const r = spawnSync('cp', ['-a', '--reflink=auto', src, path.join(laneDir, rel)], { encoding: 'utf8' });
      if ((r.status ?? 1) !== 0) fail('deps-failed', `copying ${rel} into the lane failed: ${r.stderr}`);
      depsMs += Date.now() - t1;
    }
    const meta = { ticket: id, top: P.top, laneDir, seed, base: seed, pendingBase: null, landings: [], createdAt: new Date().toISOString(), fs: P.caps };
    writeJsonAtomic(P.metaFile(id), meta);
    metric(P, { ev: 'lane-new', ticket: id, ms: Date.now() - t0, seedMs, depsMs, files: snap.files, bytes: snap.bytes, deps, fsType: P.caps.fsType });
    return { laneDir, seed, files: snap.files, bytes: snap.bytes, skipped: snap.skipped, ms: Date.now() - t0, depsMs, caps: P.caps };
  } catch (e) {
    fs.rmSync(laneDir, { recursive: true, force: true });
    throw e;
  }
}

/* ───────────────────────────────────────────── lane state */

function laneState(laneDir) {
  const st = String(git(laneDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { buffer: true }).stdout);
  const merging = fs.existsSync(path.join(laneDir, '.git', 'MERGE_HEAD'));
  const tip = gitOut(laneDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return { dirty: st.length > 0, merging, tip };
}
const isAncestor = (laneDir, a, b) => (git(laneDir, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status ?? 1) === 0;

export function laneStatus({ repo, id, env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  const meta = readMeta(P, id);
  const s = laneState(meta.laneDir);
  const ahead = gitOut(meta.laneDir, ['rev-list', '--count', `${meta.base}..${s.tip}`]);
  return { ...meta, ...s, commitsSinceBase: Number(ahead), standingLandings: landingsOf(P, id).filter((r) => r.state === 'done').length };
}

/* ───────────────────────────────────────────── sync */

export function sync({ repo, id, env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  const meta = readMeta(P, id);
  const s = laneState(meta.laneDir);
  if (s.dirty || s.merging) fail('lane-dirty', `${id}'s lane has uncommitted changes or an unfinished merge — commit (or finish the merge) before sync`);
  const t0 = Date.now();
  const snap = snapshotShared(P, meta.laneDir);
  const S = gitOut(meta.laneDir, ['commit-tree', snap.tree, '-p', meta.base, '-m', `shared tree snapshot at ${new Date().toISOString()}`]);
  git(meta.laneDir, ['update-ref', 'refs/orchard/shared', S]);
  const m = git(meta.laneDir, ['merge', '--no-ff', '--no-edit', '-m', 'sync: merge the current shared tree', S], { allowFail: true });
  const conflict = (m.status ?? 1) !== 0;
  meta.pendingBase = S;
  writeJsonAtomic(P.metaFile(id), meta);
  metric(P, { ev: 'sync', ticket: id, conflict, ms: Date.now() - t0 });
  return { snapshot: S, conflict, output: `${m.stdout || ''}${m.stderr || ''}`.trim() };
}

/* ───────────────────────────────────────────── the project land lock + journal guard */

function withLandLock(P, fn) {
  const tryTake = () => { try { fs.writeFileSync(P.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); return true; } catch { return false; } };
  let ok = tryTake();
  if (!ok) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(P.lockFile, 'utf8')); } catch { /* unreadable */ }
    let alive = false;
    if (holder?.pid) { try { process.kill(holder.pid, 0); alive = true; } catch (e) { alive = e?.code === 'EPERM'; } }
    if (!alive) { fs.rmSync(P.lockFile, { force: true }); ok = tryTake(); }
  }
  if (!ok) fail('busy', 'another landing in this project is running — try again when it has finished', [], 4);
  try { return fn(); } finally { fs.rmSync(P.lockFile, { force: true }); }
}

/** All tickets with a journal in this project. */
function journalTickets(P) {
  try { return fs.readdirSync(path.join(P.base, 'landings')).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)).filter((t) => TICKET_RE.test(t)); } catch { return []; }
}
function pendingJournals(P) {
  const out = [];
  for (const T of journalTickets(P)) for (const r of landingsOf(P, T)) if (r.state === 'pending') out.push({ ticket: T, rec: r });
  return out;
}
function refuseIfPending(P) {
  const p = pendingJournals(P);
  if (p.length) fail('interrupted', `a previous landing was interrupted (${p.map((x) => `${x.ticket} #${x.rec.n}`).join(', ')}) — nothing else lands until it is recovered`, [`Run: node scripts/shadow.mjs recover --repo ${P.top}`], 4);
}

/* ───────────────────────────────────────────── install protocol */

/** Every existing ancestor of rel must be a real directory (no symlink, no file). */
function ancestorProblem(top, rel) {
  const parts = rel.split('/');
  let cur = top;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; } // absent from here down: mkdir creates real dirs
    if (st.isSymbolicLink()) return `${parts.slice(0, i + 1).join('/')} is a symlink — a landing never writes through one`;
    if (!st.isDirectory()) return `${parts.slice(0, i + 1).join('/')} is a file, not a directory`;
  }
  return null;
}

function stage(dir, base, entry, prev) {
  const tmp = path.join(dir, `.${base}.orchard-new-${process.pid}-${randomBytes(4).toString('hex')}`);
  if (entry.kind === 'link') fs.symlinkSync(entry.bytes.toString(), tmp);
  else { fs.writeFileSync(tmp, entry.bytes, { flag: 'wx' }); fs.chmodSync(tmp, permFor(entry, prev)); }
  return tmp;
}

/** Create `abs` from `tmp` only if `abs` does not exist (link = atomic create-if-absent). */
function installNoClobber(tmp, abs) {
  try { fs.linkSync(tmp, abs); fs.rmSync(tmp, { force: true }); return; } catch (e) {
    if (e?.code === 'EEXIST') { fs.rmSync(tmp, { force: true }); throw new ShadowError('race', 'a file appeared at the path during the swap'); }
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(e?.code)) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  // No hard links on this filesystem: rename, after a last absence check (stated residual window).
  if (fs.existsSync(abs) || (() => { try { fs.lstatSync(abs); return true; } catch { return false; } })()) { fs.rmSync(tmp, { force: true }); throw new ShadowError('race', 'a file appeared at the path during the swap'); }
  fs.renameSync(tmp, abs);
}

/**
 * Replace the entry at rel, which must currently be `expectPre`, by `post` — never
 * overwriting anything else (plan review 1 #6). Returns the aside path (pre bytes) or
 * null. Throws ShadowError('race') with nothing changed when the live entry is not
 * the expected one.
 */
function swap(top, rel, expectPre, post, tag, { modes }) {
  const abs = path.join(top, ...rel.split('/'));
  const dir = path.dirname(abs); const base = path.basename(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = post.exists ? stage(dir, base, post, expectPre) : null;
  let aside = null;
  try {
    if (expectPre.exists) {
      aside = path.join(dir, `.${base}.orchard-aside-${tag}`);
      try { fs.renameSync(abs, aside); } catch (e) { if (e?.code === 'ENOENT') throw new ShadowError('race', 'the file vanished during the swap'); throw e; }
      if (!sameEntry(readAbs(aside), expectPre, { modes })) {
        // Someone changed it after the plan was made: put it back untouched.
        try { installNoClobber(aside, abs); } catch {
          const keep = path.join(dir, `.${base}.orchard-conflict-${tag}`);
          fs.renameSync(aside, keep);
          throw new ShadowError('race', `the file changed during the swap; a newer file now sits at the path, and the changed copy was kept at ${keep}`);
        }
        aside = null;
        throw new ShadowError('race', 'the file changed between the plan and the swap');
      }
    } else {
      let present = true; try { fs.lstatSync(abs); } catch { present = false; }
      if (present) throw new ShadowError('race', 'a file appeared at the path after the plan was made');
    }
    if (tmp) installNoClobber(tmp, abs);
    return aside;
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { force: true });
    if (aside && fs.existsSync(aside)) { try { installNoClobber(aside, abs); } catch { /* keep the aside file; reported by recover */ } }
    throw e;
  }
}

/**
 * TEST SEAMS (the persistent suite drives the crash and race paths deterministically).
 * They can only make this tool fail or write a file the caller names — nothing an
 * agent cannot already do — so they carry no authority.
 *   ORCHARD_SHADOW_TEST_CRASH_AFTER=N          exit(9) after N files were swapped
 *   ORCHARD_SHADOW_TEST_PRESWAP_WRITE=rel=TXT  before the first swap, write TXT to rel (a concurrent writer)
 */
function testSeams(doneCount, top) {
  const crash = process.env.ORCHARD_SHADOW_TEST_CRASH_AFTER;
  if (crash !== undefined && doneCount === Number(crash)) process.exit(9);
  const w = process.env.ORCHARD_SHADOW_TEST_PRESWAP_WRITE;
  if (w && doneCount === 0) { const i = w.indexOf('='); fs.writeFileSync(path.join(top, w.slice(0, i)), w.slice(i + 1)); }
}

/**
 * Apply a list of {path, pre, post} atomically-or-not-at-all: each path is swapped
 * in; on any failure the already-swapped ones are swapped back — only if they still
 * hold what we wrote (never clobbering a later writer).
 */
function applyAll(P, items, tag) {
  const modes = P.caps.modes;
  const done = [];
  try {
    for (const it of items) {
      testSeams(done.length, P.top);
      const aside = swap(P.top, it.path, it.pre, it.post, `${tag}-${done.length}`, { modes }); done.push({ it, aside });
    }
  } catch (e) {
    const stuck = [];
    for (const { it, aside } of done.reverse()) {
      // Put the pre entry back only if the path still holds what we installed.
      try {
        const a2 = swap(P.top, it.path, it.post, it.pre, `${tag}-rb`, { modes });
        if (a2) fs.rmSync(a2, { force: true });
        if (aside) fs.rmSync(aside, { force: true });
      } catch { stuck.push(it.path); }
    }
    throw new ShadowError(e.code === 'race' ? 'race' : 'write-failed', `${e.code === 'race' ? 'the shared tree changed during the landing' : `writing failed (${e.message})`} — the files already written were put back${stuck.length ? `, except ${stuck.join(', ')} (changed again meanwhile; left as is)` : ''}. Nothing else was changed; run the command again.`, [`  at ${items[done.length]?.path ?? '?'}: ${e.message}`], 4);
  }
  for (const { aside } of done) if (aside) fs.rmSync(aside, { force: true });
}

/* ───────────────────────────────────────────── land */

function laneEntry(laneDir, mode, sha) {
  if (!sha || /^0+$/.test(sha)) return { exists: false };
  const kind = kindOfMode(mode);
  if (kind === 'gitlink') return { exists: true, kind: 'gitlink', mode, bytes: Buffer.from(sha) };
  return { exists: true, kind, mode, bytes: git(laneDir, ['cat-file', 'blob', sha], { buffer: true }).stdout };
}

function mergeFile(P, laneDir, b, l, t, rel) {
  const dir = fs.mkdtempSync(path.join(P.base, 'tmp', 'merge-'));
  try {
    const [fb, fl, ft] = ['base', 'shared', 'lane'].map((n) => path.join(dir, n));
    fs.writeFileSync(fb, b); fs.writeFileSync(fl, l); fs.writeFileSync(ft, t);
    const r = spawnSync('git', ['-C', laneDir, 'merge-file', '-p', '-L', `shared tree: ${rel}`, '-L', 'base', '-L', `lane: ${rel}`, fl, fb, ft], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    const status = r.status ?? -1;
    if (status < 0 || status > 127) return { ok: false, conflicts: null, error: String(r.stderr || '').trim() || `merge-file exit ${status}` };
    if (status > 0) {
      const at = []; r.stdout.toString('utf8').split('\n').forEach((ln, i) => { if (ln.startsWith('<<<<<<< ')) at.push(i + 1); });
      return { ok: false, conflicts: status, at };
    }
    return { ok: true, bytes: r.stdout };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * EXACT landed-state protection (verify 6f369176 — replaces the line-heuristic
 * REVERTS-FOREIGN, which filtered punctuation-only lines, exited early on a NUL byte,
 * and saw only base→tip removals).
 *
 * For every other ticket O with a standing (landed, not undone, not yet committed)
 * landing on this path, O's recorded change is pre of its first landing → post of its
 * latest. The bytes this landing would write must keep that change exactly:
 *   - typed: O deleted the file → ours absent; O's file exists → ours exists; a symlink
 *     or non-file on any side → ours must equal O's post exactly; a mode O changed must
 *     stay;
 *   - content (any bytes, NUL included — a byte-exact `diff --text -U0`, no filters):
 *     H_O = O's hunks (pre → post), H_L = our hunks (O's post → ours), both in O-post
 *     line coordinates.
 *       R1 a hunk of ours that changes or deletes ANY line O inserted → refused;
 *       R2 a hunk of ours that touches one of O's hunks (overlapping or adjacent) and
 *          inserts any line O deleted in that hunk → refused (a stale restore,
 *          deletions included).
 * Any diff error → refused. There is no filter and no early exit that passes; edits
 * beside O's lines that keep them byte-for-byte are allowed.
 */
function lineDiff(P, a, b) {
  const dir = fs.mkdtempSync(path.join(P.base, 'tmp', 'diff-'));
  try {
    const fa = path.join(dir, 'a'); const fb = path.join(dir, 'b');
    fs.writeFileSync(fa, a); fs.writeFileSync(fb, b);
    const r = spawnSync('git', ['diff', '--no-index', '--text', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', fa, fb],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (r.status !== 0 && r.status !== 1) return null;
    const hunks = []; let cur = null;
    for (const ln of r.stdout.toString('latin1').split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
      if (m) { cur = { a: +m[1], b: m[2] === undefined ? 1 : +m[2], c: +m[3], d: m[4] === undefined ? 1 : +m[4], del: [], add: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (ln.startsWith('-')) cur.del.push(ln.slice(1)); else if (ln.startsWith('+')) cur.add.push(ln.slice(1));
    }
    return hunks;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function committedTickets(P) {
  try { return new Set(CS.allTicketStates(CS.repoInfo(P.top).store).filter((s) => s.state === 'committed').map((s) => s.id)); } catch { return new Set(); }
}
function landedByOthers(P, id, rel, committed) {
  const by = new Map();
  for (const { ticket, rec } of allStanding(P)) {
    if (ticket === id || committed.has(ticket)) continue;
    for (const p of rec.paths) {
      if (p.path !== rel) continue;
      const cur = by.get(ticket);
      by.set(ticket, { ticket, pre: cur ? cur.pre : p.pre, post: p.post });
    }
  }
  return [...by.values()];
}
function violatesLanded(P, L, rel, post, o) {
  const modes = P.caps.modes;
  const opost = entryOf(P, o.post); const opre = entryOf(P, o.pre);
  if (sameEntry(post, opost, { modes })) return null;
  if (!opost.exists) return `${o.ticket} landed the deletion of this file; this landing would bring it back`;
  if (!post.exists) return `this landing would delete the file ${o.ticket} landed`;
  if (opost.kind !== 'file' || post.kind !== 'file' || (opre.exists && opre.kind !== 'file')) return `${o.ticket} landed this ${opost.kind === 'link' ? 'symlink' : 'entry'}; any difference from its landed bytes is refused`;
  // verify faa119a9: the mode O SET (changed, or chose by creating the file) is part of its landed hunk.
  if (modes && post.mode !== opost.mode && (!opre.exists || opre.mode !== opost.mode)) return `${o.ticket} landed this file with mode ${opost.mode}${opre.exists ? ` (changed from ${opre.mode})` : " (it created the file)"}; this landing would change it to ${post.mode}`;
  const HO = lineDiff(P, opre.exists ? opre.bytes : Buffer.alloc(0), opost.bytes);
  const HL = lineDiff(P, opost.bytes, post.bytes);
  if (!HO || !HL) return `could not compare against ${o.ticket}'s landed bytes — refused`;
  const show = (t) => JSON.stringify(Buffer.from(t, 'latin1').toString('utf8').slice(0, 80));
  for (const l of HL) {
    // our hunk's old range in O-post coordinates: lines [l.a, l.a+l.b-1]; b=0 = insertion after line l.a
    const lo = l.b ? l.a : l.a + 0.5; const hi = l.b ? l.a + l.b - 1 : l.a + 0.5;
    for (const h of HO) {
      // O's inserted lines in O-post coordinates: [h.c, h.c+h.d-1]; d=0 = deletion point after line h.c
      if (h.d && l.b && lo <= h.c + h.d - 1 && hi >= h.c) {
        const line = h.add[Math.max(0, Math.ceil(lo) - h.c)] ?? h.add[0] ?? '';
        return `this landing changes bytes ${o.ticket} landed (removes or rewrites ${show(line)})`;
      }
      const hlo = h.d ? h.c - 1 : h.c; const hhi = h.d ? h.c + h.d : h.c + 1; // adjacency window
      if (h.del.length && lo <= hhi && hi >= hlo) {
        const back = l.add.find((x) => h.del.includes(x));
        if (back !== undefined) return `this landing changes bytes ${o.ticket} landed (restores ${show(back)}, which ${o.ticket} deleted)`;
      }
    }
  }
  return null;
}

/**
 * Land a ticket's lane commits into the shared tree. Only the lane's own diff
 * (base → tip) is applied; a path someone else changed is 3-way merged; ANY overlap,
 * a foreign-line revert, or a failed merge-preservation check refuses the whole
 * landing with nothing written (exit 3).
 */
export function land({ repo, id, env = process.env, claim = true, allowRevert = [] }) {
  checkId(id);
  const P = projectOf(repo, env);
  const attempt = newId();
  requireHead(P);
  return withLandLock(P, () => {
    refuseIfPending(P);
    const meta = readMeta(P, id);
    const L = meta.laneDir;
    const s = laneState(L);
    if (s.dirty || s.merging) fail('lane-dirty', `${id}'s lane has uncommitted changes or an unfinished merge — commit them in the lane first (only commits land)`);
    let base = meta.base;
    if (meta.pendingBase) {
      if (!isAncestor(L, meta.pendingBase, s.tip)) fail('sync-unfinished', `${id} synced the shared tree (${meta.pendingBase.slice(0, 12)}) but the lane does not contain it yet — finish the merge and commit it, then land`);
      base = meta.pendingBase;
    }
    if (!isAncestor(L, base, s.tip)) fail('base-lost', `${id}'s base ${base.slice(0, 12)} is not in the lane's history (was it rewritten?) — run sync, resolve, commit, then land`);
    if (base === s.tip) fail('nothing-to-land', `${id} has no lane commits since its base — nothing to land`, [], 0);
    const modes = P.caps.modes;
    const allow = new Set(allowRevert.map((p) => CS.repoRel(P.top, p)));

    const raw = String(git(L, ['diff-tree', '-r', '-z', '--no-renames', '--raw', base, s.tip], { buffer: true }).stdout).split('\0');
    const changes = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(raw[i]);
      if (m) changes.push({ rel: raw[i + 1], oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4] });
    }
    const plan = []; const refusals = []; const kinds = new Set();
    const refuse = (kind, p, why, extra = {}) => { kinds.add(kind); refusals.push({ kind, path: p, why, ...extra }); };
    for (const c of changes) {
      const b = laneEntry(L, c.oldMode, c.oldSha);
      const t = laneEntry(L, c.newMode, c.newSha);
      const l = readLive(P.top, c.rel);
      const anc = ancestorProblem(P.top, c.rel);
      if (anc) { refuse('unsafe-path', c.rel, anc); continue; }
      if ([b, t].some((x) => x.kind === 'gitlink') || l.kind === 'other') { refuse('unsupported', c.rel, 'a submodule, directory or special file — the pilot does not land these'); continue; }
      const foreign = !sameEntry(l, b, { modes });
      // The mode the shared file ends with: the lane's when it changed the mode (and the FS carries modes), else the live one.
      const modeChanged = b.exists && t.exists && b.mode !== t.mode;
      const finalMode = !t.exists ? null : t.kind === 'link' ? '120000' : (!l.exists || l.kind !== 'file' || (modeChanged && modes)) ? t.mode : l.mode;
      const post = t.exists ? { exists: true, kind: t.kind, mode: finalMode, bytes: t.bytes } : { exists: false };
      if (sameEntry(l, post, { modes })) { plan.push({ path: c.rel, action: 'noop', pre: l, post, foreign }); continue; }
      if (!foreign) { plan.push({ path: c.rel, action: t.exists ? 'write' : 'delete', pre: l, post, foreign }); continue; }
      if (!t.exists) { refuse('overlap', c.rel, 'the lane deleted it, but the shared tree changed it'); continue; }
      if (!b.exists) { refuse('overlap', c.rel, 'the lane added it, and the shared tree has a different file at that path'); continue; }
      if (!l.exists) { refuse('overlap', c.rel, 'the lane changed it, but it was deleted in the shared tree'); continue; }
      if (b.kind !== 'file' || t.kind !== 'file' || l.kind !== 'file') { refuse('overlap', c.rel, 'a symlink changed on both sides'); continue; }
      if (isBinary(b.bytes) || isBinary(t.bytes) || isBinary(l.bytes)) { refuse('overlap', c.rel, 'a binary file changed on both sides'); continue; }
      if (Buffer.compare(l.bytes, b.bytes) === 0) { plan.push({ path: c.rel, action: 'write', pre: l, post, foreign }); continue; } // only the exec bit moved
      const mr = mergeFile(P, L, b.bytes, l.bytes, t.bytes, c.rel);
      if (!mr.ok) { refuse('overlap', c.rel, mr.conflicts ? `${mr.conflicts} overlapping region(s) with edits made in the shared tree since the lane's base` : `could not merge: ${mr.error}`, { at: mr.at }); continue; }
      const dropped = mergeDropped(b.bytes, l.bytes, t.bytes, mr.bytes);
      if (dropped.length) { refuse('merge-check', c.rel, `the 3-way merge would drop ${dropped.length} added line(s), e.g. ${JSON.stringify(dropped[0].slice(0, 80))} — refused rather than lose them`); continue; }
      plan.push({ path: c.rel, action: 'write', merged: true, pre: l, post: { ...post, bytes: mr.bytes }, foreign });
    }
    const committed = committedTickets(P);
    for (const p of plan.filter((x) => x.action !== 'noop')) {
      if (allow.has(p.path)) continue;
      for (const o of landedByOthers(P, id, p.path, committed)) {
        const why = violatesLanded(P, L, p.path, p.post, o);
        if (why) { refuse('reverts-foreign', p.path, why); p.action = 'refused'; break; }
      }
    }
    const todo = plan.filter((p) => p.action !== 'noop' && p.action !== 'refused');
    if (P.caps.caseInsensitive) {
      const seen = new Map();
      for (const p of todo) {
        const k = p.path.toLowerCase();
        if (seen.has(k) && seen.get(k) !== p.path) refuse('case-collision', p.path, `differs from ${seen.get(k)} only by case on a case-folding filesystem (${P.caps.fsType})`);
        seen.set(k, p.path);
        if (!p.pre.exists && p.post.exists) {
          const dir = path.join(P.top, ...p.path.split('/').slice(0, -1)); const name = p.path.split('/').at(-1);
          try { const clash = fs.readdirSync(dir).find((n) => n !== name && n.toLowerCase() === name.toLowerCase()); if (clash) refuse('case-collision', p.path, `the shared tree already has ${clash} (case-folding filesystem)`); } catch { /* dir absent */ }
        }
      }
    }
    const foreignPaths = plan.filter((p) => p.foreign).length + refusals.filter((r) => r.kind === 'overlap').length;
    if (refusals.length) {
      const outcome = kinds.has('overlap') ? 'refused-overlap' : `refused-${[...kinds][0]}`;
      metric(P, { ev: 'land', attempt, ticket: id, outcome, kinds: [...kinds], paths: changes.length, refusedPaths: refusals.length, foreignPaths, tip: s.tip, base });
      const head = kinds.has('overlap') ? 'OVERLAP' : kinds.has('reverts-foreign') ? 'REVERTS-FOREIGN' : 'REFUSED';
      fail('overlap', `${head} — ${id} was NOT landed: ${refusals.length} file(s) cannot be landed safely. Nothing was written.`, [
        ...refusals.map((o) => `  ${o.path} [${o.kind}]: ${o.why}${o.at?.length ? ` (conflict at merged line ${o.at.join(', ')})` : ''}`),
        kinds.has('reverts-foreign') ? `  If removing those lines IS the change, land with: --allow-revert <file> (recorded).` : null,
        `Fix it in the lane: node scripts/shadow.mjs sync ${id}  → resolve any conflicts in the lane, commit, then land again.`,
      ].filter(Boolean), 3);
    }
    if (!todo.length) {
      meta.base = s.tip; meta.pendingBase = null; writeJsonAtomic(P.metaFile(id), meta);
      metric(P, { ev: 'land', attempt, ticket: id, outcome: 'landed', paths: 0, foreignPaths, mergedPaths: 0, tip: s.tip, base });
      return { n: null, tip: s.tip, base, written: [], unchanged: plan.length, claimNote: 'the shared tree already held every change' };
    }
    // Ownership for FEAT-170: claim the paths no other ticket owns, at their PRE-land bytes.
    let claimNote = null; const joined = [];
    if (claim) {
      if (!P.hasHead) claimNote = 'the project has no commit yet — no candidate claim (promotion needs a base commit)';
      else {
        try {
          const owners = CS.ownersByPath(CS.repoInfo(P.top).store);
          const mine = todo.map((p) => p.path).filter((p) => !(owners.get(p) || []).some((o) => o.ticket !== id));
          for (const p of todo) if (!mine.includes(p.path)) joined.push(`${p.path} (owned by ${(owners.get(p.path) || []).map((o) => o.ticket).join(', ')})`);
          if (mine.length) CS.claimFiles({ repo: P.top, id, files: mine });
        } catch (e) { claimNote = `candidate claim failed: ${e.message}`; }
      }
    }
    const n = landingsOf(P, id).length + 1;
    const tag = `${id}-${n}-${attempt}`;
    const rec = { n, attempt, tag, at: new Date().toISOString(), tip: s.tip, base, state: 'pending', allowRevert: [...allow], paths: todo.map((p) => ({ path: p.path, merged: !!p.merged, foreign: p.foreign, pre: recOf(P, p.pre), post: recOf(P, p.post) })) };
    appendJsonl(P.landingsFile(id), rec);
    try { applyAll(P, todo, tag); } catch (e) {
      appendJsonl(P.landingsFile(id), { n, state: 'failed', at: new Date().toISOString(), error: e.message });
      metric(P, { ev: 'land', attempt, ticket: id, outcome: e.code === 'race' ? 'refused-race' : 'write-failed', paths: todo.length, tip: s.tip, base });
      throw e;
    }
    appendJsonl(P.landingsFile(id), { n, state: 'done', at: new Date().toISOString() });
    meta.landings.push({ n, tip: s.tip, base, at: rec.at });
    meta.base = s.tip; meta.pendingBase = null;
    writeJsonAtomic(P.metaFile(id), meta);
    git(L, ['update-ref', 'refs/orchard/landed', s.tip]);
    metric(P, { ev: 'land', attempt, ticket: id, outcome: 'landed', paths: todo.length, foreignPaths, mergedPaths: todo.filter((p) => p.merged).length, allowRevert: allow.size, tip: s.tip, base });
    return { n, tip: s.tip, base, written: todo.map((p) => ({ path: p.path, action: p.action, merged: !!p.merged })), unchanged: plan.length - todo.length, claimNote, joined };
  });
}

/* ───────────────────────────────────────────── journals */

/** All landings of a ticket with their final state (pending | done | failed | undone | recovered). */
export function landingsOf(P, T) {
  let lines = [];
  try { lines = fs.readFileSync(P.landingsFile(T), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  const byN = new Map();
  for (const r of lines) {
    if (r.paths) byN.set(r.n, { ...r });
    else if (byN.has(r.n)) byN.get(r.n).state = r.state;
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/** Undo the latest standing landing: restore its pre-land entries, all-or-nothing. */
export function unland({ repo, id, env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  return withLandLock(P, () => {
    refuseIfPending(P);
    const meta = readMeta(P, id);
    const last = landingsOf(P, id).filter((r) => r.state === 'done').at(-1);
    if (!last) fail('nothing-landed', `${id} has no landing to undo`, [], 0);
    const modes = P.caps.modes;
    const changed = last.paths.filter((p) => !sameEntry(readLive(P.top, p.path), entryOf(P, p.post), { modes })).map((p) => p.path);
    if (changed.length) {
      metric(P, { ev: 'unland', ticket: id, outcome: 'refused-changed', n: last.n });
      fail('changed-since-landing', `cannot undo landing ${last.n} of ${id}: ${changed.length} file(s) changed after it landed — nothing was restored`, changed.map((c) => `  ${c}`), 3);
    }
    applyAll(P, last.paths.map((p) => ({ path: p.path, pre: entryOf(P, p.post), post: entryOf(P, p.pre) })), `${id}-${last.n}-undo-${newId()}`);
    appendJsonl(P.landingsFile(id), { n: last.n, state: 'undone', at: new Date().toISOString() });
    meta.base = last.base; meta.pendingBase = null;
    writeJsonAtomic(P.metaFile(id), meta);
    metric(P, { ev: 'unland', ticket: id, outcome: 'undone', n: last.n, paths: last.paths.length });
    return { n: last.n, restored: last.paths.map((p) => p.path) };
  });
}

/**
 * Recover an interrupted landing (a journal still `pending` after a crash): every
 * path that holds the landed entry is put back to its pre-land entry, an aside file
 * left by the crash is restored when the path is empty, and anything else is left
 * alone and reported. The journal is marked `recovered`.
 */
export function recover({ repo, env = process.env }) {
  const P = projectOf(repo, env);
  return withLandLock(P, () => {
    const out = [];
    const modes = P.caps.modes;
    for (const { ticket, rec } of pendingJournals(P)) {
      const restored = []; const left = []; const untouched = [];
      for (const p of rec.paths) {
        const abs = path.join(P.top, ...p.path.split('/'));
        const dir = path.dirname(abs); const base = path.basename(abs);
        const live = readLive(P.top, p.path);
        const pre = entryOf(P, p.pre); const post = entryOf(P, p.post);
        const asides = (() => { try { return fs.readdirSync(dir).filter((n) => n.startsWith(`.${base}.orchard-aside-${rec.tag}`)); } catch { return []; } })();
        try {
          if (sameEntry(live, pre, { modes })) untouched.push(p.path);
          else if (sameEntry(live, post, { modes })) { const a = swap(P.top, p.path, post, pre, `${rec.tag}-recover`, { modes }); if (a) fs.rmSync(a, { force: true }); restored.push(p.path); }
          else if (!live.exists && asides.length) { installNoClobber(path.join(dir, asides[0]), abs); restored.push(p.path); asides.shift(); }
          else left.push(p.path);
        } catch { left.push(p.path); }
        for (const a of asides) { const f = path.join(dir, a); if (sameEntry(readAbs(f), pre, { modes })) fs.rmSync(f, { force: true }); }
        try { for (const n of fs.readdirSync(dir)) if (n.startsWith(`.${base}.orchard-new-`)) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* */ }
      }
      appendJsonl(P.landingsFile(ticket), { n: rec.n, state: 'recovered', at: new Date().toISOString(), restored, left });
      metric(P, { ev: 'recover', ticket, n: rec.n, restored: restored.length, left: left.length });
      out.push({ ticket, n: rec.n, restored, untouched, left });
    }
    return out;
  });
}

/* ───────────────────────────────────────────── freeze: landed bytes → FEAT-170 candidate */

/** Standing landings of every ticket in the project, oldest first: [{ticket, rec}]. */
function allStanding(P) {
  const out = [];
  for (const T of journalTickets(P)) for (const r of landingsOf(P, T)) if (r.state === 'done') out.push({ ticket: T, rec: r });
  return out.sort((a, b) => String(a.rec.at).localeCompare(String(b.rec.at)) || a.rec.n - b.rec.n);
}

export function freeze({ repo, id, checks = [], acceptForeign = [], dependsOn = [], env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  refuseIfPending(P);
  const standing = allStanding(P);
  const own = new Set(standing.filter((x) => x.ticket === id).flatMap((x) => x.rec.paths.map((p) => p.path)));
  if (!own.size) fail('nothing-landed', `${id} has no standing landing — land it first`);
  // The bytes each file must hold: its latest landing by ANY ticket (a later ticket may have landed into it).
  const latest = new Map(); const touchedBy = new Map();
  for (const { ticket, rec } of standing) for (const p of rec.paths) {
    if (!own.has(p.path)) continue;
    latest.set(p.path, { ticket, post: p.post, n: rec.n });
    if (!touchedBy.has(p.path)) touchedBy.set(p.path, new Set());
    touchedBy.get(p.path).add(ticket);
  }
  const modes = P.caps.modes;
  const changed = [...latest].filter(([rel, f]) => !sameEntry(readLive(P.top, rel), entryOf(P, f.post), { modes })).map(([rel]) => rel);
  if (changed.length) {
    metric(P, { ev: 'freeze', ticket: id, outcome: 'refused-changed', paths: own.size });
    fail('changed-since-landing', `${id}: ${changed.length} landed file(s) changed in the shared tree after their last landing — the candidate would not be the landed bytes`, [
      ...changed.map((c) => `  ${c}`),
      `Re-land the ticket that owns the change, or undo the later edit, then freeze again.`,
    ], 3);
  }
  const shared = [...touchedBy].filter(([, s]) => [...s].some((t) => t !== id)).map(([p]) => p);
  const expect = new Map([...latest].map(([rel, f]) => [rel, f.post ? { sha256: f.post.sha, mode: modes ? f.post.mode : null, deleted: false } : { deleted: true }]));
  let m;
  try {
    m = CS.freezeCandidate({ repo: P.top, id, files: [...own], checks, acceptForeign: [...new Set([...acceptForeign, ...shared])], dependsOn, expect,
      note: `shadow landings: ${[...new Set([...latest.values()].map((f) => `${f.ticket}#${f.n}`))].join(', ')}${shared.length ? `; shared with another ticket's landing: ${shared.join(', ')}` : ''}` });
  } catch (e) {
    metric(P, { ev: 'freeze', ticket: id, outcome: `refused-${e.code ?? 'error'}`, paths: own.size });
    if (e.code === 'owned') {
      const owners = [...new Set((e.detail || []).map((d) => / is owned by ([A-Z]+-\d+)/.exec(d)?.[1]).filter(Boolean))];
      throw new ShadowError('owned', `${id} shares landed file(s) with ${owners.join(', ')}: they are committed as ONE group. Freeze ${owners.join(', ')} first (node scripts/shadow.mjs freeze ${owners[0] ?? '<owner>'} --repo …), then: node scripts/shadow.mjs freeze ${id} --depends-on ${owners.join(',')} --repo …`, e.detail || [], 3);
    }
    if (e instanceof CS.CandidateError) throw new ShadowError(e.code, e.message, e.detail || [], 3);
    throw e;
  }
  metric(P, { ev: 'freeze', ticket: id, outcome: 'frozen', paths: own.size, hash: m.hash, shared: shared.length });
  return { hash: m.hash, files: [...own], shared, deps: m.deps.map((d) => d.ticket) };
}

/* ───────────────────────────────────────────── drop / list / inventory / retire */

export function drop({ repo, id, force = false, env = process.env }) {
  checkId(id);
  const P = projectOf(repo, env);
  const meta = readMeta(P, id);
  const s = laneState(meta.laneDir);
  if (!force && (s.dirty || s.tip !== meta.base)) fail('unlanded-work', `${id}'s lane has work that never landed (commits after its base, or uncommitted changes) — land it, or drop with --force`);
  fs.rmSync(meta.laneDir, { recursive: true, force: true });
  fs.rmSync(P.metaFile(id), { force: true });
  metric(P, { ev: 'drop', ticket: id, forced: !!force });
  return { dropped: meta.laneDir };
}

export function listLanes({ repo, env = process.env }) {
  const P = projectOf(repo, env);
  return fs.readdirSync(path.join(P.base, 'lanes')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((t) => TICKET_RE.test(t));
}

/** Standing (landed, not undone) landings whose ticket has no committed candidate yet. */
export function inventory({ repo, env = process.env }) {
  const P = projectOf(repo, env);
  let committed = new Set();
  if (P.hasHead) { try { const store = CS.repoInfo(P.top).store; committed = new Set(CS.allTicketStates(store).filter((s) => s.state === 'committed').map((s) => s.id ?? s.ticket)); } catch { /* no store */ } }
  const standing = allStanding(P).filter((x) => !committed.has(x.ticket));
  return { project: P.top, base: P.base, lanes: listLanes({ repo, env }), pending: pendingJournals(P).map((x) => `${x.ticket}#${x.rec.n}`),
    unpromoted: standing.map((x) => ({ ticket: x.ticket, n: x.rec.n, paths: x.rec.paths.map((p) => p.path) })) };
}

/** Archive this project's shadow records (never delete them); refused while landed work is unpromoted. */
export function retire({ repo, force = false, env = process.env }) {
  const inv = inventory({ repo, env });
  if (inv.pending.length) fail('interrupted', `an interrupted landing must be recovered first (${inv.pending.join(', ')})`, [`node scripts/shadow.mjs recover --repo ${inv.project}`], 3);
  if (inv.unpromoted.length && !force) fail('unpromoted', `${inv.unpromoted.length} landing(s) are in the shared tree but not committed — undo or promote them before retiring the pilot here`, inv.unpromoted.map((u) => `  ${u.ticket} #${u.n} (${u.paths.length} file(s)): node scripts/shadow.mjs unland ${u.ticket} --repo ${inv.project}`), 3);
  const dest = path.join(path.dirname(inv.base), 'retired', `${path.basename(inv.base)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(inv.base, dest);
  return { archived: dest };
}

/* ───────────────────────────────────────────── metrics */

export function readMetrics(P, { days = 28, now = Date.now() } = {}) {
  let ev = [];
  try { ev = fs.readFileSync(P.metricsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  const since = now - days * 86400_000;
  return ev.filter((e) => Date.parse(e.at) >= since);
}
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]; };

export function metrics({ repo, days = 28, env = process.env }) {
  const P = projectOf(repo, env);
  const ev = readMetrics(P, { days });
  const lanes = ev.filter((e) => e.ev === 'lane-new');
  const lands = ev.filter((e) => e.ev === 'land');
  const landed = lands.filter((e) => e.outcome === 'landed');
  const refusedOverlap = lands.filter((e) => e.outcome === 'refused-overlap');
  const syncs = ev.filter((e) => e.ev === 'sync');
  // Resolution chains: a refused land → the next landed one of the same ticket.
  const chains = []; const open = new Map();
  for (const e of [...lands, ...syncs].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (e.ev === 'sync') { if (open.has(e.ticket)) open.get(e.ticket).syncs++; continue; }
    if (e.outcome?.startsWith('refused') && !open.has(e.ticket)) open.set(e.ticket, { ticket: e.ticket, from: e.at, syncs: 0, kind: e.outcome });
    if (e.outcome === 'landed' && open.has(e.ticket)) { const c = open.get(e.ticket); open.delete(e.ticket); chains.push({ ...c, ms: Date.parse(e.at) - Date.parse(c.from) }); }
  }
  const attempts = lands.length;
  const ms = lanes.map((e) => e.ms);
  return {
    project: P.top, days, events: ev.length,
    conflictRate: { refusedOverlap: refusedOverlap.length, attempts, rate: attempts ? refusedOverlap.length / attempts : null,
      otherRefusals: lands.filter((e) => e.outcome?.startsWith('refused') && e.outcome !== 'refused-overlap').length,
      syncConflicts: syncs.filter((e) => e.conflict).length, syncs: syncs.length },
    resolution: { resolved: chains.length, unresolved: open.size, medianMs: pct(chains.map((c) => c.ms), 0.5), medianSyncs: pct(chains.map((c) => c.syncs), 0.5), oneSync: chains.filter((c) => c.syncs <= 1).length },
    setupCost: { lanes: lanes.length, medianMs: pct(ms, 0.5), p90Ms: pct(ms, 0.9), medianFiles: pct(lanes.map((e) => e.files), 0.5), medianBytes: pct(lanes.map((e) => e.bytes), 0.5), medianDepsMs: pct(lanes.map((e) => e.depsMs ?? 0), 0.5) },
    foreignEdits: {
      note: 'a path changed in the shared tree since the lane\'s base, author unknown (another lane, the user, a tool)',
      landsWithForeign: lands.filter((e) => (e.foreignPaths ?? 0) > 0).length, mergedClean: landed.filter((e) => (e.foreignPaths ?? 0) > 0).length,
      refusedOverlap: refusedOverlap.length, revertsForeignRefused: lands.filter((e) => e.kinds?.includes('reverts-foreign')).length,
    },
    loss: {
      note: 'mechanical checks only; NO report is not proof of zero loss',
      mergeCheckRefusals: lands.filter((e) => e.kinds?.includes('merge-check')).length,
      racesDetected: lands.filter((e) => e.outcome === 'refused-race').length,
      writeFailures: lands.filter((e) => e.outcome === 'write-failed').length,
      recovered: ev.filter((e) => e.ev === 'recover').length,
      reportedSilentLoss: ev.filter((e) => e.ev === 'incident' && e.kind === 'silent-loss').length,
    },
    unlands: ev.filter((e) => e.ev === 'unland' && e.outcome === 'undone').length,
    freezes: ev.filter((e) => e.ev === 'freeze' && e.outcome === 'frozen').length,
  };
}

/** Record an incident a verifier or the orchestrator found (e.g. a silent loss). */
export function recordIncident({ repo, id, kind, note = null, env = process.env }) {
  checkId(id);
  if (!['silent-loss', 'foreign-edit', 'other'].includes(kind)) fail('bad-kind', '--kind must be silent-loss, foreign-edit or other');
  const P = projectOf(repo, env);
  metric(P, { ev: 'incident', ticket: id, kind, note });
  return { recorded: kind };
}
