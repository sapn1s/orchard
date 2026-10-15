#!/usr/bin/env node
/**
 * BUG-257 r2 — a picked option is the go, and the user's NOTE always travels with it,
 * verbatim and untruncated, in BOTH agent briefings.
 *
 *   node scripts/verify-bug-257-answer-note-travels.mjs
 *
 * Round 1 changed only the briefing's wording ("a picked option is the go; a wait is
 * not"). An independent clean room broke it two ways: (1) an option picked WITH a
 * wait / rejection / condition / question note rendered as a plain go — the note was
 * dropped (the lane text was the entry's FIRST body line); (2) a free-text answer
 * whose "wait" fell past character 60 was cut. Parsing notes for "wait"/"no" would be
 * enumeration, so the r2 design (independent design review) is structural: the pick is
 * the go, every note from the user rides beside it in full, and the agent (an LLM)
 * reads it under an instruction that the note governs over the pick.
 *
 * REALISM: the board is a COPY OF THE REAL BOARD (docs/bugs — 20+ live decisions and
 * the real FEAT-023 answer that is itself a question), answered through the REAL
 * writer (tickets.answerTicket / board.recordAdoption), in a scratch data dir.
 * Checks:
 *   [1] each non-go note (wait / reject / condition / question / multi-line) appears in
 *       full in the launch snapshot AND the live [station] briefing, under the
 *       note-governs instruction; the pick is shown as the option, not the Question line
 *   [2] a long free-text answer is not cut (its trailing "wait" survives)
 *   [3] a plain pick with no note is still briefed as the go (control)
 *   [4] a SAME-DAY follow-up ("hold off") after the pick was briefed is briefed AGAIN
 *       (plan-review: the dedup key was id@date, so it was silently suppressed)
 *   [5] answers beyond the snapshot's item cap are not marked seen at launch, so the
 *       live briefing still delivers them (plan-review: overflow was lost)
 *   [6] a user follow-up after an agent ADOPTION reaches the live briefing (adoption
 *       provenance kept; plan-review: adopted items were filtered out wholesale)
 *   [7] the real FEAT-023 answer appears in full
 * Must FAIL on the r1 tree; PASS after.
 *
 * r3 (orchestrator adjudication after clean room 8c15031e: an ADOPT launch seeded the
 * seen-set with 5 keys while its snapshot was null, so those answers reached neither
 * briefing). An answer is marked seen ONLY by board.markAnswersDelivered, called only
 * after a turn carrying it was handed to the runtime; nothing pre-seeds.
 *   [8] adopt launch, replayed as agent-bridge.ts's constructor actually does it:
 *       every answered ticket (with its notes) reaches the first live briefing
 *   [9] structural chokepoint: every seen-state write in src/ goes through
 *       markAnswersDelivered; each #withBriefing site marks only AFTER its send
 *  [10] a composed-but-undelivered briefing marks nothing; a fresh launch's first
 *       turn carries snapshot + overflow with no repeat, and nothing after
 * Must FAIL on the r2 tree (BUG257_R2_ROOT run); PASS after.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'bug257-'));
process.env.CLAUDE_STATION_DATA = path.join(RUN, 'data');
fs.mkdirSync(process.env.CLAUDE_STATION_DATA, { recursive: true });
const HOST = path.join(RUN, 'proj');
fs.cpSync(path.join(ROOT, 'docs', 'bugs'), path.join(HOST, 'docs', 'bugs'), { recursive: true });
const BOARD = path.join(HOST, 'docs', 'bugs');

const B = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
const { boardStateSection, boardAnswerBriefing, readBoard, recordAdoption, ticketFile } = B;
// r3 API, with the r2 equivalents when grading the pre-fix tree.
const snapshotKeys = (opts) => (B.boardStateSnapshot ? (B.boardStateSnapshot(HOST, opts)?.answeredKeys ?? []) : B.answeredAwaitingKeys(HOST, opts));
const deliver = (seen, keys) => (B.markAnswersDelivered ? B.markAnswersDelivered(seen, keys) : keys.forEach((k) => seen.add(k)));
const deliveredSeen = (opts) => { const s = new Set(); deliver(s, snapshotKeys(opts)); return s; };
const { answerTicket, readTicket } = await import(path.join(ROOT, 'src', 'server', 'tickets.ts'));
const ds = await import(path.join(ROOT, 'scripts', 'lib', 'delegation-source.mjs'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        observed: ${String(observed).slice(0, 400)}`}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const opt = (id, i = 0) => { const o = readTicket(HOST, id).decision.options[i]; return { key: o.key, label: o.label }; };
const answer = (id, input) => answerTicket(HOST, id, { kind: 'decision', question: readTicket(HOST, id).decision?.question ?? null, ...input }, readTicket(HOST, id).rev);

// Real decision tickets on the copied board (each 👤 with options).
const CASES = [
  { id: 'ARCH-013', note: 'Go with this, but wait until I approve the schema before touching any data.' },
  { id: 'ARCH-021', note: "Actually no — don't do this one, close it instead." },
  { id: 'ARCH-019', note: 'Only if the migration is reversible; otherwise come back to me first.' },
  { id: 'ARCH-023', note: 'What happens to the exports people already have — do they break?' },
  { id: 'BUG-115', note: 'Yes, this one.\nBut not before Friday:\n  the demo runs on the current build until then.' },
];
const FREE = { id: 'FEAT-049', text: 'I think the second option is roughly right and I am leaning that way overall, though there is a catch I need to check with the team first; not yet, wait for my approval.' };
const PLAIN = { id: 'BUG-236' };
const FOLLOW = { id: 'BUG-048', hold: 'Hold off on this until Monday — the release freeze is on.' };

const included = (text, note) => note.split('\n').map((l) => l.trim()).filter(Boolean).every((l) => text.includes(l));

try {
  for (const c of CASES) answer(c.id, { chose: opt(c.id), note: c.note });
  answer(FREE.id, { chose: null, note: FREE.text });
  answer(PLAIN.id, { chose: opt(PLAIN.id), note: '' });

  // the item cap itself is [5]'s subject; here every answered ticket is in view
  const snap = boardStateSection(HOST, { maxItems: 1000 }) ?? '';
  const live = boardAnswerBriefing(HOST, new Set()) ?? '';

  console.log('\n[1] a non-go note on a picked option travels in full, on both surfaces');
  for (const c of CASES) {
    check(`snapshot carries ${c.id}'s note verbatim: ${JSON.stringify(c.note.slice(0, 50))}`, included(snap, c.note), snap.split('\n').filter((l) => l.includes(c.id)).join(' | '));
    check(`live briefing carries ${c.id}'s note verbatim`, included(live, c.note), live.split('\n').filter((l) => l.includes(c.id)).join(' | '));
  }
  for (const [name, text] of [['snapshot', snap], ['live briefing', live]]) {
    check(`${name}: says a note governs over the pick and a wait/condition/rejection/question means do NOT start`,
      /note governs/i.test(text) && /do not start/i.test(text), text.split('\n').filter((l) => /go|start/i.test(l)).slice(0, 3).join(' | '));
    const o = opt(CASES[0].id);
    check(`${name}: the pick is shown as the option itself (${o.key} — ${o.label.slice(0, 30)}), never the echoed Question line`,
      text.includes(`${o.key} — ${o.label}`) && !/chose: \*\*Question/.test(text), text.split('\n').filter((l) => l.includes(CASES[0].id)).join(' | '));
  }

  console.log('\n[2] a long free-text answer is not cut');
  check('snapshot carries the whole free-text answer (its trailing "wait for my approval" survives)', snap.includes(FREE.text), snap.split('\n').filter((l) => l.includes(FREE.id)).join(' | '));
  check('live briefing carries the whole free-text answer', live.includes(FREE.text), live.split('\n').filter((l) => l.includes(FREE.id)).join(' | '));

  console.log('\n[3] control: a plain pick with no note is briefed as the go');
  {
    const o = opt(PLAIN.id);
    const ln = live.split('\n').filter((l) => l.includes(PLAIN.id) || l.includes(`${o.key} — ${o.label}`));
    check('the plain pick is listed with its option, and the instruction says a pick with no note is the go — start it',
      live.includes(`${o.key} — ${o.label}`) && /no note is the user's go/i.test(live) && /report it as started/i.test(live), ln.join(' | '));
  }

  console.log('\n[4] a same-day follow-up after the pick was briefed is briefed again');
  {
    const seen = deliveredSeen({ maxItems: 1000 });
    answer(FOLLOW.id, { chose: opt(FOLLOW.id), note: '' });
    const b1 = boardAnswerBriefing(HOST, seen) ?? '';
    check('the pick is briefed once', b1.includes(FOLLOW.id), b1.slice(0, 200));
    answerTicket(HOST, FOLLOW.id, { kind: 'decision', followup: true, note: FOLLOW.hold }, readTicket(HOST, FOLLOW.id).rev);
    const b2 = boardAnswerBriefing(HOST, seen) ?? '';
    check('the same-day "hold off" follow-up is briefed again, verbatim, with the same seen-set', b2.includes(FOLLOW.id) && b2.includes(FOLLOW.hold), b2 || '(null — suppressed)');
    const snap2 = boardStateSection(HOST, { maxItems: 1000 }) ?? '';
    check('a fresh launch snapshot shows the pick AND the follow-up note', snap2.includes(FOLLOW.hold), snap2.split('\n').filter((l) => l.includes(FOLLOW.id)).join(' | '));
  }

  console.log('\n[5] answers beyond the snapshot item cap still reach the session');
  {
    const all = (readBoard(HOST).answeredAwaiting ?? []).map((it) => it.id);
    const snapCap = boardStateSection(HOST) ?? '';
    const seed = deliveredSeen();
    const after = boardAnswerBriefing(HOST, seed) ?? '';
    const lost = all.filter((id) => !snapCap.includes(`${id} —`) && !after.includes(`${id} —`));
    check(`every answered ticket (${all.length}) is either shown in the launch snapshot or briefed live (none lost to the +N more cap)`,
      all.length > 5 && lost.length === 0, `lost: ${lost.join(', ') || '-'}; answered: ${all.join(', ')}`);
  }

  console.log('\n[6] a user follow-up after an agent adoption reaches the live briefing');
  {
    const ID = 'FEAT-182';
    const file = ticketFile(BOARD, ID);
    const data = process.env.CLAUDE_STATION_DATA;
    const key = ds.ensureDelegationKey(data);
    const rec = readTicket(HOST, ID).decision;
    const o = rec.options.find((x) => x.key === (rec.recommended ?? 'A'));
    let adopted = false;
    try {
      recordAdoption(file, {
        chose: { key: o.key, label: o.label }, note: '',
        delegation: { delegation_id: 'dlg-bug257-demo-0001', statement: 'pick the recommended option on FEAT-182', recorded_at: new Date().toISOString() },
        adoptedBy: 'worker (BUG-257 demo)',
        receipt: (r) => { ds.appendEntry(data, BOARD, key, { kind: 'adoption', ...r }); },
      });
      adopted = (readBoard(HOST).answeredAwaiting ?? []).some((it) => it.id === ID && it.adopted);
    } catch (e) { console.log(`        (adoption setup failed: ${e.message})`); }
    check('setup: FEAT-182 is adopted under delegation (agent act, not a user answer)', adopted, adopted);
    const seen = deliveredSeen({ maxItems: 1000 });
    const note = 'I saw the adoption — hold it, do not start until I have read the audit.';
    answerTicket(HOST, ID, { kind: 'decision', followup: true, note }, readTicket(HOST, ID).rev);
    const b = boardAnswerBriefing(HOST, seen) ?? '';
    check('the user\'s follow-up on an adopted decision is briefed live, verbatim', b.includes(ID) && b.includes(note), b || '(null — filtered out)');
    check('…and the adoption is still named as an adoption, not relabelled the user\'s answer', /adopted under delegation/i.test(b), b.split('\n').filter((l) => l.includes(ID)).join(' | '));
  }

  console.log('\n[7] the real FEAT-023 answer (itself a question) appears in full');
  {
    const real = (readBoard(HOST).answeredAwaiting ?? []).find((it) => it.id === 'FEAT-023');
    const full = real ? readTicket(HOST, 'FEAT-023').answer?.note ?? '' : '';
    const s = boardStateSection(HOST, { maxItems: 1000 }) ?? '';
    check('the launch snapshot carries the whole real answer, not its first 60 characters', !!full && full.length > 60 && included(s, full),
      `answer ${full.length} chars; shown: ${s.split('\n').filter((l) => l.includes('FEAT-023')).join(' | ').slice(0, 200)}`);
  }

  // ── r3 ──────────────────────────────────────────────────────────────────────
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  const boardSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'board.ts'), 'utf8');
  // The constructor's launch window: from the snapshot read to the first-turn compose.
  const winStart = bridgeSrc.search(/const boardSnapshot|let boardSnapshot/);
  const winEnd = bridgeSrc.indexOf('this.#withBriefing(opts.firstPrompt', winStart);
  const launchWindow = winStart >= 0 && winEnd > winStart ? bridgeSrc.slice(winStart, winEnd) : '';
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const liveIds = (seen) => {
    const b = B.answerBriefingFor ? B.answerBriefingFor(HOST, seen)?.text ?? '' : boardAnswerBriefing(HOST, new Set(seen)) ?? '';
    return b;
  };

  console.log('\n[8] r3 — ADOPT launch (snapshot null): nothing pre-seeds; every answer reaches the first briefing');
  {
    // Replay the constructor as the CODE does it: does the launch window write the
    // seen-set before any turn is delivered? (r2: answeredAwaitingKeys → #answerBriefSeen.add)
    const code = stripComments(launchWindow);
    const seedsAtLaunch = /#answerBriefSeen\.add|answeredAwaitingKeys\(|markAnswersDelivered\(/.test(code);
    check('setup: located the constructor launch window in agent-bridge.ts', launchWindow.length > 100, launchWindow.length);
    const seen = new Set();
    if (seedsAtLaunch) for (const k of B.answeredAwaitingKeys(HOST)) seen.add(k); // what r2's line 1795 did, adopt or not
    const briefable = (readBoard(HOST).answeredAwaiting ?? []).filter((it) => !it.adopted || (it.answerNotes ?? []).length > 0);
    const first = liveIds(seen);
    const lost = briefable.filter((it) => !first.includes(`${it.id} —`)).map((it) => it.id);
    check(`the launch window writes no seen-state (adopt has no snapshot to justify it)`, !seedsAtLaunch, seedsAtLaunch ? 'seeds at launch' : 'no seeding');
    check(`all ${briefable.length} answered tickets reach the adopted session's first live briefing (none silently lost)`,
      briefable.length > 5 && lost.length === 0, `lost ${lost.length}: ${lost.join(', ')}`);
    const notesLost = CASES.filter((c) => !included(first, c.note)).map((c) => c.id);
    check('…each with its user note verbatim (wait / reject / condition / question / multi-line)', notesLost.length === 0, `notes lost: ${notesLost.join(', ') || '-'}`);
  }

  console.log('\n[9] r3 — ONE writer of answer seen-state, called only after delivery');
  {
    const code = stripComments(bridgeSrc);
    const directWrites = [...code.matchAll(/#answerBriefSeen\s*(\.(add|delete|clear)\s*\(|=(?!=))/g)].map((m) => code.slice(m.index, code.indexOf('\n', m.index)).trim())
      .filter((l) => !/#answerBriefSeen\s*=\s*new Set<string>\(\);/.test(l));
    check('agent-bridge.ts never writes #answerBriefSeen directly (only via markAnswersDelivered)', directWrites.length === 0, directWrites.join(' | ') || 'none');
    const viaChoke = [...code.matchAll(/markAnswersDelivered\(this\.#answerBriefSeen/g)].length;
    check('agent-bridge.ts marks seen-state only through markAnswersDelivered (one call, in the delivered() closure)', viaChoke === 1 && /const delivered = \(\) => markAnswersDelivered\(this\.#answerBriefSeen/.test(code), viaChoke);
    const bcode = stripComments(boardSrc);
    const fnBody = (name) => { const i = bcode.search(new RegExp(`export function ${name}\\(`)); if (i < 0) return ''; const j = bcode.indexOf('\n}\n', i); return bcode.slice(i, j); };
    const adds = [...bcode.matchAll(/\bseen\.(add|delete|clear)\(/g)].length;
    const inChoke = [...fnBody('markAnswersDelivered').matchAll(/\bseen\.add\(/g)].length;
    check('board.ts: the only seen-set write is inside markAnswersDelivered', adds === 1 && inChoke === 1, `writes ${adds}, in markAnswersDelivered ${inChoke}`);
    check('board.ts: answerBriefingFor is pure (takes a ReadonlySet, writes nothing)', /answerBriefingFor\(hostPath: string, seen: ReadonlySet<string>\)/.test(bcode) && !/seen\.add/.test(fnBody('answerBriefingFor')), fnBody('answerBriefingFor').slice(0, 80));
    check('the launch pre-seeder answeredAwaitingKeys no longer exists', !/export function answeredAwaitingKeys/.test(bcode), 'answeredAwaitingKeys present?');
    // every #withBriefing call site: its result's delivered() is called, and only AFTER the hand-off
    const sites = [...code.matchAll(/const (\w+) = (?:opts\.adopt \? null : )?this\.#withBriefing\(/g)];
    const bad = [];
    for (const m of sites) {
      const v = m[1];
      const after = code.slice(m.index);
      const d = after.search(new RegExp(`${v}\\??\\.delivered\\(\\)`));
      const h = after.search(/#runtime\.send\(|#runtime\.start\(|broker\.deliver\(/);
      if (d < 0 || h < 0 || d < h) bad.push(`${v}: delivered@${d} handoff@${h}`);
    }
    check(`all ${sites.length} #withBriefing call sites mark delivered only after the runtime hand-off`, sites.length === 4 && bad.length === 0, bad.join(' | ') || `${sites.length} sites`);
    const gated = code.slice(code.indexOf('broker.deliver('), code.indexOf('broker.deliver(') + 1600);
    check('gated delivery marks only on an ACCEPTED frame (refused / uncertain mark nothing)', gated.includes('textB.delivered()') && gated.indexOf('textB.delivered()') > gated.indexOf("outcome: 'uncertain'"), 'order in deliverGated');
  }

  console.log('\n[10] r3 — undelivered marks nothing; a fresh launch delivers snapshot + overflow once');
  {
    if (B.answerBriefingFor) {
      const seen = new Set();
      const a = B.answerBriefingFor(HOST, seen);
      const b = B.answerBriefingFor(HOST, seen);
      check('a composed briefing whose send failed (delivered() never called) is composed again in full next turn', !!a && seen.size === 0 && JSON.stringify(a.keys) === JSON.stringify(b?.keys), `seen ${seen.size}, keys ${a?.keys.length}/${b?.keys.length}`);
      // fresh launch: the first turn carries the snapshot (5) AND, in the same turn, the overflow; then nothing repeats
      const snap = B.boardStateSnapshot(HOST);
      const view = new Set(snap.answeredKeys);
      const firstLive = B.answerBriefingFor(HOST, view);
      const shownIds = snap.answeredKeys.map((k) => k.split('@')[0]);
      const repeat = shownIds.filter((id) => firstLive?.text.includes(`${id} —`));
      check('first turn: the live briefing carries the snapshot\'s overflow and repeats none of the 5 the snapshot shows', !!firstLive && firstLive.keys.length > 0 && repeat.length === 0, `overflow ${firstLive?.keys.length}, repeats ${repeat.join(',') || '-'}`);
      const s2 = new Set(); B.markAnswersDelivered(s2, [...snap.answeredKeys, ...(firstLive?.keys ?? [])]);
      check('after the first turn is delivered, the next turn briefs nothing (each answer stated once)', B.answerBriefingFor(HOST, s2) === null, 'null');
    } else {
      check('answerBriefingFor / boardStateSnapshot / markAnswersDelivered exist (r3 API)', false, 'absent on this tree');
    }
  }
} catch (e) {
  console.log(`FATAL: ${e.stack ?? e.message}`);
  fail++;
} finally {
  fs.rmSync(RUN, { recursive: true, force: true });
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
process.exitCode = fail === 0 ? 0 : 1;
