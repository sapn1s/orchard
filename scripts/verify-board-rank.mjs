/**
 * FEAT-095 — the board is ordered by what answering a ticket is worth.
 *
 *   node scripts/verify-board-rank.mjs
 *
 * Everything below runs against the REAL board in this repo (docs/bugs/, 200+
 * ticket records, 34 open rows) through the REAL `readBoard`. There is no
 * fixture: a fixture would encode the same assumptions the ranking does, and
 * this board is already the busy state a fixture would have to imitate.
 *
 * It asserts INVARIANTS, never today's order. "ARCH-010 is first" would be a
 * useless test — it goes red the moment the user answers ARCH-010, which is the
 * whole point of the feature. So the properties asserted are:
 *
 *   1. ordering is a PERMUTATION — nothing is filtered out of any lane
 *   2. a ticket that settles more, all else equal, ranks higher
 *   3. the head of the needs-you lane holds the lane's maximum settlement
 *   4. every `rankWhy` claim is checkable — it names real, open, related ids
 *   5. no two tickets each claim to settle the other (symmetric-edge guard)
 *   6. a ticket with NO record still ranks and still appears
 *   7. `summary.focus` is the top-ranked row, not the oldest one
 *
 * Non-vacuity is proved against a SYNTHESIZED pre-fix board — the same lanes in
 * raw INDEX.md line order, which is exactly what shipped before this change.
 * The baseline is constructed here rather than read from a revision, so it
 * cannot silently become the fixed state once this lands (docs/CONVENTIONS.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readBoard, boardSummary } from '../src/server/board.ts';
import { rankRows, readRankRecord, settlementGraph } from '../src/server/board-rank.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const board = readBoard(ROOT);
if (!board.hasBoard) { console.error('FATAL: no board at ' + ROOT); process.exit(1); }

const LANES = {
  needsYou: board.needsYou,
  answeredAwaiting: board.answeredAwaiting ?? [],
  inflight: board.inflight,
  queued: board.queued,
};
const openIds = new Set(Object.values(LANES).flat().map((r) => r.id));

/* ── The pre-fix baseline: the same rows, in raw INDEX.md line order ───────── */
const indexOrder = (() => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'bugs', 'INDEX.md'), 'utf8');
  const out = [];
  let inOpen = false;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { inOpen = h[1].toLowerCase().startsWith('open'); continue; }
    if (!inOpen) continue;
    const m = /^\|\s*([A-Z]+-\d+)\s*\|/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
})();
/** A lane as it was BEFORE ranking: its own members, in INDEX file order. */
const preFix = (lane) => {
  const ids = new Set(lane.map((r) => r.id));
  const byId = new Map(lane.map((r) => [r.id, r]));
  return indexOrder.filter((id) => ids.has(id)).map((id) => byId.get(id));
};

/* ── 0. the board must actually be rankable, or say so LOUDLY ─────────────── */
console.log('\n0. the board carries something to rank on');
const anySettles = Object.values(LANES).flat().filter((r) => (r.rankSettles ?? []).length > 0);
check('at least one open ticket settles another (else there is nothing to rank)',
  anySettles.length > 0,
  `${anySettles.length} of ${openIds.size} open rows settle ≥1 other: ${anySettles.map((r) => `${r.id}→${r.rankSettles.length}`).join(', ') || 'NONE — ranking has no signal'}`);
check('every open row carries a rank', Object.values(LANES).flat().every((r) => typeof r.rank === 'number'),
  `${Object.values(LANES).flat().filter((r) => typeof r.rank === 'number').length}/${openIds.size}`);

/* ── 1. PERMUTATION — re-order, never filter (constraint 3) ───────────────── */
console.log('\n1. every lane is a permutation of what it was — nothing is hidden');
for (const [name, lane] of Object.entries(LANES)) {
  const before = preFix(lane).map((r) => r.id).sort();
  const after = lane.map((r) => r.id).sort();
  check(`${name}: same members, same count (${lane.length})`,
    before.length === after.length && before.every((id, i) => id === after[i]),
    `${after.length} rows, ${new Set(after).size} distinct`);
}
check('no open ticket vanished from the board entirely',
  indexOrder.filter((id) => !openIds.has(id)).length <= 1,
  `INDEX open rows ${indexOrder.length}, board open rows ${openIds.size}; absent: ${indexOrder.filter((id) => !openIds.has(id)).join(',') || 'none'} (an answered+actioned ticket legitimately leaves the lanes — FEAT-090)`);

/* ── 2. THE INVARIANT — settling more ranks higher, all else equal ────────── */
console.log('\n2. a ticket that settles more, all else equal, ranks higher');
const SEV_W = { high: 4, medium: 2, not_recorded: 1, low: 0 };
const DECIDE = new Set(['decide', 'staged_decision', 'multi_select_decision', 'answer_question']);
const facets = new Map();
for (const r of Object.values(LANES).flat()) {
  const rec = readRankRecord(r.file);
  facets.set(r.id, {
    settles: (r.rankSettles ?? []).length,
    prior: rec ? 0 : 0, // filled below from the graph
    wait: rec && DECIDE.has(rec.humanAction) ? 6 : rec?.humanAction === 'review' ? 3 : 0,
    sev: SEV_W[rec?.severity ?? 'not_recorded'] ?? 1,
  });
}
{
  const recs = new Map();
  for (const r of Object.values(LANES).flat()) recs.set(r.id, readRankRecord(r.file));
  const g = settlementGraph(recs, openIds);
  for (const [id, v] of g) if (facets.has(id)) facets.get(id).prior = v.priorInstances;
}
/** Every same-lane pair where a dominates b on every term. a MUST come first. */
function dominancePairs(lane) {
  const pairs = [];
  for (let i = 0; i < lane.length; i++) for (let j = 0; j < lane.length; j++) {
    if (i === j) continue;
    const A = facets.get(lane[i].id), B = facets.get(lane[j].id);
    if (!A || !B) continue;
    if (A.settles > B.settles && A.wait >= B.wait && A.sev >= B.sev && A.prior >= B.prior) pairs.push([i, j, lane[i].id, lane[j].id]);
  }
  return pairs;
}
for (const [name, lane] of Object.entries(LANES)) {
  if (lane.length < 2) continue;
  const pairs = dominancePairs(lane);
  const violated = pairs.filter(([i, j]) => i > j);
  check(`${name}: ${pairs.length} dominating pairs, all ordered correctly`,
    pairs.length > 0 && violated.length === 0,
    violated.length ? `VIOLATIONS: ${violated.map(([, , a, b]) => `${a} below ${b}`).join('; ')}` : `${pairs.length} pairs checked`);
}
console.log('\n2b. scores are monotonically non-increasing down each lane');
for (const [name, lane] of Object.entries(LANES)) {
  if (lane.length < 2) continue;
  const bad = lane.slice(1).map((r, i) => [lane[i], r]).filter(([a, b]) => a.rank < b.rank);
  check(`${name}: no row outranks the one above it`, bad.length === 0,
    bad.length ? bad.map(([a, b]) => `${a.id}(${a.rank}) above ${b.id}(${b.rank})`).join('; ') : `${lane.length} rows in order`);
}

/* ── 3. the head of the needs-you lane holds the lane's maximum settlement ── */
console.log('\n3. the top of the list is the most-settling ticket in it');
{
  const lane = LANES.needsYou;
  const max = Math.max(...lane.map((r) => (r.rankSettles ?? []).length));
  check('needsYou head has the lane-maximum settlement count', max > 0 && (lane[0].rankSettles ?? []).length === max,
    `head ${lane[0].id} settles ${(lane[0].rankSettles ?? []).length}; lane max ${max}`);
  check('needsYou head carries a checkable reason', !!lane[0].rankWhy, `${lane[0].id}: ${lane[0].rankWhy}`);
}

/* ── 4. every claim is CHECKABLE — the reason names real, open, related ids ─ */
console.log('\n4. every "settles" claim names ids a person can open and verify');
{
  let claims = 0, bad = [];
  for (const r of Object.values(LANES).flat()) {
    for (const id of r.rankSettles ?? []) {
      claims++;
      if (!openIds.has(id)) bad.push(`${r.id} claims to settle ${id}, which is not open`);
      if (id === r.id) bad.push(`${r.id} claims to settle itself`);
      if (!r.rankWhy?.includes(id) && (r.rankSettles.indexOf(id) < 3)) bad.push(`${r.id}'s reason omits ${id}`);
    }
    if ((r.rankSettles ?? []).length && !r.rankWhy) bad.push(`${r.id} settles ${r.rankSettles.length} but states no reason`);
    if (!(r.rankSettles ?? []).length && /settles \d+ other open/.test(r.rankWhy ?? '')) bad.push(`${r.id} claims settlement with an empty id list`);
  }
  check(`all ${claims} settlement claims are real, open and named`, claims > 0 && bad.length === 0,
    bad.length ? bad.join('; ') : `${claims} claims across ${anySettles.length} tickets`);
}
console.log('\n4b. the claim matches the ticket record it was derived from');
{
  const bad = [];
  for (const r of Object.values(LANES).flat()) {
    for (const id of r.rankSettles ?? []) {
      const own = readRankRecord(r.file);
      const declaredHere = own && (own.recurrenceEvidence.includes(id) || own.related.some((e) => e.relation === 'blocks' && e.id === id));
      const other = readRankRecord(Object.values(LANES).flat().find((x) => x.id === id)?.file);
      const declaredThere = other && other.related.some((e) => e.relation === 'depends_on' && e.id === r.id);
      if (!declaredHere && !declaredThere) bad.push(`${r.id}→${id} is in no record`);
    }
  }
  check('no settlement claim is invented by the ranker', bad.length === 0, bad.length ? bad.join('; ') : 'every claim traces to a recorded edge');
}

/* ── 5. symmetric-edge guard — the defect found while building this ──────── */
console.log('\n5. no two tickets each claim to settle the other');
{
  const claim = new Map(Object.values(LANES).flat().map((r) => [r.id, new Set(r.rankSettles ?? [])]));
  const mutual = [];
  for (const [a, s] of claim) for (const b of s) if (claim.get(b)?.has(a)) mutual.push(`${a}↔${b}`);
  check('settlement is directed, never mutual', mutual.length === 0,
    mutual.length ? `MUTUAL: ${[...new Set(mutual)].join(', ')} — a symmetric relation leaked into the ranking` : 'no mutual pairs');
}

/* ── 6. a ticket with NO orchard-ticket record still ranks and still shows ── */
console.log('\n6. a ticket with no record degrades instead of vanishing');
{
  const recordless = Object.values(LANES).flat().filter((r) => readRankRecord(r.file) === null);
  if (!recordless.length) {
    check('LOUD: no record-less ticket exists on this board to exercise the degradation path', false, 'nothing qualified — this leg proved nothing');
  } else {
    check(`${recordless.length} record-less tickets are present and ranked`,
      recordless.every((r) => typeof r.rank === 'number'),
      recordless.map((r) => `${r.id}=${r.rank}`).join(', '));
  }
}

/* ── 7. focus is the top-ranked row, not the oldest ──────────────────────── */
console.log('\n7. the focus injected into every session is the top-ranked row');
{
  const f = boardSummary(board).focus;
  check('summary.focus === needsYou head', f?.id === board.needsYou[0]?.id, `${f?.id} vs head ${board.needsYou[0]?.id}`);
  const oldest = preFix(board.needsYou)[0]?.id;
  check('focus is NOT simply the oldest 👤 row (the shipped behaviour)', f?.id !== oldest || board.needsYou.length < 2,
    `focus ${f?.id}; oldest INDEX row in lane ${oldest}`);
}

/* ── 8. NON-VACUITY — the pre-fix order FAILS legs 2b, 3 and 7 ───────────── */
console.log('\n8. must-FAIL: the pre-fix (INDEX file order) board violates these invariants');
{
  const preNeeds = preFix(board.needsYou);
  const preRanks = rankRows([preNeeds]);
  const desc = preNeeds.slice(1).map((r, i) => [preNeeds[i], r])
    .filter(([a, b]) => (preRanks.get(a.id)?.score ?? 0) < (preRanks.get(b.id)?.score ?? 0));
  check('pre-fix lane VIOLATES 2b (a row outranks the one above it)', desc.length > 0,
    `${desc.length} inversions, e.g. ${desc.slice(0, 3).map(([a, b]) => `${a.id}(${preRanks.get(a.id)?.score}) above ${b.id}(${preRanks.get(b.id)?.score})`).join('; ')}`);
  const maxS = Math.max(...preNeeds.map((r) => preRanks.get(r.id)?.settlesOpen.length ?? 0));
  check('pre-fix lane VIOLATES 3 (its head is not the most-settling ticket)',
    (preRanks.get(preNeeds[0].id)?.settlesOpen.length ?? 0) < maxS,
    `pre-fix head ${preNeeds[0].id} settles ${preRanks.get(preNeeds[0].id)?.settlesOpen.length}; lane max ${maxS}`);
  const best = [...preNeeds].sort((a, b) => (preRanks.get(b.id).score - preRanks.get(a.id).score))[0];
  check('pre-fix focus would have been the wrong ticket', preNeeds[0].id !== best.id,
    `pre-fix focus ${preNeeds[0].id}; highest-worth ${best.id} sat at position ${preNeeds.findIndex((r) => r.id === best.id) + 1} of ${preNeeds.length}`);
}

/* ── 9. the ranker is a pure permutation function (unit, constructed) ────── */
console.log('\n9. rankRows/rankLane never invent or drop a row');
{
  const synthetic = [{ id: 'X-1' }, { id: 'X-2' }, { id: 'X-3' }];
  const rk = rankRows([synthetic]);
  // Synthetic and labelled as such: no real board has a row with no file. Rows
  // with nothing to read score the not_recorded-severity floor, claim nothing,
  // and all three survive the pass.
  check('SYNTHETIC: rows with no file at all survive and claim nothing',
    rk.size === 3 && [...rk.values()].every((v) => v.why === null && v.settlesOpen.length === 0)
      && new Set([...rk.values()].map((v) => v.score)).size === 1,
    JSON.stringify([...rk.entries()].map(([k, v]) => `${k}=${v.score}`)));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  verify-board-rank — ${pass} passed, ${fail} failed`);
if (fail) console.log('  failures: ' + failures.join(' | '));
process.exit(fail === 0 ? 0 : 1);
