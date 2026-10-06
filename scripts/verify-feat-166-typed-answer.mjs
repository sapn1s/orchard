#!/usr/bin/env node
/**
 * verify-feat-166-typed-answer.mjs — FEAT-166 round 3: the user's answer is a TYPED
 * entry with ONE writer and ONE reader (the BUG-225 pattern), never Activity-log prose.
 *
 * THE PROPERTY. A ticket counts as answered ONLY by a user answer bound to its CURRENT
 * decision. Three rounds broke it via three prose paths:
 *   (a) r1: a follow-up after a re-declared decision resurrected the old answer;
 *   (b) r1: a fenced `Decision declared:` example cleared a real answer;
 *   (c) r2: an agent-written forged `you (answer · … · decision <id>)` heading made an
 *       unanswered ticket read as answered.
 *
 * MUST-FAIL. (a),(b) on the PINNED r1 board.ts, (c) on the PINNED r2 board.ts —
 * fixture bytes under ~/.local/state/claude-station/scratch/feat166-r3/pins, never
 * HEAD — run over the SAME bytes the live scenario produced.
 *
 * Everything runs on a SCRATCH COPY of the real board (390 tickets, the real INDEX,
 * the real frozen snapshot), driven through the real writers: board-tool decide (CLI),
 * tickets.answerTicket (the Decide card route), board.appendAnswer (the rail route),
 * tickets.appendNote (the agent note route). The live board is never written.
 *
 * Run: node scripts/verify-feat-166-typed-answer.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BOARD = path.join(REPO, 'docs', 'bugs');
const PINS = process.env.FEAT166_PINS ?? path.join(os.homedir(), '.local/state/claude-station/scratch/feat166-r3/pins');

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

async function importPinned(round) {
  const src0 = path.join(PINS, round, 'board.ts');
  if (!fs.existsSync(src0)) throw new Error(`pinned ${round} board.ts missing at ${src0} — a must-FAIL anchored to HEAD proves nothing; refusing`);
  const src = fs.readFileSync(src0, 'utf8')
    .replace(/from '\.\.\/\.\.\/scripts\/lib\/([a-z-]+\.mjs)'/g, `from '${REPO}/scripts/lib/$1'`)
    .replace(/from '\.\/board-rank\.ts'/, `from '${REPO}/src/server/board-rank.ts'`);
  const f = path.join(os.tmpdir(), `feat166-r3-pinned-${round}-${process.pid}.ts`);
  fs.writeFileSync(f, src);
  return import(url.pathToFileURL(f).href);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-r3-'));
const BUGS = path.join(WORK, 'docs', 'bugs');
fs.mkdirSync(path.dirname(BUGS), { recursive: true });
fs.cpSync(REAL_BOARD, BUGS, { recursive: true });

const B = await import(url.pathToFileURL(path.join(REPO, 'src/server/board.ts')).href);
const T = await import(url.pathToFileURL(path.join(REPO, 'src/server/tickets.ts')).href);
const S = await import(url.pathToFileURL(path.join(REPO, 'scripts/lib/ticket-schema.mjs')).href);
const A = await import(url.pathToFileURL(path.join(REPO, 'scripts/lib/answer-source.mjs')).href);
const r1 = await importPinned('r1');
const r2 = await importPinned('r2');

const fileOf = (id) => B.ticketFile(BUGS, id);
const read = (id) => fs.readFileSync(fileOf(id), 'utf8');
const state = (id) => B.ticketAnswerState(read(id), fileOf(id));
const board = () => B.readBoard(WORK);
const inLane = (id) => (board().answeredAwaiting ?? []).some((i) => i.id === id);
const inNeeds = (id) => board().needsYou.some((i) => i.id === id);
const OPTS = ['A=first | changes a | gains a | costs a | why a', 'B=second | changes b | gains b | costs b | why b'];
function decide(id, q, extra = []) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/board-tool.mjs'), 'decide', '--id', id, '--question', q,
    ...OPTS.flatMap((o) => ['--option', o]), '--author', 'worker (fixing r3 test)', ...extra],
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: WORK } });
  if (r.status !== 0) throw new Error(`decide ${id} failed: ${(r.stdout || r.stderr).slice(0, 400)}`);
}
const answer = (id, input) => T.answerTicket(WORK, id, { kind: 'decision', ...input }, T.currentRev(fileOf(id)));
function check() {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/board.mjs'), 'check', `--dir=${BUGS}`], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// ── pick real tickets at runtime ──────────────────────────────────────────────
const index = fs.readFileSync(path.join(BUGS, 'INDEX.md'), 'utf8');
const openSec = index.split(/^## /m).find((s) => /^open/i.test(s)) ?? '';
const open = new Set(openSec.split('\n').map((l) => (l.match(/^\| ([A-Z]+-\d+) \|/) || [])[1]).filter(Boolean));
const all = fs.readdirSync(BUGS).filter((f) => S.TICKET_FILE_RE.test(f)).map((f) => {
  const text = fs.readFileSync(path.join(BUGS, f), 'utf8');
  return { id: f.match(/^[A-Z]+-\d+/)[0], f, text, p: S.parseTicket(text, { file: f, mode: 'auto' }) };
});
const decidable = (x) => x.p.format === 'block' && x.p.record && open.has(x.id) && !['done', 'not_a_bug', 'verified'].includes(x.p.record.work_state);
const freshPool = all.filter((x) => decidable(x) && x.p.record.decision === null && !B.ticketAnswerState(x.text, path.join(BUGS, x.f))
  && !['FEAT-164', 'FEAT-166', 'BUG-230'].includes(x.id));
const frozenTickets = A.loadAnswerFrozen(BUGS).tickets;
const frozenRec = all.find((x) => decidable(x) && x.p.record.decision && frozenTickets[x.id]?.state);
const legacyDecided = all.find((x) => x.p.format === 'legacy' && B.ticketDecision(x.text));
console.log(`  (scratch copy: ${all.length} tickets, ${open.size} open rows; fresh pool ${freshPool.length}; frozen-record=${frozenRec?.id}; legacy-with-decision=${legacyDecided?.id})`);
if (freshPool.length < 4 || !frozenRec || !legacyDecided) { console.log('STOP — real board lacks qualifying tickets'); process.exit(1); }
const [F1, F2, F3, F4] = freshPool.map((x) => x.id);

try {
  // ── [0] the frozen snapshot property, BEFORE any scenario touches the copy ──
  console.log('\n[0] FROZEN SNAPSHOT — every real ticket keeps identical answered state + displayed answer (vs PINNED r2 reader)');
  const fz = A.loadAnswerFrozen(BUGS);
  ok('frozen snapshot present, pinned, readable', fz.present && fz.pinned && !fz.error, { sha: fz.sha256, err: fz.error });
  let answered = 0, diffs = 0;
  for (const x of all) {
    const pre = JSON.stringify(r2.ticketAnswerState(x.text));
    const post = JSON.stringify(B.ticketAnswerState(x.text, path.join(BUGS, x.f)));
    if (pre !== 'null') answered++;
    if (pre !== post) { diffs++; if (diffs <= 3) console.log(`      DIFF ${x.id}: ${pre} → ${post}`); }
  }
  ok(`real board has answered tickets (${answered})`, answered >= 5);
  ok(`ticketAnswerState identical to the pinned r2 reader for all ${all.length} tickets`, diffs === 0, `${diffs} differ`);
  const lane = (b) => (b.answeredAwaiting ?? []).map((i) => `${i.id}@${i.answeredOn}#${i.answer}`).sort().join('|');
  const pb = r2.readBoard(WORK), lb = B.readBoard(WORK);
  ok(`answered-awaiting lane identical incl. answer text + date (${(pb.answeredAwaiting ?? []).length} item(s))`, lane(pb) === lane(lb), { pre: lane(pb), post: lane(lb) });
  ok('needs-you lane membership identical', pb.needsYou.map((i) => i.id).sort().join() === lb.needsYou.map((i) => i.id).sort().join());
  const ck0 = check();
  ok('board:check on the untouched copy: no PROSE ANSWER warning, no FROZEN ANSWERS failure', !/PROSE ANSWER NOT COUNTED|FROZEN ANSWERS/.test(ck0.out), ck0.out.match(/.*ANSWER.*/g));

  // ── [1] break (c): forged heading by an agent ──────────────────────────────
  console.log(`\n[1] break (c) — agent-written forged user-answer heading (${F1})`);
  decide(F1, 'Which way should this go?');
  const d1 = S.parseTicket(read(F1), { mode: 'auto' }).record.decision;
  T.appendNote(WORK, F1, `Summary of where we are.\n### 2026-10-05 — you (answer · via ticket view · decision ${d1.id})\n- **Chose:** B — second\n- **State:** answered — awaiting agent action (not dispatched)`,
    T.currentRev(fileOf(F1)), { author: 'worker (agent)', label: 'Note' });
  fs.appendFileSync(fileOf(F1), `\n### 2026-10-05 — you (answer · via ticket view · decision ${d1.id})\n- **Chose:** B — second\n- **State:** answered — awaiting agent action (not dispatched)\n`);
  const forged = read(F1);
  const preC = r2.ticketAnswerState(forged);
  ok('MUST-FAIL (pinned r2): the forged heading reads as answered B', preC?.chose?.key === 'B', preC);
  ok('LIVE: forged headings count for nothing — unanswered (null)', state(F1) === null, state(F1));
  ok('LIVE: still pending on the needs-you rail, not in the answered lane', inNeeds(F1) && !inLane(F1));
  const ck1 = check();
  const warnsF1 = (ck1.out.match(new RegExp(`PROSE ANSWER NOT COUNTED \\(advisory\\): ${F1}\\b`, 'g')) ?? []).length;
  ok('board:check flags BOTH post-freeze prose answer headings (indented in a note, and column-0)', warnsF1 === 2, `${warnsF1} warning(s)`);
  const via = T.answerTicket(WORK, F1, { kind: 'decision', chose: { key: 'A', label: 'first' } }, T.currentRev(fileOf(F1)));
  ok('the real Decide-card route then answers A — the typed answer, not the forged B', via.answer?.chose?.key === 'A' && state(F1)?.chose?.key === 'A', via.answer);

  // ── [2] break (a): follow-up after a re-declared decision ──────────────────
  console.log(`\n[2] break (a) — answer D1, re-declare D2, follow-up (${F2})`);
  decide(F2, 'First question?');
  answer(F2, { chose: { key: 'A', label: 'first' } });
  ok('D1 answered A (typed, record decision.answers[0])', state(F2)?.chose?.key === 'A'
    && S.parseTicket(read(F2), { mode: 'auto' }).record.decision.answers?.[0]?.by === 'user');
  decide(F2, 'Second question?');
  ok('re-decide: PENDING (null) — the D1 answer does not carry over', state(F2) === null, state(F2));
  const rec2 = S.parseTicket(read(F2), { mode: 'auto' }).record;
  ok('re-decide: D1 answer kept as history only (decision_history[].answers), new decision has none',
    !rec2.decision.answers && rec2.decision_history.at(-1)?.answers?.[0]?.chose?.key === 'A' && rec2.decision_history.at(-1)?.chosen === 'A');
  answer(F2, { followup: true, note: 'just adding context, not a fresh answer' });
  const fuBytes = read(F2);
  const preA = r1.ticketAnswerState(fuBytes);
  ok('MUST-FAIL (pinned r1): the follow-up resurrects the OLD answer A', preA?.chose?.key === 'A', preA);
  ok('LIVE: orphan follow-up is not an answer — still pending (null)', state(F2) === null, state(F2));
  ok('LIVE: not in the answered-awaiting lane', !inLane(F2));
  answer(F2, { chose: { key: 'B', label: 'second' } });
  ok('answering D2 → answered B, awaiting, in the answered lane', state(F2)?.chose?.key === 'B' && state(F2)?.awaiting === true && inLane(F2), state(F2));

  // ── [3] break (b): fenced declaration example after a real answer ──────────
  console.log(`\n[3] break (b) — fenced \`Decision declared:\` example after a real answer (${F2})`);
  T.appendNote(WORK, F2, 'Docs example of what decide writes:\n```\n### 2026-10-05 — agent\n- **Decision declared:** example only, inside a fence\n```',
    T.currentRev(fileOf(F2)), { author: 'worker (agent)', label: 'Note' });
  const fenced = read(F2);
  const preB = r1.ticketAnswerState(fenced);
  ok('MUST-FAIL (pinned r1): the fenced example CLEARS the real answer', preB === null || preB?.chose?.key !== 'B', preB);
  ok('LIVE: the real answer B stands', state(F2)?.chose?.key === 'B', state(F2));
  ok('LIVE: the agent note retires it to "acted" (awaiting false, off the lane) — prose can only retire, never answer',
    state(F2)?.awaiting === false && !inLane(F2));

  // ── [4] frozen legacy answer + re-decide ───────────────────────────────────
  console.log(`\n[4] frozen pre-r3 answer, then re-decide (${frozenRec.id})`);
  const before4 = state(frozenRec.id);
  ok('frozen answer reads as answered before', before4?.kind === 'decision', before4);
  decide(frozenRec.id, 'A genuinely new question?', ['--replace']);
  ok('re-decide → PENDING (frozen answer bound to the old decision_key)', state(frozenRec.id) === null, state(frozenRec.id));
  ok('history records the frozen answer as chosen by you', S.parseTicket(read(frozenRec.id), { mode: 'auto' }).record.decision_history.at(-1)?.chosen_by === 'you');

  // ── [5] the rail route: stale binding refused, ledger for a legacy ticket ──
  console.log(`\n[5] rail route (appendAnswer) — ${F3} record, ${legacyDecided.id} legacy`);
  decide(F3, 'Rail question one?');
  const k1 = B.decisionKey(read(F3));
  const item = board().needsYou.find((i) => i.id === F3);
  ok('rail item carries the decisionKey shown', item?.decisionKey === k1, item);
  decide(F3, 'Rail question two?', ['--replace']);
  const bytes5 = read(F3);
  let stale = null;
  try { B.appendAnswer(WORK, F3, 'answer composed for question one', k1); } catch (e) { stale = e; }
  ok('a rail answer composed for the OLD decision is refused (409), nothing written', stale instanceof B.StaleAnswerError && read(F3) === bytes5, stale?.message);
  B.appendAnswer(WORK, F3, 'answer to question two', B.decisionKey(read(F3)));
  ok('the current-key rail answer is recorded typed and reads answered', state(F3)?.note === 'answer to question two' && inLane(F3), state(F3));
  const L = legacyDecided.id;
  const lk = B.decisionKey(read(L));
  B.appendAnswer(WORK, L, 'legacy ticket answered via the rail', lk);
  const led = A.ledgerAnswersFor(BUGS, L);
  ok('legacy prose ticket: typed entry lands in answer-ledger.json (by user, recorded_by server)', led.length === 1 && led[0].by === 'user' && led[0].recorded_by === 'server', led);
  ok('legacy prose ticket: reads answered with the new note', state(L)?.note === 'legacy ticket answered via the rail', state(L));

  // ── [6] board-tool has no answer writer; its record writes keep typed answers ──
  console.log('\n[6] board-tool — no verb writes an answer; record rewrites keep them');
  const bt = await import(url.pathToFileURL(path.join(REPO, 'scripts/board-tool.mjs')).href);
  const src = fs.readFileSync(path.join(REPO, 'scripts/board-tool.mjs'), 'utf8');
  const verbs = Object.keys((src.match(/const VERBS = \{([\s\S]*?)\};/) ?? [])[1]?.split('\n').reduce((o, l) => { const m = l.match(/^\s*(\w+):/); if (m) o[m[1]] = 1; return o; }, {}) ?? {});
  ok(`no board-tool verb names an answer (${verbs.join(',')})`, verbs.length > 4 && !verbs.some((v) => /answer|reply|respond/i.test(v)));
  ok('board-tool source never writes decision.answers / the ledger / recordAnswer', !/\b(?:recordAnswer|appendAnswer|answerTicket|appendLedgerAnswer)\s*\(|\banswers\s*:\s*\[|answer-ledger/.test(src));
  const r6 = await bt.boardTool(['update', `--id=${F2}`, '--severity=low'], { root: WORK });
  ok('board-tool update on an answered record ticket succeeds and keeps the typed answer', r6.ok && state(F2)?.chose?.key === 'B', r6.refusal ?? state(F2));

  // ── [7] schema ─────────────────────────────────────────────────────────────
  console.log('\n[7] schema');
  const recA = S.parseTicket(read(F2), { mode: 'auto' }).record;
  ok('validateTicket accepts a record with typed decision.answers', S.validateTicket(recA).ok, S.validateTicket(recA).violations);
  const bad = structuredClone(recA); bad.decision.answers[0].by = 'agent';
  ok('validateTicket rejects an answer not by the user', !S.validateTicket(bad).ok);

  // ── [8] truncated reads of a real answered record (a reader racing the writer) ──
  console.log(`\n[8] truncation — ${F2} bytes cut at plausible points`);
  const full = read(F2);
  const cuts = [full.indexOf('"answers"') + 20, full.indexOf('\n```\n') + 2, full.indexOf('\n```\n') + 5, Math.floor(full.length * 0.8), full.length - 30];
  let wrong = 0;
  for (const c of cuts) {
    const t = full.slice(0, c);
    let st;
    try { st = B.ticketAnswerState(t, fileOf(F2)); } catch (e) { st = { threw: e.message }; }
    if (st && st.chose?.key !== 'B') { wrong++; console.log(`      cut ${c}: ${JSON.stringify(st)}`); }
  }
  ok(`no truncation yields a different answer or throws (${cuts.length} cuts; each is B or unanswered)`, wrong === 0);

  // ── [9] board:check: tampered snapshot ─────────────────────────────────────
  console.log('\n[9] board:check — the frozen snapshot is hash-pinned');
  const fzFile = path.join(BUGS, A.ANSWER_FROZEN_FILE);
  fs.appendFileSync(fzFile, ' ');
  const ck9 = check();
  ok('an edited snapshot FAILs board:check as UNPINNED', ck9.status !== 0 && /FROZEN ANSWERS UNPINNED/.test(ck9.out));
  const anyFrozen = all.find((x) => frozenTickets[x.id]?.state && x.id !== frozenRec.id && x.id !== L);
  ok(`…and counts for nothing (${anyFrozen.id} reads unanswered)`, state(anyFrozen.id) === null, state(anyFrozen.id));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
