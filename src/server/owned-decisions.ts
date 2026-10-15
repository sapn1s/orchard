/**
 * owned-decisions.ts — BUG-259, the server half of an agent's OWN decision.
 *
 *  - reopenOwnedDecision: the USER reopens a decision an agent took with
 *    `board-tool own`. User-only (the route gates it with requireUserCaller), so an
 *    agent cannot fake the user's reopen. The record and its log entry land in one
 *    locked, rev-checked write; the Owner cell goes back to 👤.
 *  - recentAgentDecisions: what agents decided recently, for the board payload, so
 *    a card that left the Needs-You rail stays findable without opening every ticket.
 *
 * Distinct from FEAT-184's adoption (src/server/delegations.ts + board.ts
 * recordAdoption): that is a USER-owned decision taken under a recorded
 * delegation and written as a typed answer. An owned decision writes no answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTicket, extractTicketBlock, formatTicket, validateTicket } from '../../scripts/lib/ticket-schema.mjs';
import { reopenRecord, ownedEntry, agentDecisionsOf, type AgentDecision } from '../../scripts/lib/owned-decision.mjs';
import { withTicketLock } from '../../scripts/lib/delegation-source.mjs';
import { boardDir, ticketFile } from './board.ts';
import {
  TicketError, assertFresh, currentRev, composeLogEntry, setBoardOwner, readTicket, USER_SIGNATURE, listTickets,
} from './tickets.ts';

const TODAY = () => new Date().toISOString().slice(0, 10);

export interface ReopenResult {
  id: string; reopened: boolean; already: boolean; decision_id: string | null; rev: string; legacy: boolean;
}

/**
 * Reopen the agent-owned decision `historyId` on ticket `id`. `rev` is the ticket
 * rev the user's view displayed (409 if the ticket moved since). Legacy prose
 * tickets carry no record: the reopen puts the card back on the rail (👤) and logs it.
 */
export function reopenOwnedDecision(hostPath: string, id: string, historyId: string, rev: string | undefined, note = ''): ReopenResult {
  const detail = readTicket(hostPath, id);
  const file = detail.file;
  const base = path.basename(file);
  if (rev) assertFresh(file, rev);
  const parsed = parseTicket(detail.markdown, { file: base, mode: 'auto' });
  const extra = String(note ?? '').trim();
  if (parsed.format !== 'block' || !parsed.record) {
    if (historyId !== 'legacy') throw new TicketError(`${id} is a legacy prose ticket — reopen it with decision "legacy"`, 400);
    if (!/\*\*Decided by agent \(own\):\*\*/.test(detail.markdown)) throw new TicketError(`${id} has no agent-owned decision to reopen`, 404);
    const entry = composeLogEntry(`Reopened by you: the agent's decision is back on your Needs-You rail.${extra ? ` Your note: ${extra}` : ''}`, { author: USER_SIGNATURE, label: 'Decision reopened' });
    withTicketLock(file, () => { assertFresh(file, detail.rev); fs.writeFileSync(file, detail.markdown.replace(/\s*$/, '\n') + entry); });
    setBoardOwner(hostPath, id, 'you');
    return { id, reopened: true, already: false, decision_id: null, rev: currentRev(file), legacy: true };
  }
  const record = parsed.record as Record<string, unknown>;
  const out = reopenRecord(record, historyId, { today: TODAY() });
  if (out.refusal) throw new TicketError(out.refusal.message, out.refusal.status);
  if (out.already) return { id, reopened: false, already: true, decision_id: out.decisionId ?? null, rev: currentRev(file), legacy: false };
  const next = { ...(out.record as Record<string, unknown>), owner: 'you' };
  const v = validateTicket(next, { file: base });
  if (!v.ok) throw new TicketError(`reopen would leave ${id} invalid: ${v.violations.join('; ')}`, 409);
  const hit = ownedEntry(record, historyId);
  const owned = (hit?.entry.owned ?? {}) as Record<string, unknown>;
  const entry = composeLogEntry(
    `Reopened by you: the decision ${String(owned.by ?? 'an agent')} took (${String(hit?.entry.chosen ?? 'no option')}, ${String(owned.basis ?? '?')}) is yours again and back on your Needs-You rail.${extra ? ` Your note: ${extra}` : ''}`,
    { author: USER_SIGNATURE, label: 'Decision reopened' },
  );
  const { body } = extractTicketBlock(detail.markdown);
  withTicketLock(file, () => { assertFresh(file, detail.rev); fs.writeFileSync(file, formatTicket(next, body.replace(/\s*$/, '\n') + entry)); });
  setBoardOwner(hostPath, id, 'you');
  return { id, reopened: true, already: false, decision_id: out.decisionId ?? null, rev: currentRev(file), legacy: false };
}

export interface RecentAgentDecision extends AgentDecision { id: string; title: string }

/** Agent-owned decisions taken in the last `days` days, newest first (record tickets only). */
export function recentAgentDecisions(hostPath: string, days = 14): RecentAgentDecision[] {
  const dir = boardDir(hostPath);
  if (!fs.existsSync(dir)) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out: RecentAgentDecision[] = [];
  for (const t of listTickets(hostPath).tickets) {
    const file = ticketFile(dir, t.id);
    if (!file) continue;
    let md = '';
    try { md = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!md.includes('"owned"')) continue; // cheap pre-filter: only records an `own` wrote
    const parsed = parseTicket(md, { file: path.basename(file), mode: 'auto' });
    if (parsed.format !== 'block' || !parsed.record) continue;
    for (const d of agentDecisionsOf(parsed.record as Record<string, unknown>)) {
      if (d.on && d.on >= since) out.push({ ...d, id: t.id, title: t.title });
    }
  }
  return out.sort((a, b) => String(b.on).localeCompare(String(a.on)) || a.id.localeCompare(b.id));
}
