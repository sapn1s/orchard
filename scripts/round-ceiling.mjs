#!/usr/bin/env node
/**
 * round-ceiling.mjs — FEAT-148: read the DECLARED round count and raise the WA §N
 * stopping question when a ticket has absorbed too many attempts.
 *
 * WHY THIS EXISTS
 * ARCH-017 absorbed ELEVEN verification rounds — most returning DO-NOT-LAND —
 * without anything escalating. WA §N already states the rule: two consecutive
 * rounds that return only wording/cosmetics means STOP, and a RECURRING class of
 * failure means the DESIGN is wrong, not the reviewer. That rule never fired,
 * because nothing READ the round count. FEAT-100 already made every charter
 * DECLARE `Dispatch: … round=N …`, and `cost-collect.mjs` already parses that
 * line into `lane.declared.round`. The fact was declared by its owner and then
 * read by no one — the exact ARCH-010 defect. This script is the reader.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO READ (ARCH-010)
 * It reads the DECLARED `round=` and `ticket=` fields ONLY — through the one
 * canonical grammar (`parseDispatchDeclaration`, applied by `collect()` when it
 * builds each lane's `declared`), never a fresh regex, and NEVER by counting
 * transcripts, ticket files, or Activity-log entries. A ticket's round count is
 * the MAXIMUM round any lane DECLARED for it. Counting lanes (or log entries)
 * would be a reader re-deriving a fact its owner already stated at dispatch —
 * which is exactly the derivation this whole feature exists to remove.
 *
 * WHAT IT IS NOT
 * - No LLM. Pure computation over records the harness already wrote.
 * - It RAISES; it does not ACT. No auto-filing, no ticket mutation, no blocking
 *   of any work. It prints a §N-shaped question a human/orchestrator answers:
 *   "is this a design fault rather than a reviewer fault — should it become an
 *   ARCH decision?" If they decide to redesign, the work lives in an ARCH-###
 *   ticket (docs/bugs/TEMPLATE-ARCH.md). Same contract as `arch-watch.mjs`.
 *
 * ── THRESHOLD (configurable, escalating) ────────────────────────────────────
 *   --min-round=N   (default 3)  raise a ticket whose max declared round is ≥ N
 * Severity escalates with the observed round, relative to the threshold:
 *   round in [N, N+1]  → elevated   (default: 3–4)
 *   round in [N+2,N+4] → high       (default: 5–7)
 *   round ≥ N+5        → critical    (default: 8+; ARCH-017 at 11 is here)
 * Env equivalent: ROUND_CEILING_MIN_ROUND. These are the same knobs
 * `arch-watch.mjs` uses (a DEFAULTS object + a CLI flag + an env var) — not a new
 * settings system.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 * By default it re-derives from the live transcripts every pass (like
 * arch-watch re-derives from the board every pass), via cost-collect's own
 * read-only `collect()` — which mutates nothing (the ledger append lives only in
 * cost-collect's CLI, not in `collect()`). `--ledger` reads the durable
 * cost-ledger instead, which survives the CLI's 30-day transcript pruning.
 *
 * ── OUTPUT ──────────────────────────────────────────────────────────────────
 *   node scripts/round-ceiling.mjs                 human-readable report
 *   node scripts/round-ceiling.mjs --json          machine-readable
 *   node scripts/round-ceiling.mjs --ledger        read the durable ledger
 *   node scripts/round-ceiling.mjs --all-projects  every project's lanes
 * Exit codes: 0 = no ticket over the ceiling, 1 = ≥1 ticket over it, 2 = usage
 * error. Nothing here throws on a malformed record — a reader that broke the
 * pipeline would be worse than one that finds nothing.
 */
import path from 'node:path';
import url from 'node:url';

import { collect, readLedger } from './cost-collect.mjs';

export const DEFAULTS = {
  /** Raise a ticket whose MAX declared round is ≥ this. WA §N's "2-3× → design fault". */
  minRound: 3,
  /** Cap on how many raised tickets the CLI prints in detail (all are still in --json). */
  maxReport: 25,
};

/** Escalating severity from the observed round, relative to the ceiling. */
export function severityFor(round, minRound) {
  const delta = round - minRound;
  if (delta < 0) return null;
  if (delta <= 1) return 'elevated';
  if (delta <= 4) return 'high';
  return 'critical';
}

/**
 * The reader. Pure: takes lane records (each carrying `declared` from the one
 * canonical grammar) and returns the tickets whose MAX DECLARED round is at or
 * over the ceiling. Never throws.
 *
 * A lane contributes ONLY its declared round and declared ticket(s). A lane that
 * declared no round, or `ticket=none`, contributes nothing — there is no
 * inference and no fallback to the resolved/inferred round `cost-collect` also
 * carries, because inferring the count is the exact thing ARCH-010 forbids here.
 */
export function roundCeiling(lanes, opts = {}) {
  const minRound = Number(opts.minRound ?? DEFAULTS.minRound) || DEFAULTS.minRound;
  const byTicket = new Map();
  let lanesRead = 0;
  let lanesWithDeclaredRound = 0;
  for (const l of Array.isArray(lanes) ? lanes : []) {
    lanesRead++;
    const d = l?.declared;
    // DECLARED-only: present, a positive-integer round, and at least one ticket.
    if (!d || d.present !== true) continue;
    const round = d.round;
    if (!Number.isInteger(round) || round < 1) continue;
    const tickets = Array.isArray(d.tickets) ? d.tickets : null;
    if (!tickets || !tickets.length) continue; // ticket=none / undeclared: nothing to attribute
    lanesWithDeclaredRound++;
    for (const t of tickets) {
      if (typeof t !== 'string' || !t) continue;
      let g = byTicket.get(t);
      if (!g) {
        g = { ticket: t, maxRound: 0, lanesDeclaringRound: 0, byPhase: {} };
        byTicket.set(t, g);
      }
      g.lanesDeclaringRound++;
      g.maxRound = Math.max(g.maxRound, round);
      const phase = typeof d.phase === 'string' ? d.phase : '(no phase)';
      g.byPhase[phase] = Math.max(g.byPhase[phase] ?? 0, round);
    }
  }

  const raised = [];
  for (const g of byTicket.values()) {
    const severity = severityFor(g.maxRound, minRound);
    if (!severity) continue;
    raised.push({
      ticket: g.ticket,
      maxRound: g.maxRound,
      severity,
      lanesDeclaringRound: g.lanesDeclaringRound,
      byPhase: g.byPhase,
      question:
        `WA §N: ${g.ticket} has reached round ${g.maxRound} (declared, ≥ ceiling ${minRound}). ` +
        'Two consecutive rounds returning only wording/cosmetics mean STOP, and a recurring ' +
        'class of failure means the DESIGN is wrong, not the reviewer. Is this a design fault ' +
        'rather than a reviewer fault — should it become an ARCH decision (open an ARCH-### ' +
        'ticket from docs/bugs/TEMPLATE-ARCH.md — invariant, options, migration, proof bar), ' +
        'or is another local round genuinely right? Never auto-filed; a human decides.',
    });
  }
  const SEV_RANK = { critical: 3, high: 2, elevated: 1 };
  raised.sort(
    (a, b) => b.maxRound - a.maxRound || SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.ticket < b.ticket ? -1 : 1),
  );
  return { minRound, ticketsWithDeclaredRound: byTicket.size, lanesRead, lanesWithDeclaredRound, raised };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, quiet: false, ledger: false, all: false, project: process.cwd(), unknown: [], opts: {} };
  for (const a of argv) {
    let m;
    if ((m = /^--min-round=(\d+)$/.exec(a))) out.opts.minRound = Number(m[1]);
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--ledger') out.ledger = true;
    else if (a === '--all-projects') out.all = true;
    else if ((m = /^--project=(.*)$/.exec(a))) out.project = path.resolve(m[1]);
    else out.unknown.push(a);
  }
  return out;
}

async function loadLanes(a) {
  // Durable store, or a read-only re-derivation from the live transcripts.
  // Neither path mutates anything: `collect()` builds records and returns them;
  // the ledger append is cost-collect's CLI-only step, not called here.
  if (a.ledger) return readLedger();
  const res = await collect({ project: a.project, all: a.all, since: null });
  return res.lanes ?? [];
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  // Env default, overridable by the flag (same precedence shape as arch-watch).
  if (a.opts.minRound == null && process.env.ROUND_CEILING_MIN_ROUND) {
    const n = Number(process.env.ROUND_CEILING_MIN_ROUND);
    if (Number.isInteger(n) && n >= 1) a.opts.minRound = n;
  }
  if (a.unknown.length) {
    console.error(`round-ceiling.mjs: unrecognised argument(s): ${a.unknown.join(' ')}`);
    console.error('usage: node scripts/round-ceiling.mjs [--min-round=N] [--ledger] [--all-projects] [--project=<dir>] [--json] [--quiet]');
    process.exit(2);
  }

  let lanes;
  try {
    lanes = await loadLanes(a);
  } catch (e) {
    console.error(`round-ceiling.mjs: could not load lanes: ${e?.message ?? e}`);
    process.exit(2);
  }
  const res = roundCeiling(lanes, a.opts);

  if (a.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (!a.quiet) {
    console.log(
      `round-ceiling — ${res.lanesWithDeclaredRound} of ${res.lanesRead} lane(s) declared a round; ` +
        `${res.ticketsWithDeclaredRound} ticket(s) carry a declared round; ceiling ≥ ${res.minRound} (source: ${a.ledger ? 'durable ledger' : 'live transcripts'}).`,
    );
    if (res.raised.length === 0) {
      console.log('OK — no ticket at or over the round ceiling.');
    } else {
      console.log(`ROUND CEILING — ${res.raised.length} ticket(s) at or over the ceiling:`);
      for (const r of res.raised.slice(0, DEFAULTS.maxReport)) {
        const phases = Object.entries(r.byPhase).map(([p, n]) => `${p}:${n}`).join(' ');
        console.log(`  [${r.severity.toUpperCase()}] ${r.ticket} — max declared round ${r.maxRound} (${r.lanesDeclaringRound} lane(s) declared a round; by phase ${phases})`);
        console.log(`      ${r.question}`);
      }
      if (res.raised.length > DEFAULTS.maxReport) console.log(`  … and ${res.raised.length - DEFAULTS.maxReport} more (see --json).`);
      console.log(
        'These are QUESTIONS, not verdicts: decide redesign (ARCH-### from docs/bugs/TEMPLATE-ARCH.md) ' +
          'or state why another local round is right. This reader never files or mutates anything.',
      );
    }
  }
  process.exit(res.raised.length ? 1 : 0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
