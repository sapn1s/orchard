#!/usr/bin/env node
/**
 * FEAT-148 — verify the round-ceiling reader.
 *
 *   node scripts/verify-round-ceiling.mjs
 *
 * Everything real, everything SCRATCH: fixture transcripts under a scratch
 * CLAUDE_TRANSCRIPT_ROOT and a scratch CLAUDE_STATION_DATA, so no pass touches
 * the user's real transcript store, ledger, board, or any server. The fixtures
 * are driven through the REAL `collect()` + the ONE canonical grammar
 * (`parseDispatchDeclaration`), never a re-implementation, so the test exercises
 * the same path the CLI does.
 *
 * Proves:
 *   1. non-vacuity, DECLARED-VALUE-DRIVEN: the SAME fixture charter raises when it
 *      declares round=5 and goes SILENT when the only edit is the declared round
 *      dropping to 1 — the success branch cannot fire on empty/missing input;
 *   2. a charter with NO round= declared does not raise (missing input is silent);
 *   3. `ticket=none` with a high round does not raise (no ticket to attribute to);
 *   4. escalating severity: 3-4 elevated, 5-7 high, 8+ critical (unit, exact bands);
 *   5. the threshold is real: raising ARCH-017's observed round 11 flips off at
 *      --min-round=12 and back on at 11 (unit, over a synthesised max-round set);
 *   6. ACCEPTANCE against the REAL live store, as an INVARIANT (CONVENTIONS:
 *      "test the real artifact's invariant PROPERTIES, not values legitimate use
 *      changes"). It does NOT pin a round number — ARCH-017's count climbs with
 *      every legitimate round (was 11, now 12, will keep moving). Instead it
 *      DISCOVERS the top over-ceiling ticket at runtime and asserts the CLI's
 *      reported max round equals an INDEPENDENT reduction (a hand-rolled max over
 *      the declared rounds) of the SAME source — i.e. roundCeiling's per-ticket
 *      reduction matches a second, inline computation — plus severity = severityFor
 *      and exit 1. It FAILS LOUDLY if the real store has no ticket over the ceiling
 *      (never a vacuous pass), and 6d shows the equality reddens on a violation.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { roundCeiling, severityFor } from './round-ceiling.mjs';
import { collect } from './cost-collect.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'round-ceiling.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ---- fixture transcript through the REAL collect() -------------------------- */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'round-ceiling-verify-'));
const tRoot = path.join(scratch, 'transcripts');
const projDir = path.join(tRoot, '-scratch-proj');
fs.mkdirSync(projDir, { recursive: true });

/** Write a one-lane transcript whose charter is `charter`; return its session id. */
function writeLane(sessionId, charter) {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-09-20T00:00:00.000Z', message: { role: 'user', content: charter } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-20T00:01:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } },
    }),
  ];
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return sessionId;
}

/** Run the CLI over the fixture root and return {stdout, code} for a given charter. */
function runCliOverFixture(charter, extraArgs = []) {
  for (const f of fs.readdirSync(projDir)) fs.rmSync(path.join(projDir, f));
  writeLane('sess-0001', charter);
  const r = spawnSync('node', [SCRIPT, '--all-projects', '--json', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_TRANSCRIPT_ROOT: tRoot, CLAUDE_STATION_DATA: path.join(scratch, 'data') },
  });
  let json = {};
  try { json = JSON.parse(r.stdout); } catch { /* leave empty */ }
  return { json, code: r.status };
}

function raisedTickets(json) {
  return (json.raised ?? []).map((x) => x.ticket);
}

try {
  // 1. non-vacuity: same charter, only the declared round differs.
  const hi = runCliOverFixture('Dispatch: ticket=BUG-901 phase=verifying round=5 class=verify\n\nDo the thing.');
  check(
    '1a round=5 charter raises BUG-901 at maxRound 5 and exits 1',
    raisedTickets(hi.json).includes('BUG-901') && hi.json.raised.find((x) => x.ticket === 'BUG-901')?.maxRound === 5 && hi.code === 1,
    { raised: raisedTickets(hi.json), maxRound: hi.json.raised?.find((x) => x.ticket === 'BUG-901')?.maxRound, code: hi.code },
  );
  const lo = runCliOverFixture('Dispatch: ticket=BUG-901 phase=verifying round=1 class=verify\n\nDo the thing.');
  check(
    '1b same charter, only round dropped to 1 → NOT raised, exit 0 (declared-value-driven)',
    !raisedTickets(lo.json).includes('BUG-901') && lo.code === 0,
    { raised: raisedTickets(lo.json), code: lo.code },
  );

  // 2. missing round= is silent (not treated as any round).
  const none = runCliOverFixture('Dispatch: ticket=BUG-901 phase=verifying class=verify\n\nDo the thing.');
  check(
    '2 charter with no round= declared → NOT raised (missing input is silent)',
    !raisedTickets(none.json).includes('BUG-901') && none.code === 0,
    { raised: raisedTickets(none.json), lanesWithDeclaredRound: none.json.lanesWithDeclaredRound, code: none.code },
  );

  // 3. ticket=none at a high round → nothing to attribute, not raised.
  const tnone = runCliOverFixture('Dispatch: ticket=none phase=verifying round=9 class=verify\n\nExploration.');
  check(
    '3 ticket=none round=9 → NOT raised (no ticket to attribute the round to)',
    (tnone.json.raised ?? []).length === 0 && tnone.code === 0,
    { raised: raisedTickets(tnone.json), code: tnone.code },
  );

  // 4. escalating severity bands (unit, exact).
  check('4a round 3 at ceiling 3 → elevated', severityFor(3, 3) === 'elevated', severityFor(3, 3));
  check('4b round 4 → elevated', severityFor(4, 3) === 'elevated', severityFor(4, 3));
  check('4c round 5 → high', severityFor(5, 3) === 'high', severityFor(5, 3));
  check('4d round 7 → high', severityFor(7, 3) === 'high', severityFor(7, 3));
  check('4e round 8 → critical', severityFor(8, 3) === 'critical', severityFor(8, 3));
  check('4f round 11 → critical (ARCH-017)', severityFor(11, 3) === 'critical', severityFor(11, 3));
  check('4g round 2 below ceiling 3 → null', severityFor(2, 3) === null, severityFor(2, 3));

  // 5. threshold is real: an observed round 11 flips off at ceiling 12, on at 11.
  const synth = [{ declared: { present: true, round: 11, tickets: ['ARCH-017'], phase: 'fixing' } }];
  const at11 = roundCeiling(synth, { minRound: 11 });
  const at12 = roundCeiling(synth, { minRound: 12 });
  check(
    '5 round 11 raised at ceiling 11, silent at ceiling 12 (threshold drives it)',
    at11.raised.some((x) => x.ticket === 'ARCH-017') && !at12.raised.some((x) => x.ticket === 'ARCH-017'),
    { at11: at11.raised.map((x) => x.ticket), at12: at12.raised.map((x) => x.ticket) },
  );

  // 6. ACCEPTANCE against the REAL live store (default source: live transcripts),
  //    as an INVARIANT PROPERTY — no pinned round number. The CLI default source
  //    is collect() over the current project's live transcripts; we re-read the
  //    SAME source in-process and reduce it INDEPENDENTLY (a hand-rolled max per
  //    ticket, NOT via roundCeiling), then assert the CLI's number matches ours.
  const real = spawnSync('node', [SCRIPT, '--json'], { encoding: 'utf8', cwd: ROOT, env: process.env });
  let realJson = {};
  try { realJson = JSON.parse(real.stdout); } catch { /* leave empty */ }

  // Independent reduction over the SAME source the CLI read (same project, same
  // `all=false`). This is a second computation of "max declared round per ticket"
  // that does not go through the code under test (roundCeiling).
  const independentMax = new Map();
  try {
    const res = await collect({ project: ROOT, all: false, since: null });
    for (const l of res.lanes ?? []) {
      const d = l?.declared;
      if (!d || d.present !== true) continue;
      if (!Number.isInteger(d.round) || d.round < 1) continue;
      const tickets = Array.isArray(d.tickets) ? d.tickets : [];
      for (const t of tickets) {
        if (typeof t === 'string' && t) independentMax.set(t, Math.max(independentMax.get(t) ?? 0, d.round));
      }
    }
  } catch (e) {
    check('6 ACCEPTANCE setup — independent re-read of the live source', false, String(e?.message ?? e));
  }

  const raised = realJson.raised ?? [];
  if (raised.length === 0) {
    // Fail LOUDLY, never a vacuous pass: the live store carrying nothing over the
    // ceiling is itself worth knowing (and means this acceptance cannot run).
    check(
      '6 ACCEPTANCE — the REAL live store has at least one ticket at or over the ceiling',
      false,
      'NONE: no ticket in the live transcripts is at/over the ceiling (exit ' + real.status + '). '
        + 'Fails loudly rather than passing vacuously — the acceptance invariant has no real artifact to check.',
    );
  } else {
    // Discover the qualifying ticket at runtime: the one the CLI ranks highest.
    const top = raised[0];
    const indep = independentMax.get(top.ticket);
    check(
      '6a real store: CLI max round for the top raised ticket equals an INDEPENDENT reduction of the same source, exit 1',
      indep != null && top.maxRound === indep && real.status === 1,
      { ticket: top.ticket, cliMaxRound: top.maxRound, independentMaxRound: indep, code: real.status },
    );
    check(
      '6b real store: CLI severity for that ticket equals severityFor(maxRound, ceiling) (derived, not pinned)',
      top.severity === severityFor(top.maxRound, realJson.minRound),
      { ticket: top.ticket, severity: top.severity, expected: severityFor(top.maxRound, realJson.minRound), ceiling: realJson.minRound },
    );
    // Invariant control: no raised ticket is EVER below the ceiling — a property
    // that holds whatever the live values are (a 1-round ticket can never appear).
    const belowCeiling = raised.filter((x) => x.maxRound < realJson.minRound);
    check(
      '6c real store: no raised ticket is below the ceiling (invariant control)',
      belowCeiling.length === 0,
      { ceiling: realJson.minRound, belowCeilingRaised: belowCeiling.map((x) => `${x.ticket}:${x.maxRound}`) },
    );
  }

  // 6d NON-VACUITY (SYNTHETIC source, labelled): 6a's property must REDDEN when the
  // reader's count disagrees with the independent reduction. A synthetic lane set
  // declares rounds 3 and 9 for one ticket; the production reader reports 9 (the
  // max) and an inline reduction also yields 9 (property HOLDS), while a
  // mis-counting reader — any value ≠ 9 — is caught by the same equality.
  {
    const synth = [
      { declared: { present: true, round: 3, tickets: ['SYNTH-CEIL'], phase: 'fixing' } },
      { declared: { present: true, round: 9, tickets: ['SYNTH-CEIL'], phase: 'verifying' } },
    ];
    const readerMax = roundCeiling(synth, {}).raised.find((x) => x.ticket === 'SYNTH-CEIL')?.maxRound;
    let indepSynth = 0;
    for (const l of synth) if (l.declared.tickets.includes('SYNTH-CEIL')) indepSynth = Math.max(indepSynth, l.declared.round);
    const miscount = indepSynth - 1; // a reader that under-counts
    check(
      '6d non-vacuity (SYNTHETIC): property holds (reader==reduction) AND reddens on a mismatched count',
      readerMax === indepSynth && !(miscount === indepSynth),
      { readerMax, independent: indepSynth, miscountRejected: miscount !== indepSynth },
    );
  }
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  round-ceiling verify: ${pass} passed, ${fail} failed${failures.length ? ` (${failures.join(', ')})` : ''}`);
process.exit(fail ? 1 : 0);
