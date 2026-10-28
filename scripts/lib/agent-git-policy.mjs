/**
 * agent-git-policy.mjs — FEAT-164 (2026-10-11): the ONE rule that turns a project's
 * declared `settings.gitWrite` into what agents may do with git there.
 *
 * The user's decision (verbatim): "default no commits, each project the user requests
 * and will inform the scoping; when undetermined scoping, use whatever is appropriate,
 * while avoiding spam to main GitHub — instead it must be like soft release versions."
 *
 * MODES (derived here and nowhere else — ARCH-010). FEAT-190 reshaped these: granting
 * means ALLOWED, the scope note is optional advisory text, and release is an explicit opt-in.
 *   none     no commit grant (the default). Agents never write the real repo.
 *   scoped   commit granted (push on by default; a scope note, if any, is guidance only).
 *            Agents may write the real repo directly and push to its own remote. A plain
 *            grant produces this — a BLANK scope no longer means "release".
 *   release  commit granted AND the user EXPLICITLY opted into soft releases
 *            (`release.opt_in === true`). Agents never write the real repo; finished,
 *            verified work reaches it only as batched RELEASE commits (scripts/release.mjs).
 *            Never derived from a blank scope.
 * FEAT-190 cross-repo: a grant also covers the OTHER real repos a session works in (commit and
 * push by default), bounded only by the per-repo `repoOverrides` opt-out. A push goes to whatever
 * remote the repo has configured; the leak gate runs on every push. (FEAT-190 r8 RESCOPE removed
 * the frozen-remote veto — a destination safeguard the user never asked for, outside the guard's
 * threat model, that broke three times through its keying.)
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
import { parseGlobals } from './git-target.mjs';
import { scratchRoot } from './scratch.mjs';
import { repoIdentityOf, resolvedRemotesOf, sameRepository } from './repo-identity.mjs';
import { parseRemote } from './remote-url.mjs';

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
 * Orchard's scratch root, the system tmp, and the confined runner's work
 * dir. Realpath'd; computed on the host. Any other unregistered repo is ungranted.
 */
export function defaultFixtureRoots() {
  const roots = [];
  const add = (p) => { if (!p) return; try { roots.push(fs.realpathSync(p)); } catch { roots.push(path.resolve(p)); } };
  try { add(scratchRoot()); } catch { /* none */ }
  add(os.tmpdir());
  add(CONFINED_WORK);
  return [...new Set(roots)];
}

/**
 * TRUE iff `p` lies inside (or is) one of the fixture roots: the scratch root, the system tmp
 * (which holds e.g. the Claude CLI's own `/tmp/claude-<uid>/bash-edit-diff/<hash>` throwaway
 * repos) or the confined runner's work dir. Used to keep throwaway/test repos OUT of the
 * "other repos this grant reached" display log (they are never real repos the user governs).
 * The path is realpath'd when it still exists (else resolved), matching how the roots are built.
 * Display/record filter only — no allow/deny decision reads it.
 */
export function isFixturePath(p, roots = defaultFixtureRoots()) {
  if (typeof p !== 'string' || !p) return false;
  let rp; try { rp = fs.realpathSync(p); } catch { rp = path.resolve(p); }
  const cands = rp === path.resolve(p) ? [rp] : [rp, path.resolve(p)];
  return roots.some((r) => typeof r === 'string' && !!r && cands.some((c) => c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)));
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
/** release.mjs releaseAlarm's prefix for the structural "this project can never release"
 *  alarm (release mode, no typed verdicts) — the station tick keys its Needs-You card on it. */
export const NEVER_RELEASES_PREFIX = 'releases can never happen: ';

const posInt = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Normalise a release override block. Unknown/invalid fields fall back to the default.
 * FEAT-190: `opt_in` is the EXPLICIT switch into release (soft-release) mode. It is
 * NEVER derived from a blank scope note (that trap is gone); release mode holds iff
 * the user opted in here AND commits are granted. Absent/falsey = scoped. */
export function normalizeRelease(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(r.checks)
    ? r.checks.filter((c) => typeof c === 'string' && c.trim() && !/[\0\n\r]/.test(c)).map((c) => c.trim()).slice(0, CHECKS_MAX)
    : null;
  const tagPrefix = typeof r.tagPrefix === 'string' && /^[A-Za-z0-9._/-]{0,20}$/.test(r.tagPrefix) && !r.tagPrefix.includes('..') ? r.tagPrefix : DEFAULT_RELEASE.tagPrefix;
  return {
    opt_in: r.opt_in === true,
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
  const none = { mode: 'none', commit: false, push: false, scope: null, release: normalizeRelease(null), repoOverrides: {}, grantedAt: null, grantedVia: null, legacy: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none;
  const legacy = raw.permanent === true && raw.commit === undefined;
  const commit = legacy || raw.commit === true;
  // MIGRATION (coordinator, 2026-10-11): an EXISTING permanent grant keeps exactly its
  // behaviour — direct commits AND pushes — through a visible, editable migrated scope note
  // (scoped mode).
  const scope = legacy ? MIGRATED_SCOPE_NOTE
    : typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim().slice(0, SCOPE_MAX) : null;
  const release = normalizeRelease(raw.release);
  // FEAT-190 — the release-from-blank-scope TRAP is gone, on EVERY record (reader-side,
  // orchestrator decision 2026-10-15). Release (soft-release) mode holds ONLY when the user
  // EXPLICITLY opted in through the new `release.opt_in === true` field — never derived from
  // a blank scope note, on new OR legacy records. There was no explicit release opt-in before
  // FEAT-190, so the `release` block on a pre-FEAT-190 record came from the old panel always
  // sending it, not from a user choosing release; such a record expresses no real release-mode
  // choice. So a LEGACY record (no explicit `release.opt_in` boolean), blank scope or not,
  // reads as scoped/granted (commit+push on), NOT release. No registry rewrite or migration:
  //   · record with `release.opt_in === true`  → release;
  //   · everything else (new opt_in:false, OR legacy with no opt_in field) → scoped.
  const hasExplicitOptIn = raw.release && typeof raw.release === 'object' && typeof raw.release.opt_in === 'boolean';
  const releaseMode = commit && hasExplicitOptIn && release.opt_in === true;
  // Keep the normalized release.opt_in consistent with the derived mode for downstream readers.
  release.opt_in = releaseMode;
  const base = {
    commit,
    // Push derivation UNCHANGED from FEAT-164 (migration safety): an existing commit grant
    // never gains push on READ. The commit+push default-on lives in validatePolicyInput (the
    // new-save path) only.
    push: commit && (legacy || raw.push === true),
    scope,
    release,
    repoOverrides: normalizeRepoOverrides(raw.repoOverrides),
    grantedAt: typeof raw.grantedAt === 'string' ? raw.grantedAt : null,
    grantedVia: typeof raw.grantedVia === 'string' ? raw.grantedVia : null,
    legacy,
  };
  if (!commit) return { ...base, mode: 'none', push: false };
  return { ...base, mode: releaseMode ? 'release' : 'scoped' };
}

/**
 * FEAT-190 — the per-repo cross-repo opt-out map on a grant: `{ <repoKey>: { disabled?,
 * commit?, push?, remotes?, label?, firstReachedAt? } }`. `repoKey` is the realpath of the
 * target repo's git common dir (identity, never a path prefix). A reader uses it to decide
 * whether this grant still covers a cross-repo target and which verbs. Unknown/garbage shapes
 * are dropped (fail-closed to "no override" = covered by default, which is the user's intent).
 */
export function normalizeRepoOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || !v || typeof v !== 'object') continue;
    const o = {};
    if (v.disabled === true) o.disabled = true;
    if (typeof v.commit === 'boolean') o.commit = v.commit;
    if (typeof v.push === 'boolean') o.push = v.push;
    if (Array.isArray(v.remotes)) o.remotes = v.remotes.filter((r) => typeof r === 'string' && r).slice(0, 50);
    if (typeof v.label === 'string') o.label = v.label.slice(0, 200);
    if (typeof v.firstReachedAt === 'string') o.firstReachedAt = v.firstReachedAt;
    out[k] = o;
  }
  return out;
}

/** FEAT-190 — the identity KEY a cross-repo override / reach record is stored under: the
 * realpath of the target repo's git common dir. null when the target has no resolved repo. */
export function repoOverrideKey(target) {
  if (!target || typeof target !== 'object') return null;
  return typeof target.commonDir === 'string' && target.commonDir ? target.commonDir : null;
}

/**
 * Validate a user-submitted policy (the settings route). Returns { value } — the
 * shape to STORE — or { error }. Only these keys are accepted.
 */
export function validatePolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const allowed = new Set(['commit', 'push', 'scope', 'release', 'repoOverrides']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { error: `unknown key "${k}"` };
  if (typeof body.commit !== 'boolean') return { error: 'commit must be true or false' };
  if (body.push !== undefined && typeof body.push !== 'boolean') return { error: 'push must be true or false' };
  if (body.scope !== undefined && body.scope !== null && typeof body.scope !== 'string') return { error: 'scope must be a string or null' };
  if (typeof body.scope === 'string' && body.scope.length > SCOPE_MAX) return { error: `scope note is longer than ${SCOPE_MAX} characters` };
  // FEAT-190 — release is now an object with an explicit `opt_in` switch plus the cadence.
  // The release (soft-release) mode is NEVER derived from a blank scope; it holds only when
  // the user opts in here. We ALWAYS write an explicit `opt_in` boolean so the reader can
  // tell a new record (derive by opt_in) from a legacy one (old blank-scope rule) — see
  // normalizeGitWrite.
  const r = body.release !== undefined && body.release !== null ? body.release : {};
  const release = {};
  if (r !== undefined && r !== null) {
    if (typeof r !== 'object' || Array.isArray(r)) return { error: 'release must be an object' };
    const rk = new Set(['opt_in', 'minTickets', 'maxWaitHours', 'minIntervalHours', 'checks', 'tagPrefix']);
    for (const k of Object.keys(r)) if (!rk.has(k)) return { error: `unknown release key "${k}"` };
    if (r.opt_in !== undefined && typeof r.opt_in !== 'boolean') return { error: 'release.opt_in must be true or false' };
    for (const [k, lo, hi] of [['minTickets', 1, 1000], ['maxWaitHours', 1, 24 * 365], ['minIntervalHours', 0, 24 * 365]]) {
      if (r[k] !== undefined && posInt(r[k], lo, hi) === null) return { error: `release.${k} must be an integer from ${lo} to ${hi}` };
    }
    if (r.checks !== undefined && (!Array.isArray(r.checks) || r.checks.some((c) => typeof c !== 'string' || /[\0\n\r]/.test(c)) || r.checks.length > CHECKS_MAX)) return { error: `release.checks must be up to ${CHECKS_MAX} one-line commands` };
    if (r.tagPrefix !== undefined && (typeof r.tagPrefix !== 'string' || !/^[A-Za-z0-9._/-]{0,20}$/.test(r.tagPrefix) || r.tagPrefix.includes('..'))) return { error: 'release.tagPrefix must be up to 20 of A-Z a-z 0-9 . _ / -' };
    for (const k of ['minTickets', 'maxWaitHours', 'minIntervalHours', 'tagPrefix']) if (r[k] !== undefined) release[k] = r[k];
    if (r.checks !== undefined) release.checks = r.checks.map((c) => c.trim()).filter(Boolean);
  }
  release.opt_in = r && r.opt_in === true;
  // repoOverrides: the per-repo cross-repo opt-out map (D3/D4). Validated loosely and
  // normalised; a save may carry it to disable/limit a specific reached repo.
  let repoOverrides;
  if (body.repoOverrides !== undefined && body.repoOverrides !== null) {
    if (typeof body.repoOverrides !== 'object' || Array.isArray(body.repoOverrides)) return { error: 'repoOverrides must be an object' };
    repoOverrides = normalizeRepoOverrides(body.repoOverrides);
  }
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : null;
  // FEAT-190 — DEFAULT-ON: when commits are granted and push is OMITTED, push defaults TRUE
  // ("if i grant, then i have granted … default should allow"). An explicit push:false is
  // honoured (the per-grant opt-OUT). push is always stored as an explicit boolean.
  const push = body.commit && (body.push === undefined ? true : body.push === true);
  return { value: { commit: body.commit, push, scope, release, ...(repoOverrides ? { repoOverrides } : {}) } };
}

/* ───────────── E2: the target-repo guard (decideByTarget, below) and its helpers */

/** Verbs that send to a remote. */
export const PUSH_VERBS = new Set(['push', 'send-pack']);

const insideOrEqual = (dir, p) => typeof dir === 'string' && typeof p === 'string' && !!dir && (p === dir || p.startsWith(dir + path.sep));





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
    '  1. leave your change in the working tree;',
    '  2. freeze it:  node <orchard>/scripts/candidate.mjs freeze --id <T> --files … --check "<test cmd>";',
    '  3. get an independent HOLDS bound to that candidate (independent-verify --ticket <T>, which verifies it while current);',
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

/* ───────────────────── FEAT-190 r10: the ONE-resolved-repo invariant ─────────────────────
 * A gated publish write (commit/push/send-pack) must leave every consumer — the permission
 * decision, the leak gate, the cross-repo reach log and the audit entry — acting on ONE repo.
 * Two invocation shapes break that and have ZERO productive agent use (r10 transcript evidence,
 * N=0): (1) a repo-redirecting override — `--git-dir`/`--work-tree`, `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_COMMON_DIR`, `-c core.worktree`/`core.gitdir`/`core.bare`, `--config-env`, `GIT_CONFIG_*` —
 * can point git's repository and working tree at DIFFERENT repos, so no single repo exists to
 * agree on; (2) a bare / no-work-tree target cannot be scanned by the working-tree leak gate.
 * Rather than ENUMERATE the override channels (the r8/r9 doors were exactly such enumeration gaps),
 * this is ONE structural check on the RESOLVED target the real git produced (git-target
 * resolveWriteTarget, with the invocation's own globals + env): the target must have a real work
 * tree whose OWN git common dir — recomputed with a CLEAN env (gitCommonDirOf) — equals the
 * resolved common dir. cwd, `-C` and a linked worktree all pass (git-dir and work-tree belong to
 * one repo); every split, via ANY channel, and every bare target fail closed. The host never sees
 * the agent's env, so checking the resolved PATHS is the only enforcement that also catches the
 * env-channel redirects (GIT_WORK_TREE / GIT_CONFIG_* produce a divergent resolved toplevel). */
export function bareTargetRefusalText(verb) {
  return `orchard: \`git ${verb}\` refused — the target is a bare repository (no working tree), which the leak gate cannot scan, so the write is refused (FEAT-190, fail closed). Run the write inside a normal working checkout.`;
}
export function redirectedTargetRefusalText(verb) {
  return [
    `orchard: \`git ${verb}\` refused — this invocation points git's repository and working tree at DIFFERENT repositories`,
    `(a --git-dir/--work-tree, GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR, -c core.worktree/core.gitdir, --config-env or GIT_CONFIG_* redirect),`,
    `so the commit, the leak gate, the audit and the grant would not all act on one repo (FEAT-190, fail closed).`,
    `Run the command from inside the repository, or use \`-C <path>\`.`,
  ].join('\n');
}
/**
 * The resolved-target invariant for a gated publish write. `commonDir`/`toplevel` are the
 * git-resolved identity (absolute realpaths from git-target resolveWriteTarget). Returns a refusal
 * string, or null when the target is a single, scannable repo. `commonDirOf` is injectable for tests.
 */
export function resolvedRepoRefusal({ commonDir, toplevel, verb } = {}, { commonDirOf = gitCommonDirOf } = {}) {
  if (!(typeof toplevel === 'string' && toplevel && path.isAbsolute(toplevel))) return bareTargetRefusalText(verb);
  if (!(typeof commonDir === 'string' && commonDir && path.isAbsolute(commonDir))) return redirectedTargetRefusalText(verb);
  let honest = null;
  try { honest = commonDirOf(toplevel); } catch { honest = null; }
  let want = commonDir; try { want = fs.realpathSync(commonDir); } catch { /* already a realpath */ }
  if (!honest || honest !== want) return redirectedTargetRefusalText(verb);
  return null;
}


/* ───────────────── FEAT-164 r2 (verify adb2b039 P1): the TARGET repo chooses the policy ─────────── */

const repoDescCache = new Map(); // hostPath → { at, desc }

/** What identifies a registered project's repo: its common dir, and its remotes AS GIT RESOLVES
 * THEM (insteadOf / pushInsteadOf / pushurl applied by `git remote get-url`), then parsed by
 * parseRemote: `localRemotes` (realpaths) and `networkRemotes` (parseRemote keys). These are the
 * project's VETO keys: they are built exactly like a push destination (ruling after verify
 * 45e78a71), never from unexpanded config strings. Cached 60 s; git-unreadable → nulls/empties. */
export function describeRegisteredRepo(hostPath, { git = 'git', now = Date.now() } = {}) {
  const hit = repoDescCache.get(hostPath);
  if (hit && now - hit.at < CACHE_MS) return hit.desc;
  const rr = resolvedRemotesOf(hostPath, { git });
  const desc = { commonDir: gitCommonDirOf(hostPath, { git, now }), localRemotes: rr.local.map((l) => l.path), networkRemotes: rr.network, tree: null };
  try { desc.tree = fs.realpathSync(hostPath); } catch { desc.tree = null; }
  repoDescCache.set(hostPath, { at: now, desc });
  return desc;
}

/**
 * The registered projects that OWN a repo dir: the SAME repository by identity (its git common
 * dir equals the project's, or equals one of its local-path remotes). NEVER a path prefix
 * (FEAT-164 single authority, verify 1659cb7f): a repo nested inside a project's tree or its
 * .git (a submodule's gitdir under .git/modules, a vendored checkout) is a different
 * repository and is owned by no project unless registered itself. Several projects can share
 * one repository (a monorepo and a subfolder project); all are returned.
 * `projects`: [{ id, commonDir, localRemotes, networkRemotes, tree, ... }].
 */
export function ownersOfDir(dir, projects) {
  if (typeof dir !== 'string' || !dir) return [];
  // Identity only. A project's live local-remote config is NOT ownership (agent-editable; verify 95027178).
  return projects.filter((p) => sameRepository({ commonDir: p.commonDir ?? null, toplevel: p.tree ?? null }, { commonDir: dir }));
}
/** Every project whose network remotes have this parseRemote KEY — ALL of them, never the first match. */
function ownersOfNetworkKey(key, projects) {
  return key ? projects.filter((p) => (p.networkRemotes || []).includes(key)) : [];
}

/* ═══════════════════ FEAT-190 r5 — THE ONE PERMISSION DERIVATION ═══════════════════
 * effectiveGitPermission is the SINGLE place commit and push are related (ARCH-010). It
 * exists because FEAT-190 broke P2 ("the effective permission is never narrower than the
 * grant the user gave") four times: commit and push were decided by SEPARATE code paths,
 * each re-deriving the grant (the commit branch read `timedGrantLive || mode==='scoped'`;
 * the push branch read only `mode==='scoped' && push`, never timedGrantLive; cross-repo
 * push ran only when the source was unregistered). So a live duration grant committed but
 * refused its own push, and a registered-but-ungranted sibling committed but refused push.
 *
 * Every decision site (decideByTarget's commit branch, decidePush, the two cross-repo
 * helpers, the release CLI) now routes through HERE and derives neither commit nor push
 * itself. OWNERSHIP and LIVENESS are resolved by the caller (the host builds projects[] with
 * `policy` + `timedGrantLive`; decideByTarget/decidePush resolve which project owns the repo);
 * this function re-derives NEITHER — it only relates commit→push for ONE already-resolved
 * grant holder.
 *
 * Push is granted whenever commit is, EXCEPT for exactly these named `reason`s, in this
 * precedence (so a matrix can assert "the reason is the one expected"):
 *   commit refused (⇒ push refused too):
 *     'repo-disabled'   — a cross-repo per-repo opt-out turned this repo OFF entirely
 *     'release-mode'    — explicit soft-release opt-in: direct commit/push refused
 *     'no-grant'        — no live/standing commit grant governs this holder
 *     'repo-commit-off' — a cross-repo per-repo opt-out turned commits off for this repo
 *   push narrowed (commit allowed, push not):
 *     'repo-push-off'   — a cross-repo per-repo push opt-out
 *     'push-toggle-off' — the standing grant's push toggle is off (the per-grant opt-OUT)
 * Ref-level refusals (--force / --all / preserved-history) and the leak gate are SEPARATE,
 * later, argv-/content-keyed checks — never derived here.
 *
 * FEAT-190 r8 (orchestrator RESCOPE): there is NO frozen-remote veto. A push goes to whatever
 * remote the repo has configured; the destination remote plays no part in this derivation. The
 * old 'remote-not-recorded' reason (a push may only go to the remote the repo had when the grant
 * first reached it) was an anti-exfiltration safeguard the user never asked for, outside the
 * guard's stated threat model (autonomous noise / a broken main), and it produced three breaks
 * through its keying; it was removed rather than re-keyed. The leak gate still runs on every push.
 *
 * Inputs:
 *   policy              normalizeGitWrite result of the governing grant (mode/commit/push)
 *   live                a live TIMED grant (duration or once) is in effect for this holder.
 *                       A live grant lifts BOTH commit and push (the P2 fix) — it overrides
 *                       the standing push toggle; a per-repo override still binds.
 *   override            the cross-repo per-repo opt-out for this target, or null
 *   verb                the git verb
 *   releasePush         the release CLI's own push of a cut release: a release-mode holder
 *                       with push granted MAY push (that is what release mode is for); the
 *                       standing push toggle still binds.
 */
export function effectiveGitPermission({ policy, live = false, override = null, dstOverride = null, verb = 'commit', releasePush = false, scratch = false } = {}) {
  const pol = policy && typeof policy === 'object' ? policy : { mode: 'none', push: false };
  const ov = override && typeof override === 'object' ? override : null;
  const dov = dstOverride && typeof dstOverride === 'object' ? dstOverride : null;
  const isPush = PUSH_VERBS.has(verb);
  const deny = (reason) => ({ commit: false, push: false, reason });
  // FEAT-190 r13 — the per-repo opt-outs on BOTH the SOURCE and (for a push) the DESTINATION repo,
  // and the scratch/fixture status, are now ALL inputs to this ONE derivation (the two doors r12
  // found — a push INTO a session-opted-out destination, and a commit in a session-opted-out
  // fixture repo — were allow/deny decisions made OUTSIDE this chokepoint, so the verbs disagreed).
  //
  // ── (1) An EXPLICIT per-repo opt-out binds FIRST and is NEVER re-enabled by scratch status:
  //    the user turned this repo off; a throwaway copy of it does not turn it back on. ──
  if (ov?.disabled) return deny('repo-disabled');            // SOURCE repo turned off (commit+push)
  // ── (2) Is there an effective COMMIT grant for the source holder? Scratch/fixture status is an
  //    INPUT: a scratch/fixture source is store-governed (the FEAT-108 blanket deny + request/
  //    approve UX decides, not real policy), which we express as an ALLOW — but only PAST the
  //    explicit opt-out above (so a fixture repo the user opted out of still refuses). ──
  const releaseWritable = releasePush && pol.mode === 'release';
  if (!live && !releaseWritable && !scratch) {
    if (pol.mode === 'release') return deny('release-mode');
    if (pol.mode !== 'scoped') return deny('no-grant');
  }
  // FEAT-190 r14 — an explicit {commit:false} opt-out binds BEFORE any scratch allowance (the
  // `!scratch &&` guard let a {commit:false} opt-out be skipped for a scratch source, so commit
  // was allowed as 'scratch' while a push from it to a real remote refused 'repo-commit-off' —
  // the two verbs disagreed, violating P4). The opt-out now binds for a scratch repo too.
  if (ov && ov.commit === false) return deny('repo-commit-off');
  // Commit is granted (or store-governed scratch). A non-push write is decided now.
  if (!isPush) return { commit: true, push: true, reason: scratch ? 'scratch' : null };
  // ── (3) PUSH. The DESTINATION repo's EXPLICIT opt-out binds (even for scratch): a push INTO a
  //    repo that is turned off is refused, from the session's own grant or any other owner's. ──
  if (dov?.disabled) return { commit: true, push: false, reason: 'dest-repo-disabled' };
  if (dov && (dov.push === false || dov.commit === false)) return { commit: true, push: false, reason: 'dest-repo-push-off' };
  // ── (4) SOURCE-side per-repo push opt-out binds BEFORE any scratch allowance (FEAT-190 r14):
  //    an explicit {push:false} is never re-enabled by scratch status, so it must be checked
  //    AHEAD of the scratch→scratch early return below (the old ordering let a {push:false}
  //    opt-out be skipped for a scratch→scratch push, violating P4). It also binds under a live
  //    grant (a per-repo opt-out always wins over liveness). ──
  if (ov && ov.push === false) return { commit: true, push: false, reason: 'repo-push-off' };
  // ── (5) scratch→scratch push (caller sets scratch only when source AND destination are both
  //    scratch/fixture): store-governed → allow. ──
  if (scratch) return { commit: true, push: true, reason: 'scratch' };
  // ── (6) SOURCE-side standing push toggle (the per-grant opt-OUT; a live grant lifts it). ──
  let push = true; let reason = null;
  if (!live && pol.push === false) { push = false; reason = 'push-toggle-off'; } // standing toggle; a live grant lifts it
  return { commit: true, push, reason };
}

/* ═══════ FEAT-190 r7 (adjudicator, two-break #2) — THE per-(session, repo) GRANT ═══════
 * governingGrant resolves ONE grant for a (session, repo) pair; both decideByTarget and decidePush
 * feed its result into effectiveGitPermission ONCE, so commit and push are never decided by
 * different code — the P2 asymmetry (effective permission falling NARROWER than the grant the user
 * gave) that recurred five times, each a different OWNER-SET reduction. The SESSION's own grant is
 * the ONLY grant that AUTHORISES a write; another registered project that shares the repo
 * contributes DENIALS only (release mode, a push-off toggle, or a per-repo opt-out), never an
 * allow. This replaces the decideOwner owner-set voting and the srcOwners authorising loop.
 *
 *   session:  the session's own project entry { id, name, policy, timedGrantLive, commonDir, tree }
 *   repo:     the target repository identity { commonDir, toplevel }
 *   projects: all registered entries (read ONLY for other owners' explicit opt-outs)
 * returns { policy, live, override, ownsRepo }
 *
 * `live` (a timed grant) applies ONLY to the session's OWN repository; a timed grant does NOT
 * extend across repos (only a standing SCOPED grant does). `override` folds the session's own
 * per-repo opt-out together with every other owner's explicit opt-out (deny-only).
 *
 * FEAT-190 r8 (RESCOPE): no `recorded`/`reach` destination set — the frozen-remote veto is gone,
 * so a push goes to whatever remote the repo has (the leak gate still runs on every push).
 */
export function governingGrant({ session = null, repo = null, projects = [] } = {}) {
  const policy = session && typeof session.policy === 'object' ? session.policy : { mode: 'none', push: false };
  const commonDir = repo && typeof repo.commonDir === 'string' && repo.commonDir ? repo.commonDir : null;
  const ownsRepo = !!(session && repo && sameRepository({ commonDir: session.commonDir ?? null, toplevel: session.tree ?? null }, repo));
  const live = !!(session && session.timedGrantLive) && ownsRepo; // a timed grant covers only the session's OWN repo
  const ownOverride = commonDir && policy.repoOverrides ? policy.repoOverrides[commonDir] : null;
  const otherOptOut = commonDir ? repoOptOut(repo, projects, session ? session.id : null) : null;
  return { policy, live, override: mergeOverride(ownOverride, otherOptOut), ownsRepo };
}


/** Every OTHER registered project sharing `repo` (same repository by identity) contributes DENIALS
 * only (never an allow): an explicit per-repo opt-out, release mode, or a push-off toggle. Returned
 * as a deny-only override `{ disabled?, commit?: false, push?: false }`, or null when none objects. */
function repoOptOut(repo, projects, sessionId) {
  const commonDir = repo && typeof repo.commonDir === 'string' ? repo.commonDir : null;
  if (!commonDir || !Array.isArray(projects)) return null;
  let out = null;
  const deny = (k) => { out = out || {}; if (k === 'disabled') out.disabled = true; else out[k] = false; };
  for (const q of projects) {
    if (!q || q.id === sessionId) continue;
    if (!sameRepository({ commonDir: q.commonDir ?? null, toplevel: q.tree ?? null }, { commonDir })) continue;
    const pol = q.policy && typeof q.policy === 'object' ? q.policy : null;
    if (!pol) continue;
    if (pol.mode === 'release') deny('commit');                    // Q release-manages the repo: no direct writes
    if (pol.mode === 'scoped' && pol.push === false) deny('push'); // Q's push-off toggle
    const qov = pol.repoOverrides ? pol.repoOverrides[commonDir] : null;
    if (qov) { if (qov.disabled === true) deny('disabled'); if (qov.commit === false) deny('commit'); if (qov.push === false) deny('push'); }
  }
  return out;
}

/** Merge the session's own per-repo override with the deny-only opt-out from other owners: the
 * UNION of denials; the other-owner side can only tighten, never loosen. */
function mergeOverride(own, other) {
  const A = own && typeof own === 'object' ? own : null;
  const B = other && typeof other === 'object' ? other : null;
  if (!A && !B) return null;
  const out = {};
  if ((A && A.disabled === true) || (B && B.disabled === true)) out.disabled = true;
  if ((A && A.commit === false) || (B && B.commit === false)) out.commit = false;
  else if (A && A.commit === true) out.commit = true;
  if ((A && A.push === false) || (B && B.push === false)) out.push = false;
  else if (A && A.push === true) out.push = true;
  return Object.keys(out).length ? out : null;
}

/**
 * FEAT-190 r13 — the DESTINATION repo's per-repo opt-out for a push, resolved as a deny-only override
 * that decidePush feeds straight into effectiveGitPermission (so the DESTINATION opt-out is decided in
 * the ONE chokepoint, never in decidePush — the r12 door A was decidePush's veto loop IGNORING the
 * session's OWN repoOverrides for the destination). It folds together:
 *   · the SESSION's OWN per-repo opt-out for the destination repo (door A: a push INTO a repo the
 *     session turned off is refused, even from the session's own repo) — local destinations only
 *     (a network URL has no commonDir key); and
 *   · every OTHER owner of the destination (by repo identity for a local path, or by network key)
 *     with an EXPLICIT opt-out: release mode, a push-off toggle, or a per-repo opt-out. A live timed
 *     grant on that owner lifts its veto; a SOURCE co-owner never vetoes here (it already folds into
 *     the source governingGrant override); an ungranted sharer has no opinion.
 * Deny-only: it can only tighten the push, never widen it.
 */
function destinationOverride({ destCommonDir = null, destNetworkKey = null, session = null, projects = [], sessionProjectId = null, srcRepo = null } = {}) {
  const commonDir = typeof destCommonDir === 'string' && destCommonDir ? destCommonDir : null;
  const own = (commonDir && session && session.policy && session.policy.repoOverrides) ? session.policy.repoOverrides[commonDir] : null;
  const list = Array.isArray(projects) ? projects : [];
  const owners = commonDir
    ? [...ownersOfDir(commonDir, list), ...list.filter((p) => (p.localRemotes || []).some((r) => sameRepository(repoIdentityOf(r), { commonDir })))]
    : ownersOfNetworkKey(destNetworkKey, list);
  let other = null;
  const deny = (k) => { other = other || {}; if (k === 'disabled') other.disabled = true; else other[k] = false; };
  const seen = new Set();
  for (const q of owners) {
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    if (sessionProjectId != null && q.id === sessionProjectId) continue;     // the session's own override is `own`
    if (q.timedGrantLive) continue;                                          // a live grant lifts the owner's veto
    if (srcRepo && sameRepository({ commonDir: q.commonDir ?? null, toplevel: q.tree ?? null }, srcRepo)) continue; // source co-owner: handled by governingGrant
    const pol = q.policy && typeof q.policy === 'object' ? q.policy : null;
    if (!pol) continue;
    if (pol.mode === 'release') deny('disabled');                            // Q release-manages the destination
    else if (pol.mode === 'scoped' && pol.push === false) deny('push');      // Q's push-off toggle
    const qov = commonDir && pol.repoOverrides ? pol.repoOverrides[commonDir] : null;
    if (qov) { if (qov.disabled === true) deny('disabled'); if (qov.commit === false) deny('disabled'); if (qov.push === false) deny('push'); }
  }
  return mergeOverride(own, other);
}

/** The named-reason refusal text for a WRITE (commit) refused by governingGrant/effectiveGitPermission. */
function writeRefusal(reason, verb, where, label) {
  switch (reason) {
    case 'release-mode': return releaseModeRefusalText(verb);
    case 'repo-disabled':
    case 'repo-commit-off':
      return `orchard: \`git ${verb}\` ${where} refused — you turned agent commits OFF for this repo${label ? ` under project "${label}"` : ''} (FEAT-190 per-repo opt-out). Re-enable it on the git page.`;
    default: // 'no-grant'
      return `orchard: \`git ${verb}\` ${where} is refused — your session's project has no agent git grant covering this repo (FEAT-164/FEAT-190: grant agent git on the git page; a grant also covers the other repos the session works in).`;
  }
}

/** The named-reason refusal text for a PUSH refused by governingGrant/effectiveGitPermission. */
function pushRefusal(reason, verb, where, label) {
  switch (reason) {
    case 'release-mode': return releaseModeRefusalText(verb);
    case 'repo-disabled':
    case 'repo-commit-off':
      return `orchard: \`git ${verb}\` ${where} refused — you turned this repo OFF for agent git${label ? ` under project "${label}"` : ''} (FEAT-190 per-repo opt-out).`;
    case 'repo-push-off':
      return `orchard: \`git ${verb}\` ${where} refused — pushes are off for this repo (FEAT-190); the commit stays local for the user to push.`;
    case 'dest-repo-disabled':
      return `orchard: \`git ${verb}\` ${where} refused — the DESTINATION repository is turned off for agent git${label ? ` by project "${label}"` : ''} (FEAT-190 per-repo opt-out). Re-enable it on the git page.`;
    case 'dest-repo-push-off':
      return `orchard: \`git ${verb}\` ${where} refused — pushes into the destination repository are off for agent git${label ? ` (project "${label}")` : ''} (FEAT-190 destination opt-out).`;
    case 'push-toggle-off':
      return `orchard: \`git ${verb}\` ${where} refused — the user granted commits but not pushes${label ? ` for project "${label}"` : ''} (FEAT-164). Leave the push to the user.`;
    default: // 'no-grant'
      return `orchard: \`git ${verb}\` ${where} refused — your session's project has no agent git grant covering this repo's push (FEAT-164/FEAT-190).`;
  }
}
/**
 * The target repo's work-tree toplevel, for the leak gate on a cross-repo write. FEAT-190 r9: this
 * is the RESOLVED target's toplevel (git-target resolved it with the invocation's own globals —
 * -C / --git-dir / --work-tree), NEVER the cwd's repo when a DIFFERENT target was resolved. A
 * `git --git-dir=Q/.git …` run from cwd=P was gating P instead of Q (IV 027bd822 FINDING 1); the
 * gate, the permission decision and the reach log must all name the one resolved repo.
 */
function targetToplevelOf(t, tgt) {
  if (tgt && typeof tgt.toplevel === 'string' && tgt.toplevel) return tgt.toplevel;
  // A resolved commonDir but no work tree (bare / no-worktree): nothing to gate here, and the cwd is
  // NOT this target's repo — return null rather than scan the wrong repo.
  if (tgt && typeof tgt.commonDir === 'string' && tgt.commonDir) return null;
  // No target resolved at all: the write is aimed at the cwd's own repo (no --git-dir redirect).
  const cwd = t && typeof t.cwd === 'string' && t.cwd ? t.cwd : null;
  if (cwd) { const id = repoIdentityOf(cwd); return id?.toplevel ?? cwd; }
  return null;
}

/**
 * THE PUSH AUTHORITY (FEAT-164; FEAT-190 r7 redesign). The ONLY place a push is decided. The shim
 * (decideByTarget) and the release CLI (release.mjs pushRelease) both call it, once per resolved
 * destination URL (git has already applied aliases / insteadOf / pushInsteadOf).
 *
 * The SESSION's grant governs the push FROM the source repo (governingGrant → effectiveGitPermission,
 * ONE call — the same derivation decideByTarget uses for a commit, so push can never fall narrower
 * than commit for an un-named reason). A push is allowed when that one call allows it AND no project
 * owning the DESTINATION has an EXPLICIT opt-out (the named push-only reason `destination-opt-out` —
 * the one sanctioned deny-site outside governingGrant, per the adjudicator; a co-owner of the SOURCE
 * repo is not a destination vetoer, it already folds into governingGrant's override). A scratch/
 * fixture source or destination is governed by the FEAT-108 store, not real policy, as before.
 * `key` is ALWAYS the SESSION project (its grant is claimed); `gateRepo` is the SOURCE repo's work
 * tree (the leak gate scans what is being published, never the destination).
 *   source: { commonDir?, cwd? }   url: one destination   → { refusal: string|null, key, gateRepo }
 */
export function decidePush({ source, url, projects, sessionProjectId, verb = 'push', fixtureRoots = defaultFixtureRoots(), release = false }) {
  const inFixture = (p) => typeof p === 'string' && fixtureRoots.some((r) => insideOrEqual(r, p));
  const cwd = source && typeof source.cwd === 'string' ? source.cwd : null;
  const cwdId = cwd ? repoIdentityOf(cwd) : null;
  const srcCommon = (source && typeof source.commonDir === 'string' && source.commonDir) || cwdId?.commonDir || null;
  // FEAT-190 r9 — the leak gate scans the SOURCE repo being published. That is the RESOLVED target
  // (git-target's toplevel, carried on `source.toplevel`), NOT the cwd's repo: a `git --git-dir=Q
  // push` run from cwd=P publishes Q, so its gate must scan Q (IV 027bd822 FINDING 1). Fall back to
  // the cwd only when no resolved toplevel was supplied (the release CLI, which operates on the
  // session's own repo and passes cwd alone).
  // FEAT-190 r10 — the leak gate scans the RESOLVED source toplevel ONLY. The old cwd fallback
  // (`cwdId?.toplevel || cwd`) gated the invoking cwd's repo when the resolved target was elsewhere
  // or bare (IV 4f6c97c8 FINDING 2: a bare `--git-dir=Q.git push` from cwd=OWN gated OWN). No
  // fallback: a source with no resolved work tree is refused by the invariant below (bare), and the
  // release CLI now passes `source.toplevel` explicitly.
  const srcTop = (source && typeof source.toplevel === 'string' && source.toplevel) || null;
  const gateRepo = srcTop;
  const out = (refusal, key) => ({ refusal, key, gateRepo });
  // FEAT-190 r11 — parse and classify the DESTINATION FIRST, because the fixture-source exemption
  // from the one-resolved-repo invariant (applied below) holds ONLY when the destination is ALSO
  // scratch/fixture. `destScratch` is true only for a local path inside a scratch/fixture root (a
  // throwaway bare remote); a network URL is NEVER scratch (a real remote). The destination's own
  // early outcome (allow a scratch dest / refuse a non-repo) is DEFERRED to after the invariant so
  // a bare/redirected FIXTURE source pushing to a NON-scratch destination is still caught.
  const session = Array.isArray(projects) ? (projects.find((q) => q.id === sessionProjectId) ?? null) : null;
  const pr = parseRemote(url, { base: cwd ?? undefined });                   // THE remote parser
  if (!pr) return out(`orchard: \`git ${verb}\` refused — its destination ${JSON.stringify(String(url).slice(0, 120))} cannot be parsed as a git remote (FEAT-164, fail closed).`, sessionProjectId);
  let tid = null; let where;
  let destScratch = false; let destRefusal = null;
  if (pr.kind === 'network') {
    where = `to ${pr.key}`;
  } else {
    tid = repoIdentityOf(pr.path);
    if (!tid || !tid.commonDir) {
      // Destination is not a repository: a scratch/fixture path is classified scratch (git/the store
      // gate it); anything else is refused (fail closed).
      where = `to ${pr.path}`;
      if (inFixture(pr.path)) destScratch = true;
      else destRefusal = `orchard: \`git ${verb}\` to ${pr.path} refused — the destination does not resolve to a repository (FEAT-164, fail closed).`;
    } else {
      where = `to ${tid.commonDir}`;
      const claim = projects.filter((p) => (p.localRemotes || []).some((r) => sameRepository(repoIdentityOf(r), tid)));
      const owned = ownersOfDir(tid.commonDir, projects).length || claim.length;
      // A push to an UNREGISTERED scratch destination (a repo under a fixture root that NO registered
      // project owns) is store-governed, not real policy (scratch-to-scratch / publishing to a
      // throwaway remote). A REGISTERED real repo's remote is NEVER scratch, so a scratch source can
      // never slip a push INTO a registered repo this way.
      if (!owned && inFixture(tid.commonDir)) destScratch = true;
    }
  }
  // FEAT-190 r10/r11 — the ONE-resolved-repo invariant on the SOURCE repo being published (the gate
  // scans srcTop, the permission uses srcCommon; they must be one scannable repo). A redirected
  // (git-dir≠work-tree) or bare source is refused, fail closed. The fixture-source exemption (a
  // scratch source is store-gated, not real policy) applies ONLY when the DESTINATION is also
  // scratch/fixture; a fixture source pushing to a REAL remote (any network URL, or a path outside
  // the scratch roots) gets the full invariant, so a bare/unscanned scratch history can never be
  // published to a registered project's real remote (FEAT-190 r11 door; IV 184b8f70).
  const srcIsFixture = inFixture(srcTop || '') || inFixture(srcCommon || '');
  if (srcCommon && !(srcIsFixture && destScratch)) {
    const inv = resolvedRepoRefusal({ commonDir: srcCommon, toplevel: srcTop, verb });
    if (inv) return out(inv, sessionProjectId);
  }
  // A non-repo real destination path is refused, fail closed (applied AFTER the invariant so a
  // bare/redirected FIXTURE source pushing to it is still caught above).
  if (destRefusal) return out(destRefusal, sessionProjectId);
  // THE one derivation (FEAT-190 r13): decidePush decides NOTHING itself — it resolves the inputs
  // (source grant + source opt-out via governingGrant; the DESTINATION opt-out via destinationOverride,
  // which now folds in the session's OWN repoOverrides for the destination — the r12 door A fix; the
  // scratch/fixture status of source AND destination) and hands them to the ONE chokepoint, then
  // renders its result. FEAT-190 r8 (RESCOPE): the push goes to WHATEVER remote the repo has — there
  // is no frozen-remote veto; the leak gate still runs on the source tree.
  const srcRepo = { commonDir: srcCommon, toplevel: srcTop };
  const gg = governingGrant({ session, repo: srcRepo, projects });
  const dstOverride = destinationOverride({
    destCommonDir: tid ? tid.commonDir : null,
    destNetworkKey: pr.kind === 'network' ? pr.key : null,
    session, projects, sessionProjectId, srcRepo,
  });
  const scratch = srcIsFixture && destScratch;
  const perm = effectiveGitPermission({ policy: gg.policy, live: gg.live, override: gg.override, dstOverride, verb, releasePush: release, scratch });
  if (!perm.push) {
    const label = session ? (session.name ?? session.id) : null;
    return out(pushRefusal(perm.reason, verb, where, label), sessionProjectId);
  }
  return out(null, sessionProjectId);
}

/**
 * THE WRITE decision (FEAT-164; FEAT-190 r7 redesign). Returns { refusal: string|null, key } where
 * `key` is ALWAYS the SESSION project (its grant is claimed; the store's blanket deny and the leak
 * gate run against it) — the four breaks were all "key became ANOTHER project's grant". A push is
 * delegated to decidePush. A non-push WRITE is governed by the SESSION's own grant applied to the
 * TARGET repo (governingGrant → effectiveGitPermission, the SAME one call decidePush uses):
 *   - init/clone (a NEW repo) → allowed; the session's own grant decides (store).
 *   - a scratch/fixture repo → the session's own grant decides (store); not real policy.
 *   - a real repo → the session's grant covers it (its own project repo, or any OTHER repo it works
 *     in — the cross-repo rule), unless a named reason refuses: release mode, a per-repo opt-out,
 *     another owner's explicit opt-out (deny-only), or no grant. A live timed grant lifts commits on
 *     the session's OWN repo only. When the session's OWN repo is ungranted the refusal is DEFERRED
 *     to the FEAT-108 store (its blanket deny + request/approve UX runs unchanged).
 * The leak gate scans the TARGET repo (`gateRepo`) when it is not the session's own project repo.
 *   projects: [{ id, name, commonDir, localRemotes, networkRemotes, tree, policy, timedGrantLive }]
 */
export function decideByTarget({ argv, target, sessionProjectId, projects, commonDirOf = gitCommonDirOf, fixtureRoots = defaultFixtureRoots() }) {
  const inFixture = (p) => typeof p === 'string' && fixtureRoots.some((r) => insideOrEqual(r, p));
  const fromArgv = verbOfArgv(argv);
  const t = target && typeof target === 'object' ? target : null;
  // FEAT-164 r4 (verify 73256821): ALIASES. The shim expands them with git's own config
  // resolution (git-target expandGitAliases). A shell alias runs arbitrary commands and an
  // unresolvable one is unknowable: both are treated as a potential push/write → refused. A
  // verb git does not know as a builtin, arriving WITHOUT that resolution, is refused too.
  if (t && (t.alias === 'shell' || t.alias === 'unresolved')) {
    return { refusal: `orchard: \`git ${fromArgv}\` refused — ${t.alias === 'shell' ? 'it is a shell (!) alias, which can run anything, including a push' : `its alias cannot be resolved (${t.aliasDetail ?? 'unknown'})`}; under the agent git policy it is treated as a potential push (FEAT-164).`, key: sessionProjectId };
  }
  if (!(t && t.resolvedVerb === true)) {
    const builtins = hostGitBuiltins();
    if (!builtins || !builtins.has(fromArgv)) return { refusal: `orchard: \`git ${fromArgv}\` refused — not a git builtin, and the command was not resolved (possible alias) by the invocation shim; treated as a potential push (FEAT-164, fail closed).`, key: sessionProjectId };
  }
  const verb = t && PUSH_VERBS.has(t.verb) ? t.verb : t && t.resolvedVerb === true && typeof t.verb === 'string' ? t.verb : fromArgv;
  if (PUSH_VERBS.has(verb)) {
    const urls = Array.isArray(t?.push?.urls) ? t.push.urls.filter((u) => typeof u === 'string' && u) : [];
    if (!urls.length) return { refusal: `orchard: \`git ${verb}\` refused — its destination could not be determined (FEAT-164, fail closed).`, key: sessionProjectId };
    // THE push authority (decidePush) for every destination; all must be allowed.
    const source = {
      commonDir: t && typeof t.commonDir === 'string' && path.isAbsolute(t.commonDir) ? t.commonDir : null,
      cwd: t && typeof t.cwd === 'string' && path.isAbsolute(t.cwd) ? t.cwd : null,
      // FEAT-190 r9 — carry the RESOLVED source toplevel so decidePush's leak gate scans the repo
      // git resolved, never the cwd's repo (a --git-dir push from another cwd gated the wrong repo).
      toplevel: t && typeof t.toplevel === 'string' && path.isAbsolute(t.toplevel) ? t.toplevel : null,
    };
    let last = null;
    for (const u of urls) {
      const d = decidePush({ source, url: u, projects, sessionProjectId, verb, fixtureRoots });
      if (d.refusal) return d;
      last = d;
    }
    return last;
  }
  if (t?.creating === true) {
    // FEAT-190 r11 — a new repo (init/clone) is allowed; emit the gateRepo it is created in (the
    // resolved toplevel, else the cwd) so the host scans THAT repo, never a substituted one. The
    // host fallback that gated the session's own repo for a null gateRepo is gone (fail closed).
    const gr = (t && typeof t.toplevel === 'string' && t.toplevel && path.isAbsolute(t.toplevel) ? t.toplevel : null)
      ?? (t && typeof t.cwd === 'string' && t.cwd && path.isAbsolute(t.cwd) ? t.cwd : null);
    return { refusal: null, key: sessionProjectId, ...(gr ? { gateRepo: gr } : {}) };
  }
  const session = Array.isArray(projects) ? (projects.find((q) => q.id === sessionProjectId) ?? null) : null;
  const d = t && typeof t.commonDir === 'string' && path.isAbsolute(t.commonDir) ? t.commonDir : null;
  // The TARGET's identity: the repository git resolved, or (unresolvable) the cwd's own repo/dir.
  // FEAT-190 r9 — carry the RESOLVED toplevel so the leak gate (targetToplevelOf) scans the repo git
  // resolved, never the cwd's repo for a --git-dir-redirected write (IV 027bd822 FINDING 1).
  const resolvedTop = t && typeof t.toplevel === 'string' && path.isAbsolute(t.toplevel) ? t.toplevel : null;
  let tgt = d ? { commonDir: d, toplevel: resolvedTop } : null;
  if (!d) {
    const cwd = t && typeof t.cwd === 'string' && path.isAbsolute(t.cwd) ? t.cwd : null;
    if (!cwd) return { refusal: `orchard: \`git ${verb}\` refused — its target repo could not be determined (FEAT-164, fail closed).`, key: sessionProjectId };
    let real = cwd; try { real = fs.realpathSync(cwd); } catch { /* keep */ }
    const own = repoIdentityOf(real);
    tgt = own?.commonDir ? { commonDir: own.commonDir, toplevel: own.toplevel } : { commonDir: null, toplevel: real };
  }
  const where = d ?? (t && t.cwd);
  // FEAT-190 r13 — fixture/scratch status is an INPUT to the chokepoint, not a short-circuit. A
  // scratch/fixture repo is NOT a real repo — the FEAT-108 store decides — which effectiveGitPermission
  // now expresses as an allow (reason 'scratch') UNLESS the user turned THIS repo off: an explicit
  // per-repo opt-out binds even for a fixture repo. The old `if (inFixture(where)) return allowed`
  // short-circuit NEVER read the opt-out, so a commit in a session-opted-out repo under a fixture root
  // was allowed while a push from it was refused — the r12 door B (the verbs disagreed). The gateRepo
  // (the fixture repo's OWN resolved toplevel) is still emitted from the allowed path below, so the
  // host scans the scratch repo being written, never a substitute.
  const scratch = inFixture(where);
  // FEAT-190 r10 — the ONE-resolved-repo invariant: a REAL resolved target whose git-dir and
  // work-tree diverge (any redirect channel), or a bare target, leaves the consumers acting on
  // different / unscannable repos — refuse, fail closed. A scratch target is store-governed, and a
  // plain cwd write (no resolved commonDir) is inherently one repo, so both skip this. (N=0
  // productive agent use of these forms, r10 evidence.)
  if (!scratch && tgt && typeof tgt.commonDir === 'string' && tgt.commonDir) {
    const inv = resolvedRepoRefusal({ commonDir: tgt.commonDir, toplevel: tgt.toplevel, verb }, { commonDirOf });
    if (inv) return { refusal: inv, key: sessionProjectId };
  }
  // A real repo: the SESSION's grant governs it (governingGrant → effectiveGitPermission, ONE call —
  // the single allow/deny authority; a scratch target routes through it too, via `scratch`).
  const gg = governingGrant({ session, repo: tgt, projects });
  const perm = effectiveGitPermission({ policy: gg.policy, live: gg.live, override: gg.override, verb, scratch });
  if (perm.commit) {
    // FEAT-190 r9/r10 — ALWAYS gate the RESOLVED target toplevel, even for the session's OWN repo
    // or a linked worktree of it (ownsRepo). The old `ownsRepo ? null` let the host fall back to the
    // registered MAIN worktree, so a leak staged only in a linked worktree committed un-gated (IV
    // 4f6c97c8 FINDING 1). The invariant above guarantees this toplevel is a real, scannable tree.
    const gateRepo = targetToplevelOf(t, tgt);
    return { refusal: null, key: sessionProjectId, ...(gateRepo ? { gateRepo } : {}) };
  }
  // The session's OWN project repo, ungranted → DEFER to the FEAT-108 store (its blanket deny +
  // request/approve UX runs unchanged); decideByTarget does not pre-empt it.
  if (perm.reason === 'no-grant' && gg.ownsRepo) return { refusal: null, key: sessionProjectId };
  const owners = tgt && tgt.commonDir ? ownersOfDir(tgt.commonDir, projects) : [];
  const other = owners.find((x) => x.id !== sessionProjectId) ?? owners[0] ?? null;
  const label = other ? (other.name ?? other.id) : null;
  return { refusal: writeRefusal(perm.reason, verb, `in ${where}`, label), key: sessionProjectId };
}

export function _clearCommonDirCache() { commonDirCache.clear(); repoDescCache.clear(); }

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
  const lines = ['## Git policy for this project (set by the user — FEAT-164/FEAT-190)'];
  if (policy.mode === 'scoped') {
    lines.push(`Agents may commit to this project's real repo${policy.push ? ' and push to its remote' : ' (NOT push — leave pushing to the user)'}.`);
    if (policy.scope) { lines.push("Follow the user's scope note (guidance; it never narrows what the grant allows):", '', ...policy.scope.split('\n').map((l) => `> ${l}`), ''); }
    lines.push(`This grant ALSO covers the OTHER real repos you work in here: you may commit${policy.push ? ' (and push to a repo\'s own existing remote)' : ''} in them too, unless the user turned a specific repo off. Every commit and push still runs the leak gate.`);
  } else {
    lines.push('Agent commits are granted here WITHOUT a scope note, so this project uses SOFT RELEASES: never commit or push to the real repo yourself (it is refused).');
    lines.push('Finished work reaches the repo only as a batched release commit with a version tag and a changelog, cut when enough verified tickets are ready:');
    lines.push(`- freeze your ticket's files: \`node ${orchardDir}/scripts/candidate.mjs freeze --id <T> --files … --check "<your test command>"\`;`);
    lines.push('- it needs an independent HOLDS bound to that candidate (independent-verify --ticket <T>, which verifies it while current) — nothing unverified ships;');
    lines.push(`- releases are cut automatically when due (at least ${policy.release.minTickets} verified tickets or one waiting ${policy.release.maxWaitHours} h, at most one per ${policy.release.minIntervalHours} h); \`node ${orchardDir}/scripts/release.mjs plan ${projectId}\` shows what is eligible.`);
    lines.push(policy.push ? 'Releases are pushed to the remote when cut.' : 'Releases are NOT pushed; the user pushes.');
    lines.push('Scratch and fixture repos (tests) are unaffected.');
  }
  return lines.join('\n');
}

/** One-line summary for UIs and CLIs. */
export function policySummary(policy) {
  if (!policy || policy.mode === 'none') return 'No agent commits (default)';
  if (policy.mode === 'scoped') return `Agents commit${policy.push ? ' and push' : ' (no push)'} — here and in other repos this session works in`;
  return `Soft releases: verified work batched into versioned release commits${policy.push ? ', pushed' : ''}`;
}
