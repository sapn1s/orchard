#!/usr/bin/env node
/**
 * verify:bug-225 — independent verification is a TYPED entry, not parsed prose
 * (BUG-225 round 3).
 *
 * Properties, each with a must-FAIL half:
 *   A. no prose makes a ticket count as verified: every spelling the round-1/2
 *      attackers used, typed after the freeze, counts as NOTHING, and the
 *      dispatch-shaped ones are NAMED by board:check as a WARN (round 4: prose is
 *      harmless, so it must not block a commit), never counted;
 *   B. only HOLDS counts (F5): BROKEN-only tickets (FEAT-151, FEAT-152) raise
 *      the NO INDEPENDENT VERIFICATION advisory; HOLDS-then-BROKEN does not count;
 *   C. `board-tool verified` is the one writer: a typed entry in the record's
 *      verification[] (record ticket) or the ledger (legacy ticket), carrying the
 *      frozen history forward; its echo is not proof and does not FAIL the board;
 *      it refuses anything but HOLDS|BROKEN|INVALID, multi-line fields, bad ids;
 *   D. tamper is loud: an edited frozen snapshot is unpinned (FAIL, nothing
 *      counts); a deleted frozen line FAILs; a bad ledger entry FAILs;
 *   E. legacy reads as the frozen reader says: every frozen record equals
 *      legacyProseVerifications' output for that ticket (the round-2 reader plus
 *      the round-4 audited tolerance that recovers three real HOLDS); the frozen
 *      file is pinned; R4 pins the recovered HOLDS and the tolerance's limits;
 *   F. every consumer agrees (board.mjs, board-status, migrate-tickets);
 *   G. migration never turns post-freeze prose into proof.
 *
 * Runs against a scratch copy of the REAL board (never the live tree), plus the
 * real board read-only for E/F and the final no-false-FAIL check.
 *
 *   node scripts/verify-bug-225-verified-by-parse.mjs
 *   node scripts/verify-bug-225-verified-by-parse.mjs --baseline=<root>   # must-FAIL: A+B against another tree's board.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { mkdtempScratch } from './lib/scratch.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BOARD = path.join(REPO, 'docs', 'bugs');
const baselineArg = process.argv.find((a) => a.startsWith('--baseline='));
const IMPL = baselineArg ? path.resolve(baselineArg.slice('--baseline='.length)) : REPO;
const B = await import(url.pathToFileURL(path.join(IMPL, 'scripts', 'board.mjs')).href);

let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const scratch = mkdtempScratch('bug225-');
const DIR = path.join(scratch, 'bugs');
fs.mkdirSync(DIR);
for (const f of fs.readdirSync(BOARD)) {
  const p = path.join(BOARD, f);
  if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(DIR, f));
}
const fileOf = (dir, id) => fs.readdirSync(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
const readT = (dir, id) => fs.readFileSync(path.join(dir, fileOf(dir, id)), 'utf8');
const writeT = (dir, id, text) => fs.writeFileSync(path.join(dir, fileOf(dir, id)), text);
const verifiedIn = (dir, id) => !!B.readTickets(dir).tickets.get(id)?.verifiedBy;
const advisoryFor = (warns, id) => warns.some((w) => w.startsWith(`NO INDEPENDENT VERIFICATION (advisory): ${id} `));
// Round 4: post-freeze prose is a WARN (advisory), never a FAIL — it is harmless (not proof)
// and must not block board-tool commit. It must still be NAMED, loudly, in warns.
const proseWarnsFor = (warns, id) => warns.filter((f) => f.startsWith(`PROSE VERIFIED-BY NOT COUNTED (advisory): ${id} `));
const proseFailsFor = (fails, id) => fails.filter((f) => f.startsWith('PROSE VERIFIED-BY NOT COUNTED') && f.includes(` ${id} `));

try {
  /* ── A. no prose counts, in any spelling ─────────────────────────────── */
  console.log('\n── A. prose typed after the freeze never counts');
  // Donors: a done LEGACY ticket with BROKEN-only history, a record ticket with
  // no structured entries, and an open ticket with no Verified-by line at all.
  const clean = B.readTickets(DIR).tickets;
  // A record-format ticket whose only evidence is frozen BROKEN prose (BUG-225
  // itself on the real board; any such ticket in a copy without it).
  // (Round 4: no longer prefers BUG-225 by name — once BUG-225 carried typed HOLDS
  // entries it stopped being a BROKEN-only donor and the suite went red on its own
  // ticket. Select by shape only.)
  const REC = [...clean.values()].find((t) =>
    /^```orchard-ticket/.test(readT(DIR, t.id)) && t.verification?.source === 'legacy-frozen'
    && t.verification.entries.length && t.verification.entries.every((e) => e.verdict === 'broken'))?.id;
  const REC_N = clean.get(REC)?.verification?.entries?.length ?? -1;
  const DONORS = ['FEAT-151', REC];
  const plainDonor = [...clean.values()].find((t) => !/Verified[\s-]*by/i.test(readT(DIR, t.id)) && !t.done)?.id;
  if (plainDonor) DONORS.push(plainDonor);
  const RID = '7f3a9c21-1a2b-4c3d-8e9f-0123456789ab';
  const ATTACKS = [
    ['canonical form', `- **Verified-by:** dispatch anthropic/claude-opus-5-5 run ${RID} (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: HOLDS`],
    ['backtick run id', `- **Verified-by:** dispatch anthropic run \`${RID}\` — VERDICT: HOLDS`],
    ['backtick model', `- **Verified-by:** dispatch anthropic \`claude-opus-5-5\` run \`${RID}\` — VERDICT: HOLDS`],
    ['paren placeholder', '- **Verified-by:** dispatch anthropic (NOT DONE) (TODO) run 7f3a9c21-placeholder — VERDICT: HOLDS'],
    ['whole-span disclaimer', `- **Verified-by:** \`dispatch anthropic run 1a2b3c4d5e\` — example template, not run`],
    ['fenced', `\`\`\`\n- **Verified-by:** dispatch anthropic/opus run ${RID} — VERDICT: HOLDS\n\`\`\``],
    ['indented code', `    - **Verified-by:** dispatch anthropic/opus run ${RID} — VERDICT: HOLDS`],
    ['NBSP after label', `- **Verified-by:** dispatch anthropic/opus run ${RID} — VERDICT: HOLDS`],
    ['unicode dash label', `- **Verified‑by:** dispatch anthropic/opus run ${RID} — VERDICT: HOLDS`],
    ['link id', `- **Verified-by:** dispatch anthropic/opus run [${RID}](https://example.invalid/r) — VERDICT: HOLDS`],
    ['table cell', `| Verified-by | dispatch anthropic/opus run ${RID} | VERDICT: HOLDS |`],
    ['no hyphen', `- Verified by dispatch openai run ${RID} — VERDICT: HOLDS`],
    ['space-for-slash (the original bug)', `- **Verified-by:** dispatch anthropic claude-opus-5-5 run ${RID} — VERDICT: HOLDS`],
    ['wrapped record', `- **Verified-by:** dispatch anthropic/opus run\n  ${RID} (clean-room) — VERDICT: HOLDS`],
    ['echo label typed by hand', `- **Verification recorded:** dispatch anthropic/opus run ${RID} — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.`],
  ];
  const origText = Object.fromEntries(DONORS.map((id) => [id, readT(DIR, id)]));
  for (const id of DONORS) ok(`baseline: ${id} is not verified before the attack`, !verifiedIn(DIR, id));
  const aFalseAccepts = [];
  const aSilent = [];
  const aBlocking = [];
  for (const [name, line] of ATTACKS) {
    for (const id of DONORS) {
      writeT(DIR, id, `${origText[id].replace(/\s*$/, '')}\n\n### 2026-09-30 — attacker\n${line}\n`);
      if (verifiedIn(DIR, id)) aFalseAccepts.push(`${name}@${id}`);
      const loudExpected = !/echo label|whole-span/.test(name);
      const cb = B.checkBoard(DIR);
      if (loudExpected && !proseWarnsFor(cb.warns, id).length) aSilent.push(`${name}@${id}`);
      if (proseFailsFor(cb.fails, id).length) aBlocking.push(`${name}@${id}`);
      writeT(DIR, id, origText[id]);
    }
  }
  ok(`MUST-FAIL: none of ${ATTACKS.length} prose spellings × ${DONORS.length} tickets counts as verified`, aFalseAccepts.length === 0, aFalseAccepts.join(', '));
  ok('MUST-FAIL: every dispatch-shaped prose line is NAMED by board:check (PROSE VERIFIED-BY NOT COUNTED advisory)', aSilent.length === 0, aSilent.join(', '));
  ok('post-freeze prose is a WARN, never a board:check FAIL (round 4 decision)', aBlocking.length === 0, aBlocking.join(', '));
  // Many at once — a busy log, not one line.
  writeT(DIR, 'FEAT-151', `${origText['FEAT-151']}\n### 2026-09-30 — attacker\n${ATTACKS.map((a) => a[1]).join('\n')}\n`);
  ok('all attack lines together still do not verify FEAT-151', !verifiedIn(DIR, 'FEAT-151'));
  writeT(DIR, 'FEAT-151', origText['FEAT-151']);

  /* ── B. only HOLDS counts ──────────────────────────────────────────────── */
  console.log('\n── B. verdict-aware counting (F5)');
  const { warns: w0 } = B.checkBoard(DIR);
  ok('MUST-FAIL: FEAT-151 (done, BROKEN-only) raises NO INDEPENDENT VERIFICATION', advisoryFor(w0, 'FEAT-151'));
  ok('MUST-FAIL: FEAT-152 (done, BROKEN-only) raises NO INDEPENDENT VERIFICATION', advisoryFor(w0, 'FEAT-152'));

  if (baselineArg) throw new Error('__baseline_done__');

  const VS = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'verification-source.mjs')).href);
  const R = VS;
  ok('rule: [holds] counts', R.isIndependentlyVerified([{ verdict: 'holds' }]));
  ok('rule: [broken] does not', !R.isIndependentlyVerified([{ verdict: 'broken' }]));
  ok('rule: [invalid] does not', !R.isIndependentlyVerified([{ verdict: 'invalid' }]));
  ok('rule: [broken, holds] counts (a later HOLDS resolves)', R.isIndependentlyVerified([{ verdict: 'broken' }, { verdict: 'holds' }]));
  ok('rule: [holds, broken] does not (outstanding BROKEN)', !R.isIndependentlyVerified([{ verdict: 'holds' }, { verdict: 'broken' }]));
  ok('rule: [holds, invalid] counts (INVALID is inert)', R.isIndependentlyVerified([{ verdict: 'holds' }, { verdict: 'invalid' }]));
  ok('rule: [] does not', !R.isIndependentlyVerified([]));

  /* ── C. the one writer ─────────────────────────────────────────────────── */
  console.log('\n── C. board-tool verified writes typed entries');
  const ROOT = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(ROOT, 'docs', 'bugs'), { recursive: true });
  for (const f of fs.readdirSync(DIR)) fs.copyFileSync(path.join(DIR, f), path.join(ROOT, 'docs', 'bugs', f));
  fs.writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify({ name: 'scratch', private: true, type: 'module' })}\n`);
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'scratch board']);
  const RB = path.join(ROOT, 'docs', 'bugs');
  const { boardTool } = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'board-tool.mjs')).href);
  const call = (...argv) => boardTool(argv, { root: ROOT });
  const recOf = (id) => JSON.parse(/^```orchard-ticket\n([\s\S]*?)\n```/.exec(readT(RB, id))[1]);

  // Record-format ticket with frozen BROKEN history and empty verification[].
  const r1 = await call('verified', `--id=${REC}`, '--provider=anthropic', '--model=claude-opus-5-5', '--run=aa11bb22-cc33-dd44-ee55-ff6677889900', '--verdict=HOLDS', '--author=verify lane');
  ok('record ticket: verified succeeds', r1.ok === true, JSON.stringify(r1.refusal || ''));
  const v1 = recOf(REC).verification;
  ok('record ticket: the entry is typed and in verification[]', v1.at(-1)?.run_id === 'aa11bb22-cc33-dd44-ee55-ff6677889900' && v1.at(-1)?.verdict === 'holds' && v1.at(-1)?.recorded_by === 'board-tool' && !!v1.at(-1)?.recorded_at);
  ok(`record ticket ${REC}: frozen history carried forward (${REC_N} BROKEN before the HOLDS)`, REC_N > 0 && v1.length === REC_N + 1 && v1.slice(0, REC_N).every((e) => e.verdict === 'broken' && e.origin === 'legacy-prose-freeze'), `len=${v1.length}`);
  ok('record ticket: now counts as independently verified', verifiedIn(RB, REC) && r1.independently_verified === true);
  ok('record ticket: work_state advanced to verified on HOLDS', recOf(REC).work_state === 'verified');
  ok('the echo line is written with a non-Verified-by label', /- \*\*Verification recorded:\*\* dispatch anthropic\/claude-opus-5-5 run aa11bb22/.test(readT(RB, REC)));
  // Live lanes may have typed prose on OTHER tickets since the freeze (a true
  // FAIL, not this test's concern): judge only tickets this section touched.
  const pre = new Set(B.checkBoard(DIR).fails);
  const newFails = (dir) => B.checkBoard(dir).fails.filter((f) => !pre.has(f));
  const bc1 = { fails: newFails(RB) };
  ok('the echo does not FAIL board:check', proseFailsFor(bc1.fails, REC).length === 0, JSON.stringify(proseFailsFor(bc1.fails, REC)));
  ok('the echo is not flagged as prose either', proseWarnsFor(B.checkBoard(RB).warns, REC).length === 0);
  ok('the whole scratch board stays clean after the write', bc1.fails.length === 0, JSON.stringify(bc1.fails.slice(0, 3)));

  const r2 = await call('verified', `--id=${REC}`, '--provider=openai', '--run=01a0ffff-0000-7000-8000-000000000001', '--verdict=BROKEN');
  // BUG-225 r5 / decision 4: a BROKEN after a standing HOLDS must both un-verify
  // the proof AND move the ticket's work_state off `verified` — the exact defect
  // (a stale `verified` the round-4 lane had to reset by hand).
  ok('a later BROKEN un-verifies it AND demotes work_state to in_verification', r2.ok === true && !verifiedIn(RB, REC) && r2.work_state === 'in_verification' && recOf(REC).work_state === 'in_verification', JSON.stringify({ ws: r2.work_state, rec: recOf(REC).work_state }));
  ok('refuses a duplicate (same run + verdict)', (await call('verified', `--id=${REC}`, '--provider=openai', '--run=01a0ffff-0000-7000-8000-000000000001', '--verdict=BROKEN')).refusal?.code === 'duplicate');

  /* work_state is DERIVED from isIndependentlyVerified in BOTH directions
   * (BUG-225 r5, decision 4), on a fresh record ticket so the transitions are not
   * entangled with any frozen history. INVALID (and BROKEN with no prior HOLDS)
   * change nothing; a HOLDS promotes; a BROKEN after a HOLDS demotes; a HOLDS
   * after that promotes again; an explicit --work-state still overrides. */
  const wsFiled = await call('file', `--json=${JSON.stringify({
    type: 'bug', title: 'r5 work_state derivation probe',
    summary: 'scratch ticket exercising bidirectional work_state derivation here',
    impact_if_we_wait: 'nothing — this probe ticket exists only in a scratch board',
    current_need: 'none at all, it is a test fixture for BUG-225 round 5',
    severity: 'low', area: 'tooling', success_criteria: ['Not recorded'],
    verification_class: 'fix', body: 'Probe body for the work_state derivation test.',
  })}`);
  const WS = wsFiled.id;
  ok('r5: a fresh record ticket starts open', wsFiled.ok === true && recOf(WS).work_state === 'open', JSON.stringify(wsFiled.refusal || recOf(WS).work_state));
  const wsCall = (verdict, run, ...extra) => call('verified', `--id=${WS}`, '--provider=anthropic', `--run=${run}`, `--verdict=${verdict}`, ...extra);
  const wsInv = await wsCall('INVALID', '01a0b000-0000-7000-8000-000000000001');
  ok('r5: INVALID with no prior HOLDS changes nothing (stays open)', wsInv.ok === true && wsInv.work_state === null && recOf(WS).work_state === 'open', JSON.stringify({ ws: wsInv.work_state, rec: recOf(WS).work_state }));
  const wsBrk0 = await wsCall('BROKEN', '01a0b000-0000-7000-8000-000000000002');
  ok('r5: BROKEN with no prior HOLDS changes nothing (stays open)', wsBrk0.ok === true && wsBrk0.work_state === null && recOf(WS).work_state === 'open', JSON.stringify({ ws: wsBrk0.work_state, rec: recOf(WS).work_state }));
  const wsH1 = await wsCall('HOLDS', '01a0b000-0000-7000-8000-000000000003');
  ok('r5: a HOLDS promotes to verified (BROKEN→HOLDS)', wsH1.ok === true && wsH1.work_state === 'verified' && recOf(WS).work_state === 'verified' && verifiedIn(RB, WS), JSON.stringify({ ws: wsH1.work_state, rec: recOf(WS).work_state }));
  const wsB1 = await wsCall('BROKEN', '01a0b000-0000-7000-8000-000000000004');
  ok('r5: a BROKEN after the HOLDS demotes to in_verification', wsB1.ok === true && wsB1.work_state === 'in_verification' && recOf(WS).work_state === 'in_verification' && !verifiedIn(RB, WS), JSON.stringify({ ws: wsB1.work_state, rec: recOf(WS).work_state }));
  const wsH2 = await wsCall('HOLDS', '01a0b000-0000-7000-8000-000000000005');
  ok('r5: a HOLDS after the BROKEN promotes again', wsH2.ok === true && wsH2.work_state === 'verified' && recOf(WS).work_state === 'verified' && verifiedIn(RB, WS), JSON.stringify({ ws: wsH2.work_state, rec: recOf(WS).work_state }));
  const wsOv = await wsCall('BROKEN', '01a0b000-0000-7000-8000-000000000006', '--work-state=blocked');
  ok('r5: an explicit --work-state still overrides the derivation', wsOv.ok === true && wsOv.work_state === 'blocked' && recOf(WS).work_state === 'blocked', JSON.stringify({ ws: wsOv.work_state, rec: recOf(WS).work_state }));

  // Legacy prose ticket → ledger.
  const r3 = await call('verified', '--id=FEAT-151', '--provider=anthropic', '--model=claude-opus-5-5', '--run=bb22cc33-dd44-ee55-ff66-001122334455', '--verdict=HOLDS');
  ok('legacy ticket: verified succeeds', r3.ok === true, JSON.stringify(r3.refusal || ''));
  const led = JSON.parse(fs.readFileSync(path.join(RB, VS.LEDGER_FILE), 'utf8'));
  const f151 = led.entries.filter((e) => e.id === 'FEAT-151');
  ok('legacy ticket: typed entries land in the ledger, history carried forward', f151.length === 6 && f151.at(-1).verdict === 'holds' && f151.slice(0, 5).every((e) => e.verdict === 'broken'), `n=${f151.length}`);
  ok('legacy ticket: its Status line is not touched', /^- \*\*Status:\*\* VERIFIED \(with caveats\)/m.test(readT(RB, 'FEAT-151')) && r3.work_state === null);
  ok('legacy ticket: counts as verified; the advisory is gone', verifiedIn(RB, 'FEAT-151') && !advisoryFor(B.checkBoard(RB).warns, 'FEAT-151'));
  ok('the scratch board is still clean (no FAIL the writes introduced)', newFails(RB).length === 0, JSON.stringify(newFails(RB).slice(0, 3)));
  // The remedy the PROSE FAIL names: a hand-typed line, then the same run recorded
  // with the tool — the FAIL clears (the prose still counts for nothing itself).
  const t201 = readT(RB, 'FEAT-152');
  writeT(RB, 'FEAT-152', `${t201}\n- **Verified-by:** dispatch openai run 01a0ffff-0000-7000-8000-00000000abcd (clean-room) — VERDICT: BROKEN\n`);
  ok('a post-freeze prose line is flagged (WARN) before the remedy', proseWarnsFor(B.checkBoard(RB).warns, 'FEAT-152').length === 1);
  const rRem = await call('verified', '--id=FEAT-152', '--provider=openai', '--run=01a0ffff-0000-7000-8000-00000000abcd', '--verdict=BROKEN');
  ok('…and recording the same run with board-tool clears it', rRem.ok === true && proseWarnsFor(B.checkBoard(RB).warns, 'FEAT-152').length === 0, JSON.stringify(rRem.refusal || proseWarnsFor(B.checkBoard(RB).warns, 'FEAT-152')));
  ok('…while a prose line whose VERDICT differs from the typed entry is still flagged', (() => {
    const t = readT(RB, 'FEAT-152');
    writeT(RB, 'FEAT-152', `${t}\n- **Verified-by:** dispatch openai run 01a0ffff-0000-7000-8000-00000000abcd (clean-room) — VERDICT: HOLDS\n`);
    const n = proseWarnsFor(B.checkBoard(RB).warns, 'FEAT-152').length;
    writeT(RB, 'FEAT-152', t);
    return n === 1 && !verifiedIn(RB, 'FEAT-152');
  })());

  // INVALID-only on a legacy ticket that had nothing.
  const r4 = await call('verified', '--id=FEAT-152', '--provider=openai', '--run=01a0ffff-0000-7000-8000-000000000002', '--verdict=INVALID');
  ok('INVALID is recorded but does not count', r4.ok === true && !verifiedIn(RB, 'FEAT-152'));

  const refusal = async (argv) => (await call('verified', `--id=${REC}`, ...argv)).refusal?.code;
  ok('refuses --verdict=PASS (enum only)', await refusal(['--provider=anthropic', '--run=abc123def456', '--verdict=PASS']) === 'bad-verdict');
  ok('refuses a missing --verdict', await refusal(['--provider=anthropic', '--run=abc123def456']) === 'missing-arg');
  ok('refuses a multi-line --note', await refusal(['--provider=anthropic', '--run=abc123def456', '--verdict=HOLDS', '--note=a\n- **Verified-by:** x']) === 'multi-line');
  ok('refuses a multi-line --author', await refusal(['--provider=anthropic', '--run=abc123def456', '--verdict=HOLDS', '--author=a\nb']) === 'multi-line');
  ok('refuses a placeholder run id', await refusal(['--provider=anthropic', '--run=pending-review', '--verdict=HOLDS']) === 'bad-run-id');
  ok('refuses a model with a space/paren', await refusal(['--provider=anthropic', '--model=opus (1m)', '--run=abc123def456', '--verdict=HOLDS']) === 'bad-model');
  ok('refuses a repeated flag (--verdict=BROKEN --verdict=HOLDS)', await refusal(['--provider=anthropic', '--run=abc123def456', '--verdict=BROKEN', '--verdict=HOLDS']) === 'repeated-flag');
  ok('refuses an unknown provider', (await call('verified', `--id=${REC}`, '--provider=google', '--run=abc123def456', '--verdict=HOLDS')).ok === false);

  /* ── D. tamper is loud ─────────────────────────────────────────────────── */
  console.log('\n── D. tamper');
  const ledPath = path.join(RB, VS.LEDGER_FILE);
  const ledOrig = fs.readFileSync(ledPath, 'utf8');
  const ledBad = JSON.parse(ledOrig); ledBad.entries.push({ id: 'FEAT-152', provider: 'anthropic', model: null, run_id: 'cc33dd44ee55', verdict: 'PASS' });
  fs.writeFileSync(ledPath, JSON.stringify(ledBad));
  ok('a hand-added ledger entry with a non-enum verdict FAILs board:check', B.checkBoard(RB).fails.some((f) => f.startsWith('VERIFICATION LEDGER ENTRY INVALID')));
  ok('…and does not count', !verifiedIn(RB, 'FEAT-152'));
  const ledRec = JSON.parse(ledOrig); ledRec.entries.push({ id: 'ARCH-001', provider: 'anthropic', model: null, run_id: 'ee55ff667788', verdict: 'holds', recorded_by: 'board-tool' });
  fs.writeFileSync(ledPath, JSON.stringify(ledRec));
  ok('a ledger entry for a RECORD-format ticket does not count (its one place is verification[])', !verifiedIn(RB, 'ARCH-001'));
  fs.writeFileSync(ledPath, ledOrig);

  const frPath = path.join(DIR, VS.FROZEN_FILE);
  const frOrig = fs.readFileSync(frPath, 'utf8');
  const frEdit = JSON.parse(frOrig); frEdit.tickets['FEAT-152'].records.push({ provider: 'anthropic', model: null, run_id: 'dd44ee55ff66', verdict: 'holds', line_sha256: 'x' });
  fs.writeFileSync(frPath, `${JSON.stringify(frEdit, null, 2)}\n`);
  const bcF = B.checkBoard(DIR);
  ok('an edited frozen snapshot FAILs board:check as UNPINNED', bcF.fails.some((f) => f.startsWith('FROZEN VERIFICATIONS UNPINNED')));
  ok('…and none of it counts (FEAT-152 not verified, no frozen entries read)', !verifiedIn(DIR, 'FEAT-152') && B.readTickets(DIR).tickets.get('BUG-192').verification.entries.length === 0);
  fs.unlinkSync(frPath);
  ok('a deleted frozen snapshot on a board with prose FAILs board:check (FROZEN VERIFICATIONS MISSING); nothing from prose counts',
    B.checkBoard(DIR).fails.some((f) => f.startsWith('FROZEN VERIFICATIONS MISSING')) && ![...B.readTickets(DIR).tickets.values()].some((t) => t.verification.source === 'legacy-frozen'));
  // Someone types a prose HOLDS, deletes the snapshot and re-freezes to bless it.
  const t152 = readT(DIR, 'FEAT-152');
  writeT(DIR, 'FEAT-152', `${t152}\n- **Verified-by:** dispatch anthropic/opus run ${RID} (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: HOLDS\n`);
  const re = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'board.mjs'), 'freeze-verifications', `--dir=${DIR}`], { encoding: 'utf8' });
  ok('re-freezing produces a file whose hash is NOT pinned (prose added since cannot be blessed silently)',
    re.status === 0 && B.checkBoard(DIR).fails.some((f) => f.startsWith('FROZEN VERIFICATIONS UNPINNED')), re.stderr);
  const again = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'board.mjs'), 'freeze-verifications', `--dir=${DIR}`], { encoding: 'utf8' });
  ok('freeze refuses to overwrite an existing snapshot', again.status === 1);
  ok('…and the blessed prose HOLDS still does not count', !verifiedIn(DIR, 'FEAT-152'));
  writeT(DIR, 'FEAT-152', t152);
  fs.writeFileSync(frPath, frOrig);

  const bug142 = readT(DIR, 'BUG-142');
  const firstVb = bug142.split('\n').find((l) => /Verified-by:\*\* dispatch/.test(l));
  writeT(DIR, 'BUG-142', bug142.replace(firstVb, '- (line removed)'));
  ok('deleting a frozen Verified-by line FAILs board:check (FROZEN VERIFICATION DRIFT)', B.checkBoard(DIR).fails.some((f) => f.startsWith('FROZEN VERIFICATION DRIFT: BUG-142')));
  writeT(DIR, 'BUG-142', bug142);

  /* ── E. legacy reads exactly as before ─────────────────────────────────── */
  console.log('\n── E. legacy records are exactly the round-2 reader\'s output');
  const frozenReal = VS.loadFrozen(BOARD);
  ok('the real frozen snapshot is present and pinned', frozenReal.present && frozenReal.pinned && !frozenReal.error, frozenReal.sha256);
  const { extractVerifiedBy } = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'lib', 'verdict-contract.mjs')).href);
  const mism = [];
  const missingFiles = [];
  let nRec = 0;
  const beyondR2 = [];
  for (const [id, t] of Object.entries(frozenReal.tickets)) {
    const f = fileOf(BOARD, id);
    if (!f) { missingFiles.push(id); continue; } // a copy without that ticket (e.g. a clean room)
    const text = fs.readFileSync(path.join(BOARD, f), 'utf8');
    // Only the part of the file that existed at the freeze: records whose line is frozen.
    const lines = text.split('\n');
    const frozenShas = new Set(t.records.map((r) => r.line_sha256));
    // Round 4: the frozen reader is legacyProseVerifications (the round-2 reader plus
    // the audited verdict/emphasis tolerance), so compare against IT, verdict included.
    const live = VS.legacyProseVerifications(text).filter((r) => frozenShas.has(r.line_sha256));
    const a = live.map((r) => `${r.provider}|${r.model ?? ''}|${r.run_id}|${r.verdict}`);
    const b = t.records.map((r) => `${r.provider}|${r.model ?? ''}|${r.run_id}|${r.verdict}`);
    nRec += b.length;
    if (JSON.stringify(a) !== JSON.stringify(b)) mism.push(id);
    // …and name every frozen record the round-2 SHARED reader would not have produced
    // (declared: the round-4 audit added exactly these).
    const r2 = new Set(extractVerifiedBy(text).map((r) => `${VS.lineSha(lines[r.index])}|${r.runId}`));
    for (const r of t.records) if (!r2.has(`${r.line_sha256}|${r.run_id}`)) beyondR2.push(`${id}:${r.run_id.slice(0, 8)}`);
  }
  ok('the only frozen records beyond the round-2 shared reader are the audited two (FEAT-144 97800f97, BUG-169 L162 restatement)',
    JSON.stringify(beyondR2.sort()) === JSON.stringify(['BUG-169:b94b2346', 'FEAT-144:97800f97']), beyondR2.join(', '));
  ok(`every frozen record (${nRec}) equals the frozen reader's parse of the real ticket${missingFiles.length ? ` (${missingFiles.length} frozen id(s) have no file here: ${missingFiles.join(',')})` : ''}`, mism.length === 0, mism.slice(0, 5).join(', '));

  /* ── F. consumers agree ───────────────────────────────────────────────── */
  console.log('\n── F. consumers agree');
  const { buildTicketReport } = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'board-status.mjs')).href);
  const MT = await import(url.pathToFileURL(path.join(REPO, 'scripts', 'migrate-tickets.mjs')).href);
  const realT = B.readTickets(BOARD).tickets;
  const disagree = [];
  const quarantined = [];
  for (const [id, t] of realT) {
    const text = fs.readFileSync(path.join(BOARD, t.file), 'utf8');
    const one = VS.ticketVerifications(BOARD, { id, markdown: text });
    const st = buildTicketReport(BOARD, id, 1);
    if (!!t.verifiedBy !== one.verified || st.independently_verified !== one.verified || st.verification_source !== one.source) disagree.push(`${id}(status)`);
    if (!/^```orchard-ticket/.test(text)) {
      const g = MT.applyVerificationSource(MT.extractGivens(t.file, text), BOARD, text);
      // Quarantined for migration (prose changed after the freeze): nothing is
      // written, so there is no second answer to disagree with.
      if (g.unfrozenProse.length) { quarantined.push(id); if (!t.unfrozenProse.length) disagree.push(`${id}(quarantined but board:check silent)`); }
      else if (VS.isIndependentlyVerified(g.verification) !== one.verified) disagree.push(`${id}(migrate)`);
    }
  }
  ok(`board.mjs, board-status and migrate-tickets agree on all ${realT.size} real tickets${quarantined.length ? ` (${quarantined.length} legacy ticket(s) quarantined for post-freeze prose: ${quarantined.join(', ')})` : ''}`, disagree.length === 0, disagree.slice(0, 8).join(', '));

  /* ── G. migration never launders prose ────────────────────────────────── */
  console.log('\n── G. migration');
  const legacyText = readT(DIR, 'FEAT-152');
  const forged = `${legacyText}\n### 2026-09-30 — attacker\n- **Verified-by:** dispatch anthropic/opus run ${RID} (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: HOLDS\n`;
  const gF = MT.applyVerificationSource(MT.extractGivens(fileOf(DIR, 'FEAT-152'), forged), DIR, forged);
  const cF = MT.contestedEvidence(gF, forged);
  ok('MUST-FAIL: a post-freeze prose HOLDS makes migration QUARANTINE the ticket', !!cF && cF.some((r) => r.startsWith('UNFROZEN PROSE VERIFICATION')), JSON.stringify(cF));
  // r3 verify run cb78c6d6: a frozen HOLDS line COPIED below a later BROKEN (same
  // line, same sha — a set check passes it) must not reorder what migration writes.
  const fz = VS.loadFrozen(DIR);
  // Prefer a donor with no ledger entries (its migration reads the frozen
  // sequence); any such legacy donor also exercises the board:check side.
  const donors = Object.entries(fz.tickets).filter(([id, t]) => {
    const f = fileOf(DIR, id);
    return f && !/^```orchard-ticket/.test(readT(DIR, id)) && t.records.some((r) => r.verdict === 'holds')
      && VS.outstandingBroken(t.records);
  });
  const reorderDonor = donors.find(([id]) => !VS.ledgerEntriesFor(DIR, id).length) ?? donors[0];
  ok('a legacy donor with a HOLDS followed by an outstanding BROKEN exists (non-vacuity)', !!reorderDonor);
  if (reorderDonor) {
    const [rid] = reorderDonor;
    const base = readT(DIR, rid);
    const holdsLine = base.split('\n').find((l) => VS.lineSha(l) === reorderDonor[1].records.find((r) => r.verdict === 'holds').line_sha256);
    const copied = `${base.replace(/^(\s*)(?:`{3,}|~{3,}).*$/gm, '$1(fence removed)')}\n### 2026-09-30 — re-check\n${holdsLine}\n`;
    const gR = MT.applyVerificationSource(MT.extractGivens(fileOf(DIR, rid), copied), DIR, copied);
    const cR = MT.contestedEvidence(gR, copied);
    const viaLedger = gR.verificationSource === 'ledger';
    ok(`MUST-FAIL: ${rid} with its own frozen HOLDS line copied after a BROKEN is QUARANTINED${viaLedger ? ' (n/a: donor migrates from its ledger)' : ''}`,
      viaLedger || (!!cR && cR.some((r) => r.startsWith('UNFROZEN PROSE VERIFICATION'))), JSON.stringify(cR));
    // …and board:check names the copy whatever the donor's source (run 66eb2134).
    const withCopy = `${base}\n### 2026-09-30 — re-check\n${holdsLine}\n`;
    writeT(DIR, rid, withCopy);
    ok(`MUST-FAIL: board:check names the COPIED frozen line on ${rid} (a second occurrence is new prose)`, proseWarnsFor(B.checkBoard(DIR).warns, rid).length === 1, JSON.stringify(proseWarnsFor(B.checkBoard(DIR).warns, rid)));
    writeT(DIR, rid, base);
    // The copy must not change what migration writes: exactly the donor's own source
    // sequence (its ledger entries, else the frozen records). Data-independent — a
    // live lane may have recorded a typed HOLDS on the donor since (r4 re-verify).
    const kk = (e) => `${e.run_id}|${e.verdict}`;
    const expectSeq = (viaLedger ? VS.ledgerEntriesFor(DIR, rid) : reorderDonor[1].records).map(kk);
    ok(`…and the verification[] it would write is exactly the donor's ${viaLedger ? 'ledger' : 'frozen'} sequence (the copy adds nothing)`,
      JSON.stringify(gR.verification.map(kk)) === JSON.stringify(expectSeq), `${gR.verification.length} vs ${expectSeq.length}`);
  }
  const gL = MT.applyVerificationSource(MT.extractGivens(fileOf(RB, 'FEAT-151'), readT(RB, 'FEAT-151')), RB, readT(RB, 'FEAT-151'));
  ok('a legacy ticket with ledger entries migrates with exactly those typed entries', gL.verificationSource === 'ledger' && gL.verification.length === 6 && gL.verification.at(-1).verdict === 'holds');
  const gC = MT.applyVerificationSource(MT.extractGivens(fileOf(DIR, 'FEAT-152'), legacyText), DIR, legacyText);
  ok('an untouched legacy ticket migrates uncontested', MT.contestedEvidence(gC, legacyText) === null);

  /* ── R4v. round-4 verify (run 63ecbf9a) — the copied-line check's two gaps ── */
  console.log('\n── R4v. copies of frozen records the shared reader cannot see; moved heads');
  if (fileOf(DIR, 'FEAT-144')) {
    const base144 = readT(DIR, 'FEAT-144');
    const L144 = base144.split('\n');
    const h = L144.findIndex((l) => /Verified-by \(round 2, weakened\)/.test(l));
    ok('R4v: FEAT-144 carries the annotated-label HOLDS record (non-vacuity)', h >= 0);
    // F1: copy the frozen 3-line record (only the frozen reader parses it) to the end.
    writeT(DIR, 'FEAT-144', `${base144.replace(/\s*$/, '')}\n\n### 2026-10-01 — attacker\n${L144.slice(h, h + 3).join('\n')}\n`);
    const c1 = B.checkBoard(DIR);
    ok('R4v MUST-FAIL (F1): a COPY of a frozen record only the frozen reader parses is NAMED', proseWarnsFor(c1.warns, 'FEAT-144').length === 1, JSON.stringify(proseWarnsFor(c1.warns, 'FEAT-144')));
    ok('R4v (F1): …and the copy changes nothing that counts', B.readTickets(DIR).tickets.get('FEAT-144')?.verification?.entries?.length === 2);
    writeT(DIR, 'FEAT-144', base144);
    // F2: delete the frozen BROKEN head + its continuation, re-add the head under a HOLDS continuation.
    const b = L144.findIndex((l) => /Verified-by:\*\* dispatch openai run `01a0a739/.test(l));
    ok('R4v: FEAT-144 carries the frozen openai BROKEN record with its verdict on a continuation (non-vacuity)', b >= 0 && !/VERDICT/.test(L144[b]) && /VERDICT: \*\*BROKEN/.test(L144[b + 1]));
    const moved = [...L144.slice(0, b), ...L144.slice(b + 2)].join('\n').replace(/\s*$/, '')
      + `\n\n### 2026-10-01 — attacker\n${L144[b]}\n  (clean-room re-run) — VERDICT: **HOLDS**.\n`;
    writeT(DIR, 'FEAT-144', moved);
    const c2 = B.checkBoard(DIR);
    ok('R4v MUST-FAIL (F2): a frozen head line moved under a new verdict FAILs as FROZEN VERIFICATION DRIFT', c2.fails.some((f) => f.startsWith('FROZEN VERIFICATION DRIFT: FEAT-144') && /no longer reads that way/.test(f)), JSON.stringify(c2.fails.filter((f) => /FEAT-144/.test(f))));
    // …and an in-place edit of a continuation verdict (head untouched) likewise.
    writeT(DIR, 'FEAT-144', base144.replace(/(dispatch openai run `01a0a739[^\n]*\n[^\n]*VERDICT: \*\*)BROKEN/, '$1HOLDS'));
    ok('R4v MUST-FAIL (F2b): editing a frozen record\'s continuation verdict in place FAILs as DRIFT', B.checkBoard(DIR).fails.some((f) => f.startsWith('FROZEN VERIFICATION DRIFT: FEAT-144')));
    writeT(DIR, 'FEAT-144', base144);
    ok('R4v: FEAT-144 restored → no DRIFT', !B.checkBoard(DIR).fails.some((f) => /FEAT-144/.test(f)));
  }

  // r4 re-verify run 35dd5b0b: on a RECORD-format ticket whose verification[] was
  // migrated from the frozen snapshot WITHOUT an origin marker, a copy of a frozen
  // line was taken for an "echo" of a typed entry and never named.
  {
    const recDonor = [...B.readTickets(DIR).tickets.values()].find((t) => t.verification?.source === 'record'
      && /^```orchard-ticket/.test(readT(DIR, t.id))
      && t.verification.entries.some((e) => !e.origin && e.verdict === 'holds')
      && (VS.loadFrozen(DIR).tickets[t.id]?.records ?? []).some((r) => r.verdict === 'holds'))?.id;
    ok('R4v: a record ticket with unmarked frozen-carried entries exists (non-vacuity)', !!recDonor, recDonor);
    if (recDonor) {
      const base = readT(DIR, recDonor);
      const fr = VS.loadFrozen(DIR).tickets[recDonor].records.find((r) => r.verdict === 'holds');
      const line = base.split('\n').find((l) => VS.lineSha(l) === fr.line_sha256);
      writeT(DIR, recDonor, `${base.replace(/\s*$/, '')}\n\n### 2026-10-01 — attacker\n${line}\n`);
      ok(`R4v MUST-FAIL (F3): a COPY of a frozen line on record ticket ${recDonor} is NAMED (not taken for an echo)`, proseWarnsFor(B.checkBoard(DIR).warns, recDonor).length === 1);
      writeT(DIR, recDonor, base);
      ok(`R4v: ${recDonor} restored → not named`, proseWarnsFor(B.checkBoard(DIR).warns, recDonor).length === 0);
    }
  }

  /* ── R4. the legacy reader must not lose a REAL HOLDS (round-4 audit) ─── */
  console.log('\n── R4. legacy reader: real HOLDS spellings on the frozen corpus');
  const L = (s) => VS.legacyProseVerifications(s).map((r) => r.verdict);
  const U = 'ae9775f9-b558-467b-841d-35fee15531ff';
  ok('R4: `run <id> (clean-room round 5, HOLDS, cosmetics only)` reads holds (ARCH-020 shape)', L(`- **Verified-by:** dispatch anthropic \`claude-opus-5-5\` run \`${U}\` (clean-room round 5, HOLDS, cosmetics only), more`)[0] === 'holds');
  ok('R4: `VERDICT: **HOLDS**` reads holds (FEAT-145 shape)', L(`- **Verified-by:** dispatch anthropic run \`${U}\` (clean-room) — VERDICT: **HOLDS**, contract **VALID**`)[0] === 'holds');
  ok('R4: `**Verified-by (round 2, weakened):** dispatch **anthropic** (…\\n  …) run … VERDICT: **HOLDS**` reads holds (FEAT-144 shape)',
    L(`- **Verified-by (round 2, weakened):** dispatch **anthropic** (SAME-PROVIDER as\n  author — reduced) run \`${U}\`\n  (clean-room) — VERDICT: **HOLDS**.`)[0] === 'holds');
  ok('R4: `VERDICT: **BROKEN**` reads broken, not invalid (FEAT-154 shape)', L(`- **Verified-by:** dispatch anthropic run \`${U}\` (clean-room) — VERDICT: **BROKEN**.`)[0] === 'broken');
  ok('R4: an ambiguous parenthetical (HOLDS and BROKEN) stays invalid', L(`- **Verified-by:** dispatch anthropic run ${U} (a HOLDS, b BROKEN)`)[0] === 'invalid');
  ok('R4: a lower-case "holds" in the parenthetical is not a verdict', L(`- **Verified-by:** dispatch anthropic run ${U} (the claim holds, I think)`)[0] === 'invalid');
  ok('R4: HOLDS outside the run parenthetical is not a verdict', L(`- **Verified-by:** dispatch anthropic run ${U} (clean-room) — the fix HOLDS`)[0] === 'invalid');
  const rb = B.readTickets(BOARD).tickets;
  for (const id of ['ARCH-020', 'BUG-216', 'FEAT-144']) {
    ok(`R4 MUST-FAIL: ${id} (a real standing HOLDS in legacy prose) reads independently verified on the real board`, rb.get(id)?.verification?.verified === true,
      JSON.stringify(rb.get(id)?.verification?.entries?.map((e) => e.verdict)));
  }

  /* ── the real board ───────────────────────────────────────────────────── */
  console.log('\n── the real board');
  const real = B.checkBoard(BOARD);
  const storeFails = real.fails.filter((f) => /^(FROZEN VERIF|VERIFICATION LEDGER)/.test(f));
  ok('the real board: the frozen snapshot and ledger are intact (no store FAIL)', storeFails.length === 0, storeFails.slice(0, 3).join(' | '));
  // PROSE VERIFIED-BY NOT COUNTED on the real board is a TRUE finding by
  // construction (a dispatch-shaped line typed after the freeze) — listed, not hidden.
  const prose = real.warns.filter((f) => f.startsWith('PROSE VERIFIED-BY NOT COUNTED'));
  console.log(`        (real board: ${prose.length} post-freeze prose line(s) flagged${prose.length ? `: ${prose.map((f) => /\): (\S+)/.exec(f)[1]).join(', ')}` : ''})`);
  ok('the real board: post-freeze prose never FAILs board:check', real.fails.filter((f) => f.startsWith('PROSE VERIFIED-BY NOT COUNTED')).length === 0);
  ok('the real board: no verification-store FAIL', real.fails.filter((f) => /VERIF/.test(f)).length === 0,
    real.fails.filter((f) => /VERIF/.test(f)).slice(0, 3).join(' | '));
} catch (e) {
  if (e.message !== '__baseline_done__') { failures.push(`threw: ${e.stack}`); console.log(`  FAIL  threw: ${e.stack}`); }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nverify:bug-225${baselineArg ? ` [baseline ${IMPL}]` : ''} — ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
