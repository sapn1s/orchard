/**
 * FEAT-145 step 2 — the multi-account registry + the overlay materialiser.
 *
 * ─────────────────────────── THE INVARIANT (do not let a future reader
 * "clean up" the symlinks and quietly split the transcript store) ───────────
 *
 * An account dir is a THIN OVERLAY over `~/.claude` that differs in exactly ONE
 * file, `.credentials.json`. `projects` and `settings.json` are SYMLINKS back
 * into the real store, so there is still exactly ONE transcript store and zero
 * reader changes anywhere in the codebase.
 *
 *  - `.claude.json` is deliberately NOT shared: it caches `oauthAccount`
 *    (account identity) and `projects[<cwd>].hasTrustDialogAccepted`. Sharing it
 *    would cross-contaminate one account's identity/trust into another's.
 *  - `settings.json` MUST be a SYMLINK, never a copy: it carries
 *    `cleanupPeriodDays: 36500`, the PreToolUse Bash guard hook, the Stop
 *    response-format gate and `enabledPlugins`. A fresh dir would default
 *    `cleanupPeriodDays` to 30 and prune the user's SHARED transcripts.
 *  - `.credentials.json` is the account's OWN file — produced by the login step
 *    (FEAT-145 step 3), NOT by this materialiser. A dir with none is `pending`.
 *
 * `scripts/lib/station-boot.mjs` `isolatedStoreEnv()` does the INVERSE overlay
 * for the test harness (shares `.credentials.json` + `settings.json`, isolates
 * `projects`); this shares `projects` + `settings.json` and isolates the creds.
 * Same symlink-not-copy idiom.
 *
 * ARCH-010: `resolveAccountDir(id)` is the ONE place anything maps an account id
 * to a config dir. Every reader reads it; nobody re-derives it — the stored
 * `dir` on a row is a denormalised display copy and is RECOMPUTED from the id on
 * read, so a hand-edited registry can never point an account at another path.
 *
 * Reads are tolerant of corruption (a truncated/garbage registry degrades to
 * "no extra accounts", per docs/CONVENTIONS on readers of files other processes
 * write); writes are atomic (`writeAtomic`). Idiomatically a sibling of
 * `src/server/global-settings.ts`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import { accountsFile, accountsDir, writeAtomic, isInside } from '../lib/paths.ts';
// REUSE FEAT-129's lock authority (do not invent a second one). Same import the
// FEAT-144 transcript mirror uses for exactly this purpose — see withRegistryLock.
import { reclaimReason, FILE_LOCK_TTL_MS } from '../../scripts/lib/file-lock.mjs';

/** The implicit default account — id `'default'`, dir `~/.claude`. Never a row. */
export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * A minted account id: opaque, server-generated hex. Never user-supplied and
 * never derived from the label (a label is free text that can collide or carry
 * path separators). The dir is derived from THIS, not the label.
 */
const ID_RE = /^[a-f0-9]{8,64}$/;

/** Hard ceiling on the auth-status probe (mirrors provider-usage's timeouts). */
const AUTH_STATUS_TIMEOUT_MS = 6_000;

export interface AccountStatus {
  loggedIn: boolean;
  subscriptionType: string | null;
  checkedAt: number;
}

export interface AccountRow {
  id: string;
  label: string;
  dir: string;
  createdAt: string;
  state: 'pending' | 'ready';
  lastStatus?: AccountStatus;
}

/** The richer result of a live `claude auth status --json` probe. */
export interface AccountHealth {
  loggedIn: boolean;
  subscriptionType: string | null;
  checkedAt: number;
  configDirectory: string | null;
  projectsDirectory: string | null;
  /** Plain-words reason when the probe could not report (timeout, no binary). */
  error?: string;
}

/** An error carrying an HTTP status so the route can answer honestly. */
export class AccountError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

/** The user's REAL Claude store base, ignoring any override — the one to protect. */
function realStoreBase(): string {
  return path.join(os.homedir(), '.claude');
}

/** Where a deleted account dir is moved aside (recoverable), sibling of the root. */
function accountsTrashDir(): string {
  return path.join(path.dirname(accountsDir()), 'claude-accounts-trash');
}

/**
 * ARCH-010 — the ONE mapping from an account id to its config dir. `'default'`
 * is `~/.claude` itself; any other id is `<accountsDir>/<id>`, a PURE function
 * of the id (never of the label, never of a stored path). Rejects a malformed
 * id so a bad value can never reach a filesystem op or a `CLAUDE_CONFIG_DIR`.
 */
export function resolveAccountDir(id: string): string {
  if (id === DEFAULT_ACCOUNT_ID) return realStoreBase();
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new AccountError(`invalid account id: ${JSON.stringify(id)}`, 400);
  }
  return path.join(accountsDir(), id);
}

/** The synthesised default row — always first, never persisted. */
export function defaultAccountRow(): AccountRow {
  return {
    id: DEFAULT_ACCOUNT_ID,
    label: 'Default (~/.claude)',
    dir: realStoreBase(),
    // synthesised, not stored: the default has no creation event on disk.
    createdAt: '',
    state: 'ready',
  };
}

/* ------------------------------------------------------------- registry read */

function normaliseStatus(v: unknown): AccountStatus | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.loggedIn !== 'boolean' || typeof o.checkedAt !== 'number') return undefined;
  return {
    loggedIn: o.loggedIn,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
    checkedAt: o.checkedAt,
  };
}

/**
 * Validate one stored row field-by-field. A row with a bad/absent id or label
 * is dropped (not coerced). `dir` is RECOMPUTED from the id (ARCH-010) — a
 * stored `dir` is never trusted, so a hand-edit cannot repoint an account.
 */
function normaliseRow(v: unknown): AccountRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof o.label !== 'string' || !o.label.trim()) return null;
  const state: 'pending' | 'ready' = o.state === 'ready' ? 'ready' : 'pending';
  const status = normaliseStatus(o.lastStatus);
  return {
    id,
    label: o.label,
    dir: resolveAccountDir(id),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    state,
    ...(status ? { lastStatus: status } : {}),
  };
}

/**
 * Read the extra (non-default) account rows. Tolerant by construction: a
 * missing file, unparseable JSON, or the wrong top-level shape all resolve to
 * `[]` rather than throwing — a truncated registry a concurrent write left
 * behind must degrade to "no extra accounts", never crash a session start.
 * Accepts either a bare array or `{ accounts: [...] }`.
 */
export function readAccounts(): AccountRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(accountsFile(), 'utf8');
  } catch {
    return [];
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(obj)
    ? obj
    : obj && typeof obj === 'object' && Array.isArray((obj as Record<string, unknown>).accounts)
      ? ((obj as Record<string, unknown>).accounts as unknown[])
      : null;
  if (!arr) return [];
  const out: AccountRow[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    const row = normaliseRow(entry);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/** The API list: the synthesised default FIRST, then the stored rows. */
export function listAccounts(): AccountRow[] {
  return [defaultAccountRow(), ...readAccounts()];
}

function writeAccounts(rows: AccountRow[]): void {
  writeAtomic(accountsFile(), `${JSON.stringify({ accounts: rows }, null, 2)}\n`);
}

/* ------------------------------------------------------- the writer lock (§W)
 *
 * WHY THIS EXISTS. Every mutation here is a READ-MODIFY-WRITE of one file:
 * `readAccounts()` → splice/push the row → `writeAccounts()`. `writeAtomic` makes
 * each WRITE atomic, which is why a READER never sees a half file — but it does
 * nothing about two writers that both read the SAME `rows` and then both write
 * their own version: the second write wins whole-file and the first writer's row
 * is gone. A create racing a delete loses the created account (its overlay dir
 * stays on disk, orphaned, with no row naming it); two creates lose one account.
 * Named as a live residual by the step-2 independent clean-room round
 * ("`createAccount` does read → mint → materialise → `writeAccounts` with no
 * lock"); the window is real because `materialiseAccountDir` does genuine fs work
 * (mkdir + two `lstat`s + two `symlink`s + two `existsSync`es) between the read
 * and the write.
 *
 * REUSES FEAT-129's file-lock rather than a new policy: acquire is that module's
 * atomic link-create pattern (temp + `linkSync`, so the lockfile is never observed
 * empty by a racer), and staleness is FEAT-129's OWN `reclaimReason` — dead owner
 * via `pidAlive`, or past the shared `FILE_LOCK_TTL_MS` backstop. The one thing
 * that differs is LIFETIME: this is a bounded critical section (acquire, run the
 * synchronous body, release in `finally`), which `evaluateFileLock`'s
 * claim-until-heartbeat model cannot express — the same reason, and the same
 * shape, as `withMirrorLock` in `src/server/orchard-transcripts.ts`. Read that
 * function beside this one; they are deliberately the same idiom.
 *
 * WHERE THIS DIVERGES FROM THE MIRROR LOCK, and why: the mirror fails toward SKIP
 * (its work is idempotent, so letting the other pass do it loses nothing). A
 * registry mutation is NOT idempotent — silently skipping a create would report
 * success and store nothing. So this fails toward a LOUD REFUSAL: an
 * `AccountError` (503) the route already turns into an honest HTTP answer.
 *
 * READS ARE DELIBERATELY NOT LOCKED. `readAccounts()` must keep degrading on a
 * corrupt or half-written file (docs/CONVENTIONS, readers of files other
 * processes write) rather than start throwing or blocking a session launch on a
 * lock; `writeAtomic` already guarantees a reader sees either the old or the new
 * file, never a splice. The lock only arbitrates WRITERS against each other.
 */
const REGISTRY_LOCK_ATTEMPTS = 200;
const REGISTRY_LOCK_SLEEP_MS = 25; // ≈5 s of patience, then refuse

/** Block this thread briefly without a busy-spin. The critical section is synchronous by design. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* Atomics.wait unavailable → fall through to an immediate retry */
  }
}

function registryLockPath(): string {
  return `${accountsFile()}.lock`;
}

/**
 * Run `fn` as the ONLY writer of the accounts registry. Throws `AccountError`
 * (503) rather than running the body if the lock cannot be taken — never runs a
 * mutation it could not serialize.
 */
function withRegistryLock<T>(fn: () => T): T {
  const lockPath = registryLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < REGISTRY_LOCK_ATTEMPTS; attempt++) {
    // Atomic create-with-content: `link` fails EEXIST for every loser, and the
    // target is never observed empty (unlike O_EXCL-then-write).
    const tmp = `${lockPath}.mk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let created = false;
    try {
      const meta = { host: os.hostname(), ownerPid: process.pid, refreshedAt: Date.now() };
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(meta));
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(tmp, lockPath);
        created = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* linked, or never made */
      }
    }

    if (created) {
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already reclaimed by a TTL sweep */
        }
      }
    }

    // Held. Reclaim ONLY if FEAT-129's authority says the holder is provably
    // dead or past the shared TTL; otherwise wait for it.
    let held: unknown = null;
    try {
      held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      held = null;
    }
    if (reclaimReason(held ?? {}, Date.now(), FILE_LOCK_TTL_MS)) {
      // Race-safe: rename aside — exactly one contender wins, the rest retry.
      const moved = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        fs.renameSync(lockPath, moved);
        fs.unlinkSync(moved);
      } catch {
        /* lost the reclaim race — retry and see the winner's lock */
      }
      continue;
    }
    sleepSync(REGISTRY_LOCK_SLEEP_MS);
  }
  throw new AccountError(
    'the Claude account registry is busy (another writer holds it) — nothing was changed; retry shortly',
    503,
  );
}

function mintId(existing: ReadonlySet<string>): string {
  for (let i = 0; i < 10_000; i++) {
    const id = crypto.randomBytes(12).toString('hex'); // 24 hex chars
    if (!existing.has(id)) return id;
  }
  // Astronomically unreachable; better to throw than loop forever.
  throw new AccountError('could not mint a unique account id', 500);
}

/* ------------------------------------------------ overlay materialiser (§3) */

/**
 * Create/repair a symlink `linkPath -> target` without ever following it.
 * Distinct refusal when a NON-symlink already sits there, and when a symlink
 * points somewhere else — both mean "this dir is not one we minted".
 */
function ensureSymlink(linkPath: string, target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.symlinkSync(target, linkPath);
      return;
    }
    throw err;
  }
  if (!st.isSymbolicLink()) {
    throw new AccountError(
      `${linkPath} already exists and is not a symlink — refusing (the account dir is not one we minted)`,
      409,
    );
  }
  const current = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), current);
  if (resolved !== path.resolve(target)) {
    throw new AccountError(
      `${linkPath} is a symlink to ${resolved}, not the expected ${target} — refusing (the account dir is not one we minted)`,
      409,
    );
  }
  // Already correct — idempotent no-op.
}

/**
 * Materialise an account's overlay dir (§3): `mkdir`, then symlink `projects`
 * and `settings.json` into the REAL store. Never creates `.credentials.json`
 * (that is what login produces) and never touches `~/.claude`. Idempotent:
 * re-materialising an already-correct dir is a no-op, not an error.
 *
 * Refusals, each distinct: the path exists and is not a directory we own; the
 * real store or real settings.json is missing; a symlink points elsewhere.
 */
export function materialiseAccountDir(id: string): { dir: string; created: boolean } {
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new AccountError('the default account is never materialised (it IS ~/.claude)', 400);
  }
  const dir = resolveAccountDir(id);
  if (!isInside(accountsDir(), dir)) {
    // Defensive: resolveAccountDir already guarantees this, but never mkdir
    // outside the accounts root.
    throw new AccountError(`refusing to materialise outside the accounts root: ${dir}`, 400);
  }
  const base = realStoreBase();
  const realProjects = path.join(base, 'projects');
  const realSettings = path.join(base, 'settings.json');
  if (!fs.existsSync(realProjects)) {
    throw new AccountError(`the real transcript store is missing (${realProjects}) — cannot overlay it`, 409);
  }
  if (!fs.existsSync(realSettings)) {
    throw new AccountError(
      `the real settings.json is missing (${realSettings}) — refusing to create a fresh one ` +
        `(a fresh dir defaults cleanupPeriodDays to 30 and would prune the shared transcripts)`,
      409,
    );
  }

  let created = false;
  let dst: fs.Stats | null = null;
  try {
    dst = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!dst) {
    fs.mkdirSync(dir, { recursive: true });
    created = true;
  } else if (!dst.isDirectory() || dst.isSymbolicLink()) {
    // isDirectory() is false for a symlink under lstat, so this catches both a
    // stray file and a symlinked dir — either is "not ours".
    throw new AccountError(`${dir} already exists and is not an account directory we own`, 409);
  }

  ensureSymlink(path.join(dir, 'projects'), realProjects);
  ensureSymlink(path.join(dir, 'settings.json'), realSettings);
  return { dir, created };
}

/* -------------------------------------------------------- create / delete */

function validateLabel(v: unknown): string {
  if (typeof v !== 'string') throw new AccountError('label must be a string', 400);
  const label = v.trim();
  if (!label) throw new AccountError('label must not be empty', 400);
  if (label.length > 200) throw new AccountError('label must be at most 200 characters', 400);
  // Free text, but no control chars (newlines etc. would corrupt display/logs).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new AccountError('label must not contain control characters', 400);
  return label;
}

/**
 * Create a new account: mint an id, materialise its overlay dir, then persist
 * the row as `state: 'pending'` (login in step 3 flips it to `'ready'`).
 * Materialise BEFORE persist, so a materialise refusal leaves no orphan row.
 *
 * The WHOLE read→mint→materialise→write is one critical section (§W): the label
 * is validated first (a bad label must be refused whether or not anyone else is
 * writing) and everything that touches the registry runs under the writer lock,
 * so a concurrent create or delete cannot read the same `rows` and write a
 * version missing this row.
 */
export function createAccount(label: unknown): AccountRow {
  const clean = validateLabel(label);
  return withRegistryLock(() => {
    const rows = readAccounts();
    const id = mintId(new Set(rows.map((r) => r.id)));
    materialiseAccountDir(id); // throws (with a status) if it cannot overlay
    const row: AccountRow = {
      id,
      label: clean,
      dir: resolveAccountDir(id),
      createdAt: new Date().toISOString(),
      state: 'pending',
    };
    rows.push(row);
    writeAccounts(rows);
    return row;
  });
}

/**
 * Remove an account dir SAFELY (§D). The overlay symlinks are unlinked WITHOUT
 * being followed (`fs.unlinkSync` on a symlink removes the LINK, never the
 * target), so the user's real `projects`/`settings.json` are never touched;
 * only then is the now-linkless dir moved aside to a trash path (recoverable,
 * matching the deleted-sessions idiom). A `projects` that is NOT a symlink is
 * left in place and moved intact — still no descent into the real store.
 */
function removeAccountDir(dir: string): string {
  for (const name of ['projects', 'settings.json']) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fs.unlinkSync(p); // unlink the LINK, never its target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const trash = path.join(accountsTrashDir(), `${path.basename(dir)}-${Date.now()}`);
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(dir, trash);
  return trash;
}

/**
 * Delete an account (§D — the dangerous one). Refuses `'default'`. Verifies the
 * dir is the one we minted (its stored `dir` equals the id-derived dir AND lies
 * under the accounts root) before removing anything, then unlinks the overlay
 * symlinks without following them and moves the dir aside.
 */
export function deleteAccount(id: string): { deleted: true; trashed: string | null } {
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new AccountError('refusing to delete the default account (~/.claude)', 400);
  }
  // §W — the existence check, the dir removal and the rewrite are ONE critical
  // section: a create that lands between the read and the write would otherwise
  // be erased by the row list this call read before it existed.
  return withRegistryLock(() => {
    const rows = readAccounts();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new AccountError(`no account ${id}`, 404);
    const row = rows[idx];
    const derived = resolveAccountDir(id);
    if (path.resolve(row.dir) !== path.resolve(derived)) {
      throw new AccountError(`account ${id} dir mismatch (${row.dir} != ${derived}) — refusing to delete`, 409);
    }
    if (!isInside(accountsDir(), derived)) {
      throw new AccountError(`account ${id} dir ${derived} is not under the accounts root — refusing to delete`, 409);
    }
    let trashed: string | null = null;
    if (fs.existsSync(derived)) trashed = removeAccountDir(derived);
    rows.splice(idx, 1);
    writeAccounts(rows);
    return { deleted: true as const, trashed };
  });
}

/**
 * FEAT-145 step 3 — write down the outcome of a login, ONCE, from the CLI's own
 * report (ARCH-010). The caller must have read `claude auth status --json` and
 * must pass a health whose `loggedIn` is TRUE: `state` never flips on an exit
 * code, a spawn result, or the mere existence of a credential file, because
 * those are all things a reader would be re-deriving instead of reading the
 * fact its owner (the CLI) stated.
 *
 * `lastStatus` is the denormalised display copy of that same report, so the UI
 * can say which plan an account is on without shelling out per paint.
 */
export function markAccountReady(id: string, health: Pick<AccountHealth, 'loggedIn' | 'subscriptionType' | 'checkedAt'>): AccountRow {
  if (id === DEFAULT_ACCOUNT_ID) throw new AccountError('the default account has no stored state', 400);
  if (!health || health.loggedIn !== true) {
    throw new AccountError(
      `refusing to mark account ${id} ready: \`claude auth status --json\` did not report loggedIn:true`,
      409,
    );
  }
  // §W — the state/lastStatus flip is a read-modify-write of the same file, so
  // it takes the same writer lock: without it a concurrent create is dropped by
  // the row list this call read before that create existed.
  return withRegistryLock(() => {
    const rows = readAccounts();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new AccountError(`no account ${id}`, 404);
    rows[idx] = {
      ...rows[idx],
      state: 'ready',
      lastStatus: {
        loggedIn: true,
        subscriptionType: health.subscriptionType ?? null,
        checkedAt: typeof health.checkedAt === 'number' ? health.checkedAt : Date.now(),
      },
    };
    writeAccounts(rows);
    return rows[idx];
  });
}

/* -------------------------------------------------- launch-time resolution */

/**
 * FEAT-145 step 4 — resolve the `CLAUDE_CONFIG_DIR` for a session launch, or
 * `null` for the implicit default account (id `null` or `'default'`). The caller
 * MUST then NOT set the env var when this returns null, so a default-account
 * session's env stays byte-identical to before this feature existed.
 *
 * For a NAMED account this is the loud gate the ticket demands: it throws
 * (`AccountError`) rather than ever falling back to the default when the account
 * is missing, not yet logged in, or has lost its credential — because silently
 * spending the wrong plan's quota is the failure the whole feature exists to
 * avoid. Three distinct refusals so the UI can say which:
 *
 *  - the id names no account row (deleted, or never existed);
 *  - the row exists but is not `state:'ready'` (login step 3 not completed);
 *  - the row is ready but its `.credentials.json` is gone (re-login required) —
 *    the file is exactly what the CLI reads, so its absence is the truest
 *    "not logged in" signal at launch.
 *
 * `materialiseAccountDir` is called (idempotent) to repair the overlay symlinks
 * before launch, per the ticket: "ensure the account dir is materialised".
 */
export function resolveLaunchAccountDir(id: string | null | undefined): string | null {
  if (id == null || id === DEFAULT_ACCOUNT_ID) return null;
  const row = readAccounts().find((r) => r.id === id);
  if (!row) {
    throw new AccountError(
      `session names Claude account ${JSON.stringify(id)}, which does not exist — refusing to start ` +
        `(falling back to the default account would spend the wrong plan's quota silently)`,
      409,
    );
  }
  if (row.state !== 'ready') {
    throw new AccountError(
      `Claude account "${row.label}" (${id}) is not logged in yet (state: ${row.state}) — ` +
        `add it via Machine settings before a session can use it`,
      409,
    );
  }
  const { dir } = materialiseAccountDir(id); // idempotent; repairs the overlay symlinks
  const creds = path.join(dir, '.credentials.json');
  if (!fs.existsSync(creds)) {
    throw new AccountError(
      `Claude account "${row.label}" (${id}) is marked ready but its credential (${creds}) is missing — ` +
        `refusing to start (re-login required); it must not silently spend the default account`,
      409,
    );
  }
  return dir;
}

/* ---------------------------------------------------------- health probe */

/**
 * Shell out to `claude auth status --json` with the account's `CLAUDE_CONFIG_DIR`
 * and parse it. `loggedIn` is the source of truth (NOT the exit code — logged
 * out exits 1 but still prints valid JSON, so stdout is parsed regardless of
 * exit). Bounded by a hard timeout; a timeout, missing binary, or unparseable
 * output degrades to `{ loggedIn: false, error }` — never a throw.
 */
export async function readAccountHealth(id: string, opts: { timeoutMs?: number } = {}): Promise<AccountHealth> {
  const dir = resolveAccountDir(id);
  const timeoutMs = opts.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS;
  const bin = process.env.CLAUDE_STATION_CLAUDE_BIN || 'claude';
  const checkedAt = Date.now();
  const fail = (error: string): AccountHealth => ({
    loggedIn: false,
    subscriptionType: null,
    checkedAt,
    configDirectory: null,
    projectsDirectory: null,
    error,
  });

  const stdout = await new Promise<string>((resolve) => {
    execFile(
      bin,
      ['auth', 'status', '--json'],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, out) => {
        // stdout is populated even on a non-zero (logged-out) exit; only a
        // kill/timeout or spawn failure with no output is a genuine failure.
        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) return resolve('');
        resolve(out || '');
      },
    );
  });

  if (!stdout.trim()) return fail('claude auth status produced no output (timeout or binary missing)');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return fail('claude auth status returned non-JSON');
  }
  return {
    loggedIn: obj.loggedIn === true,
    subscriptionType: typeof obj.subscriptionType === 'string' ? obj.subscriptionType : null,
    checkedAt,
    configDirectory: typeof obj.configDirectory === 'string' ? obj.configDirectory : null,
    projectsDirectory: typeof obj.projectsDirectory === 'string' ? obj.projectsDirectory : null,
  };
}
