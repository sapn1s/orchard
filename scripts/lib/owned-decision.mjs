/**
 * owned-decision.mjs — BUG-259: an AGENT's own decision, recorded as the agent's,
 * and the USER's reopen of it. Pure record transforms plus their shape check; the
 * writers (scripts/board-tool.mjs `own`, src/server/owned-decisions.ts reopen) do
 * the locked, rev-checked file IO.
 *
 * WHY THIS EXISTS. 20 of the 24 cards on the Needs-You rail on 2026-10-14 were the
 * agent's own call (docs/research/unnecessary-asks-2026-10-14.md, Appendix A), and
 * the only ways to clear one were dishonest: a server answer recorded `by: user`
 * (FEAT-164, FEAT-170), or an Owner-cell flip that left the decision open and said
 * nothing about who decided.
 *
 * WHAT IT IS NOT. It is not FEAT-184's `adopt`. An adoption is a USER-owned decision
 * taken under a delegation the user recorded, and it is written as a typed answer
 * (`by: agent-under-delegation`) with a receipt. An owned decision was never the
 * user's: it writes NO answer at all. The open decision moves to
 * `decision_history` as `chosen_by: 'agent'`, carrying who decided, on what typed
 * basis, why, and a FULL snapshot of the decision so the user can reopen it intact.
 *
 * WHAT IT REFUSES (the caller turns these into refusals):
 *   - a card that declares a hard stop (`decision.stop`, written by the BUG-259
 *     decide gate): the agent filed it as the user's, so only the user clears it;
 *   - a decision the user reopened (`reopened_from`): no own/reopen loops;
 *   - an answered or adopted decision (checked by the caller with ticketAnswerState).
 */

import { randomUUID } from 'node:crypto';
import { OWN_BASES, OWN_BASES_NEEDING_REF } from './ticket-schema.mjs';

export { OWN_BASES, OWN_BASES_NEEDING_REF };
/** Bases that pick an option — `chose` is required. */
export const OWN_BASES_NEEDING_CHOICE = Object.freeze(['recommendation', 'judgement', 'criteria']);

/**
 * BUG-263 — the basis of a WITHDRAWAL: a card an agent filed as the user's (a
 * hard-stop Decide card) that turns out to have been the agent's own call, already
 * made and built, with neither option matching what shipped. `own` refuses a
 * hard-stop card by design (only the user clears a real stop); `withdraw` is the
 * honest path to take such a mis-filed card back. It records the agent's decision
 * AND leaves the user a one-click reopen, so the user's authority is preserved —
 * it does not launder the stop into an easier class. It is NOT a user answer.
 */
export const WITHDRAW_BASIS = 'withdrawn';

export const READS_AS_USER_RE = /^\s*(you|user|the user)\b/i;

/** The decision without its answers: what a reopen restores. */
function snapshotOf(decision) {
  const { answers: _answers, ...rest } = decision;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * Validate an own request against the record. Returns null or `{ code, message }`.
 * `refExists(ref)` lets the caller check a `settled` ref against the board.
 */
export function ownRefusal(record, { chose, basis, ref, why, author }, { refExists = () => true } = {}) {
  const d = record?.decision;
  if (!d || typeof d !== 'object') return { code: 'no-open-decision', message: 'there is no open decision on this ticket' };
  if (d.stop) {
    return { code: 'declared-stop', message: `the card declares the hard stop "${d.stop}" (${d.stop_consequence ?? 'no consequence recorded'}) — it was filed as the user's, so only the user answers or clears it` };
  }
  if (d.reopened_from) return { code: 'reopened-by-user', message: 'the user reopened this decision after an agent took it — it is theirs now' };
  if (!OWN_BASES.includes(basis)) return { code: 'bad-basis', message: `--basis must be one of ${OWN_BASES.join(' | ')}` };
  if (!String(why ?? '').trim()) return { code: 'missing-arg', message: '--why="the reason" is required — an agent decision without a reason is not reviewable' };
  if (!String(author ?? '').trim()) return { code: 'missing-arg', message: '--author=<the agent deciding, e.g. "worker (BUG-259 fixing r1)"> is required' };
  if (READS_AS_USER_RE.test(author)) return { code: 'bad-author', message: `--author ${JSON.stringify(author)} reads as the user — an owned decision is the agent's and is recorded as one` };
  if (OWN_BASES_NEEDING_REF.includes(basis) && !String(ref ?? '').trim()) {
    return { code: 'missing-arg', message: `--basis=${basis} needs --ref (criteria: sc:<index of the success criterion>; settled: the ticket or answer id that settled it)` };
  }
  const keys = Array.isArray(d.options) ? d.options.map((o) => o && o.key) : [];
  if (d.mode === 'staged') {
    // A staged decision is asked one stage at a time: an agent may own only the
    // stage the card is asking NOW (the lowest), and the later stages travel in the
    // snapshot, so a reopen restores the whole question.
    const stages = (Array.isArray(d.options) ? d.options : []).map((o) => o && o.stage).filter((x) => Number.isInteger(x));
    const first = stages.length ? Math.min(...stages) : null;
    const opt = (d.options ?? []).find((o) => o && o.key === String(chose ?? '').trim());
    if (!opt || opt.stage !== first) return { code: 'staged-not-first', message: `a staged decision is owned one stage at a time: --chose must be an option of stage ${first}` };
  }
  if (OWN_BASES_NEEDING_CHOICE.includes(basis) && !String(chose ?? '').trim()) {
    return { code: 'missing-arg', message: `--basis=${basis} picks an option: --chose=<${keys.join('|')}> is required` };
  }
  if (chose) {
    const picked = d.mode === 'multi' ? String(chose).split('+').map((k) => k.trim()) : [String(chose).trim()];
    const unknown = picked.filter((k) => !keys.includes(k));
    if (unknown.length) return { code: 'bad-choice', message: `--chose names ${unknown.join(', ')}, which is not an option key (${keys.join(', ')})` };
  }
  if (basis === 'recommendation' && String(chose).trim() !== String(d.recommendation ?? '').trim()) {
    return { code: 'not-recommendation', message: `--basis=recommendation but the card recommends ${d.recommendation ?? 'nothing'} — use --basis=judgement and say why` };
  }
  if (basis === 'criteria') {
    const m = /^sc:(\d+)$/.exec(String(ref).trim());
    const sc = Array.isArray(record.success_criteria) ? record.success_criteria : [];
    if (!m || Number(m[1]) >= sc.length) return { code: 'bad-ref', message: `--ref for criteria must be sc:<0..${sc.length - 1}> — the success criterion that decides it` };
  }
  if (basis === 'settled' && !refExists(String(ref).trim())) {
    return { code: 'bad-ref', message: `--ref ${JSON.stringify(ref)} names nothing on this board (a ticket id, or an answer id on this ticket)` };
  }
  return null;
}

/**
 * The record after an agent owns its open decision. Pure. The caller has already
 * run ownRefusal. `askedOn` is the date the decision was declared, when known.
 */
export function ownRecord(record, { chose, basis, ref, why, author, next, handoff, today, askedOn = null }) {
  const d = record.decision;
  const entry = {
    // A decision declared before FEAT-166 r2 has no id; the owned entry needs one,
    // because the user's reopen names it.
    id: d.id ?? randomUUID(),
    asked_on: askedOn ?? record.updated ?? null,
    question: d.question ?? null,
    mode: d.mode,
    options_keys: Array.isArray(d.options) ? d.options.map((o) => o && o.key) : [],
    chosen: chose ? String(chose).trim() : null,
    chosen_on: today,
    chosen_by: 'agent',
    note: `Decided by the agent (${author}), not by you — ${basis}: ${String(why).trim()}`,
    owned: {
      by: String(author).trim(),
      basis,
      ref: ref ? String(ref).trim() : null,
      why: String(why).trim(),
      on: today,
      next: next ? String(next).trim() : null,
      handoff: handoff ? String(handoff).trim() : null,
      prior: { human_action: record.human_action, work_state: record.work_state, current_need: record.current_need ?? null },
    },
    snapshot: snapshotOf(d),
  };
  const history = Array.isArray(record.decision_history) ? [...record.decision_history, entry] : [entry];
  const next2 = {
    ...record,
    decision: null,
    decision_history: history,
    human_action: 'none',
    work_state: record.work_state === 'blocked' ? 'open' : record.work_state,
    updated: today,
  };
  if (next) next2.current_need = String(next).trim();
  return { record: next2, entry };
}

/**
 * Validate a withdraw request against the record. Returns null or `{ code, message }`.
 * Unlike ownRefusal it does NOT refuse a hard-stop card — withdrawing one is the
 * whole point. It refuses only what must never be withdrawn: a reopened decision
 * (the user took it back), and missing required fields. The caller has already
 * refused an answered/adopted decision (ticketAnswerState) before calling this.
 */
export function withdrawRefusal(record, { reason, decided, author }) {
  const d = record?.decision;
  if (!d || typeof d !== 'object') return { code: 'no-open-decision', message: 'there is no open decision to withdraw on this ticket' };
  if (d.reopened_from) return { code: 'reopened-by-user', message: 'the user reopened this decision after an agent took it — it is theirs now, not something an agent withdraws' };
  // FAIL CLOSED on a user answer. ticketAnswerState (the caller's first guard) is
  // the authoritative "is it answered" reader, but it fails toward PENDING when the
  // FEAT-184 seal store cannot be verified (key unreadable, store damaged) — and a
  // withdrawal that trusted only that would then CLOSE a card carrying a genuine
  // sealed `by:user` answer and ERASE it (clean-room verify r2). So refuse on the
  // mere PRESENCE of a user answer or an adoption in the record, verifiable or not:
  // an agent never withdraws a decision the user answered or adopted.
  const answers = Array.isArray(d.answers) ? d.answers : [];
  if (answers.some((a) => a && (a.by === 'user' || a.by === 'agent-under-delegation'))) {
    return { code: 'answered', message: 'the decision carries a user answer or an adoption in its record — only the user reopens it; an agent never withdraws it (this holds even when the seal store cannot be verified)' };
  }
  if (!String(reason ?? '').trim()) return { code: 'missing-arg', message: '--reason="why this was the agent\'s own call, not yours" is required — a withdrawal without a reason is not reviewable' };
  if (!String(decided ?? '').trim()) return { code: 'missing-arg', message: '--decided="what was actually decided and built" is required — the card\'s options did not match reality, so say what did' };
  if (!String(author ?? '').trim()) return { code: 'missing-arg', message: '--author=<the agent withdrawing, e.g. "orchestrator"> is required' };
  if (READS_AS_USER_RE.test(author)) return { code: 'bad-author', message: `--author ${JSON.stringify(author)} reads as the user — a withdrawal is the agent's own act and is recorded as one` };
  return null;
}

/**
 * The record after an agent WITHDRAWS its own open decision. Pure. The caller has
 * already run withdrawRefusal and refused an answered/adopted decision. The entry
 * is shaped like an owned-decision entry (chosen_by:'agent', `owned`, `snapshot`)
 * so the existing reopen route, "Decisions already made" UI, board:status and
 * board:check all read it with no new machinery — it differs by `owned.basis:
 * 'withdrawn'` and an `owned.decided` field that records what was actually built.
 * The `snapshot` is the withdrawn card (its question + options), restored intact
 * when the user reopens.
 */
export function withdrawRecord(record, { reason, decided, author, today, askedOn = null }) {
  const d = record.decision;
  const entry = {
    id: d.id ?? randomUUID(),
    asked_on: askedOn ?? record.updated ?? null,
    question: d.question ?? null,
    mode: d.mode,
    options_keys: Array.isArray(d.options) ? d.options.map((o) => o && o.key) : [],
    chosen: null,
    chosen_on: today,
    chosen_by: 'agent',
    note: `Withdrawn by the agent (${String(author).trim()}), not answered by you — ${String(reason).trim()}`,
    owned: {
      by: String(author).trim(),
      basis: WITHDRAW_BASIS,
      ref: null,
      why: String(reason).trim(),
      decided: String(decided).trim(),
      on: today,
      next: null,
      handoff: null,
      prior: { human_action: record.human_action, work_state: record.work_state, current_need: record.current_need ?? null },
    },
    snapshot: snapshotOf(d),
  };
  const history = Array.isArray(record.decision_history) ? [...record.decision_history, entry] : [entry];
  return {
    record: {
      ...record,
      decision: null,
      decision_history: history,
      human_action: 'none',
      work_state: record.work_state === 'blocked' ? 'open' : record.work_state,
      updated: today,
    },
    entry,
  };
}

/** The newest owned entry for a decision id that the user has not reopened, or null. */
export function ownedEntry(record, historyId) {
  const h = Array.isArray(record?.decision_history) ? record.decision_history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i];
    if (e && e.chosen_by === 'agent' && e.owned && (historyId ? e.id === historyId : true)) return { entry: e, index: i };
  }
  return null;
}

/**
 * The record after the USER reopens an agent-owned decision. Pure. Returns
 * `{ record, decisionId }`, or `{ refusal }`. Idempotent: reopening an entry that
 * is already reopened returns `{ already: true }`.
 */
export function reopenRecord(record, historyId, { today, newId = randomUUID() } = {}) {
  const hit = ownedEntry(record, historyId);
  if (!hit) return { refusal: { code: 'not-owned', status: 404, message: `no agent-owned decision ${JSON.stringify(historyId)} on this ticket` } };
  const { entry, index } = hit;
  if (entry.reopened) return { already: true, decisionId: entry.reopened.decision_id };
  if (record.decision) return { refusal: { code: 'newer-decision', status: 409, message: 'the ticket already has a newer open decision — answer that one' } };
  if (['done', 'not_a_bug'].includes(record.work_state)) return { refusal: { code: 'ticket-closed', status: 409, message: `the ticket is ${record.work_state} — reopen the ticket first` } };
  if (!entry.snapshot || typeof entry.snapshot !== 'object') return { refusal: { code: 'no-snapshot', status: 409, message: 'this agent decision kept no snapshot to restore' } };
  const history = record.decision_history.map((e, i) => (i === index ? { ...e, reopened: { on: today, by: 'user', decision_id: newId } } : e));
  const prior = entry.owned?.prior ?? {};
  const decision = { ...JSON.parse(JSON.stringify(entry.snapshot)), id: newId, reopened_from: entry.id };
  delete decision.answers;
  return {
    decisionId: newId,
    record: {
      ...record,
      decision,
      decision_history: history,
      human_action: prior.human_action && prior.human_action !== 'none' ? prior.human_action : 'decide',
      work_state: prior.work_state && !['done', 'not_a_bug'].includes(prior.work_state) ? prior.work_state : record.work_state,
      current_need: prior.current_need ?? record.current_need,
      updated: today,
    },
  };
}

/** Agent-owned decisions in a record, newest first, for the board's "agents decided" line. */
export function agentDecisionsOf(record) {
  const h = Array.isArray(record?.decision_history) ? record.decision_history : [];
  return h.filter((e) => e && e.chosen_by === 'agent' && e.owned).map((e) => ({
    decision_id: e.id ?? null, question: e.question ?? null, chosen: e.chosen ?? null, on: e.owned.on ?? e.chosen_on ?? null,
    by: e.owned.by, basis: e.owned.basis, why: e.owned.why, next: e.owned.next ?? null, handoff: e.owned.handoff ?? null,
    decided: e.owned.decided ?? null,
    reopened: !!e.reopened,
  })).reverse();
}

/**
 * TEST SUPPORT — rewind an agent-owned card to its pre-own bytes, on a COPY of a
 * board. Suites that use real board tickets as fixtures (FEAT-166, FEAT-184,
 * BUG-259) need a card with an open decision; after the 2026-10-14 migration the
 * real cards carry an owned decision instead. This restores the decision from the
 * card's own snapshot, drops the owned history entry and its log entry. Returns the
 * new markdown, or null when the card has no un-reopened owned decision. The caller
 * puts the INDEX Owner cell back to 👤 (tickets.ts setBoardOwner). Never run it on
 * the live board: rewinding there would erase a recorded decision.
 */
export function rewindOwnedMarkdown(md, file, { parseTicket, extractTicketBlock, formatTicket }) {
  const OWN_ENTRY = /\n### \d{4}-\d\d-\d\d — [^\n]*\n- \*\*Decided by agent \(own\):\*\*/;
  const parsed = parseTicket(md, { file, mode: 'auto' });
  if (parsed.format === 'block' && parsed.record) {
    const rec = parsed.record;
    const i = (rec.decision_history ?? []).findIndex((h) => h?.owned && !h.reopened);
    if (i < 0) return null;
    const h = rec.decision_history[i];
    const prior = h.owned.prior ?? {};
    const back = { ...rec, decision: { ...h.snapshot }, decision_history: rec.decision_history.filter((_, k) => k !== i),
      human_action: prior.human_action ?? 'decide', work_state: prior.work_state ?? rec.work_state,
      current_need: prior.current_need ?? rec.current_need, owner: 'you' };
    let { body } = extractTicketBlock(md);
    const cut = body.search(OWN_ENTRY);
    if (cut >= 0) body = body.slice(0, cut).replace(/\s*$/, '\n');
    return formatTicket(back, body);
  }
  const cut = md.search(OWN_ENTRY);
  return cut < 0 ? null : md.slice(0, cut).replace(/\s*$/, '\n');
}
