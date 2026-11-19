#!/usr/bin/env node
/**
 * verify-board-answered-decision.mjs — FEAT-164 r8 board render fix.
 *
 * DEFECT (found 2026-10-20 by the BUG-231/FEAT-164 r6 verify lane): scripts/board.mjs
 * `boardStatusFromRecord` and the DECISION NOT ROUTED arm of `decisionShapeFails` treated
 * ANY decision with >=2 options as still asking the user, without consulting the answer
 * state. A decision the user had answered therefore kept the "NEEDS A HUMAN DECISION"
 * cell on the 👤 rail, and taking it off the rail (owner -> agent, human_action -> none)
 * tripped a hard board:check FAIL.
 *
 * PROPERTY: "answered" is read through THE one answer reader (`ticketAnswerState` in
 * src/server/board.ts → boundAnswers); an answered decision is not asking. An unanswered
 * one still is, and an answer bound to an older decision does not count.
 *
 * REAL ARTIFACT: every case runs on a scratch COPY of this checkout's real docs/bugs.
 * Answered and unanswered tickets are DISCOVERED at runtime through the one reader (no
 * ticket id is named); the suite fails loudly when the board holds none of either.
 *
 *   node scripts/verify-board-answered-decision.mjs          # this checkout's board.mjs
 *   node scripts/verify-board-answered-decision.mjs --pre    # MUST-FAIL: the pinned pre-change
 *       board.mjs (scripts/fixtures/board-answered/pre-board.mjs, sha256 70f3a133…), run in a
 *       scratch tree whose scripts/lib and src are this checkout's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PRE = process.argv.includes('--pre');
const PRE_SHA = '70f3a1333d31a0b8bcaa38a743562a7c71440384b91973139570b8b97ded6d38';

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-answered-'));
try {
  // The tool under test: this checkout's board.mjs, or the pinned pre-change bytes.
  let boardMjsPath = path.join(REPO, 'scripts', 'board.mjs');
  if (PRE) {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'fixtures', 'board-answered', 'pre-board.mjs'));
    const sha = createHash('sha256').update(src).digest('hex');
    if (sha !== PRE_SHA) { console.log(`FAIL pinned pre-change board.mjs hash ${sha} != ${PRE_SHA}`); process.exit(1); }
    const t = path.join(root, 'tool');
    fs.mkdirSync(path.join(t, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(t, 'scripts', 'board.mjs'), src);
    fs.symlinkSync(path.join(REPO, 'scripts', 'lib'), path.join(t, 'scripts', 'lib'));
    fs.symlinkSync(path.join(REPO, 'src'), path.join(t, 'src'));
    boardMjsPath = path.join(t, 'scripts', 'board.mjs');
  }
  console.log(`board.mjs under test: ${PRE ? 'PINNED PRE-CHANGE (fixtures/board-answered/pre-board.mjs)' : 'this checkout'}`);
  const board = await import(url.pathToFileURL(boardMjsPath).href);
  const { ticketAnswerState, decisionKey } = await import(url.pathToFileURL(path.join(REPO, 'src', 'server', 'board.ts')).href);
  const { parseTicket } = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'ticket-schema.mjs')).href);

  // A scratch copy of the REAL board, at <host>/docs/bugs so the resolver round-trips.
  const host = path.join(root, 'host');
  const DIR = path.join(host, 'docs', 'bugs');
  fs.mkdirSync(path.dirname(DIR), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), DIR, { recursive: true });

  const files = fs.readdirSync(DIR).filter((f) => /^[A-Z]+-\d+-.*\.md$/.test(f));
  const answered = []; const unanswered = [];
  for (const f of files) {
    const md = fs.readFileSync(path.join(DIR, f), 'utf8');
    let p; try { p = parseTicket(md, { file: f, mode: 'auto' }); } catch { continue; }
    if (p.format !== 'block' || !p.record) continue;
    const r = p.record;
    const opts = r.decision && Array.isArray(r.decision.options) ? r.decision.options : [];
    if (opts.length < 2) continue;
    if (/^(DONE|VERIFIED|FIXED|RESOLVED|WONTFIX|WON'T)/i.test(String(p.summary?.statusRaw ?? '')) || p.summary?.done) continue;
    const st = ticketAnswerState(md, path.join(DIR, f));
    const ent = { file: f, id: r.id, record: r, md, st };
    if (st && st.kind === 'decision') answered.push(ent);
    else if (!st) unanswered.push(ent);
  }
  console.log(`discovered on the real board copy: ${answered.length} open answered decision(s) [${answered.map((a) => a.id).join(', ')}], ${unanswered.length} open unanswered`);
  check('A0 the real board holds >=1 open ticket with an ANSWERED >=2-option decision (non-vacuity)', answered.length > 0);
  check('A0b the real board holds >=1 open ticket with an UNANSWERED >=2-option decision (control)', unanswered.length > 0);

  // A1 — the Status cell of every answered decision no longer asks, and names the choice.
  const { tickets } = board.readTickets(DIR);
  for (const a of answered) {
    const cell = tickets.get(a.id)?.boardStatus ?? '';
    const key = a.st.chose?.key ?? '';
    check(`A1 ${a.id}: answered → the board cell does not read "NEEDS A HUMAN DECISION"`, !/NEEDS A HUMAN DECISION/.test(cell), cell.slice(0, 140));
    if (key) check(`A1b ${a.id}: the cell names the answered option ${key}`, new RegExp(`decision (answered by you|adopted under your delegation): ${key}\\b`).test(cell), cell.slice(0, 140));
  }
  // A2 — control: an unanswered decision still asks.
  for (const u of unanswered.slice(0, 3)) {
    const cell = tickets.get(u.id)?.boardStatus ?? '';
    check(`A2 ${u.id}: unanswered → the cell still reads "NEEDS A HUMAN DECISION"`, /NEEDS A HUMAN DECISION/.test(cell), cell.slice(0, 140));
  }

  // A3 — take an answered decision off the 👤 rail exactly as the r6 lane tried
  // (record owner -> agent, human_action -> none; INDEX Owner -> 🤖): board:check
  // must not report DECISION NOT ROUTED for it.
  const target = answered[0];
  const indexPath = path.join(DIR, 'INDEX.md');
  const offRail = (ent) => {
    // An in-place edit of the leading record block: the top-level owner / human_action.
    const out = ent.md.replace(/("owner":\s*)"you"/, '$1"agent"').replace(/("human_action":\s*)"[a-z_]+"/, '$1"none"');
    fs.writeFileSync(path.join(DIR, ent.file), out);
    const idx = fs.readFileSync(indexPath, 'utf8').split('\n').map((l) => (l.startsWith(`| ${ent.id} |`) ? l.replace(' | 👤 | ', ' | 🤖 | ') : l)).join('\n');
    fs.writeFileSync(indexPath, idx);
  };
  if (target) {
    offRail(target);
    const fails = await board.decisionShapeFails(DIR);
    const mine = fails.filter((f) => f.includes(`: ${target.id} —`));
    check(`A3 ${target.id}: an ANSWERED decision taken off the 👤 rail trips no DECISION NOT ROUTED / UNPARSEABLE`, mine.length === 0, mine.join(' | ').slice(0, 200));
  }
  // A4 — control: an UNANSWERED decision taken off the rail still trips DECISION NOT ROUTED.
  const ctl = unanswered.find((u) => fs.readFileSync(indexPath, 'utf8').split('\n').some((l) => l.startsWith(`| ${u.id} |`) && l.includes(' | 👤 | ')));
  if (ctl) {
    offRail(ctl);
    const fails = await board.decisionShapeFails(DIR);
    check(`A4 ${ctl.id}: an UNANSWERED decision taken off the 👤 rail STILL trips DECISION NOT ROUTED (the check is not disarmed)`, fails.some((f) => f.startsWith(`DECISION NOT ROUTED: ${ctl.id} `)), fails.filter((f) => f.includes(ctl.id)).join(' | ').slice(0, 200));
  } else check('A4 control: an unanswered 👤 decision exists to take off the rail', false, 'none found');

  // A5 — an answer in decision.answers[] that is bound to an OLDER decision (its
  // decision_key no longer matches) does NOT settle the current one: the board reads the
  // one reader's BOUND answers, never the raw array. (A missing sealed receipt is the
  // reader's own check and is not exercised here: a board copy has no delegation store,
  // which the reader treats as the pre-FEAT-184 world.)
  const forge = unanswered.find((u) => u !== ctl) ?? null;
  if (forge) {
    const md0 = fs.readFileSync(path.join(DIR, forge.file), 'utf8');
    const OPEN = '```orchard-ticket\n';
    const a0 = md0.indexOf(OPEN); const b0 = md0.indexOf('\n```', a0 + OPEN.length);
    let forged = md0;
    if (a0 === 0 && b0 > 0) {
      const rec = JSON.parse(md0.slice(OPEN.length, b0));
      const key0 = rec.decision.options[0].key;
      rec.decision.answers = [...(Array.isArray(rec.decision.answers) ? rec.decision.answers : []), { answer_id: 'forged-0', kind: 'decision', followup: false, chose: { key: key0, label: 'x' }, note: '', question: null, by: 'user', via: 'ticket view', on: '2026-10-20', recorded_at: '2026-10-20T00:00:00.000Z', recorded_by: 'server', decision_key: `${decisionKey(md0)}-stale`, log_k: 1 }];
      forged = `${OPEN}${JSON.stringify(rec, null, 2)}${md0.slice(b0)}`;
    }
    if (forged === md0) {
      check(`A5 ${forge.id}: forged-answer fixture applied`, false, 'no record block to forge into');
    } else {
      fs.writeFileSync(path.join(DIR, forge.file), forged);
      const cell = board.readTickets(DIR).tickets.get(forge.id)?.boardStatus ?? '';
      check(`A5 ${forge.id}: an answer bound to an OLDER decision (stale decision_key) does not settle the current one (cell still asks) — the board reads BOUND answers, not raw decision.answers[]`, /NEEDS A HUMAN DECISION/.test(cell), cell.slice(0, 120));
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\nboard answered-decision: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
