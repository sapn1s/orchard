/**
 * FEAT-181 — the round-ceiling preflight for the dispatch path.
 *
 * WHY THIS EXISTS. FEAT-148 built the reader (round-ceiling.mjs) that raises the
 * WA §N stopping question when a ticket has absorbed too many verify rounds, but
 * nothing FIRED it — it only ran on a hand-typed `npm run arch:rounds`, so the
 * rounds-2+ cost (the majority of total) accrued unseen between orchestrator
 * turns. This is the automatic surface at the one moment it is most actionable:
 * a dispatch that is about to spend ANOTHER round on a ticket.
 *
 * WHAT IT DOES. Reads the durable cost ledger through the ONE canonical reader
 * (round-ceiling.mjs — never a second count, ARCH-010), adds THIS dispatch's own
 * declared round as a synthetic lane so a ticket crosses the ceiling on the round
 * being launched NOW and not only on history, and returns the subset of the
 * tickets this dispatch names that are at or over the ceiling — each already
 * carrying its named owner and the rescope / redesign / stop choices.
 *
 * WHAT IT IS NOT. It RAISES; it does not ACT (same contract as round-ceiling and
 * arch-watch): no block, no ticket mutation, no auto-file. The caller prints the
 * warning and proceeds. A missing or unreadable ledger degrades to a clean skip —
 * a preflight that broke a dispatch would be worse than none.
 *
 * It is extracted into this module (not inlined in dispatch.mjs) so it is
 * unit-testable against a SYNTHETIC ledger without spawning a real dispatch or
 * making an API call — the same seam BUG-189's sandbox preflight uses.
 */
import { roundCeiling, readRoundHistory, ESCALATION_ACTIONS } from '../round-ceiling.mjs';

/**
 * Which of THIS dispatch's tickets are at or over the ceiling, PLUS whether the
 * round history was usable (a named gap, never a silent empty success).
 *
 * The history check does NOT depend on this dispatch declaring a round (r1 break
 * b): a ticket already over the ceiling in HISTORY must raise even when this
 * dispatch passes no `--round`. This dispatch's own round is folded in as a
 * synthetic lane ONLY when a valid positive integer was declared — an omitted or
 * invalid round contributes nothing (we never invent a round) and never changes
 * the ledger-usability verdict (plan review Q3).
 *
 * @param {object} o
 * @param {number} [o.round]    the round this dispatch declared (optional)
 * @param {string[]} o.tickets  the ticket id(s) this dispatch declared
 * @param {string|null} [o.phase]
 * @param {Array|null} [o.lanes] prior lanes; defaults to the durable ledger. Pass
 *        an array (incl. []) to test without touching the real ledger.
 * @param {number} [o.minRound] override the ceiling (else round-ceiling's default)
 * @returns {{raised: object[], minRound: number|null, skipped: string|null,
 *           history: {usable:boolean, code:string|null, reason:string|null}|null}}
 */
export function preflightRoundCeiling({ round, tickets, phase = null, lanes = null, minRound } = {}) {
  // No ticket to attribute a round to → nothing to check. This stays BEFORE any
  // history read (plan review Q4: unticketed dispatches must not warn).
  const list = Array.isArray(tickets) ? tickets.filter((t) => typeof t === 'string' && t) : [];
  if (!list.length) return { raised: [], minRound: null, skipped: 'no declared ticket', history: null };

  // The ONE owner classifies the REAL round history (usable | unusable(reason)).
  const hist = readRoundHistory({ lanes, minRound });
  const prior = Array.isArray(hist.lanes) ? hist.lanes : [];

  // Fold THIS dispatch's own declared round in as a lane the reader counts — so a
  // round=N launched now crosses the ceiling even with no prior history — but
  // only when a valid round was actually declared.
  const hasRound = Number.isInteger(round) && round >= 1;
  const combined = hasRound ? [...prior, { declared: { present: true, round, tickets: list, phase } }] : prior;

  // Every evaluation path is non-crashing: readRoundHistory's catch covers the
  // first roundCeiling; this combined one is the SECOND and needs its own guard
  // (plan review Q4). roundCeiling is pure and does not throw, but a defensive
  // catch keeps a broken preflight from ever breaking a dispatch.
  let res;
  try {
    res = roundCeiling(combined, minRound != null ? { minRound } : {});
  } catch {
    res = { raised: [], minRound: hist.result?.minRound ?? null };
  }

  const mine = new Set(list);
  return {
    raised: res.raised.filter((r) => mine.has(r.ticket)),
    minRound: res.minRound,
    skipped: null,
    // The named gap, rendered by every surface independently of any raise.
    history: { usable: hist.usable, code: hist.code, reason: hist.reason },
  };
}

/**
 * The stderr lines for a raised preflight — a NAMED owner and an actionable
 * decision, never a bare count (the "notification theatre" the cross-provider
 * refutation warned against). Returns [] when nothing is raised.
 */
export function formatRoundCeilingWarning(raised, dispatchRound, minRound) {
  // ADJUDICATION (orchestrator, 2026-10-14): when a dispatch names a ticket but
  // declares no --round, its own round is "undeclared" — never "null", never a
  // silent round-0. The over-ceiling status still comes from the ledger as normal
  // (that is a HISTORY fact, not this dispatch's); only the label of THIS
  // dispatch's round changes. A valid positive integer renders as itself.
  const roundLabel = Number.isInteger(dispatchRound) && dispatchRound >= 1 ? String(dispatchRound) : 'undeclared';
  const lines = [];
  for (const r of raised || []) {
    lines.push(`⚠ ROUND CEILING [${String(r.severity).toUpperCase()}] ${r.ticket}: dispatching round ${roundLabel}; max declared round ${r.maxRound} (≥ ceiling ${minRound}).`);
    lines.push(`  WA §N — OWNER ${r.owner} must decide, not just be notified:`);
    for (const a of ESCALATION_ACTIONS) lines.push(`    - ${a.label}`);
    lines.push('  This is a QUESTION, not a block — the dispatch proceeds. See `npm run arch:rounds -- --ledger`.');
  }
  return lines;
}
