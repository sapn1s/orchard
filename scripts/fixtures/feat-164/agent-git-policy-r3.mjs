/* PINNED FIXTURE (FEAT-164 r4 must-FAIL baseline): agent-git-policy.mjs WITHOUT the alias refusals
 * (round 3), synthesized from its exact prior lines. */
/**
 * agent-git-policy.mjs — FEAT-164 (2026-10-11): the ONE rule that turns a project's
 * declared `settings.gitWrite` into what agents may do with git there.
 *
 * The user's decision (verbatim): "default no commits, each project the user requests
 * and will inform the scoping; when undetermined scoping, use whatever is appropriate,
 * while avoiding spam to main GitHub — instead it must be like soft release versions."
 *
 * MODES (derived here and nowhere else — ARCH-010):
 *   none     no commit grant (the default). Agents never write the real repo.
 *   scoped   commit granted AND the user wrote a scope note. Agents may write the real
 *            repo directly, following the note; push only when push is granted.
 *   release  commit granted, scope note blank (undetermined). Agents never write the
 *            real repo; finished, verified work reaches it only as batched RELEASE
 *            commits (one commit + one version tag per batch, scripts/release.mjs).
 *
 * Under ANY commit grant agents may still write scratch/fixture repos (the grant store
 * answers "standing grant" for mode ≠ none); the restriction is on the REAL repos —
 * `decideByTarget` below (the TARGET repo's project decides), applied by the host at the shim's decide call.
 *
 * Legacy `{ permanent: true }` (FEAT-164 r1, granted before scope notes existed) reads
 * as `{ commit: true, push: true, scope: MIGRATED_SCOPE_NOTE }` = scoped mode: an existing
 * grant keeps exactly its behaviour (coordinator, 2026-10-11), shown in Settings as an
 * editable migrated note. Nothing is rewritten on disk until the user saves the setting.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseGlobals, defaultShadowRoot } from './shadow-guard.mjs';
import { scratchRoot } from './scratch.mjs';

let hostBuiltins; // undefined = not computed; null = unavailable
/** git's builtins on the HOST (`git --list-cmds=builtins`), cached; null when git cannot say. */
export function hostGitBuiltins(git = 'git') {
  if (hostBuiltins !== undefined && hostBuiltins !== null) return hostBuiltins;
  try {
    const r = spawnSync(git, ['--list-cmds=builtins'], { encoding: 'utf8', timeout: 10000 });
    const s = (r.status ?? 1) === 0 ? new Set(String(r.stdout).split('\n').map((x) => x.trim()).filter(Boolean)) : null;
    hostBuiltins = s && s.size ? s : null;
  } catch { hostBuiltins = null; }
  return hostBuiltins;
}

/** scripts/lib/confined-run.mjs WORK — the confined runner's in-container tree. */
const CONFINED_WORK = '/work';

/**
 * The roots under which an UNREGISTERED repo counts as a test fixture (coordinator 2026-10-11):
 * Orchard's scratch root, the system tmp, the shadow-repo root, and the confined runner's work
 * dir. Realpath'd; computed on the host. Any other unregistered repo is ungranted.
 */
export function defaultFixtureRoots() {
  const roots = [];
  const add = (p) => { if (!p) return; try { roots.push(fs.realpathSync(p)); } catch { roots.push(path.resolve(p)); } };
  try { add(scratchRoot()); } catch { /* none */ }
  add(os.tmpdir());
  try { add(defaultShadowRoot()); } catch { /* none */ }
  add(CONFINED_WORK);
  return [...new Set(roots)];
}

/**
 * The evidence-based release cadence default (FEAT-164 plan, 2026-10-11): Orchard saw
 * 23 tickets with a typed HOLDS in 30 days (≈0.8/day, bursts of 6/day); the user's own
 * cadence was 4 batch commits/30 days; an ungated grant produced 26–29 commits/day.
 * A release is DUE when ≥1 ticket is eligible, ≥ minIntervalHours since the last
 * release, and (≥ minTickets eligible OR the oldest eligible has waited ≥ maxWaitHours).
 * ⇒ ≤ 1 release/day; ≈ 2/week of 3–5 tickets at Orchard's rate. Per-project override:
 * settings.gitWrite.release.{minTickets,maxWaitHours,minIntervalHours}.
 */
export const DEFAULT_RELEASE = Object.freeze({ minTickets: 5, maxWaitHours: 72, minIntervalHours: 24, tagPrefix: 'v' });
export const SCOPE_MAX = 2000;
/** The scope note an existing (r1) permanent grant is read with: its behaviour, unchanged. */
export const MIGRATED_SCOPE_NOTE = 'Direct commits and pushes as before (migrated from the earlier permanent grant — edit or clear this note to change it).';
export const CHECKS_MAX = 20;

const posInt = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Normalise a release override block. Unknown/invalid fields fall back to the default. */
export function normalizeRelease(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(r.checks)
    ? r.checks.filter((c) => typeof c === 'string' && c.trim() && !/[\0\n\r]/.test(c)).map((c) => c.trim()).slice(0, CHECKS_MAX)
    : null;
  const tagPrefix = typeof r.tagPrefix === 'string' && /^[A-Za-z0-9._/-]{0,20}$/.test(r.tagPrefix) && !r.tagPrefix.includes('..') ? r.tagPrefix : DEFAULT_RELEASE.tagPrefix;
  return {
    minTickets: posInt(r.minTickets, 1, 1000) ?? DEFAULT_RELEASE.minTickets,
    maxWaitHours: posInt(r.maxWaitHours, 1, 24 * 365) ?? DEFAULT_RELEASE.maxWaitHours,
    minIntervalHours: posInt(r.minIntervalHours, 0, 24 * 365) ?? DEFAULT_RELEASE.minIntervalHours,
    checks: checks && checks.length ? checks : null,
    tagPrefix,
  };
}

/**
 * THE normaliser. Any stored value (absent, null, legacy, torn) → a full policy:
 *   { mode, commit, push, scope, release, grantedAt, grantedVia, legacy }
 * Fail closed: anything that is not an explicit commit grant is mode 'none'.
 */
export function normalizeGitWrite(raw) {
  const none = { mode: 'none', commit: false, push: false, scope: null, release: normalizeRelease(null), grantedAt: null, grantedVia: null, legacy: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none;
  const legacy = raw.permanent === true && raw.commit === undefined;
  const commit = legacy || raw.commit === true;
  // MIGRATION (coordinator, 2026-10-11): an EXISTING permanent grant keeps exactly its
  // behaviour — direct commits AND pushes — through a visible, editable migrated scope note
  // (scoped mode). Only new grants with a genuinely blank note get release mode.
  const scope = legacy ? MIGRATED_SCOPE_NOTE
    : typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim().slice(0, SCOPE_MAX) : null;
  const release = normalizeRelease(raw.release);
  const base = {
    commit,
    push: commit && (legacy || raw.push === true),
    scope,
    release,
    grantedAt: typeof raw.grantedAt === 'string' ? raw.grantedAt : null,
    grantedVia: typeof raw.grantedVia === 'string' ? raw.grantedVia : null,
    legacy,
  };
  if (!commit) return { ...base, mode: 'none', push: false };
  return { ...base, mode: scope ? 'scoped' : 'release' };
}

/**
 * Validate a user-submitted policy (the settings route). Returns { value } — the
 * shape to STORE — or { error }. Only these keys are accepted.
 */
export function validatePolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const allowed = new Set(['commit', 'push', 'scope', 'release']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { error: `unknown key "${k}"` };
  if (typeof body.commit !== 'boolean') return { error: 'commit must be true or false' };
  if (body.push !== undefined && typeof body.push !== 'boolean') return { error: 'push must be true or false' };
  if (body.scope !== undefined && body.scope !== null && typeof body.scope !== 'string') return { error: 'scope must be a string or null' };
  if (typeof body.scope === 'string' && body.scope.length > SCOPE_MAX) return { error: `scope note is longer than ${SCOPE_MAX} characters` };
  let release;
  if (body.release !== undefined && body.release !== null) {
    const r = body.release;
    if (typeof r !== 'object' || Array.isArray(r)) return { error: 'release must be an object' };
    const rk = new Set(['minTickets', 'maxWaitHours', 'minIntervalHours', 'checks', 'tagPrefix']);
    for (const k of Object.keys(r)) if (!rk.has(k)) return { error: `unknown release key "${k}"` };
    for (const [k, lo, hi] of [['minTickets', 1, 1000], ['maxWaitHours', 1, 24 * 365], ['minIntervalHours', 0, 24 * 365]]) {
      if (r[k] !== undefined && posInt(r[k], lo, hi) === null) return { error: `release.${k} must be an integer from ${lo} to ${hi}` };
    }
    if (r.checks !== undefined && (!Array.isArray(r.checks) || r.checks.some((c) => typeof c !== 'string' || /[\0\n\r]/.test(c)) || r.checks.length > CHECKS_MAX)) return { error: `release.checks must be up to ${CHECKS_MAX} one-line commands` };
    if (r.tagPrefix !== undefined && (typeof r.tagPrefix !== 'string' || !/^[A-Za-z0-9._/-]{0,20}$/.test(r.tagPrefix) || r.tagPrefix.includes('..'))) return { error: 'release.tagPrefix must be up to 20 of A-Z a-z 0-9 . _ / -' };
    release = {};
    for (const k of ['minTickets', 'maxWaitHours', 'minIntervalHours', 'tagPrefix']) if (r[k] !== undefined) release[k] = r[k];
    if (r.checks !== undefined) release.checks = r.checks.map((c) => c.trim()).filter(Boolean);
  }
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : null;
  return { value: { commit: body.commit, push: body.commit && body.push === true, scope, ...(release ? { release } : {}) } };
}

/* ───────────── E2: the target-repo guard (decideByTarget, below) and its helpers */

/** Verbs that send to a remote. */
export const PUSH_VERBS = new Set(['push', 'send-pack']);

const insideOrEqual = (dir, p) => typeof dir === 'string' && typeof p === 'string' && !!dir && (p === dir || p.startsWith(dir + path.sep));


/** A URL that leaves the machine: scheme://… other than file://, or scp-like host:path. */
export function isNetworkUrl(u) {
  if (typeof u !== 'string' || !u) return true;
  if (/^file:\/\//i.test(u)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return true;
  if (/^[A-Za-z]:[\\/]/.test(u)) return false; // a Windows drive path
  if (/^[^/\\]+:/.test(u)) return true; // user@host:path
  return false;
}




/** The git verb of a shim argv (no `git` head). Unparseable globals: a push stays a push. */
export function verbOfArgv(argv) {
  const a = Array.isArray(argv) ? argv.filter((x) => typeof x === 'string') : [];
  const parsed = parseGlobals(a);
  if (parsed) return parsed.sub;
  if (a.includes('push')) return 'push';
  if (a.includes('send-pack')) return 'send-pack';
  return a.find((x) => !x.startsWith('-')) ?? '';
}

export function releaseModeRefusalText(verb) {
  return [
    `orchard: \`git ${verb}\` on this project's real repo/remote is refused — release mode (FEAT-164).`,
    'The user granted agent commits here without a scope note, so work reaches the real',
    'repo only as batched, verified RELEASE commits — never one commit per fix:',
    '  1. leave your change in the working tree (or land it from your shadow lane);',
    '  2. freeze it:  node <orchard>/scripts/candidate.mjs freeze --id <T> --files … --check "<test cmd>";',
    '  3. get an independent HOLDS bound to that candidate (independent-verify --candidate);',
    '  4. releases are cut automatically when due (or ask: node <orchard>/scripts/release.mjs cut <project> --via-station).',
    'Scratch/fixture repos are unaffected.',
  ].join('\n');
}

/* ─────────────────────────────── protected dirs: every registered project's real repo */

const commonDirCache = new Map(); // hostPath → { at, dir }
const CACHE_MS = 60_000;

/** realpath of the git common dir for a work tree, or null (not a repo / unreadable). */
export function gitCommonDirOf(dir, { git = 'git', now = Date.now() } = {}) {
  if (!dir || typeof dir !== 'string') return null;
  const hit = commonDirCache.get(dir);
  if (hit && now - hit.at < CACHE_MS) return hit.dir;
  let out = null;
  try {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k]; // an EMPTY value still counts as set
    const r = spawnSync(git, ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, env });
    const line = (r.status ?? 1) === 0 ? String(r.stdout).trim().split('\n')[0] : '';
    if (line && path.isAbsolute(line)) out = fs.realpathSync(line);
  } catch { out = null; }
  commonDirCache.set(dir, { at: now, dir: out });
  return out;
}

const remoteDirsCache = new Map(); // hostPath → { at, dirs }

/**
 * The LOCAL-path remotes (url / pushurl) of a registered repo, realpath'd: when a project's
 * origin is a bare repo on disk, that bare repo IS its "GitHub" and is a real remote
 * (verify a6b600b7 could-not-test). Network remotes are judged by URL shape instead.
 */
export function localRemoteDirsOf(dir, { git = 'git', now = Date.now() } = {}) {
  const hit = remoteDirsCache.get(dir);
  if (hit && now - hit.at < CACHE_MS) return hit.dirs;
  const dirs = [];
  try {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
    const r = spawnSync(git, ['-C', dir, 'config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { encoding: 'utf8', timeout: 5000, env });
    for (const line of String(r.stdout || '').split('\n')) {
      const v = line.slice(line.indexOf(' ') + 1).trim();
      if (!line.trim() || !v || isNetworkUrl(v)) continue;
      const local = path.resolve(dir, v.replace(/^file:\/\//i, ''));
      let real = null; try { real = fs.realpathSync(local); } catch { real = null; }
      if (real) dirs.push(real);
    }
  } catch { /* none */ }
  remoteDirsCache.set(dir, { at: now, dirs });
  return dirs;
}

/* ───────────────── FEAT-164 r2 (verify adb2b039 P1): the TARGET repo chooses the policy ─────────── */

/** Comparable form of a network remote URL: host/path, no scheme/user/.git/trailing slash. */
export function normalizeRemoteUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  let s = u.trim();
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
  if (!m) m = /^(?:[^@/]*@)?([^/:]+):(.*)$/.exec(s); // scp-like user@host:path
  if (!m) return null;
  return `${m[1].toLowerCase()}/${m[2].replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '')}`;
}

const repoDescCache = new Map(); // hostPath → { at, desc }

/** What identifies a registered project's repo: its common dir, its local-path remotes, its
 * network remote URLs (normalised). Cached 60 s; git-unreadable → nulls/empties. */
export function describeRegisteredRepo(hostPath, { git = 'git', now = Date.now() } = {}) {
  const hit = repoDescCache.get(hostPath);
  if (hit && now - hit.at < CACHE_MS) return hit.desc;
  const desc = { commonDir: gitCommonDirOf(hostPath, { git, now }), localRemotes: localRemoteDirsOf(hostPath, { git, now }), networkRemotes: [], tree: null };
  try { desc.tree = fs.realpathSync(hostPath); } catch { desc.tree = null; }
  try {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
    const r = spawnSync(git, ['-C', hostPath, 'config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { encoding: 'utf8', timeout: 5000, env });
    for (const line of String(r.stdout || '').split('\n')) {
      const v = line.slice(line.indexOf(' ') + 1).trim();
      if (line.trim() && v && isNetworkUrl(v)) { const n = normalizeRemoteUrl(v); if (n) desc.networkRemotes.push(n); }
    }
  } catch { /* none */ }
  repoDescCache.set(hostPath, { at: now, desc });
  return desc;
}

/**
 * The registered project that OWNS a repo dir (its common dir, or one of its local-path
 * remotes; the longest match wins, so a nested project beats its umbrella), or null.
 * `projects`: [{ id, commonDir, localRemotes, networkRemotes, tree, ... }].
 */
export function ownerOfDir(dir, projects) {
  if (typeof dir !== 'string' || !dir) return null;
  let best = null; let len = -1;
  for (const p of projects) {
    for (const d of [p.commonDir, ...(p.localRemotes || [])]) {
      if (d && insideOrEqual(d, dir) && d.length > len) { best = p; len = d.length; }
    }
  }
  return best;
}
/** The owner of a work-tree path (an unresolvable target's cwd), by registered work tree. */
function ownerOfTree(cwd, projects) {
  let best = null; let len = -1;
  for (const p of projects) if (p.tree && insideOrEqual(p.tree, cwd) && p.tree.length > len) { best = p; len = p.tree.length; }
  return best;
}
/** The owner of a push destination URL: network → by normalised remote URL; local → by dir. */
export function ownerOfUrl(u, projects, commonDirOf = gitCommonDirOf) {
  if (isNetworkUrl(u)) { const n = normalizeRemoteUrl(u); return n ? projects.find((p) => (p.networkRemotes || []).includes(n)) ?? null : null; }
  const local = u.replace(/^file:\/\//i, '');
  if (!path.isAbsolute(local)) return null;
  let real = local; try { real = fs.realpathSync(local); } catch { /* keep */ }
  const d = commonDirOf ? commonDirOf(real) : null;
  return ownerOfDir(d ?? real, projects) ?? ownerOfDir(real, projects);
}

/**
 * THE decision (verify adb2b039 P1): the policy that governs a git write is the policy of the
 * project that OWNS THE REPO git resolved as the target — never the session's. Returns
 * { refusal: string|null, key: string } — `key` is the project whose grant the store then
 * claims and whose repo the leak gate scans.
 *   projects: [{ id, name, commonDir, localRemotes, networkRemotes, tree, policy, timedGrantLive }]
 * Rules:
 *   - init/clone (a NEW repo): no refusal; the session's own grant decides (store).
 *   - a write in a registered project's repo → THAT project's policy: none → refused (unless it
 *     is the session's own project, where the store's standard refusal applies unchanged);
 *     release → refused (soft releases); scoped → allowed; a live timed grant on THAT project
 *     lifts commits.
 *   - a write in an unregistered local repo (fixture/scratch): the session's own grant decides.
 *   - a push: judged by DESTINATION. A registered project's remote → that project must be
 *     scoped + push (a timed grant never lifts a push). A network URL that is no registered
 *     project's remote → UNGRANTED → refused. An unregistered local repo → session's grant.
 *     An undeterminable destination → refused.
 */
export function decideByTarget({ argv, target, sessionProjectId, projects, commonDirOf = gitCommonDirOf, fixtureRoots = defaultFixtureRoots() }) {
  const inFixture = (p) => typeof p === 'string' && fixtureRoots.some((r) => insideOrEqual(r, p));
  const unregistered = (v, where) => `orchard: \`git ${v}\` ${where} is refused — that repo is not a registered project and not under a scratch/fixture root, so nothing grants it (FEAT-164: an unregistered real repo is ungranted; register it as a project and grant it there).`;
  const fromArgv = verbOfArgv(argv);
  const t = target && typeof target === 'object' ? target : null;
  const verb = t && PUSH_VERBS.has(t.verb) ? t.verb : fromArgv;
  const ungranted = (p, v) => `orchard: \`git ${v}\` into ${p ? `project "${p.name ?? p.id}"` : 'this repo'} is refused — that repo's project has no agent git grant (FEAT-164: the TARGET repo's grant decides, not your session's).`;
  if (PUSH_VERBS.has(verb)) {
    const urls = Array.isArray(t?.push?.urls) ? t.push.urls.filter((u) => typeof u === 'string' && u) : [];
    if (!urls.length) return { refusal: `orchard: \`git ${verb}\` refused — its destination could not be determined (FEAT-164, fail closed).`, key: sessionProjectId };
    let key = sessionProjectId;
    for (const u of urls) {
      const o = ownerOfUrl(u, projects, commonDirOf);
      if (o) {
        if (o.policy?.mode === 'scoped' && o.policy.push) { key = o.id; continue; }
        if (o.policy?.mode === 'release') return { refusal: releaseModeRefusalText(verb), key: o.id };
        if (o.policy?.mode === 'scoped') return { refusal: `orchard: \`git ${verb}\` to project "${o.name ?? o.id}"'s remote is refused — the user granted commits but not pushes there (FEAT-164). Leave the push to the user.`, key: o.id };
        return { refusal: ungranted(o, verb), key: o.id };
      }
      if (isNetworkUrl(u)) return { refusal: `orchard: \`git ${verb}\` to ${normalizeRemoteUrl(u) ?? 'that remote'} is refused — it is no registered project's remote, so nothing grants it (FEAT-164).`, key: sessionProjectId };
      // a LOCAL unregistered destination: a fixture remote under a scratch root, or ungranted
      const local = u.replace(/^file:\/\//i, '');
      let real = path.isAbsolute(local) ? local : null;
      try { if (real) real = fs.realpathSync(real); } catch { /* keep */ }
      if (!inFixture(real)) return { refusal: unregistered(verb, `to ${real ?? u}`), key: sessionProjectId };
    }
    return { refusal: null, key };
  }
  if (t?.creating === true) return { refusal: null, key: sessionProjectId };
  const d = t && typeof t.commonDir === 'string' && path.isAbsolute(t.commonDir) ? t.commonDir : null;
  let owner = d ? ownerOfDir(d, projects) : null;
  if (!d) {
    const cwd = t && typeof t.cwd === 'string' && path.isAbsolute(t.cwd) ? t.cwd : null;
    if (!cwd) return { refusal: `orchard: \`git ${verb}\` refused — its target repo could not be determined (FEAT-164, fail closed).`, key: sessionProjectId };
    owner = ownerOfTree(cwd, projects) ?? ownerOfDir(cwd, projects);
  }
  if (!owner) {
    // Unregistered: a FIXTURE under a scratch root stays under the session's own grant; any other
    // repo (e.g. a real checkout that is not a project) is UNGRANTED (coordinator 2026-10-11).
    const where = d ?? (t && t.cwd);
    return inFixture(where) ? { refusal: null, key: sessionProjectId } : { refusal: unregistered(verb, `in ${where}`), key: sessionProjectId };
  }
  if (owner.timedGrantLive) return { refusal: null, key: owner.id };
  const mode = owner.policy?.mode ?? 'none';
  if (mode === 'scoped') return { refusal: null, key: owner.id };
  if (mode === 'release') return { refusal: releaseModeRefusalText(verb), key: owner.id };
  if (owner.id === sessionProjectId) return { refusal: null, key: owner.id }; // the store's standard FEAT-108 refusal
  return { refusal: ungranted(owner, verb), key: owner.id };
}

export function _clearCommonDirCache() { commonDirCache.clear(); remoteDirsCache.clear(); repoDescCache.clear(); }

/* ─────────────────────────────────────────── E4: what an agent is told */

/**
 * The system-prompt note for a session in a project with this policy. `null` for mode
 * none, so a project without a grant gets byte-identical prompts to before.
 */
export function agentGitPolicyNote(policy, { orchardDir = '<orchard>', projectId = '<project>' } = {}) {
  if (!policy || policy.mode === 'none') return null;
  // A migrated (unsaved legacy) grant keeps EXACTLY its old behaviour, prompts included:
  // no note until the user saves the setting.
  if (policy.legacy) return null;
  const lines = ['## Git policy for this project (set by the user — FEAT-164)'];
  if (policy.mode === 'scoped') {
    lines.push(`Agents may commit to this project's real repo${policy.push ? ' and push to its remote' : ' (NOT push — leave pushing to the user)'}, following the user's scope note exactly:`);
    lines.push('', ...policy.scope.split('\n').map((l) => `> ${l}`), '');
    lines.push('Every commit and push still runs the leak gate.');
  } else {
    lines.push('Agent commits are granted here WITHOUT a scope note, so this project uses SOFT RELEASES: never commit or push to the real repo yourself (it is refused).');
    lines.push('Finished work reaches the repo only as a batched release commit with a version tag and a changelog, cut when enough verified tickets are ready:');
    lines.push(`- freeze your ticket's files: \`node ${orchardDir}/scripts/candidate.mjs freeze --id <T> --files … --check "<your test command>"\`;`);
    lines.push('- it needs an independent HOLDS bound to that candidate (independent-verify --candidate) — nothing unverified ships;');
    lines.push(`- releases are cut automatically when due (at least ${policy.release.minTickets} verified tickets or one waiting ${policy.release.maxWaitHours} h, at most one per ${policy.release.minIntervalHours} h); \`node ${orchardDir}/scripts/release.mjs plan ${projectId}\` shows what is eligible.`);
    lines.push(policy.push ? 'Releases are pushed to the remote when cut.' : 'Releases are NOT pushed; the user pushes.');
    lines.push('Scratch and fixture repos (tests) are unaffected.');
  }
  return lines.join('\n');
}

/** One-line summary for UIs and CLIs. */
export function policySummary(policy) {
  if (!policy || policy.mode === 'none') return 'No agent commits (default)';
  if (policy.mode === 'scoped') return `Agents commit${policy.push ? ' and push' : ''} per your scope note`;
  return `Soft releases: verified work batched into versioned release commits${policy.push ? ', pushed' : ''}`;
}
