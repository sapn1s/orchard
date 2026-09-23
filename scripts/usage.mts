#!/usr/bin/env node
/**
 * usage.mts — FEAT-119. The on-demand answer to "can I afford to dispatch this,
 * and at what tier?", for a session that is ABOUT to fan out.
 *
 *   npm run usage            # human-readable readout
 *   npm run usage -- --json  # machine-readable, for a session to parse
 *
 * WHY A COMMAND AND NOT INJECTED TEXT. FEAT-113 established that per-turn-volatile
 * numbers in the system prompt bust the whole cached prefix (~$255–318/month of
 * `cache_miss_reason: system_changed`). Live usage is the most volatile number
 * there is, so it must NOT ride the system prompt. A command is:
 *   - always current (read at call time, not stale from launch),
 *   - only paid for when a decision is actually being made,
 *   - obtainable by a RUNNING session too — a session cannot have its system
 *     prompt changed mid-flight, but it can run a command any time. New sessions
 *     also see a one-line pointer to it in the first-turn board preamble
 *     (boardStateSection), which is off-system and therefore cache-safe.
 *
 * THREE THINGS IT SHOWS, kept strictly separate so none is passed off as another:
 *   1. PROVIDER WINDOW USAGE — percent consumed + reset, from the provider's OWN
 *      interface (src/server/provider-usage.ts, FEAT-116). Reused, not re-read.
 *   2. BURN RATE vs the reset — observed %/hr between successive reads, or a
 *      labelled window-average on the first read (scripts/lib/usage-burn.mjs).
 *   3. OUR OWN SPEND — what this workspace's lanes have consumed, from the cost
 *      model over this project's transcripts. Labelled a LOWER BOUND and OUR
 *      accounting, NEVER conflated with the provider's quota: they measure
 *      different things and mixing them would corrupt the very decision this
 *      exists to serve.
 *
 * HARD RULES it keeps: never fabricate a number (unknown says unknown); always
 * say when it was read (asOf); bounded and non-blocking (the provider reads carry
 * the module's own hard timeouts and never throw); no credential anywhere.
 */
import path from 'node:path';

import { readUsageForTarget, usageTargets, type ProviderUsage } from '../src/server/provider-usage.ts';
import { deriveWindow, overallVerdict, verdictAdvice } from './lib/usage-burn.mjs';
import { appendHistory, histKeyForSnapshot, priorFor, readHistory, rowsFromSnapshots } from './lib/usage-history.mjs';

/* ------------------------------------------------------------------ history */

/*
 * FEAT-145 step 7: the history reader/writer now lives in
 * `scripts/lib/usage-history.mjs` so the KEYING RULE it documents (default
 * account = bare `'anthropic'`, byte-identical to every pre-145 row; every other
 * account = `anthropic:<id>`, its own KEEP bucket) can be graded directly by
 * `scripts/verify-feat-145-usage.mjs` rather than only through this CLI.
 */
interface HistRow { provider: string; label: string; usedPercent: number; resetsAt: number | null; at: number }

/* -------------------------------------------------------------- own spend */

/**
 * What THIS workspace's lanes have consumed, from the cost model over this
 * project's transcripts. Bounded to a recent window (local disk read only) and
 * fully guarded: any failure degrades to a stated "unavailable", never a zero.
 *
 * Kept ARCHITECTURALLY apart from the provider windows above: this is dollars we
 * would have paid at list rates (a LOWER BOUND, subscription is flat), NOT a
 * fraction of any provider quota. The two never share a number.
 */
async function ownSpend(project: string): Promise<
  | { available: true; asOf: number; windows: { label: string; hours: number; cost: number | null; priced: number; lanes: number; unpriced: boolean; prorated: boolean }[]; ledgerFloor: string; anyProrated: boolean }
  | { available: false; note: string }
> {
  try {
    const { collect } = await import('./cost-collect.mjs');
    const sevenDays = Date.now() - 7 * 86400e3;
    const res = await collect({ project, all: false, since: sevenDays, top: 25, ticket: null });
    if (res.error) return { available: false, note: res.error };
    const lanes = res.lanes ?? [];
    const now = Date.now();

    /*
     * BUG-175 DEFECT 2. Attribute each REQUEST's cost to the window containing
     * THAT request's own timestamp — not the whole lane's cost to the window
     * containing its `ended_at`. The old rule dropped a 36-day session's entire
     * $2088 into "last 7d" because that is when it ended, over-reporting 7-day
     * spend ~4×. `request_costs` (from cost-model.laneRequestCosts, attached in
     * memory by collect()) carries per-request at_ms + priced cost.
     *
     * A request with an unparseable timestamp (at_ms null) is PRORATED across the
     * lane's [started_at, ended_at] span rather than silently mis-binned, and the
     * output says when any proration happened.
     */
    const mk = (label: string, hours: number) => {
      const cutoff = now - hours * 3.6e6;
      let priced = 0;
      let unpriced = false;
      let prorated = false;
      const lanesTouching = new Set<string>();

      for (const l of lanes as any[]) {
        const reqs: { at_ms: number | null; cost_usd: number | null; cost_priced_usd: number }[] = l.request_costs ?? [];
        const laneStart = Date.parse(l.started_at ?? '');
        const laneEnd = Date.parse(l.ended_at ?? l.started_at ?? '');
        // Fraction of the lane's own span that falls inside this window — used to
        // prorate requests whose individual timestamp is missing.
        const spanFrac = (() => {
          if (!Number.isFinite(laneStart) || !Number.isFinite(laneEnd) || laneEnd <= laneStart) {
            // A point-in-time (or undated) lane: fall back to ended_at membership.
            return Number.isFinite(laneEnd) && laneEnd >= cutoff ? 1 : 0;
          }
          const lo = Math.max(laneStart, cutoff);
          const hi = laneEnd;
          return hi > lo ? (hi - lo) / (laneEnd - laneStart) : 0;
        })();

        for (const rq of reqs) {
          if (rq.at_ms != null && Number.isFinite(rq.at_ms)) {
            if (rq.at_ms >= cutoff) {
              priced += rq.cost_priced_usd;
              if (rq.cost_usd == null) unpriced = true;
              lanesTouching.add(l.lane_id);
            }
          } else {
            // No per-request timestamp: prorate across the lane span, flagged.
            if (spanFrac > 0) {
              prorated = true;
              priced += rq.cost_priced_usd * spanFrac;
              if (rq.cost_usd == null) unpriced = true;
              lanesTouching.add(l.lane_id);
            }
          }
        }
      }
      return {
        label,
        hours,
        cost: unpriced ? null : Math.round(priced * 100) / 100,
        priced: Math.round(priced * 100) / 100,
        lanes: lanesTouching.size,
        unpriced,
        prorated,
      };
    };

    const windows = [mk('last 5h', 5), mk('last 24h', 24), mk('last 7d', 168)];
    return {
      available: true,
      asOf: now,
      windows,
      anyProrated: windows.some((w) => w.prorated),
      ledgerFloor:
        'OUR accounting (list-rate equivalent, a LOWER BOUND ~5%/session low) — NOT the provider quota above. Cost is binned per REQUEST timestamp (BUG-175), not by lane end.',
    };
  } catch (err) {
    return { available: false, note: `own-spend read failed: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ compose */

interface DerivedProvider {
  provider: string;
  /** FEAT-145: which Claude account this row is; null where there is no account axis. */
  accountId: string | null;
  accountLabel: string | null;
  /** The burn-history key this account's rows live under (`histKey`). */
  historyKey: string;
  available: boolean;
  asOf: number | null;
  plan: string | null;
  note: string | null;
  windows: ReturnType<typeof deriveWindow>[];
  overall: ReturnType<typeof overallVerdict>;
}

function deriveProvider(snap: ProviderUsage, history: HistRow[], now: number): DerivedProvider {
  // The history key, NOT snap.provider: two accounts are two independent 5-hour
  // windows and must never be matched against each other's prior reads.
  const key = histKeyForSnapshot(snap);
  const windows = snap.available
    ? snap.windows.map((w) => deriveWindow(w, { now, prior: priorFor(history, key, w.label, w.resetsAt) }))
    : [];
  return {
    provider: snap.provider,
    accountId: snap.accountId ?? null,
    accountLabel: snap.accountLabel ?? null,
    historyKey: key,
    available: snap.available,
    asOf: snap.asOf,
    plan: snap.plan ?? null,
    note: snap.note ?? null,
    windows,
    overall: overallVerdict(windows),
  };
}

/* -------------------------------------------------------------------- format */

const pct = (n: number | null) => (n == null ? '  ?' : `${Math.round(n)}%`);
const hrs = (n: number | null) => (n == null ? '?' : n === Infinity ? '∞' : `${n.toFixed(1)}h`);
const rate = (n: number | null) => (n == null ? '?' : `${n.toFixed(1)}%/hr`);
const ago = (ms: number | null) => (ms == null ? 'never' : `${Math.max(0, Math.round((Date.now() - ms) / 1000))}s ago`);

function formatText(providers: DerivedProvider[], spend: Awaited<ReturnType<typeof ownSpend>>): string {
  const L: string[] = [];
  L.push('');
  L.push('  USAGE & BURN — read on demand, current as of now. Decide dispatch tier from this.');
  L.push('  Provider quota below is the PROVIDER\'S OWN measure; our spend at the end is a');
  L.push('  separate, list-rate estimate — never the same number.');
  L.push('');
  // FEAT-145: one clearly-labelled block PER ACCOUNT, so this command answers
  // "which plan can I dispatch on right now" rather than only "the first one".
  // With exactly one Claude account the label is omitted, so a single-account
  // user's readout is unchanged.
  const claudeAccounts = providers.filter((p) => p.provider === 'anthropic');
  const multiAccount = claudeAccounts.length > 1;
  for (const p of providers) {
    const who = `${p.provider.toUpperCase()}${multiAccount && p.accountLabel ? ` · ${p.accountLabel}` : ''}`;
    if (!p.available) {
      L.push(`  ${who}: unavailable — ${p.note ?? 'unknown'} (last good read ${ago(p.asOf)})`);
      L.push('');
      continue;
    }
    L.push(`  ${who}${p.plan ? ` (${p.plan})` : ''}  · read ${ago(p.asOf)}`);
    for (const w of p.windows) {
      const bind = w.binding ? ' [binding]' : '';
      const src = w.rateSource ? ` ${w.rateSource}` : '';
      L.push(
        `    ${String(w.label + bind).padEnd(22)} ${pct(w.usedPercent).padStart(4)} used · resets in ${hrs(w.hoursToReset)}`,
      );
      L.push(
        `      burn ${rate(w.rate)}${src} · sustainable ≤${rate(w.sustainablePerHr)} · to-cap ${hrs(w.projectedHoursToCap)} → ${w.verdict.toUpperCase()}`,
      );
    }
    if (p.overall) L.push(`    → ${verdictAdvice(p.overall.verdict)} (driven by ${p.overall.window.label})`);
    L.push('');
  }
  if (multiAccount) {
    // Which Claude plan has the most 5h headroom RIGHT NOW — the whole point of
    // holding two subscriptions (FEAT-145). Unknown accounts are named as
    // unknown, never treated as 0% used.
    const five = (p: DerivedProvider) => p.windows.find((w) => /^5h$/.test(String(w.label)));
    const known = claudeAccounts.filter((p) => p.available && five(p) != null);
    const unknownNames = claudeAccounts.filter((p) => !p.available || five(p) == null).map((p) => p.accountLabel ?? p.accountId ?? '?');
    if (known.length) {
      const best = known.reduce((a, b) => ((five(b)!.usedPercent ?? 100) < (five(a)!.usedPercent ?? 100) ? b : a));
      L.push(`  CLAUDE ACCOUNTS — most 5h headroom: ${best.accountLabel ?? best.accountId} (${pct(five(best)!.usedPercent)} used, resets in ${hrs(five(best)!.hoursToReset)})`);
      for (const p of known) {
        L.push(`    ${String(p.accountLabel ?? p.accountId).padEnd(28)} ${pct(five(p)!.usedPercent).padStart(4)} of 5h · resets in ${hrs(five(p)!.hoursToReset)}`);
      }
    }
    if (unknownNames.length) L.push(`    unknown (not readable right now): ${unknownNames.join(', ')}`);
    L.push('');
  }
  L.push('  ── OUR OWN SPEND (workspace) ──────────────────────────────────────────');
  if (!spend.available) {
    L.push(`  unavailable — ${spend.note}`);
  } else {
    L.push(`  ${spend.ledgerFloor}`);
    for (const w of spend.windows) {
      const c = w.cost == null ? `~$${w.priced.toFixed(2)}+ (some requests unpriced)` : `$${w.cost.toFixed(2)}`;
      const pro = w.prorated ? ' (incl. prorated rows — some requests had no timestamp)' : '';
      L.push(`    ${w.label.padEnd(10)} ${String(w.lanes).padStart(3)} lanes touch   ${c}${pro}`);
    }
    if (spend.anyProrated) {
      L.push('    note: some requests lacked a per-request timestamp and were prorated across');
      L.push('    their lane span rather than binned to the lane end (BUG-175).');
    }
  }
  L.push('');
  return L.join('\n');
}

/* ---------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const project = (() => {
    const i = argv.indexOf('--project');
    return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : process.cwd();
  })();

  const now = Date.now();
  const history = readHistory();

  // Bounded, non-blocking by construction: each reader carries the module's own
  // hard timeout and NEVER throws — a wedged provider degrades to unavailable.
  // FEAT-145: EVERY registered Claude account (default first) plus openai. One
  // account's failure degrades only its own row; `Promise.all` is safe precisely
  // because no reader rejects.
  const targets = usageTargets();
  const snaps: ProviderUsage[] = await Promise.all(targets.map((t) => readUsageForTarget(t)));

  const derived = snaps.map((s) => deriveProvider(s, history, now));

  // Record this read so the NEXT call has an observed rate. Keyed per account
  // (see scripts/lib/usage-history.mjs) — the default account keeps the bare
  // `anthropic` key its existing rows already carry.
  appendHistory(rowsFromSnapshots(snaps, now) as HistRow[]);

  const spend = await ownSpend(project);

  if (json) {
    console.log(JSON.stringify({ at: now, providers: derived, ownSpend: spend }, null, 2));
    return 0;
  }
  console.log(formatText(derived, spend));
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
