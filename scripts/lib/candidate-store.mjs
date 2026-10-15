/**
 * candidate-store.mjs — FEAT-170: IMMUTABLE VERIFY CANDIDATES and per-file TICKET
 * OWNERSHIP on a shared, uncommitted working tree.
 *
 * WHY. Many lanes edit ONE uncommitted tree. Verifiers hand-assembled "their"
 * ticket's diff (86 of 211 verify lanes in 30 days); a strip lane's whole-file
 * restore removed BUG-217's finished wiring four seconds after it went green and
 * the next verify returned a FALSE BROKEN (BUG-224); a per-ticket commit failed on
 * interleaved hunks; a batch commit put known-broken code on main. A patch LEDGER
 * gives provenance, not isolation (cross-provider critique, 2026-10-07). What is
 * built here: a FROZEN candidate identity, verification of exactly that, verdicts
 * bound to it, refusal on ambiguity, and a commit published from the frozen bytes.
 *
 * A CANDIDATE (one ticket, or an explicit GROUP of tickets) is frozen at handoff:
 *   - `base`   HEAD at freeze time;
 *   - `files`  per path: exact bytes (content-addressed, sha256) + git mode, or
 *              "deleted", plus the blob/mode the path had at `base`;
 *   - `deps`   other tickets' candidates this one builds on, PINNED BY HASH; their
 *              FROZEN bytes (never the live tree) are part of this candidate;
 *   - `checks` the fixer's recorded commands (re-run by the integration check);
 *   - `tree`   base's tree with ONLY these files overlaid — the SOURCE tree a commit
 *              of this candidate onto `base` produces;
 *   - `hash`   sha256 of the canonical identity {ticket, base, deps, checks, files}.
 * Nothing written to the working tree after the freeze — any lane, any tool, Bash or
 * python — can reach a candidate: its bytes live in the store.
 *
 * THE PROPERTY (rescoped 2026-10-07, FEAT-170 decision A): what gets committed for a
 * ticket is exactly the frozen bytes that were verified, and any later change to
 * those files invalidates the verdict. Readiness therefore needs every file's live
 * bytes to equal its frozen bytes (CURRENT); any other state blocks until a re-freeze
 * gets a new hash and a new verdict.
 *
 * WHAT IT DOES NOT CLAIM: a freeze captures the listed files as they are; it cannot
 * attribute each LINE to a lane. A candidate is a DECLARED bundle. Claims narrow that
 * (a file dirty at claim time, or never claimed, is refused unless declared or
 * accepted), but a hunk-local edit by a lane that never claimed the file, made between
 * the claim and the freeze, rides along. That is the ACCEPTED RESIDUAL. Its revisit
 * trigger is HARM, not presence: `foreignReport` counts committed foreign lines whose
 * owning ticket later gets a BROKEN touching them or changes them in its own freeze; at >= 1 a month the ownership redesign options (mutation ledger, sealed
 * copy) are reopened. The raw --accept-foreign count is informational only.
 *
 * WHERE. `<git-common-dir>/orchard-candidates/` of the repo being worked on:
 * per project, never committed, survives reboots. `objects/<sha256>`,
 * `cand/<hash>.json` and `integ/*.json` are WRITE-ONCE (0444) and RE-HASHED ON READ;
 * `tickets/<ID>.json` is the only mutable state, changed only under ONE store-wide
 * lock (so the cross-ticket ownership invariant is checked and written atomically).
 *
 * PRODUCT SCOPE (ARCH-013). Pure Node + git plumbing, no dependency on Orchard's
 * board or layout (the verdict reader is loaded lazily; its absence is reported),
 * so it operates on ANY git repo. How its verbs reach a non-Orchard project is the
 * fork ARCH-013 leaves to the user — see FEAT-170.
 *
 * Git use by every agent-runnable verb: read-only git plus the FEAT-135-sanctioned
 * `read-tree` / `add` / `write-tree` on a THROWAWAY index under the OS temp dir
 * (tree-snapshot.mjs's footing). The real index, HEAD and refs
 * are touched ONLY by `commitCandidate`, the USER's command. It has NO agent check of
 * its own: the project's git-write authority (FEAT-135's shim today, whatever FEAT-164
 * decides) is the single authority that refuses its publishing git calls in an agent
 * session. See commitCandidate.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Long-lived/expensive scratch never goes in the boot-wiped /tmp (CONVENTIONS, scratch.mjs).
import { mkdtempScratch } from './scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class CandidateError extends Error {
  constructor(code, message, detail = []) { super(message); this.code = code; this.detail = detail; }
}
const fail = (code, msg, detail) => { throw new CandidateError(code, msg, detail); };

export const HASH_RE = /^[0-9a-f]{64}$/;
export const TICKET_RE = /^(BUG|FEAT|ARCH|DEPLOY)-\d{1,5}$/;
export const TRAILER = 'Orchard-Candidate';

/* ─────────────────────────────────────────────────────────────── git helpers */

function git(repo, args, { env = null, input = null, buffer = false, allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: buffer ? 'buffer' : 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    input: input ?? undefined,
    maxBuffer: 512 * 1024 * 1024,
  });
  if ((r.status ?? 1) !== 0 && !allowFail) {
    const err = buffer ? (r.stderr ? r.stderr.toString() : '') : (r.stderr || '');
    fail('git-failed', `git ${args[0]} failed in ${repo}: ${String(err).trim() || `exit ${r.status}`}`);
  }
  return r;
}
const gitOut = (repo, args, o) => String(git(repo, args, o).stdout).trim();

/** Repo facts every verb needs. */
export function repoInfo(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' });
  if ((r.status ?? 1) !== 0) fail('not-a-repo', `not a git repository: ${repo} — candidates need git to name a base`);
  const [top, common] = r.stdout.trim().split('\n');
  const commonDir = path.isAbsolute(common) ? common : path.resolve(top, common);
  const headR = spawnSync('git', ['-C', top, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  if ((headR.status ?? 1) !== 0) fail('no-head', `${top} has no commit yet — a candidate needs a base commit`);
  return { top: fs.realpathSync(top), commonDir, head: headR.stdout.trim(), store: path.join(commonDir, 'orchard-candidates') };
}

/** Normalise a user-given path to repo-relative POSIX; refuse escapes and .git. */
export function repoRel(top, p) {
  const abs = path.resolve(top, p);
  let real = abs;
  try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* parent may not exist (deleted file) */ }
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('path-escape', `${p} is not inside the repository ${top}`);
  const posix = rel.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) fail('path-escape', `${p} is inside .git — not a candidate file`);
  return posix;
}

/** The live bytes + git mode of a repo path, or {exists:false}. Directories are refused. */
function readLive(top, rel) {
  const abs = path.join(top, ...rel.split('/'));
  let st;
  try { st = fs.lstatSync(abs); } catch { return { exists: false }; }
  if (st.isSymbolicLink()) return { exists: true, mode: '120000', bytes: Buffer.from(fs.readlinkSync(abs)) };
  if (st.isDirectory()) fail('is-directory', `${rel} is a directory — list the files in it; a candidate holds files`);
  if (!st.isFile()) fail('not-a-file', `${rel} is not a regular file`);
  return { exists: true, mode: (st.mode & 0o111) ? '100755' : '100644', bytes: fs.readFileSync(abs) };
}

/** {mode, blob} of a path in a commit or tree, or null when absent. Byte-exact. */
function blobAt(repo, rev, rel) {
  const r = git(repo, ['ls-tree', '-z', rev, '--', `:(literal)${rel}`]);
  const line = String(r.stdout).split('\0').find(Boolean);
  if (!line) return null;
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
  if (!m || m[2] !== 'blob') return null;
  return { mode: m[1], blob: m[3] };
}
function catBlob(repo, blob) { return git(repo, ['cat-file', 'blob', blob], { buffer: true }).stdout; }
const gitBlobOf = (repo, bytes) => gitOut(repo, ['hash-object', '--stdin'], { input: bytes });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ──────────────────────────────────────────────────────────────── the store */

function ensureStore(store) {
  for (const d of ['objects', 'cand', 'tickets', 'integ']) fs.mkdirSync(path.join(store, d), { recursive: true });
}

/** Write-once file publish (temp + rename, 0444). An existing file is never rewritten. */
function publishOnce(file, data) {
  if (fs.existsSync(file)) return false;
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o444 });
  fs.renameSync(tmp, file);
  return true;
}

function putObject(store, bytes) {
  const h = sha256(bytes);
  const p = path.join(store, 'objects', h);
  if (fs.existsSync(p)) { getObject(store, h); return h; }
  publishOnce(p, bytes);
  return h;
}

/** Read an object and PROVE it is what its name says. */
export function getObject(store, h) {
  const p = path.join(store, 'objects', h);
  let bytes;
  try { bytes = fs.readFileSync(p); } catch { fail('store-missing', `candidate store object ${h} is missing — the candidate cannot be reproduced; refusing`); }
  if (sha256(bytes) !== h) fail('store-tampered', `candidate store object ${h} does not match its own hash — the store was modified; refusing`);
  return bytes;
}

/** The identity that is hashed: key order fixed, files sorted by path. */
function identityOf(m) {
  // MIXED-STATE (see freezeMixed): a different identity version, so no clean (v2)
  // candidate's hash changes. It pins the whole verified room tree and exactly what
  // was disclosed to the verifier, besides the ticket's own frozen files.
  if (m.mode === 'mixed') {
    return {
      v: 3, mode: 'mixed', ticket: m.ticket, base: m.base, roomTree: m.roomTree,
      files: [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({
        path: f.path, owner: f.owner, deleted: !!f.deleted, mode: f.deleted ? null : f.mode,
        sha256: f.deleted ? null : f.sha256, baseBlob: f.baseBlob, baseMode: f.baseMode,
      })),
      disclosure: m.disclosure ?? null,
    };
  }
  return {
    v: 2,
    ticket: m.ticket,
    base: m.base,
    deps: [...m.deps].map((d) => ({ ticket: d.ticket, hash: d.hash })).sort((a, b) => a.ticket.localeCompare(b.ticket)),
    checks: [...(m.checks || [])],
    files: [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({
      path: f.path, owner: f.owner, deleted: !!f.deleted, mode: f.deleted ? null : f.mode,
      sha256: f.deleted ? null : f.sha256, baseBlob: f.baseBlob, baseMode: f.baseMode,
    })),
  };
}
export const candidateHash = (m) => sha256(Buffer.from(JSON.stringify(identityOf(m))));
/** Every ticket a candidate commits: itself plus its pinned dependency closure. */
export const membersOf = (m) => [m.ticket, ...m.deps.map((d) => d.ticket)];

/** Load a candidate by hash (or a unique prefix ≥ 8) and VERIFY it end to end. */
export function loadCandidate(store, ref) {
  let hash = String(ref || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(hash)) fail('bad-ref', `${ref} is not a candidate hash`);
  if (hash.length < 64) {
    let names = [];
    try { names = fs.readdirSync(path.join(store, 'cand')).filter((n) => n.startsWith(hash) && n.endsWith('.json')); } catch { /* none */ }
    if (names.length !== 1) fail('unknown-candidate', `${ref} matches ${names.length} candidates in the store`);
    hash = names[0].slice(0, 64);
  }
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(store, 'cand', `${hash}.json`), 'utf8')); }
  catch { fail('unknown-candidate', `no candidate ${hash} in the store`); }
  if (m.hash !== hash || candidateHash(m) !== hash) fail('store-tampered', `candidate ${hash} does not match its own identity hash — the store was modified; refusing`);
  for (const f of m.files) if (!f.deleted) getObject(store, f.sha256);
  return m;
}

/* ── ONE store-wide lock: every read-check-write of ticket state happens inside it.
 * A holder is broken only when it is PROVABLY dead (same host, pid gone), or after
 * a 10-minute backstop — never because a live process paused for a while. */

const LOCK_BACKSTOP_MS = 10 * 60_000;
function withStoreLock(store, fn) {
  ensureStore(store);
  const lock = path.join(store, 'lock');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const l = JSON.parse(fs.readFileSync(lock, 'utf8'));
        let alive = true;
        if (l.host === os.hostname()) { try { process.kill(l.pid, 0); } catch (err) { alive = err.code === 'EPERM'; } }
        stale = !alive || Date.now() - Number(l.at) > LOCK_BACKSTOP_MS;
      } catch { stale = false; } // half-written by a live writer: wait, do not break it
      if (stale) {
        const aside = `${lock}.stale-${process.pid}-${randomBytes(3).toString('hex')}`;
        try { fs.renameSync(lock, aside); fs.rmSync(aside, { force: true }); } catch { /* another breaker won */ }
        continue;
      }
      if (Date.now() > deadline) fail('store-busy', 'the candidate store is locked by another live process; retry');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } }
}

function ticketFile(store, id) { return path.join(store, 'tickets', `${id}.json`); }
export function readTicketState(store, id) {
  try { return JSON.parse(fs.readFileSync(ticketFile(store, id), 'utf8')); }
  catch { return { id, open: null, claim: null, state: 'none', history: [] }; }
}
function writeTicketState(store, st) {
  const f = ticketFile(store, st.id);
  const tmp = `${f}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, f);
}
export function allTicketStates(store) {
  let names = [];
  try { names = fs.readdirSync(path.join(store, 'tickets')).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => readTicketState(store, n.slice(0, -5)));
}

/**
 * Who owns each path now: every member of an OPEN candidate owns that candidate's
 * files; an active claim owns its files. Map<path, [{ticket, via, hash?}]>.
 */
export function ownersByPath(store) {
  const out = new Map();
  const add = (p, o) => { if (!out.has(p)) out.set(p, []); out.get(p).push(o); };
  for (const st of allTicketStates(store)) {
    if (st.open) {
      let m = null;
      try { m = loadCandidate(store, st.open); } catch { /* a broken candidate owns nothing it can prove */ }
      if (m) for (const f of m.files) if (f.owner === st.id) add(f.path, { ticket: st.id, via: 'candidate', hash: m.hash });
    }
    if (st.claim) for (const f of st.claim.files) add(f.path, { ticket: st.id, via: 'claim' });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────── claim */

/**
 * Claim files at lane start: records ownership AND each file's bytes at claim time
 * (the mechanical "pre-lane" copy). Overlap with another open ticket is returned as
 * `conflicts` (the CLI exits 3), never silent.
 */
export function claimFiles({ repo, id, files }) {
  if (!TICKET_RE.test(id)) fail('bad-id', `${id} is not a ticket id`);
  if (!files?.length) fail('missing-arg', 'claim: name the files (--files a b c)');
  const info = repoInfo(repo);
  const rels = [...new Set(files.map((f) => repoRel(info.top, f)))];
  return withStoreLock(info.store, () => {
    const owners = ownersByPath(info.store);
    const conflicts = [];
    for (const p of rels) for (const o of owners.get(p) || []) if (o.ticket !== id) conflicts.push({ path: p, owner: o.ticket, via: o.via });
    const st = readTicketState(info.store, id);
    const prev = new Map((st.claim?.files || []).map((f) => [f.path, f]));
    const recs = rels.map((p) => {
      if (prev.has(p)) return prev.get(p); // the FIRST claim's pre-lane bytes stay authoritative
      const live = readLive(info.top, p);
      return { path: p, sha256: live.exists ? putObject(info.store, live.bytes) : null, at: new Date().toISOString() };
    });
    const merged = [...new Map([...(st.claim?.files || []), ...recs].map((f) => [f.path, f])).values()];
    st.claim = { files: merged, head: info.head, at: st.claim?.at ?? new Date().toISOString() };
    if (!st.open) st.state = 'claimed';
    st.history.push({ event: 'claim', files: rels, at: new Date().toISOString(), conflicts: conflicts.map((c) => `${c.path}<-${c.owner}`) });
    writeTicketState(info.store, st);
    return { id, files: rels, conflicts };
  });
}

/* ──────────────────────────────────────────────────────────────── freeze */

/** Read every listed file until two consecutive passes agree (no mixed generation). */
function stableRead(top, rels) {
  let prev = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = new Map(rels.map((p) => [p, readLive(top, p)]));
    if (prev && [...cur].every(([p, v]) => {
      const u = prev.get(p);
      return u.exists === v.exists && (!v.exists || (u.mode === v.mode && Buffer.compare(u.bytes, v.bytes) === 0));
    })) return cur;
    prev = cur;
  }
  fail('unstable', `the files kept changing while being frozen (${rels.length} file(s)) — another lane is writing them; freeze again when it has finished`);
}

/**
 * Freeze a ticket's candidate (or a GROUP, with dependsOn). Refusals:
 *   'owned'            a file is owned by another open ticket outside the dependency closure
 *   'foreign-at-claim' a claimed file already held others' uncommitted lines at claim time
 *   'dep-*'            a dependency is not frozen, forms a cycle, or two deps disagree on a file
 *   'unstable'         the files changed while being read
 *   'no-change'        nothing differs from HEAD
 */
export function freezeCandidate({ repo, id, files, dependsOn = [], acceptForeign = [], checks = [], round = null, note = null, expect = null }) {
  if (!TICKET_RE.test(id)) fail('bad-id', `${id} is not a ticket id`);
  if (!files?.length) fail('missing-arg', 'freeze: name the ticket\'s files (--files a b c)');
  for (const d of dependsOn) if (!TICKET_RE.test(d) || d === id) fail('bad-id', `--depends-on ${d} is not another ticket id`);
  const info = repoInfo(repo);
  const own = [...new Set(files.map((f) => repoRel(info.top, f)))];
  const accept = new Set(acceptForeign.map((f) => repoRel(info.top, f)));

  return withStoreLock(info.store, () => {
    // 1. Dependencies, PINNED by their current open candidate hash; closure through
    //    the pinned candidates' own pins; a cycle back to this ticket is refused.
    const pinned = new Map(); // ticket -> candidate manifest
    const stack = [...dependsOn];
    while (stack.length) {
      const d = stack.pop();
      if (d === id) fail('dep-cycle', `--depends-on ${dependsOn.join(', ')} leads back to ${id} — a dependency cycle cannot be committed in any order`);
      if (pinned.has(d)) continue;
      const st = readTicketState(info.store, d);
      if (!st.open) fail('dep-not-frozen', `--depends-on ${d}: ${d} has no open candidate — freeze ${d} first (a group is built from frozen work, never from the live tree)`);
      const dm = loadCandidate(info.store, st.open);
      pinned.set(d, dm);
      for (const x of dm.deps) stack.push(x.ticket);
    }
    // The dependency files come from the dependencies' FROZEN bytes.
    const depFiles = new Map(); // path -> entry (owner = dep ticket)
    for (const [d, dm] of pinned) {
      for (const f of dm.files.filter((x) => x.owner === d)) {
        if (own.includes(f.path)) continue; // this ticket's own capture of a shared file wins (it holds both)
        const prior = depFiles.get(f.path);
        if (prior && (prior.sha256 !== f.sha256 || prior.deleted !== f.deleted)) {
          fail('dep-conflict', `dependencies ${prior.owner} and ${d} froze different bytes for ${f.path} — freeze them as one group first`);
        }
        depFiles.set(f.path, { ...f });
      }
    }
    // 2. Ownership against every other open ticket, atomically under the store lock.
    const owners = ownersByPath(info.store);
    const clashes = [];
    for (const p of own) {
      for (const o of owners.get(p) || []) {
        if (o.ticket !== id && !pinned.has(o.ticket)) clashes.push(`${p} is owned by ${o.ticket} (${o.via}${o.hash ? ` ${o.hash.slice(0, 12)}` : ''})`);
      }
    }
    if (clashes.length) {
      fail('owned', `freeze ${id}: ${clashes.length} file(s) belong to another open ticket — two tickets in one file are committed together or one after the other, never silently mixed`, [
        ...clashes,
        'Either declare the dependency (--depends-on <ID>: verified and committed as ONE group),',
        'or wait until that ticket is committed or released.',
      ]);
    }
    // 3. Foreign lines present at CLAIM time (the FEAT-169/BUG-234 shape).
    const st = readTicketState(info.store, id);
    const claimMap = new Map((st.claim?.files || []).map((f) => [f.path, f]));
    const foreign = []; const attribution = {};
    for (const p of own) {
      const c = claimMap.get(p);
      const b = blobAt(info.top, info.head, p);
      const baseSha = b ? sha256(catBlob(info.top, b.blob)) : null;
      const coveredByDep = (owners.get(p) || []).some((o) => pinned.has(o.ticket));
      if (!c) {
        // ROUND 2 (verify 64ff5cb8 #2): no claim means no pre-lane bytes, so NOTHING proves
        // which of this file's uncommitted lines are this ticket's. Structural default:
        // refuse, whether or not the lane remembered to claim. A file that equals HEAD
        // carries no uncommitted lines at all and needs no attribution.
        const liveNow = readLive(info.top, p);
        const liveSha = liveNow.exists ? sha256(liveNow.bytes) : null;
        if (liveSha === baseSha) attribution[p] = 'unclaimed, identical to HEAD';
        else if (accept.has(p)) attribution[p] = 'ACCEPTED: unclaimed, so its uncommitted lines are not attributable to this ticket';
        else if (coveredByDep) attribution[p] = 'unclaimed; covered by a declared dependency';
        else foreign.push(`${p} differs from HEAD and ${id} never claimed it — nothing shows which of its uncommitted lines are ${id}'s (claim files at lane start)`);
        continue;
      }
      if (c.sha256 === baseSha) attribution[p] = 'claimed while clean';
      else if (accept.has(p)) attribution[p] = 'ACCEPTED foreign lines present at claim time';
      else if (coveredByDep) attribution[p] = 'dirty at claim time; covered by a declared dependency';
      else foreign.push(`${p} already differed from HEAD when ${id} claimed it — those uncommitted lines are not ${id}'s`);
    }
    if (foreign.length) {
      fail('foreign-at-claim', `freeze ${id}: ${foreign.length} file(s) may carry another lane's uncommitted lines (dirty when claimed, or never claimed)`, [
        ...foreign,
        'Declare whose they are (--depends-on <ID>), or accept them into this candidate explicitly (--accept-foreign <file>, recorded on the candidate).',
      ]);
    }
    // 4. Capture own files (stable read), then dependency files (frozen bytes).
    const live = stableRead(info.top, own);
    const entries = [];
    for (const p of own) {
      const l = live.get(p);
      const b = blobAt(info.top, info.head, p);
      if (!l.exists && !b) fail('no-such-file', `${p} exists neither in the working tree nor at HEAD — nothing to freeze`);
      entries.push({ path: p, owner: id, deleted: !l.exists, mode: l.exists ? l.mode : null, sha256: l.exists ? putObject(info.store, l.bytes) : null, baseBlob: b ? b.blob : null, baseMode: b ? b.mode : null });
    }
    for (const [p, f] of depFiles) {
      const b = blobAt(info.top, info.head, p);
      entries.push({ path: p, owner: f.owner, deleted: f.deleted, mode: f.mode, sha256: f.sha256, baseBlob: b ? b.blob : null, baseMode: b ? b.mode : null });
    }
    // Optional `expect` (FEAT-170 plan review 1 #9): a caller that knows which bytes the candidate
    // MUST hold passes them; the captured bytes are checked against
    // them here, after the stable read and before anything is published, so an edit
    // between the caller's check and this capture can never become the candidate.
    if (expect) {
      const off = [];
      for (const e of entries.filter((x) => x.owner === id)) {
        const x = expect.get(e.path);
        if (!x) { off.push(`${e.path}: not an expected file`); continue; }
        if (!!x.deleted !== !!e.deleted || (!e.deleted && (x.sha256 !== e.sha256 || (x.mode && x.mode !== e.mode)))) off.push(`${e.path}: captured ${e.deleted ? 'deleted' : `${e.sha256.slice(0, 12)} ${e.mode}`}, expected ${x.deleted ? 'deleted' : `${x.sha256.slice(0, 12)} ${x.mode ?? ''}`}`);
      }
      if (off.length) fail('not-expected', `freeze ${id}: the captured bytes are not the expected (landed) bytes — nothing was frozen`, off);
    }
    const manifest = {
      ticket: id, base: info.head,
      deps: [...pinned].map(([t, dm]) => ({ ticket: t, hash: dm.hash })),
      checks: [...checks], files: entries,
    };
    manifest.hash = candidateHash(manifest);
    manifest.tree = buildTree(info.top, info.store, manifest, info.head);
    // Unchanged = the path's entry in the candidate tree equals HEAD's (blob and mode).
    const unchanged = entries.filter((e) => {
      const a = blobAt(info.top, manifest.tree, e.path); const b = blobAt(info.top, info.head, e.path);
      return (a?.blob ?? null) === (b?.blob ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
    }).map((e) => e.path);
    if (unchanged.length === entries.length) fail('no-change', `freeze ${id}: none of the files differs from HEAD — there is nothing to verify`);
    // The claim-time bytes of each claimed file: lines already differing from HEAD at
    // claim time are not this ticket's. Provenance, not identity — foreignReport counts
    // them for accepted-foreign files; they do not change what is verified.
    const claims = {};
    for (const p of own) if (claimMap.get(p)?.sha256) claims[p] = claimMap.get(p).sha256;
    manifest.meta = { frozenAt: new Date().toISOString(), round, note, attribution, claims, acceptedForeign: [...accept], unchangedFiles: unchanged };
    publishOnce(path.join(info.store, 'cand', `${manifest.hash}.json`), JSON.stringify(manifest, null, 2));
    const prevOpen = st.open;
    st.open = manifest.hash;
    st.state = 'open';
    st.history.push({ event: 'freeze', hash: manifest.hash, supersedes: prevOpen && prevOpen !== manifest.hash ? prevOpen : null, round, deps: manifest.deps, at: manifest.meta.frozenAt });
    writeTicketState(info.store, st);
    return manifest;
  });
}

/**
 * Overlay a candidate's files onto `onto` (a commit or tree) in a THROWAWAY index and
 * write the tree. Bytes come from the STORE, never the live tree. Deterministic.
 *
 * Only the plumbing the FEAT-135 git shim sanctions for agent sessions is used —
 * `read-tree`, `add`, `write-tree` against a GIT_INDEX_FILE under the OS temp dir —
 * so lanes can freeze and verify. The frozen bytes are laid out in a private temp
 * WORK TREE and `add -A -f` stages exactly the candidate's paths from it (absent =
 * deletion), with the repo's own attributes/filters, as a real `git add` would.
 */
function buildTree(top, store, m, onto) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-candidate-'));
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  const gitDir = path.resolve(top, gitOut(top, ['rev-parse', '--git-dir']));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index'), GIT_DIR: gitDir, GIT_WORK_TREE: wt };
  try {
    git(top, ['read-tree', onto], { env });
    for (const f of m.files) {
      if (f.deleted) continue;
      const p = path.join(wt, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const bytes = getObject(store, f.sha256);
      if (f.mode === '120000') fs.symlinkSync(bytes.toString(), p);
      else { fs.writeFileSync(p, bytes); fs.chmodSync(p, f.mode === '100755' ? 0o755 : 0o644); }
    }
    const specs = m.files.map((f) => `:(literal)${f.path}`);
    for (let i = 0; i < specs.length; i += 500) {
      const r = spawnSync('git', ['add', '-A', '-f', '--', ...specs.slice(i, i + 500)], { cwd: wt, encoding: 'utf8', env: { ...process.env, ...env } });
      if ((r.status ?? 1) !== 0) fail('git-failed', `staging the candidate's files in a throwaway index failed: ${(r.stderr || '').trim()}`);
    }
    return gitOut(top, ['write-tree'], { env });
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** FEAT-164 release — the tree `onto` + candidate `m`'s frozen bytes (the same builder the commit uses). */
export function buildCandidateTree(top, store, m, onto) { return buildTree(top, store, m, onto); }

/**
 * FEAT-164 release — after ONE release commit published several candidates, mark each
 * candidate's members committed (the same transition `commitCandidate` makes, under the
 * store lock). `hashes` = the published candidates' hashes.
 */
export function markCandidatesCommitted(repo, hashes, commit, event = 'release') {
  const info = repoInfo(repo);
  return withStoreLock(info.store, () => {
    for (const hash of hashes) {
      const m = loadCandidate(info.store, hash);
      for (const T of membersOf(m)) {
        const ts = readTicketState(info.store, T);
        ts.history.push({ event, hash, commit, at: new Date().toISOString() });
        // Same transition as commitCandidate: the owner always; a dependency only while
        // its open candidate is still the one this group pinned.
        if (T === m.ticket || ts.open === m.deps.find((d) => d.ticket === T)?.hash) { ts.open = null; ts.claim = null; ts.state = 'committed'; }
        writeTicketState(info.store, ts);
      }
    }
  });
}

/** Materialise for a verifier: integrity-checked, and the recomputed tree must equal the recorded one. */
export function materializeCandidate(repo, ref) {
  const info = repoInfo(repo);
  const m = loadCandidate(info.store, resolveRefIn(info, ref));
  if (m.mode === 'mixed') return materializeMixed(info, m);
  let tree;
  try { tree = buildTree(info.top, info.store, m, m.base); }
  catch (e) { fail('base-missing', `candidate ${m.hash.slice(0, 12)}'s base ${m.base.slice(0, 12)} cannot be read (${e.message}) — history was rewritten or pruned; re-freeze`); }
  if (tree !== m.tree) fail('tree-mismatch', `candidate ${m.hash.slice(0, 12)} re-materialised to tree ${tree.slice(0, 12)}, recorded ${m.tree.slice(0, 12)} — refusing to verify something other than what was frozen`);
  return { manifest: m, base: m.base, tree, info };
}

function resolveRefIn(info, ref) {
  if (TICKET_RE.test(String(ref))) {
    const st = readTicketState(info.store, ref);
    if (!st.open) fail('no-open-candidate', `${ref} has no open candidate — the fixer freezes one at handoff: candidate freeze --id ${ref} --files …`);
    return st.open;
  }
  return loadCandidate(info.store, ref).hash;
}
export function resolveRef(repo, ref) { return resolveRefIn(repoInfo(repo), ref); }

/* ─────────────────────────────────────────── MIXED-STATE freeze (no ownership) */

/*
 * WHY. A clean candidate needs the ticket's files to carry only its own uncommitted
 * lines (or a declared dependency group). On a shared tree that is often false: BUG-255's
 * verify could not start because five other open tickets had hunks in the same files
 * (freeze refused `owned`; a group hit dependency cycles; --working-tree was an 800 KB
 * blend). Lanes worked around it by hand: copy the tree to scratch, check the hashes
 * against the live files, verify there, record the verdict.
 *
 * A MIXED-STATE candidate is that workaround as the tool's own path:
 *   - the ticket's files are frozen AS THEY ARE in the working tree, foreign hunks
 *     included, from ONE snapshot of the whole tree (the verifier's room), and their
 *     snapshot bytes are checked equal to the live bytes before anything is published;
 *   - it takes NO claim and writes NO ticket state, so it never refuses because another
 *     ticket owns a file, and never makes anyone else's freeze refuse;
 *   - each hunk of those files that is attributable to another ticket (matched against
 *     that ticket's own frozen bytes) or predates this ticket's claim is DISCLOSED, with
 *     the owning ticket where known — ticket ids and line ranges only, never prose;
 *   - the hash pins the files, the room tree and the disclosure; a later edit to any
 *     frozen file makes candidateStatus report CHANGED, so the bound verdict lapses.
 * It is a verification binding, not a commit unit (readiness refuses it).
 */

/** The ticket's own file list when the caller names none: its open candidate's own files, else its claim. */
export function ticketFilesOf(repo, id) {
  const info = repoInfo(repo);
  const st = readTicketState(info.store, id);
  if (st.open) {
    try { return loadCandidate(info.store, st.open).files.filter((f) => f.owner === id).map((f) => f.path); } catch { /* fall through */ }
  }
  return (st.claim?.files || []).map((f) => f.path);
}

/**
 * Is the ticket's open CLEAN candidate usable as-is (every file CURRENT, no stale base,
 * pinned dependencies still open at their pinned hash, and it covers `files` if named)?
 * Returns { usable, hash, reasons[] } — the reasons say why a clean diff is not possible.
 */
export function cleanCandidateUsable(repo, id, files = null) {
  const info = repoInfo(repo);
  const st = readTicketState(info.store, id);
  if (!st.open) return { usable: false, hash: null, reasons: [`${id} has no open clean candidate`] };
  let s;
  try { s = candidateStatus(repo, st.open); } catch (e) { return { usable: false, hash: st.open, reasons: [`its candidate cannot be loaded: ${e.message}`] }; }
  const reasons = [];
  for (const f of s.files) {
    if (f.state !== 'CURRENT') reasons.push(`${f.path}: ${f.state}`);
    if (f.staleBase) reasons.push(`${f.path}: STALE-BASE`);
  }
  for (const d of s.manifest.deps) if (readTicketState(info.store, d.ticket).open !== d.hash) reasons.push(`dependency ${d.ticket} re-frozen, released or committed`);
  if (files?.length) {
    const own = new Set(s.manifest.files.filter((f) => f.owner === id).map((f) => f.path));
    const miss = [...new Set(files.map((f) => repoRel(info.top, f)))].filter((p) => !own.has(p));
    if (miss.length) reasons.push(`the candidate does not cover ${miss.join(', ')}`);
  }
  return { usable: reasons.length === 0, hash: s.manifest.hash, reasons };
}

/** `git diff --no-index -U0` hunks WITH their line content. */
function contentHunks(a, b) {
  if (Buffer.compare(a, b) === 0) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-cand-hunks-'));
  try {
    const pa = path.join(dir, 'a'); const pb = path.join(dir, 'b');
    fs.writeFileSync(pa, a); fs.writeFileSync(pb, b);
    const r = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '-U0', '--text', '--', pa, pb], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) fail('git-failed', `git diff --no-index failed: ${(r.stderr || '').trim()}`);
    const out = []; let cur = null;
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) { cur = { oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4], del: [], add: [] }; out.push(cur); continue; }
      if (!cur) continue;
      if (line.startsWith('-')) cur.del.push(line.slice(1));
      else if (line.startsWith('+')) cur.add.push(line.slice(1));
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const hunkKey = (h) => JSON.stringify([h.del, h.add]);
/** A line worth matching on: short / punctuation-only lines (`}`, `);`) match everywhere. */
const significant = (t) => /[A-Za-z0-9_]{3,}/.test(t);

/**
 * Attribute each hunk of HEAD→frozen for one file. Sources, all from the store:
 *   other tickets' OPEN candidates owning the file (their frozen bytes) → that ticket;
 *   this ticket's own CLAIM-time bytes → lines that predate this ticket's lane;
 *   this ticket's own (stale) open candidate → its own lines;
 *   other tickets' CLAIMS → named as claimants (a claim records pre-lane bytes, so it
 *   cannot say which lines are theirs).
 */
function discloseFile(info, id, rel, headBytes, frozenBytes, owners, ownState) {
  const live = contentHunks(headBytes, frozenBytes);
  const src = [];
  const claimants = [];
  for (const o of owners.get(rel) || []) {
    if (o.ticket === id) continue;
    if (o.via === 'claim') { claimants.push(o.ticket); continue; }
    let m; try { m = loadCandidate(info.store, o.hash); } catch { continue; }
    const f = m.files.find((x) => x.path === rel && x.owner === o.ticket);
    if (!f) continue;
    src.push({ kind: 'other', ticket: o.ticket, hunks: contentHunks(headBytes, f.deleted ? Buffer.alloc(0) : getObject(info.store, f.sha256)) });
  }
  const claimSha = ownState.claim?.files?.find((f) => f.path === rel)?.sha256;
  const pre = claimSha ? contentHunks(headBytes, getObject(info.store, claimSha)) : [];
  let own = [];
  if (ownState.open) {
    try {
      const f = loadCandidate(info.store, ownState.open).files.find((x) => x.path === rel && x.owner === id);
      if (f) own = contentHunks(headBytes, f.deleted ? Buffer.alloc(0) : getObject(info.store, f.sha256));
    } catch { /* none */ }
  }
  const keys = (hs) => new Set(hs.map(hunkKey));
  const sig = (hs) => new Set(hs.flatMap((h) => [...h.del.map((t) => `-${t}`), ...h.add.map((t) => `+${t}`)]).filter((t) => significant(t.slice(1))));
  const srcK = src.map((s) => ({ ...s, keys: keys(s.hunks), sig: sig(s.hunks) }));
  const preK = keys(pre); const preSig = sig(pre); const ownK = keys(own);
  const hunks = []; let unattributed = 0; let ownN = 0;
  for (const h of live) {
    const k = hunkKey(h);
    const hs = [...h.del.map((t) => `-${t}`), ...h.add.map((t) => `+${t}`)].filter((t) => significant(t.slice(1)));
    const exact = [...new Set(srcK.filter((s) => s.keys.has(k)).map((s) => s.ticket))];
    const partial = [...new Set(srcK.filter((s) => hs.some((t) => s.sig.has(t))).map((s) => s.ticket))];
    const at = { path: rel, newStart: h.newStart, newLen: h.newLen, oldStart: h.oldStart, oldLen: h.oldLen };
    if (exact.length) hunks.push({ ...at, class: 'foreign', owners: exact, basis: 'identical to the owner\'s frozen change' });
    else if (preK.has(k) || (hs.length && hs.every((t) => preSig.has(t)))) hunks.push({ ...at, class: 'foreign', owners: partial, basis: `already present when ${id} claimed the file` });
    else if (ownK.has(k)) ownN++;
    else if (partial.length) hunks.push({ ...at, class: 'mixed', owners: partial, basis: 'shares changed lines with the owner\'s frozen change; may also hold this ticket\'s lines' });
    else unattributed++;
  }
  return { file: { path: rel, hunks: live.length, own: ownN, unattributed, claimants: [...new Set(claimants)].sort() }, hunks };
}

/**
 * Freeze a MIXED-STATE candidate. Never claims, never refuses for ownership, writes no
 * ticket state. Refusals: 'missing-arg' (no files known), 'unstable' (files changed
 * while snapshotting), 'ignored' (a listed file exists but git ignores it), 'no-such-file',
 * 'no-change' (every listed file equals HEAD — nothing to verify).
 */
export function freezeMixed({ repo, id, files = null, why = null }) {
  if (!TICKET_RE.test(id)) fail('bad-id', `${id} is not a ticket id`);
  let info = repoInfo(repo);
  const rels = files?.length ? [...new Set(files.map((f) => repoRel(info.top, f)))] : ticketFilesOf(repo, id);
  if (!rels.length) fail('missing-arg', `mixed freeze ${id}: name the ticket's files (--files a b c); ${id} has no candidate or claim to take them from`);
  let room = null; let entries = null;
  for (let attempt = 0; attempt < 4 && !entries; attempt++) {
    info = repoInfo(repo);
    room = snapshotTree(info.top);
    if (room.head !== info.head) continue; // HEAD moved mid-snapshot
    const got = [];
    let ok = true;
    for (const p of rels) {
      const b = blobAt(info.top, room.tree, p);
      const h = blobAt(info.top, room.head, p);
      const bytes = b ? catBlob(info.top, b.blob) : null;
      const live = readLive(info.top, p);
      // The room's bytes must be the live bytes ("check the hashes against the live files").
      if (!!b !== live.exists || (b && (Buffer.compare(bytes, live.bytes) !== 0 || b.mode !== live.mode))) {
        if (live.exists && !b && spawnSync('git', ['-C', info.top, 'check-ignore', '-q', '--no-index', '--', p]).status === 0) {
          fail('ignored', `mixed freeze ${id}: ${p} exists but git ignores it, so the snapshot (the verifier's room) cannot carry it`);
        }
        ok = false; break;
      }
      if (!b && !h) fail('no-such-file', `${p} exists neither in the working tree nor at HEAD — nothing to freeze`);
      got.push({ path: p, owner: id, deleted: !b, mode: b ? b.mode : null, bytes, blob: b ? b.blob : null, baseBlob: h ? h.blob : null, baseMode: h ? h.mode : null });
    }
    if (ok) entries = got;
  }
  if (!entries) fail('unstable', `mixed freeze ${id}: the files kept changing while being snapshotted — another lane is writing them; run again when it has finished`);
  const changed = entries.filter((e) => e.blob !== e.baseBlob || (!e.deleted && e.mode !== e.baseMode));
  if (!changed.length) fail('no-change', `mixed freeze ${id}: none of the files differs from HEAD — there is nothing to verify`);

  ensureStore(info.store);
  const owners = ownersByPath(info.store);
  const ownState = readTicketState(info.store, id);
  const disclosure = { files: [], hunks: [] };
  for (const e of entries) {
    const head = e.baseBlob ? catBlob(info.top, e.baseBlob) : Buffer.alloc(0);
    const d = discloseFile(info, id, e.path, head, e.bytes ?? Buffer.alloc(0), owners, ownState);
    disclosure.files.push(d.file); disclosure.hunks.push(...d.hunks);
  }
  const manifest = {
    ticket: id, mode: 'mixed', base: room.head, roomTree: room.tree, tree: room.tree, deps: [], checks: [],
    files: entries.map(({ bytes, blob, ...e }) => ({ ...e, sha256: e.deleted ? null : putObject(info.store, bytes) })),
    disclosure,
  };
  manifest.hash = candidateHash(manifest);
  manifest.meta = {
    frozenAt: new Date().toISOString(),
    why: why ? [].concat(why) : [],
    ownership: 'none: a mixed-state freeze takes no claim, writes no ticket state and is never refused for ownership',
    unchangedFiles: entries.filter((e) => !changed.includes(e)).map((e) => e.path),
  };
  publishOnce(path.join(info.store, 'cand', `${manifest.hash}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Snapshot the whole working tree (tracked + untracked-not-ignored) in a throwaway index. */
function snapshotTree(top) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-mixed-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const head = gitOut(top, ['rev-parse', 'HEAD']);
    git(top, ['read-tree', head], { env });
    git(top, ['add', '-A'], { env });
    return { head, tree: gitOut(top, ['write-tree'], { env }) };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Materialise a mixed candidate: its room tree must still exist and hold exactly the frozen bytes. */
function materializeMixed(info, m) {
  const t = git(info.top, ['cat-file', '-t', m.roomTree], { allowFail: true });
  if ((t.status ?? 1) !== 0 || String(t.stdout).trim() !== 'tree') fail('base-missing', `mixed candidate ${m.hash.slice(0, 12)}'s room tree ${m.roomTree.slice(0, 12)} is gone (pruned) — freeze it again`);
  for (const f of m.files) {
    const b = blobAt(info.top, m.roomTree, f.path);
    const okF = f.deleted ? !b : !!b && b.mode === f.mode && sha256(catBlob(info.top, b.blob)) === f.sha256;
    if (!okF) fail('tree-mismatch', `mixed candidate ${m.hash.slice(0, 12)}: ${f.path} in the room tree is not the frozen bytes — refusing to verify something other than what was frozen`);
  }
  return { manifest: m, base: m.base, tree: m.roomTree, info };
}

/* ─────────────────────────────────────────── later changes: byte equality */

/** `git diff --no-index -U0` hunks between two buffers (used by the foreign-line metric). */
function lineHunks(a, b) {
  if (Buffer.compare(a, b) === 0) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-cand-diff-'));
  try {
    const pa = path.join(dir, 'a'); const pb = path.join(dir, 'b');
    fs.writeFileSync(pa, a); fs.writeFileSync(pb, b);
    const r = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '-U0', '--text', '--', pa, pb], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) fail('git-failed', `git diff --no-index failed: ${(r.stderr || '').trim()}`);
    const out = [];
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) out.push({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4] });
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
/** Lines changed between two buffers: per hunk, the larger of removed/added. */
const changedLines = (a, b) => lineHunks(a, b).reduce((n, h) => n + Math.max(h.oldLen, h.newLen), 0);

/**
 * Per-file state of a candidate against the live tree and the current HEAD.
 *   CURRENT   live == frozen (bytes and mode; for a deleted file: still absent)
 *   REVERTED  the live file is back to its base (HEAD at freeze) or gone
 *   CHANGED   any other difference from the frozen bytes or mode
 *   staleBase HEAD changed this path since the candidate's base
 * Only CURRENT keeps a verdict valid (the rescoped property: ANY later change to a
 * candidate's files invalidates its verdict). There is no textual "disjoint edit"
 * class any more: round 2's DRIFTED let a file nobody re-verified count as verified.
 */
export function candidateStatus(repo, ref) {
  const info = repoInfo(repo);
  const m = loadCandidate(info.store, resolveRefIn(info, ref));
  const files = [];
  for (const f of m.files) {
    const live = readLive(info.top, f.path);
    const frozen = f.deleted ? null : getObject(info.store, f.sha256);
    const headBase = f.baseBlob ? catBlob(info.top, f.baseBlob) : null;
    const headNow = blobAt(info.top, info.head, f.path);
    const staleBase = info.head !== m.base && ((headNow?.blob ?? null) !== f.baseBlob || (headNow?.mode ?? null) !== f.baseMode);
    const recover = frozen ? `; frozen bytes: ${path.join(info.store, 'objects', f.sha256)}` : '';
    let state; let detail = '';
    if (f.deleted) {
      state = live.exists ? (headBase && Buffer.compare(live.bytes, headBase) === 0 ? 'REVERTED' : 'CHANGED') : 'CURRENT';
      if (live.exists) detail = 'the candidate deletes this file, but it exists again in the working tree';
    } else if (!live.exists) {
      state = 'REVERTED'; detail = `the file is gone from the working tree${recover}`;
    } else if (Buffer.compare(live.bytes, frozen) === 0 && live.mode === f.mode) {
      state = 'CURRENT';
    } else if (headBase && Buffer.compare(live.bytes, headBase) === 0) {
      state = 'REVERTED'; detail = `the live file is byte-identical to its base (HEAD at freeze) — the candidate's change was removed${recover}`;
    } else {
      state = 'CHANGED';
      detail = `${live.mode !== f.mode ? `mode ${f.mode}→${live.mode}; ` : ''}the live file differs from the frozen, verified bytes — the verdict no longer covers it; re-freeze and re-verify${recover}`;
    }
    files.push({ path: f.path, owner: f.owner, state, staleBase, detail });
  }
  return { manifest: m, head: info.head, files };
}

/* ─────────────────────────────────────────────────── verdict binding */

/**
 * A ticket's typed verdicts, through the board's ONE reader (`ticketVerifications`,
 * BUG-225). Loaded lazily so this module works in a project without Orchard's
 * board; `null` means "no verdict source in this project".
 */
async function verdictsFor(top, id) {
  let VS; let BP;
  try {
    VS = await import(pathToFileURL(path.join(HERE, 'verification-source.mjs')).href);
    BP = await import(pathToFileURL(path.join(HERE, 'board-path.mjs')).href);
  } catch { return null; }
  let boardDir = null;
  try { boardDir = BP.resolveBoardDir(top) ?? null; } catch { boardDir = null; }
  if (!boardDir || !fs.existsSync(boardDir)) return null;
  let markdown = '';
  try {
    const name = fs.readdirSync(boardDir).find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
    if (name) markdown = fs.readFileSync(path.join(boardDir, name), 'utf8');
  } catch { /* none */ }
  try { return VS.ticketVerifications(boardDir, { id, markdown }).entries || []; } catch { return null; }
}

/**
 * THE binding rule (one place). Ticket T is satisfied for candidate C iff T's latest
 * verdict bound to C's EXACT hash is HOLDS and no BROKEN for T was recorded after it.
 * No reuse across hashes: a group, a new base, a changed dependency or a changed mode
 * is a different hash and needs its own verdict (2026-10-07 plan review, point 2).
 */
export async function ticketSatisfied(top, C, T) {
  const entries = await verdictsFor(top, T);
  if (entries === null) return { ok: false, reason: `no verdict source in this project — nothing can bind a verification to ${T}'s candidate (ARCH-013)` };
  const sorted = [...entries].sort((a, b) => String(a.recorded_at ?? '').localeCompare(String(b.recorded_at ?? '')));
  const bound = sorted.filter((e) => e.candidate === C.hash);
  const last = bound.at(-1);
  if (!last) return { ok: false, reason: `${T} has no verdict bound to candidate ${C.hash.slice(0, 12)} (independent-verify --ticket ${T} for ${T}'s requirement — it verifies candidate ${C.hash.slice(0, 12)} while current — then board-tool verified --id ${T} … --candidate ${C.hash})` };
  if (last.verdict !== 'holds') return { ok: false, reason: `${T}'s verdict on candidate ${C.hash.slice(0, 12)} is ${String(last.verdict).toUpperCase()} (run ${last.run_id})` };
  const laterBroken = sorted.filter((e) => e.verdict === 'broken' && String(e.recorded_at ?? '') > String(last.recorded_at ?? ''));
  if (laterBroken.length) return { ok: false, reason: `${T} has a BROKEN recorded after its HOLDS (run ${laterBroken.at(-1).run_id})` };
  return { ok: true, run: last.run_id, at: last.recorded_at ?? null };
}

/* ─────────────────────────────────────────────────── integration after a base move */

/** The integration record for (candidate, resulting tree), or null. Write-once, re-checked. */
function integrationFor(store, hash, keyTree) {
  const f = path.join(store, 'integ', `${keyTree}-${hash}.json`);
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (r.hash !== hash || r.keyTree !== keyTree || !r.ok) return null;
    return r;
  } catch { return null; }
}

/** Export a tree into a scratch dir with node_modules reflink-copied from the repo. */
function exportTree(top, tree) {
  const dir = mkdtempScratch('candidate-integrate-');
  const t = spawnSync('sh', ['-c', `git -C ${JSON.stringify(top)} archive ${tree} | tar -x -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if ((t.status ?? 1) !== 0) { fs.rmSync(dir, { recursive: true, force: true }); fail('export-failed', `could not export tree ${tree.slice(0, 12)}: ${t.stderr}`); }
  if (fs.existsSync(path.join(top, 'node_modules'))) spawnSync('cp', ['-a', '--reflink=auto', path.join(top, 'node_modules'), path.join(dir, 'node_modules')]);
  return dir;
}

/**
 * Integration check of the EXACT tree a commit of candidate C would produce on top of
 * `onto` (default: current HEAD, or the tree left by committing `after` candidates
 * first). Runs C's recorded checks there and records the result, keyed by the
 * resulting tree. Agent-runnable: it writes no ref and no real index.
 */
export async function integrateCandidate({ repo, ref, after = [], timeoutMs = 15 * 60_000 }) {
  const info = repoInfo(repo);
  const C = loadCandidate(info.store, resolveRefIn(info, ref));
  if (!C.checks.length) fail('no-checks', `candidate ${C.hash.slice(0, 12)} recorded no checks (freeze --check "<cmd>") — there is nothing to re-run on a moved base; re-freeze with checks`);
  let onto = gitOut(info.top, ['rev-parse', `${info.head}^{tree}`]);
  for (const a of after) onto = buildTree(info.top, info.store, loadCandidate(info.store, resolveRefIn(info, a)), onto);
  for (const f of C.files) {
    const at = blobAt(info.top, onto, f.path);
    if ((at?.blob ?? null) !== f.baseBlob || (at?.mode ?? null) !== f.baseMode) fail('stale-base', `${f.path} changed at HEAD since candidate ${C.hash.slice(0, 12)}'s base — re-freeze ${C.ticket}; an integration check cannot stand in for that`);
  }
  const resultTree = buildTree(info.top, info.store, C, onto);
  const dir = exportTree(info.top, resultTree);
  const results = [];
  try {
    for (const cmd of C.checks) {
      const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ORCHARD_CANDIDATE_INTEGRATION: '1' } });
      const out = (r.stdout || '') + (r.stderr || '');
      results.push({ cmd, exit: r.status ?? (r.signal ? 128 : 1), signal: r.signal ?? null, outSha256: sha256(Buffer.from(out)), tail: out.slice(-2000) });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ok = results.every((r) => r.exit === 0);
  // ROUND 2 (verify 64ff5cb8 #1): keyed on the EXACT resulting tree. The board-dir
  // exemption let a board-only HEAD move reuse a PASS for a tree never checked.
  const keyTree = resultTree;
  const rec = { hash: C.hash, ticket: C.ticket, ontoTree: onto, after, resultTree, keyTree, checks: results, ok, at: new Date().toISOString() };
  ensureStore(info.store);
  if (ok) publishOnce(path.join(info.store, 'integ', `${keyTree}-${C.hash}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

/* ─────────────────────────────────────────────────── readiness */

/** Find a commit in recent history carrying this candidate's trailer (crash reconcile). */
function committedAs(top, hash) {
  const r = git(top, ['log', '-n', '500', `--grep=^${TRAILER}: ${hash}$`, '--format=%H'], { allowFail: true });
  return (String(r.stdout || '').trim().split('\n').find(Boolean)) || null;
}

/**
 * Readiness of one candidate. `ready` = the user may commit it now; `blocking` says
 * why not; `notes` are true-but-harmless facts. The tree a commit would produce is
 * computed here, and it must be either the verified tree (HEAD == base) or a tree
 * with a passing integration record.
 */
export async function readiness(repo, ref) {
  const info = repoInfo(repo);
  const st = candidateStatus(repo, ref);
  const C = st.manifest;
  const blocking = []; const notes = [];
  if (C.mode === 'mixed') {
    // A mixed-state candidate binds a verdict to the ticket's files as they sit in the
    // shared tree, other tickets' hunks included. Its verified room was the whole
    // working tree, so no `candidate commit` of it would publish what was verified.
    return { hash: C.hash, ticket: C.ticket, members: membersOf(C), ready: false, blocking: [`${C.hash.slice(0, 12)} is a MIXED-STATE candidate (verified in the shared tree with other tickets' uncommitted hunks): it binds a verdict, it is not a commit unit — its files are committed together with their co-owners; \`candidate status --candidate ${C.hash.slice(0, 12)}\` shows whether the verdict still covers them`], notes, files: st.files, verdicts: {}, base: C.base, head: info.head, mode: 'mixed' };
  }
  const done = committedAs(info.top, C.hash);
  if (done) return { hash: C.hash, ticket: C.ticket, members: membersOf(C), ready: false, committed: done, blocking: [`already committed as ${done.slice(0, 12)}`], notes, files: st.files, verdicts: {}, base: C.base, head: info.head };
  for (const f of st.files) {
    if (f.state !== 'CURRENT') blocking.push(`${f.path}: ${f.state} — ${f.detail}`);
    if (f.staleBase) blocking.push(`${f.path}: STALE-BASE — HEAD changed this file since the candidate's base ${C.base.slice(0, 12)}; re-freeze and re-verify`);
  }
  for (const d of C.deps) {
    const ds = readTicketState(info.store, d.ticket);
    if (ds.open !== d.hash) blocking.push(`dependency ${d.ticket} was ${ds.state === 'committed' ? 'committed on its own' : 're-frozen or released'} since this group pinned ${d.hash.slice(0, 12)} — re-freeze ${C.ticket}`);
  }
  let resultTree = C.tree;
  if (info.head !== C.base && !st.files.some((f) => f.staleBase)) {
    resultTree = buildTree(info.top, info.store, C, info.head);
    const integ = integrationFor(info.store, C.hash, resultTree);
    if (integ) notes.push(`HEAD moved ${C.base.slice(0, 12)} → ${info.head.slice(0, 12)}; the exact tree this commit makes passed the integration check (${integ.checks.length} check(s), ${integ.at})`);
    else blocking.push(`HEAD moved ${C.base.slice(0, 12)} → ${info.head.slice(0, 12)} since the verified base; the tree this commit would make was never checked — an agent runs: node scripts/candidate.mjs integrate ${C.ticket}`);
  }
  const verdicts = {};
  for (const T of membersOf(C)) {
    const s = await ticketSatisfied(info.top, C, T);
    verdicts[T] = s;
    if (!s.ok) blocking.push(s.reason);
  }
  return { hash: C.hash, ticket: C.ticket, members: membersOf(C), ready: blocking.length === 0, blocking, notes, files: st.files, verdicts, base: C.base, head: info.head, resultTree };
}

/** Mark candidates whose trailer is already in history as committed (crash after publish). */
export function reconcileCommitted(repo) {
  const info = repoInfo(repo);
  const fixed = [];
  withStoreLock(info.store, () => {
    for (const st of allTicketStates(info.store)) {
      if (!st.open) continue;
      const c = committedAs(info.top, st.open);
      if (!c) continue;
      let m; try { m = loadCandidate(info.store, st.open); } catch { continue; }
      for (const T of membersOf(m)) {
        const ts = readTicketState(info.store, T);
        ts.history.push({ event: 'commit-reconciled', hash: m.hash, commit: c, at: new Date().toISOString() });
        if (T === m.ticket || ts.open === m.deps.find((d) => d.ticket === T)?.hash) { ts.open = null; ts.claim = null; ts.state = 'committed'; }
        writeTicketState(info.store, ts);
      }
      fixed.push({ ticket: m.ticket, commit: c });
    }
  });
  return fixed;
}

/* ─────────────────────────────────────────────────────────────── release */

export function releaseTicket({ repo, id, why = null }) {
  const info = repoInfo(repo);
  return withStoreLock(info.store, () => {
    const st = readTicketState(info.store, id);
    st.history.push({ event: 'release', hash: st.open, at: new Date().toISOString(), why });
    st.open = null; st.claim = null; st.state = 'released';
    writeTicketState(info.store, st);
    return st;
  });
}

/* ─────────────────────────────────────────────────────────────── the commit */

function hookPath(top, name) {
  const rel = gitOut(top, ['rev-parse', '--git-path', `hooks/${name}`]);
  const p = path.isAbsolute(rel) ? rel : path.join(top, rel);
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; }
}

/**
 * THE USER'S COMMIT of one ready candidate, published from its FROZEN bytes.
 *   1. readiness (exact verified tree, or an integration-checked tree on a moved HEAD);
 *   2. refuse if the real index has STAGED changes on these paths (they would be lost);
 *   3. throwaway index = HEAD + frozen files, nothing else; its tree must equal the
 *      checked tree (the board file is committed separately, never ridden along);
 *   4. run the repo's pre-commit hook against that index (the leak gate scans STAGED
 *      bytes = exactly what is committed) and commit-msg; refuse if a hook changed the index;
 *   5. commit-tree, then `update-ref HEAD <new> <expected old>` — atomic: if HEAD moved,
 *      nothing is published;
 *   6. sync the real index for these paths only; mark the members committed. A crash
 *      after 5 is reconciled from the `Orchard-Candidate:` trailer.
 *
 * WHO MAY RUN IT: decided by ONE authority, not here (FEAT-170 round 3, rescoped). The
 * env-variable agent check that used to sit at the top was a second, weaker authority:
 * an `env -i` child passed it (measured), and two real lanes scrubbed env for unrelated
 * reasons. It is gone. In an agent session the project's git-write authority (FEAT-135's
 * shim) refuses the publishing calls — `commit-tree` outside a temp index, `update-ref`,
 * `reset` — so nothing is PUBLISHED. The contract is publication, not "refuses agents":
 * steps 1-4 may still run first, and they write only what an agent may write anyway (the
 * candidate store, temp-index objects) plus whatever the repo's own pre-commit/commit-msg
 * hooks do. Residuals are the authority's own (absolute-path git, a scrubbed PATH):
 * FEAT-164 / ARCH-021.
 */
export async function commitCandidate({ repo, ref, message = null }) {
  reconcileCommitted(repo);
  const info = repoInfo(repo);
  const hash = resolveRefIn(info, ref);
  const r = await readiness(repo, hash);
  if (!r.ready) fail('not-ready', `candidate ${hash.slice(0, 12)} (${r.members.join(' + ')}) is not ready to commit`, r.blocking);
  const C = loadCandidate(info.store, hash);
  const head = info.head;
  // Exactly the candidate's paths. Round 4 (verify 248ad5f9 #1) deleted the ticket-file
  // ride-along: it staged the board file's LIVE bytes after the tree check, so the
  // published tree was not the verified one. The board is committed separately.
  const allPaths = C.files.map((f) => f.path);
  const verified = Object.entries(r.verdicts).map(([t, v]) => `${t} run ${v.run}`).join('; ');
  const res = publishFrozenTree({
    repo, head, paths: allPaths, hashes: [C.hash], event: 'commit', reflog: `candidate commit ${C.ticket}`,
    buildTree: () => {
      const codeTree = buildTree(info.top, info.store, C, head);
      if (codeTree !== r.resultTree) fail('tree-mismatch', `the tree this commit makes (${codeTree.slice(0, 12)}) is not the checked one (${String(r.resultTree).slice(0, 12)}) — nothing committed`);
      return codeTree;
    },
    message: `${message || `${r.members.join(', ')}: commit frozen candidate ${C.hash.slice(0, 12)}`}\n\nVerified: ${verified}.\n\n${TRAILER}: ${C.hash}\n`,
    trailers: [`${TRAILER}: ${C.hash}`],
  });
  return { commit: res.commit, parent: head, tree: res.tree, paths: allPaths, members: r.members, notes: r.notes, stillDirty: res.stillDirty };
}

/**
 * THE PUBLISHER of frozen bytes into a real repo — one for `candidate commit` (one
 * candidate) and FEAT-164's release cut (a batch + a version tag), so there is ONE
 * publication path (FEAT-164 plan review #3):
 *   1. HEAD must still be `head`; refuse if the real index has STAGED changes on `paths`;
 *   2. throwaway index = `buildTree()` (HEAD + frozen bytes, nothing else); its tree is
 *      re-read and must equal what was built;
 *   3. the repo's pre-commit hook (the leak gate scans the STAGED bytes = exactly what is
 *      committed) and commit-msg; refuse if a hook changed the index;
 *   4. commit-tree (and, for a release, mktag); then ONE `update-ref --stdin`
 *      transaction: HEAD <new> <expected old> [+ create refs/tags/<tag>] — both or
 *      neither; if HEAD moved, nothing is published;
 *   5. sync the real index for `paths` only; post-commit; mark the candidates committed.
 * WHO MAY RUN IT is the project's git-write authority's decision (see commitCandidate).
 */
export function publishFrozenTree({ repo, head, paths, buildTree: build, message, trailers = [], tag = null, hashes = [], event = 'commit', reflog = 'orchard publish' }) {
  const info = repoInfo(repo);
  if (info.head !== head) fail('head-moved', `HEAD moved (expected ${head.slice(0, 12)}, now ${info.head.slice(0, 12)}) — nothing was published; run the command again`);
  // 1. Staged state on these paths would be discarded by the index sync: refuse.
  const staged = [];
  for (const p of paths) {
    const idx = String(git(info.top, ['ls-files', '-s', '-z', '--', `:(literal)${p}`]).stdout).split('\0').find(Boolean);
    const idxBlob = idx ? /^\d+ ([0-9a-f]+) /.exec(idx)?.[1] ?? null : null;
    const hd = blobAt(info.top, head, p);
    if ((idxBlob ?? null) !== (hd?.blob ?? null)) staged.push(p);
  }
  if (staged.length) fail('staged-conflict', `you have staged (git add-ed) changes on ${staged.length} file(s) this commit writes; committing would drop them from the staging area`, [
    ...staged.map((p) => `  ${p}`),
    `Unstage them first (your files are kept): git restore --staged -- ${staged.join(' ')}`,
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-candidate-commit-'));
  const idxFile = path.join(tmpDir, 'index');
  const ienv = { GIT_INDEX_FILE: idxFile };
  try {
    const built = build();
    git(info.top, ['read-tree', built], { env: ienv });
    const tree = gitOut(info.top, ['write-tree'], { env: ienv });
    if (tree !== built) fail('tree-mismatch', `the staged tree (${tree.slice(0, 12)}) is not the checked one (${String(built).slice(0, 12)}) — nothing committed`);
    if (tree === gitOut(info.top, ['rev-parse', `${head}^{tree}`])) fail('nothing-to-commit', 'the candidate is identical to HEAD — already committed?');

    const msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, message);
    const hookEnv = { ...process.env, ...ienv, GIT_EDITOR: ':' };
    for (const [name, args] of [['pre-commit', []], ['commit-msg', [msgFile]]]) {
      const h = hookPath(info.top, name);
      if (!h) continue;
      const hr = spawnSync(h, args, { cwd: info.top, env: hookEnv, stdio: ['ignore', 2, 'inherit'] });
      if ((hr.status ?? 1) !== 0) fail('hook-refused', `the repository's ${name} hook refused this commit (exit ${hr.status}) — nothing was committed`);
    }
    if (gitOut(info.top, ['write-tree'], { env: ienv }) !== tree) fail('hook-changed-index', 'a hook changed the staged content — refusing to commit bytes other than the verified ones; nothing was committed');
    let msg = fs.readFileSync(msgFile, 'utf8');
    for (const t of trailers) if (!msg.includes(t)) msg += `${msg.endsWith('\n') ? '' : '\n'}${t}\n`;
    const newCommit = gitOut(info.top, ['commit-tree', tree, '-p', head, '-F', '-'], { input: msg });
    let tagObj = null;
    if (tag) {
      const ident = gitOut(info.top, ['var', 'GIT_COMMITTER_IDENT']);
      tagObj = gitOut(info.top, ['mktag'], { input: `object ${newCommit}\ntype commit\ntag ${tag.name}\ntagger ${ident}\n\n${tag.message ?? msg}` });
    }
    const tx = `update HEAD ${newCommit} ${head}\n${tag ? `create refs/tags/${tag.name} ${tagObj}\n` : ''}`;
    const upd = git(info.top, ['update-ref', '-m', reflog, '--stdin'], { input: tx, allowFail: true });
    if ((upd.status ?? 1) !== 0) {
      const now = String(git(info.top, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).stdout || '').trim();
      if (now === head) fail('publish-refused', `update-ref was refused, so nothing was published (the git-write authority, or git itself): ${String(upd.stderr || '').trim().split('\n')[0] || `exit ${upd.status}`}`);
      fail('head-moved', `HEAD moved while committing (expected ${head.slice(0, 12)}) — nothing was published; run the command again`);
    }
    // Published. Sync only these paths in the real index; then the store.
    git(info.top, ['reset', '-q', newCommit, '--', ...paths.map((p) => `:(literal)${p}`)], { allowFail: true });
    const post = hookPath(info.top, 'post-commit');
    if (post) spawnSync(post, [], { cwd: info.top, stdio: ['ignore', 2, 'inherit'] });
    if (hashes.length) markCandidatesCommitted(repo, hashes, newCommit, event);
    const stillDirty = paths.filter((p) => {
      const l = readLive(info.top, p); const b = blobAt(info.top, newCommit, p);
      return l.exists ? !b || gitBlobOf(info.top, l.bytes) !== b.blob : !!b;
    });
    return { commit: newCommit, parent: head, tree, tag: tagObj, paths, stillDirty };
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

/* ───────────── the revisit trigger: HARM from foreign lines that shipped under the wrong ticket */

const linesOf = (buf) => buf.toString('utf8').split('\n');
/** Lines added / removed between two buffers (from -U0 hunks). */
function lineDelta(a, b) {
  const A = linesOf(a); const B = linesOf(b); const added = []; const removed = [];
  for (const h of lineHunks(a, b)) {
    if (h.newLen) added.push(...B.slice(h.newStart - 1, h.newStart - 1 + h.newLen));
    if (h.oldLen) removed.push(...A.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLen));
  }
  return { added, removed };
}
/** Lines are matched by exact text; short or punctuation-only lines (`}`, `});`) are too common to attribute. */
const meaningful = (t) => t.trim().length >= 6 && /[A-Za-z0-9]/.test(t);
const baseOf = (top, f) => (f.baseBlob ? catBlob(top, f.baseBlob) : Buffer.alloc(0));
const frozenOf = (store, f) => (f.deleted ? Buffer.alloc(0) : getObject(store, f.sha256));

/**
 * Record foreign lines someone FOUND in a ticket's candidate, and WHOSE they are.
 * Typically the verifier spots another ticket's lines in the candidate's diff and the
 * orchestrator records them (exact line text, so a later harm can be matched). The
 * owner is what lets the metric tell harm from a harmless ride-along. Append-only
 * JSONL in the store; a metric, not part of any candidate's identity.
 */
export function recordForeignFound({ repo, id, file, owner, lines, note = null, by = null }) {
  if (!TICKET_RE.test(String(id))) fail('bad-id', `${id} is not a ticket id`);
  if (!TICKET_RE.test(String(owner)) || owner === id) fail('bad-id', `--owner ${owner} must be the OTHER ticket the lines belong to`);
  const texts = (lines || []).filter((t) => typeof t === 'string' && t.length);
  if (!texts.length) fail('missing-arg', 'foreign-found: give each foreign line\'s exact text with --line "<text>" (repeatable)');
  const info = repoInfo(repo);
  const rel = repoRel(info.top, file);
  const rec = { ticket: id, file: rel, owner, lines: texts, note, by, at: new Date().toISOString() };
  ensureStore(info.store);
  fs.appendFileSync(path.join(info.store, 'foreign-found.jsonl'), `${JSON.stringify(rec)}\n`);
  return rec;
}

function readForeignFound(store) {
  try {
    return fs.readFileSync(path.join(store, 'foreign-found.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && TICKET_RE.test(String(r.owner)) && Array.isArray(r.lines));
  } catch { return []; }
}
function allCandidates(store) {
  let names = [];
  try { names = fs.readdirSync(path.join(store, 'cand')).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push(loadCandidate(store, n.slice(0, 64))); } catch { /* unprovable: skipped */ } }
  return out;
}

/**
 * The revisit-trigger metric (FEAT-170, harm-based). A foreign line that rides along is
 * the ACCEPTED residual; it counts toward the trigger only when it did harm:
 *
 *   a COMMITTED foreign line (in a ticket's committed candidate, belonging to another
 *   ticket B) counts when B, after that commit,
 *     - gets a BROKEN verdict bound to a candidate whose change touches that line, or
 *     - changes or removes that line in a candidate it freezes
 *   i.e. unverified or half-done work that actually shipped under the wrong ticket.
 *   Only the OWNER's own recorded events count. Live-file state never does (round 4,
 *   verify 248ad5f9 #2): a line vanishing from the tree may be a third lane's edit,
 *   and counting it raised a false trigger against an innocent ticket.
 *
 * WHOSE a line is: an explicit `foreign-found --owner B`, else another ticket whose
 * candidate frozen before the commit added that exact line in that file. A foreign line
 * with no known owner is reported (`unowned`) but cannot count as harm; recording its
 * owner is how it becomes countable. Lines are matched by exact text (short or
 * punctuation-only lines are ignored).
 *
 * Informational, NOT the trigger: lines taken in with --accept-foreign (`accepted`:
 * already differing from HEAD at claim; `unattributed`: a never-claimed file's whole
 * change), one row per ticket's latest freeze in the window, and lines `reported`.
 * The window (default 30 days) applies to when the harm became visible.
 */
export async function foreignReport({ repo, days = 30, now = Date.now() }) {
  const info = repoInfo(repo);
  const since = new Date(now - days * 86_400_000).toISOString();
  // A mixed-state candidate's frozen bytes hold OTHER tickets' lines by design, so it is
  // never a source of line ownership (it would attribute B's lines to the verifier's ticket).
  const cands = allCandidates(info.store).filter((m) => m.mode !== 'mixed');
  const found = readForeignFound(info.store);

  // ── informational: what --accept-foreign took in (latest freeze per ticket in the window)
  const latest = new Map();
  for (const m of cands) {
    const at = String(m.meta?.frozenAt ?? '');
    if (at < since) continue;
    const prev = latest.get(m.ticket);
    if (!prev || at > String(prev.meta?.frozenAt ?? '')) latest.set(m.ticket, m);
  }
  const raw = { accepted: 0, unattributed: 0, reported: 0 };
  for (const m of latest.values()) {
    for (const p of m.meta?.acceptedForeign || []) {
      const f = m.files.find((x) => x.path === p && x.owner === m.ticket);
      if (!f) continue;
      const claimSha = m.meta?.claims?.[p];
      if (claimSha) raw.accepted += changedLines(baseOf(info.top, f), getObject(info.store, claimSha));
      else raw.unattributed += changedLines(baseOf(info.top, f), frozenOf(info.store, f));
    }
  }
  for (const r of found) if (String(r.at) >= since) raw.reported += r.lines.length;

  // ── harm: committed foreign lines whose owner later broke or changed them
  const verdictCache = new Map();
  const verdicts = async (T) => { if (!verdictCache.has(T)) verdictCache.set(T, (await verdictsFor(info.top, T)) || []); return verdictCache.get(T); };
  const commitsOf = (T) => readTicketState(info.store, T).history.filter((e) => e.event === 'commit' || e.event === 'commit-reconciled');
  const seen = new Set(); const harms = []; let committedForeign = 0; let unowned = 0;
  for (const st of allTicketStates(info.store)) {
    for (const ev of commitsOf(st.id)) {
      if (seen.has(ev.hash)) continue; seen.add(ev.hash);
      let C; try { C = loadCandidate(info.store, ev.hash); } catch { continue; }
      const members = new Set(membersOf(C)); const T0 = String(ev.at);
      for (const f of C.files.filter((x) => x.owner === C.ticket)) {
        const committed = new Set(linesOf(frozenOf(info.store, f)));
        const owners = new Map(); // line text -> owner ticket
        if ((C.meta?.acceptedForeign || []).includes(f.path)) {
          const claimSha = C.meta?.claims?.[f.path];
          const pool = lineDelta(baseOf(info.top, f), claimSha ? getObject(info.store, claimSha) : frozenOf(info.store, f)).added;
          for (const t of pool) if (meaningful(t) && committed.has(t)) owners.set(t, null);
        }
        for (const r of found) if (members.has(r.ticket) && r.file === f.path && !members.has(r.owner)) for (const t of r.lines) if (committed.has(t)) owners.set(t, r.owner);
        for (const [t, o] of owners) {
          if (o) continue;
          const by = cands.filter((D) => !members.has(D.ticket) && String(D.meta?.frozenAt) < T0)
            .sort((a, b) => String(a.meta?.frozenAt).localeCompare(String(b.meta?.frozenAt)))
            .find((D) => D.files.some((g) => g.path === f.path && g.owner === D.ticket && lineDelta(baseOf(info.top, g), frozenOf(info.store, g)).added.includes(t)));
          if (by) owners.set(t, by.ticket);
        }
        for (const [t, B] of owners) {
          committedForeign++;
          if (!B) { unowned++; continue; }
          const events = [];
          for (const v of await verdicts(B)) {
            if (v.verdict !== 'broken' || String(v.recorded_at ?? '') <= T0 || !v.candidate) continue;
            let E; try { E = loadCandidate(info.store, v.candidate); } catch { continue; }
            const g = E.files.find((x) => x.path === f.path);
            if (!g) continue;
            const d = lineDelta(baseOf(info.top, g), frozenOf(info.store, g));
            if (d.added.includes(t) || d.removed.includes(t)) events.push({ kind: 'broken', at: String(v.recorded_at), run: v.run_id ?? null });
          }
          for (const E of cands.filter((x) => x.ticket === B && String(x.meta?.frozenAt) > T0)) {
            const g = E.files.find((x) => x.path === f.path && x.owner === B);
            if (g && lineDelta(baseOf(info.top, g), frozenOf(info.store, g)).removed.includes(t)) events.push({ kind: 'changed', at: String(E.meta.frozenAt), hash: E.hash });
          }
          const hit = events.filter((e) => e.at >= since).sort((a, b) => a.at.localeCompare(b.at))[0];
          if (hit) harms.push({ ticket: C.ticket, commit: ev.commit ?? null, hash: C.hash, file: f.path, owner: B, line: t, ...hit });
        }
      }
    }
  }
  return { days, since, harm: harms.length, harms, committedForeign, unowned, informational: raw, triggered: harms.length >= 1 };
}
