#!/usr/bin/env node
/**
 * verify-feat-166-board-tool-decide.mjs — proof for `board-tool decide` (FEAT-166).
 *
 * THE BUG. A lane at a fork that needs the user wrote options A/B/C as
 * Activity-log prose (FEAT-164). The Decide card renders only a decision declared
 * in the ticket RECORD, so the user saw nothing. There was no sanctioned writer.
 *
 * WHAT IT RUNS AGAINST. A byte-for-byte COPY of the REAL `docs/bugs/` in a
 * scratch dir — never the live board. The tickets it decides on are DISCOVERED at
 * runtime (an open record ticket with no decision; a record ticket whose open
 * decision has no answer; a record ticket the user already ANSWERED once, which
 * is the re-decision case; a done ticket; a legacy prose ticket) and it stops
 * loudly if the real board has none of a kind.
 *
 * WHAT IT ASSERTS, through the REAL readers, not the writer's own idea of success:
 *   · round-trip — `ticketDecision()` (src/server/board.ts, the parser the Decide
 *     card and Needs-You rail read) returns the keyed options and the recommended
 *     key exactly as declared; `readBoard()` puts the ticket on the needs-you rail
 *     with that question; the record still passes `validateTicket`;
 *   · the CLI form lanes actually type (`--id X --option "A=…" --option "B=…"`,
 *     space-separated, repeated) works, not only `--flag=value`;
 *   · refusals — <2 options, duplicate keys, recommend ∉ keys, recommend without
 *     a reason, an open decision without --replace, an author that would forge a
 *     user answer, a done ticket, a legacy ticket, a truncated (half-written)
 *     ticket — each leaves the file BYTE-IDENTICAL;
 *   · append-only — everything before the appended entry is unchanged except the
 *     record block; no `you (…` answer entry is ever written;
 *   · re-decision — on a ticket the user answered before, the NEW decision is
 *     asked (rail: needsYou, card: unanswered) instead of being hidden behind the
 *     old answer; and once the user answers it, FEAT-090's answered-awaiting lane
 *     still works.
 *
 * MUST-FAIL: before FEAT-166 the tool has no `decide` verb — section 1 fails with
 * `unknown-verb` and every later section with it.
 *
 * Run: node scripts/verify-feat-166-board-tool-decide.mjs
 * Spawns no server, touches no port, never writes inside the real repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { mkdtempScratch } from './lib/scratch.mjs';
import { parseTicket, validateTicket, extractTicketBlock, TICKET_FILE_RE } from './lib/ticket-schema.mjs';
import { boardTool } from './board-tool.mjs';
import { ticketDecision, ticketAnswerState, readBoard } from '../src/server/board.ts';
import { answerTicket, currentRev } from '../src/server/tickets.ts';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BOARD = path.join(REPO, 'docs', 'bugs');

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
function require_(v, what) {
  if (v === null || v === undefined) {
    console.log(`\nSTOP — the real board contains no ${what}; this suite cannot prove anything without one.`);
    process.exit(1);
  }
  return v;
}

const scratch = mkdtempScratch('feat-166-decide-');
const ROOT = path.join(scratch, 'repo');
const BOARD = path.join(ROOT, 'docs', 'bugs');
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.cpSync(REAL_BOARD, BOARD, { recursive: true });

const call = (...argv) => boardTool(argv, { root: ROOT });
/** The CLI, exactly as a lane runs it (space-separated values, repeated --option). */
function cli(...argv) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'board-tool.mjs'), ...argv],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: ROOT } });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { out = { ok: false, raw: r.stdout + r.stderr }; }
  return { status: r.status, out };
}
const fileOf = (id) => path.join(BOARD, fs.readdirSync(BOARD).find((n) => n.startsWith(`${id}-`) && n.endsWith('.md')));
const read = (id) => fs.readFileSync(fileOf(id), 'utf8');
const indexRow = (id) => fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8').split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? null;
const openIds = () => {
  const text = fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8');
  const open = text.split(/^## /m).find((s) => /^open/i.test(s)) ?? '';
  return new Set(open.split('\n').map((l) => (l.match(/^\| ([A-Z]+-\d+) \|/) || [])[1]).filter(Boolean));
};

const OPTS = [
  'A=Keep the timed grant only | Nothing changes; agents keep re-asking every thirty minutes | No new trust surface at all | The user re-grants all day in a trusted project | It is the status quo the user asked to leave',
  'B=Permanent grant per project | A revocable per-project setting the one grant check reads | One decision per project instead of one per half hour | A planted setting is a new path to defend | Persisted trust is what the store avoided on purpose',
  'C=Longer timed grant | Offer eight hours next to thirty minutes | Cuts the re-grant count without persisting anything | Still lapses mid-task on a long day | It halves the problem rather than removing it',
];
const QUESTION = 'Which grant length should the git-write control offer per project?';
const WHY = 'B removes the half-hourly prompt the user asked about while staying revocable from the same control.';

async function main() {
  const realBefore = new Map(fs.readdirSync(REAL_BOARD).filter((f) => TICKET_FILE_RE.test(f)).map((f) => [f, fs.readFileSync(path.join(REAL_BOARD, f), 'utf8')]));

  // Discovery, never names.
  const open = openIds();
  const all = fs.readdirSync(BOARD).filter((f) => TICKET_FILE_RE.test(f)).map((f) => {
    const text = fs.readFileSync(path.join(BOARD, f), 'utf8');
    return { f, id: f.match(/^[A-Z]+-\d+/)[0], text, p: parseTicket(text, { file: f, mode: 'auto' }) };
  });
  const isRecord = (x) => x.p.format === 'block' && x.p.record;
  const SKIP = new Set(['FEAT-164', 'BUG-230', 'FEAT-166']);
  const fresh = require_(all.find((x) => isRecord(x) && open.has(x.id) && !SKIP.has(x.id) && x.p.record.decision === null
    && !['done', 'verified'].includes(x.p.record.work_state) && !ticketAnswerState(x.text, path.join(BOARD, x.f))) ?? null, 'open record ticket with no decision and no prior answer');
  const openDecision = require_(all.find((x) => isRecord(x) && open.has(x.id) && x.id !== fresh.id && x.p.record.decision
    && !ticketAnswerState(x.text, path.join(BOARD, x.f))) ?? null, 'open record ticket with an unanswered decision');
  const answeredBefore = require_(all.find((x) => isRecord(x) && open.has(x.id) && ![fresh.id, openDecision.id].includes(x.id)
    && ticketAnswerState(x.text, path.join(BOARD, x.f))?.kind === 'decision' && !['done', 'verified'].includes(x.p.record.work_state)) ?? null,
  'open record ticket the user already answered once');
  const doneOne = require_(all.find((x) => isRecord(x) && x.p.record.work_state === 'done') ?? null, 'done record ticket');
  const legacy = require_(all.find((x) => x.p.format === 'legacy') ?? null, 'legacy prose ticket');
  console.log(`  (discovered: fresh=${fresh.id} open-decision=${openDecision.id} answered-before=${answeredBefore.id} done=${doneOne.id} legacy=${legacy.id})`);

  const decideArgs = (id, extra = [], opts = OPTS) => ['decide', '--id', id, '--question', QUESTION,
    ...opts.flatMap((o) => ['--option', o]), '--recommend', 'B', '--why', WHY, '--author', 'worker (fixing r1)', ...extra];

  section('1. round-trip on a scratch copy of a real ticket, via the CLI form lanes type');
  const before = read(fresh.id);
  const r = cli(...decideArgs(fresh.id));
  ok('decide exits 0 and reports ok', r.status === 0 && r.out.ok === true, JSON.stringify(r.out.refusal ?? r.out.raw ?? '').slice(0, 300));
  const after = read(fresh.id);
  const d = ticketDecision(after);
  ok('ticketDecision() reads a decision', !!d, 'null');
  ok('…with the declared question', d?.question === QUESTION, d?.question);
  ok('…with keys A,B,C in order', JSON.stringify(d?.options.map((o) => o.key)) === '["A","B","C"]', JSON.stringify(d?.options));
  ok('…with the declared labels', d?.options.map((o) => o.label).join('|') === 'Keep the timed grant only|Permanent grant per project|Longer timed grant');
  ok('…with recommended key B', d?.recommended === 'B', d?.recommended);
  const rec = parseTicket(after, { mode: 'auto' }).record;
  ok('the record passes validateTicket', validateTicket(rec, { file: path.basename(fileOf(fresh.id)) }).ok,
    JSON.stringify(validateTicket(rec, { file: path.basename(fileOf(fresh.id)) }).violations));
  ok('record: mode single, all five option fields kept', rec.decision.mode === 'single' && rec.decision.options.every((o) => o.what_changes && o.benefit && o.cost && o.why_not_obvious));
  ok('record: recommendation_reason is --why', rec.decision.recommendation_reason === WHY);
  ok('record: human_action decide, owner you', rec.human_action === 'decide' && rec.owner === 'you', `${rec.human_action}/${rec.owner}`);
  ok('record: work_state blocked (default)', rec.work_state === 'blocked', rec.work_state);
  ok('INDEX row is owned 👤 and says NEEDS A HUMAN DECISION', /\| \u{1F464} \|/u.test(indexRow(fresh.id) ?? '') && /NEEDS A HUMAN DECISION \(3 options\)/.test(indexRow(fresh.id) ?? ''), indexRow(fresh.id));
  const board = readBoard(ROOT);
  const item = board.needsYou.find((i) => i.id === fresh.id);
  ok('readBoard(): on the needs-you rail with the question, 3 options and B badged',
    !!item && item.question === QUESTION && item.options?.length === 3 && item.recommended === 'B', JSON.stringify(item ?? null).slice(0, 200));
  const { body: bodyBefore } = extractTicketBlock(before);
  const { body: bodyAfter } = extractTicketBlock(after);
  ok('append-only: the old body is a byte-exact prefix of the new body', bodyAfter.startsWith(bodyBefore));
  const appended = bodyAfter.slice(bodyBefore.length);
  ok('one Activity entry appended, labelled Decision declared, authored by the lane', /^\n### \d{4}-\d\d-\d\d — worker \(fixing r1\)\n- \*\*Decision declared:\*\*/.test(appended), JSON.stringify(appended.slice(0, 120)));
  ok('no user answer entry was written', !/^### .* — you \(/m.test(appended) && ticketAnswerState(after, fileOf(fresh.id)) === null);

  section('2. refusals leave the file byte-identical');
  async function refuses(name, id, argv, code) {
    const b = read(id);
    const idx = fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8');
    const out = await call(...argv);
    ok(`${name}: refused (${code})`, out.ok === false && out.refusal?.code === code, JSON.stringify(out.refusal ?? out).slice(0, 300));
    ok(`${name}: ticket and INDEX unchanged`, read(id) === b && fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8') === idx);
  }
  const d2 = (id, extra, opts) => decideArgs(id, extra, opts); // same argv, through the programmatic entry
  await refuses('one option', openDecision.id, d2(openDecision.id, ['--replace'], OPTS.slice(0, 1)), 'bad-options');
  await refuses('duplicate keys', openDecision.id, d2(openDecision.id, ['--replace'], [OPTS[0], OPTS[1].replace(/^B=/, 'A=')]), 'bad-options');
  await refuses('recommend names no option', openDecision.id,
    ['decide', '--id', openDecision.id, '--question', QUESTION, ...OPTS.flatMap((o) => ['--option', o]), '--recommend', 'Z', '--why', WHY, '--replace'], 'bad-recommend');
  await refuses('recommend without --why', openDecision.id,
    ['decide', '--id', openDecision.id, '--question', QUESTION, ...OPTS.flatMap((o) => ['--option', o]), '--recommend', 'B', '--replace'], 'missing-arg');
  await refuses('option missing its fields', openDecision.id, d2(openDecision.id, ['--replace'], [OPTS[0], 'B=Just a label']), 'bad-options');
  await refuses('question without "?"', openDecision.id,
    ['decide', '--id', openDecision.id, '--question', 'Pick one', ...OPTS.flatMap((o) => ['--option', o]), '--replace'], 'invalid-ticket');
  await refuses('open undecided decision, no --replace (real hand-written one)', openDecision.id, d2(openDecision.id), 'open-decision');
  await refuses('open undecided decision, no --replace (one this tool wrote)', fresh.id, d2(fresh.id), 'open-decision');
  await refuses('author that would forge a user answer', fresh.id, [...d2(fresh.id, ['--replace']).filter((a, i, arr) => !(a === '--author' || arr[i - 1] === '--author')), '--author', 'you (answer via ticket view)'], 'bad-author');
  await refuses('done ticket', doneOne.id, d2(doneOne.id), 'not-applicable');
  await refuses('legacy prose ticket', legacy.id, d2(legacy.id), 'legacy-ticket');
  await refuses('unknown flag', fresh.id, [...d2(fresh.id, ['--replace']), '--mode', 'multi'], 'unknown-flag');

  section('3. truncated (half-written) ticket — another process is mid-write');
  {
    const real = read(openDecision.id);
    const close = real.indexOf('\n```', 4);
    const cuts = [Math.floor(close / 3), Math.floor(close * 0.66), close - 1, close + 2];
    for (const at of cuts) {
      fs.writeFileSync(fileOf(openDecision.id), real.slice(0, at));
      const b = read(openDecision.id);
      const out = await call(...d2(openDecision.id, ['--replace']));
      ok(`truncated at ${at}/${real.length}: refused (${out.refusal?.code}), not written`, out.ok === false && out.refusal?.code === 'unreadable-ticket' && read(openDecision.id) === b, JSON.stringify(out.refusal ?? '').slice(0, 200));
    }
    fs.writeFileSync(fileOf(openDecision.id), real);
  }

  section('4. --replace moves the open decision into decision_history (unchosen)');
  {
    const oldRec = parseTicket(read(openDecision.id), { mode: 'auto' }).record;
    const out = await call(...d2(openDecision.id, ['--replace']));
    ok('replace accepted', out.ok === true, JSON.stringify(out.refusal ?? '').slice(0, 300));
    const nrec = parseTicket(read(openDecision.id), { mode: 'auto' }).record;
    const h = nrec.decision_history.at(-1);
    ok('history gets the old question and keys, chosen null', h && h.question === oldRec.decision.question
      && JSON.stringify(h.options_keys) === JSON.stringify(oldRec.decision.options.map((o) => o.key)) && h.chosen === null, JSON.stringify(h));
    ok('history length grew by exactly one', nrec.decision_history.length === oldRec.decision_history.length + 1);
    ok('new decision parses with recommended B', ticketDecision(read(openDecision.id))?.recommended === 'B');
  }

  section('5. re-decision on a ticket the user answered before (real answered ticket)');
  {
    const b = read(answeredBefore.id);
    const prior = ticketAnswerState(b, fileOf(answeredBefore.id));
    const out = await call(...d2(answeredBefore.id));
    ok('an ANSWERED decision is not "open": no --replace needed', out.ok === true, JSON.stringify(out.refusal ?? '').slice(0, 300));
    const a = read(answeredBefore.id);
    const nrec = parseTicket(a, { mode: 'auto' }).record;
    const h = nrec.decision_history.at(-1);
    if (parseTicket(b, { mode: 'auto' }).record.decision) {
      ok('history records what the user chose', h?.chosen_by === 'you' && h?.chosen_on === prior.on && (h?.chosen ?? null) === (prior.chose?.key ?? null), JSON.stringify(h));
    }
    ok('the old answer no longer masks the new question (ticketAnswerState null)', ticketAnswerState(a, fileOf(answeredBefore.id)) === null, JSON.stringify(ticketAnswerState(a, fileOf(answeredBefore.id))));
    const bd = readBoard(ROOT);
    ok('readBoard(): the new decision is on the needs-you rail, not answered/dropped',
      bd.needsYou.some((i) => i.id === answeredBefore.id && i.question === QUESTION)
      && !bd.answeredAwaiting.some((i) => i.id === answeredBefore.id), JSON.stringify(bd.needsYou.find((i) => i.id === answeredBefore.id) ?? null).slice(0, 200));
    // The user answers the NEW decision through the real reply path.
    answerTicket(ROOT, answeredBefore.id, { kind: 'decision', question: QUESTION, chose: { key: 'C', label: 'Longer timed grant' }, note: '' }, currentRev(fileOf(answeredBefore.id)));
    const st = ticketAnswerState(read(answeredBefore.id), fileOf(answeredBefore.id));
    ok('after the user answers it: answer state is the NEW answer (C), awaiting', st?.chose?.key === 'C' && st?.awaiting === true, JSON.stringify(st));
    ok('readBoard(): answered-awaiting lane (FEAT-090 unchanged)', readBoard(ROOT).answeredAwaiting.some((i) => i.id === answeredBefore.id));
    const again = await call(...d2(answeredBefore.id));
    ok('a decision the user has answered can be superseded without --replace', again.ok === true, JSON.stringify(again.refusal ?? '').slice(0, 200));
    const h2 = parseTicket(read(answeredBefore.id), { mode: 'auto' }).record.decision_history.at(-1);
    ok('…and history records chosen C by you', h2?.chosen === 'C' && h2?.chosen_by === 'you', JSON.stringify(h2));
  }

  section('6. CLI compatibility — the old --flag=value form is unchanged, the documented space form now works');
  {
    const eq = await call('query', `--id=${fresh.id}`, '--include-body');
    const sp = await call('query', '--id', fresh.id, '--include-body');
    ok('query --id=X --include-body ok', eq.ok === true && eq.returned === 1 && typeof eq.tickets[0].markdown === 'string', JSON.stringify(eq.refusal ?? ''));
    ok('query --id X --include-body returns the same', sp.ok === true && JSON.stringify(sp.tickets) === JSON.stringify(eq.tickets));
    const bool = await call('query', '--include-body', '--id', fresh.id);
    ok('a boolean flag does not swallow the next flag', bool.ok === true && bool.returned === 1 && typeof bool.tickets[0].markdown === 'string');
    const stray = await call('query', '--include-body', 'stray');
    ok('a stray positional after a boolean flag is still refused', stray.ok === false && stray.refusal?.code === 'bad-argument');
    const rep = await call('verified', '--id', fresh.id, '--verdict', 'BROKEN', '--verdict', 'HOLDS', '--provider', 'anthropic', '--run', 'x');
    ok('verified still refuses a repeated flag in the space form', rep.ok === false && rep.refusal?.code === 'repeated-flag', JSON.stringify(rep.refusal ?? ''));
    const rq = await call('decide', '--id', fresh.id, '--question', QUESTION, '--question', 'Other?', ...OPTS.flatMap((o) => ['--option', o]), '--replace');
    ok('decide refuses a repeated non-option flag', rq.ok === false && rq.refusal?.code === 'repeated-flag');
  }

  section('7. the real board was never touched');
  {
    const changed = [...realBefore].filter(([f, t]) => {
      try { return fs.readFileSync(path.join(REAL_BOARD, f), 'utf8') !== t; } catch { return true; }
    }).map(([f]) => f);
    const ours = changed.filter((f) => [fresh.id, openDecision.id, answeredBefore.id, doneOne.id, legacy.id].some((id) => f.startsWith(`${id}-`)));
    ok('no real ticket this suite decided on changed on disk', ours.length === 0, ours.join(', '));
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
