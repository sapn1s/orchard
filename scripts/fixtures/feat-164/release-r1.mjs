/**
 * release.mjs — FEAT-164 (2026-10-11): SOFT RELEASES. The one publisher of agent work
 * into a project's real repo when the user granted agent commits WITHOUT a scope note
 * (agent-git-policy.mjs mode 'release'), and the user's one-command batch promotion in
 * any mode.
 *
 * A release is ONE commit + ONE annotated version tag that carries a coherent batch of
 * finished, VERIFIED tickets — never one commit per fix:
 *   - eligible = an open FEAT-170 candidate whose files are all CURRENT (live = frozen),
 *     not STALE-BASE, whose every member has a HOLDS bound to its exact hash with no
 *     later BROKEN (`ticketSatisfied`), and whose dependencies are in the same batch or
 *     already committed. Two unrelated candidates on one path: the later is excluded.
 *   - due (cadence, DEFAULT_RELEASE, adjustable per project): ≥1 eligible ticket, ≥
 *     minIntervalHours since the last release, and (≥ minTickets eligible tickets OR the
 *     oldest has waited ≥ maxWaitHours). The user's `--now` skips ONLY the cadence.
 *   - checked: the EXACT release tree (HEAD + every member's frozen bytes) is checked
 *     out in a throwaway shared clone and the project's release checks (default
 *     `npm run gate` when package.json has one) plus every member's recorded --check run
 *     there. Any failure → nothing is published. Zero checks → refused.
 *   - published atomically: the repo's pre-commit + commit-msg hooks run on a temp
 *     index holding exactly that tree; commit-tree; mktag; then ONE `update-ref --stdin`
 *     transaction moves HEAD (expected old value) AND creates the tag — both or neither.
 *   - pushed only at a release, only when push is granted (or the user passes --push):
 *     `git push --atomic <remote> <commit>:<upstream ref> <tag>`. A failed push leaves
 *     the release local (pushed:false) and `push` retries it.
 *
 * WHO MAY RUN IT is decided by the project's git-write authority, not here: in an agent
 * session the shim refuses the real-repo `update-ref` (release mode / no grant). The
 * station runs it OUTSIDE any shim, and only under a commit grant (`trigger` agent/auto
 * refuse mode none). The user's terminal may always run it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as CS from './candidate-store.mjs';
import { normalizeGitWrite } from './agent-git-policy.mjs';
import { mkdtempScratch } from './scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_TRAILER = 'Orchard-Release';

export class ReleaseError extends Error {
  constructor(code, message, detail = []) { super(message); this.code = code; this.detail = detail; }
}
const fail = (code, message, detail = []) => { throw new ReleaseError(code, message, detail); };

/* ───────────────────────────────────────────────────────────── git helpers */

/** Env for git calls on the real repo: no inherited redirect can retarget them. */
function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/.test(k)) env[k] = v;
  return { ...env, ...extra };
}
function git(cwd, args, { env = null, input = null, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv(env || {}), input: input ?? undefined, maxBuffer: 256 * 1024 * 1024 });
  if ((r.status ?? 1) !== 0 && !allowFail) fail('git-failed', `git ${args[0]} failed: ${String(r.stderr || '').trim() || `exit ${r.status}`}`);
  return r;
}
const gitOut = (cwd, args, o) => String(git(cwd, args, o).stdout).trim();

/* ───────────────────────────────────────────────────────────── the log */

export function releaseDir(info) { return path.join(info.commonDir, 'orchard-releases'); }
const logFile = (info) => path.join(releaseDir(info), 'log.jsonl');

export function readReleaseLog(info) {
  let txt = '';
  try { txt = fs.readFileSync(logFile(info), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn tail line: ignore */ } }
  return out;
}
function appendLog(info, rec) {
  fs.mkdirSync(releaseDir(info), { recursive: true });
  fs.appendFileSync(logFile(info), JSON.stringify(rec) + '\n');
}
/** The latest published release (log), cross-checked against history. */
export function lastRelease(info) {
  const log = readReleaseLog(info).filter((r) => r.event === 'release');
  return log.at(-1) ?? null;
}
/** Releases whose push has not succeeded yet (latest first). */
export function unpushedReleases(info) {
  const log = readReleaseLog(info);
  const pushed = new Set(log.filter((r) => r.event === 'push' && r.ok).map((r) => r.commit));
  return log.filter((r) => r.event === 'release' && !pushed.has(r.commit)).reverse();
}

/* ───────────────────────────────────────────────────────────── the lock */

function withReleaseLock(info, fn) {
  fs.mkdirSync(releaseDir(info), { recursive: true });
  const lock = path.join(releaseDir(info), 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const l = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (l.host === os.hostname()) { try { process.kill(l.pid, 0); } catch (err) { stale = err.code !== 'EPERM'; } }
      } catch { stale = false; }
      if (!stale || attempt) fail('busy', 'another release is being cut for this repo right now — try again when it finishes');
      try { fs.rmSync(lock, { force: true }); } catch { /* raced */ }
    }
  }
  const done = () => { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } };
  let p;
  try { p = fn(); } catch (e) { done(); throw e; }
  return Promise.resolve(p).finally(done);
}

/* ───────────────────────────────────────────────────────────── board titles */

async function ticketTitle(top, id) {
  try {
    const BP = await import(pathToFileURL(path.join(HERE, 'board-path.mjs')).href);
    const dir = BP.resolveBoardDir(top);
    if (!dir) return null;
    const name = fs.readdirSync(dir).find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
    if (!name) return null;
    const md = fs.readFileSync(path.join(dir, name), 'utf8');
    const m = /```orchard-ticket\n([\s\S]*?)\n```/.exec(md);
    if (m) { try { const t = JSON.parse(m[1]).title; if (typeof t === 'string' && t.trim()) return t.trim(); } catch { /* fall through */ } }
    const h = new RegExp(`^# ${id}\\s*[—-]\\s*(.+)$`, 'm').exec(md);
    return h ? h[1].trim() : null;
  } catch { return null; }
}

/* ───────────────────────────────────────────────────────────── versions */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Latest `<prefix>X.Y.Z` tag reachable from HEAD, as [x,y,z] (or null), and the next one. */
export function nextVersion(top, prefix, tickets) {
  const re = new RegExp(`^${esc(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`);
  const names = String(git(top, ['for-each-ref', '--merged', 'HEAD', '--format=%(refname:strip=2)', 'refs/tags/'], { allowFail: true }).stdout || '').split('\n').filter(Boolean);
  let best = null;
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;
    const v = [+m[1], +m[2], +m[3]];
    if (!best || v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  }
  let next;
  if (!best) next = [0, 1, 0];
  else if (tickets.some((t) => t.startsWith('FEAT-') || t.startsWith('ARCH-'))) next = [best[0], best[1] + 1, 0];
  else next = [best[0], best[1], best[2] + 1];
  const exists = (v) => (git(top, ['rev-parse', '--verify', '--quiet', `refs/tags/${prefix}${v.join('.')}`], { allowFail: true }).status ?? 1) === 0;
  while (exists(next)) next = [next[0], next[1], next[2] + 1];
  return { previous: best ? `${prefix}${best.join('.')}` : null, version: `${prefix}${next.join('.')}` };
}

/* ───────────────────────────────────────────────────────────── the plan */

const hoursBetween = (a, b) => (b - a) / 3_600_000;

/**
 * What a release would contain right now, and whether it is due. Read-only apart from
 * FEAT-170's own crash reconcile (store bookkeeping, never a ref).
 */
export async function planRelease({ repo, policy = null, now = Date.now() }) {
  const pol = policy ?? normalizeGitWrite(null);
  CS.reconcileCommitted(repo);
  const info = CS.repoInfo(repo);
  const rows = [];
  for (const st of CS.allTicketStates(info.store)) {
    if (!st.open) continue;
    let C;
    try { C = CS.loadCandidate(info.store, st.open); }
    catch (e) { rows.push({ ticket: st.id, hash: st.open, C: null, reasons: [`candidate unreadable: ${e.message}`] }); continue; }
    if (C.ticket !== st.id) continue;
    const reasons = [];
    const status = CS.candidateStatus(repo, C.hash);
    for (const f of status.files) {
      if (f.state !== 'CURRENT') reasons.push(`${f.path}: ${f.state} — ${f.detail}`);
      if (f.staleBase) reasons.push(`${f.path}: STALE-BASE — HEAD changed it since the candidate's base; re-freeze and re-verify`);
    }
    const verdicts = {};
    let readyAt = String(C.meta?.frozenAt ?? '');
    for (const T of CS.membersOf(C)) {
      const s = await CS.ticketSatisfied(info.top, C, T);
      verdicts[T] = s;
      if (!s.ok) reasons.push(s.reason);
      else if (s.at && String(s.at) > readyAt) readyAt = String(s.at);
    }
    rows.push({ ticket: C.ticket, hash: C.hash, C, reasons, verdicts, readyAt, frozenAt: String(C.meta?.frozenAt ?? '') });
  }
  // Dependencies + path collisions, to a fixpoint (an exclusion can exclude its dependents).
  const byHash = new Map(rows.filter((r) => r.C).map((r) => [r.hash, r]));
  const related = (a, b) => a.C.deps.some((d) => d.hash === b.hash) || b.C.deps.some((d) => d.hash === a.hash);
  const committedBefore = (d) => CS.readTicketState(info.store, d.ticket).history.some((h) => ['commit', 'release', 'commit-reconciled'].includes(h.event) && h.hash === d.hash);
  let changed = true;
  while (changed) {
    changed = false;
    const ok = rows.filter((r) => r.C && !r.reasons.length).sort((a, b) => a.frozenAt.localeCompare(b.frozenAt));
    for (const r of ok) {
      for (const d of r.C.deps) {
        const inBatch = byHash.get(d.hash);
        if (inBatch && !inBatch.reasons.length) continue;
        if (committedBefore(d)) continue;
        r.reasons.push(`dependency ${d.ticket} (candidate ${d.hash.slice(0, 12)}) is not releasable with it`); changed = true; break;
      }
    }
    if (changed) continue;
    const owner = new Map();
    for (const r of ok) {
      const clash = r.C.files.map((f) => [f.path, owner.get(f.path)]).find(([, o]) => o && !related(o, r));
      if (clash) { r.reasons.push(`${clash[0]} is also in ${clash[1].ticket}'s candidate and the two are not dependency-linked — freeze one with --depends-on the other`); changed = true; break; }
      for (const f of r.C.files) owner.set(f.path, r);
    }
  }
  const eligible = rows.filter((r) => r.C && !r.reasons.length).sort((a, b) => a.frozenAt.localeCompare(b.frozenAt));
  const excluded = rows.filter((r) => r.reasons.length).map((r) => ({ ticket: r.ticket, hash: r.hash, reasons: r.reasons }));
  const tickets = [...new Set(eligible.flatMap((r) => CS.membersOf(r.C)))];
  const last = lastRelease(info);
  const rel = pol.release;
  const sinceLast = last ? hoursBetween(Date.parse(last.at), now) : Infinity;
  const oldest = eligible.length ? Math.min(...eligible.map((r) => Date.parse(r.readyAt) || now)) : null;
  const waited = oldest === null ? 0 : hoursBetween(oldest, now);
  let due = false; let why;
  if (!tickets.length) why = 'no eligible ticket (a ticket needs a frozen candidate, CURRENT files and an independent HOLDS bound to it)';
  else if (sinceLast < rel.minIntervalHours) why = `the last release was ${sinceLast.toFixed(1)} h ago (at most one per ${rel.minIntervalHours} h)`;
  else if (tickets.length >= rel.minTickets) { due = true; why = `${tickets.length} eligible ticket(s) ≥ ${rel.minTickets}`; }
  else if (waited >= rel.maxWaitHours) { due = true; why = `the oldest eligible ticket has waited ${waited.toFixed(1)} h ≥ ${rel.maxWaitHours} h`; }
  else why = `${tickets.length} eligible ticket(s) < ${rel.minTickets}, oldest waited ${waited.toFixed(1)} h < ${rel.maxWaitHours} h`;
  const ver = nextVersion(info.top, rel.tagPrefix, tickets);
  return {
    top: info.top, head: info.head, mode: pol.mode,
    eligible: eligible.map((r) => ({ ticket: r.ticket, hash: r.hash, members: CS.membersOf(r.C), readyAt: r.readyAt, runs: Object.fromEntries(Object.entries(r.verdicts).map(([t, v]) => [t, v.run])) })),
    excluded,
    tickets,
    cadence: { due, why, tickets: tickets.length, oldestWaitHours: Number(waited.toFixed(2)), hoursSinceLast: Number.isFinite(sinceLast) ? Number(sinceLast.toFixed(2)) : null, ...rel },
    nextVersion: ver.version,
    previousVersion: ver.previous,
    last,
    _rows: eligible,
  };
}

/* ───────────────────────────────────────────────────────────── checks */

/** The checks a release tree must pass: the project's, else `npm run gate` if present; plus every member's own. */
export function releaseChecks(top, policy, rows) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  if (policy.release.checks) policy.release.checks.forEach(add);
  else {
    try { const pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')); if (pkg?.scripts?.gate) add('npm run gate'); } catch { /* no package.json */ }
  }
  for (const r of rows) for (const c of r.C.checks || []) add(c);
  return out;
}

/**
 * Check out EXACTLY `tree` in a throwaway shared clone (a real repo, so gates that ask
 * git work; HEAD = the real HEAD, so the release delta is the staged diff), run every
 * check there, and remove it. The clone's remote is deleted, so no check can push
 * through it.
 */
export function runReleaseChecks(info, tree, checks, { timeoutMs = 30 * 60_000 } = {}) {
  const dir = mkdtempScratch('release-check-');
  const wt = path.join(dir, 'repo');
  const results = [];
  try {
    git(dir, ['clone', '--quiet', '--no-checkout', '--shared', info.top, wt]);
    git(wt, ['remote', 'remove', 'origin'], { allowFail: true });
    git(wt, ['read-tree', '-u', '--reset', tree]);
    if (fs.existsSync(path.join(info.top, 'node_modules'))) spawnSync('cp', ['-a', '--reflink=auto', path.join(info.top, 'node_modules'), path.join(wt, 'node_modules')]);
    const env = cleanGitEnv({ ORCHARD_RELEASE_CHECK: '1' });
    for (const cmd of checks) {
      const t0 = Date.now();
      const r = spawnSync('sh', ['-c', cmd], { cwd: wt, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 256 * 1024 * 1024 });
      const out = (r.stdout || '') + (r.stderr || '');
      results.push({ cmd, exit: r.status ?? (r.signal ? 128 : 1), signal: r.signal ?? null, ms: Date.now() - t0, tail: out.slice(-1500) });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return results;
}

/* ───────────────────────────────────────────────────────────── the cut */


async function releaseMessage(top, version, rows) {
  const tickets = [...new Set(rows.flatMap((r) => CS.membersOf(r.C)))];
  const lines = [`Release ${version}: ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`, ''];
  for (const r of rows) {
    for (const T of CS.membersOf(r.C)) {
      const title = await ticketTitle(top, T);
      lines.push(`- ${T}${title ? ` ${title}` : ''} (verified run ${r.verdicts[T]?.run ?? '?'}, candidate ${r.hash.slice(0, 12)})`);
    }
  }
  lines.push('', `${RELEASE_TRAILER}: ${version}`);
  for (const r of rows) lines.push(`${CS.TRAILER}: ${r.hash}`);
  return lines.join('\n') + '\n';
}

/** HEAD's tree + every row's frozen bytes, in order (dependencies were frozen first). */
function batchTree(info, rows) {
  let tree = gitOut(info.top, ['rev-parse', `${info.head}^{tree}`]);
  for (const r of rows) tree = CS.buildCandidateTree(info.top, info.store, r.C, tree);
  return tree;
}

/** Drop the most recently verified row and every row that depends on it (transitively). */
function dropNewest(rows) {
  const newest = [...rows].sort((a, b) => b.readyAt.localeCompare(a.readyAt))[0];
  const gone = new Set([newest.hash]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!gone.has(r.hash) && r.C.deps.some((d) => gone.has(d.hash))) { gone.add(r.hash); grew = true; }
  }
  return { rows: rows.filter((r) => !gone.has(r.hash)), dropped: rows.filter((r) => gone.has(r.hash)).map((r) => r.ticket) };
}

/** How many times a failing batch is retried without its newest member (plan review #4). */
export const SUBSET_RETRIES = 2;

/**
 * Cut a release. `trigger`: 'user' (a terminal: any mode; `now` skips the cadence),
 * 'agent' (an agent asked the station: needs a commit grant, cadence enforced) or
 * 'auto' (the station's tick: release mode only, cadence enforced, a tree that already
 * failed is not retried). `push`: null = as granted; true/false = the USER's override.
 */
export async function cutRelease({ repo, policy = null, trigger = 'user', now = false, push = null, dryRun = false, checkTimeoutMs = 30 * 60_000, clock = Date.now } = {}) {
  const pol = policy ?? normalizeGitWrite(null);
  if (!['user', 'agent', 'auto'].includes(trigger)) fail('bad-trigger', `trigger must be user, agent or auto (got ${trigger})`);
  if (trigger !== 'user' && pol.mode === 'none') fail('not-granted', 'agent commits are not granted for this project (the default), so nothing is released. The user can grant them in Settings → Agent git.');
  if (trigger === 'auto' && pol.mode !== 'release') return { released: false, reason: `automatic releases run only in release mode (this project is ${pol.mode})` };
  const force = now === true && trigger === 'user';
  const info = CS.repoInfo(repo);
  return withReleaseLock(info, async () => {
    const plan = await planRelease({ repo, policy: pol, now: clock() });
    if (!plan.tickets.length) return { released: false, reason: plan.cadence.why, plan: strip(plan) };
    if (!force && !plan.cadence.due) return { released: false, reason: `not due yet: ${plan.cadence.why}`, plan: strip(plan) };
    let rows = plan._rows;
    let tree = batchTree(info, rows);
    if (tree === gitOut(info.top, ['rev-parse', `${info.head}^{tree}`])) fail('nothing-to-commit', 'the eligible candidates are already identical to HEAD');
    if (trigger === 'auto' && readReleaseLog(info).some((e) => e.event === 'refused' && e.tree === tree)) {
      return { released: false, reason: `this exact release tree (${tree.slice(0, 12)}) already failed its checks; waiting for the batch to change`, plan: strip(plan) };
    }
    if (!releaseChecks(info.top, pol, rows).length) fail('no-checks', 'no release checks: set Settings → Agent git → release checks (or a `gate` npm script), or freeze candidates with --check — a release is never published unchecked');
    if (dryRun) return { released: false, dryRun: true, version: plan.nextVersion, tree, checks: releaseChecks(info.top, pol, rows), plan: strip(plan) };

    // The gate and tests on the EXACT tree that will be committed. A failing batch is
    // retried without its most recently verified member (and its dependents), so one bad
    // ticket cannot block every other verified ticket forever (plan review #4).
    const attempts = [];
    const cutId = `${Date.now().toString(36)}-${process.pid}`;
    let results;
    for (let attempt = 0; ; attempt++) {
      const checks = releaseChecks(info.top, pol, rows);
      results = runReleaseChecks(info, tree, checks, { timeoutMs: checkTimeoutMs });
      const failed = results.filter((r) => r.exit !== 0);
      const tickets = [...new Set(rows.flatMap((r) => CS.membersOf(r.C)))];
      attempts.push({ tickets, tree, failed: failed.map((r) => r.cmd) });
      if (!failed.length) break;
      appendLog(info, { event: 'refused', cutId, reason: 'checks-failed', tree, tickets, hashes: rows.map((r) => r.hash), trigger, at: new Date(clock()).toISOString(), checks: results.map(({ cmd, exit }) => ({ cmd, exit })) });
      if (attempt >= SUBSET_RETRIES || rows.length <= 1) {
        fail('checks-failed', `release refused: the checks failed on the exact release tree${attempts.length > 1 ? ` (and on ${attempts.length - 1} smaller batch(es) without the newest ticket)` : ''} — nothing was committed`,
          [...attempts.map((a) => `  attempt ${a.tickets.join(', ')}: ✗ ${a.failed.join('; ')}`), ...failed.map((r) => `  ✗ ${r.cmd} (exit ${r.exit})\n${r.tail.split('\n').slice(-8).map((l) => `      ${l}`).join('\n')}`)]);
      }
      rows = dropNewest(rows).rows;
      tree = batchTree(info, rows);
    }

    // Nothing may have changed while the checks ran: same HEAD, every chosen candidate
    // still eligible (a later BROKEN or an edited file drops it — then cut again).
    const again = await planRelease({ repo, policy: pol, now: clock() });
    const info2 = CS.repoInfo(repo);
    if (info2.head !== info.head) fail('head-moved', `HEAD moved while the checks ran (${info.head.slice(0, 12)} → ${info2.head.slice(0, 12)}) — nothing was committed; cut again`);
    const still = new Set(again.eligible.map((r) => r.hash));
    const lost = rows.filter((r) => !still.has(r.hash));
    if (lost.length) fail('batch-changed', `${lost.map((r) => r.ticket).join(', ')} stopped being releasable while the checks ran (a verdict or a file changed) — nothing was committed; cut again`);

    const tickets = [...new Set(rows.flatMap((r) => CS.membersOf(r.C)))];
    const version = nextVersion(info.top, pol.release.tagPrefix, tickets).version;
    const msg = await releaseMessage(info.top, version, rows);
    const paths = [...new Set(rows.flatMap((r) => r.C.files.map((f) => f.path)))];
    const pub = CS.publishFrozenTree({
      repo, head: info.head, paths, hashes: rows.map((r) => r.hash), event: 'release', reflog: `release ${version}`,
      buildTree: () => {
        const t = batchTree(info, rows);
        if (t !== tree) fail('tree-mismatch', `the release tree rebuilt as ${t.slice(0, 12)}, not the checked ${tree.slice(0, 12)} — nothing committed`);
        return t;
      },
      message: msg,
      trailers: [`${RELEASE_TRAILER}: ${version}`, ...rows.map((r) => `${CS.TRAILER}: ${r.hash}`)],
      tag: { name: version, message: msg },
    });
    const rec = { event: 'release', cutId, version, tag: `refs/tags/${version}`, commit: pub.commit, parent: info.head, tree, tickets, hashes: rows.map((r) => r.hash), trigger, at: new Date(clock()).toISOString(), checks: results.map(({ cmd, exit, ms }) => ({ cmd, exit, ms })), ...(attempts.length > 1 ? { droppedAfterFailure: attempts.slice(0, -1).map((a) => a.tickets.filter((t) => !tickets.includes(t))).flat() } : {}) };
    appendLog(info, rec);
    const wantPush = trigger === 'user' && push !== null ? push === true : pol.push === true;
    const pushed = wantPush ? pushRelease(info, rec, clock) : { ok: false, skipped: true, reason: trigger === 'user' && push === false ? 'not pushed (--no-push)' : 'push is not granted for this project' };
    return { released: true, version, commit: pub.commit, tag: pub.tag, tickets, hashes: rec.hashes, checks: rec.checks, dropped: rec.droppedAfterFailure ?? [], pushed, plan: strip(again) };
  });
}

const strip = (p) => { const { _rows, ...rest } = p; return rest; };

/* ───────────────────────────────────────────────────────────── push */

function pushRelease(info, rel, clock = Date.now) {
  const branchR = git(info.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  const branch = String(branchR.stdout || '').trim();
  const done = (o) => { appendLog(info, { event: 'push', version: rel.version, commit: rel.commit, at: new Date(clock()).toISOString(), ...o }); return o; };
  if (!branch) return done({ ok: false, reason: 'HEAD is detached — no branch to push' });
  const cfg = (k) => String(git(info.top, ['config', '--get', k], { allowFail: true }).stdout || '').trim();
  const remotes = String(git(info.top, ['remote'], { allowFail: true }).stdout || '').split('\n').filter(Boolean);
  const remote = cfg(`branch.${branch}.remote`) || (remotes.includes('origin') ? 'origin' : '');
  if (!remote) return done({ ok: false, reason: 'no remote configured' });
  const merge = cfg(`branch.${branch}.merge`) || `refs/heads/${branch}`;
  const r = git(info.top, ['push', '--atomic', '--porcelain', remote, `${rel.commit}:${merge}`, `${rel.tag}:${rel.tag}`], { allowFail: true });
  const ok = (r.status ?? 1) === 0;
  return done({ ok, remote, ref: merge, reason: ok ? null : String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ') });
}

/** Retry the push of the latest unpushed release (and only it: older ones are its ancestors). */
export function pushPending({ repo, policy = null, trigger = 'user', clock = Date.now }) {
  const pol = policy ?? normalizeGitWrite(null);
  if (trigger !== 'user' && !pol.push) fail('push-not-granted', 'push is not granted for this project');
  const info = CS.repoInfo(repo);
  const pending = unpushedReleases(info)[0];
  if (!pending) return { ok: true, nothing: true };
  return withReleaseLock(info, () => pushRelease(info, pending, clock));
}

/** Resolve a project id or a path to { repo, project, policy } through the registry. */
export function resolveTarget(arg, { env = process.env } = {}) {
  const reg = readRegistry(env);
  const ps = Array.isArray(reg?.projects) ? reg.projects : Object.values(reg?.projects ?? {});
  let project = ps.find((p) => p && p.id === arg) ?? null;
  let repo = project?.hostPath ?? null;
  if (!project) {
    let real; try { real = fs.realpathSync(path.resolve(arg)); } catch { real = null; }
    if (!real) fail('unknown-project', `${arg} is neither a registered project id nor a directory`);
    repo = real;
    let best = null;
    for (const p of ps) {
      if (!p?.hostPath) continue;
      let hp; try { hp = fs.realpathSync(p.hostPath); } catch { continue; }
      if ((real === hp || real.startsWith(hp + path.sep)) && (!best || hp.length > best.hp.length)) best = { hp, p };
    }
    project = best?.p ?? null;
  }
  return { repo, project, policy: normalizeGitWrite(project?.settings?.gitWrite) };
}
function readRegistry(env) {
  const d = env.CLAUDE_STATION_DATA?.trim() ? path.resolve(env.CLAUDE_STATION_DATA)
    : path.join(env.XDG_DATA_HOME?.trim() ? path.resolve(env.XDG_DATA_HOME) : path.join(os.homedir(), '.local', 'share'), 'claude-station');
  try { return JSON.parse(fs.readFileSync(path.join(d, 'registry.json'), 'utf8')); } catch { return null; }
}

/**
 * Should the user hear about this project's releases (plan review #4)? A string when the
 * last TWO release attempts were both refused, or when the oldest eligible ticket has
 * waited more than twice the cadence's maxWaitHours; else null.
 */
export async function releaseAlarm({ repo, policy = null, now = Date.now() }) {
  const pol = policy ?? normalizeGitWrite(null);
  const info = CS.repoInfo(repo);
  // One CUT may log several refused attempts (the subset retry): judge whole cuts.
  const cuts = [];
  for (const e of readReleaseLog(info)) {
    if (e.event !== 'release' && e.event !== 'refused') continue;
    const key = e.cutId ?? `${e.event}-${e.at}`;
    const c = cuts.find((x) => x.key === key);
    if (c) c.released = c.released || e.event === 'release'; else cuts.push({ key, released: e.event === 'release', tickets: e.tickets });
  }
  const last2 = cuts.slice(-2);
  if (last2.length === 2 && last2.every((c) => !c.released)) return `the last two release cuts failed their checks (${last2.at(-1).tickets?.join(', ') ?? ''})`;
  const plan = await planRelease({ repo, policy: pol, now });
  if (plan.cadence.oldestWaitHours > 2 * pol.release.maxWaitHours) return `a verified ticket has waited ${plan.cadence.oldestWaitHours} h for a release (more than twice the ${pol.release.maxWaitHours} h cadence)`;
  return null;
}
