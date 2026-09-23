/**
 * file-lock.mjs — FEAT-129. An advisory "file busy" lock that stops one
 * lane/session from silently CLOBBERING another's uncommitted work on a shared
 * working tree.
 *
 * WHY THIS EXISTS (the user, in FEAT-129): several sessions run on ONE project at
 * once, sometimes editing the SAME files. Every session and lane of a project
 * shares ONE working tree (agent-bridge sets `cwd = project.hostPath`; a container
 * bind-mounts the one repo). There is no private buffer — edits write straight to
 * disk. Two clobbers were MEASURED (agent-ad026*, agent-af0292*): a concurrent
 * lane's whole-tree `git checkout`/revert wiped a live lane's uncommitted hunk,
 * and a still-alive orphan's whole-file `Write` overwrote a live lane's file.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * NOT a re-guard of the Edit tool. The harness Edit tool already fails LOUD on a
 * stale read-modify-write (FEAT-129 confirmed it never silently clobbered). The
 * hazard is the WHOLE-FILE / git-mutation path — `Write`, `git checkout -- f`,
 * `git reset --hard`, `git stash`, `git show HEAD:f > f`, `echo … > f`, a verify
 * script that regenerates a file — none of which carry a staleness check. THAT is
 * what this covers, plus cross-session coordination (two orchestrators each
 * serialize only their OWN lanes; nothing locks the shared tree between them).
 *
 * ── The model: claim-on-mutate, reclaim-when-dead-or-stale ───────────────────
 * A lane CLAIMS a path before mutating it. The claim is a per-path lockfile taken
 * with O_EXCL (the reliable primitive the ticket named). A concurrent writer to a
 * path a DIFFERENT LIVE lane holds is told BUSY — the fail-loud signal the user
 * saw in the CLI — rather than overwriting. Same owner re-claiming its own path
 * just refreshes (the single-lane common case pays nothing). Edit ALSO claims —
 * not to guard Edit (it is already safe) but so a later foreign whole-file/git
 * write to that path is told busy.
 *
 * ── Reliability is the one hard requirement — never wedge, never lose ─────────
 *   • LIVENESS IS GROUND TRUTH, NOT A CLOCK (the round-1 defect, now fixed). A
 *     lock is live for exactly as long as its owning LANE is a live task. Each
 *     session process runs a HEARTBEAT (see refreshOwnedLocks) that re-stamps its
 *     held locks on a timer INDEPENDENT of tool calls, gated on the bridge's own
 *     running-set (`liveAgents()`, keyed on agent_id — the same authority
 *     harvest-agent/running-set.ts use). So a lane in ONE long tool call never
 *     goes stale (round-1's clobber), and a finished lane is released the instant
 *     it drops from the running-set. Cross-session needs no foreign probe: each
 *     process refreshes only its OWN locks; an observer just sees them stay fresh.
 *   • The TTL is now a pure BACKSTOP. reclaimReason still reclaims a lock whose
 *     recorded owner PROCESS is provably gone (`pidAlive` false — real for a dead
 *     FOREIGN session), and reclaims a lock untouched past the TTL — but a live
 *     lane's heartbeat keeps `refreshedAt` fresh, so the TTL only ever fires once
 *     the heartbeat has stopped (the whole owner process died). It is never the
 *     primary guard on a live lane.
 *   • Fail toward SERIALIZE, not clobber: an unresolvable lock error, or retry
 *     exhaustion under contention, returns BUSY (deny the mutation) rather than
 *     waving a silent overwrite through. The TTL still guarantees eventual release.
 *   • The reclaim itself is race-safe: rename-to-claim means only ONE contender
 *     can take a stale/dead lock; the loser retries and sees the winner's fresh
 *     lock (→ busy or self). Bounded retries, then fail-safe deny.
 *
 * ── Known residual (shared with the git-write block) ─────────────────────────
 * A mutation that never crosses the tool layer as a recognised shell command is
 * unseen: `python -c "open('f','w')…"`, a compiled helper, a wrapper script that
 * shells out internally. The classifier covers the common shell in-place editors
 * (Write/Edit, redirects, cp/mv/install/tee/dd/truncate, sed -i, perl -i, patch,
 * ex -c 'w…', and git-tree ops); a non-shell interpreter body is the same blind
 * spot FEAT-108's git-write block documents, and is out of scope for a shell-level
 * classifier — the fix would be a filesystem-level guard, not a command scan.
 *
 * Modelled on REVIVED_TASK_TTL_MS (agent-bridge.ts, 300_000ms) for the stale bound
 * and on liveness.ts `pidAlive` for the ground-truth rung — the project's existing
 * liveness authority, not a third invented one.
 *
 * Pure + injectable like git-write-policy/fable-tier: the classifier functions
 * touch no fs, and the store takes an injected `lockDir` so the runtime passes
 * `dataDir()/file-locks/<projectKey>` and the tests pass a scratch dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

/* ── The escape hatch, VISIBLE not silent (mirrors the git/Fable gates) ───────
 * `ORCHARD_ALLOW_FILE_CLOBBER=1` disables the lock for one dispatch. The runtime
 * announces it once per process, so an opened hatch is never quiet.
 */
export function fileLockEnabled(env = process.env) {
  const v = env.ORCHARD_ALLOW_FILE_CLOBBER;
  if (v == null) return true; // lock ON by default
  const s = String(v).trim().toLowerCase();
  return !(s === '1' || s === 'true' || s === 'yes' || s === 'on');
}

/** The stale bound: a lock untouched for this long is reclaimable even if we cannot probe the owner. */
export const FILE_LOCK_TTL_MS = Number(process.env.CLAUDE_STATION_FILE_LOCK_TTL_MS) || 300_000;
/** Bounded retries around the acquire loop (reclaim races converge fast; then fail-safe deny). */
const MAX_ACQUIRE_RETRIES = 8;

/* ────────────────────────────────────────────────── ground-truth reclaim rung
 *
 * The ONE pid-liveness check, same shape as liveness.ts `pidAlive`: pid <= 1 is
 * never a session process (0 = the group, 1 = init) and is refused rather than
 * probed. Kept local so this module has zero runtime dependency on src/**.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Is an existing lock reclaimable by a DIFFERENT owner? Ground truth first
 * (owner process provably dead on THIS host), TTL backstop last. Returns a
 * reason string when reclaimable, or null when it must stand (→ busy).
 */
export function reclaimReason(lock, now, ttlMs = FILE_LOCK_TTL_MS) {
  if (!lock || typeof lock !== 'object') return 'corrupt lock';
  const sameHost = lock.host === os.hostname();
  // Ground truth: only trust the pid when the lock was taken on THIS host, and the
  // pid is a real, checkable session pid. A dead owner is reclaimed with no wait.
  if (sameHost && Number.isInteger(lock.ownerPid) && lock.ownerPid > 1 && !pidAlive(lock.ownerPid)) {
    return `owner process (pid ${lock.ownerPid}) is gone`;
  }
  // TTL backstop: guarantees eventual release when the owner cannot be probed
  // (in-process lanes share the host pid) or is a live-but-moved-on lane.
  const refreshed = Number(lock.refreshedAt);
  if (!Number.isFinite(refreshed) || now - refreshed > ttlMs) {
    const age = Number.isFinite(refreshed) ? Math.round((now - refreshed) / 1000) : '∞';
    return `lock is stale (untouched ${age}s, limit ${Math.round(ttlMs / 1000)}s)`;
  }
  return null; // owner is live and fresh → stands
}

/* ─────────────────────────────────────────────────────── the per-path store */

/** Absolute-path → stable lockfile name. Hash keeps it filesystem-safe and short. */
function lockFileName(key) {
  return createHash('sha1').update(key).digest('hex') + '.lock';
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Atomically overwrite a lockfile we already own/reclaimed (temp + rename). */
function writeLockOver(file, meta) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(meta)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/**
 * Race-safe reclaim of a stale/dead lock: rename it aside FIRST. renameSync of the
 * same source succeeds for exactly one caller; every other gets ENOENT and retries
 * the whole acquire (seeing the winner's fresh lock). Returns true iff we won it.
 */
function tryReclaim(file) {
  const moved = `${file}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try { fs.renameSync(file, moved); } catch { return false; } // someone else already moved it
  try { fs.unlinkSync(moved); } catch { /* best effort */ }
  return true;
}

/**
 * Create a lockfile with FULL content, race-free: write the content to a unique
 * temp, then `link()` it into place. `link` is atomic and fails with EEXIST if the
 * target already exists — so exactly one creator wins a free path, AND the target
 * is NEVER observed empty (unlike O_EXCL-then-write, whose create/write window let
 * a concurrent reader see an empty file and wrongly "reclaim" it). Returns true on
 * win, false on EEXIST; rethrows any other error to the caller's fail-safe.
 */
function tryCreate(file, meta) {
  const tmp = `${file}.mk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(meta)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, file); return true; }
  catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
  finally { try { fs.unlinkSync(tmp); } catch { /* linked or gone */ } }
}

/** How long an UNPARSEABLE lockfile is treated as a create-in-progress before it may be reclaimed as garbage. */
const CORRUPT_GRACE_MS = 5_000;

/**
 * Claim ONE absolute path for `meta.owner`. Returns:
 *   { ok:true, mode:'acquired'|'refresh'|'reclaimed' }
 *   { ok:false, holder }            — a different LIVE owner holds it (BUSY)
 *   { ok:false, exhausted:true }    — retry storm under contention (fail-safe deny)
 * Never throws: an unresolvable fs error resolves to BUSY (fail toward serialize).
 */
function acquireOne(lockDir, key, meta, now, ttlMs) {
  const file = path.join(lockDir, lockFileName(key));
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch { /* raced dir create is fine */ }

  for (let attempt = 0; attempt < MAX_ACQUIRE_RETRIES; attempt++) {
    // Fast path: atomic link-create. Only one creator wins a free path, and the
    // target is never seen empty by a racer.
    try {
      if (tryCreate(file, { ...meta, key, acquiredAt: now, refreshedAt: now })) return { ok: true, mode: 'acquired', file };
    } catch (e) {
      return { ok: false, error: String(e.message || e), file }; // fail-safe: treat as busy
    }

    const existing = readLock(file);
    if (existing == null) {
      // Unparseable. With link-create a lock is never partially written, so this is
      // rare — but a fresh unparseable file may still be a create-in-progress from a
      // racer, so only reclaim it once it has aged past the grace (else back off).
      let ageOk = false;
      try { ageOk = now - fs.statSync(file).mtimeMs > CORRUPT_GRACE_MS; } catch { continue; }
      if (ageOk && tryReclaim(file)) continue;
      continue; // young/garbage or lost the reclaim race → retry
    }
    if (existing.owner === meta.owner) {
      // Ours: refresh in place, preserving the original acquire time.
      try { writeLockOver(file, { ...meta, key, acquiredAt: existing.acquiredAt ?? now, refreshedAt: now }); }
      catch (e) { return { ok: false, error: String(e.message || e), file }; }
      return { ok: true, mode: 'refresh', file };
    }
    const why = reclaimReason(existing, now, ttlMs);
    if (why) {
      if (tryReclaim(file)) continue; // won → loop reattempts the O_EXCL create
      continue;                       // lost → someone else reclaimed; retry
    }
    return { ok: false, holder: existing, file }; // live foreign owner → BUSY
  }
  return { ok: false, exhausted: true, file }; // fail-safe: deny, TTL still frees it later
}

/** Best-effort release of a path we just newly acquired (used to unwind a partial multi-path claim). */
function releaseOne(lockDir, key, owner) {
  const file = path.join(lockDir, lockFileName(key));
  const cur = readLock(file);
  if (cur && cur.owner === owner) { try { fs.unlinkSync(file); } catch { /* gone already */ } }
}

/**
 * Claim a SET of paths all-or-nothing. If any path is busy, unwind the ones this
 * call newly acquired (never orphan a half-claim) and report the first blocker.
 */
function claimPaths(lockDir, keys, meta, now, ttlMs) {
  const newlyAcquired = [];
  for (const key of keys) {
    const r = acquireOne(lockDir, key, meta, now, ttlMs);
    if (!r.ok) {
      for (const k of newlyAcquired) releaseOne(lockDir, k, meta.owner);
      return r; // busy | exhausted | error — all deny
    }
    if (r.mode === 'acquired' || r.mode === 'reclaimed') newlyAcquired.push(key);
  }
  return { ok: true };
}

/**
 * A whole-TREE mutation (`git reset --hard`, `git stash`, `git checkout <branch>`)
 * owns no path going forward — it is a one-shot. So it only READS the lock dir:
 * if ANY path is held by a different LIVE owner, the tree op would clobber that
 * lane's uncommitted work → BUSY. Otherwise allow (and reap stale/dead locks it
 * passes, so they never accumulate).
 */
function checkTree(lockDir, owner, now, ttlMs) {
  let files = [];
  try { files = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock')); } catch { return { ok: true }; }
  for (const f of files) {
    const file = path.join(lockDir, f);
    const lock = readLock(file);
    if (!lock) { tryReclaim(file); continue; }
    if (lock.owner === owner) continue;
    if (reclaimReason(lock, now, ttlMs)) { tryReclaim(file); continue; }
    return { ok: false, holder: lock }; // a live foreign lock a tree-wide op would wipe
  }
  return { ok: true };
}

/* ───────────────────────────────────────────── the pure mutation classifier
 *
 * What tool call mutates WHICH path(s)? Returns:
 *   { mutates:false }                        — a read / test / build / non-clobber
 *   { mutates:true, paths:[raw,…], kind }    — whole-file/path mutations
 *   { mutates:true, tree:true, kind }        — a whole-working-tree mutation
 * `paths` are RAW as written; the caller resolves them against the repo cwd.
 */
export function classifyMutation({ toolName, toolInput } = {}) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Write' || toolName === 'Edit') {
    const p = ti.file_path;
    return typeof p === 'string' && p ? { mutates: true, paths: [p], kind: toolName.toLowerCase() } : { mutates: false };
  }
  if (toolName === 'NotebookEdit') {
    const p = ti.notebook_path;
    return typeof p === 'string' && p ? { mutates: true, paths: [p], kind: 'notebook' } : { mutates: false };
  }
  if (toolName === 'MultiEdit') {
    const p = ti.file_path;
    return typeof p === 'string' && p ? { mutates: true, paths: [p], kind: 'edit' } : { mutates: false };
  }
  if (toolName === 'Bash') {
    const cmd = ti.command;
    return scanBashMutation(typeof cmd === 'string' ? cmd : '');
  }
  return { mutates: false };
}

/* ── Quote-aware segment tokenizer (same principle as git-write-policy) ────────
 * Keeps a quoted span as ONE token (so `sh -c '…'` bodies aren't shattered) and
 * splits into segments on ; && || | & and newline OUTSIDE quotes. Redirections
 * (`>`, `>|`, `N>`) are surfaced as their own marker tokens so a target file can
 * be read off the next token.
 */
function tokenizeSegments(str) {
  const segments = [];
  let cur = [], tok = '', hasTok = false;
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false; } };
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = []; } };
  let i = 0; const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === '\\') { tok += str[i + 1] ?? ''; hasTok = true; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const close = str.indexOf(ch, i + 1);
      if (close < 0) { tok += str.slice(i + 1); hasTok = true; break; }
      tok += str.slice(i + 1, close); hasTok = true; i = close + 1; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pushTok(); i++; continue; }
    if (ch === '\n' || ch === ';') { pushSeg(); i++; continue; }
    if (ch === '&') { pushSeg(); i += str[i + 1] === '&' ? 2 : 1; continue; }
    if (ch === '|') { pushSeg(); i += str[i + 1] === '|' ? 2 : 1; continue; }
    // Redirections: `>` and `>|` truncate (clobber); `>>` appends (not a clobber).
    // Also `N>` (fd-prefixed). Emit a marker so the next token is read as target.
    if (ch === '>') {
      pushTok();
      if (str[i + 1] === '>') { cur.push('__APPEND__'); i += 2; continue; }
      if (str[i + 1] === '|') { cur.push('__TRUNC__'); i += 2; continue; }
      cur.push('__TRUNC__'); i += 1; continue;
    }
    if (ch === '<') { pushTok(); cur.push('__IN__'); i++; continue; }
    tok += ch; hasTok = true; i++;
  }
  pushSeg();
  return segments;
}

const NOOP_HEADS = new Set(['command', 'nohup', 'time', 'builtin', '!', '{', '}',
  'then', 'else', 'elif', 'do', 'done', 'fi', 'in', 'if', 'for', 'while', 'until', 'case', 'esac', 'sudo']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXEC_C = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const basename = (w) => (w.includes('/') && !w.startsWith('-') ? w.slice(w.lastIndexOf('/') + 1) : w);

function headOf(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || NOOP_HEADS.has(tokens[i]))) i++;
  const rest = tokens.slice(i);
  if (!rest.length) return null;
  return { head: basename(rest[0]), args: rest.slice(1) };
}

/* git subcommands that mutate the WORKING TREE or index (can drop uncommitted work). */
const GIT_TREE_MUTATORS = new Set([
  'checkout', 'switch', 'restore', 'reset', 'stash', 'clean', 'rm', 'mv',
  'merge', 'rebase', 'revert', 'cherry-pick', 'pull', 'apply', 'am', 'read-tree', 'checkout-index',
]);
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree',
  '--namespace', '--exec-path', '--config-env', '--super-prefix', '--attr-source']);

/** Skip git's global options to reach the subcommand + its args. */
function gitSubcommand(tokens) {
  let i = 0; // tokens here EXCLUDE the leading 'git'
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--version' || t === '--help' || t === '-h') return null;
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    return { sub: t, args: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * A git tree-mutator's target: explicit pathspecs after `--` (or trailing bare
 * paths for pathspec-only verbs) → those paths; anything wider or ambiguous →
 * whole tree. Fail toward TREE (the safe, deny-if-any-lock direction).
 */
function gitMutationTarget(sub, args) {
  const dd = args.indexOf('--');
  if (dd >= 0) {
    const paths = args.slice(dd + 1).filter((a) => a && a !== '.');
    if (args.slice(dd + 1).includes('.')) return { tree: true };
    return paths.length ? { paths } : { tree: true };
  }
  // Pathspec-only verbs where trailing bare args are FILES (no branch ambiguity).
  if (sub === 'restore' || sub === 'rm' || sub === 'checkout-index') {
    const paths = args.filter((a) => !a.startsWith('-') && a !== '.');
    if (args.includes('.')) return { tree: true };
    return paths.length ? { paths } : { tree: true };
  }
  // checkout/switch/reset/stash/clean/merge/rebase/revert/… without `--`:
  // could switch branches or touch the whole tree → TREE (fail safe).
  return { tree: true };
}

/* ── Redirect targets that DISCARD, not clobber (BUG-176) ─────────────────────
 * A redirect whose target is `/dev/null` or another std stream / character device
 * destroys no lane's work — it is a bit bucket, not a file. `2>/dev/null` is
 * idiomatic on nearly every read-only command, so locking it injected refusal
 * ping-pong into read-only work (two lanes measured plain `ls`/`head` refused
 * purely for their `2>/dev/null`). Such a target must NEVER be locked.
 *
 * Matched by EXACT normalized path, never substring: a REGULAR file that merely
 * CONTAINS the text `/dev/null` (e.g. `./tmp/dev/null-notes.txt`) is NOT excluded
 * and stays locked exactly as before. Kept a PURE path test (no fs stat) to
 * preserve the classifier's no-fs invariant; the standard device nodes below are
 * the reachable cases — a redirect to a bespoke char device a lane created is not
 * a real contention shape and is out of scope.
 */
const DISCARD_REDIR_TARGETS = new Set([
  '/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom',
  '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/dev/console',
]);
function isDiscardRedirTarget(target) {
  if (typeof target !== 'string' || !target) return false;
  const norm = path.posix.normalize(target); // collapse `/dev//null`; touches no fs
  if (DISCARD_REDIR_TARGETS.has(norm)) return true;
  // fd dups exposed as pseudo-paths (`>/dev/fd/2`, `>/proc/self/fd/1`) are streams, not files.
  if (/^\/dev\/fd\/\d+$/.test(norm) || /^\/proc\/(self|\d+)\/fd\/\d+$/.test(norm)) return true;
  return false;
}

const REDIR_MARKERS = new Set(['__TRUNC__', '__APPEND__', '__IN__']);
/** Strip our redirection markers (and the target after an __IN__) from a token list for head parsing. */
function stripRedirs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '__TRUNC__' || t === '__APPEND__' || t === '__IN__') { i++; continue; } // drop marker + its target
    out.push(t);
  }
  return out;
}
/** Collect truncating-redirect targets (`> f`, `>| f`) from a segment; append is skipped. */
function redirTargets(tokens) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '__TRUNC__' && tokens[i + 1] != null && !REDIR_MARKERS.has(tokens[i + 1])) targets.push(tokens[i + 1]);
  }
  return targets;
}

/** Trailing bare (non-flag) positionals of an arg list. */
function positionals(args) { return args.filter((a) => !a.startsWith('-')); }

/**
 * Scan a Bash command for whole-file / git-tree mutations and their targets.
 * Recurses into `sh -c '…'` / `eval` / command substitutions and `env` preambles
 * (the same evasions git-write-policy covers). Read-only commands, appends, and
 * anything unrecognised are NOT mutations — the lock never fires on `ls`/`npm
 * test`/a git read, so two lanes on DIFFERENT files never contend (requirement 5).
 */
export function scanBashMutation(command, depth = 0) {
  if (typeof command !== 'string' || depth > 6) return { mutates: false };

  // Heredoc bodies are DATA — decide the opening line, but KEEP a redirect target
  // on that line (`cat > f <<EOF` clobbers f). Drop only the body.
  const heredoc = command.search(/<<-?\s*['"]?[A-Za-z_]/);
  const src = heredoc >= 0 ? command.slice(0, heredoc) : command;

  const subs = [];
  const flattened = src
    .replace(/\$\(([^()]*)\)/g, (_m, b) => { subs.push(b); return ' '; })
    .replace(/`([^`]*)`/g, (_m, b) => { subs.push(b); return ' '; });
  for (const body of subs) { const r = scanBashMutation(body, depth + 1); if (r.mutates) return r; }

  const allPaths = [];
  let kind = null;
  /*
   * The command's EFFECTIVE cwd, tracked across `&&`/`;`-joined segments so a
   * `cd sub && sed -i f` keys `f` as `sub/f`, not `f` (round-1 gap #b — a lane
   * holding `sub/f` and this one would otherwise get divergent keys and both
   * "own" the file). Relative to the command's start dir (the repo root the tool
   * runs in); `push()` prefixes it onto relative targets so the caller's
   * `lockKeyFor` resolves them correctly. An absolute `cd` switches the base.
   */
  let cwd = '';
  const push = (p) => { if (p) allPaths.push(path.isAbsolute(p) ? p : (cwd ? path.join(cwd, p) : p)); };
  for (const rawTokens of tokenizeSegments(flattened)) {
    // Any truncating redirect in this segment clobbers its target file, whatever
    // the command is (`git show HEAD:f > f`, `node gen.mjs > f`, `cat a b > f`).
    for (const t of redirTargets(rawTokens)) if (t && !isDiscardRedirTarget(t)) { push(t); kind ??= 'redirect'; }

    const tokens = stripRedirs(rawTokens);
    const h = headOf(tokens);
    if (!h) continue;
    const { head, args } = h;

    // `cd DIR` shifts the effective cwd for every LATER segment. `cd -` / `cd`
    // (to $OLDPWD / $HOME) is not statically resolvable → leave cwd unchanged
    // (conservative: the following mutation keys against the last known dir).
    if (head === 'cd') {
      const dir = args.find((a) => !a.startsWith('-'));
      if (dir) cwd = path.isAbsolute(dir) ? dir : (cwd ? path.join(cwd, dir) : dir);
      continue;
    }

    if (head === 'git') {
      const parsed = gitSubcommand(args);
      if (parsed && GIT_TREE_MUTATORS.has(parsed.sub)) {
        const tgt = gitMutationTarget(parsed.sub, parsed.args);
        if (tgt.tree) return { mutates: true, tree: true, kind: `git ${parsed.sub}` };
        for (const p of tgt.paths) push(p);
        kind = `git ${parsed.sub}`;
      }
      continue;
    }
    if (head === 'env') {
      let j = 0;
      while (j < args.length) {
        const a = args[j];
        if (ASSIGNMENT.test(a)) { j++; continue; }
        if (a === '-i' || a === '--ignore-environment' || a === '-') { j++; continue; }
        if (a === '-u' || a === '-C' || a === '-S') { j += 2; continue; }
        if (a.startsWith('-')) { j++; continue; }
        break;
      }
      const r = scanBashMutation(args.slice(j).join(' '), depth + 1);
      if (r.mutates) { if (r.tree) return r; for (const p of r.paths) push(p); }
      continue;
    }
    if (EXEC_C.has(head)) {
      const ci = args.indexOf('-c');
      if (ci >= 0 && args[ci + 1] != null) { const r = scanBashMutation(args[ci + 1], depth + 1); if (r.mutates) { if (r.tree) return r; for (const p of r.paths) push(p); } }
      continue;
    }
    if (head === 'eval') { const r = scanBashMutation(args.join(' '), depth + 1); if (r.mutates) { if (r.tree) return r; for (const p of r.paths) push(p); } continue; }

    // Whole-file overwriters. `cp/mv/install` clobber their DESTINATION (last
    // positional); `tee`/`dd`/`truncate`/`sed -i` clobber named files.
    if (head === 'cp' || head === 'mv' || head === 'install') {
      const pos = positionals(args);
      if (pos.length >= 2) { push(pos[pos.length - 1]); kind = head; } // dest
      continue;
    }
    if (head === 'tee') {
      if (!args.includes('-a') && !args.includes('--append')) for (const p of positionals(args)) { push(p); kind = 'tee'; }
      continue;
    }
    if (head === 'dd') { const of = args.find((a) => a.startsWith('of=')); if (of) { push(of.slice(3)); kind = 'dd'; } continue; }
    if (head === 'truncate') { for (const p of positionals(args)) { push(p); kind = 'truncate'; } continue; }
    if (head === 'sed') {
      const inPlace = args.some((a) => a === '-i' || a === '--in-place' || (a.startsWith('-i') && a.length > 2) || (a.startsWith('-') && !a.startsWith('--') && a.includes('i')));
      if (inPlace) for (const p of positionals(args).slice(1)) { push(p); kind = 'sed -i'; } // skip the script positional
      continue;
    }
    /*
     * perl -i (in-place edit). `perl -i -pe '…' f`, `perl -i.bak -pe '…' f`,
     * `perl -pi -e '…' f`. Round-1 gap: `sed -i` was covered but `perl -i` — the
     * other ubiquitous in-place editor — was not. Parse perl's short-flag
     * clusters: a cluster containing `i` (but not `--…`) means in-place; a
     * cluster containing `e`/`E` consumes the NEXT arg as the script (so it is
     * NOT a file); every remaining bare arg is a file. Only in-place perl
     * mutates a named file (plain perl writes to stdout).
     */
    if (head === 'perl') {
      let inPlace = false; const files = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a.startsWith('--')) continue;                    // long opt, no file
        if (a.startsWith('-')) {
          const cluster = a.slice(1);
          if (cluster.includes('i')) inPlace = true;         // -i / -i.bak / -pi
          if (/[eE]/.test(cluster)) k++;                     // -e/-E/-pe/-ne script is the next arg
          continue;
        }
        files.push(a);                                       // a bare positional → a file
      }
      if (inPlace) for (const p of files) { push(p); kind = 'perl -i'; }
      continue;
    }
    /*
     * patch — applies a diff, overwriting the target(s). `patch f < d.diff` and
     * `patch -pN f < d.diff` name the file explicitly (lock it). `patch -pN <
     * d.diff` takes its targets from the diff HEADERS, which we cannot see → fail
     * toward TREE (deny if ANY lock is held), the safe direction, since such a
     * patch can rewrite arbitrary tracked files.
     */
    if (head === 'patch') {
      const files = positionals(args).filter((a) => !/\.(diff|patch)$/i.test(a));
      // A `-i FILE` gives the patch INPUT, not a target; drop it (and its value).
      const iIdx = args.indexOf('-i');
      const inputVal = iIdx >= 0 ? args[iIdx + 1] : null;
      const targets = files.filter((f) => f !== inputVal);
      if (targets.length) { for (const p of targets) push(p); kind = 'patch'; }
      else return { mutates: true, tree: true, kind: 'patch' }; // target(s) come from the diff → whole tree
      continue;
    }
    /*
     * ex / vim -c scripted edits. `ex -s -c 'wq' f` writes f. `-c CMD` consumes
     * the next arg as the ex command (not a file); treat it as a mutation of its
     * file positionals only when a `-c` command actually WRITES (contains `w`),
     * so a scripted read (`ex -c 'q' f`) is not a false clobber.
     */
    if (head === 'ex' || head === 'vim' || head === 'vi' || head === 'nvim') {
      let writes = false; const files = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '-c' || a === '--cmd' || a === '+') { const cmd = args[++k] ?? ''; if (/\bw/.test(cmd) || /w/.test(cmd)) writes = true; continue; }
        if (a.startsWith('+')) { if (/w/.test(a.slice(1))) writes = true; continue; } // `+wq`
        if (a.startsWith('-')) continue;
        files.push(a);
      }
      if (writes) for (const p of files) { push(p); kind = 'ex'; }
      continue;
    }
  }
  return allPaths.length ? { mutates: true, paths: allPaths, kind: kind ?? 'write' } : { mutates: false };
}

/* ─────────────────────────────────────────────────────── the top-level decision */

/**
 * Resolve a path as far as it exists on disk, following symlinks. A Write to a
 * file that does not exist yet still resolves its (existing) directory + any
 * symlinked ancestor, so `sub -> ../real` keys the same as writing under `real`.
 * A symlinked FILE resolves to its target, so a lane locking the real path and
 * one writing THROUGH the symlink land on ONE key (round-1 gap #a).
 */
function realpathBestEffort(p) {
  try { return fs.realpathSync(p); } catch { /* not there yet */ }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { /* dir absent too */ }
  return p;
}

/**
 * Normalise a raw target to the lock KEY. A path UNDER the repo root keys by its
 * repo-RELATIVE path, so two sessions on the same project (whatever their absolute
 * cwd — a container's `/workspace/<id>` vs a direct session's hostPath) coordinate
 * on the same key. A path outside the repo keys by its absolute path.
 *
 * Both the target AND the repo root are realpath-resolved before the relative is
 * taken, so a symlinked target (or a symlinked repo root, e.g. a /tmp that is a
 * link to /private/tmp) can never split one file into two keys and let two lanes
 * both "own" it — the round-1 symlink clobber (gap #a).
 */
export function lockKeyFor(rawPath, repoRoot) {
  const absRaw = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot || process.cwd(), rawPath);
  const abs = realpathBestEffort(absRaw);
  if (repoRoot) {
    const root = realpathBestEffort(path.resolve(repoRoot));
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return abs;
}

/**
 * THE decision, called by the runtime's PreToolUse hook and by the tests (one
 * answer per repo). Classify the tool call, then claim its target(s) against the
 * shared lock dir. `{ allow, busy?, holder?, reason?, kind?, mode? }`.
 *
 * A busy result carries the holder so the refusal can name the lane, exactly the
 * "file locked by lane X" signal the user asked for.
 */
export function evaluateFileLock({
  toolName,
  toolInput,
  lockDir,
  repoRoot = null,
  owner,
  ownerPid = process.pid,
  now = Date.now(),
  ttlMs = FILE_LOCK_TTL_MS,
  env = process.env,
} = {}) {
  if (!fileLockEnabled(env)) return { allow: true };
  // Infrastructure gaps (no lock dir, no owner) degrade to today's behaviour —
  // there is nothing to coordinate against and wedging a session would be worse.
  if (!lockDir || !owner) return { allow: true };

  let cls;
  try { cls = classifyMutation({ toolName, toolInput }); } catch { return { allow: true }; }
  if (!cls.mutates) return { allow: true };

  const meta = { owner, ownerPid: Number.isInteger(ownerPid) ? ownerPid : null, host: os.hostname(), kind: cls.kind ?? null };

  try {
    if (cls.tree) {
      const r = checkTree(lockDir, owner, now, ttlMs);
      if (r.ok) return { allow: true, kind: cls.kind, tree: true };
      return { allow: false, busy: true, holder: r.holder, kind: cls.kind, tree: true, reason: busyRefusal(cls.kind, r.holder, { tree: true }) };
    }
    const keys = [...new Set((cls.paths || []).map((p) => lockKeyFor(p, repoRoot)))];
    if (!keys.length) return { allow: true, kind: cls.kind };
    const r = claimPaths(lockDir, keys, meta, now, ttlMs);
    if (r.ok) return { allow: true, kind: cls.kind };
    if (r.exhausted || r.error) return { allow: false, busy: true, kind: cls.kind, reason: busyRefusal(cls.kind, null, { exhausted: true, error: r.error }) };
    return { allow: false, busy: true, holder: r.holder, kind: cls.kind, reason: busyRefusal(cls.kind, r.holder, {}) };
  } catch (e) {
    // Fail toward SERIALIZE: an unexpected store error denies the mutation rather
    // than waving a possible clobber through. The TTL still frees the path later.
    return { allow: false, busy: true, kind: cls.kind, reason: busyRefusal(cls.kind, null, { error: String((e && e.message) || e) }) };
  }
}

/* ──────────────────────────────────────────── the HEARTBEAT — liveness, not a clock
 *
 * WHY THIS EXISTS (round-1 was BROKEN here). A lock's `refreshedAt` only ever
 * advanced on the SAME owner's NEXT mutating tool call. So a lane that claimed a
 * file, then ran ONE legitimate long tool call (a >5-min verify/build/`npm test`,
 * no mutating call to refresh), went stale at the TTL — and a foreign lane's write
 * was ALLOWED, clobbering the live lane's uncommitted work. That is the exact
 * BUG-157 "fixed timeout reclaimed live work" shape, and the WA lesson is: no fixed
 * timeout is safe on live work — decide liveness from GROUND TRUTH.
 *
 * The ground truth here is the OWNER'S OWN PROCESS plus the harness's running-set:
 * each session process runs this heartbeat on a timer INDEPENDENT of tool calls,
 * and re-stamps `refreshedAt` on every lock it holds whose owning lane is STILL a
 * live task (`isOwnerLive`, wired to the bridge's own `liveAgents()` running-set —
 * the same authority `harvest-agent`/running-set.ts use, keyed on the lane's
 * agent_id). Consequences, each a requirement the round-1 fix violated:
 *   • A live lane's lock NEVER goes stale, no matter how long its current tool call
 *     runs — the timer keeps refreshing it. (attack 1, closed.)
 *   • The moment a lane FINISHES it drops out of the running-set, so the heartbeat
 *     stops refreshing AND releases its lock now — a later lane on the same file is
 *     not falsely blocked (no wedge). Ground truth, not a timer, ends the hold.
 *   • If the whole process DIES, the timer dies with it: nothing refreshes those
 *     locks, and the TTL backstop (reclaimReason) frees them — the dead-owner path.
 * So `reclaimReason`'s TTL is now a BACKSTOP that only ever fires on a lock whose
 * heartbeat has stopped (owner process gone), never on a live lane. Cross-session
 * needs no foreign probing: each process refreshes only ITS OWN locks, and a
 * foreign observer simply sees a live owner's `refreshedAt` staying fresh.
 *
 * `isOwnerLive(owner)` returns false only when the lane is PROVABLY gone from the
 * running-set; anything it cannot resolve is treated as live (fail toward
 * never-clobber — a held-a-little-long lock is strictly better than a data loss).
 */

/** How often to heartbeat: comfortably below the TTL so a live lock is re-stamped several times per window. */
export function heartbeatIntervalMs(ttlMs = FILE_LOCK_TTL_MS) {
  return Math.min(120_000, Math.max(15_000, Math.floor(ttlMs / 4)));
}

/**
 * Refresh (or release) the locks THIS process owns. Called on a timer by the
 * runtime. For each lock created by this process (matched on `ownerPid` + `host`):
 *   • owner still live  → re-stamp `refreshedAt = now` (keeps it off the TTL).
 *   • owner provably gone → unlink it now (release; do not wait out the TTL).
 *   • owner UNJUDGEABLE  → leave completely alone (see below).
 * Foreign locks (another session's pid/host) are left untouched — that session's
 * own heartbeat minds them. Returns counts for the tests. Never throws.
 *
 * THE THIRD RUNG — `unknown`, added 2026-09-10 (FEAT-129 defect, filed same
 * ticket). `ownerPid` CANNOT distinguish sessions: every Orchard session runs
 * inside the one shared server process, so `process.pid` is byte-identical on
 * every lock every session writes on this host. The pid filter above therefore
 * does NOT restrict this loop to our own session's locks — it only restricts it
 * to this host's. `isOwnerLive` then met foreign owners on its "not ours to
 * judge" branch and answered `true`, so THIS session's heartbeat re-stamped a
 * DEAD session's lock, forever. `refreshedAt` — the one staleness signal — was
 * manufactured by the refresher, `reclaimReason`'s TTL backstop could never
 * fire, and dead sessions' locks were immortal for as long as any session
 * stayed open. Measured live 2026-09-08: four such locks in one project,
 * including `docs/HANDOFF.md`, all carrying the live session's byte-identical
 * `refreshedAt`.
 *
 * The fix keeps ARCH-010's shape — the owner declares the fact rather than the
 * reader re-deriving it. `isOwnerLive` now returns a THIRD value, `null`, for
 * "this owner is not mine to judge", and that answer is honoured here as
 * NEITHER live NOR dead: we do not refresh (so the lock ages honestly and the
 * TTL backstop can free it) and we do not release (never clobber a lock we
 * cannot prove is dead). A genuinely-live foreign session is unharmed — its OWN
 * heartbeat matches its own owner prefix and keeps its locks fresh, which is
 * exactly the invariant the doc comment above already claimed.
 *
 * `isOwnerLive` is optional and legacy callers may still return only booleans;
 * `undefined`/absent is read as live, preserving the never-clobber default.
 */
export function refreshOwnedLocks({ lockDir, ownerPid = process.pid, host = os.hostname(), isOwnerLive, now = Date.now() } = {}) {
  const out = { refreshed: 0, released: 0, skipped: 0, unjudged: 0 };
  if (!lockDir) return out;
  let files;
  try { files = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock')); } catch { return out; }
  for (const f of files) {
    const file = path.join(lockDir, f);
    const lock = readLock(file);
    if (!lock || typeof lock !== 'object') { out.skipped++; continue; }
    // Only touch locks THIS process created — never refresh a foreign owner's.
    // NOTE: on a shared server process this is a HOST filter, not a session
    // filter; the `null` rung below is what actually excludes foreign sessions.
    if (lock.host !== host || !Number.isInteger(lock.ownerPid) || lock.ownerPid !== ownerPid) { out.skipped++; continue; }
    const verdict = typeof isOwnerLive === 'function' ? isOwnerLive(lock.owner) : true;
    if (verdict === null) {
      // Not ours to judge → do not refresh (let it age), do not release (never
      // clobber). Its owning session's own heartbeat keeps it alive if live.
      out.unjudged++; out.skipped++;
      continue;
    }
    if (verdict === false) {
      // Provably finished lane → release now so its file is not falsely held.
      // Race-safe: only unlink if it is still ours (rename-aside then remove).
      if (tryReclaim(file)) out.released++; else out.skipped++;
      continue;
    }
    try { writeLockOver(file, { ...lock, refreshedAt: now }); out.refreshed++; } catch { out.skipped++; }
  }
  return out;
}

/** The fail-loud "file busy" message — the CLI behaviour the user cited, told to the agent. */
export function busyRefusal(kind, holder, { tree = false, exhausted = false, error = null } = {}) {
  const who = holder && holder.owner ? `\`${holder.owner}\`` : 'another live lane';
  const age = holder && Number.isFinite(Number(holder.refreshedAt))
    ? ` (held ${Math.round((Date.now() - Number(holder.refreshedAt)) / 1000)}s ago)` : '';
  const head = tree
    ? `File-busy lock: this ${kind || 'whole-tree'} operation would overwrite the working tree, but ${who} holds an uncommitted lock on a file in it${age}.`
    : `File-busy lock: the target is locked by ${who}${age} — a \`${kind || 'write'}\` here would silently drop that lane's uncommitted work.`;
  const tail = exhausted
    ? 'The lock store is under contention right now; this is a fail-safe deny (serialize, never clobber). Retry shortly — the lock auto-releases on a bound.'
    : error
      ? `The lock store could not be consulted cleanly (${error}); denying the mutation is the fail-safe direction. Retry shortly.`
      : 'Do not force it. Coordinate: wait for that lane to finish this file, edit a DIFFERENT file, or (if it is your own stale work) retry after the lock TTL. A crashed lane\'s lock auto-releases.';
  return [head, '', tail, '',
    'This is FEAT-129\'s advisory file lock: many sessions/lanes share ONE working tree, and a whole-file or git-tree write here would clobber a concurrent lane\'s unsaved edits with no staleness check. The lock is per-path and auto-releases when the owner dies or its TTL lapses, so it can never wedge a file forever.',
  ].join('\n');
}
