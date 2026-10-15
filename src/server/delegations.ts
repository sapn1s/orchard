/**
 * FEAT-184 — the user's STANDING DELEGATIONS, and an agent's ADOPTION under one.
 *
 *   GET  /api/projects/:id/delegations                 every delegation + its state
 *   POST /api/projects/:id/delegations                 USER ONLY — record one
 *        { statement, tickets: [ids], days }
 *   POST /api/projects/:id/delegations/:did/revoke     USER ONLY — revoke one
 *   POST /api/projects/:id/tickets/:tid/adopt          an agent adopts the decision's
 *        { delegation_id, option?, note?, author }      own recommendation under a live
 *                                                      delegation the user recorded
 *
 * THE PROPERTY. An agent can never create something that reads as the user's: the
 * record/revoke routes refuse any caller that is not the user (requireUserCaller —
 * the FEAT-164 process-provenance gate), and the adopt route writes a typed entry
 * `by: 'agent-under-delegation'` naming the delegation, never `by: 'user'`.
 * Authority for an adoption comes ONLY from a delegation the user recorded here —
 * never from a transcript turn, which an agent can produce (BUG-258).
 *
 * SERIALIZED. Every handler is synchronous from its checks to its writes (no await
 * between them), so on the server's one thread a revoke, an adoption and a user
 * answer cannot interleave. recordAdoption also refuses if the ticket's bytes
 * changed between its read and its write (another process — a board-tool lane).
 */
import type * as http from 'node:http';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requireUserCaller } from './caller-provenance.ts';
import { boardDir, ticketFile, ticketAnswerState, recordAdoption, StaleAnswerError, legacyTypedUserAnswers, decisionKey, boardHasAdoptions } from './board.ts';
import { dataDir } from '../lib/paths.ts';
import { parseTicket } from '../../scripts/lib/ticket-schema.mjs';
import { genBoard } from '../../scripts/board.mjs';
import {
  loadStore, appendEntry, ensureBoardStore, readDelegationKey, validateDelegationInput,
  listDelegations, liveDelegation, READS_AS_USER, PERMITS,
} from '../../scripts/lib/delegation-source.mjs';

type Send = (res: http.ServerResponse, code: number, body: unknown) => void;
type ReadBody = (req: http.IncomingMessage) => Promise<unknown>;
interface Project { id: string; hostPath: string }

const ID_RE = /^[A-Z]+-\d+$/;
const USER_ONLY = {
  code: 'agent-not-user',
  agentError: 'only the user records or revokes a delegation, from the dashboard. An agent adopts a decision only under a delegation the user recorded (node scripts/board-tool.mjs adopt).',
};

/** Live delegations that cover one ticket — for the ticket view's Decide card. */
export function delegationsForTicket(hostPath: string, id: string): { damaged: string | null; delegations: ReturnType<typeof listDelegations> } {
  const dir = boardDir(hostPath);
  const store = loadStore(dataDir(), dir);
  if (!store.ok) return { damaged: store.damaged, delegations: [] };
  return { damaged: null, delegations: listDelegations(store).filter((d) => d.scope?.tickets?.includes(id)) };
}

/**
 * Handle a delegation/adopt route. Returns true when it answered. `rest` is the
 * path after /api/ (['projects', id, 'delegations', …] or ['projects', id,
 * 'tickets', tid, 'adopt']).
 */
export async function handleDelegationRoute(
  req: http.IncomingMessage, res: http.ServerResponse, m: string, rest: string[], p: Project,
  sendJson: Send, readBody: ReadBody,
): Promise<boolean> {
  const dir = boardDir(p.hostPath);
  const data = dataDir();

  if (rest[2] === 'delegations') {
    if (m === 'GET' && rest.length === 3) {
      const store = loadStore(data, dir);
      sendJson(res, 200, { damaged: store.ok ? null : store.damaged, delegations: store.ok ? listDelegations(store) : [] });
      return true;
    }
    if (m === 'POST' && rest.length === 3) {
      const refusal = requireUserCaller(req, `recording a delegation on ${p.id}`, USER_ONLY);
      if (refusal) { sendJson(res, refusal.status, refusal.body); return true; }
      let body: Record<string, unknown>;
      try { body = ((await readBody(req)) ?? {}) as Record<string, unknown>; } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return true; }
      // ── synchronous from here to the write ──
      const v = validateDelegationInput(body);
      if (!v.ok) { sendJson(res, 400, { error: v.errors.join('; '), code: 'bad-delegation' }); return true; }
      const unknown = v.value.scope.tickets.filter((t: string) => !ticketFile(dir, t));
      if (unknown.length) { sendJson(res, 400, { error: `no ticket ${unknown.join(', ')} on this board`, code: 'bad-delegation' }); return true; }
      // First write for this board: seal receipts for its existing user answers too.
      const key = ensureBoardStore(data, dir, () => legacyTypedUserAnswers(dir), { hasAdoptions: () => boardHasAdoptions(dir) });
      const now = new Date();
      try {
        const e = appendEntry(data, dir, key, {
          kind: 'record', delegation_id: randomUUID(), statement: v.value.statement, scope: v.value.scope,
          permits: PERMITS, recorded_on: now.toISOString().slice(0, 10), recorded_at: now.toISOString(),
          expires_at: v.value.expires_at, recorded_by: 'server', origin: 'user-route',
        });
        const { seal: _s, prev: _p, ...shown } = e;
        sendJson(res, 200, { ok: true, delegation: shown });
      } catch (err) {
        sendJson(res, 409, { error: (err as Error).message, code: (err as { code?: string }).code ?? 'delegation-store-damaged' });
      }
      return true;
    }
    if (m === 'POST' && rest.length === 5 && rest[4] === 'revoke') {
      const refusal = requireUserCaller(req, `revoking delegation ${rest[3]} on ${p.id}`, USER_ONLY);
      if (refusal) { sendJson(res, refusal.status, refusal.body); return true; }
      const did = rest[3];
      const key = readDelegationKey(data);
      const store = loadStore(data, dir, key);
      if (!store.ok || !key) { sendJson(res, 409, { error: `the delegation store is damaged: ${store.damaged}`, code: 'delegation-store-damaged' }); return true; }
      if (!store.entries.some((e: { kind: string; delegation_id: string }) => e.kind === 'record' && e.delegation_id === did)) {
        sendJson(res, 404, { error: `no delegation ${did}`, code: 'delegation-not-found' }); return true;
      }
      if (store.entries.some((e: { kind: string; delegation_id: string }) => e.kind === 'revoke' && e.delegation_id === did)) {
        sendJson(res, 409, { error: `delegation ${did} is already revoked`, code: 'delegation-revoked' }); return true;
      }
      const now = new Date().toISOString();
      appendEntry(data, dir, key, { kind: 'revoke', delegation_id: did, recorded_at: now, recorded_by: 'server', origin: 'user-route' });
      sendJson(res, 200, { ok: true, delegation_id: did, revoked_at: now });
      return true;
    }
    sendJson(res, 404, { error: `delegations: no route ${m} ${rest.slice(2).join('/')}` });
    return true;
  }

  if (rest[2] === 'tickets' && rest[4] === 'adopt' && m === 'POST' && rest.length === 5) {
    // NOT caller-gated: agents call this. Authority comes only from a live delegation.
    let body: Record<string, unknown>;
    try { body = ((await readBody(req)) ?? {}) as Record<string, unknown>; } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return true; }
    // ── synchronous from here to the write ──
    const out = adopt(p, dir, data, rest[3], body);
    sendJson(res, out.status, out.body);
    return true;
  }
  return false;
}

function refuse(status: number, code: string, error: string) { return { status, body: { ok: false, code, error } }; }

function adopt(p: Project, dir: string, data: string, tid: string, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  if (!ID_RE.test(tid)) return refuse(400, 'bad-id', `not a ticket id: ${JSON.stringify(tid)}`);
  const author = String(body.author ?? '').trim();
  if (!author || /[\r\n\u2028\u2029]/.test(author) || author.length > 120) return refuse(400, 'bad-author', 'author: one line naming the agent that adopts (e.g. "worker (FEAT-182 fixing r1)")');
  if (READS_AS_USER.test(author)) return refuse(400, 'bad-author', `author ${JSON.stringify(author)} reads as the user — an adoption is an agent's act and is recorded as one`);
  const did = String(body.delegation_id ?? '').trim();
  if (!did) return refuse(400, 'missing-arg', 'delegation_id is required: an adoption always names the delegation the user recorded');
  const note = String(body.note ?? '').trim();
  if (note.length > 2000) return refuse(400, 'bad-note', 'note: at most 2000 characters');

  const file = ticketFile(dir, tid);
  if (!file) return refuse(404, 'no-ticket', `no ticket ${tid} on this board`);
  const text = fs.readFileSync(file, 'utf8');
  let record: Record<string, unknown> | null = null;
  try { const parsed = parseTicket(text, { mode: 'auto' }); record = parsed.format === 'block' ? parsed.record as Record<string, unknown> : null; } catch { /* unreadable */ }
  const decision = record?.decision as { recommendation?: string | null; options?: { key: string; label: string }[] } | null | undefined;
  if (!record || !decision || typeof decision !== 'object') return refuse(409, 'no-decision', `${tid} has no live record decision to adopt`);
  if (ticketAnswerState(text, file)) return refuse(409, 'already-answered', `${tid}'s current decision is already answered or adopted — nothing to adopt`);
  const rec = decision.recommendation ?? null;
  if (!rec) return refuse(409, 'no-recommendation', `${tid}'s decision recommends no option; a delegation lets an agent adopt only the recommendation`);
  const option = body.option === undefined || body.option === null || body.option === '' ? rec : String(body.option).trim();
  if (option !== rec) return refuse(409, 'not-recommended', `option ${option} is not ${tid}'s recommendation (${rec}); a delegation covers only the recommended option — leave any other choice to the user`);
  const opt = (decision.options ?? []).find((o) => o && o.key === rec);
  if (!opt) return refuse(409, 'no-recommendation', `${tid}'s recommendation ${rec} is not one of its options`);

  const key = readDelegationKey(data);
  const live = liveDelegation(loadStore(data, dir, key), did, tid);
  if (!live.ok) return refuse(403, live.code, live.why);

  try {
    const { typed, entry } = recordAdoption(file, {
      chose: { key: opt.key, label: opt.label },
      note,
      delegation: { delegation_id: live.delegation.delegation_id, statement: live.delegation.statement ?? '', recorded_at: live.delegation.recorded_at },
      adoptedBy: author,
      expectDecisionKey: decisionKey(text),
      precheck: () => {
        const again = liveDelegation(loadStore(data, dir, key), did, tid);
        if (!again.ok) throw Object.assign(new Error(again.why), { code: again.code });
      },
      receipt: (r) => { appendEntry(data, dir, key, { kind: 'adoption', ...r }); },
    });
    let boardError: string | null = null;
    try { genBoard(dir); } catch (err) { boardError = (err as Error).message; }
    return { status: 200, body: { ok: true, id: tid, adopted: typed, appended: entry, board_error: boardError, project: p.id } };
  } catch (err) {
    if (err instanceof StaleAnswerError) return refuse(409, 'stale', err.message);
    const code = (err as { code?: string }).code;
    if (code === 'ticket-locked') return refuse(409, 'ticket-locked', (err as Error).message);
    if (code && /^delegation-|^out-of-scope$/.test(code)) return refuse(403, code, (err as Error).message);
    throw err;
  }
}
