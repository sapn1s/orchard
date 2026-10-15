#!/usr/bin/env node
/**
 * verify-bug-263-withdraw.mjs — BUG-263: `board-tool withdraw` is the honest take-
 * back for a Decide card an agent filed as the USER's (a hard-stop card, which
 * `own` refuses) that was actually the agent's own call, already made and built.
 * It records the agent's decision as a typed owned-decision entry (never a user
 * answer), closes the card from the Decide rail, and leaves the user a one-click
 * reopen that restores the card intact.
 *
 * Every case runs against a SCRATCH COPY OF THE REAL BOARD (docs/bugs of this
 * checkout, copied fresh per run), through the real CLI and the real readers
 * (ticketAnswerState, readBoard, board:check, boardStatusFromRecord). The hard-
 * stop card it withdraws is the REAL open card on the board: FEAT-190's P3
 * keep-vs-force-migrate decision (stop: git). The answered cards it refuses are
 * the real answered cards (FEAT-164/FEAT-170/BUG-240). The live board is never
 * written.
 *
 * BUG263_TOOL_ROOT=<a code tree> runs the suite against another tree — that is how
 * the must-FAIL run points it at a PRE-CHANGE snapshot (no `withdraw` verb): every
 * [W*] case then fails with unknown-verb, proving the capability is new.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.resolve(process.env.BUG263_TOOL_ROOT || REPO);
const imp = (rel) => import(url.pathToFileURL(path.join(TOOL, rel)).href);

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const safe = async (name, fn) => { try { await fn(); } catch (err) { check(name, false, `threw: ${String(err?.message ?? err).split('\n')[0]}`); } };

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug263-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(root, 'docs', 'bugs'), { recursive: true });
  return root;
}

function tool(...args) {
  const r = spawnSync(process.execPath, [path.join(TOOL, 'scripts', 'board-tool.mjs'), ...args], {
    env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: ROOT }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, refusal: { code: 'unparseable', message: (r.stdout + r.stderr).slice(0, 400) } }; }
}

const ROOT = scratch();
const BOARD = path.join(ROOT, 'docs', 'bugs');
// Isolate the FEAT-184 delegation/answer store to a scratch data dir so nothing
// touches the real one, and so W4 can migrate a store to exercise board:check's
// real UNAUTHENTICATED USER ANSWER rule without any real-state dependency.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug263-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
const fileOf = (id) => path.join(BOARD, fs.readdirSync(BOARD).find((f) => f.startsWith(`${id}-`)));
const read = (id) => fs.readFileSync(fileOf(id), 'utf8');
const indexRow = (id) => fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8').split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';

// Readers from the REPO under test (the current tree), used to GRADE outcomes.
const schema = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'ticket-schema.mjs')).href);
const owned = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'owned-decision.mjs')).href);
const boardMjs = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'board.mjs')).href);
const DS = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'delegation-source.mjs')).href);
const recordOf = (id) => schema.parseTicket(read(id), { file: path.basename(fileOf(id)), mode: 'auto' }).record;
let boardTs = null;
try { boardTs = await imp('src/server/board.ts'); } catch (e) { console.log('  (board.ts unavailable: ' + e.message.split('\n')[0] + ')'); }
const answerState = (id) => boardTs.ticketAnswerState(read(id), path.basename(fileOf(id)));
const rail = () => boardTs.readBoard(ROOT).needsYou.map((i) => i.id);

const NEEDS_YOU = '\u{1F464}';
console.log(`BUG-263 — withdraw a mis-filed hard-stop card (tool tree: ${TOOL}; scratch board: ${ROOT})`);

const RSN = '--reason=User direction: the agent already built this; neither option matches what shipped.';
const DEC = '--decided=Legacy blank-scope grants are READ as granted (scoped), never release; release mode only from the explicit opt-in.';
const AUTH = '--author=orchestrator';

// board:check fails BEFORE any of our writes — the anti-regression baseline. The
// scratch board is a copy of the real one and may carry pre-existing advisory
// fails (e.g. an orphan INDEX row); withdraw must add NO NEW fail, not make an
// already-imperfect board perfect.
const baselineFails = new Set((tool('check').board?.fails ?? []));

// Declare a FRESH hard-stop card on a scratch ticket for the success path, so the
// suite does not depend on any particular ticket still carrying an open card on
// the live board (FEAT-190's P3 card is withdrawn once this fix ships — "verify
// the user's reality"). CARD is a real open ticket with no decision of its own.
const CARD = 'BUG-030';
const DECLARE = ['decide', `--id=${CARD}`, '--question=Legacy blank-scope grants: keep r1 migration-safety or force-migrate?',
  '--option=keep=Keep r1 migration | legacy record keeps its mode | no data rewrite | P3 not literally met for old records | leaves a known gap',
  '--option=fixnow=Force-migrate | one-time rewrite+reseal | P3 holds everywhere | silently changes real grants | reverses a settled call',
  '--decider=git', '--consequence=force-migrating rewrites existing sealed git-write grants and changes what the grants currently allow',
  '--recommend=keep', '--why=r1 settled it; preserving release behaviour is the only safe map', '--author=worker (BUG-263 verify)'];
const decl = tool(...DECLARE);
const DECL_DECISION = recordOf(CARD).decision;
console.log(`  fresh ${CARD} card: stop=${DECL_DECISION?.stop}; options=${(DECL_DECISION?.options ?? []).map((o) => o.key).join('/')}; declared.ok=${decl.ok}`);

/* ── [W1] withdraw an unanswered hard-stop card: card closed, agent decision recorded, NO user answer ── */
console.log(`\n[W1] withdraw a fresh stop=git card (${CARD})`);
await safe('W1 withdraw succeeds on the hard-stop card', () => {
  const r = tool('withdraw', `--id=${CARD}`, RSN, DEC, AUTH);
  check('W1 withdraw succeeds on the hard-stop card', r.ok && r.verb === 'withdraw', JSON.stringify(r.refusal ?? '').slice(0, 200));
});
await safe('W1a decision is now closed (record.decision === null)', () => {
  check('W1a decision is now closed (record.decision === null)', recordOf(CARD).decision === null);
});
await safe('W1b a typed agent-decision entry is recorded (chosen_by agent, basis withdrawn, snapshot kept)', () => {
  const h = recordOf(CARD).decision_history.slice(-1)[0];
  const ok = h && h.chosen_by === 'agent' && h.owned && h.owned.basis === 'withdrawn'
    && h.owned.by === 'orchestrator' && /already built/.test(h.owned.why) && /READ as granted/.test(h.owned.decided)
    && h.snapshot && h.snapshot.stop === 'git' && Array.isArray(h.snapshot.options) && h.snapshot.options.length === DECL_DECISION.options.length;
  check('W1b a typed agent-decision entry is recorded (chosen_by agent, basis withdrawn, snapshot kept)', ok, JSON.stringify(h?.owned ?? h).slice(0, 220));
});
await safe('W1c NO user answer was created (ticketAnswerState stays null)', () => {
  check('W1c NO user answer was created (ticketAnswerState stays null)', answerState(CARD) === null, JSON.stringify(answerState(CARD)));
});
await safe('W1d the card left the Decide rail (Owner off 👤, not in needsYou)', () => {
  const offRail = !indexRow(CARD).includes(NEEDS_YOU) && !rail().includes(CARD);
  check('W1d the card left the Decide rail (Owner off 👤, not in needsYou)', offRail, `row=${indexRow(CARD).trim().slice(0, 80)}`);
});
await safe('W1e board:status no longer reads "NEEDS A HUMAN DECISION"', () => {
  const cell = boardMjs.boardStatusFromRecord(recordOf(CARD));
  check('W1e board:status no longer reads "NEEDS A HUMAN DECISION"', !/NEEDS A HUMAN DECISION/.test(cell), cell.slice(0, 120));
});
await safe('W1f board:check gains NO new fail from the withdrawal', () => {
  const now = (tool('check').board?.fails ?? []);
  const added = now.filter((f) => !baselineFails.has(f));
  check('W1f board:check gains NO new fail from the withdrawal', added.length === 0, JSON.stringify(added).slice(0, 240));
});
await safe('W1g the REAL FEAT-190 P3 card reads as withdrawn by the agent (real artifact)', () => {
  // FEAT-190 was withdrawn on the live board by this fix; the scratch copy carries
  // that real state. Assert it reads as the agent's, not the user's, with no answer.
  const rec = recordOf('FEAT-190');
  const h = (rec.decision_history ?? []).filter((e) => e?.owned?.basis === 'withdrawn').slice(-1)[0];
  const ok = rec.decision === null && h && h.owned.by === 'orchestrator' && answerState('FEAT-190') === null;
  check('W1g the REAL FEAT-190 P3 card reads as withdrawn by the agent (real artifact)', ok, JSON.stringify({ dec: rec.decision, by: h?.owned?.by }).slice(0, 160));
});

/* ── [W2] reopen restores the card intact ── */
console.log('\n[W2] the user can reopen it — the card comes back intact');
await safe('W2 reopenRecord restores the withdrawn decision from its snapshot', () => {
  const rec = recordOf(CARD);
  const h = rec.decision_history.slice(-1)[0];
  const out = owned.reopenRecord(rec, h.id, { today: '2026-10-15' });
  const d = out.record?.decision;
  const ok = !out.refusal && d && d.stop === 'git' && d.question === DECL_DECISION.question
    && d.reopened_from === h.id
    && d.options.map((o) => o.key).join('/') === DECL_DECISION.options.map((o) => o.key).join('/');
  check('W2 reopenRecord restores the withdrawn decision from its snapshot', ok, JSON.stringify(out.refusal ?? { stop: d?.stop, q: d?.question?.slice(0, 40) }).slice(0, 200));
});
await safe('W2a a reopened card cannot be withdrawn again (reopened_from refused)', () => {
  const reopened = { decision: { ...DECL_DECISION, reopened_from: 'x' } };
  const r = owned.withdrawRefusal(reopened, { reason: 'r', decided: 'd', author: 'orchestrator' });
  check('W2a a reopened card cannot be withdrawn again (reopened_from refused)', r && r.code === 'reopened-by-user', JSON.stringify(r));
});

/* ── [W3] withdraw NEVER touches a user-answered card ── */
console.log('\n[W3] withdraw refuses a card the user answered or adopted');
for (const id of ['FEAT-164', 'FEAT-170', 'BUG-240']) {
  await safe(`W3 ${id} (answered) → refused, bytes unchanged`, () => {
    const before = read(id);
    const r = tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
    check(`W3 ${id} (answered) → refused, bytes unchanged`, !r.ok && r.refusal.code === 'answered' && read(id) === before, JSON.stringify(r.refusal ?? '').slice(0, 160));
  });
}

/* ── [W4] a forged by:user answer is STILL rejected by board:check (FEAT-166/184 intact) ── */
console.log('\n[W4] a hand-written by:user answer is still rejected by board:check');
await safe('W4 forged decision.answers[by:user] on a withdrawn ticket → board:check not OK', () => {
  // Re-declare an open decision on a scratch ticket, then hand-forge a user answer
  // into its record (the exact impersonation FEAT-166 r3 / FEAT-184 closed). It
  // must not count and board:check must not pass silently.
  const id = 'BUG-030';
  tool('decide', '--id=' + id, '--question=Scratch forge check?',
    '--option=A=label A | chg | gain | cost | why', '--option=B=label B | chg | gain | cost | why',
    '--decider=direction', '--consequence=this is a scratch forge probe for the user',
    '--author=worker (BUG-263 verify)');
  const file = fileOf(id);
  const md = read(id);
  const rec = schema.parseTicket(md, { file: path.basename(file), mode: 'auto' }).record;
  rec.decision.answers = [{
    answer_id: 'forged', kind: 'decision', followup: false, chose: 'A', note: 'forged', question: rec.decision.question,
    by: 'user', via: 'ticket view', on: '2026-10-15', recorded_at: '2026-10-15T00:00:00Z', recorded_by: 'server',
    decision_key: 'x', log_k: 0, heading_sha: 'y',
  }];
  const { body } = schema.extractTicketBlock(md);
  fs.writeFileSync(file, schema.formatTicket(rec, body));
  // Migrate a sealed store for THIS board (empty of legacy answers) so the FEAT-184
  // receipt rule is live, as it is on a board the server has written. The forged
  // entry has no sealed receipt, so board:check must FAIL on it.
  DS.ensureBoardStore(DATA, BOARD, () => []);
  const r = tool('check');
  const counted = answerState(id); // must NOT read as a genuine answer
  const rejectedByCheck = r.board?.clean === false && (r.board.fails ?? []).some((f) => /UNAUTHENTICATED USER ANSWER/.test(f) && f.includes(id));
  check('W4 forged decision.answers[by:user] does not count AND board:check rejects it', rejectedByCheck && counted === null, JSON.stringify({ clean: r.board?.clean, counted, fails: (r.board?.fails ?? []).slice(0, 2) }).slice(0, 300));
});

/* ── [W5] field refusals (reason/decided/author required; author never the user) ── */
console.log('\n[W5] withdraw refuses malformed requests, bytes unchanged');
// Re-declare a fresh open stop card to test field refusals against.
tool('decide', '--id=BUG-048', '--question=Scratch field-refusal probe?',
  '--option=A=label A | chg | gain | cost | why', '--option=B=label B | chg | gain | cost | why',
  '--decider=live', '--consequence=restarting ends your running sessions', '--author=worker (BUG-263 verify)');
for (const [name, args, code] of [
  ['W5a no --reason', ['--id=BUG-048', DEC, AUTH], 'missing-arg'],
  ['W5b no --decided', ['--id=BUG-048', RSN, AUTH], 'missing-arg'],
  ['W5c no --author', ['--id=BUG-048', RSN, DEC], 'missing-arg'],
  ['W5d author reads as the user', ['--id=BUG-048', RSN, DEC, '--author=you'], 'bad-author'],
]) {
  await safe(name, () => {
    const before = read('BUG-048');
    const r = tool('withdraw', ...args);
    check(name, !r.ok && r.refusal.code === code && read('BUG-048') === before, JSON.stringify(r.refusal ?? '').slice(0, 160));
  });
}
await safe('W5e withdraw on a ticket with no open decision → refused', () => {
  const r = tool('withdraw', '--id=BUG-004', RSN, DEC, AUTH);
  check('W5e withdraw on a ticket with no open decision → refused', !r.ok && ['no-open-decision', 'legacy-ticket'].includes(r.refusal.code), JSON.stringify(r.refusal ?? '').slice(0, 160));
});

/* ── [W6] a user-reopened card cannot be laundered back via decide --replace ── */
console.log('\n[W6] reopen-launder: decide --replace on a reopened card does not strip the reopen');
await safe('W6 withdraw is refused after the user reopens, even after decide --replace', async () => {
  const id = 'BUG-115';
  // 1) declare a stop card, 2) agent withdraws it, 3) USER reopens (server route,
  // user-only), 4) agent re-asks with decide --replace (same stop), 5) withdraw
  // again → must be refused, the reopened card left intact.
  tool('decide', `--id=${id}`, '--question=Launder probe: keep or force-migrate?',
    '--option=keep=Keep | a | b | c | d', '--option=fixnow=Force | a | b | c | d',
    '--decider=git', '--consequence=rewrites existing sealed git-write grants for this probe',
    '--author=worker (BUG-263 verify)');
  tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
  const hid = recordOf(id).decision_history.slice(-1)[0].id;
  const ownedTs = await imp('src/server/owned-decisions.ts');
  ownedTs.reopenOwnedDecision(ROOT, id, hid, undefined, 'I want to decide this');
  const reopenedHasFrom = !!recordOf(id).decision?.reopened_from;
  const rep = tool('decide', `--id=${id}`, '--question=Launder probe v2: keep or force-migrate?',
    '--option=keep=Keep | a | b | c | d', '--option=fixnow=Force | a | b | c | d',
    '--decider=git', '--consequence=rewrites existing sealed git-write grants for this probe', '--replace',
    '--author=worker (BUG-263 verify)');
  const stillReopened = !!recordOf(id).decision?.reopened_from; // the fix: carried across --replace
  const before = read(id);
  const w2 = tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
  const refused = !w2.ok && w2.refusal.code === 'reopened-by-user' && read(id) === before;
  check('W6 withdraw is refused after the user reopens, even after decide --replace',
    reopenedHasFrom && rep.ok && stillReopened && refused,
    JSON.stringify({ reopenedHasFrom, replaceOk: rep.ok, stillReopened, w2: w2.refusal ?? 'SUCCEEDED (launder!)' }).slice(0, 240));
});

/* ── [W7] fail-closed: a user answer in the record blocks withdraw even if unverifiable ── */
console.log('\n[W7] withdraw fails CLOSED on a user answer whose seal cannot be verified');
await safe('W7 a by:user answer in decision.answers blocks withdraw (ticketAnswerState null, no sealed receipt)', () => {
  // Declare a fresh stop card, then hand-write a by:user answer into decision.answers
  // with NO sealed receipt (the damaged/unreadable-store reality: ticketAnswerState
  // returns null, so a guard that trusted only it would proceed and erase the answer).
  const id = 'BUG-140';
  tool('decide', `--id=${id}`, '--question=Fail-closed probe: keep or force?',
    '--option=keep=Keep | a | b | c | d', '--option=fixnow=Force | a | b | c | d',
    '--decider=git', '--consequence=rewrites existing sealed git-write grants for this probe', '--author=worker (BUG-263 verify)');
  const file = fileOf(id);
  const rec = schema.parseTicket(read(id), { file: path.basename(file), mode: 'auto' }).record;
  rec.decision.answers = [{
    answer_id: 'unsealed-user', kind: 'decision', followup: false, chose: 'fixnow', note: 'I, the user, choose force',
    question: rec.decision.question, by: 'user', via: 'ticket view', on: '2026-10-15',
    recorded_at: '2026-10-15T00:00:00Z', recorded_by: 'server', decision_key: 'x', log_k: 0, heading_sha: 'y',
  }];
  const { body } = schema.extractTicketBlock(read(id));
  fs.writeFileSync(file, schema.formatTicket(rec, body));
  const unverifiable = answerState(id) === null; // the dangerous precondition: not counted → fails open
  const before = read(id);
  const r = tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
  const refused = !r.ok && r.refusal.code === 'answered' && read(id) === before;
  check('W7 a by:user answer in decision.answers blocks withdraw (ticketAnswerState null, no sealed receipt)',
    unverifiable && refused, JSON.stringify({ unverifiable, refusal: r.refusal ?? 'SUCCEEDED (erased the answer!)' }).slice(0, 220));
});

/* ── [W8] fail-closed on a legacy frozen answer whose pinned snapshot is tampered ── */
console.log('\n[W8] withdraw fails CLOSED on a legacy frozen answer when the snapshot is unpinned');
await safe('W8 FEAT-023 (answered via frozen snapshot) stays un-withdrawable when the snapshot is tampered', () => {
  // FEAT-023 is answered via the pinned pre-r3 frozen snapshot (real artifact). Its
  // answer lives in NEITHER decision.answers[] NOR a sealed store — only the frozen
  // file + its Activity-log `you (answer …)` heading. Tamper the snapshot (unpin it):
  // ticketAnswerState then falls to null, but the heading guard must still refuse.
  const id = 'FEAT-023';
  // Confirm FEAT-023 really carries a legacy user-answer heading (its only on-ticket
  // trace of the frozen answer) — the real artifact this guard must honour.
  const hasYouHeading = /\n### \d{4}-\d\d-\d\d — you \(answer/.test(read(id));
  const frozen = path.join(BOARD, 'answers-legacy.frozen.json');
  fs.appendFileSync(frozen, '\n'); // one byte → sha no longer matches ANSWER_FROZEN_PINS
  const nowNull = answerState(id) === null; // the dangerous precondition: ticketAnswerState fails open
  const before = read(id);
  const r = tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
  const refused = !r.ok && r.refusal.code === 'answered' && read(id) === before;
  check('W8 FEAT-023 (answered via frozen snapshot) stays un-withdrawable when the snapshot is tampered',
    hasYouHeading && nowNull && refused,
    JSON.stringify({ hasYouHeading, nowNull, refusal: r.refusal ?? 'SUCCEEDED (erased a frozen answer!)' }).slice(0, 220));
});

/* ── [W9] withdraw must not resurrect a stale legacy answer via decision:null ── */
console.log('\n[W9] withdraw refuses a ticket whose decision:null would re-bind a frozen legacy answer');
await safe('W9 declare+withdraw on ARCH-010 (has a pre-r3 frozen you-answer) is refused, no resurrection', () => {
  // ARCH-010 is a record ticket with no current decision but a pre-r3 frozen user
  // answer (keyed `none`) and an id-less `you (answer)` heading. Declaring a NEW
  // decision then withdrawing it would set decision:null and re-bind that 2026-08
  // answer — masking the withdrawal and misstating state. withdraw must refuse.
  const id = 'ARCH-010';
  const hasLegacyHeading = /\n### \d{4}-\d\d-\d\d — you \(answer/.test(read(id));
  tool('decide', `--id=${id}`, '--question=Resurrection probe: keep or force?',
    '--option=keep=Keep | a | b | c | d', '--option=fixnow=Force | a | b | c | d',
    '--decider=git', '--consequence=rewrites existing sealed git-write grants for this probe', '--author=worker (BUG-263 verify)');
  const beforeWithdraw = answerState(id); // new decision open → should be null (not the stale answer)
  const before = read(id);
  const r = tool('withdraw', `--id=${id}`, RSN, DEC, AUTH);
  const refused = !r.ok && r.refusal.code === 'answered' && read(id) === before;
  check('W9 declare+withdraw on ARCH-010 (has a pre-r3 frozen you-answer) is refused, no resurrection',
    hasLegacyHeading && beforeWithdraw === null && refused,
    JSON.stringify({ hasLegacyHeading, beforeWithdraw, refusal: r.refusal ?? 'SUCCEEDED (resurrected stale answer!)' }).slice(0, 220));
});

/* ── summary ── */
console.log(`\nBUG-263 withdraw: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
