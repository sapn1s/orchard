/**
 * usage-burn.mjs — the PURE half of FEAT-119's "can I afford to dispatch?"
 * derivation. No I/O, no network, no clock of its own: every function is a
 * function of numbers handed in, so the whole thing is unit-testable without a
 * provider, a session, or a wall clock.
 *
 * It turns a provider window (percent consumed + reset time, from
 * `src/server/provider-usage.ts` — NEVER from our own spend accounting) into the
 * one shape a session actually needs before it fans out a fleet:
 *
 *   "40% of the 5h window is gone, it resets in 3h, I'm burning 8%/hr, and at
 *    that pace I hit the cap in ~7.5h — AFTER it resets, so there's headroom."
 *
 * versus
 *
 *   "40% gone, resets in 6h, burning 15%/hr → I hit the cap in ~4h, BEFORE the
 *    reset. Park the fleet or drop a tier."
 *
 * Percent alone cannot tell those two apart; the burn rate against the reset is
 * the whole point. Two rates are derived, each labelled so neither is passed off
 * as the other:
 *
 *   - OBSERVED — the true %/hr between two successive real reads of the SAME
 *     window instance (matched on `resetsAt`). This is the number that changes a
 *     decision. It is null on the first read of a window: there is no history to
 *     diff, and inventing one would be exactly the fabrication the charter bans.
 *   - WINDOW-AVERAGE — the single-read fallback: percent consumed divided by how
 *     long the window has been open (reset time minus the window's duration). For
 *     a ROLLING window this is an approximation (oldest usage ages out, it is not
 *     a hard reset), and it is labelled as such. It exists so the FIRST call is
 *     still decision-shaped instead of blank.
 *
 * Projection prefers the observed rate when it is a positive signal, else the
 * window-average. A window that is not being consumed projects to "never" (not a
 * fabricated zero), and a window with no reset time reports its rate but withholds
 * a verdict rather than guess one.
 */

/**
 * Duration of a named window, in minutes, or null when the label does not map to
 * a known window. `provider-usage.ts` emits '5h', 'weekly', and scoped variants
 * like 'weekly · Fable'; a duration we cannot name yields a null, which makes the
 * window-average pace unavailable rather than wrong.
 */
export function windowDurationMins(label) {
  const l = String(label ?? '').toLowerCase();
  if (l === '5h' || l.startsWith('5h')) return 300;
  if (l.startsWith('weekly')) return 7 * 24 * 60;
  // A bare "<n>h" label (codex reports arbitrary window durations by hours).
  const m = /^(\d+)h$/.exec(l);
  if (m) return Number(m[1]) * 60;
  return null;
}

const HOUR_MS = 3.6e6;

/**
 * Derive the decision shape for ONE window.
 *
 * @param window  { usedPercent, resetsAt (unix SEC|null), label, binding? }
 * @param ctx     { now (ms), prior?: { usedPercent, at (ms), resetsAt } | null }
 * @returns a plain object; every field is either a real number or null (unknown).
 */
export function deriveWindow(window, ctx = {}) {
  const usedPercent = Number(window?.usedPercent);
  const resetsAt = window?.resetsAt ?? null;
  const label = window?.label ?? null;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const prior = ctx.prior ?? null;

  const resetMs = resetsAt != null ? resetsAt * 1000 : null;
  const durationMins = windowDurationMins(label);
  const hoursToReset = resetMs != null ? (resetMs - now) / HOUR_MS : null;

  // --- window-average pace (available from a single read) ---
  let avgPacePerHr = null;
  let elapsedHours = null;
  if (resetMs != null && durationMins != null) {
    const startMs = resetMs - durationMins * 60000;
    elapsedHours = (now - startMs) / HOUR_MS;
    if (elapsedHours > 0.001 && Number.isFinite(usedPercent)) avgPacePerHr = usedPercent / elapsedHours;
  }

  // --- observed pace (requires a prior read of the SAME window instance) ---
  let observedPerHr = null;
  let observedDtHours = null;
  if (
    prior &&
    resetsAt != null &&
    prior.resetsAt === resetsAt &&
    Number.isFinite(prior.at) &&
    Number.isFinite(prior.usedPercent) &&
    prior.at < now
  ) {
    observedDtHours = (now - prior.at) / HOUR_MS;
    if (observedDtHours > 0.001) observedPerHr = (usedPercent - prior.usedPercent) / observedDtHours;
  }

  // Prefer the observed rate when it is a POSITIVE signal (consumption seen);
  // otherwise fall back to the window-average. A zero/negative observed delta
  // (usage aged out of a rolling window) is reported but does not drive a "will
  // exhaust" projection — it means the opposite.
  const rateSource =
    observedPerHr != null && observedPerHr > 0 ? 'observed' : avgPacePerHr != null ? 'window-average' : null;
  const rate = rateSource === 'observed' ? observedPerHr : rateSource === 'window-average' ? avgPacePerHr : null;

  const remainingPct = Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : null;

  // The sustainable rate: %/hr you could keep spending and just reach 100% AT
  // the reset — the ceiling a dispatch decision is measured against.
  const sustainablePerHr = hoursToReset != null && hoursToReset > 0 && remainingPct != null ? remainingPct / hoursToReset : null;

  let projectedHoursToCap = null;
  if (rate != null && remainingPct != null) projectedHoursToCap = rate > 0 ? remainingPct / rate : Infinity;

  let headroomRatio = null;
  if (rate != null && rate > 0 && sustainablePerHr != null) headroomRatio = sustainablePerHr / rate;

  let verdict;
  if (Number.isFinite(usedPercent) && usedPercent >= 100) verdict = 'exhausted';
  else if (rate == null) verdict = 'unknown-rate';
  else if (projectedHoursToCap === Infinity) verdict = 'idle';
  else if (hoursToReset == null) verdict = 'unknown-reset';
  else if (projectedHoursToCap < hoursToReset) verdict = 'park';
  else verdict = 'ok';

  return {
    label,
    binding: !!window?.binding,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    remainingPct,
    resetsAt,
    hoursToReset,
    durationMins,
    elapsedHours,
    avgPacePerHr,
    observedPerHr,
    observedDtHours,
    rate,
    rateSource,
    sustainablePerHr,
    projectedHoursToCap,
    headroomRatio,
    verdict,
  };
}

/**
 * The single dispatch signal across all of a provider's windows: the harshest
 * verdict wins, because the binding constraint is whichever window runs out
 * first. Returns { verdict, window } naming which window drove it, or null when
 * there is nothing to decide on.
 */
export function overallVerdict(derivedWindows) {
  const rank = { exhausted: 5, park: 4, 'unknown-rate': 3, 'unknown-reset': 3, ok: 1, idle: 0 };
  let worst = null;
  for (const w of derivedWindows ?? []) {
    if (worst == null || (rank[w.verdict] ?? 2) > (rank[worst.verdict] ?? 2)) worst = w;
  }
  return worst ? { verdict: worst.verdict, window: worst } : null;
}

/** Plain-words dispatch guidance for a verdict — decision-shaped, never a number alone. */
export function verdictAdvice(verdict) {
  switch (verdict) {
    case 'exhausted':
      return 'window is spent — dispatches will hit the wall now; park until reset';
    case 'park':
      return 'at the current burn you hit the cap BEFORE it resets — park the fleet or drop a tier';
    case 'ok':
      return 'the window resets before the current burn would exhaust it — headroom to dispatch';
    case 'idle':
      return 'window is barely moving — full headroom to dispatch';
    case 'unknown-rate':
      return 'burn rate unknown (first read of this window) — re-run after a lane or two to see the trend';
    case 'unknown-reset':
      return 'reset time unknown — cannot project exhaustion; decide on the percent alone';
    default:
      return 'unavailable';
  }
}
