#!/usr/bin/env node
/**
 * verify-bug-259-decide-gate-own.mjs — BUG-259: a decision card needs a hard stop
 * (the SAME closed list as the turn-end ask check), and an agent records its own
 * call with `board-tool own` — as the agent's, never as the user's answer — which
 * the user can reopen.
 *
 * Every case runs against a SCRATCH COPY OF THE REAL BOARD (docs/bugs of this
 * checkout, copied fresh per run), through the real CLI and the real readers
 * (readBoard, ticketAnswerState, board:check). The cards it owns are the real
 * agent-owned cards from the 2026-10-14 triage.
 *
 * BUG259_TOOL_ROOT=<a code tree> runs the suite against another tree — that is how
 * the must-FAIL run points it at the pre-change snapshot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.resolve(process.env.BUG259_TOOL_ROOT || REPO);
const imp = (rel) => import(url.pathToFileURL(path.join(TOOL, rel)).href);

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const safe = async (name, fn) => { try { await fn(); } catch (err) { check(name, false, `threw: ${String(err?.message ?? err).split('\n')[0]}`); } };

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug259-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(root, 'docs', 'bugs'), { recursive: true });
  return root;
}
const ROOT = scratch();
const BOARD = path.join(ROOT, 'docs', 'bugs');

function tool(...args) {
  const r = spawnSync(process.execPath, [path.join(TOOL, 'scripts', 'board-tool.mjs'), ...args], {
    env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: ROOT }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, refusal: { code: 'unparseable', message: (r.stdout + r.stderr).slice(0, 300) } }; }
}
const fileOf = (id) => path.join(BOARD, fs.readdirSync(BOARD).find((f) => f.startsWith(`${id}-`)));
const read = (id) => fs.readFileSync(fileOf(id), 'utf8');
let TICKETS_TS = null;
try { TICKETS_TS = await imp('src/server/tickets.ts'); } catch { /* reported per check */ }
const revOf = (id) => TICKETS_TS.currentRev(fileOf(id));
const indexRow = (id) => fs.readFileSync(path.join(BOARD, 'INDEX.md'), 'utf8').split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';

const schema = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'ticket-schema.mjs')).href);
const recordOf = (id) => schema.parseTicket(read(id), { file: path.basename(fileOf(id)), mode: 'auto' }).record;
const OPT = (k) => `--option=${k}=label ${k} | what changes ${k} | what it gains | what it costs | why it is not obvious`;
// The real board has had the 2026-10-14 migration applied (these very cards were
// owned with `own`). REWIND each card the suite needs to its pre-own state on the
// SCRATCH copy, from the snapshot its own history carries, so the cases run on the
// real card content either way. The live board is never written.
const REPO_TICKETS = await import(url.pathToFileURL(path.join(REPO, 'src', 'server', 'tickets.ts')).href);
const { rewindOwnedMarkdown } = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'owned-decision.mjs')).href);
function rewind(id) {
  const file = fileOf(id);
  const back = rewindOwnedMarkdown(fs.readFileSync(file, 'utf8'), path.basename(file), schema);
  if (back === null) return false;
  fs.writeFileSync(file, back);
  REPO_TICKETS.setBoardOwner(ROOT, id, 'you');
  return true;
}
const rewound = ['BUG-121', 'BUG-115', 'FEAT-087', 'ARCH-021', 'FEAT-135'].filter(rewind);
let boardTs = null;
try { boardTs = await imp('src/server/board.ts'); } catch { /* reported per check */ }
const rail = () => boardTs.readBoard(ROOT).needsYou.map((i) => i.id);

console.log(`BUG-259 — decide gate + own + reopen (tool tree: ${TOOL}; scratch board: ${ROOT})`);
console.log(`  (scratch copy of the real board; rewound to their pre-own state from their own history: ${rewound.join(', ') || 'none — the board predates the migration'})`);

/* ── [1] the decide gate: same closed list, same first-code rule, same floor ── */
console.log('\n[1] decide refuses a card that names no hard stop');
const QUESTION = '--question=Which way should the scratch check go?';
await safe('G1 no --decider → refused, nothing written', () => {
  const before = read('BUG-259');
  const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'));
  check('G1 no --decider → refused, nothing written', !r.ok && read('BUG-259') === before, JSON.stringify(r.refusal ?? r).slice(0, 160));
});
const CONSEQ = '--consequence=restarting the service ends your three running sessions';
for (const [name, decider, code, conseq = CONSEQ] of [
  ['G2 priority (off the list)', 'priority', 'not-hard-stop'],
  ['G3 priority/live (a joined value is not one code)', 'priority/live', 'not-hard-stop'],
  ['G4 none,commit (BUG-256 r1 break shape)', 'none,live', 'not-hard-stop'],
  ['G4b live-priority (BUG-256 r2 compound break)', 'live-priority', 'not-hard-stop'],
  ['G4c live plus trailing words', 'live because it matters', 'not-hard-stop'],
  ['G5 live with no consequence', 'live', 'decider-no-consequence', '--consequence='],
]) {
  await safe(name, () => {
    const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'), `--decider=${decider}`, conseq);
    check(`${name} → refused ${code}`, !r.ok && r.refusal?.code === code, JSON.stringify(r.refusal ?? r).slice(0, 160));
  });
}
await safe('G6 a real hard stop passes, is stored, and reaches the rail', () => {
  const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'), '--decider=live', CONSEQ);
  const d = recordOf('BUG-259')?.decision;
  check('G6 live + consequence → card written with stop + consequence', r.ok && d?.stop === 'live' && /three running sessions/.test(d?.stop_consequence ?? ''), JSON.stringify(r.refusal ?? d).slice(0, 200));
  check('G6 …and it is on the Needs-You rail', rail().includes('BUG-259'));
});
await safe('G7 a Cyrillic consequence counts (BUG-256 r2 word count, shared)', () => {
  const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'), '--replace', '--decider=live', '--consequence=перезапуск остановит три ваших сессии');
  check('G7 live + Cyrillic consequence → accepted', r.ok, JSON.stringify(r.refusal ?? '').slice(0, 160));
});
await safe('G8 a replacement may not change the declared stop', () => {
  const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'), '--replace', '--decider=taste', '--consequence=you will look at this card every single day');
  check('G8 --replace live→taste on an open card → refused stop-change', !r.ok && r.refusal?.code === 'stop-change', JSON.stringify(r.refusal ?? r).slice(0, 160));
});
await safe('G9 ONE definition: board-tool and the ask check give the same verdict', async () => {
  const fm = await imp('scripts/lib/format-metrics.mjs');
  const src = fs.readFileSync(path.join(TOOL, 'scripts', 'board-tool.mjs'), 'utf8');
  check('G9 board-tool imports hardStopDefect/HARD_STOPS from format-metrics (no second list)',
    typeof fm.hardStopDefect === 'function' && /from '\.\/lib\/format-metrics\.mjs'/.test(src) && !/'irreversible',\s*\/\//.test(src));
  const cases = [['live', 'restarting ends three sessions'], ['priority', 'it matters a lot'], ['live', ''], ['taste/priority', 'you will see it daily'], ['risk', 'could break things badly'], ['LIVE', 'restart ends three sessions']];
  let agree = 0;
  for (const [d, c] of cases) {
    // `about: action` — a user-held subject — so this compares the DECIDER verdict
    // only; the chat ask's subject check (verify-ask-subject-gate.mjs) has no card twin yet.
    const ask = fm.askOwnershipDefects({ blocks: [{ name: 'orchard-ask', content: `confidence: high\nabout: action\ndecider: ${d}\nconsequence: ${c}` }] });
    const askVerdict = ask.length ? ask[0].defect : null;
    const r = tool('decide', '--id=BUG-259', QUESTION, OPT('A'), OPT('B'), '--replace', `--decider=${d}`, `--consequence=${c}`);
    const map = { 'not-hard-stop': 'decider-not-hard-stop', 'decider-no-consequence': 'decider-no-consequence' };
    const cardVerdict = r.ok ? null : (map[r.refusal?.code] ?? r.refusal?.code);
    if (askVerdict === cardVerdict) agree++;
    else console.log(`        disagree on ${d}/${c}: ask=${askVerdict} card=${cardVerdict}`);
  }
  check(`G9 the ask check and the card gate agree on ${agree}/${cases.length} decider/consequence pairs (live CLI vs the Stop-hook parser)`, agree === cases.length);
});

/* ── [2] own: the agent's decision, recorded as the agent's ── */
console.log('\n[2] own records an agent decision, never a user answer');
const AUTHOR = '--author=worker (BUG-259 verify suite)';
await safe('O1 own a real agent-owned card (BUG-121, judgement B)', () => {
  const r = tool('own', '--id=BUG-121', '--basis=judgement', '--chose=B', '--why=Parser strictness; B keeps the grammar and says out loud where the block was found.', '--next=Build B in the reader and the page.', AUTHOR);
  const rec = recordOf('BUG-121');
  const h = rec?.decision_history?.at(-1);
  const md = read('BUG-121');
  check('O1 own → ok', r.ok, JSON.stringify(r.refusal ?? '').slice(0, 200));
  check('O1 decision cleared, human_action none', rec?.decision === null && rec?.human_action === 'none');
  check('O1 history: chosen_by agent, owned.by/basis/why, full snapshot', h?.chosen_by === 'agent' && h?.owned?.by === 'worker (BUG-259 verify suite)'
    && h?.owned?.basis === 'judgement' && h?.snapshot?.options?.length === 2 && h?.chosen === 'B');
  check('O1 no answer written anywhere (no answers[], ticketAnswerState null)', !JSON.stringify(rec).includes('"answers"') && boardTs.ticketAnswerState(md, fileOf('BUG-121')) === null);
  check('O1 off the Needs-You rail, Owner cell not 👤', !rail().includes('BUG-121') && !indexRow('BUG-121').includes('\u{1F464}'));
  check('O1 typed log entry names the agent and says "not by you"', /— worker \(BUG-259 verify suite\)\n- \*\*Decided by agent \(own\):\*\* Decided by the agent, not by you/.test(md));
  check('O1 the record still validates', schema.validateTicket(rec, { file: path.basename(fileOf('BUG-121')) }).ok);
});
await safe('O2 a card that declares a hard stop cannot be owned', () => {
  const r = tool('own', '--id=BUG-259', '--basis=judgement', '--chose=A', '--why=I think A is fine here.', AUTHOR);
  check('O2 own on a live-stop card → refused declared-stop', !r.ok && r.refusal?.code === 'declared-stop', JSON.stringify(r.refusal ?? r).slice(0, 160));
});
for (const [name, args, code] of [
  ['O3 author reads as the user', ['--id=BUG-115', '--basis=recommendation', '--chose=A', '--why=Recommended.', '--author=user (via dashboard)'], 'bad-author'],
  ['O4 basis recommendation but not the recommended option', ['--id=BUG-115', '--basis=recommendation', '--chose=B', '--why=Because.', AUTHOR], 'not-recommendation'],
  ['O5 an option the card does not have', ['--id=BUG-115', '--basis=judgement', '--chose=Z', '--why=Because.', AUTHOR], 'bad-choice'],
  ['O6 criteria with a criterion that does not exist', ['--id=FEAT-087', '--basis=criteria', '--chose=A', '--ref=sc:99', '--why=Criteria.', AUTHOR], 'bad-ref'],
  ['O7 settled with a ref that names nothing', ['--id=ARCH-021', '--basis=settled', '--ref=BUG-99999', '--why=Settled.', AUTHOR], 'bad-ref'],
  ['O8 an answered card (BUG-240)', ['--id=BUG-240', '--basis=judgement', '--chose=A', '--why=Because.', AUTHOR], 'answered'],
  ['O9 a stale rev', ['--id=BUG-115', '--basis=recommendation', '--chose=A', '--why=Recommended.', '--rev=1:1', AUTHOR], 'ticket-409'],
]) {
  await safe(name, () => {
    const before = fs.existsSync(fileOf(args[0].slice(5))) ? read(args[0].slice(5)) : '';
    const r = tool('own', ...args);
    check(`${name} → refused ${code}, nothing written`, !r.ok && r.refusal?.code === code && read(args[0].slice(5)) === before, JSON.stringify(r.refusal ?? r).slice(0, 160));
  });
}
await safe('O10 criteria with a real criterion (FEAT-087 sc:1) is accepted', () => {
  const r = tool('own', '--id=FEAT-087', '--basis=criteria', '--chose=A', '--ref=sc:1', '--why=Its criteria already require parsing every ticket after the rename.', AUTHOR);
  check('O10 own --basis=criteria --ref=sc:1 → ok', r.ok, JSON.stringify(r.refusal ?? '').slice(0, 160));
});
await safe('O11 a legacy prose card (FEAT-135, verify owed)', () => {
  const r = tool('own', '--id=FEAT-135', '--basis=verify-owed', '--why=Decision A is resolved; only the independent verify remains.', AUTHOR);
  check('O11 own on a legacy card → ok, legacy:true', r.ok && r.legacy === true, JSON.stringify(r.refusal ?? '').slice(0, 160));
  check('O11 …off the rail', !rail().includes('FEAT-135'));
});
await safe('O12 the hiding path is closed', () => {
  const r = tool('update', '--id=BUG-108', '--owner=agent');
  check('O12 update --owner=agent on an open card → refused open-decision', !r.ok && r.refusal?.code === 'open-decision', JSON.stringify(r.refusal ?? r).slice(0, 160));
  const r2 = tool('update', '--id=BUG-108', '--human-action=none');
  check('O12 update --human-action=none on an open card → refused', !r2.ok && r2.refusal?.code === 'open-decision');
  const r3 = tool('update', '--id=BUG-121', '--owner=agent');
  check('O12 update --owner=agent with no open decision → still allowed', r3.ok, JSON.stringify(r3.refusal ?? '').slice(0, 160));
});
await safe('O13 schema: an owned entry with no reason is invalid', () => {
  const rec = recordOf('BUG-121');
  const h = rec.decision_history.at(-1);
  const bad = { ...rec, decision_history: [...rec.decision_history.slice(0, -1), { ...h, owned: { ...h.owned, why: '' } }] };
  check('O13 validateTicket rejects owned.why empty', !schema.validateTicket(bad, { file: path.basename(fileOf('BUG-121')) }).ok);
});

/* ── [3] the user's reopen ── */
console.log('\n[3] the user reopens an agent decision');
let od = null;
try { od = await imp('src/server/owned-decisions.ts'); } catch { /* reported below */ }
await safe('R1 reopen restores the decision as an open card on the rail', () => {
  const histId = recordOf('BUG-121').decision_history.at(-1).id;
  const snap = recordOf('BUG-121').decision_history.at(-1).snapshot;
  const out = od.reopenOwnedDecision(ROOT, 'BUG-121', histId, revOf('BUG-121'), 'I want to look at this one.');
  const rec = recordOf('BUG-121');
  check('R1 reopened', out.reopened === true);
  check('R1 same question + options, new id, reopened_from', rec.decision?.question === snap.question
    && JSON.stringify(rec.decision?.options) === JSON.stringify(snap.options) && rec.decision?.id !== histId && rec.decision?.reopened_from === histId);
  check('R1 back on the Needs-You rail', rail().includes('BUG-121'));
  check('R1 log says the user reopened it', /— user \(via dashboard\)\n- \*\*Decision reopened:\*\* Reopened by you/.test(read('BUG-121')));
  const again = od.reopenOwnedDecision(ROOT, 'BUG-121', histId, undefined);
  check('R2 reopening twice is idempotent', again.already === true && recordOf('BUG-121').decision?.id === rec.decision.id);
  const r = tool('own', '--id=BUG-121', '--basis=judgement', '--chose=B', '--why=Again.', AUTHOR);
  check('R3 own after the user reopened → refused reopened-by-user', !r.ok && r.refusal?.code === 'reopened-by-user', JSON.stringify(r.refusal ?? r).slice(0, 160));
});
await safe('R4 a reopen against a stale rev is refused', () => {
  const histId = recordOf('FEAT-087').decision_history.at(-1).id;
  let status = null;
  try { od.reopenOwnedDecision(ROOT, 'FEAT-087', histId, '1:1'); } catch (err) { status = err.status; }
  check('R4 stale rev → 409, card stays off the rail', status === 409 && !rail().includes('FEAT-087'));
});
await safe('R5 legacy reopen, then own refused', () => {
  od.reopenOwnedDecision(ROOT, 'FEAT-135', 'legacy', revOf('FEAT-135'));
  check('R5 legacy card back on the rail', rail().includes('FEAT-135'));
  const r = tool('own', '--id=FEAT-135', '--basis=verify-owed', '--why=Again.', AUTHOR);
  check('R5 own after a legacy reopen → refused reopened-by-user', !r.ok && r.refusal?.code === 'reopened-by-user');
});
await safe('R6 the reopen route is user-only (static: gate precedes the write)', () => {
  const src = fs.readFileSync(path.join(TOOL, 'src', 'server', 'index.ts'), 'utf8');
  const i = src.indexOf("action === 'reopen-decision'");
  const block = i < 0 ? '' : src.slice(i, i + 900);
  check('R6 requireUserCaller runs before reopenOwnedDecision in the route', i >= 0
    && block.indexOf('requireUserCaller') > -1 && block.indexOf('requireUserCaller') < block.indexOf('reopenOwnedDecision'));
});
await safe('R7 recent agent decisions list names what agents took', () => {
  const list = od.recentAgentDecisions(ROOT, 14);
  check('R7 FEAT-087 (owned, not reopened) is listed with its basis', list.some((d) => d.id === 'FEAT-087' && d.basis === 'criteria' && !d.reopened));
});

/* ── [4] partial reads: a concurrent reader catches the file mid-write ── */
console.log('\n[4] truncated reads of an owned ticket');
await safe('T truncations never read as a user answer and never break the rail', () => {
  const full = read('FEAT-087');
  const file = fileOf('FEAT-087');
  const cuts = [0.1, 0.3, 0.5, 0.7, 0.9, 0.98].map((f) => Math.floor(full.length * f));
  const ownedAt = full.indexOf('"owned"');
  cuts.push(ownedAt, full.indexOf('```', 10) + 1, full.lastIndexOf('### '));
  let ok = 0;
  for (const c of cuts) {
    fs.writeFileSync(file, full.slice(0, c));
    let good = true;
    try {
      const md = read('FEAT-087');
      if (boardTs.ticketAnswerState(md, file) !== null) good = false;
      boardTs.readBoard(ROOT);
    } catch { good = false; }
    if (good) ok++;
  }
  fs.writeFileSync(file, full);
  check(`T ${ok}/${cuts.length} truncation points: no fabricated answer, readBoard does not throw`, ok === cuts.length);
});

/* ── [5] the scratch board is still consistent ── */
console.log('\n[5] board:check on the scratch board after every write above');
await safe('B board check clean', () => {
  const r = tool('check');
  check('B board-tool check → clean', r.ok && r.board?.clean !== false && (r.fails ?? r.board?.fails ?? []).length === 0, JSON.stringify(r.fails ?? r.board?.fails ?? r.refusal ?? '').slice(0, 300));
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
