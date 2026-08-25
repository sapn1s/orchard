/**
 * FEAT-057 — WHAT ENDED AND WHY, recorded by the SERVER, costing ZERO model tokens.
 *
 * WHY THIS EXISTS. An agent that dies fires a harness notification the
 * ORCHESTRATOR must run a turn to consume. In an account-wide usage limit the
 * orchestrator cannot run either — so the information existed only in a
 * transient notification nobody read, and the user discovered the outage by
 * noticing that nothing had happened. Everything here is written by the server
 * from frames it already receives, persisted to disk, and rendered by the
 * client with no model in the loop.
 *
 * IT IS THE SAME STRUCTURE THAT ANSWERS "WHAT IS RUNNING" (ARCH-001 phase 2):
 * `running-set.ts` carries these records on every snapshot. Building the two
 * separately is exactly what produced the split-brain this ticket family exists
 * to end — a surface that knows what runs but not what died will invent one of
 * the two.
 *
 * HONESTY RULES (§C), enforced here rather than merely documented:
 *  - A cause is NEVER fabricated. `kind:'unknown'` with the plain-words detail
 *    "…ended; the engine reported no outcome for it" is the fallback, and it is
 *    an honest answer. `completed` is only ever written where a terminal frame
 *    actually said so.
 *  - Only DEATHS are stored. A normal completion is not an outcome anyone needs
 *    to be told about after the fact, and storing every finished `local_bash`
 *    row would grow the store by hundreds of records per session.
 *  - The store is BOUNDED (`MAX_RECORDS`), oldest-first pruned, and written
 *    atomically, so a crash mid-write cannot truncate it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';

/**
 * Why a thing ended. Same vocabulary as `liveness.ts`'s `LivenessEnd` — the
 * authority's `ended` slot is the source these records are filled from.
 */
export type OutcomeKind = 'completed' | 'failed' | 'killed' | 'cut' | 'provider-error' | 'unknown';

/** BUG-031's provider-agnostic taxonomy, carried verbatim (never re-derived). */
export interface OutcomeProviderError {
  kind: string;
  provider: string;
  detail: string;
  retryable?: boolean;
  /** Epoch ms the provider says the window reopens — the "resets 13:40" half. */
  resetsAt?: number | null;
  /**
   * BUG-041 — BUG-035's "still attaching" marker, carried through so this
   * module can refuse to treat an advisory notice as a cause of death.
   */
  pending?: boolean | null;
}

/**
 * BUG-041 — MAY THIS CLASSIFICATION BE NAMED AS A CAUSE OF DEATH?
 *
 * Only a classification that is TERMINAL FOR THE TURN may become a
 * `provider-error` reason. Two advisory shapes exist today and both are
 * excluded: `retrying` (the engine is still retrying — the turn is alive) and
 * `pending` (BUG-035's deliberately NON-FATAL "MCP tool server still starting"
 * notice — a capability arriving late cannot kill a turn). The live failure
 * this guards against: the pending-serena notice was latched as the turn's
 * last classified error and reported verbatim as why two agents died.
 */
export function isTerminalCause(pe: { retrying?: unknown; pending?: boolean | null } | null | undefined): boolean {
  if (!pe) return false;
  return !pe.retrying && !pe.pending;
}

export interface AgentOutcome {
  id: string;
  /** Epoch ms, SERVER clock, when the end was observed. Never fabricated. */
  at: number;
  projectId: string | null;
  projectName: string | null;
  stationSessionId: string | null;
  sdkSessionId: string | null;
  /** The agent's task id, or `'main'` for the orchestrator's own turn. */
  agentId: string;
  row: 'main' | 'agent' | 'tool';
  label: string;
  description: string;
  kind: OutcomeKind;
  /** Plain words, safe to show a user. */
  detail: string;
  providerError: OutcomeProviderError | null;
  /**
   * BUG-041 — records written by ONE host-level moment (a turn boundary sweep,
   * a session cut) share a cluster id, stamped by the writer that KNOWS they
   * are one event. Reporting surfaces collapse a cluster into a single
   * "host-level event" line instead of narrating N independent deaths.
   */
  clusterId?: string | null;
  /** Set when the user dismissed the rail item. Persisted: a reload keeps it gone. */
  dismissedAt: number | null;
  /** Set when it was named in a "while you were away" briefing (never twice). */
  briefedAt: number | null;
}

/**
 * Normalise a provider's `resetsAt` to epoch MILLISECONDS.
 *
 * The two engines differ (BUG-031's `ProviderError.resetsAt` is documented as
 * "epoch seconds or ms"), and a surface that guesses wrong renders a reset time
 * that is off by decades — a fabricated number, which is exactly the failure
 * class this whole family keeps paying for. Normalised ONCE, here, so no
 * renderer has to know which it got. `null` in, `null` out: unknown stays
 * unknown and the UI shows no reset time at all.
 */
export function resetsAtMs(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  // Anything below ~2001-09-09 in ms cannot be a real reset time in ms, and IS
  // a plausible epoch-seconds value; the two ranges do not overlap in practice.
  return v < 1e12 ? v * 1000 : v;
}

/** Total retained records. Oldest are pruned first; deaths are small and rare. */
const MAX_RECORDS = 200;
/** How many individual deaths a single briefing may name before it counts. */
const BRIEF_MAX_ITEMS = 6;

function storeFile(): string {
  return path.join(dataDir(), 'agent-outcomes.json');
}

function readAll(): AgentOutcome[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as AgentOutcome[]) : [];
  } catch {
    return []; // no store yet, or unreadable — an empty ledger, never an error
  }
}

function writeAll(records: AgentOutcome[]): void {
  ensureDir(dataDir());
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
  writeAtomic(storeFile(), JSON.stringify(trimmed, null, 2));
}

export interface RecordInput {
  projectId?: string | null;
  projectName?: string | null;
  stationSessionId?: string | null;
  sdkSessionId?: string | null;
  agentId: string;
  row: 'main' | 'agent' | 'tool';
  label: string;
  description?: string;
  kind: OutcomeKind;
  detail: string;
  providerError?: OutcomeProviderError | null;
  at?: number;
  /** BUG-041 — set by a writer recording several rows for ONE host-level event. */
  clusterId?: string | null;
}

/** Does this record describe something the user should be told about? */
export function isDeath(kind: OutcomeKind): boolean {
  return kind !== 'completed';
}

/**
 * Record ONE end. Deaths only (a `completed` is dropped — see the header).
 *
 * FIRST OBSERVATION WINS, per (session, agent): an agent ends once. A later
 * sweep that finds the same agent already settled must not overwrite the
 * specific reason with a vaguer one — e.g. a turn-boundary sweep saying
 * "unknown" must never replace a recorded `provider-error` that named the
 * quota window. `main` is exempt: an orchestrator turn ends once PER TURN, so
 * its records are keyed by time as well.
 */
export function record(input: RecordInput): AgentOutcome | null {
  if (!isDeath(input.kind)) return null;
  const at = input.at ?? Date.now();
  const key = input.sdkSessionId || input.stationSessionId || 'unknown-session';
  const all = readAll();
  if (input.agentId !== 'main' && all.some((o) => sessionKeyOf(o) === key && o.agentId === input.agentId)) {
    return null; // already recorded — the first, most specific observation stands
  }
  /*
   * BUG-041 — DEFENSE IN DEPTH at the one choke point every write passes.
   * An ADVISORY classification (BUG-035's pending "MCP still starting" notice)
   * must never be stored as a cause of death, whatever a caller latched. The
   * notice is kept — verbatim, as annotated CONTEXT in `detail` so a reader
   * can corroborate — but the recorded cause demotes to the honest `unknown`,
   * and `providerError` stays null so no surface renders it as the reason.
   */
  let kind = input.kind;
  let detail = input.detail;
  let providerError = input.providerError ?? null;
  if (providerError && !isTerminalCause(providerError)) {
    if (kind === 'provider-error') kind = 'unknown';
    detail = `${detail} (context, not cause: an advisory ${providerError.kind} notice from ${providerError.provider} was active — "${providerError.detail}" — a capability still attaching cannot end a turn)`;
    providerError = null;
  }
  const rec: AgentOutcome = {
    id: `out-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    stationSessionId: input.stationSessionId ?? null,
    sdkSessionId: input.sdkSessionId ?? null,
    agentId: input.agentId,
    row: input.row,
    label: input.label,
    description: input.description ?? '',
    kind,
    detail,
    providerError,
    clusterId: input.clusterId ?? null,
    dismissedAt: null,
    briefedAt: null,
  };
  all.push(rec);
  writeAll(all);
  return rec;
}

/**
 * FEAT-057 gap #2 — ATTACH THE TURN'S CAUSE TO THE DEATHS IT CAUSED.
 *
 * The reported hole, verbatim: "a SUBAGENT that dies on a usage limit settles
 * as a generic failed/killed row — the user never learns it was a quota wall".
 * That is not a rendering bug, it is an ORDERING fact about the engines: the
 * turn settles its agents FIRST (each one a bare `killed`) and only then
 * reports why the turn failed. So the cause arrives after the deaths.
 *
 * This upgrades the records of THIS turn — `since` is the turn's own start, so
 * a previous turn's death can never be re-attributed — and it is careful about
 * what it claims: the record keeps saying what the engine said about the agent
 * ("the engine reported this agent killed") and ADDS the turn's failure as the
 * context it happened in. It never invents a cause where the engine reported
 * none, and it never touches a record that already names its own.
 */
export function attachProviderError(
  sessionIds: (string | null | undefined)[],
  since: number,
  providerError: OutcomeProviderError,
): number {
  // BUG-041 — an advisory classification (pending/retrying) is not a cause of
  // anything and must never be promoted onto a death record. Attach nothing.
  if (!isTerminalCause(providerError)) return 0;
  const ids = sessionIds.filter((s): s is string => !!s);
  if (!ids.length) return 0;
  const all = readAll();
  let n = 0;
  for (const o of all) {
    if (o.providerError) continue;
    if (o.at < since) continue;
    if (!ids.includes(o.stationSessionId ?? '') && !ids.includes(o.sdkSessionId ?? '')) continue;
    o.providerError = providerError;
    o.detail = `${o.detail}; the turn it belonged to then failed with ${providerError.kind} (${providerError.provider}): ${providerError.detail}`;
    o.kind = 'provider-error';
    n++;
  }
  if (n) writeAll(all);
  return n;
}

function sessionKeyOf(o: AgentOutcome): string {
  return o.sdkSessionId || o.stationSessionId || 'unknown-session';
}

/**
 * BUG-041 — WHAT (IF ANYTHING) MAY BE RECORDED for an agent that was still
 * open when its turn's `result` arrived. Extracted here as the single, testable
 * decision the bridge's turn-boundary sweep applies per agent.
 *
 * The second live false-positive this ticket collected: an agent COMPLETED and
 * delivered its full report, then the parent turn ended before the engine
 * emitted the agent's terminal frame — and the ledger logged it as an
 * incomplete death. A delivered final result IS an outcome: when the Task
 * call's tool_result came back (`resultDelivered`), nothing died and NOTHING
 * is recorded (returns null). "No terminal frame observed" is not "did not
 * complete".
 */
export function turnEndOutcome(opts: {
  interrupted: boolean;
  /** The agent's Task tool_result was received — evidence it finished. */
  resultDelivered: boolean;
  lastProviderError: OutcomeProviderError | null;
  /** BUG-041 — an advisory notice active during the turn, quoted as context only. */
  advisoryNotice?: string | null;
}): { kind: OutcomeKind; detail: string; providerError: OutcomeProviderError | null } | null {
  const ctx = opts.advisoryNotice ? ` (context, not cause: ${opts.advisoryNotice})` : '';
  // Evidence of completion outranks everything: an agent whose final result
  // already came back finished — even an interrupt afterwards killed the TURN,
  // not this agent's already-delivered work.
  if (opts.resultDelivered) return null;
  if (opts.interrupted) {
    return {
      kind: 'killed',
      detail: 'the turn was interrupted from the dashboard while this agent was still running',
      providerError: null,
    };
  }
  if (opts.lastProviderError && isTerminalCause(opts.lastProviderError)) {
    const pe = opts.lastProviderError;
    return {
      kind: 'provider-error',
      detail: `the turn ended while this agent was still running; the last failure the engine reported was ${pe.kind} (${pe.provider}): ${pe.detail}`,
      providerError: pe,
    };
  }
  return {
    kind: 'unknown',
    detail: `the turn ended while this agent was still running and the engine reported no outcome for it${ctx}`,
    providerError: null,
  };
}

/**
 * BUG-041 — GROUP records that are really ONE host-level event.
 *
 * Primary evidence is the writer's own `clusterId`. For records that predate
 * it (or came from writers that could not know), a same-session run of deaths
 * within `CLUSTER_WINDOW_MS` of each other is itself evidence of one host
 * event, not N independent failures — the live example was a main turn and its
 * subagent "dying" 3 ms apart. Returns clusters in ascending time order.
 */
export const CLUSTER_WINDOW_MS = 10;
export function clustersOf(records: AgentOutcome[]): AgentOutcome[][] {
  const sorted = [...records].sort((a, b) => a.at - b.at);
  const out: AgentOutcome[][] = [];
  const byClusterId = new Map<string, AgentOutcome[]>();
  let lastImplicit: AgentOutcome[] | null = null;
  for (const o of sorted) {
    if (o.clusterId) {
      const key = `${sessionKeyOf(o)}|${o.clusterId}`;
      const c = byClusterId.get(key);
      if (c) { c.push(o); continue; }
      const fresh = [o];
      byClusterId.set(key, fresh);
      out.push(fresh);
      lastImplicit = null;
      continue;
    }
    const prev = lastImplicit?.[lastImplicit.length - 1];
    if (prev && sessionKeyOf(prev) === sessionKeyOf(o) && o.at - prev.at <= CLUSTER_WINDOW_MS) {
      lastImplicit!.push(o);
      continue;
    }
    lastImplicit = [o];
    out.push(lastImplicit);
  }
  return out;
}

export interface ListQuery {
  projectId?: string | null;
  /** Any of these ids (station or sdk) identifies the session. */
  sessionIds?: (string | null | undefined)[];
  includeDismissed?: boolean;
  limit?: number;
}

/** Newest first. Dismissed records are excluded unless asked for. */
export function list(q: ListQuery = {}): AgentOutcome[] {
  const ids = (q.sessionIds ?? []).filter((s): s is string => !!s);
  const out = readAll().filter((o) => {
    if (!q.includeDismissed && o.dismissedAt) return false;
    if (q.projectId && o.projectId && o.projectId !== q.projectId) return false;
    if (ids.length && !ids.includes(o.stationSessionId ?? '') && !ids.includes(o.sdkSessionId ?? '')) return false;
    return true;
  });
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, q.limit ?? 50);
}

/** Mark records dismissed (persisted). `ids: '*'` dismisses everything listed. */
export function dismiss(ids: string[] | '*'): number {
  const all = readAll();
  const now = Date.now();
  let n = 0;
  for (const o of all) {
    if (o.dismissedAt) continue;
    if (ids !== '*' && !ids.includes(o.id)) continue;
    o.dismissedAt = now;
    n++;
  }
  if (n) writeAll(all);
  return n;
}

/* ------------------------------------------------ the "while you were away" briefing */

/**
 * BUG-070 — a RELATIVE DAY label ("today", "yesterday", "Aug 10") for an
 * outcome's timestamp, so a reader can never mistake a fossil for a fresh
 * death. The reported failure: "these errors were … 1-2 days ago and still
 * will show always as if 7pm today" — the record has the ISO date, the rail
 * was dropping it and printing time-of-day alone. Computed on CALENDAR-day
 * boundaries (not a rolling 24h) so "yesterday 23:00" reads as yesterday even
 * an hour later. Mirrored verbatim by the client's `dayLabel`.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(atMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (atMs == null || !Number.isFinite(atMs)) return '';
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** A short local clock for a reset time ("13:40"), or '' when there is none. */
function hhmm(at: number | null | undefined): string {
  if (!at || !Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One human line for a single death. Used by the briefing AND by the client. */
export function outcomeLine(o: AgentOutcome): string {
  const who = o.row === 'main' ? 'the main turn' : `${o.label}${o.description ? ` (${o.description})` : ''}`;
  const when = new Date(o.at).toISOString();
  if (o.kind === 'provider-error' && o.providerError) {
    const reset = hhmm(o.providerError.resetsAt);
    return `${who} — ${o.providerError.kind} (${o.providerError.provider})${reset ? `, resets ${reset}` : ''}: ${o.providerError.detail} [${when}]`;
  }
  if (o.kind === 'unknown') return `${who} — ended, reason unknown: ${o.detail} [${when}]`;
  return `${who} — ${o.kind}: ${o.detail} [${when}]`;
}

/**
 * The bounded briefing injected at the orchestrator's NEXT turn start.
 *
 * Returns null when nothing died since it last ran — a healthy session must
 * never be spammed, and "nothing to report" is not worth a single token. Each
 * record is named at most once (`briefedAt`), so a long-running session does
 * not re-hear about the same death every turn.
 */
export function takeBriefing(sessionIds: (string | null | undefined)[]): string | null {
  const ids = sessionIds.filter((s): s is string => !!s);
  if (!ids.length) return null;
  const all = readAll();
  const mine = all.filter(
    (o) => !o.briefedAt && (ids.includes(o.stationSessionId ?? '') || ids.includes(o.sdkSessionId ?? '')),
  );
  if (!mine.length) return null;
  mine.sort((a, b) => a.at - b.at);
  const now = Date.now();
  for (const o of mine) o.briefedAt = now;
  writeAll(all);

  /*
   * BUG-041 — one host-level event is ONE briefing item. N rows that ended
   * together (a cut session, a turn-boundary sweep) are a single fact; telling
   * the orchestrator "N agents ended" invites it to treat an advisory surface
   * as N independent failures (the exact over-reaction ARCH-002 documents).
   * Wording is deliberately not over-strong: `unknown` records may well have
   * completed — the server only knows it observed no terminal frame.
   */
  const clusters = clustersOf(mine);
  const shown = clusters.slice(0, BRIEF_MAX_ITEMS);
  const rest = clusters.length - shown.length;
  const head = `[station] While you were away: ${mine.length} agent/turn${mine.length === 1 ? '' : 's'} ended since your last turn (${clusters.length} event${clusters.length === 1 ? '' : 's'}).`;
  const lines = shown.map((c) => `  - ${c.length > 1 ? clusterLine(c) : outcomeLine(c[0])}`);
  const tail = rest > 0 ? [`  - …and ${rest} more event${rest === 1 ? '' : 's'} (see the dashboard rail).`] : [];
  return [head, ...lines, ...tail, '[station] This is a server-recorded fact, not a request — it is ADVISORY: corroborate (transcripts, commits, the rail) before abandoning or re-dispatching work on the strength of it.'].join('\n');
}

/**
 * BUG-041 — one line for a CLUSTER: N rows that ended in the same host-level
 * moment, named as one event with the evidence (who, span, shared cause).
 */
export function clusterLine(c: AgentOutcome[]): string {
  const who = c.map((o) => (o.row === 'main' ? 'the main turn' : o.label || 'agent')).join(' + ');
  const spanMs = c[c.length - 1].at - c[0].at;
  const when = new Date(c[0].at).toISOString();
  const pe = c.map((o) => o.providerError).find((p) => !!p);
  const cause = pe
    ? `${pe.kind} (${pe.provider}): ${pe.detail}`
    : [...new Set(c.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))].join(', ');
  return `host-level event: ${c.length} ended together (${who}, within ${spanMs}ms) — one event, not ${c.length} independent failures — ${cause} [${when}]`;
}

/**
 * Group deaths into the one-line rail headline, e.g.
 * "3 agents stopped — usage limit, resets 13:40". Shared by the server (tests)
 * and mirrored by the client so the two surfaces cannot word it differently.
 */
export function headline(outcomes: AgentOutcome[]): string {
  if (!outcomes.length) return '';
  const n = outcomes.length;
  // BUG-041 — when everything shown is ONE host-level event, say so instead of
  // implying N independent deaths. (Mirrored by the client's outcomesHeadline.)
  const clusters = clustersOf(outcomes);
  if (clusters.length === 1 && n > 1) {
    const pe = outcomes.map((o) => o.providerError).find((p) => !!p);
    const kinds = [...new Set(outcomes.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))];
    return `${n} stopped together — one event (${pe ? pe.kind : kinds.join(', ')})`;
  }
  const quota = outcomes.find((o) => o.kind === 'provider-error' && o.providerError);
  const noun = `${n} agent${n === 1 ? '' : 's'} stopped`;
  if (quota?.providerError) {
    const reset = hhmm(quota.providerError.resetsAt);
    return `${noun} — ${quota.providerError.kind}${reset ? `, resets ${reset}` : ''}`;
  }
  const kinds = [...new Set(outcomes.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))];
  return `${noun} — ${kinds.join(', ')}`;
}
