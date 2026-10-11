/**
 * BUG-239 (A) — a permission card has a deadline, and the deadline can only ever
 * REFUSE.
 *
 * WHY. Five of the eight longest lane hangs on record (2026-08-23 → 10-07) were a
 * subagent lane's permission card that nobody answered — up to 1,271 minutes —
 * because the pending request settled only on an answer, an abort or a session
 * close. The BUG-187 request floor deliberately never refuses a card an attached
 * client owns. Nothing escalated; the only signal was an amber dot.
 *
 * POLICY.
 *   ESCALATE at `escalateMs` (default 5 min): the card surfaces on the Needs-You
 *     rail with its deadline. Every request, main thread or lane.
 *   EXPIRE at `deadlineMs` (default 30 min; 0 = never) — ONLY a request carrying
 *     a subagent's agent id. A request with no agent id (the main thread, or
 *     unattributed) is never expired: failing safe here means today's behaviour.
 *     Expiry ALWAYS resolves `deny`. It never approves, never fabricates a
 *     question answer, never authorises a plan.
 *   RETRY: an identical request (same lane, tool and input) after an expiry is
 *     refused at once, without a second card — "fresh user intent" means the user
 *     re-dispatching, not the lane asking again for another 30 minutes.
 *
 * Timers are Node `setTimeout`, i.e. libuv's CLOCK_MONOTONIC on Linux: awake
 * time. A machine that slept through a card does not expire it the instant it
 * wakes. Node gives no exact timing guarantee; a timer may fire late, never early.
 */

export interface ApprovalDeadlineConfig {
  escalateMs: number;
  /** 0 = lane cards never expire. */
  deadlineMs: number;
}

const MAX_MS = 24 * 60 * 60 * 1000;

function ms(v: string | undefined, d: number): number {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return d;
  return Math.min(Math.floor(n), MAX_MS);
}

/** Read + validate. An escalation at or after the deadline is pulled to half the deadline. */
export function approvalDeadlineConfig(env: NodeJS.ProcessEnv = process.env): ApprovalDeadlineConfig {
  const deadlineMs = ms(env.CLAUDE_STATION_APPROVAL_DEADLINE_MS, 30 * 60 * 1000);
  let escalateMs = ms(env.CLAUDE_STATION_APPROVAL_ESCALATE_MS, 5 * 60 * 1000);
  if (deadlineMs > 0 && (escalateMs === 0 || escalateMs >= deadlineMs)) escalateMs = Math.floor(deadlineMs / 2);
  return { escalateMs, deadlineMs };
}

export function fmtMinutes(msv: number): string {
  if (msv < 60_000) return `${Math.round(msv / 1000)} s`;
  return `${Math.round(msv / 60_000)} min`;
}

/** Verbatim to the model (BUG-174: a denial names its own mechanism). */
export function expiryMessage(deadlineMs: number, kind: 'approval' | 'question' | 'plan'): string {
  const what = kind === 'question' ? 'question' : kind === 'plan' ? 'plan approval' : 'permission request';
  return [
    `ORCHARD PERMISSION TIMEOUT: nobody answered this ${what} within ${fmtMinutes(deadlineMs)}, so it was NOT approved.`,
    'This is a timeout, not a user decision — the user has not seen or refused it.',
    'Do not retry it, and do not work around it with a different tool or command.',
    'Finish whatever does not need it, then put a line in your final report:',
    '"BLOCKED-ON-PERMISSION: <tool> — <what it needed to do and why>", so the user can grant it and re-dispatch.',
  ].join(' ');
}

export function retryRefusalMessage(): string {
  return 'ORCHARD PERMISSION TIMEOUT (repeat): this exact request already timed out unanswered in this session, so it is refused without asking again. '
    + 'Do not retry it. Report it as "BLOCKED-ON-PERMISSION: <tool> — <what>" in your final report.';
}

/** Deterministic key for "the same request again": lane + tool + canonical input. */
export function requestKey(agentId: string, toolName: string, input: unknown): string {
  return `${agentId}\u0000${toolName}\u0000${canonical(input)}`;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** One line describing what a tool wanted, for a rail card. */
export function inputSummary(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const s = pick('command') || pick('file_path') || pick('path') || pick('url') || pick('pattern') || pick('description') || '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one ? `${toolName}: ${one.length > 140 ? `${one.slice(0, 140)}…` : one}` : toolName;
}
