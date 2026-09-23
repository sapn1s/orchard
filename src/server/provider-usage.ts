/**
 * FEAT-116 — provider rate-limit window usage, for the dispatch-now-vs-park
 * decision. Answers "how much of each provider's window have I burned, and when
 * does it reset?" from the PROVIDER'S OWN interface — never inferred from
 * Orchard's token/cost accounting (that measures spend, not quota).
 *
 * Two real sources, established from each tool's own interface:
 *
 *  - OpenAI/Codex: `codex app-server` speaks the `account/rateLimits/read`
 *    JSON-RPC method (schema `GetAccountRateLimitsResponse`, codex-cli 0.152.1).
 *    Its `rateLimits.primary` is the rolling 5-hour window and `.secondary` the
 *    weekly one, each `{ usedPercent, resetsAt (unix sec), windowDurationMins }`.
 *    We spawn a short-lived app-server, initialize, read once, and kill it.
 *
 *  - Anthropic/Claude: the CLI's `/usage` view is backed by the OAuth endpoint
 *    `GET https://api.anthropic.com/api/oauth/usage`, authorized with the same
 *    subscription OAuth token Claude Code stores at `<config dir>/.credentials.json`.
 *    It returns `five_hour` / `seven_day` `{ utilization, resets_at (ISO) }` plus
 *    a `limits[]` array flagging the currently-binding window. This is NOT
 *    scraping the TUI — it is the same JSON the TUI itself fetches.
 *
 * FEAT-145 step 7 — PER-ACCOUNT. Two Claude subscriptions are two INDEPENDENT
 * 5-hour windows, and the number that says "switch accounts now" only exists if
 * each account is read separately. So:
 *  - the token is read from the ACCOUNT'S OWN config dir, which only
 *    `claude-accounts.resolveAccountDir(id)` may map (ARCH-010 — never rederived
 *    here). The endpoint is per-token, so nothing else about the request changes.
 *  - the cache/inflight maps are keyed by `provider\x00accountId`, not by
 *    provider alone — keyed by provider, account B would be served account A's
 *    snapshot for up to the TTL.
 *  - every snapshot keeps `provider: 'anthropic'`, and the DEFAULT account is
 *    emitted FIRST, so the pre-145 call sites that do
 *    `.find(s => s.provider === 'anthropic')` keep resolving to exactly the same
 *    snapshot they did before. A single-account user sees no change at all.
 *  - one account's 401/timeout/pending state degrades ONLY that account's
 *    snapshot to unknown; it can never take down another account's read.
 *
 * THE HARD RULES this module keeps (from the FEAT-116 charter):
 *  - Never block a session or a UI control on this. Every read is bounded by a
 *    timeout; the request path (`getUsageSnapshots`) NEVER awaits the network —
 *    it serves the cache and revalidates in the background (stale-while-refresh).
 *  - Never show a stale value as live: every snapshot carries `asOf` (ms) so the
 *    caller can say when it was last read; a failed/timed-out read degrades to
 *    `available:false` (unknown), it does not overwrite a good value with a lie.
 *  - No credentials anywhere. The OAuth token is read at call time, used only in
 *    the Authorization header, and never logged, returned, or surfaced.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectCodex } from './runtime/codex-runtime.ts';
import { DEFAULT_ACCOUNT_ID, defaultAccountRow, listAccounts, resolveAccountDir } from './claude-accounts.ts';

export type UsageProvider = 'anthropic' | 'openai';

/** One rate-limit window: how much is used and when it rolls over. */
export interface UsageWindow {
  /** Human label — '5h', 'weekly', or a scoped variant like 'weekly · Fable'. */
  label: string;
  /** Percent of the window consumed, 0–100 (rounded). */
  usedPercent: number;
  /** Unix SECONDS when the window resets, or null if the provider omits it. */
  resetsAt: number | null;
  /** True for the window that is the current binding constraint, if known. */
  binding?: boolean;
}

/** A provider's usage snapshot. `available:false` means "unknown", not "0%". */
export interface ProviderUsage {
  provider: UsageProvider;
  /**
   * FEAT-145: which Claude account this snapshot belongs to (`'default'` for the
   * implicit `~/.claude` one). `null` for providers that have no account axis
   * (openai). `provider` deliberately stays `'anthropic'` for every account.
   */
  accountId: string | null;
  /** The account's human label, or null when there is no account axis. */
  accountLabel: string | null;
  available: boolean;
  /** Epoch ms of the last SUCCESSFUL read, or null if never read. */
  asOf: number | null;
  windows: UsageWindow[];
  /** Plan/tier label when the source reports one (e.g. 'plus', 'max'). */
  plan?: string | null;
  /** Plain-words reason when unavailable/degraded. NEVER contains a credential. */
  note?: string | null;
}

/** How long a snapshot is considered fresh before a background refresh fires. */
const TTL_MS = 60_000;
/** Hard ceilings so a wedged provider can never hold anything open. */
const CODEX_TIMEOUT_MS = 6_000;
const CLAUDE_TIMEOUT_MS = 6_000;

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Test seam ONLY (same idiom as `CLAUDE_STATION_CLAUDE_BIN` in claude-accounts):
 * lets a verify script point the reader at a local stub server so the suite
 * never touches the live Anthropic endpoint. Unset in normal operation.
 */
function claudeUsageUrl(): string {
  return process.env.CLAUDE_STATION_USAGE_URL || CLAUDE_USAGE_URL;
}

/**
 * One thing whose usage can be read: a provider, plus (for anthropic) WHICH
 * account. This is the unit the cache is keyed by and the unit the request
 * surface enumerates.
 */
export interface UsageTarget {
  provider: UsageProvider;
  /** `'default'` … for anthropic; `null` for providers with no account axis. */
  accountId: string | null;
  accountLabel: string | null;
}

/** The cache/inflight key. Keyed by provider ALONE, account B would be served A's snapshot. */
function targetKey(t: UsageTarget): string {
  return `${t.provider}\x00${t.accountId ?? ''}`;
}

/**
 * Everything worth reading right now: every registered Claude account (the
 * implicit DEFAULT first — `listAccounts()` guarantees that order), then openai.
 * A corrupt/unreadable registry degrades to the default account alone rather
 * than throwing; usage must never be able to break a request path.
 */
export function usageTargets(): UsageTarget[] {
  let rows;
  try {
    rows = listAccounts();
  } catch {
    rows = [defaultAccountRow()];
  }
  if (!rows.length) rows = [defaultAccountRow()];
  const out: UsageTarget[] = rows.map((r) => ({
    provider: 'anthropic' as const,
    accountId: r.id,
    accountLabel: r.label,
  }));
  out.push({ provider: 'openai', accountId: null, accountLabel: null });
  return out;
}

const cache = new Map<string, ProviderUsage>();
const inflight = new Map<string, Promise<void>>();

function unknown(
  provider: UsageProvider,
  note: string,
  keepAsOf: number | null = null,
  account: { id: string | null; label: string | null } = { id: null, label: null },
): ProviderUsage {
  return {
    provider,
    accountId: account.id,
    accountLabel: account.label,
    available: false,
    asOf: keepAsOf,
    windows: [],
    plan: null,
    note,
  };
}

/* ------------------------------------------------------------ Codex reader */

interface CodexFrame { id?: number; method?: string; result?: unknown; error?: { message?: string } }

/**
 * Drive a short-lived `codex app-server` to read `account/rateLimits/read`.
 * Everything is bounded by CODEX_TIMEOUT_MS: on timeout, spawn error, non-JSON,
 * or a JSON-RPC error we resolve to "unknown" and kill the child. No throw
 * escapes; the caller always gets a ProviderUsage.
 */
export async function readCodexUsage(opts: { timeoutMs?: number } = {}): Promise<ProviderUsage> {
  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;
  const det = detectCodex();
  const bin = det.binaryPath;
  if (!bin) return unknown('openai', 'Codex CLI not found — install it and sign in');

  return await new Promise<ProviderUsage>((resolve) => {
    let settled = false;
    const finish = (u: ProviderUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(u);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      return resolve(unknown('openai', `Codex app-server failed to spawn: ${(err as Error).message}`));
    }

    const timer = setTimeout(() => finish(unknown('openai', 'Codex usage read timed out')), timeoutMs);
    child.once('error', (err: Error) => finish(unknown('openai', `Codex app-server error: ${err.message}`)));
    child.once('exit', () => finish(unknown('openai', 'Codex app-server exited before answering')));

    let nextId = 0;
    let rlId = -1;
    const write = (frame: Record<string, unknown>) => {
      try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); } catch { /* closing */ }
    };

    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: CodexFrame;
        try { frame = JSON.parse(line) as CodexFrame; } catch { continue; }
        if (frame.id === 0 && frame.method == null) {
          // initialize acked → announce initialized, then ask for the limits.
          write({ method: 'initialized', params: {} });
          rlId = ++nextId;
          write({ id: rlId, method: 'account/rateLimits/read', params: null });
        } else if (frame.id === rlId && frame.method == null) {
          if (frame.error) return finish(unknown('openai', 'Codex declined the rate-limit read'));
          return finish(normalizeCodex(frame.result));
        }
      }
    });

    // Kick the handshake. id:0 is the initialize response we key on above.
    write({ id: nextId, method: 'initialize', params: { clientInfo: { name: 'orchard', version: '0.1.0' }, capabilities: {} } });
  });
}

function normalizeCodex(result: unknown): ProviderUsage {
  const r = result as Record<string, any> | null | undefined;
  const rl = r?.rateLimits as Record<string, any> | undefined;
  if (!rl) return unknown('openai', 'Codex returned no rate-limit data');
  const windows: UsageWindow[] = [];
  const mk = (w: any, fallbackLabel: string): UsageWindow | null => {
    if (!w || typeof w.usedPercent !== 'number') return null;
    const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
    const label = mins === 300 ? '5h' : mins === 10080 ? 'weekly' : mins != null ? `${Math.round(mins / 60)}h` : fallbackLabel;
    return { label, usedPercent: Math.round(w.usedPercent), resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null };
  };
  const primary = mk(rl.primary, '5h');
  const secondary = mk(rl.secondary, 'weekly');
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  if (!windows.length) return unknown('openai', 'Codex returned no usable windows');
  // Binding = the fullest window.
  let bi = 0;
  for (let i = 1; i < windows.length; i++) if (windows[i].usedPercent > windows[bi].usedPercent) bi = i;
  windows[bi].binding = true;
  return {
    provider: 'openai',
    accountId: null,
    accountLabel: null,
    available: true,
    asOf: Date.now(),
    windows,
    plan: typeof rl.planType === 'string' ? rl.planType : null,
    note: null,
  };
}

/* ----------------------------------------------------------- Claude reader */

/**
 * Read one ACCOUNT's OAuth token. `accountDir` is the account's config dir and
 * is always supplied by the caller from `resolveAccountDir(id)` — this function
 * never derives a dir itself (ARCH-010) and never consults `CLAUDE_CONFIG_DIR`,
 * which describes the process's own session, not the account being polled.
 */
function readClaudeToken(accountDir: string): { token: string; plan: string | null } | { error: string } {
  const file = path.join(accountDir, '.credentials.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { error: 'not signed in to Claude (no credentials)' }; }
  let oauth: Record<string, any> | undefined;
  try { oauth = (JSON.parse(raw) as Record<string, any>)?.claudeAiOauth; } catch { return { error: 'Claude credentials unreadable' }; }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || !token) return { error: 'not signed in to Claude' };
  return { token, plan: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : null };
}

/**
 * Read ONE Claude account's subscription usage windows from the OAuth usage
 * endpoint. Bounded by CLAUDE_TIMEOUT_MS via AbortSignal. The token is used only
 * in the Authorization header and never returned or logged.
 *
 * The endpoint is PER-TOKEN, so the account is expressed entirely by which
 * `.credentials.json` the token came from — nothing else about the request
 * changes. Defaults to the implicit default account, which is what every
 * pre-FEAT-145 caller means.
 */
export async function readClaudeUsage(
  opts: { url?: string; timeoutMs?: number; accountId?: string; accountLabel?: string | null } = {},
): Promise<ProviderUsage> {
  const url = opts.url ?? claudeUsageUrl();
  const timeoutMs = opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const account = { id: accountId, label: opts.accountLabel ?? null };
  let accountDir: string;
  try {
    accountDir = resolveAccountDir(accountId);
  } catch (err) {
    // A malformed id is this account's problem alone — degrade, never throw.
    return unknown('anthropic', `unknown Claude account (${(err as Error).message})`, null, account);
  }
  const cred = readClaudeToken(accountDir);
  if ('error' in cred) return unknown('anthropic', cred.error, null, account);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'orchard/0.1',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = (err as Error)?.name === 'TimeoutError' ? 'Claude usage read timed out' : 'Claude usage read failed (network)';
    return unknown('anthropic', why, null, account);
  }
  if (res.status === 401 || res.status === 403) {
    return unknown('anthropic', 'Claude sign-in expired — re-authenticate', null, account);
  }
  if (!res.ok) return unknown('anthropic', `Claude usage read failed (HTTP ${res.status})`, null, account);

  let body: Record<string, any>;
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    return unknown('anthropic', 'Claude usage read returned non-JSON', null, account);
  }
  return normalizeClaude(body, cred.plan, account);
}

function isoToEpochSec(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeClaude(
  body: Record<string, any>,
  plan: string | null,
  account: { id: string | null; label: string | null } = { id: DEFAULT_ACCOUNT_ID, label: null },
): ProviderUsage {
  const windows: UsageWindow[] = [];
  const five = body.five_hour as Record<string, any> | undefined;
  const seven = body.seven_day as Record<string, any> | undefined;
  if (five && typeof five.utilization === 'number') {
    windows.push({ label: '5h', usedPercent: Math.round(five.utilization), resetsAt: isoToEpochSec(five.resets_at) });
  }
  if (seven && typeof seven.utilization === 'number') {
    windows.push({ label: 'weekly', usedPercent: Math.round(seven.utilization), resetsAt: isoToEpochSec(seven.resets_at) });
  }
  // The `limits[]` array names the ACTIVE binding window (e.g. a model-scoped
  // weekly cap). Surface a scoped one when it's the active constraint so the
  // decision reflects what will actually stop the next lane.
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const activeScoped = limits.find((l: any) => l?.is_active && l?.group === 'weekly' && l?.scope?.model?.display_name && typeof l?.percent === 'number');
  if (activeScoped) {
    windows.push({
      label: `weekly · ${String(activeScoped.scope.model.display_name)}`,
      usedPercent: Math.round(activeScoped.percent),
      resetsAt: isoToEpochSec(activeScoped.resets_at),
      binding: true,
    });
  }
  if (!windows.length) return unknown('anthropic', 'Claude returned no usable windows', null, account);
  if (!windows.some((w) => w.binding)) {
    let bi = 0;
    for (let i = 1; i < windows.length; i++) if (windows[i].usedPercent > windows[bi].usedPercent) bi = i;
    windows[bi].binding = true;
  }
  return {
    provider: 'anthropic',
    accountId: account.id,
    accountLabel: account.label,
    available: true,
    asOf: Date.now(),
    windows,
    plan,
    note: null,
  };
}

/* ------------------------------------------------- cache / request surface */

/** Read exactly one target, bypassing the cache. Never throws. */
export function readUsageForTarget(t: UsageTarget): Promise<ProviderUsage> {
  if (t.provider === 'openai') return readCodexUsage();
  return readClaudeUsage({
    accountId: t.accountId ?? DEFAULT_ACCOUNT_ID,
    accountLabel: t.accountLabel,
  });
}

function refresh(t: UsageTarget): Promise<void> {
  const key = targetKey(t);
  const existing = inflight.get(key);
  if (existing) return existing;
  const account = { id: t.accountId, label: t.accountLabel };
  const p = readUsageForTarget(t)
    .then((snap) => {
      if (snap.available) {
        cache.set(key, snap);
      } else {
        // Degrade to unknown, but PRESERVE the last good asOf so the UI can say
        // "last read at HH:MM" instead of erasing all history.
        const prev = cache.get(key);
        cache.set(key, { ...snap, asOf: prev?.asOf ?? null });
      }
    })
    .catch((err) => {
      // One account's failure lands in THAT account's cache slot only — it can
      // never overwrite or block another account's snapshot.
      const prev = cache.get(key);
      cache.set(key, unknown(t.provider, `usage read error: ${(err as Error).message}`, prev?.asOf ?? null, account));
    })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/**
 * The request-path surface. NEVER awaits the network: it returns whatever is
 * cached right now and kicks a background refresh if the snapshot is missing or
 * older than TTL_MS. First call for a target returns a "reading…" placeholder;
 * the value lands on a later poll. This is what makes the endpoint non-blocking.
 *
 * FEAT-145: the DEFAULT Claude account is always first (see `usageTargets`), so
 * `.find(s => s.provider === 'anthropic')` — which is what `public/app.js` does —
 * still resolves to the default account's snapshot, unchanged.
 */
export function getUsageSnapshots(targets: UsageTarget[] = usageTargets()): ProviderUsage[] {
  const now = Date.now();
  return targets.map((t) => {
    const key = targetKey(t);
    const snap = cache.get(key);
    const fresh = snap?.asOf != null && now - snap.asOf < TTL_MS;
    if (!fresh && !inflight.has(key)) void refresh(t);
    return snap ?? unknown(t.provider, 'reading…', null, { id: t.accountId, label: t.accountLabel });
  });
}

/**
 * Test/verify seam: force a synchronous read of one provider, bypassing cache.
 * `accountId` selects the Claude account; omitted, it means the default one.
 */
export async function readUsageNow(provider: UsageProvider, accountId?: string): Promise<ProviderUsage> {
  if (provider === 'openai') return readCodexUsage();
  return readClaudeUsage({ accountId: accountId ?? DEFAULT_ACCOUNT_ID });
}
