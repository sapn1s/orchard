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
/* ── BUG-277: the index-only `git apply --cached` exemption — a WHOLE-STRING match
 *
 * `git apply --cached <path>…` writes ONLY the index, never the working tree
 * (git-apply(1): "apply the patch to just the index, without touching the working
 * tree"), so it cannot clobber a concurrent lane's unsaved edits — the one hazard
 * this lock guards. It is the sanctioned form the landing flow uses to stage repo
 * patches (confirmed live: `git apply --cached scripts/git-write-policy.mjs.patch`,
 * plain repo-relative/absolute paths).
 *
 * Two earlier fixes tried to recognise this form by PARSING the command — r1 a
 * denylist over git-apply's flags, r2 a token allowlist plus a `GIT_*`/global-option
 * guard. BOTH were refuted: the classifier cannot model what the SHELL does before
 * git ever runs. `$(echo --reject)`, `{--reject,p.diff}`, a glob, `$VAR`, and an env
 * set earlier on the line (`export GIT_WORK_TREE=…;`, `env GIT_DIR=… git …`) all
 * change what git actually receives, yet tokenised to the exempt shape — so a
 * working-tree-writing apply was waved through under a foreign lock (run f02aa74c…).
 *
 * So we DO NOT parse shell for the exemption. It fires ONLY when the WHOLE Bash
 * command string, trimmed, is EXACTLY `git apply --cached` followed by one or more
 * space-separated plain path tokens — no leading `-` on any token (git would read
 * it as an option), no shell metacharacter ANYWHERE in the string ($ \ ` ( ) { }
 * [ ] * ? ; & | < > ' " \\ ~ ! newline tab, or a doubled/odd space), and no second
 * command. Anything else — any expansion, any env prefix, any extra flag, any other
 * command on the line — simply does not match, and falls back to today's tree
 * classification (fail-safe: the tree check denies only when a lock is actually
 * held). Over-refusal is acceptable and expected; under-refusal is the defect.
 *
 * The allowed token character classes deliberately exclude every shell metacharacter,
 * so the single regex both pins the shape AND rejects metacharacters by construction.
 * First token char excludes `-` (no option-leading path); `=`/`@` are permitted mid
 * token (harmless in a path, not shell-special). A trailing newline is stripped by
 * trim(); an EMBEDDED newline (a second command) survives and fails the anchored match.
 */
const INDEX_ONLY_APPLY_RE = /^git apply --cached( [A-Za-z0-9._/+][A-Za-z0-9._/+@=-]*)+$/;
export function isIndexOnlyApplyExempt(command) {
  return typeof command === 'string' && INDEX_ONLY_APPLY_RE.test(command.trim());
}

/* ── BUG-277 r4/r5: the WRAPPER-HOLE whole-tree safety net ─────────────────────
 *
 * The tokenizer only reaches git's classifier when `git` is the segment HEAD (or a
 * NOOP-head/`sh -c`/`env` preamble it unwraps). A WRAPPER that passes its args to git
 * without being one of those — `exec git …`, `xargs git …`, `timeout 5 git …`,
 * `nohup`/`command`-around forms not already unwrapped — never reaches the git branch,
 * so the segment classifies as NO mutation and a tree-wiping `git checkout`/`reset`/
 * `apply`/… slips every lock (proven live: run 7fe2cf90… for apply; and the r4 probe
 * showed the SAME hole for checkout/restore/reset/stash/clean — it is per-wrapper, not
 * per-verb). We do NOT try to model which wrapper it is: per the r3 lesson (the shell
 * does arbitrary things before git runs), we take a plain WHOLE-STRING regex. It
 * matches a `git` token followed — after only git's own global options — by any
 * GIT_TREE_MUTATORS verb. Over-refusal is acceptable and expected (e.g.
 * `echo "git apply …"` is refused); under-refusal is the defect this closes.
 *
 * r5 — run the net on EVERY top-level command, NOT only at the `mutates:false` exit.
 * r4 gated it on `mutates:false`, so a COMBINED line that carries BOTH a path-scoped
 * mutation AND a wrapped whole-tree mutator (`git checkout -- f; xargs git reset
 * --hard`) keyed the lock to `f` only and the wrapped `reset --hard` slipped (anthropic
 * run 648f8f34…). Now `scanBashMutation` COUNTS git-tree-mutator occurrences in the raw
 * string (`countGitTreeMutators`) and compares that with how many it classified as a
 * head `git` (scoped, or early-returned whole-tree). A SURPLUS means a git mutator the
 * tokenizer never saw — wrapped, or sitting beside an already-scoped one — so the line
 * mutates the whole tree: the union of what we scoped and the wrapped mutator, the
 * strongest wins. EQUAL counts mean every git mutator was seen and individually
 * classified, so a CLEAN `git checkout -- f` (count 1 = head 1) keeps its narrow
 * per-file key, not widened to the tree.
 *
 * The verb must sit in the SUBCOMMAND position (after `git` and its global options
 * only), so a mutator word inside a later arg — `git commit -m "apply the reset fix"`
 * — does NOT match and a benign commit is never refused. Global value-options
 * (`-C <dir>`, `-c <cfg>`, …) consume their following value so `git -C . apply` still
 * matches. `git` must be a standalone/pathed token (`/usr/bin/git`, `(git …`,
 * `` `git … ``), never a substring (`digit`, `mygit`).
 *
 * ── OUT OF CONTRACT (accepted residual, pinned below) ────────────────────────
 * This guard protects against MISTAKES by non-malicious agents (the user's stated
 * intent: "stop autonomous noise and broken main, not malicious agents"). DELIBERATELY
 * OBFUSCATED shell is out of contract and NOT closed here — a text classifier cannot
 * close shell obfuscation, and no agent writes these by accident:
 *   • a quoted or escaped command word — `exec 'git' reset`, `g\it reset`;
 *   • an ANSI-C quoted verb — `exec git $'reset'`;
 *   • a backslash-newline inside the command word — `g\<newline>it reset`;
 *   • a `-C` global value that itself contains a space — `exec git -C 'a b' reset`.
 * Each tokenises/reads to something the whole-string regex does not match, so it
 * classifies NOT-whole-tree and would slip a foreign lock. The forms are PINNED as
 * "accepted out-of-contract" in the verify suite (section 10) so a silent change to
 * their classification is noticed; they are documented, not silently ignored.
 */
const _GIT_GLOBAL_VALUE_OPT = '-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix|--attr-source';
const _GIT_GLOBAL_OPT = `(?:(?:${_GIT_GLOBAL_VALUE_OPT})[ \\t]+\\S+|--?[^\\s]+)`;
// longest-first where a verb is a prefix of another (checkout-index before checkout).
const _GIT_TREE_MUTATOR_VERB = 'checkout-index|checkout|cherry-pick|read-tree|switch|restore|reset|rebase|revert|stash|clean|rm|mv|merge|pull|apply|am';
const _WRAPPED_GIT_TREE_MUTATOR_SRC = `(?<![\\w-])git[ \\t]+(?:${_GIT_GLOBAL_OPT}[ \\t]+)*(?:${_GIT_TREE_MUTATOR_VERB})(?![\\w-])`;
const WRAPPED_GIT_TREE_MUTATOR_RE = new RegExp(_WRAPPED_GIT_TREE_MUTATOR_SRC);
const WRAPPED_GIT_TREE_MUTATOR_RE_G = new RegExp(_WRAPPED_GIT_TREE_MUTATOR_SRC, 'g');
export function hasWrappedGitTreeMutator(command) {
  return typeof command === 'string' && WRAPPED_GIT_TREE_MUTATOR_RE.test(command);
}
/** How many `git <global-opts> <tree-mutator-verb>` occurrences the raw string carries (r5). */
export function countGitTreeMutators(command) {
  if (typeof command !== 'string') return 0;
  const m = command.match(WRAPPED_GIT_TREE_MUTATOR_RE_G);
  return m ? m.length : 0;
}

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
    /*
     * Round 4 (10-11 verify): a SUBSHELL `( … )` is its own scope. Unhandled,
     * `(cd sub && sed -i s/a/b/ f)` tokenised as head `(cd` (so the cd was never
     * applied) and target `f)` — the clobber walked straight past. `(` / `)` now
     * close the current segment and emit scope markers; the scanner pushes and
     * pops its cwd/vars on them, exactly as bash scopes a subshell.
     */
    if (ch === '(') { pushSeg(); segments.push([SUB_OPEN]); i++; continue; }
    if (ch === ')') { pushSeg(); segments.push([SUB_CLOSE]); i++; continue; }
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

const SUB_OPEN = '__SUB_OPEN__';
const SUB_CLOSE = '__SUB_CLOSE__';

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

/**
 * Skip git's global options to reach the subcommand + its args. Also returns the
 * `-C <dir>` chain (round 4, 10-11 verify): git resolves pathspecs against the
 * `-C` dir, so `git -C sub checkout -- f` rewrites `sub/f` — keying it `f` let a
 * lock on `sub/f` be bypassed. Successive `-C`s compose, as git documents.
 */
function gitSubcommand(tokens) {
  let i = 0; // tokens here EXCLUDE the leading 'git'
  const cdirs = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--version' || t === '--help' || t === '-h') return null;
    if (t === '-C') { if (tokens[i + 1] != null) cdirs.push(tokens[i + 1]); i += 2; continue; }
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    return { sub: t, args: tokens.slice(i + 1), cdirs };
  }
  return null;
}

/**
 * A git tree-mutator's target: explicit pathspecs after `--` (or trailing bare
 * paths for pathspec-only verbs) → those paths; anything wider or ambiguous →
 * whole tree. Fail toward TREE (the safe, deny-if-any-lock direction).
 */
function gitMutationTarget(sub, args) {
  // NOTE (BUG-277): the index-only `git apply --cached` exemption is NOT decided
  // here. Parsing git-apply's flags to recognise the index-only form proved
  // unsound (r1 denylist, r2 token allowlist — both BROKEN by shell expansion and
  // env prefixes the classifier does not model). The exemption now fires ONLY on
  // a whole-command-string match at the top of `scanBashMutation`
  // (`isIndexOnlyApplyExempt`); EVERY `git apply` that reaches this classifier is
  // treated as a potential working-tree write, exactly as it was pre-exemption.
  //
  // BUG-277 r4: `apply` and `am` read PATCH/MBOX files — their tokens after `--`
  // are files to READ, NOT written pathspecs. The generic `--` branch below wrongly
  // keyed `git apply -- p.patch` / `git apply --cached -- p.patch` to the patch file
  // `p`, so a foreign lock on any OTHER file was slipped and the tree-writing apply
  // was ALLOWED (anthropic run 7fe2cf90…). Neither verb ever writes a NAMED pathspec,
  // so both are unconditionally whole-tree here. The one sanctioned exception —
  // `git apply --cached <path>…` writing only the index — is handled earlier, as a
  // whole-command-string exemption at the top of scanBashMutation, never here.
  if (sub === 'apply' || sub === 'am') return { tree: true };
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

/* ── Heredocs (round 4, 10-11 verify) ───────────────────────────────────────────
 * A heredoc BODY is data, but everything else on its opening line is code. The
 * old scanner cut the whole command at the first `<<`, so `cat <<'EOF' > f` and
 * `cat <<EOF | tee f` — the commonest agent file-writing idiom — dropped the
 * `> f` / `| tee f` that FOLLOWS the operator and classified as no mutation.
 * Now: per line, each `<<[-]DELIM` operator is removed IN PLACE (the rest of the
 * line is kept), and the body lines up to the delimiter are lifted out. A body
 * fed to a shell (`bash <<EOF`, `sudo sh -s <<EOF`) IS code and is scanned too.
 * Quote-unaware on purpose, like the old cut: `"$(cat <<'EOF' … EOF)"` (the
 * commit-message idiom) puts the operator inside double quotes, and bash still
 * parses it as a heredoc there.
 */
const HEREDOC_OP = /(^|[^<])<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\3/g;
function splitHeredocs(command) {
  const lines = command.split('\n');
  const out = []; const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ops = [];
    out.push(line.replace(HEREDOC_OP, (_m, pre, dash, _q, delim, offset) => {
      ops.push({ dash: !!dash, delim, before: line.slice(0, offset + pre.length) });
      return `${pre} `;
    }));
    for (const op of ops) {
      const body = [];
      while (i + 1 < lines.length) {
        const l = lines[++i];
        const cmp = op.dash ? l.replace(/^\t+/, '') : l;
        if (cmp === op.delim || cmp.trim() === op.delim) break;
        body.push(l);
      }
      bodies.push({ body: body.join('\n'), before: op.before });
    }
  }
  return { src: out.join('\n'), bodies };
}
/** Does the text before a heredoc operator end in a shell that will EXECUTE the body? */
function heredocFeedsShell(before) {
  const segs = tokenizeSegments(before).filter((s) => s[0] !== SUB_OPEN && s[0] !== SUB_CLOSE);
  const last = segs[segs.length - 1];
  if (!last) return false;
  const h = headOf(stripRedirs(last));
  return !!h && EXEC_C.has(h.head) && !h.args.includes('-c');
}

/* ── Unexpanded shell syntax in a write target (round 4) ────────────────────────
 * A target like `src/seed/content/en/$f.ts` used to be locked under its LITERAL
 * text, a key no real write ever produces — so it collided with nothing and the
 * write was waved through with an illusion of protection. Measured on this
 * machine's transcripts (170k Bash calls): a THIRD of all path-mutating commands
 * carry such a target, half with a LEADING variable (`$S/x`, `~/x`, `$D/x` —
 * mostly scratch dirs assigned earlier in the same command).
 *
 * So the policy is RESOLVE FIRST, then be conservative about the remainder:
 *  1. Resolve what the command itself pins: `X=lit` / `export X=…` assignments
 *     (in order, subshell-scoped), `for f in a b c` lists, brace lists `{a,b}`,
 *     `~` / `$HOME`, `$PWD`. Those become EXACT keys and are held like any path.
 *  2. A temp target (`$(mktemp …)` without an explicit dir, `$TMPDIR`) is outside
 *     the project and cannot clobber its tree → no lock.
 *  3. What is still unresolved (`$1`, `$(cmd)`, an unassigned var, `read f`)
 *     becomes a SCOPE: the static directory prefix before the first unresolved
 *     piece. The decision then refuses if ANY live foreign lock sits under that
 *     directory — or under the whole tree when even the root is unknown (a
 *     leading unresolved var could point anywhere). Check-only, no hold: holding
 *     a directory for a lane's whole life would wedge every other session out of
 *     it. Never a literal key, never a silent skip.
 * Markers are private code points the tokenizer passes through untouched.
 */
const UNK = '\u0001'; // unresolvable expansion
const OUT = '\u0002'; // rooted in a temp dir — outside any project tree
const MAX_EXPANSIONS = 64;
const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|\{[^}]*\}|[0-9@*#?$!-])/;

/** `$(mktemp …)` → where its output lives: OUT (temp dir), DIR/UNK (explicit dir), or UNK. */
function mktempValue(body) {
  const segs = tokenizeSegments(body);
  if (segs.length !== 1) return UNK;
  const h = headOf(stripRedirs(segs[0]));
  if (!h || h.head !== 'mktemp') return UNK;
  let dir = null, tflag = false; const pos = [];
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    if (a === '-p') { dir = h.args[++k] ?? ''; continue; }
    if (a === '--tmpdir') { tflag = true; continue; }
    if (a.startsWith('--tmpdir=')) { dir = a.slice('--tmpdir='.length); continue; }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-p') && a.length > 2) { dir = a.slice(2); continue; }
    if (a.startsWith('-')) { if (a.slice(1).includes('t')) tflag = true; continue; }
    pos.push(a);
  }
  if (dir != null && dir !== '') return `${dir.replace(/\/+$/, '')}/${UNK}`;
  if (tflag || dir === '' || !pos.length) return OUT;
  return pos[0].includes('/') ? `${path.posix.dirname(pos[0])}/${UNK}` : UNK; // a bare template lands in cwd
}

/** One level of brace-list expansion (`a/{b,c}.ts`), recursive; null when it explodes. */
function braceExpand(s) {
  const m = /(^|[^$])\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m) return [s];
  const start = m.index + m[1].length; const end = start + m[2].length + 2;
  const out = [];
  for (const alt of m[2].split(',')) {
    const sub = braceExpand(s.slice(0, start) + alt + s.slice(end));
    if (!sub) return null;
    out.push(...sub);
    if (out.length > MAX_EXPANSIONS) return null;
  }
  return out;
}

/** Expand one shell word against the statically-known vars → candidate strings (may hold UNK/OUT). */
function expandWord(word, vars, home) {
  let words = braceExpand(word) ?? [UNK];
  words = words.map((w) => (w === '~' ? home : w.startsWith('~/') ? home + w.slice(1) : /^~[^/]/.test(w) ? UNK + w.slice(w.indexOf('/') >>> 0) : w));
  for (let guard = 0; guard < 16; guard++) {
    let changed = false; const next = [];
    for (const w of words) {
      const m = VAR_REF.exec(w);
      if (!m) { next.push(w); continue; }
      changed = true;
      const name = m[1] || m[2];
      let vals;
      if (!name) vals = [UNK];
      else if (vars.has(name)) vals = vars.get(name);
      else if (name === 'HOME') vals = [home];
      else if (name === 'PWD') vals = ['.'];
      else if (name === 'TMPDIR' || name === 'TMP' || name === 'TEMP') vals = [OUT];
      else vals = [UNK];
      for (const v of vals) next.push(w.slice(0, m.index) + v + w.slice(m.index + m[0].length));
    }
    words = next.length > MAX_EXPANSIONS ? [UNK] : next;
    if (!changed) break;
  }
  return words;
}

/**
 * Place an expanded word relative to the effective cwd →
 *   { kind:'path', path } | { kind:'scope', dir: string|null } | { kind:'outside' }.
 * `dir: null` = the root itself is unknown (a leading unresolved piece);
 * `dir: ''` = the command's start dir (the repo root).
 */
function placeExpanded(p, cwd) {
  if (p.startsWith(OUT)) return { kind: 'outside' };
  p = p.split(OUT).join(UNK);
  if (p.startsWith(UNK)) return { kind: 'scope', dir: null };
  let full;
  if (path.posix.isAbsolute(p)) full = p;
  else if (cwd.startsWith(OUT)) return { kind: 'outside' };
  else if (cwd.startsWith(UNK)) return { kind: 'scope', dir: null };
  else full = cwd ? `${cwd}/${p}` : p;
  const u = full.indexOf(UNK);
  if (u < 0) return { kind: 'path', path: path.posix.normalize(full) };
  const prefix = full.slice(0, u);
  const slash = prefix.lastIndexOf('/');
  const dir = slash >= 0 ? prefix.slice(0, slash) : '';
  if (path.posix.isAbsolute(full) && !dir) return { kind: 'scope', dir: null };
  return { kind: 'scope', dir: dir ? path.posix.normalize(dir) : '' };
}

const DECLARE_HEADS = new Set(['export', 'local', 'declare', 'readonly', 'typeset']);

/**
 * Scan a Bash command for whole-file / git-tree mutations and their targets.
 * Recurses into `sh -c '…'` / `eval` / command substitutions / shell-fed heredocs
 * and `env` preambles (the same evasions git-write-policy covers). Read-only
 * commands, appends, and anything unrecognised are NOT mutations — the lock never
 * fires on `ls`/`npm test`/a git read, so two lanes on DIFFERENT files never
 * contend (requirement 5).
 *
 * Returns `{ mutates:false }`, `{ mutates:true, tree:true, kind }`, or
 * `{ mutates:true, paths:[…], scopes:[{dir, raw}], kind }` — `scopes` are the
 * unresolvable targets (see the round-4 block above); `dir:null` means "anywhere".
 */
export function scanBashMutation(command, depth = 0, ctx = null) {
  if (typeof command !== 'string' || depth > 6) return { mutates: false };
  // BUG-277: the whole-command index-only `git apply --cached <path>…` exemption
  // is a top-level property of the RAW command the user ran — decided ONLY at
  // depth 0, never on a recursively-scanned fragment (a `sh -c`/`eval`/subshell
  // body is NOT the raw command and gets no exemption). See isIndexOnlyApplyExempt.
  if (depth === 0 && isIndexOnlyApplyExempt(command)) return { mutates: false };
  const home = (ctx && ctx.home) || os.homedir();
  let vars = new Map(ctx && ctx.vars ? ctx.vars : []);

  const { src, bodies } = splitHeredocs(command);

  // Command substitutions become a marker IN the word they sit in (`"$(pwd)/f"`
  // stays one unresolved word rather than collapsing to `/f`); `$(mktemp)` is
  // placed (temp dir vs explicit dir). Their bodies are scanned for mutations too.
  const subs = [];
  const flattened = src
    .replace(/\$\(([^()]*)\)/g, (_m, b) => { subs.push(b); return mktempValue(b); })
    .replace(/`([^`]*)`/g, (_m, b) => { subs.push(b); return mktempValue(b); });

  const allPaths = [];
  const scopes = [];
  let kind = null;
  // r5: how many git tree-mutators the tokenizer saw as a head `git` subcommand.
  // Compared at the exit with countGitTreeMutators(command): a surplus in the raw
  // string is a wrapped/combined-line mutator the tokenizer missed → whole-tree.
  let gitHeadMutators = 0;
  /*
   * The command's EFFECTIVE cwd, tracked across `&&`/`;`-joined segments so a
   * `cd sub && sed -i f` keys `f` as `sub/f`, not `f` (round-1 gap #b), and
   * scoped by subshells (round 4). Relative to the command's start dir (the repo
   * root the tool runs in). May itself carry UNK/OUT when `cd` went somewhere
   * unresolvable or temporary.
   */
  let cwd = '';
  const stack = [];
  const place = (e, raw) => {
    const r = placeExpanded(e, cwd);
    if (r.kind === 'path') allPaths.push(r.path);
    else if (r.kind === 'scope') scopes.push({ dir: r.dir, raw });
  };
  const push = (p) => { if (p) for (const e of expandWord(p, vars, home)) place(e, p); };
  /** Fold a recursive scan's result in, re-rooted at the current cwd. */
  const merge = (r) => {
    if (!r || !r.mutates) return null;
    if (r.tree) return r;
    // r5: carry the child's resolved git-mutator count up so the depth-0 net
    // discounts a git mutator classified through recursion (`sh -c "git checkout
    // -- f"`), not just a direct head `git`. Else the raw-string regex count would
    // exceed the (direct-only) head count and falsely widen the recursed scope.
    gitHeadMutators += r.gitMutators || 0;
    for (const p of r.paths || []) place(p, p);
    for (const s of r.scopes || []) {
      if (s.dir == null) scopes.push(s);
      else place(`${s.dir ? `${s.dir}/` : ''}${UNK}`, s.raw);
    }
    kind ??= r.kind;
    return null;
  };
  const sub = (cmd) => merge(scanBashMutation(cmd, depth + 1, { vars, home }));

  for (const body of subs) { const t = sub(body); if (t) return t; }
  for (const b of bodies) if (heredocFeedsShell(b.before)) { const t = sub(b.body); if (t) return t; }

  for (const rawTokens of tokenizeSegments(flattened)) {
    if (rawTokens[0] === SUB_OPEN) { stack.push({ cwd, vars: new Map(vars) }); continue; }
    if (rawTokens[0] === SUB_CLOSE) { const f = stack.pop(); if (f) { cwd = f.cwd; vars = f.vars; } continue; }

    // Any truncating redirect in this segment clobbers its target file, whatever
    // the command is (`git show HEAD:f > f`, `node gen.mjs > f`, `cat a b > f`).
    for (const t of redirTargets(rawTokens)) if (t && !isDiscardRedirTarget(t)) { push(t); kind ??= 'redirect'; }

    const tokens = stripRedirs(rawTokens);

    // Static variable bindings (round 4). A segment of ONLY assignments, or an
    // export/local/declare, binds for later segments; `for v in …` binds v to the
    // list; `read v` binds v to "unknown". A prefix assignment on a command
    // (`X=1 cmd`) scopes to that command only and is not recorded.
    if (tokens.length && tokens.every((t) => ASSIGNMENT.test(t))) {
      for (const t of tokens) { const eq = t.indexOf('='); vars.set(t.slice(0, eq), expandWord(t.slice(eq + 1), vars, home)); }
      continue;
    }
    if (tokens[0] === 'for' && tokens[1]) {
      vars.set(tokens[1], tokens[2] === 'in' ? tokens.slice(3).flatMap((w) => expandWord(w, vars, home)) : [UNK]);
      continue;
    }

    const h = headOf(tokens);
    if (!h) continue;
    const { head, args } = h;

    if (DECLARE_HEADS.has(head)) {
      for (const a of args) { if (ASSIGNMENT.test(a)) { const eq = a.indexOf('='); vars.set(a.slice(0, eq), expandWord(a.slice(eq + 1), vars, home)); } }
      continue;
    }
    if (head === 'read') { for (const a of positionals(args)) vars.set(a, [UNK]); continue; }

    // `cd DIR` shifts the effective cwd for every LATER segment (until the
    // enclosing subshell closes). `cd -` / bare `cd` is not statically resolvable
    // → leave cwd unchanged (conservative: keys against the last known dir).
    if (head === 'cd') {
      const dir = args.find((a) => !a.startsWith('-'));
      if (dir) {
        const ex = expandWord(dir, vars, home);
        let r;
        if (ex.length === 1) r = placeExpanded(ex[0], cwd);
        else {
          // Several candidates (a `for d in a b` var): scope to their common dir.
          const placed = ex.map((e) => placeExpanded(e, cwd));
          if (placed.every((x) => x.kind === 'path')) {
            const parts = placed.map((x) => x.path.split('/'));
            const common = [];
            for (let k = 0; parts.every((p) => k < p.length - 1 && p[k] === parts[0][k]); k++) common.push(parts[0][k]);
            const j = common.join('/');
            r = { kind: 'scope', dir: j ? j : (path.posix.isAbsolute(placed[0].path) ? null : '') };
          } else r = { kind: 'scope', dir: null };
        }
        cwd = r.kind === 'path' ? r.path : r.kind === 'outside' ? OUT : r.dir ? `${r.dir}/${UNK}` : UNK;
      }
      continue;
    }

    if (head === 'git') {
      const parsed = gitSubcommand(args);
      if (parsed && GIT_TREE_MUTATORS.has(parsed.sub)) {
        gitHeadMutators++; // seen as a head git subcommand; the net discounts it
        const tgt = gitMutationTarget(parsed.sub, parsed.args);
        if (tgt.tree) return { mutates: true, tree: true, kind: `git ${parsed.sub}` };
        // `git -C a -C b …` resolves pathspecs under a/b (absolute -C resets the base).
        let pre = '';
        for (const d of parsed.cdirs) pre = path.posix.isAbsolute(d) ? d : (pre ? `${pre}/${d}` : d);
        for (const p of tgt.paths) push(pre && !path.posix.isAbsolute(p) ? `${pre}/${p}` : p);
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
      const t = sub(args.slice(j).join(' ')); if (t) return t;
      continue;
    }
    if (EXEC_C.has(head)) {
      const ci = args.indexOf('-c');
      if (ci >= 0 && args[ci + 1] != null) { const t = sub(args[ci + 1]); if (t) return t; }
      continue;
    }
    if (head === 'eval') { const t = sub(args.join(' ')); if (t) return t; continue; }

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
    /*
     * sed. Round 4 (10-11 verify): the long form `--in-place=SUFFIX` was missed
     * (only an exact `--in-place` matched). Parse sed's options properly: `-i`
     * (with an optional attached suffix — GNU's `-ie` means suffix "e") or
     * `--in-place[=SUFFIX]` → in place; `-e`/`-f`/`--expression`/`--file` supply
     * the script, in which case EVERY positional is a file; otherwise the first
     * positional is the script.
     */
    if (head === 'sed') {
      let inPlace = false, scriptGiven = false; const pos = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '--') { pos.push(...args.slice(k + 1)); break; }
        if (a.startsWith('--')) {
          if (a === '--in-place' || a.startsWith('--in-place=')) inPlace = true;
          else if (a === '--expression' || a === '--file') { scriptGiven = true; k++; }
          else if (a.startsWith('--expression=') || a.startsWith('--file=')) scriptGiven = true;
          else if (a === '--line-length') k++;
          continue;
        }
        if (a.startsWith('-') && a.length > 1) {
          const cl = a.slice(1);
          for (let c = 0; c < cl.length; c++) {
            const ch = cl[c];
            if (ch === 'i') { inPlace = true; break; }                                  // rest = suffix
            if (ch === 'e' || ch === 'f') { scriptGiven = true; if (c === cl.length - 1) k++; break; }
            if (ch === 'l') { if (c === cl.length - 1) k++; break; }
          }
          continue;
        }
        if (a !== '') pos.push(a);
      }
      if (inPlace) for (const p of (scriptGiven ? pos : pos.slice(1))) { push(p); kind = 'sed -i'; }
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
  // BUG-277 r5: the wrapper-hole net, run on EVERY top-level command (not only at
  // the mutates:false exit as r4 did). If the raw string carries MORE git tree-mutator
  // occurrences than the tokenizer classified as a head `git`, the surplus is a mutator
  // smuggled past the tokenizer by a wrapper (`exec`/`xargs`/`timeout`/…) OR sitting on
  // a COMBINED line beside an already-path-scoped one (`git checkout -- f; xargs git
  // reset --hard`). Either way the line mutates the whole tree — the union, strongest
  // wins. Equal counts leave a clean path-scoped `git checkout -- f` narrow. Depth 0
  // only (the raw command, not a recursively-scanned fragment).
  if (depth === 0 && countGitTreeMutators(command) > gitHeadMutators) {
    return { mutates: true, tree: true, kind: 'git (wrapped tree mutation)' };
  }
  // `gitMutators` is internal: it lets a parent scan discount git mutators this
  // (recursive) scan already resolved (see merge). Harmless on the public result.
  if (!allPaths.length && !scopes.length) return { mutates: false, gitMutators: gitHeadMutators };
  return { mutates: true, paths: allPaths, scopes, kind: kind ?? 'write', gitMutators: gitHeadMutators };
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
 * Round 4 — the CONTAINER/HOST namespace. Every session of a project already
 * shares ONE lock dir (keyed by project id under the data dir — the hook runs in
 * the server for both modes). What diverged was the KEY: a container session's
 * CLI sees the repo at `/workspace/<id>` (its cwd), which is not under the host
 * repo root, so its targets keyed as absolute `/workspace/<id>/src/a.ts` while a
 * host session keyed `src/a.ts` — two keys for one file, no coordination. The
 * bridge (owner of isolation) declares the CLI-side repo path(s) as `pathAliases`;
 * a target under an alias is rewritten onto the real repo root BEFORE keying, so
 * both modes produce the same repo-relative key.
 */
function unalias(p, repoRoot, aliases) {
  if (!repoRoot || !aliases || !aliases.length || !path.isAbsolute(p)) return p;
  for (const a of aliases) {
    if (typeof a !== 'string' || !a || !path.isAbsolute(a)) continue;
    const base = a.replace(/\/+$/, '') || '/';
    if (p === base) return path.resolve(repoRoot);
    if (p.startsWith(`${base}/`)) return path.join(path.resolve(repoRoot), p.slice(base.length + 1));
  }
  return p;
}

/** Repo-relative path of an absolute one ('' = the root itself), or null when outside the repo. */
function repoRelative(abs, repoRoot) {
  if (!repoRoot) return null;
  const root = realpathBestEffort(path.resolve(repoRoot));
  const rel = path.relative(root, realpathBestEffort(abs));
  if (rel === '') return '';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/**
 * Normalise a raw target to the lock KEY. A path UNDER the repo root keys by its
 * repo-RELATIVE path, so two sessions on the same project coordinate on the same
 * key whatever their absolute cwd — including a container's `/workspace/<id>`,
 * mapped back onto the repo through `aliases` (round 4). A path outside the repo
 * keys by its absolute path.
 *
 * Both the target AND the repo root are realpath-resolved before the relative is
 * taken, so a symlinked target (or a symlinked repo root, e.g. a /tmp that is a
 * link to /private/tmp) can never split one file into two keys and let two lanes
 * both "own" it — the round-1 symlink clobber (gap #a).
 */
export function lockKeyFor(rawPath, repoRoot, aliases = []) {
  const p = unalias(rawPath, repoRoot, aliases);
  const absRaw = path.isAbsolute(p) ? p : path.resolve(repoRoot || process.cwd(), p);
  const abs = realpathBestEffort(absRaw);
  const rel = repoRelative(abs, repoRoot);
  return rel ? rel : abs;
}

/**
 * A resolved target may still carry a GLOB (`sed -i … src/*.ts`, or a `for f in
 * *.ts` list). Bash expands it against the disk, so do the same: a literal file of
 * that exact name wins (Next.js `[id]` dirs are real names), else the matches,
 * else the literal (bash passes an unmatched glob through verbatim).
 */
function expandGlob(p, repoRoot, aliases) {
  if (!/[*?[]/.test(p)) return [p];
  const abs = (() => { const q = unalias(p, repoRoot, aliases); return path.isAbsolute(q) ? q : path.resolve(repoRoot || process.cwd(), q); })();
  try { if (fs.existsSync(abs)) return [abs]; } catch { /* fall through */ }
  try {
    const hits = typeof fs.globSync === 'function' ? fs.globSync(abs) : [];
    if (hits.length) return hits.slice(0, 512).map((h) => (path.isAbsolute(h) ? h : path.resolve(h)));
  } catch { /* fall through */ }
  return [abs];
}

/**
 * Round 4 — an UNRESOLVABLE target's conservative check. Refuse if any live
 * foreign lock sits at or under `relDir` (repo-relative). Read-only like
 * checkTree: it holds nothing, so it cannot wedge the directory for other lanes.
 */
function checkScope(lockDir, owner, relDir, now, ttlMs) {
  let files = [];
  try { files = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock')); } catch { return { ok: true }; }
  for (const f of files) {
    const file = path.join(lockDir, f);
    const lock = readLock(file);
    if (!lock || lock.owner === owner || typeof lock.key !== 'string') continue;
    if (lock.key !== relDir && !lock.key.startsWith(`${relDir}/`)) continue;
    if (reclaimReason(lock, now, ttlMs)) { tryReclaim(file); continue; }
    return { ok: false, holder: lock };
  }
  return { ok: true };
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
  pathAliases = [],
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
    // Unresolvable targets first (check-only): their directory, or the whole
    // tree when the root itself is unknown. An out-of-repo directory cannot hold
    // this project's files, so it has nothing to check against here.
    for (const s of cls.scopes || []) {
      let rel = null; let whole = s.dir == null || !repoRoot;
      if (!whole) {
        const d = unalias(s.dir, repoRoot, pathAliases);
        rel = repoRelative(path.isAbsolute(d) ? d : path.resolve(repoRoot, d), repoRoot);
        if (rel == null) continue;      // outside the project tree
        if (rel === '') whole = true;   // the repo root → every file
      }
      const r = whole ? checkTree(lockDir, owner, now, ttlMs) : checkScope(lockDir, owner, rel, now, ttlMs);
      if (!r.ok) {
        return { allow: false, busy: true, holder: r.holder, kind: cls.kind, scope: whole ? '' : rel, unresolved: s.raw,
          reason: busyRefusal(cls.kind, r.holder, { scope: whole ? '' : rel, unresolved: s.raw }) };
      }
    }
    const resolved = (cls.paths || []).flatMap((p) => expandGlob(p, repoRoot, pathAliases));
    const keys = [...new Set(resolved.map((p) => lockKeyFor(p, repoRoot, pathAliases)))];
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
export function busyRefusal(kind, holder, { tree = false, exhausted = false, error = null, scope = null, unresolved = null } = {}) {
  const who = holder && holder.owner ? `\`${holder.owner}\`` : 'another live lane';
  const age = holder && Number.isFinite(Number(holder.refreshedAt))
    ? ` (held ${Math.round((Date.now() - Number(holder.refreshedAt)) / 1000)}s ago)` : '';
  const held = holder && holder.key ? ` (\`${holder.key}\`)` : '';
  const head = scope != null
    ? `File-busy lock: this \`${kind || 'write'}\` targets \`${unresolved}\`, a path built from shell syntax that cannot be resolved before it runs, so it was checked conservatively against ${scope ? `everything under \`${scope}/\`` : 'the whole working tree'} — and ${who} holds an uncommitted lock there${held}${age}. Spell the target path(s) out literally (or assign the variable in this same command) so only the real file is checked.`
    : tree
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
