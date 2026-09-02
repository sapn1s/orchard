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
 *    subscription OAuth token Claude Code stores at ~/.claude/.credentials.json.
 *    It returns `five_hour` / `seven_day` `{ utilization, resets_at (ISO) }` plus
 *    a `limits[]` array flagging the currently-binding window. This is NOT
 *    scraping the TUI — it is the same JSON the TUI itself fetches.
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
import * as os from 'node:os';
import * as path from 'node:path';
import { detectCodex } from './runtime/codex-runtime.ts';

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

const cache = new Map<UsageProvider, ProviderUsage>();
const inflight = new Map<UsageProvider, Promise<void>>();

function unknown(provider: UsageProvider, note: string, keepAsOf: number | null = null): ProviderUsage {
  return { provider, available: false, asOf: keepAsOf, windows: [], plan: null, note };
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
    available: true,
    asOf: Date.now(),
    windows,
    plan: typeof rl.planType === 'string' ? rl.planType : null,
    note: null,
  };
}

/* ----------------------------------------------------------- Claude reader */

function readClaudeToken(): { token: string; plan: string | null } | { error: string } {
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { error: 'not signed in to Claude (no credentials)' }; }
  let oauth: Record<string, any> | undefined;
  try { oauth = (JSON.parse(raw) as Record<string, any>)?.claudeAiOauth; } catch { return { error: 'Claude credentials unreadable' }; }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || !token) return { error: 'not signed in to Claude' };
  return { token, plan: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : null };
}

/**
 * Read the Claude subscription usage windows from the OAuth usage endpoint.
 * Bounded by CLAUDE_TIMEOUT_MS via AbortSignal. The token is used only in the
 * Authorization header and never returned or logged.
 */
export async function readClaudeUsage(opts: { url?: string; timeoutMs?: number } = {}): Promise<ProviderUsage> {
  const url = opts.url ?? CLAUDE_USAGE_URL;
  const timeoutMs = opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const cred = readClaudeToken();
  if ('error' in cred) return unknown('anthropic', cred.error);

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
    return unknown('anthropic', why);
  }
  if (res.status === 401 || res.status === 403) return unknown('anthropic', 'Claude sign-in expired — re-authenticate');
  if (!res.ok) return unknown('anthropic', `Claude usage read failed (HTTP ${res.status})`);

  let body: Record<string, any>;
  try { body = (await res.json()) as Record<string, any>; } catch { return unknown('anthropic', 'Claude usage read returned non-JSON'); }
  return normalizeClaude(body, cred.plan);
}

function isoToEpochSec(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeClaude(body: Record<string, any>, plan: string | null): ProviderUsage {
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
  if (!windows.length) return unknown('anthropic', 'Claude returned no usable windows');
  if (!windows.some((w) => w.binding)) {
    let bi = 0;
    for (let i = 1; i < windows.length; i++) if (windows[i].usedPercent > windows[bi].usedPercent) bi = i;
    windows[bi].binding = true;
  }
  return { provider: 'anthropic', available: true, asOf: Date.now(), windows, plan, note: null };
}

/* ------------------------------------------------- cache / request surface */

function refresh(provider: UsageProvider): Promise<void> {
  const existing = inflight.get(provider);
  if (existing) return existing;
  const reader = provider === 'openai' ? readCodexUsage : readClaudeUsage;
  const p = reader()
    .then((snap) => {
      if (snap.available) {
        cache.set(provider, snap);
      } else {
        // Degrade to unknown, but PRESERVE the last good asOf so the UI can say
        // "last read at HH:MM" instead of erasing all history.
        const prev = cache.get(provider);
        cache.set(provider, { ...snap, asOf: prev?.asOf ?? null });
      }
    })
    .catch((err) => {
      const prev = cache.get(provider);
      cache.set(provider, unknown(provider, `usage read error: ${(err as Error).message}`, prev?.asOf ?? null));
    })
    .finally(() => { inflight.delete(provider); });
  inflight.set(provider, p);
  return p;
}

/**
 * The request-path surface. NEVER awaits the network: it returns whatever is
 * cached right now and kicks a background refresh if the snapshot is missing or
 * older than TTL_MS. First call for a provider returns a "reading…" placeholder;
 * the value lands on a later poll. This is what makes the endpoint non-blocking.
 */
export function getUsageSnapshots(providers: UsageProvider[] = ['anthropic', 'openai']): ProviderUsage[] {
  const now = Date.now();
  return providers.map((provider) => {
    const snap = cache.get(provider);
    const fresh = snap?.asOf != null && now - snap.asOf < TTL_MS;
    if (!fresh && !inflight.has(provider)) void refresh(provider);
    return snap ?? unknown(provider, 'reading…');
  });
}

/** Test/verify seam: force a synchronous read of one provider, bypassing cache. */
export async function readUsageNow(provider: UsageProvider): Promise<ProviderUsage> {
  return provider === 'openai' ? readCodexUsage() : readClaudeUsage();
}
