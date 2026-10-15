/**
 * FEAT-145 step 3 — the "Add account" login flow.
 *
 * ONE login at a time, for ONE `state:'pending'` account, driven by the real
 * CLI over PLAIN PIPES. Everything here is built on facts measured against
 * claude 2.1.273 (FEAT-145 step 1), not on guesses:
 *
 *  - `claude auth login --claudeai` does NOT need a TTY. With piped stdin it
 *    prints `Opening browser to sign in…`, then an authorize URL on stdout,
 *    then `Paste code here if prompted > ` and blocks reading stdin. So no
 *    `node-pty`, no pseudo-terminal, no extra dependency.
 *  - The URL is `https://claude.com/cai/oauth/authorize?...` — note the HOST is
 *    `claude.com/cai/...`, not `claude.ai/oauth/...`. It is therefore scraped
 *    GENERICALLY (any https URL whose path ends `/oauth/authorize` and carries a
 *    query), so a CLI change degrades to "no URL found, here is the raw output"
 *    rather than a silent hang. `URL_GRACE_MS` makes that degradation TIMELY:
 *    the user is told, with the raw output, instead of watching a dead panel.
 *  - The CLI tries to OPEN A BROWSER. This server may be driven from another
 *    machine, so a browser on the HOST is worse than useless — `BROWSER` is
 *    pinned to a no-op and `DISPLAY`/`WAYLAND_DISPLAY` are stripped from the
 *    child env, and the URL is surfaced in the UI instead.
 *  - `claude auth status --json` is the health read, and LOGGED OUT EXITS 1
 *    while still printing valid JSON. `readAccountHealth` already parses
 *    `loggedIn` as the source of truth and ignores the exit code; this module
 *    flips `state` to `'ready'` from THAT field and never from a child exit
 *    code (ARCH-010: the CLI owns the fact, we write down what it reported).
 *
 * Two safety properties this module owes the rest of the system:
 *
 *  1. **No stray process, no half-account.** The child is spawned `detached`
 *     so it leads its OWN process group, and every teardown path (cancel,
 *     timeout, socket close) kills the GROUP (`process.kill(-pid, …)`). Killing
 *     the leader alone leaves the CLI's own children orphaned. After the kill
 *     the pending account is DELETED, so an abandoned attempt leaves no row and
 *     no dir behind.
 *  2. **The pasted code never leaves this process.** It is written to the
 *     child's stdin and nowhere else — never logged, never echoed into an
 *     event, never persisted. Anything the child prints back that CONTAINS it
 *     is redacted on the way out, because a CLI that echoes its own prompt
 *     input must not turn our output relay into a credential leak.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AccountError,
  DEFAULT_ACCOUNT_ID,
  deleteAccount,
  materialiseAccountDir,
  markAccountReady,
  readAccountHealth,
  readAccounts,
  resolveAccountDir,
} from './claude-accounts.ts';
import type { ClaudeLoginEvent } from './events.ts';

/** Hard ceiling on one login attempt. A human OAuth round trip is minutes. */
const LOGIN_TIMEOUT_MS = Number(process.env.CLAUDE_STATION_LOGIN_TIMEOUT_MS ?? 10 * 60_000);
/** How long to wait for the authorize URL before saying "we could not find one". */
const URL_GRACE_MS = Number(process.env.CLAUDE_STATION_LOGIN_URL_GRACE_MS ?? 25_000);
/** How long SIGTERM gets before the group is SIGKILLed. */
const KILL_GRACE_MS = 2_000;
/** Cap on the raw output kept for the degraded "no URL found" report. */
const RAW_TAIL_MAX = 4_000;

/**
 * Generic authorize-URL scrape. Matches the PATH (`/oauth/authorize?`), never a
 * hardcoded host, so `claude.com/cai/oauth/authorize` and any future host both
 * work; a CLI that stops printing one degrades loudly instead of hanging.
 * Trailing punctuation a sentence might add is trimmed by the character class.
 */
const AUTHORIZE_RE = /https?:\/\/[^\s"'<>`]*\/oauth\/authorize\?[^\s"'<>`]+/i;
/** The CLI's stdin prompt — printed WITHOUT a trailing newline. */
const PASTE_PROMPT_RE = /paste\s+code\s+here/i;

/**
 * The relay's events are `StationEvent` members (src/server/events.ts), not a
 * parallel union declared here: they travel the same socket as every other
 * server→client event, so one place holds their shape (ARCH-010). This alias is
 * kept because it is the name every call site in this module already uses.
 */
export type LoginEvent = ClaudeLoginEvent;

export type LoginEmit = (e: LoginEvent) => void;

interface LoginSession {
  accountId: string;
  label: string;
  /** The account's real overlay dir — the one every session/container binds. */
  dir: string;
  /**
   * BUG-254 r4 — where the CLI actually writes `.credentials.json`. For a REAUTH it is a private
   * TEMP dir, so a successful sign-in never atomic-replaces (and so orphans a running container's
   * single-file bind — BUG-136) the account's real credential; the fresh credential is then written
   * IN PLACE into the real file (same inode), so a running container sees the new token with no
   * recreate. For a first login `writeDir === dir` (no temp, nothing to copy). Removed on finish.
   */
  writeDir: string;
  child: ChildProcess;
  emit: LoginEmit;
  /**
   * RE-authentication of an already-`ready` account (BUG-254), as opposed to
   * the first login of a freshly-added `pending` one. A reauth NEVER deletes the
   * account on failure/cancel/timeout — the established row and its existing
   * credential are kept untouched, and only a successful CLI write replaces the
   * credential in place, so the account id (and every project pinned to it) is
   * preserved. The pending first-login path still cleans its half-made row away.
   */
  reauth: boolean;
  /** Codes the user pasted — held ONLY to redact them out of relayed output. */
  secrets: string[];
  urlEmitted: boolean;
  finished: boolean;
  rawTail: string;
  lineBuf: string;
  timers: NodeJS.Timeout[];
}

/** The ONE live login. Module scope on purpose: a second attempt is refused. */
let active: LoginSession | null = null;

/** What the UI/route needs to know about the attempt in flight, if any. */
export function activeClaudeLogin(): { accountId: string; label: string } | null {
  return active ? { accountId: active.accountId, label: active.label } : null;
}

/** Redact every pasted code out of anything on its way to a client or a log. */
function redact(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (secret.length < 4) continue; // too short to redact without mangling output
    out = out.split(secret).join('«code redacted»');
  }
  return out;
}

function clearTimers(s: LoginSession): void {
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
}

/**
 * BUG-254 r7 — copy the freshly-minted credential from the reauth's temp config dir into the
 * account's real `.credentials.json` via a WHOLESALE ATOMIC REPLACE: write the new bytes to a
 * sibling temp file in the account dir, fsync, then `rename()` it over the target. The rename is
 * atomic within the directory, so a concurrent reader ever sees EITHER the complete old document OR
 * the complete new one — never a torn or partial read. The credential bytes are never logged.
 *
 * Why not the r4 same-inode in-place rewrite: there is no atomic same-inode replace on Linux, and a
 * single `write(2)` of a ~1 KB credential is NOT atomic against a concurrent reader. The r7 docker-
 * sandbox gate measured ~0.012% torn reads (49 per 400 000) even for a padded fixed-length single
 * write, observed by a real container reader over the single-file bind. Because CLI 2.1.296 reloads
 * the credential ONLY on an mtime CHANGE, a torn read cached against the final write's mtime has no
 * recovery trigger (no further write/touch/login) — it would strand the running CLI on a bad read
 * forever. So the in-place path is removed: the re-login replaces the file wholesale (new inode),
 * the running container keeps its old bound inode (BUG-136) until the verified idle-only reconciler
 * (grant-rebuild.ts) recreates it the moment the project is idle. Its sessions are failing on auth,
 * so they ARE idle; the priced residual is a few seconds until the heal runs rather than instant.
 */
export function applyCredentialReplace(fromDir: string, toDir: string): void {
  const src = path.join(fromDir, '.credentials.json');
  const dst = path.join(toDir, '.credentials.json');
  const content = fs.readFileSync(src); // Buffer; never stringified or logged
  const tmp = path.join(toDir, `.credentials.json.reauth-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', 0o600); // fresh sibling file in the SAME dir (so rename is atomic)
  try {
    fs.writeSync(fd, content, 0, content.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, dst); // atomic replace — a reader sees the whole old OR the whole new file
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** Remove a reauth's temp config dir (it briefly held a real credential). Best effort. */
function cleanupWriteDir(s: LoginSession): void {
  if (s.writeDir === s.dir) return; // first login wrote straight to the account dir — nothing temp
  try { fs.rmSync(s.writeDir, { recursive: true, force: true }); } catch { /* gone, or left for the OS tmp reaper */ }
}

/**
 * Kill the child's whole PROCESS GROUP — never the bare pid. The CLI spawns
 * helpers of its own (that is the point of `detached: true` at spawn time); a
 * single-pid kill leaves them running, holding the account dir and the user's
 * terminal-less OAuth attempt alive forever.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone, or never got a group — the SIGKILL below is the backstop */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * Remove the pending account a failed/cancelled attempt left behind, so the
 * account list never accumulates half-made rows. Best effort by design: a
 * delete refusal must not mask the login outcome the user is waiting on.
 */
function dropPendingAccount(accountId: string): boolean {
  try {
    deleteAccount(accountId);
    return true;
  } catch {
    return false;
  }
}

/** Finish exactly once: clear timers, drop the module lock, emit the verdict. */
function finish(
  s: LoginSession,
  verdict: Omit<LoginEvent & { t: 'claude-login-done' }, 't' | 'accountId'>,
): void {
  if (s.finished) return;
  s.finished = true;
  clearTimers(s);
  cleanupWriteDir(s); // BUG-254 r4 — remove the reauth temp dir (held a credential briefly)
  if (active === s) active = null;
  s.emit({ t: 'claude-login-done', accountId: s.accountId, ...verdict });
}

/** Relay one output chunk: redact, cap the kept tail, scrape complete lines. */
function onOutput(s: LoginSession, stream: 'stdout' | 'stderr', chunk: string): void {
  const text = redact(chunk, s.secrets);
  s.rawTail = (s.rawTail + text).slice(-RAW_TAIL_MAX);
  s.emit({ t: 'claude-login-output', accountId: s.accountId, stream, text });

  /*
   * Scrape from COMPLETE LINES, not from the raw chunk: a URL split across two
   * reads would otherwise match as a truncated URL and send the user to a dead
   * link. The remainder is kept and scanned again when its line completes.
   */
  s.lineBuf += text;
  const parts = s.lineBuf.split(/\r?\n/);
  s.lineBuf = parts.pop() ?? '';
  for (const line of parts) {
    if (s.urlEmitted) break;
    const m = AUTHORIZE_RE.exec(line);
    if (m) {
      s.urlEmitted = true;
      s.emit({ t: 'claude-login-url', accountId: s.accountId, url: m[0] });
    }
  }

  /*
   * The paste prompt has NO trailing newline, so it only ever appears in the
   * remainder. Reaching it without a URL means the scrape did not recognise
   * this CLI's output: say so, with the raw output, rather than leaving a panel
   * that waits forever for a link that is never coming.
   */
  if (PASTE_PROMPT_RE.test(s.lineBuf)) {
    if (s.urlEmitted) {
      s.emit({ t: 'claude-login-status', accountId: s.accountId, message: 'the CLI is waiting for the code from the sign-in page' });
    } else {
      s.emit({
        t: 'claude-login-status',
        accountId: s.accountId,
        message:
          'the CLI is asking for a code but no authorize URL was found in its output — ' +
          'open the link it printed below by hand, then paste the code',
        urlFound: false,
        raw: s.rawTail,
      });
    }
  }
}

/**
 * Start a login for an account. Two shapes, chosen from the row's state:
 *
 *  - a `pending` account → its FIRST login (a failed attempt deletes the
 *    half-made row, as before);
 *  - a `ready` account → a RE-login in place (BUG-254). It reuses this exact
 *    relay against the SAME account dir, so a successful sign-in replaces
 *    `.credentials.json` and KEEPS the account id — every project pinned to it
 *    keeps working. A failed reauth leaves the account and its old credential
 *    untouched. This replaces the old "delete it and add it again" refusal,
 *    which minted a new id and broke every project pointing at the old one.
 *
 * Still refused, each with a distinct status: another attempt is live (409),
 * the id is the default (400 — that is plain `claude` CLI territory), or the
 * account does not exist (404).
 *
 * `onReady(accountId)` fires AFTER a successful sign-in has been written down
 * (`markAccountReady`), so the caller can propagate the replaced credential to
 * running sessions (BUG-254) without this module importing the session layer.
 */
export function startClaudeLogin(
  accountId: string,
  emit: LoginEmit,
  opts: { timeoutMs?: number; urlGraceMs?: number; onReady?: (accountId: string) => void } = {},
): { accountId: string; label: string; dir: string; pid: number; reauth: boolean } {
  if (active && !active.finished) {
    throw new AccountError(
      `a Claude login is already in progress for "${active.label}" — finish or cancel it first ` +
        '(two CLI logins would race for the same browser round trip)',
      409,
    );
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    throw new AccountError(
      'refusing to log in the default account (~/.claude) — it is the credential this machine already uses; ' +
        'sign in with the plain `claude` CLI if it needs re-authenticating',
      400,
    );
  }
  const row = readAccounts().find((r) => r.id === accountId);
  if (!row) throw new AccountError(`no account ${accountId}`, 404);
  const reauth = row.state === 'ready';

  const { dir } = materialiseAccountDir(accountId); // idempotent; repairs the overlay
  const bin = process.env.CLAUDE_STATION_CLAUDE_BIN || 'claude';

  /*
   * BUG-254 r4 — a REAUTH writes to a private temp dir, not the account's real dir, so the CLI's
   * atomic credential replace cannot orphan a running container's single-file bind (BUG-136). The
   * fresh credential is copied IN PLACE into the real file on success (same inode). A first login
   * has no running consumers of a credential that does not exist yet, so it writes straight to the
   * account dir exactly as before.
   */
  const writeDir = reauth ? fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reauth-')) : dir;

  /*
   * The child env. `CLAUDE_CONFIG_DIR` is the whole point — it is what makes
   * the CLI write `.credentials.json` into THIS account's overlay (or, for a
   * reauth, the temp dir) instead of the user's real store. `BROWSER`/`DISPLAY`
   * are the "do not open a browser on the server's own desktop" contract.
   */
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: writeDir, BROWSER: '/usr/bin/true' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;

  const child = spawn(bin, ['auth', 'login', '--claudeai'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its OWN process group, so teardown can kill the group and leave nothing.
    detached: true,
  });

  const s: LoginSession = {
    accountId,
    label: row.label,
    dir,
    writeDir,
    child,
    emit,
    reauth,
    secrets: [],
    urlEmitted: false,
    finished: false,
    rawTail: '',
    lineBuf: '',
    timers: [],
  };
  active = s;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => onOutput(s, 'stdout', d));
  child.stderr?.on('data', (d: string) => onOutput(s, 'stderr', d));

  child.on('error', (err: Error) => {
    // A reauth keeps the established account; only a first-login's half-made
    // pending row is cleaned away.
    const removed = s.reauth ? false : dropPendingAccount(accountId);
    finish(s, {
      ok: false,
      loggedIn: false,
      subscriptionType: null,
      reason: `could not run \`${bin} auth login --claudeai\`: ${err.message}`,
      accountRemoved: removed,
    });
  });

  child.on('exit', (code, signal) => {
    if (s.finished) return; // a cancel/timeout already wrote the verdict
    clearTimers(s);
    /*
     * ARCH-010 — the account's identity is written down from the CLI's OWN
     * report, never inferred from an exit code. `claude auth status --json`
     * exits 1 when logged out but still prints valid JSON, so a 0/non-0 read
     * here would be wrong in both directions; `readAccountHealth` parses
     * `loggedIn` and that single field decides.
     */
    // BUG-254 r4 — a reauth wrote to the temp dir; read the confirmed `loggedIn` fact from THERE.
    void readAccountHealth(accountId, s.writeDir === s.dir ? {} : { configDir: s.writeDir })
      .then((health) => {
        if (health.loggedIn) {
          if (s.reauth) {
            // BUG-254 r7 — replace the account credential WHOLESALE (atomic rename, new inode). If
            // this fails the real credential is untouched (still the old one), so the account is NOT
            // marked ready on a credential we could not install. A running container keeps its old
            // bound inode until the idle reconciler recreates it (grantRebuild, nudged below).
            try {
              applyCredentialReplace(s.writeDir, s.dir);
            } catch (err) {
              finish(s, {
                ok: false,
                loggedIn: false,
                subscriptionType: null,
                reason:
                  `signed in, but the new credential could not be written to the account in place (${(err as Error).message}). ` +
                  'The account is unchanged — it still has its previous credential; try again.',
              });
              return;
            }
          }
          markAccountReady(accountId, health);
          // Propagate the replaced credential to running sessions (BUG-254).
          // Fires only on a confirmed sign-in, after the fact is written down.
          try {
            opts.onReady?.(accountId);
          } catch {
            /* propagation is best-effort; it must not fail the login verdict */
          }
          finish(s, {
            ok: true,
            loggedIn: true,
            subscriptionType: health.subscriptionType,
            reason: `signed in${health.subscriptionType ? ` (${health.subscriptionType})` : ''}`,
          });
          return;
        }
        const how = signal ? `killed by ${signal}` : `exited ${code}`;
        finish(s, {
          ok: false,
          loggedIn: false,
          subscriptionType: null,
          reason:
            `the sign-in did not complete — \`claude auth status\` still reports logged out (the CLI ${how})` +
            (health.error ? `: ${health.error}` : '') +
            (s.reauth
              ? '. The account is unchanged — it still has its previous credential.'
              : '. The account is kept so you can try again.'),
        });
      })
      .catch((err: Error) => {
        finish(s, {
          ok: false,
          loggedIn: false,
          subscriptionType: null,
          reason: `could not confirm the sign-in: ${err.message}`,
        });
      });
  });

  // Hard ceiling. A CLI stuck on a round trip the user abandoned must not hold
  // a process (and a half-made account) open forever.
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  s.timers.push(
    setTimeout(() => {
      if (s.finished) return;
      killGroup(child);
      const removed = s.reauth ? false : dropPendingAccount(accountId);
      finish(s, {
        ok: false,
        loggedIn: false,
        subscriptionType: null,
        reason: `the sign-in timed out after ${Math.round(timeoutMs / 1000)}s — the CLI was stopped` +
          (removed ? ' and the half-made account removed' : s.reauth ? ' (the account is unchanged)' : ''),
        timedOut: true,
        accountRemoved: removed,
      });
    }, timeoutMs),
  );

  // Timely degradation: no URL within the grace window is REPORTED, with the
  // raw output, instead of leaving the panel silently waiting.
  const graceMs = opts.urlGraceMs ?? URL_GRACE_MS;
  s.timers.push(
    setTimeout(() => {
      if (s.finished || s.urlEmitted) return;
      s.emit({
        t: 'claude-login-status',
        accountId,
        message:
          'no authorize URL was found in the CLI output yet — the raw output is below; ' +
          'open any link it printed by hand, or cancel and try again',
        urlFound: false,
        raw: s.rawTail,
      });
    }, graceMs),
  );

  return { accountId, label: row.label, dir, pid: child.pid ?? -1, reauth };
}

/**
 * Feed the code the user pasted back from the sign-in page to the CLI's stdin.
 *
 * The code is written to the child and kept ONLY as a redaction secret. It is
 * never logged, never echoed into an event, never persisted.
 */
export function submitClaudeLoginCode(accountId: string, code: unknown): void {
  const s = active;
  if (!s || s.finished) throw new AccountError('no Claude login is in progress', 409);
  if (s.accountId !== accountId) throw new AccountError('that login is for a different account', 409);
  if (typeof code !== 'string' || !code.trim()) throw new AccountError('code must be a non-empty string', 400);
  const clean = code.trim();
  if (clean.length > 4_000) throw new AccountError('code is implausibly long', 400);
  s.secrets.push(clean);
  if (!s.child.stdin || s.child.stdin.destroyed) {
    throw new AccountError('the CLI is no longer accepting input', 409);
  }
  s.child.stdin.write(`${clean}\n`);
  // Deliberately NOT echoing the code back, not even truncated.
  s.emit({ t: 'claude-login-status', accountId, message: 'code sent to the CLI — waiting for it to finish' });
}

/**
 * Cancel the attempt: kill the child's process GROUP, then remove the pending
 * account so neither a stray process nor a half-made account survives.
 */
export function cancelClaudeLogin(accountId?: string, reason = 'cancelled'): boolean {
  const s = active;
  if (!s || s.finished) return false;
  if (accountId && s.accountId !== accountId) return false;
  killGroup(s.child);
  const removed = s.reauth ? false : dropPendingAccount(s.accountId);
  finish(s, {
    ok: false,
    loggedIn: false,
    subscriptionType: null,
    reason: `${reason} — the CLI was stopped` +
      (removed ? ' and the half-made account removed' : s.reauth ? ' (the account is unchanged)' : ''),
    cancelled: true,
    accountRemoved: removed,
  });
  return true;
}

/** True when the account's credential file exists (what the CLI actually writes). */
export function loginWroteCredential(accountId: string): boolean {
  try {
    return fs.existsSync(path.join(resolveAccountDir(accountId), '.credentials.json'));
  } catch {
    return false;
  }
}
