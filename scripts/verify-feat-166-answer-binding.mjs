#!/usr/bin/env node
/**
 * verify-feat-166-answer-binding.mjs — FEAT-166 round 2.
 *
 * THE PROPERTY. "A ticket's answer state reflects the user's answer to the CURRENT
 * decision, and nothing else." It broke twice via src/server/board.ts, both by
 * inferring the declaration<->answer pairing from Activity-log TEXT rather than an
 * explicit binding:
 *   (a) decision1 answered -> `decide --replace` declares decision2 -> the user adds
 *       a context-only FOLLOW-UP. The old answer to decision1 resurfaces, because
 *       the follow-up sits after the declaration in text order.
 *   (b) a `- **Decision declared:**`-shaped line inside a FENCED code block counts as
 *       a real declaration and clears a genuine answer.
 *
 * THE REDESIGN (holds by construction, ARCH-010). `board-tool decide` mints the
 * decision's own id (record.decision.id). A reply records the id it answers, in its
 * server-composed heading (`you (answer · via … · decision <id>)`). board.ts pairs
 * answer to decision by that id — a non-follow-up anchor BOUND to the current id is
 * required — and the Activity-log scan is code-fence aware. No declaration scanning,
 * no line-order comparison. Legacy (no id) + legacy answer (no binding) reads as
 * today via `null === null`.
 *
 * MUST-FAIL. Sections 1-2 run against a PINNED COPY of the pre-r2 board.ts (fixture
 * bytes under $scratch/pre, NOT HEAD): both breaks reproduce (the proof that the
 * tests are real). Sections 3+ run the LIVE board.ts: both fixed, legacy preserved,
 * FEAT-090 follow-up preserved, and a property sweep over every currently-answered
 * REAL ticket shows identical answer state before/after.
 *
 * Run: node scripts/verify-feat-166-answer-binding.mjs
 * Reads a COPY of the real board; never writes inside the real repo; no server, no port.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BOARD = path.join(REPO, 'docs', 'bugs');

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── the pinned pre-r2 board.ts ──────────────────────────────────────────────
// Prefer the lane's snapshot ($scratch/pre/board.ts). It must exist: a must-FAIL
// proof anchored to HEAD would pass the moment the fix lands (CONVENTIONS), so we
// refuse to run rather than silently skip if the pinned bytes are missing.
function scratchRoot() {
  const p = '/tmp/feat166-scratch-path.txt';
  if (fs.existsSync(p)) { const d = fs.readFileSync(p, 'utf8').trim(); if (d && fs.existsSync(path.join(d, 'pre', 'board.ts'))) return d; }
  return null;
}
async function importPinnedPre() {
  const root = scratchRoot();
  if (!root) throw new Error('pinned pre-r2 board.ts not found under $scratch/pre — re-snapshot before running the must-FAIL proof');
  let src = fs.readFileSync(path.join(root, 'pre', 'board.ts'), 'utf8');
  src = src
    .replace(/from '\.\.\/\.\.\/scripts\/lib\/ticket-schema\.mjs'/, `from '${REPO}/scripts/lib/ticket-schema.mjs'`)
    .replace(/from '\.\.\/\.\.\/scripts\/lib\/board-path\.mjs'/, `from '${REPO}/scripts/lib/board-path.mjs'`)
    .replace(/from '\.\/board-rank\.ts'/, `from '${REPO}/src/server/board-rank.ts'`);
  const file = path.join(root, 'pre', `board.pinned.${Date.now()}.ts`);
  fs.writeFileSync(file, src);
  return import(url.pathToFileURL(file).href);
}

// ── fixtures (realistic state, synthetic bytes — no real ticket is in these states yet) ──
function rec(id, question, decision = {}) {
  const base = {
    id, type: id.startsWith('BUG') ? 'bug' : 'feature', title: 't', summary: 's',
    impact_if_we_wait: 'i', current_need: 'c', severity: 'medium', area: 'a',
    reported: '2026-10-01', reported_by: 'agent', owner: 'you', work_state: 'blocked',
    human_action: 'decide', updated: '2026-10-04',
    decision: {
      mode: 'single', question,
      options: [
        { key: 'A', label: 'first', what_changes: 'x', benefit: 'y', cost: 'z', why_not_obvious: 'w' },
        { key: 'B', label: 'second', what_changes: 'x', benefit: 'y', cost: 'z', why_not_obvious: 'w' },
      ],
      recommendation: null, recommendation_reason: null, prerequisite: null, ...decision,
    },
    decision_history: [], success_criteria: ['x'], code_refs: [], related: [],
    recurrence_evidence: [], verification: [], body_slots: {},
  };
  return '```orchard-ticket\n' + JSON.stringify(base, null, 2) + '\n```\n';
}

// (a) old legacy answer to decision1, decision2 re-declared, context-only follow-up bound to d2.
const D2 = '11111111-2222-4333-8444-555555555555';
const breakA = rec('BUG-900', 'New question two?', { id: D2 }) + `# BUG-900 — t
## Activity log
### 2026-10-01 — agent
- **Decision declared:** Old question one options.
### 2026-10-02 — you (answer · via ticket view)
- **Chose:** A — first
- **State:** answered — awaiting agent action (not dispatched)
### 2026-10-03 — worker (fixing r2)
- **Decision declared:** New question two options.
### 2026-10-04 — you (follow-up · via ticket view · decision ${D2})
- **Note:** just adding context, not a fresh answer
- **State:** answered — awaiting agent action (context added after deciding, not dispatched)
`;

// (b) a real answer bound to the current decision, plus a fenced declaration example after it.
const DCUR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const breakB = rec('BUG-901', 'Current question?', { id: DCUR }) + `# BUG-901 — t
## Activity log
### 2026-10-02 — you (answer · via ticket view · decision ${DCUR})
- **Chose:** B — second
- **State:** answered — awaiting agent action (not dispatched)

## Docs
Example of the entry a declaration writes:
\`\`\`
### 2026-10-03 — agent
- **Decision declared:** example only, inside a fence
\`\`\`
`;

// legacy: a decision with NO id and a legacy answer with NO binding → must read as today.
const legacy = rec('BUG-902', 'Legacy question?') + `# BUG-902 — t
## Activity log
### 2026-10-02 — you (answer · via ticket view)
- **Chose:** A — first
- **State:** answered — awaiting agent action (not dispatched)
`;

// FEAT-090 preserved: answer + follow-up both bound to the current decision.
const DF = '99999999-0000-4111-8222-333333333333';
const followupOk = rec('BUG-903', 'Followup question?', { id: DF }) + `# BUG-903 — t
## Activity log
### 2026-10-02 — you (answer · via ticket view · decision ${DF})
- **Chose:** B — second
- **State:** answered — awaiting agent action (not dispatched)
### 2026-10-03 — you (follow-up · via ticket view · decision ${DF})
- **Note:** one more consideration
- **State:** answered — awaiting agent action (context added after deciding, not dispatched)
`;

async function main() {
  // ── 1-2: MUST-FAIL on pinned pre-r2 board.ts ──────────────────────────────
  console.log('\n[1-2] MUST-FAIL — both breaks reproduce on the pinned pre-r2 board.ts');
  const pre = await importPinnedPre();
  const preA = pre.ticketAnswerState(breakA);
  ok('(pre) break (a): old answer RESURFACES (proves the test is real)', preA && preA.chose && preA.chose.key === 'A',
    `got ${JSON.stringify(preA && preA.chose)}`);
  const preB = pre.ticketAnswerState(breakB);
  ok('(pre) break (b): fenced declaration CLEARS the real answer (proves the test is real)', preB === null,
    `got ${JSON.stringify(preB && preB.chose)}`);

  // ── 3+: LIVE board.ts — both fixed, legacy & FEAT-090 preserved ───────────
  console.log('\n[3] LIVE board.ts — property holds');
  const live = await import(`${REPO}/src/server/board.ts`);
  const a = live.ticketAnswerState(breakA);
  ok('break (a) FIXED: orphan follow-up after a re-declared decision is NOT answered (null)', a === null,
    `got ${JSON.stringify(a)}`);
  // FEAT-166 r3: answers are typed entries now; a prose heading counts for nothing at
  // read time. These grammar legs stay meaningful against the FROZEN prose reader (the
  // one that built answers-legacy.frozen.json). The typed equivalents are in
  // verify-feat-166-typed-answer.mjs.
  const b = live.legacyProseAnswerState(breakB);
  ok('break (b) FIXED: the real answer stands despite the fenced declaration (chose B)', b && b.chose && b.chose.key === 'B',
    `got ${JSON.stringify(b)}`);
  const lg = live.legacyProseAnswerState(legacy);
  ok('legacy preserved: no-id decision + no-binding answer reads as answered (chose A)', lg && lg.chose && lg.chose.key === 'A',
    `got ${JSON.stringify(lg)}`);
  const fu = live.legacyProseAnswerState(followupOk);
  ok('FEAT-090 preserved: answer + bound follow-up → anchor chose B, 1 follow-up, awaiting', !!fu && fu.chose && fu.chose.key === 'B' && fu.followups.length === 1 && fu.awaiting === true,
    `got ${JSON.stringify(fu)}`);

  // Non-vacuity: the fence-aware scan must still SEE a real (unfenced) declaration's
  // effect via identity — a NEW decision id with no bound answer reads as unanswered.
  const reask = rec('BUG-904', 'Brand new question?', { id: 'cccccccc-dddd-4eee-8fff-000000000000' }) + `# BUG-904 — t
## Activity log
### 2026-10-02 — you (answer · via ticket view · decision ${DCUR})
- **Chose:** A — first
- **State:** answered — awaiting agent action (not dispatched)
`;
  ok('re-ask by identity: an answer bound to a SUPERSEDED id does not satisfy the new decision (null)', live.ticketAnswerState(reask) === null,
    `got ${JSON.stringify(live.ticketAnswerState(reask))}`);

  // ── 4: property sweep over every currently-answered REAL ticket ───────────
  console.log('\n[4] PROPERTY SWEEP — every answered real ticket: identical answer state before/after');
  const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-sweep-'));
  try {
    const dst = path.join(sweepRoot, 'docs', 'bugs');
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(REAL_BOARD)) {
      const s = path.join(REAL_BOARD, n);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, n));
    }
    const files = fs.readdirSync(dst).filter((n) => /^[A-Z]+-\d+.*\.md$/.test(n));
    let answeredCount = 0, mismatches = 0;
    for (const n of files) {
      const md = fs.readFileSync(path.join(dst, n), 'utf8');
      const sPre = pre.ticketAnswerState(md);
      const sPost = live.ticketAnswerState(md, path.join(dst, n));
      if (sPre && sPre.kind === 'decision') answeredCount++;
      if (JSON.stringify(sPre) !== JSON.stringify(sPost)) {
        mismatches++;
        if (mismatches <= 5) console.log(`      DIFF ${n}: pre=${JSON.stringify(sPre)} post=${JSON.stringify(sPost)}`);
      }
    }
    ok(`sweep: real board has answered tickets to test (found ${answeredCount})`, answeredCount > 0);
    ok(`sweep: ticketAnswerState identical pre vs post for all ${files.length} real tickets`, mismatches === 0, `${mismatches} differed`);

    // readBoard().answeredAwaiting lane: same membership + same answer text/date.
    const preBoard = pre.readBoard(sweepRoot);
    const postBoard = live.readBoard(sweepRoot);
    const key = (arr) => (arr ?? []).map((i) => `${i.id}@${i.answeredOn ?? ''}#${i.answer ?? ''}`).sort().join('|');
    ok(`sweep: readBoard().answeredAwaiting identical pre vs post (${(preBoard.answeredAwaiting ?? []).length} items)`,
      key(preBoard.answeredAwaiting) === key(postBoard.answeredAwaiting),
      `pre=${(preBoard.answeredAwaiting ?? []).map((i) => i.id).join(',')} post=${(postBoard.answeredAwaiting ?? []).map((i) => i.id).join(',')}`);
    ok('sweep: needsYou lane membership identical pre vs post',
      (preBoard.needsYou ?? []).map((i) => i.id).sort().join(',') === (postBoard.needsYou ?? []).map((i) => i.id).sort().join(','));
  } finally {
    fs.rmSync(sweepRoot, { recursive: true, force: true });
  }

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
