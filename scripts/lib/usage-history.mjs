/**
 * usage-history.mjs — the append-only burn history behind `npm run usage`
 * (FEAT-119), extracted from `scripts/usage.mts` by FEAT-145 step 7 so the
 * keying scheme can be graded directly by a verify script instead of only
 * through the CLI's side effects.
 *
 * ─────────────────────────── THE KEYING RULE (FEAT-145) ────────────────────
 *
 * A history row is keyed by `provider\x00label`, and rows are pruned to the last
 * KEEP per key. With two Claude accounts, the provider string is where the
 * account has to live — and the choice is load-bearing:
 *
 *   - the DEFAULT account is written as `'anthropic'`, BYTE-IDENTICAL to what
 *     every row written before FEAT-145 carries. Its existing history therefore
 *     keeps matching `priorFor()`, and the observed burn rate for the account
 *     the user has been on all along does NOT silently reset to "no history".
 *   - every OTHER account is written as `anthropic:<accountId>`. An old row can
 *     never match a new key, and each account gets its own KEEP bucket instead
 *     of interleaving two independent 5-hour windows into one series (which
 *     would produce a fabricated burn rate — the exact thing this file is not
 *     allowed to do).
 *
 * The only cost is that a brand-new account has no prior read on its first call,
 * so it reports a window-average rather than an observed rate. `deriveWindow`
 * already labels which one it used (`rateSource`), so that is displayed
 * honestly rather than shown as 0%/hr.
 *
 * Writes are best-effort: history is a nicety for the NEXT call's observed rate,
 * never a blocker for THIS call's answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How many rows to retain PER KEY. */
export const KEEP = 8;

export function dataDir() {
  if (process.env.CLAUDE_STATION_DATA) return process.env.CLAUDE_STATION_DATA;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'claude-station');
  return path.join(os.homedir(), '.local', 'share', 'claude-station');
}

export function historyFile() {
  return path.join(dataDir(), 'usage-burn-history.jsonl');
}

/** The one value that MEANS "the default Claude account" (claude-accounts.ts DEFAULT_ACCOUNT_ID). */
export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * The history key for a (provider, accountId) pair. See THE KEYING RULE above:
 * the default Claude account keeps the bare `'anthropic'` key it has always had.
 *
 * WHY THE DEFAULT NEEDS A POSITIVE SENTINEL (FEAT-145 step 6+7 round). This
 * function used to read `if (!accountId || accountId === 'default')`, so EVERY
 * falsy id — `''`, `undefined`, `null`, `0`, `false` — silently wrote into the
 * DEFAULT account's series. `usage-burn-history.jsonl` is append-only user data
 * and the burn rate is computed from it, so a mis-keyed row does not error, it
 * FABRICATES a rate for an account that never produced it.
 *
 * The verifier reclassified that unreachable — correctly, but only because the
 * registry's 8–64-hex `ID_RE` drops such ids UPSTREAM, in `claude-accounts.ts`.
 * The guard did not live in the file that depends on it (the ARCH-010 shape in
 * miniature), so an id arriving by any other route — a hand-built snapshot, a
 * future caller, a test — was folded into the user's real history in silence.
 *
 * So: the default is claimed by NAME, never by absence, and anything that is
 * neither the sentinel nor a real id is refused out loud. The on-disk keying is
 * untouched (`'anthropic'` for the default, `anthropic:<id>` for the rest) —
 * this is a guard, not a re-keying, and pre-existing rows stay byte-identical.
 */
export function histKey(provider, accountId) {
  if (provider !== 'anthropic') return provider;
  if (accountId === DEFAULT_ACCOUNT_ID) return 'anthropic';
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error(
      `usage-history: refusing to key a burn-history row from account id ${JSON.stringify(accountId)}. ` +
      `The default Claude account must be named explicitly ('${DEFAULT_ACCOUNT_ID}'); an empty or absent id is ` +
      'not a synonym for it, because folding it into the default silently corrupts that account\'s observed burn rate ' +
      'in the append-only usage-burn-history.jsonl.',
    );
  }
  return `anthropic:${accountId}`;
}

/**
 * The history key a ProviderUsage snapshot's rows belong under. A Claude
 * snapshot always carries its account id (`provider-usage.ts` defaults every
 * anthropic target and every `unknown()` degrade to DEFAULT_ACCOUNT_ID), so the
 * id is passed STRAIGHT through — no `?? default` here, or this reader would be
 * the second place deciding what an absent id means.
 */
export function histKeyForSnapshot(snap) {
  return histKey(snap?.provider, snap?.accountId);
}

/**
 * Read the burn history, tolerant of a torn tail line (this file is only written
 * by the usage command, so there is no concurrent-writer race — but a
 * half-flushed final line from an interrupted run must not lose the rest).
 */
export function readHistory(file = historyFile()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.provider === 'string' && typeof r.at === 'number') out.push(r);
    } catch { /* torn tail */ }
  }
  return out;
}

/** The most recent prior read of a given window instance, matched on resetsAt. */
export function priorFor(history, provider, label, resetsAt) {
  let best = null;
  for (const r of history) {
    if (r.provider !== provider || r.label !== label) continue;
    if (resetsAt != null && r.resetsAt !== resetsAt) continue; // same window instance only
    if (best == null || r.at > best.at) best = r;
  }
  return best;
}

/** The rows one read produces: one per usable window of every AVAILABLE snapshot. */
export function rowsFromSnapshots(snaps, now) {
  const rows = [];
  for (const s of snaps) {
    if (!s?.available) continue;
    const key = histKeyForSnapshot(s);
    for (const w of s.windows ?? []) {
      if (typeof w.usedPercent === 'number') {
        rows.push({ provider: key, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, at: now });
      }
    }
  }
  return rows;
}

/**
 * Append the windows just read, and keep the file small by retaining only the
 * last KEEP rows per (provider,label). Bounded and best-effort: a write failure
 * is swallowed.
 */
export function appendHistory(rows, file = historyFile()) {
  if (!rows.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const all = [...readHistory(file), ...rows];
    const byKey = new Map();
    for (const r of all) {
      const k = `${r.provider}\x00${r.label}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const pruned = [];
    for (const list of byKey.values()) {
      list.sort((a, b) => a.at - b.at);
      pruned.push(...list.slice(-KEEP));
    }
    pruned.sort((a, b) => a.at - b.at);
    fs.writeFileSync(file, pruned.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch { /* history is best-effort */ }
}
