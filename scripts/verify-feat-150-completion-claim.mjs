#!/usr/bin/env node
/**
 * FEAT-150 — the orchestrator's "done"/"all green" does not distinguish
 * filed / built-unverified / verified / committed, so the user must interrogate.
 *
 *   npm run verify:feat-150
 *
 * Drives the response-format stop hook DIRECTLY (scripts/hooks/response-format-gate.mjs)
 * with crafted Stop payloads + synthetic JSONL transcripts, exactly like the
 * FEAT-085 suite — but the completion-claim check binds to the REAL board via
 * board-status.mjs, so this suite reads the project's ACTUAL docs/bugs (the
 * user's reality), not a fixture board.
 *
 * The contract asserted:
 *   BLOCK = exit 0 AND stdout is {"decision":"block","reason":...} naming the
 *           ticket + the board's real work_state.
 *   ALLOW = exit 0 AND no stdout.
 *
 * ENFORCED BY DEFAULT: the completion check is NOT gated on
 * ORCHARD_STOP_HOOK_ENFORCE (it is in the FEAT-137/138 enforced-by-default
 * class), so every run below deliberately leaves that env UNSET and still blocks.
 *
 * Non-vacuity / must-FAIL guards:
 *   - a done item whose ref the board reads verified/done ALLOWS (the check
 *     cannot be an always-block);
 *   - a done item with NO ref ALLOWS (ad-hoc, ticket-less — the declared fork);
 *   - an `in-flight` item about the SAME in-progress ticket ALLOWS (only a
 *     `done` claim is graded);
 *   - the block reason must name the ticket AND its real work_state, so it cannot
 *     pass on an empty/absent status.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTicketReport } from './board-status.mjs';
import { resolveBoardDir } from './lib/board-path.mjs';
import { DONE_WORK_STATES } from './lib/ticket-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOOK = path.join(HERE, 'hooks', 'response-format-gate.mjs');
const BOARD = resolveBoardDir(REPO);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat150-'));
const SID = '0f150000-0000-4000-8000-000000000150';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

/** A minimal, otherwise-compliant reply: a valid leading digest + tiny prose. */
function replyWithItems(items) {
  const json = JSON.stringify({ items });
  return '```orchard-digest\n' + json + '\n```\n\nStatus above.';
}

function transcript(name, text) {
  const file = path.join(TMP, name + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'is it done?' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Run the hook WITHOUT ORCHARD_STOP_HOOK_ENFORCE — proving default enforcement. */
function run(items) {
  const tp = transcript('t' + Math.random().toString(36).slice(2), replyWithItems(items));
  const payload = { session_id: SID, cwd: REPO, transcript_path: tp, hook_event_name: 'Stop' };
  const env = { ...process.env, ORCHARD_SESSION: SID };
  delete env.ORCHARD_STOP_HOOK_ENFORCE; // prove it blocks by default
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd: REPO, timeout: 15000 });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const isAllow = (res) => res.code === 0 && res.stdout === '';
function blockReason(res) {
  try { const o = JSON.parse(res.stdout); return o.decision === 'block' ? String(o.reason || '') : null; }
  catch { return null; }
}

/* ── Discover real board tickets at runtime (the user's reality, not a fixture) ── */
function firstTicketWith(pred) {
  // Cheap scan of the board dir for a ticket id whose report satisfies pred.
  for (const f of fs.readdirSync(BOARD)) {
    const m = /^(ARCH|BUG|FEAT|DEPLOY)-(\d+)-/.exec(f);
    if (!m) continue;
    const id = `${m[1]}-${Number(m[2])}`;
    let rep; try { rep = buildTicketReport(BOARD, id, 0); } catch { continue; }
    if (rep && rep.ok && pred(rep)) return rep;
  }
  return null;
}
const doneSet = new Set(DONE_WORK_STATES);
const verifiedTicket = firstTicketWith((r) => doneSet.has(r.work_state) && !r.status_ambiguous);
const openTicket = firstTicketWith((r) => !doneSet.has(r.work_state) && r.work_state === 'in_progress');

console.log('FEAT-150 — completion-claim ground truth (real board: ' + BOARD + ')');
console.log('  discovered verified ticket: ' + (verifiedTicket ? `${verifiedTicket.id} (${verifiedTicket.work_state})` : 'NONE'));
console.log('  discovered in-progress ticket: ' + (openTicket ? `${openTicket.id} (${openTicket.work_state})` : 'NONE'));

check('a verified ticket exists on the real board to test the ALLOW path', !!verifiedTicket);
check('an in-progress ticket exists on the real board to test the BLOCK path', !!openTicket);

/* 1. BLOCK — "done" for a ticket the board reads in_progress. THE loop. */
if (openTicket) {
  const res = run([{ text: `${openTicket.id} shipped, all green`, kind: 'done', importance: 'high', ref: openTicket.id }]);
  const reason = blockReason(res);
  check('done-claim for an in-progress ticket is BLOCKED (default, no ENFORCE)', reason !== null, res);
  check('  block reason names the ticket', !!reason && reason.includes(openTicket.id), reason);
  check('  block reason carries the real work_state (read from board, not memory)',
    !!reason && reason.includes(openTicket.work_state), reason);
}

/* 2. ALLOW — "done" for a genuinely verified/done ticket. Not an always-block. */
if (verifiedTicket) {
  const res = run([{ text: `${verifiedTicket.id} verified and landed`, kind: 'done', importance: 'high', ref: verifiedTicket.id }]);
  check('done-claim for a verified ticket is ALLOWED', isAllow(res), res);
}

/* 3. BLOCK — "done" for a ticket with NO board record (cannot pass on missing status). */
{
  const res = run([{ text: 'FEAT-99999 done', kind: 'done', importance: 'high', ref: 'FEAT-99999' }]);
  const reason = blockReason(res);
  check('done-claim for a non-existent ticket is BLOCKED (no record != done)', reason !== null, res);
  check('  block reason says no record found', !!reason && /no ticket record/i.test(reason), reason);
}

/* 4. FORK / non-vacuity — an ad-hoc done item with NO ref is NOT graded. */
{
  const res = run([{ text: 'changed the sidebar to red, done', kind: 'done', importance: 'high' }]);
  check('ad-hoc (ref-less) done-claim is ALLOWED (declared fork, no false block)', isAllow(res), res);
}

/* 5. Only `done` is graded — an in-flight item about the in-progress ticket ALLOWS. */
if (openTicket) {
  const res = run([{ text: `${openTicket.id} still in progress`, kind: 'in-flight', importance: 'med', ref: openTicket.id }]);
  check('in-flight item about an in-progress ticket is ALLOWED (only done is a completion claim)', isAllow(res), res);
}

/* 6. Anti-regression — a compliant reply with no done items is untouched. */
{
  const res = run([{ text: 'here is what I found', kind: 'fyi', importance: 'low' }]);
  check('a reply with no completion claim is ALLOWED (no regression on the base gate)', isAllow(res), res);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nFEAT-150: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
