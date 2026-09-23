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
  dir: string;
  child: ChildProcess;
  emit: LoginEmit;
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
 * Start the login for a PENDING account. Refuses, with a distinct status, when:
 * another attempt is live (409), the id is the default (400), the account does
 * not exist (404), or it is already `ready` (409 — logging in over a live
 * credential would silently replace a working account).
 */
export function startClaudeLogin(
  accountId: string,
  emit: LoginEmit,
  opts: { timeoutMs?: number; urlGraceMs?: number } = {},
): { accountId: string; label: string; dir: string; pid: number } {
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
  if (row.state !== 'pending') {
    throw new AccountError(
      `account "${row.label}" is already logged in (state: ${row.state}) — delete it and add it again to re-authenticate`,
      409,
    );
  }

  const { dir } = materialiseAccountDir(accountId); // idempotent; repairs the overlay
  const bin = process.env.CLAUDE_STATION_CLAUDE_BIN || 'claude';

  /*
   * The child env. `CLAUDE_CONFIG_DIR` is the whole point — it is what makes
   * the CLI write `.credentials.json` into THIS account's overlay instead of
   * the user's real store. `BROWSER`/`DISPLAY` are the "do not open a browser
   * on the server's own desktop" contract.
   */
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir, BROWSER: '/usr/bin/true' };
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
    child,
    emit,
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
    dropPendingAccount(accountId);
    finish(s, {
      ok: false,
      loggedIn: false,
      subscriptionType: null,
      reason: `could not run \`${bin} auth login --claudeai\`: ${err.message}`,
      accountRemoved: true,
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
    void readAccountHealth(accountId)
      .then((health) => {
        if (health.loggedIn) {
          markAccountReady(accountId, health);
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
            '. The account is kept so you can try again.',
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
      const removed = dropPendingAccount(accountId);
      finish(s, {
        ok: false,
        loggedIn: false,
        subscriptionType: null,
        reason: `the sign-in timed out after ${Math.round(timeoutMs / 1000)}s — the CLI was stopped and the half-made account removed`,
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

  return { accountId, label: row.label, dir, pid: child.pid ?? -1 };
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
  const removed = dropPendingAccount(s.accountId);
  finish(s, {
    ok: false,
    loggedIn: false,
    subscriptionType: null,
    reason: `${reason} — the CLI was stopped${removed ? ' and the half-made account removed' : ''}`,
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
