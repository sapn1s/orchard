#!/usr/bin/env node
/**
 * migrate-tickets.mjs — §5 of docs/analysis/ticket-board-redesign-plan.md.
 * Steps 5–7 of §8: the per-ticket migration pipeline, its staging area, its
 * quarantine, and the archive-preserving cutover.
 *
 * THE ONE RULE: the originals are NEVER modified. Every ticket is READ, a new
 * file is WRITTEN elsewhere, and the original is only ever `git mv`d — verbatim,
 * byte-identical — into `docs/bugs/archive/` at promotion.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO AUTHOR (§5.2)
 * ----------------------------------------------------
 * The model never sees the activity log and never writes a run id. Everything a
 * future reader could not re-derive once the original is archived is extracted
 * by regex, by this script, BEFORE the model is invoked, and copied verbatim:
 *
 *   - the whole `## Activity log` section        → byte-for-byte into the body
 *   - every `Verified-by:` line                  → verification[] (provider,
 *                                                   run_id, verdict, verdict_on,
 *                                                   harness, model)
 *   - id, type, reported, updated                → from the filename, the header
 *                                                   and the newest log heading
 *   - work_state                                 → classifyLegacyStatus, which
 *                                                   is 100% decided on the real
 *                                                   corpus (186/186, 0 errors)
 *   - severity, verification_class, area, title  → given as the ORIGINAL values
 *                                                   the model must not contradict
 *
 * This is primarily a COST decision — the log is 71% of the corpus by bytes and
 * the model has no reason to read it — with the useful side effect that the one
 * class of value whose loss is undetectable later is never at risk at all.
 *
 * The model authors ONLY prose and enum classification, single-turn, no tools.
 *
 * ACCEPTANCE (§5.3): schema validation (ticket-schema.mjs), the provenance check
 * (provenance-check.mjs), and cross-field consistency. A ticket that fails gets
 * ONE corrective re-dispatch naming the violations; a second failure QUARANTINES
 * it to `<out>/failed/` with the violations written next to it. A quarantined
 * ticket is NOT migrated and its original stays exactly where it is. Nothing
 * half-migrated is ever written into the staging set: the file is composed in
 * memory, graded whole, and only then written.
 *
 * USAGE
 *   node scripts/migrate-tickets.mjs --ids FEAT-092,BUG-085,ARCH-003
 *   node scripts/migrate-tickets.mjs --all [--concurrency 4] [--limit N]
 *   node scripts/migrate-tickets.mjs --reconcile        # write the related[] back-edges
 *   node scripts/migrate-tickets.mjs --validate-set     # re-grade the staging set
 *   node scripts/migrate-tickets.mjs --report           # cost + status table
 *   node scripts/migrate-tickets.mjs --promote [--apply] # §5.6 cutover (dry by default)
 *   node scripts/migrate-tickets.mjs --promote --allow-legacy 'FEAT-091=why'
 *
 *   --dir <d>          ticket source dir            (default docs/bugs)
 *   --out <d>          staging dir                  (default docs/bugs/.migrated)
 *   --model <m>        dispatch model               (default gpt-5.6-sol)
 *   --provider <p>     dispatch provider            (default openai)
 *   --timeout-min <n>  per-dispatch timeout         (default 8)
 *   --allow-legacy <ID>[=<why>]  repeatable; a ticket that may stay in legacy
 *                      format instead of being staged. An UNNAMED one still
 *                      refuses. The named set and its reasons are printed by the
 *                      promotion and written into archive/INDEX.md (FEAT-094).
 *   --force            re-migrate tickets already staged
 *   --dry-run          compose the prompt, invoke nothing, print sizes
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  BODY_SLOTS, DECISION_MODES, HUMAN_ACTIONS, OWNERS, RELATION_INVERSE, RELATIONS, SEVERITIES,
  TICKET_FILE_RE, VERIFICATION_CLASSES, VERDICTS, WORD_CAPS,
  countActivityEntries, deriveBodySlots, escapeTableCell, extractTicketBlock, formatTicket, headerRegion, idFromFilename,
  idsMatch,
  isDoneWorkState, lastActivityDate, legacyField, parseTicket, parseTitleLine, severityToEnum,
  typeFromId, validateTicket,
} from './lib/ticket-schema.mjs';
import { renderWorkedExamples } from './lib/ticket-writing.mjs';
// The ONE rule about proof (ARCH-009). It lives in the browser module because
// the ticket view is its other consumer, and one definition is the point: grep
// `outstandingBroken` and you have found every rule about verification there is.
import { outstandingBroken } from '../public/lib/ticket-record.js';
import { VERIFIED_BY_RE, joinVerdictContinuation } from './lib/verdict-contract.mjs';
import { provenanceCheck, provenanceOf } from './provenance-check.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/**
 * The dispatch entry point. `MIGRATE_DISPATCH_BIN` is the FIXTURE SEAM (the
 * `CLAUDE_STATION_CODEX_BIN` pattern): a test can drive the whole retry /
 * quarantine / write loop offline with a scripted responder, so the
 * "never write a half-migrated file" invariant is exercised, not just asserted.
 */
const DISPATCH = process.env.MIGRATE_DISPATCH_BIN || path.join(HERE, 'dispatch.mjs');

/** GPT-5.6 Sol, per docs/prompts/ROUTING.md's ladder. USD per million tokens. */
const PRICE = { in: 5 / 1e6, out: 30 / 1e6 };
/** §5.4's forecast, so every run reports itself against the number it was sold on. */
const FORECAST_TOTAL_USD = 22;

/* ═══════════════════════════════════════════════════ deterministic extraction */

const ACTIVITY_H2 = '## Activity log';

/** `{ head, log }` — the log is everything from `## Activity log`, verbatim. */
export function splitAtActivityLog(text) {
  const s = String(text || '');
  const i = s.indexOf(ACTIVITY_H2);
  return i === -1 ? { head: s, log: null } : { head: s.slice(0, i), log: s.slice(i) };
}

/**
 * Every `Verified-by:` line, parsed, with the things only position can supply:
 * `verdict_on` is the `### <date>` activity heading it lives under, `harness`
 * the backticked script named in its parenthetical.
 *
 * The EXPRESSION is imported from verdict-contract.mjs, never re-written, so
 * "formatVerifiedBy stays the single formatter and the extractor is its inverse"
 * holds by construction rather than by vigilance.
 */
export function extractVerificationRecords(text) {
  const out = [];
  let heading = null;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (h) { heading = h[1]; continue; }
    const m = new RegExp(VERIFIED_BY_RE.source, 'i').exec(line);
    if (!m) continue;
    // The record is its list item's first paragraph, not its first line — a
    // wrapped `— VERDICT: X` is on the next line and was being read as no
    // verdict at all. See `joinVerdictContinuation`.
    const record = joinVerdictContinuation(lines, i);
    const verdict = /VERDICT:\s*([A-Za-z]+)/i.exec(record);
    const harness = /\(([^)]*?)`([^`]+)`/.exec(record);
    const v = verdict ? verdict[1].toLowerCase() : null;
    out.push({
      provider: m[1],
      model: m[2] ?? null,
      run_id: m[3],
      // VERDICTS is the closed set; anything else is recorded as `invalid`
      // rather than invented or dropped.
      verdict: VERDICTS.includes(v) ? v : 'invalid',
      verdict_on: heading,
      harness: harness ? harness[2] : null,
    });
  }
  return out;
}

/**
 * THE FENCE-AWARE READING OF THE SAME FILE — an INSTRUMENT, never a filter.
 *
 * `extractVerificationRecords` above is deliberately fence-blind, and it stays
 * that way: measured over the real corpus, a CommonMark-correct strip DROPS
 * EIGHT GENUINE VERDICTS from `FEAT-091`, because that document nests a
 * ````-fenced example inside a ```-fenced block and the spec closes the outer
 * one early. Deleting real verdicts to catch a hypothetical quoted one is the
 * wrong trade, and it would break `provenance-check.mjs`'s deliberate mirror of
 * the same expression.
 *
 * But the DISAGREEMENT between the two readings is exactly the signal ARCH-009
 * option A asks for: where they agree, no record's attribution is in question
 * under either reading; where they differ, a human has to look. So the strict
 * reading is computed and COMPARED, never substituted. Its only output is the
 * word "contested".
 */
function stripFencedBlocks(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
      out.push('');
      continue;
    }
    if (m) { fence = m[1]; out.push(''); continue; }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * THE CONTESTED-EVIDENCE GATE (ARCH-009 option A, gating option C's one pass).
 *
 * C removes derivation AFTER migration. But the migration itself has to read
 * verdicts out of prose exactly once, and that single extraction still has the
 * attribution problem C exists to end. So this function does the one thing the
 * old `deriveVerificationState` would not: when the evidence disagrees with
 * itself, it REFUSES TO ANSWER and names the conflict, and the ticket is
 * quarantined for a human instead of migrated on a guess.
 *
 * It decides nothing. It returns a reason or `null`.
 *
 * Two ways evidence is contested, and they are the two halves of the class:
 *
 *  1. THE TICKET'S OWN CLAIM DISAGREES WITH ITS OWN EVIDENCE. The status line
 *     says VERIFIED (`holds`) while `verification[]` carries a `broken` that no
 *     later `holds` resolves. One of the two is wrong and nothing in the file
 *     says which. Measured on the live board: 3 tickets — `BUG-109`,
 *     `FEAT-061`, `FEAT-062`.
 *  2. A RECORD'S ATTRIBUTION IS UNCERTAIN. The fence-blind and fence-aware
 *     readings of the file return different verdict sets, so at least one
 *     `Verified-by:` line is quoted-or-asserted depending on how you read the
 *     document. Measured on the live board: 1 ticket — `FEAT-091`, 8 records.
 *
 * 4 of 192 today. ARCH-009's own falsification bar was ">25 of 195 means this is
 * a wall, not a gate"; 4 is a gate. The cost is a human pass over four tickets
 * once, against writing a contested answer into 191 files in one unattended run.
 */
export function contestedEvidence(g, text) {
  const reasons = [];
  if (g.status_verification_state === 'holds' && outstandingBroken(g.verification)) {
    reasons.push(`CONTESTED EVIDENCE: the Status line claims verification holds (${JSON.stringify(g.statusRaw)}) `
      + `but ${g.verification.length} recorded verdict(s) [${g.verification.map((v) => v.verdict).join(',')}] leave a `
      + `BROKEN unresolved (a "broken" with no later "holds"). The ticket disagrees with its own evidence; `
      + `a human resolves which is true before this ticket migrates.`);
  }
  const strict = extractVerificationRecords(stripFencedBlocks(text));
  const same = strict.length === g.verification.length
    && g.verification.every((r, i) => strict[i] && strict[i].run_id === r.run_id && strict[i].verdict === r.verdict);
  if (!same) {
    reasons.push(`CONTESTED ATTRIBUTION: the fence-blind reading finds ${g.verification.length} verification record(s) `
      + `and the fence-aware reading finds ${strict.length}, so at least one \`Verified-by:\` line is asserted or `
      + `quoted depending on how the document's fences are read. Neither reading may be trusted to transcribe `
      + `\`verification[]\` unattended; a human says which lines this ticket ASSERTS.`);
  }
  return reasons.length ? reasons : null;
}

/* ─────────────────────────────────────── self-evidence (BUG-119) */

/**
 * THE OTHER KIND OF EVIDENCE, and why it gets its own function rather than
 * being poured into `verification[]`.
 *
 * `extractVerificationRecords` above reads `Verified-by:` lines: INDEPENDENT
 * clean-room dispatch verdicts, `{provider, run_id, verdict}`. 16 of the 185
 * real tickets carry one. The other 144 finished tickets record the FIXER's own
 * executed evidence instead — a named suite with a pass tally, a pre-fix FAIL
 * proof, a typecheck. That is real evidence and the migration was throwing all
 * of it away, then making the model write "not_recorded" over the top.
 *
 * It is NOT merged into `verification[]`, deliberately. A suite run has no
 * provider and no run id, so both would have to be invented; and `verification`
 * being empty is the one signal that says "nobody independently verified this",
 * which is what README rule 5, FEAT-061 and board.mjs's NO INDEPENDENT
 * VERIFICATION warning are all built on. Conflating the two would buy a nicer
 * count by destroying the distinction the count is supposed to measure.
 *
 * Scanned over the WHOLE ticket, log included — that is the point: the model
 * never sees the log, so this is how the log's evidence reaches it.
 */
const SUITE_NAME_RE = /\bverify[:-]([a-z0-9][a-z0-9-]*)/gi;
/** `33/33`, `170/170` — a MATCHED tally, i.e. everything the suite ran passed. */
const FULL_TALLY_RE = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/;

export function extractSelfEvidence(text) {
  const s = String(text || '');

  // Suites, each with the nearest tally that follows its name. A suite is named
  // far more often than it is scored (172 tickets name one, 150 carry a tally),
  // so a nameless-but-scored suite is not invented and a scoreless name is kept.
  const suites = new Map();
  for (const m of s.matchAll(SUITE_NAME_RE)) {
    const name = `verify:${m[1].toLowerCase()}`;
    // Look ahead a short window only: further than this and the number belongs
    // to the next clause, not to this suite.
    const t = FULL_TALLY_RE.exec(s.slice(m.index + m[0].length, m.index + m[0].length + 60));
    const prev = suites.get(name);
    const tally = t && t[1] === t[2] ? { passed: Number(t[1]), total: Number(t[2]) } : null;
    // Keep the LARGEST matched tally seen for a suite: a ticket quotes the same
    // suite at several sizes as it grows, and the largest is the current one.
    if (!prev) suites.set(name, tally);
    else if (tally && (!prev || tally.total > prev.total)) suites.set(name, tally);
  }

  // Every matched tally anywhere, whether or not a suite name was adjacent.
  const tallies = [];
  for (const m of s.matchAll(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g)) {
    if (m[1] === m[2] && Number(m[2]) >= 2) tallies.push(`${m[1]}/${m[2]}`);
  }

  // A pre-fix / pre-feature FAIL proof is the non-vacuity demonstration this
  // project requires (WA §C), and it is the strongest self-evidence there is:
  // it shows the test discriminates rather than merely passing.
  const preFix = /pre-?(?:fix|feature)\b[^\n]{0,80}?\b(?:FAIL\w*|\d{1,4}\s*\/\s*\d{1,4})/i.exec(s);

  const checks = [];
  for (const [label, re] of [
    ['typecheck', /\btypecheck\b[^\n]{0,20}?\b(?:clean|PASS(?:ES|ED)?|green)\b/i],
    ['leak-gate', /\bleak[- ]gate\b[^\n]{0,20}?\b(?:clean|PASS(?:ES|ED)?|green)\b/i],
    ['board:check', /\bboard:check\b[^\n]{0,30}?\b(?:clean|PASS(?:ES|ED)?|exits? 0)\b/i],
  ]) if (re.test(s)) checks.push(label);

  const cleanRoom = /\bclean[- ]room\b|independent-verify|independently verif/i.test(s);
  const harnessRuns = [...new Set(
    [...s.matchAll(/\b(?:harness-recorded run|recorded run|dispatch[^\n]{0,40}?run)\s+([0-9a-f]{6,64})\b/gi)]
      .map((m) => m[1].toLowerCase()),
  )];

  // EXPLICIT PASS MARKERS — the oldest shape on this board, and the one the
  // first round of this fix still missed. FEAT-028 carries no suite name and no
  // tally at all; it records five hand-run checks each marked `(PASS)` and the
  // line "**Result: all verification PASSED.**", and its status line reads
  // "DONE — verified; cutover done". Extracting nothing from that and then
  // writing "not_recorded" is the same defect as before, one layer down.
  //
  // Counted, not merely detected, so a single incidental "PASS" in prose cannot
  // stand in for a verification record — the threshold is applied by
  // `hasSelfEvidence`, not here.
  const passMarkers = (s.match(/\*\*PASS(?:ED)?\*\*|\(PASS(?:ED)?\)|\bPASS(?:ED)?:|\ball (?:\w+ )?verification[s]? PASSED\b/gi) ?? []).length;

  return {
    suites: [...suites.entries()].map(([name, tally]) => ({ name, ...(tally ?? { passed: null, total: null }) })),
    tallies: [...new Set(tallies)],
    preFixProof: preFix ? preFix[0].replace(/\s+/g, ' ').trim() : null,
    checks,
    cleanRoom,
    harnessRuns,
    passMarkers,
    hasVerificationSection: /^#{2,}\s*Verification\b/mi.test(s),
  };
}

/**
 * Does this ticket record that SOMEONE ran something and it passed?
 *
 * Deliberately not "is it verified" — it is the weaker question of whether the
 * ticket holds executed evidence at all.
 *
 * ROUND 3: every clause below is a SCORE or a RAN-AND-REPORTED signal. The
 * round-2 version accepted a suite that was merely NAMED, so "Next step: run
 * verify:foo. The command verify:foo does not exist yet." counted as proof —
 * `suites.length > 0` bypassed the marker threshold entirely. It also accepted
 * two stray `**PASS**` tokens in ordinary release prose, and two `(PASS)` lines
 * inside a quoted fence. A name is an intention; a number is a result.
 */
export function hasSelfEvidence(ev) {
  if (!ev) return false;
  // A suite with its own matched tally — the strongest and commonest shape.
  if (ev.suites.some((s) => s.total !== null)) return true;
  // A named suite AND a matched tally somewhere: the BUG-012 shape, where the
  // tally sits a clause away from its suite and proximity binding refuses to
  // guess. Both halves are required, so a bare name never qualifies.
  if (ev.suites.length > 0 && ev.tallies.length > 0) return true;
  // A pre-fix FAIL proof is executed evidence by construction — it reports a
  // run that FAILED, which nobody writes aspirationally.
  if (ev.preFixProof !== null) return true;
  // typecheck / leak-gate / board:check reported clean: a named command with a
  // reported result.
  if (ev.checks.length > 0) return true;
  // Explicit PASS markers, but ONLY inside a ticket that has a `## Verification`
  // section — i.e. a ticket that declares it is recording verification. This is
  // what keeps FEAT-028 (five hand-run `(PASS)` checks, no suite, no tally)
  // while rejecting prose and quoted fences, neither of which sits under such a
  // heading. Two markers minimum: one "PASS" in a sentence is not a record.
  if (ev.passMarkers >= 2 && ev.hasVerificationSection) return true;
  return false;
}

/** `extractSelfEvidence` as the prompt's GIVEN lines, or null when there is none. */
export function summariseSelfEvidence(ev) {
  const lines = [];
  const scored = ev.suites.filter((x) => x.total !== null);
  const named = ev.suites.filter((x) => x.total === null);
  for (const x of scored) lines.push(`  suite ${x.name} — ${x.passed}/${x.total} passing`);
  // A NAMED suite is an intention until a number says otherwise. The round-3
  // model run proved the distinction has to be spelled out: FEAT-020 merely
  // MENTIONS `verify:subagent` and `verify:container` while surveying what
  // already exists, and the model wrote that they "exercised the completed
  // synthesis". The state was right; the prose still overclaimed.
  if (named.length) {
    lines.push(`  suites NAMED but with NO result recorded — a mention, not a run; do not`);
    lines.push(`  write that these were executed or that they passed: ${named.map((x) => x.name).join(', ')}`);
  }
  // UNATTRIBUTED tallies are reported, never bound to a suite by proximity. On
  // the real board a tally can sit a whole clause away from its suite name
  // (BUG-012: `verify:search` … 180 characters … `11/11`) or PRECEDE a different
  // suite entirely (FEAT-079: `17/17 PASS, verify:ui 7/0 PASS`, where the 17/17
  // belongs to a suite named on the previous line). Both would be mis-bound by
  // any window wide enough to catch the first. Guessing the attribution is worse
  // than stating what was measured and leaving the pairing to the prose, so the
  // number reaches the model either way and the claim it supports does not.
  const bound = new Set(scored.map((x) => `${x.passed}/${x.total}`));
  const loose = ev.tallies.filter((t) => !bound.has(t));
  if (loose.length) lines.push(`  matched pass tallies recorded without an adjacent suite name: ${loose.slice(0, 8).join(', ')}`);
  if (ev.preFixProof) lines.push(`  pre-fix failure proof recorded: "${ev.preFixProof.slice(0, 120)}"`);
  if (ev.checks.length) lines.push(`  standing checks reported clean: ${ev.checks.join(', ')}`);
  if (ev.harnessRuns.length) lines.push(`  harness-recorded run id(s): ${ev.harnessRuns.join(', ')}`);
  if (ev.cleanRoom) lines.push('  the ticket describes a clean-room / independent verification pass');
  return lines.length ? lines.join('\n') : null;
}

/* ─────────────────────────────────── `deriveVerificationState` — REMOVED
 *
 * ARCH-009, option C, chosen by the user on 2026-08-20. A function called
 * `deriveVerificationState` used to sit here and compute a `verification_state`
 * enum from a precedence sequence over the `Verified-by:` lines scraped out of
 * the whole file. It is not patched, it is gone, and so is the field: the
 * migration now transcribes only what the ticket ASSERTS, `verification[]`
 * carries the attributed verdicts as data, and nothing downstream computes a
 * state from prose. `contestedEvidence` above replaces it — it answers
 * "contested or not", never "what the state is".
 *
 * WHY REMOVAL RATHER THAN A FOURTH GUARD. Three rounds of guards produced three
 * stop-everything defects, each found by an independent clean-room pass and none
 * by the fixer; round 3's two guards ("a `broken` outranks every claim" and
 * "only the status line grants `holds`") were already absolute and in mutual
 * conflict, so a fourth had to weaken one of them. The class is not the guards,
 * it is that a state was being DERIVED from an unattributed set read partially.
 * Removing the derivation makes the class impossible instead of guarded.
 *
 * The history below is kept because it is the argument, and because a future
 * reader proposing to re-derive this field needs to see what re-deriving costs.
 * Nothing below is live code; every rule in it was deleted.
 *
 * WHY THE STATUS LINE OUTRANKED THE NEWEST VERDICT, which is not obvious.
 * Verification here is ITERATIVE: a clean-room verifier breaks a fix, the fixer
 * re-fixes, round after round, and the ticket is finally closed VERIFIED. So a
 * ticket's `Verified-by:` lines are mostly BROKEN by construction — ARCH-003
 * carries nine BROKEN then one HOLDS; FEAT-061 ends on `invalid`. Taking "the
 * newest verdict" off the bottom of that list reports the loop's worst moment
 * as the ticket's state: measured on the real board, the naive rule made
 * BUG-109, FEAT-061 and FEAT-062 — all VERIFIED, all closed — come out `broken`
 * or `pending`. The status line is the author's LAST word and is already what
 * `work_state` trusts; the verdicts are evidence from inside the loop.
 *
 * TWO WAYS TO MANUFACTURE A FALSE "VERIFIED", both closed here in round 3 after
 * a clean-room verdict (openai run 01a01bc8-0d77-76d0-9a13-7ca98d195380) found
 * that round 2 had closed neither.
 *
 * (1) THE STATUS LINE OVERRUNNING A BROKEN VERDICT. Round 2 returned `holds` on
 * the status line BEFORE consulting the verdicts, so a ticket that says VERIFIED
 * while its newest independent verdict says `broken` claimed proof. This is not
 * hypothetical: BUG-109's status line reads "VERIFIED (fixer's own run) —
 * independent clean-room verify still required", its ONE verdict is BROKEN, and
 * round 2 derived `holds` for it. A found defect is a fact about the code; a
 * status line is a claim about it, and the fact outranks the claim. `broken` is
 * therefore checked FIRST, unconditionally.
 *
 * (2) A QUOTED VERDICT PROMOTED TO A REAL ONE. `extractVerificationRecords`
 * cannot tell a `Verified-by: … VERDICT: HOLDS` line that is being QUOTED (a
 * worked example, a pasted excerpt, a template being explained) from one being
 * asserted. Round 2 claimed the unfinished-ticket guard closed this; it did not
 * — it left every FINISHED ticket exposed, and the comment saying otherwise was
 * worse than the gap because it stopped anyone looking.
 *
 * FENCE-STRIPPING THE EXTRACTOR WAS TRIED AND REJECTED, with the measurement.
 * A CommonMark-correct fence scanner drops EIGHT GENUINE verdicts from FEAT-091,
 * because these documents are themselves ambiguous: FEAT-091 nests ````-fenced
 * examples inside a ```-fenced block, and per the spec the inner longer fence
 * CLOSES the outer one, so hundreds of lines of ordinary prose fall inside a
 * "code block". Narrowing the opener rule (an info string must be a language
 * token, not a sentence) recovered three of the eight and no more. Deleting real
 * verdicts to catch a hypothetical quoted one is the wrong trade in both
 * directions, and it would also break `provenance-check.mjs`'s deliberate mirror
 * of the same expression.
 *
 * SO THE GUARD IS A PROPERTY INSTEAD, and it is the whole safety story in one
 * line: **only the ticket's own status line can grant `holds`.** A verification
 * record can raise `broken`, and it can show that a check happened
 * (`pending`) — it can never, by itself, produce a claim of proof. Quotation
 * therefore cannot manufacture one, whatever the ticket's work state, and the
 * property is auditable by reading six lines rather than by trusting a markdown
 * parser. Measured: zero real tickets relied on a record-derived `holds`, so
 * this costs the corpus nothing.
 *
 * Precedence, in order:
 *   1. the newest verdict is `broken` — a found defect outranks every claim,
 *      including the ticket's own closing line;
 *   2. else the status line claims `holds` (`VERIFIED`) — THE ONLY ROUTE TO
 *      `holds`;
 *   3. else the status line, when it says anything but "nothing recorded"
 *      (`FIXED` → pending, `NOT-A-BUG` → not_required);
 *   4. else a verification record exists → `pending`: something was checked,
 *      but nothing here claims it passed. This is also what keeps a ticket with
 *      records out of `not_recorded`, which `validateTicket` forbids;
 *   5. else a FINISHED ticket that records its own executed evidence →
 *      `pending`;
 *   6. else `not_recorded`.
 *
 * STEP 6 REVISES WHAT THIS FUNCTION SAID IN ROUND 1. It said self-evidence
 * "deliberately does NOT move this value". That was too blunt, and the verdict
 * was right to call it: it left `not_recorded` written across 24 finished
 * tickets whose evidence the pipeline had already extracted and was holding —
 * ARCH-001 with ten named passing suites and `191/191`, FEAT-028 whose status
 * line literally reads "DONE — verified". The correct statement is narrower:
 * self-evidence may never produce `holds`, because a fixer's own suite is not
 * an independent verdict and substituting one for the other is what README rule
 * 5 exists to prevent. It MAY lift `not_recorded` to `pending`, which is
 * strictly weaker than `holds` and means exactly the true thing — the work was
 * proven by whoever did it and the independent check is outstanding. That is
 * also what `board:check` already says about these tickets with its NO
 * INDEPENDENT VERIFICATION warning, so the state now agrees with the linter
 * instead of contradicting it.
 *
 * WHY NOT A NEW ENUM VALUE (e.g. `self_verified`), which was the alternative
 * the verdict invited. It is more precise, and it is the better answer if the
 * board ever needs to tell "closed with self-evidence" from "closed awaiting a
 * verifier". It is NOT taken here for two reasons: `pending` already carries
 * that meaning on this board (`classifyLegacyStatus` maps `FIXED` — fixed,
 * self-tested, unverified — to `pending`, and that mapping predates this
 * ticket), and a sixth value would render as a missing label until
 * `public/lib/ticket-record.js` VERIFICATION_LABEL learned it, which is held by
 * another lane. Shipping an enum value that renders as nothing is a worse
 * failure than reusing one that is already true. Recorded on the ticket as a
 * proposal rather than decided silently.
 *
 * ─── end of the removed function's argument. ARCH-009 answered the enum
 * question by deleting the enum. ───────────────────────────────────────────── */

/** `- **Reported:** 2026-08-18 by user (…)` → the reporter, ≤ 4 words. */
function reportedByFrom(text) {
  const raw = legacyField(text, 'Reported');
  const m = /by\s+([^(:—–]+)/i.exec(raw);
  if (!m) return null;
  const who = m[1].trim().replace(/[.,;]+$/, '');
  if (!who) return null;
  return who.split(/\s+/).slice(0, 4).join(' ');
}

/** First ISO date anywhere, as the last-resort `reported` fallback. */
function earliestDate(text) {
  const all = [...String(text || '').matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]).sort();
  return all[0] ?? null;
}

/**
 * The provenance tokens the model's own output must carry.
 *
 * ONLY the head is scanned. The activity log is copied byte-for-byte, so every
 * token in it survives by construction — demanding the model reproduce them
 * would be asking it to re-author what it never saw.
 *
 * ...AND THE SAME ARGUMENT APPLIES ONE STEP FURTHER (BUG-119). A token that
 * appears in the head AND ALSO in the log is likewise guaranteed by the verbatim
 * copy — `provenanceCheck` asserts presence anywhere in the migrated FILE, and
 * separately asserts the log is copied byte-for-byte, so the token cannot go
 * missing unless that assertion already failed. Requiring the model to re-place
 * it buys no provenance and costs a template seam: two blind graders flagged
 * "the independent review on date 2026-08-14 found…" and "ticket ARCH-006 was
 * reported on date 2026-08-18…" in the output prose, which is the MUST APPEAR
 * list being sewn into sentences.
 *
 * Measured over the 185 real tickets: 887 head tokens, 653 of them also in the
 * log. Subtracting them takes the ask from 4.8 tokens per ticket to 1.2, and
 * 75 tickets to zero.
 *
 * THE COVERAGE TEST MUST BE THE DOWNSTREAM TEST, EXACTLY. `provenanceCheck`
 * folds case for run ids and shas (it lowercases both the needle and the
 * haystack) and does NOT fold it for ticket refs or dates. A token may only be
 * dropped here if the check that will look for it later would FIND it, so the
 * predicates are mirrored per kind rather than approximated with one.
 *
 * This is not hypothetical: FEAT-082 cites `FEAT-067` in its head, and its log
 * contains only `verify:feat-067-rail-summary` — a SUITE NAME. A case-folding
 * coverage test reads that as covered, drops the requirement, and the
 * case-sensitive check downstream then fails the ticket. Caught by
 * verify-migrate-tickets.mjs, which is why the anti-regression run is not
 * optional here.
 */
export function headProvenance(head, log = null) {
  const p = provenanceOf(head);
  const raw = String(log ?? '');
  const folded = raw.toLowerCase();
  const foldedRisk = (xs) => xs.filter((x) => !folded.includes(String(x).toLowerCase()));
  const exactRisk = (xs) => xs.filter((x) => !raw.includes(String(x)));
  return {
    runIds: foldedRisk(p.runIds),
    shas: foldedRisk(p.shas),
    ticketRefs: exactRisk(p.ticketRefs),
    dates: exactRisk(p.dates),
  };
}

/** Everything the pipeline decides before the model is invoked. */
export function extractGivens(file, text) {
  const id = idFromFilename(path.basename(file));
  const { head, log } = splitAtActivityLog(text);
  const legacy = parseTicket(text, { file: path.basename(file) });
  const rec = legacy.record ?? {};
  const h1 = parseTitleLine(text);
  const verification = extractVerificationRecords(text);
  const selfEvidence = extractSelfEvidence(text);
  const declaredClass = legacyField(text, 'Verification-class').replace(/\s*[—–-].*$/, '').trim();
  const reported = (/^- \*\*Reported:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(headerRegion(text)) || [, null])[1];
  const updated = lastActivityDate(text);
  return {
    id,
    type: typeFromId(id),
    file: path.basename(file),
    original_title: h1.ok ? h1.title : null,
    head,
    log,
    logEntries: countActivityEntries(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    // Legacy status → the enum. 186/186 of the real corpus classify with zero
    // statusErrors, so this is DECIDED here, not asked of the model.
    work_state: rec.work_state ?? null,
    statusRaw: rec.statusRaw ?? null,
    statusError: rec.statusError ?? null,
    severity: rec.severity ?? severityToEnum(legacyField(text, 'Severity')),
    area_raw: legacyField(text, 'Area') || null,
    reported: reported ?? updated ?? earliestDate(text),
    reported_by: reportedByFrom(text),
    verification,
    // The status line's own verification half — a TRANSCRIPTION of the one word
    // the ticket's author wrote (VERIFIED / FIXED / NOT-A-BUG), read by the same
    // fixed table that reads `work_state` from it. It is not a derived state and
    // nothing writes it into the record: ARCH-009 keeps it for exactly one
    // purpose, which is to be COMPARED with `verification[]` by
    // `contestedEvidence` so a ticket that disagrees with itself is stopped.
    status_verification_state: rec.verification_state ?? null,
    self_evidence: selfEvidence,
    verification_class: VERIFICATION_CLASSES.includes(declaredClass) ? declaredClass : null,
    provenance: headProvenance(head, log),
  };
}

/* ══════════════════════════════════════════════════════════════ the prompt */

const list = (xs) => xs.join(' | ');

/**
 * The schema contract, GENERATED from ticket-schema.mjs rather than restated.
 * A fifth verbatim copy of the format spec is the exact defect §7 risk 4 names;
 * this one cannot drift because it is read from the validator that enforces it.
 */
function schemaContract() {
  return `THE SCHEMA — a closed key set. Every key below is REQUIRED and PRESENT.
An absent value is null, NEVER omitted, NEVER "", NEVER "n/a"/"none"/"tbd"/"unknown".
An unknown key is REJECTED, not dropped. Word caps are HARD and counted by whitespace.

HUMAN LAYER (what a person reads first — assume NO subsystem knowledge):
  title              string, <= ${WORD_CAPS.title} words. A SYMPTOM or OUTCOME, never a proposal.
                     It must NOT contain "(not ", "+", or "->"-style arrows.
  summary            string, <= ${WORD_CAPS.summary} words. What is happening, in project-general language.
  impact_if_we_wait  string, <= ${WORD_CAPS.impact_if_we_wait} words. MUST state the BOUND as well as the harm
                     ("display-correctness, not data loss"). Bounding is what stops
                     every ticket reading as an emergency.
  current_need       string, <= ${WORD_CAPS.current_need} words. What the ticket needs NOW, one sentence.
  area               string, <= ${WORD_CAPS.area} words, human-readable ("Ticket board"). NOT a path list.
  severity           enum: ${list(SEVERITIES)}
  reported_by        string, <= 4 words ("user", "agent", "bug-hunt workflow")
  owner              enum: ${list(OWNERS)}
  human_action       enum: ${list(HUMAN_ACTIONS)}

THERE IS NO \`verification_state\` KEY. Do not write one; it is REJECTED as an
unknown key. What was verified is DATA, not a state you summarise: the pipeline
carries the ticket's independent verdicts in \`verification[]\` verbatim. Say what
ran and what it showed, in your prose, from the evidence listed under GIVEN.

DECISION — null when no decision is OUTSTANDING, else an object:
  mode                 enum: ${list(DECISION_MODES)}
  question             string, <= ${WORD_CAPS['decision.question']} words, ENDS IN "?", answerable without the deep layer
  options              array, >= 2 entries, each:
     key               string <= 6 chars, unique ("A", "B", "1")
     label             string <= ${WORD_CAPS['option.label']} words, a noun phrase
     what_changes      string <= ${WORD_CAPS['option.what_changes']} words
     benefit           string <= ${WORD_CAPS['option.benefit']} words
     cost              string <= ${WORD_CAPS['option.cost']} words
     why_not_obvious   string <= ${WORD_CAPS['option.why_not_obvious']} words. THE FIELD THAT MAKES OPTIONS COMPARABLE.
                       Never "n/a" — an option with no downside is not an option, it is the answer.
     combines_with     array of option keys — REQUIRED in mode "multi", FORBIDDEN otherwise
     stage             integer >= 1 — REQUIRED in mode "staged", FORBIDDEN otherwise
  stages               REQUIRED in mode "staged", FORBIDDEN otherwise:
                       array of { stage, question, unlocked_by }
  recommendation       an option key, or a "+"-joined key list in mode "multi", or null.
                       null is NOT a failure — it is the correct record when no
                       recommendation is honest.
  recommendation_reason string <= ${WORD_CAPS['decision.recommendation_reason']} words. Non-null EXACTLY when recommendation is non-null.
  prerequisite         string <= ${WORD_CAPS['decision.prerequisite']} words, or null. What must be established first.

  Present-but-irrelevant mode fields are REJECTED. You may not hedge by filling
  in all three shapes.

decision_history   array (possibly empty, never absent) of ANSWERED/superseded decisions:
                   { asked_on, question, mode, options_keys, chosen, chosen_on, chosen_by, note }
                   A ticket has AT MOST ONE live decision. Everything else is history.

DEEP LAYER:
  success_criteria    array of strings, >= 1 entry, each <= ${WORD_CAPS.success_criterion} words.
                      If genuinely unknown, exactly one entry: "Not recorded".
  code_refs           array of { path, symbol, note } — symbol/note may be null. May be empty.
  related             array of { id, relation }, relation enum: ${list(RELATIONS)}
  recurrence_evidence array of ticket ids. MUST be non-empty for an architecture ticket.
  verification_class  enum: ${list(VERIFICATION_CLASSES)}

BODY PROSE — long-form deep prose, as a separate object \`body_prose\` with these
keys and NO others. Each value is markdown (headings BELOW h2 only) or null when
the original has nothing for that slot:
${BODY_SLOTS.filter((s) => s !== 'Activity log').map((s) => `  ${JSON.stringify(s)}`).join('\n')}
  Do NOT write an activity log. You have not been shown one and the pipeline
  copies the real one verbatim.

SOURCE — your own account of the transformation:
  source.confirmation string <= ${WORD_CAPS['source.confirmation']} words: your statement that the SUBSTANCE of the
                      original survives in the fields above.
  source.dropped      array of short strings naming anything you judged non-essential
                      and deliberately left behind. Empty array if nothing.`;
}

/**
 * HOW TO WRITE THE FIELDS — inlined from docs/TICKET-WRITING.md, which is the
 * ONE owner of the register rules (the checkable half of the same contract is
 * `scripts/lib/ticket-writing.mjs`). It is read at compose time rather than
 * copied, because a second hand-maintained copy drifts invisibly: both versions
 * keep validating while they disagree.
 *
 * The trailing repo-meta sections ("What is checked, and what is not" onward)
 * are about calibration corpora and where the doc is wired in. They are true and
 * they are noise to an author, so the inline stops there.
 */
function writingGuide() {
  const p = path.join(ROOT, 'docs', 'TICKET-WRITING.md');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return ''; }
  const cut = text.indexOf('\n## What is checked, and what is not');
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * The deep-layer and provenance keys, demonstrated on the SAME ticket as worked
 * example 1. The human layer is NOT re-demonstrated here — it comes from
 * `renderWorkedExamples()`, so the register has one source, not two.
 */
const PIPELINE_KEYS_EXAMPLE = `THE SAME TICKET AS WORKED EXAMPLE 1, showing only the keys this pipeline writes
that the example above does not carry. The human-layer fields are exactly as
shown above; do not re-derive them from this fragment.

{
  "reported_by": "user",
  "owner": "you",
  "decision_history": [],
  "success_criteria": [
    "Restoring a snapshot twice in a row succeeds both times",
    "The snapshot file exists after a restore completes"
  ],
  "code_refs": [ { "path": "src/server/snapshots.ts", "symbol": "restoreSnapshot", "note": "unlinks the source after reading it" } ],
  "related": [],
  "recurrence_evidence": [],
  "verification_class": "fix",
  "body_prose": {
    "Diagnosis": "\`restoreSnapshot\` reads the snapshot, writes the session state, then unlinks the path it read from. The unlink was added to keep the store bounded and its data-loss consequence was never stated.",
    "Evidence": "Restoring the same snapshot twice fails on the second attempt with ENOENT.",
    "Implementation notes": null,
    "Verification plan": "Restore twice from one snapshot; assert both succeed and the file still exists.",
    "Migration and rollback": null,
    "Risks": null
  },
  "source": {
    "confirmation": "Every claim in the original head appears above: the unlink, the double-restore symptom, the copy-versus-move choice, and its storage cost.",
    "dropped": ["a paragraph of speculation about a future retention policy, which the decision now carries"]
  }
}`;

/** Compose the single-turn prompt for one ticket. */
export function buildPrompt(g, violations = null) {
  const prov = g.provenance;
  const givenVerif = g.verification.length
    ? g.verification.map((v) => `  run ${v.run_id} — provider ${v.provider}, verdict ${v.verdict.toUpperCase()}${v.verdict_on ? `, on ${v.verdict_on}` : ''}`).join('\n')
    : '  (none recorded)';
  // Grouped by KIND, with the kind named ONCE in a heading instead of glued to
  // every token (BUG-119). The old flat list read `date 2026-08-14` per line and
  // the model copied the label into the sentence — "the independent review on
  // date 2026-08-14 found…". A heading cannot be glued to a token.
  const mustAppearGroups = [
    ['dispatch run ids', prov.runIds],
    ['commit shas', prov.shas],
    ['ticket ids', prov.ticketRefs],
    ['dates (ISO, exactly as written)', prov.dates],
  ].filter(([, xs]) => xs.length);
  const mustAppearCount = mustAppearGroups.reduce((a, [, xs]) => a + xs.length, 0);

  const selfEvidence = summariseSelfEvidence(g.self_evidence);

  const corrective = violations
    ? `
YOUR PREVIOUS ANSWER WAS REJECTED. It is discarded entirely; nothing in it counts.
Fix EVERY violation below and return the whole JSON object again. Do not argue
with the violations and do not explain — return only JSON.

${violations.map((v) => `  - ${v}`).join('\n')}

`
    : '';

  return `${corrective}You are converting ONE ticket from this project's free-prose format into a fixed
schema. This is a single turn: no tools, no questions, no repo access. Your entire
reply is ONE JSON object and nothing else — no markdown fence, no preamble.

WHY: today every ticket's state and human-readable layer is prose, so nothing can
render it and every model invents its own fields. The schema below is closed so
that stops. Your job is to put the ticket's EXISTING substance into fixed fields,
not to re-decide anything about it and not to research it.

${schemaContract()}

GIVEN — these are FACTS about this ticket, already extracted from it by the
pipeline. You must NOT contradict them and you must NOT restate them as your own
fields; they are merged in after you answer.

  id                  ${g.id}
  type                ${g.type}
  original title      ${g.original_title ?? '(unparseable)'}
  reported            ${g.reported ?? '(unknown)'}
  work_state          ${g.work_state}   (from the ticket's own Status line: ${JSON.stringify(g.statusRaw)})
  activity log        ${g.logEntries} entries, copied verbatim by the pipeline — you will not see it
  independent verification records (\`Verified-by:\` dispatch verdicts) from the whole file:
${givenVerif}
${selfEvidence ? `  ${hasSelfEvidence(g.self_evidence)
      ? `the fixer's OWN executed evidence, extracted from the whole file INCLUDING the
  activity log you are not shown — this is real, it happened, and it is what the
  ticket has instead of an independent verdict:`
      : `what this ticket MENTIONS about verification. The pipeline judged that NONE of
  it is a record of something that ran — no scored suite, no failure proof, no
  reported check. Treat it as context, NEVER as proof, and do not write that any
  of it passed:`}
${selfEvidence}
` : ''}${g.severity ? `  severity (declared)  ${g.severity}\n` : ''}${g.verification_class ? `  verification_class (declared)  ${g.verification_class}\n` : ''}
CONSEQUENCES OF THE GIVENS — these are not suggestions:
${isDoneWorkState(g.work_state)
      ? `  * work_state is "${g.work_state}", which is FINISHED. Therefore \`decision\` MUST be null
    and \`human_action\` MUST be "none". Any decision you find in the text below is
    HISTORY: put it in \`decision_history\` with what was chosen, if the text says.`
      : `  * work_state is "${g.work_state}", which is UNFINISHED. If the text below puts a real,
    still-open choice in front of a human, express it as \`decision\`. If it does not,
    \`decision\` is null and \`human_action\` is "none" or "review" — do not invent a
    decision to fill the field.`}
  * THERE IS NO verification_state FIELD and you must not invent one. ${g.verification.length
      ? `The ${g.verification.length} independent verdict(s) above are carried into \`verification[]\`
    verbatim by the pipeline; you neither copy them nor summarise them.`
      : `This ticket has no independent verdict, so \`verification[]\` is empty. That
    means nobody ran a clean-room check — it does NOT mean the work was never
    proven, and you must not write that it was unverified.`}
    Do not write a sentence whose content is a proof STATE ("verification holds",
    "proof not recorded", "verification pending"). Write what actually ran.
  * WHAT THE PROOF WAS belongs in your PROSE, and it must be specific. If the
    ticket's evidence is listed above, \`current_need\` and \`body_prose\` say what
    ran and what it showed. Never write "no further action is recorded", "not
    recorded", "the fix is verified" or any other sentence whose content is that
    you have nothing to say — if the evidence is genuinely absent, say which kind
    is absent ("closed without a build", "superseded, never implemented").
  * \`title\` is a NEW title you write. The original is preserved separately, so you
    are free to make it a plain symptom.
${mustAppearCount
      ? `
MUST APPEAR VERBATIM — ${mustAppearCount} token(s). A future reader cannot re-derive
these once the original is archived, so each must appear SOMEWHERE in your output:
a body_prose slot, a code_ref note, a related[] id, a decision_history entry —
wherever it genuinely belongs. Do not paraphrase, do not shorten a sha, do not
turn a date into "last week".

THE HEADINGS BELOW ARE LABELS FOR YOU, NOT WORDS TO WRITE. Write "on 2026-08-14",
never "on date 2026-08-14"; write "ARCH-006", never "ticket ARCH-006 was
reported on date 2026-08-18". A sentence that reads as a list being worked
through has failed, even with every token present. If a token has no natural home
in a sentence, put it in the structured field it belongs to (related[],
decision_history, a code_ref note) rather than forcing it into prose.

${mustAppearGroups.map(([kind, xs]) => `  ${kind}:\n${xs.map((x) => `    ${x}`).join('\n')}`).join('\n')}
`
      : ''}
═══════════════════════════════════════════════════════════════════════════════
HOW TO WRITE THE FIELDS (docs/TICKET-WRITING.md — the register contract):

${writingGuide()}

═══════════════════════════════════════════════════════════════════════════════
${renderWorkedExamples()}

${PIPELINE_KEYS_EXAMPLE}

═══════════════════════════════════════════════════════════════════════════════
THE TICKET (everything before its activity log):

${g.head}
═══════════════════════════════════════════════════════════════════════════════

Return ONE JSON object with EXACTLY these top-level keys and no others:
  title, summary, impact_if_we_wait, current_need, area, severity, reported_by,
  owner, human_action, decision, decision_history,
  success_criteria, code_refs, related, recurrence_evidence, verification_class,
  body_prose, source

No prose before it. No prose after it. No markdown fence.`;
}

/* ═════════════════════════════════════════════════════════════ the dispatch */

/** NUL is illegal in argv and unsafe downstream — the argvSafePrompt pattern. */
const nulSafe = (s) => String(s).replace(/\0/g, '␀');

/** Codex reports usage on stderr as `tokens: {…}`. Last one wins. */
function scrapeUsage(stderr) {
  let usage = null;
  for (const m of String(stderr).matchAll(/^\s*(?:\[[^\]]*\]\s*)?tokens:\s*(\{.*\})\s*$/gm)) {
    try { usage = JSON.parse(m[1]); } catch { /* keep the previous */ }
  }
  if (!usage) return null;
  const pick = (...ks) => { for (const k of ks) if (typeof usage[k] === 'number') return usage[k]; return 0; };
  const input = pick('input_tokens', 'inputTokens', 'prompt_tokens');
  const output = pick('output_tokens', 'outputTokens', 'completion_tokens');
  const cached = pick('cached_input_tokens', 'cache_read_input_tokens', 'cachedInputTokens');
  return { input, output, cached, raw: usage, usd: input * PRICE.in + output * PRICE.out };
}

function runDispatch(prompt, opts, metaFile) {
  return new Promise((resolve) => {
    const safe = nulSafe(prompt);
    const viaStdin = Buffer.byteLength(safe, 'utf8') > 100_000;
    const child = spawn(process.execPath, [
      DISPATCH,
      '--provider', opts.provider,
      ...(opts.model ? ['--model', opts.model] : []),
      '--cwd', ROOT,
      '--sandbox', 'read-only',       // no tools, nothing to write: the wall costs nothing
      '--timeout-min', String(opts.timeoutMin),
      '--meta-out', metaFile,
      ...(viaStdin ? ['--prompt-stdin'] : ['--', safe]),
    ], { stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (viaStdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(safe);
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const done = (code) => {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* stderr carries the kind */ }
      resolve({ code, stdout, stderr, meta, usage: scrapeUsage(stderr), promptBytes: Buffer.byteLength(safe, 'utf8') });
    };
    child.once('error', (e) => { stderr += `dispatch not runnable: ${e.message}\n`; done(-1); });
    child.once('exit', (c) => done(c ?? 1));
  });
}

/**
 * Lenient JSON extraction, following scripts/experiments/haiku-check.mjs: a model
 * that wraps its object in a fence or a sentence has still answered.
 */
export function extractJson(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(s);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  candidates.push(s);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    } catch { /* next candidate */ }
  }
  return { ok: false, value: null, error: 'no parseable JSON object in the reply' };
}

/* ══════════════════════════════════════════════════════════════ composition */

const MODEL_KEYS = [
  'title', 'summary', 'impact_if_we_wait', 'current_need', 'area', 'severity',
  // ARCH-009: `verification_state` is NOT here, so a model that emits one has
  // its key dropped by `compose` and named as a violation by `grade`. The field
  // a model could fill with a plausible word is the field it can get wrong.
  'reported_by', 'owner', 'human_action', 'decision',
  'decision_history', 'success_criteria', 'code_refs', 'related',
  'recurrence_evidence', 'verification_class', 'body_prose', 'source',
];

/**
 * Merge the model's answer with the pipeline's givens and compose the whole new
 * file. Deterministic values ALWAYS win: the model cannot overwrite an id, a
 * date, a work_state or a verification record even by accident.
 *
 * Returns `{ record, body, text, notes[] }`. Composes in memory only — nothing
 * is written until the whole file has been graded (§5.3: a ticket that fails
 * must never silently produce a half-migrated file).
 */
export function compose(g, answer, opts = {}) {
  const notes = [];
  const a = answer && typeof answer === 'object' ? answer : {};
  for (const k of Object.keys(a)) {
    if (!MODEL_KEYS.includes(k)) notes.push(`model returned unexpected key ${JSON.stringify(k)} — dropped before validation`);
  }

  const bodyProse = a.body_prose && typeof a.body_prose === 'object' && !Array.isArray(a.body_prose) ? a.body_prose : {};
  const sections = [];
  for (const slot of BODY_SLOTS) {
    if (slot === 'Activity log') continue;
    const v = bodyProse[slot];
    if (typeof v === 'string' && v.trim()) sections.push(`## ${slot}\n\n${v.trim()}\n`);
  }
  // The log, byte-for-byte, always last. A ticket with no log gets no slot and
  // `body_slots["Activity log"]` records that as a fact.
  const body = `\n# ${g.id} — ${a.title ?? g.original_title ?? g.id}\n\n${sections.join('\n')}${g.log ? `\n${g.log.endsWith('\n') ? g.log : `${g.log}\n`}` : ''}`;

  // Derived from the composed body by the schema module's own rule — the board
  // tool composes records too, and one loop in two files is how the two writers
  // would come to disagree about whether a ticket has an Activity log.
  const bodySlots = deriveBodySlots(body);

  const src = a.source && typeof a.source === 'object' && !Array.isArray(a.source) ? a.source : {};
  const record = {
    // ── deterministic, model-proof ────────────────────────────────────────
    id: g.id,
    type: g.type,
    reported: g.reported,
    updated: lastActivityDate(g.log ?? '') ?? g.reported,
    work_state: g.work_state,
    verification: g.verification,
    // ── model-authored ────────────────────────────────────────────────────
    title: a.title ?? null,
    summary: a.summary ?? null,
    impact_if_we_wait: a.impact_if_we_wait ?? null,
    current_need: a.current_need ?? null,
    severity: g.severity ?? a.severity ?? 'not_recorded',
    area: a.area ?? null,
    reported_by: a.reported_by ?? g.reported_by ?? 'agent',
    owner: a.owner ?? null,
    human_action: a.human_action ?? null,
    decision: a.decision === undefined ? null : a.decision,
    decision_history: Array.isArray(a.decision_history) ? a.decision_history : [],
    success_criteria: Array.isArray(a.success_criteria) ? a.success_criteria : [],
    code_refs: Array.isArray(a.code_refs) ? a.code_refs : [],
    related: Array.isArray(a.related) ? a.related : [],
    recurrence_evidence: Array.isArray(a.recurrence_evidence) ? a.recurrence_evidence : [],
    verification_class: g.verification_class ?? a.verification_class ?? null,
    // ── derived from the composed file, never asserted ────────────────────
    body_slots: bodySlots,
    source: {
      archived_path: `docs/bugs/archive/${g.file}`,
      sha256: g.sha256,
      bytes: g.bytes,
      original_title: g.original_title,
      migrated_on: opts.today ?? new Date().toISOString().slice(0, 10),
      migrated_by: opts.migratedBy ?? 'migrate-tickets.mjs',
      confirmation: typeof src.confirmation === 'string' ? src.confirmation : null,
      dropped: Array.isArray(src.dropped) ? src.dropped : [],
    },
  };
  // `code_refs[].symbol`/`note` are optional in the schema but the plan's shape
  // is three keys; null them explicitly so absence stays explicit on disk.
  record.code_refs = record.code_refs.map((c) => (c && typeof c === 'object' && !Array.isArray(c)
    ? { path: c.path ?? null, symbol: c.symbol ?? null, note: c.note ?? null } : c));

  return { record, body, text: formatTicket(record, body), notes };
}

/* ══════════════════════════════════════════════════════════════ acceptance */

/**
 * The full acceptance gate for one composed ticket. Schema, provenance, and the
 * cross-field consistency the plan names — in that order, all of them run, so a
 * corrective re-prompt sees EVERY violation at once instead of one per round.
 */
export function grade(g, composed, originalText) {
  const violations = [];
  const v = validateTicket({ ...composed.record }, { file: g.file });
  violations.push(...v.violations);

  const expectedOptionKeys = null; // the original's option keys are prose; the
  // model re-derives them, and §6.1's key assertion applies only where the
  // pipeline itself extracted them. Stated rather than faked.
  const p = provenanceCheck(originalText, composed.text, { id: g.id, expectedOptionKeys });
  violations.push(...p.violations);

  // Cross-field consistency (§5.3 item 3) beyond what the schema checks.
  const r = composed.record;
  if (isDoneWorkState(r.work_state) && r.human_action !== 'none') {
    violations.push(`${g.file}: work_state ${JSON.stringify(r.work_state)} is finished but human_action is ${JSON.stringify(r.human_action)} — a finished ticket asks nothing of a human`);
  }
  // ARCH-009: the field is gone, so the check is that it STAYS gone. `compose`
  // drops an unexpected key before validation (that is what keeps a bad answer
  // from reaching disk); this makes the drop LOUD, so a model that keeps
  // emitting a proof state shows up as a violation and a re-prompt rather than
  // as a silent note nobody reads. `validateTicket` also rejects it as an
  // unknown key if it ever reaches a record — two independent refusals.
  if ((composed.notes ?? []).some((n) => n.includes('"verification_state"'))) {
    violations.push(`${g.file}: the answer carries "verification_state" — that field was REMOVED (ARCH-009). `
      + `A ticket's proof is \`verification[]\`, which the pipeline fills from the ticket's own verdicts; `
      + `there is no state to state.`);
  }
  // A record NAMES the file it derives from, by hash. Nothing used to check
  // that the file it was GRADED against is that file — so `--validate-set`
  // could compare a staged record to the wrong original and report a row that
  // proves nothing. It did: ARCH-005's original had already been moved to
  // `docs/bugs/archive/` and a migrated copy left in its place, so 192 of 193
  // rows graded the right file and one graded itself, silently, inside a 193/193.
  // A hash mismatch here means the comparison is meaningless, so it is louder
  // than any of the content checks it invalidates.
  const claimedSha = typeof r.source.sha256 === 'string' ? r.source.sha256 : null;
  if (claimedSha === null) {
    violations.push(`${g.file}: "source.sha256" is missing — a record that does not name the original it derives from cannot be graded against one`);
  } else if (g.sha256 && claimedSha !== g.sha256) {
    violations.push(`${g.file}: this record claims to derive from source.sha256 ${claimedSha}, but it was graded against a file whose sha256 is ${g.sha256}`
      + ` (${r.source.archived_path ?? 'unknown path'}, ${g.bytes} bytes). EVERY provenance result above is therefore about the wrong pair of files.`
      + ` Grade it against the original it names, or re-migrate it from the file that is actually there.`);
  }
  if (r.source.confirmation === null) {
    violations.push(`${g.file}: "source.confirmation" is null — content preservation rides on this statement, so it is required, not optional`);
  }
  if (g.log !== null && !/^## Activity log\b/m.test(composed.body)) {
    violations.push(`${g.file}: the original has an activity log but the composed body has no "## Activity log" section`);
  }
  return { ok: violations.length === 0, violations, counts: p.counts };
}

/* ══════════════════════════════════════════════════════════════════ driver */

/**
 * Remove the quarantine marker for a ticket that is now staged. The marker
 * describes an attempt, and an attempt that has since been superseded is not a
 * fact about the set — leaving it made `--validate-set` report a ticket as both
 * staged and quarantined, which the promotion gate reads as a refusal.
 */
function clearQuarantine(failDir, id) {
  for (const suffix of ['violations.txt', 'rejected.md', 'reply.txt', 'stderr.txt']) {
    try { fs.unlinkSync(path.join(failDir, `${id}.${suffix}`)); } catch { /* absent is the normal case */ }
  }
}

function migrateOne(file, opts) {
  const srcPath = path.join(opts.dir, file);
  const originalText = fs.readFileSync(srcPath, 'utf8');
  const g = extractGivens(file, originalText);
  const outPath = path.join(opts.out, file);
  const failDir = path.join(opts.out, 'failed');
  const record = { id: g.id, file, attempts: 0, usd: 0, tokens: { input: 0, output: 0 }, seconds: 0, status: 'pending', violations: [] };

  return (async () => {
    if (!opts.force && fs.existsSync(outPath)) {
      clearQuarantine(failDir, g.id);
      record.status = 'cached';
      return record;
    }
    // ARCH-009's GATE, and it runs BEFORE the dispatch on purpose.
    //
    // A ticket whose own evidence is contested has no correct migration to
    // produce — the file disagrees with itself, and every answer the model could
    // give would be a guess dressed as a transcription. Stopping here rather
    // than after grading also means the contested set is discoverable by a
    // `--dry-run` over the corpus, at zero cost, before anyone spends a run.
    //
    // Quarantine is the EXISTING path, not a new one: the original stays where
    // it is, the conflict is written next to it in `failed/`, and the migration
    // continues with the other tickets. A stopped ticket is a normal outcome.
    const contested = contestedEvidence(g, originalText);
    if (contested) {
      if (!opts.dryRun) {
        fs.mkdirSync(failDir, { recursive: true });
        fs.writeFileSync(path.join(failDir, `${g.id}.violations.txt`), `${contested.join('\n')}\n`);
      }
      record.status = 'quarantined';
      record.contested = true;
      record.violations = contested;
      return record;
    }

    if (opts.dryRun) {
      const prompt = buildPrompt(g);
      record.status = 'dry-run';
      record.promptBytes = Buffer.byteLength(prompt, 'utf8');
      record.headBytes = Buffer.byteLength(g.head, 'utf8');
      record.mustAppear = g.provenance.runIds.length + g.provenance.shas.length + g.provenance.ticketRefs.length + g.provenance.dates.length;
      return record;
    }

    fs.mkdirSync(path.join(opts.out, 'meta'), { recursive: true });
    let violations = null;
    let last = null;
    // ONE corrective re-dispatch (§5.3). A single-turn extraction has no
    // investigation state worth resuming, so the retry is a fresh turn carrying
    // the full prompt plus the violations — cheaper to reason about than a
    // resumed session and identical in effect.
    for (let attempt = 1; attempt <= 2; attempt++) {
      record.attempts = attempt;
      const t0 = Date.now();
      const res = await runDispatch(buildPrompt(g, violations), opts, path.join(opts.out, 'meta', `${g.id}.attempt${attempt}.json`));
      record.seconds += (Date.now() - t0) / 1000;
      if (res.usage) {
        record.usd += res.usage.usd;
        record.tokens.input += res.usage.input;
        record.tokens.output += res.usage.output;
      }
      record.promptBytes = res.promptBytes;
      if (res.code !== 0) {
        const kind = (/dispatch failed \[([a-z-]+)\]/.exec(res.stderr) || [, 'unknown'])[1];
        record.failureKind = kind;
        violations = [`the dispatch itself failed [${kind}] — ${res.stderr.trim().split('\n').slice(-3).join(' ')}`];
        last = { violations, stderr: res.stderr };
        continue;
      }
      const parsed = extractJson(res.stdout);
      if (!parsed.ok) {
        violations = [`your reply contained no parseable JSON object. Reply with ONE JSON object and nothing else.`];
        last = { violations, stdout: res.stdout };
        continue;
      }
      const composed = compose(g, parsed.value, { today: opts.today });
      const graded = grade(g, composed, originalText);
      record.counts = graded.counts;
      if (graded.ok) {
        // Whole-file write, only after the whole file passed.
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, composed.text);
        clearQuarantine(failDir, g.id);
        record.status = 'migrated';
        record.notes = composed.notes;
        record.dropped = composed.record.source.dropped;
        record.confirmation = composed.record.source.confirmation;
        return record;
      }
      violations = graded.violations;
      last = { violations, text: composed.text };
    }

    // Quarantine. A NORMAL outcome: the original stays where it is and this
    // ticket is simply not migrated.
    fs.mkdirSync(failDir, { recursive: true });
    fs.writeFileSync(path.join(failDir, `${g.id}.violations.txt`), `${(violations ?? []).join('\n')}\n`);
    if (last?.text) fs.writeFileSync(path.join(failDir, `${g.id}.rejected.md`), last.text);
    if (last?.stdout) fs.writeFileSync(path.join(failDir, `${g.id}.reply.txt`), last.stdout);
    if (last?.stderr) fs.writeFileSync(path.join(failDir, `${g.id}.stderr.txt`), last.stderr);
    record.status = 'quarantined';
    record.violations = violations ?? [];
    return record;
  })();
}

/** A semaphore over migrateOne. dispatch.mjs has no parallelism of its own. */
async function runPool(files, opts, onDone) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const r = await migrateOne(files[i], opts);
      results[i] = r;
      onDone(r, results.filter(Boolean).length, files.length);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ═════════════════════════════════════════════════════ validate the whole set */

/** Re-grade every staged ticket against its original. The §5.6 promotion gate. */
export function validateSet(opts) {
  const rows = [];
  if (!fs.existsSync(opts.out)) return { ok: false, rows, message: `no staging dir at ${opts.out}` };
  for (const file of fs.readdirSync(opts.out).sort()) {
    if (!TICKET_FILE_RE.test(file)) continue;
    const originalPath = path.join(opts.dir, file);
    if (!fs.existsSync(originalPath)) { rows.push({ file, ok: false, violations: [`no original at ${originalPath}`] }); continue; }
    const originalText = fs.readFileSync(originalPath, 'utf8');
    const migratedText = fs.readFileSync(path.join(opts.out, file), 'utf8');
    const g = extractGivens(file, originalText);
    const parsedBlock = extractTicketBlock(migratedText);
    if (parsedBlock.block === null) { rows.push({ file, ok: false, violations: [`${file}: no orchard-ticket block`] }); continue; }
    let rec = null;
    try { rec = JSON.parse(parsedBlock.block); } catch (e) { rows.push({ file, ok: false, violations: [`${file}: malformed block — ${e.message}`] }); continue; }
    const composed = { record: rec, body: parsedBlock.body, text: migratedText, body_slots: rec.body_slots };
    rows.push({ file, ...grade(g, composed, originalText) });
  }
  // A quarantine marker is a record of the LAST attempt, not of the current
  // state, and `migrateOne` used to leave one behind when a later re-run
  // succeeded — so a ticket could be reported as staged AND quarantined at once
  // and the promotion gate refused on a ticket sitting, valid, in the set.
  // (It happened: six markers were moved out of the way by hand rather than
  // fixed. See FEAT-094.) `clearQuarantine` now removes the marker on success;
  // this filter is the reader's own guard, so a marker left by an older run —
  // or by a run against a different source dir — cannot resurrect the refusal.
  const stagedIds = new Set(rows.map((r) => idFromFilename(r.file)));
  const quarantined = fs.existsSync(path.join(opts.out, 'failed'))
    ? fs.readdirSync(path.join(opts.out, 'failed')).filter((f) => f.endsWith('.violations.txt'))
      .map((f) => f.replace('.violations.txt', '')).filter((id) => !stagedIds.has(id))
    : [];
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows, quarantined };
}

/* ══════════════════════════════════════════════ back-edge reconciliation */

/**
 * §2.5: `related[]` relations are BIDIRECTIONAL and a one-sided edge is drift.
 *
 * A per-ticket migration structurally cannot write both sides — each dispatch
 * sees one ticket and does not know what the others said. So the back edges are
 * a WHOLE-SET pass, run over the staging dir after the run and before promotion.
 * It is deterministic (RELATION_INVERSE), idempotent, and touches only staged
 * copies — never an original.
 *
 * An edge whose target is not in the staged set is REPORTED, not invented: a
 * dangling reference is a fact about the corpus, and silently adding a back edge
 * to a file that does not exist would be worse than naming it.
 */
export function reconcileRelations(opts) {
  const files = fs.existsSync(opts.out) ? fs.readdirSync(opts.out).filter((f) => TICKET_FILE_RE.test(f)).sort() : [];
  const byId = new Map();
  for (const f of files) {
    const text = fs.readFileSync(path.join(opts.out, f), 'utf8');
    const { block, body } = extractTicketBlock(text);
    if (block === null) continue;
    try { byId.set(idFromFilename(f), { f, rec: JSON.parse(block), body, dirty: false }); } catch { /* validateSet reports it */ }
  }
  const dangling = [];
  const selfEdges = [];
  let added = 0;
  for (const [id, entry] of byId) {
    for (const rel of Array.isArray(entry.rec.related) ? entry.rec.related : []) {
      if (!rel || typeof rel.id !== 'string') continue;
      // BUG-128 — a self-edge is REPORTED and never propagated. Left to run,
      // the loop below reads `A --blocks--> A`, looks up the inverse, finds the
      // target is A itself, and writes `A --depends_on--> A`: a defect that
      // manufactures a second defect out of the first, in a pass whose whole
      // job is to repair edges. Reconciliation cannot fix this one — the
      // ticket it would have to correct is the ticket that is wrong — so the
      // only honest move is to name it and leave it for a person, exactly as
      // a dangling edge is named rather than invented away.
      if (idsMatch(rel.id, id)) {
        selfEdges.push(`${id} -> itself (${rel.relation}): a relation describes two tickets; not propagated, and not repairable here`);
        continue;
      }
      const inverse = RELATION_INVERSE[rel.relation];
      const target = byId.get(rel.id);
      if (!target) { dangling.push(`${id} -> ${rel.id} (${rel.relation}): no ticket ${rel.id} in the staged set`); continue; }
      if (!inverse) { dangling.push(`${id} -> ${rel.id}: relation ${JSON.stringify(rel.relation)} has no inverse`); continue; }
      if (!Array.isArray(target.rec.related)) target.rec.related = [];
      if (target.rec.related.some((r) => r && r.id === id && r.relation === inverse)) continue;
      target.rec.related.push({ id, relation: inverse });
      target.dirty = true;
      added++;
    }
  }
  for (const entry of byId.values()) {
    if (!entry.dirty) continue;
    entry.rec.related.sort((a, b) => String(a.id).localeCompare(String(b.id)) || String(a.relation).localeCompare(String(b.relation)));
    fs.writeFileSync(path.join(opts.out, entry.f), formatTicket(entry.rec, entry.body));
  }
  return { files: files.length, added, dangling, selfEdges };
}

/* ═══════════════════════════════════════════════════════════════ promotion */

/**
 * §5.6 step 3, as ONE commit's worth of file moves so `git revert` is a complete
 * rollback:
 *   originals  docs/bugs/<f>.md      → docs/bugs/archive/<f>.md   (git mv, verbatim)
 *   staged     .migrated/<f>.md      → docs/bugs/<f>.md
 *   generated  docs/bugs/archive/INDEX.md
 *
 * ALL-OR-NOTHING, with ONE recorded exception. If any staged ticket fails the
 * gate, or any ticket in the source dir has no staged counterpart, nothing moves
 * and the reason is named.
 *
 * THE EXCEPTION — `--allow-legacy <ID>[=<why>]` (FEAT-094). Two tickets on this
 * board have no correct migration to produce: their own evidence is contested,
 * and BUG-125 is contested by construction because its Repro QUOTES a verdict
 * line inside a fence, so a fence-aware and a fence-blind reader legitimately
 * count different records. Uniformity is therefore not reachable, and the two
 * ways of reaching it are both worse than a mixed corpus: forcing them through
 * writes a GUESSED attribution into the permanent record, and loosening the gate
 * drops the check that has already caught four real self-contradictions here.
 * So the mixed corpus becomes a FIRST-CLASS, RECORDED state instead: a named
 * ticket may stay in legacy format, an UNNAMED one still refuses exactly as
 * before, and the named set with its reasons is printed by the promotion and
 * written into `archive/INDEX.md` — so a reader years later sees which tickets
 * were deliberately left behind and why, rather than inferring it from a gap.
 *
 * An original that ALREADY carries an ```orchard-ticket block is not legacy and
 * not unmigrated — it was authored in the new format and needs no staged
 * counterpart. It is left exactly where it is and never archived.
 *
 * Dry by default; `--apply` performs the moves. It does NOT commit and it does
 * NOT run board:gen — those are the operator's, deliberately, so the cutover
 * commit is composed by a human who can read the diff.
 */
export function promote(opts) {
  const set = validateSet(opts);
  const allow = opts.allowLegacy instanceof Map ? opts.allowLegacy : new Map();
  const problems = [];
  if (!set.ok) problems.push(`${set.rows.filter((r) => !r.ok).length} staged ticket(s) fail the acceptance gate`);
  const originals = fs.readdirSync(opts.dir).filter((f) => TICKET_FILE_RE.test(f)).sort();
  const staged = new Set(set.rows.map((r) => r.file));
  const fileOf = new Map(originals.map((f) => [idFromFilename(f), f]));

  // Already in the new format by hand: not staged, not legacy, not moved.
  const native = originals.filter((f) => !staged.has(f)
    && extractTicketBlock(fs.readFileSync(path.join(opts.dir, f), 'utf8')).block !== null);
  const nativeSet = new Set(native);

  const legacyLeft = originals.filter((f) => !staged.has(f) && !nativeSet.has(f));
  const namedLegacy = legacyLeft.filter((f) => allow.has(idFromFilename(f)));
  const unnamedLegacy = legacyLeft.filter((f) => !allow.has(idFromFilename(f)));
  if (unnamedLegacy.length) {
    problems.push(`${unnamedLegacy.length} ticket(s) have no staged counterpart and are not named in --allow-legacy: `
      + `${unnamedLegacy.slice(0, 8).join(', ')}${unnamedLegacy.length > 8 ? ' …' : ''}`);
  }
  const unnamedQuarantine = (set.quarantined ?? []).filter((id) => !allow.has(id));
  if (unnamedQuarantine.length) problems.push(`${unnamedQuarantine.length} quarantined ticket(s) not named in --allow-legacy: ${unnamedQuarantine.join(', ')}`);

  // An allow-list entry that does not name a ticket left behind is OPERATOR
  // ERROR and refuses rather than being ignored: a typo'd or stale id would
  // otherwise read, in the archive's own index, as a deliberate decision about
  // a ticket that was in fact promoted.
  for (const id of allow.keys()) {
    const f = fileOf.get(id);
    if (!f) problems.push(`--allow-legacy names ${id}, which is not a ticket in ${opts.dir}`);
    else if (staged.has(f)) problems.push(`--allow-legacy names ${id}, but it HAS a staged record — remove it from the list or remove the record`);
    else if (nativeSet.has(f)) problems.push(`--allow-legacy names ${id}, but it already carries an orchard-ticket block — it is not legacy`);
  }

  if (problems.length) {
    console.error('PROMOTION REFUSED — the gate is all-or-nothing apart from --allow-legacy (§5.6 step 2):');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }

  const archiveDir = path.join(opts.dir, 'archive');
  const moves = originals.filter((f) => staged.has(f))
    .map((f) => ({ f, from: path.join(opts.dir, f), archive: path.join(archiveDir, f), staged: path.join(opts.out, f) }));
  const indexRows = moves.map(({ f }) => {
    const text = fs.readFileSync(path.join(opts.dir, f), 'utf8');
    const h1 = parseTitleLine(text);
    return {
      id: idFromFilename(f), file: f, title: h1.ok ? h1.title : '(unparseable H1)',
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    };
  });
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const legacyRows = namedLegacy.map((f) => {
    const id = idFromFilename(f);
    return { id, file: f, reason: allow.get(id) || '(no reason recorded)' };
  });
  const legacySection = legacyRows.length ? `
## Deliberately NOT migrated — still in legacy format in \`docs/bugs/\`

${legacyRows.length} ticket(s) were named in \`--allow-legacy\` and stayed where they
are. They are not in this archive and they have no record: their originals are
still the live ticket files. A ticket lands here when its own evidence is
contested and no migration could be produced without guessing what it asserts.

| ID | Still at | Why it was left in legacy format |
|---|---|---|
${legacyRows.map((r) => `| ${r.id} | [docs/bugs/${r.file}](../${r.file}) | ${escapeTableCell(r.reason)} |`).join('\n')}
` : '';
  const index = `# Archive — pre-migration ticket originals

These are the ticket files exactly as they stood before the schema migration of
${today}, moved here verbatim by \`scripts/migrate-tickets.mjs --promote\`. Not one
byte was edited. Each migrated ticket's \`source.sha256\` pins which of these it
derived from, so "what did the original say" is one \`rg\` away, permanently.

| ID | Original title | Bytes | sha256 | Archived |
|---|---|---|---|---|
${indexRows.map((r) => `| [${r.id}](${r.file}) | ${escapeTableCell(r.title)} | ${r.bytes} | \`${r.sha256}\` | ${today} |`).join('\n')}
${legacySection}`;

  // BUG-127: escaping a cell is lossy — a newline becomes a space, `<` becomes
  // an entity. Silently rewriting what a person wrote is how the corruption got
  // this far unnoticed, so every altered value is NAMED. Escaping is still the
  // right remedy rather than a refusal: a multi-line reason is legitimate to
  // WRITE, it is only illegitimate to emit into a table row unchanged.
  const rewritten = [
    ...indexRows.map((r) => ({ id: r.id, field: 'title', raw: r.title })),
    ...legacyRows.map((r) => ({ id: r.id, field: 'legacy reason', raw: r.reason })),
  ].filter((r) => escapeTableCell(r.raw) !== String(r.raw));

  const reportLeftBehind = () => {
    for (const r of rewritten) {
      console.log(`  CELL ESCAPED         ${String(r.id).padEnd(9)} ${r.field} contained a cell, row or region terminator; the archive index shows ${JSON.stringify(escapeTableCell(r.raw))}`);
    }
    for (const r of legacyRows) console.log(`  LEGACY, BY DECISION  ${r.id.padEnd(9)} stays at ${opts.dir}/${r.file} — ${r.reason}`);
    for (const f of native) console.log(`  ALREADY A RECORD     ${idFromFilename(f).padEnd(9)} authored in the new format; not staged, not archived`);
  };

  if (!opts.apply) {
    console.log(`PROMOTION DRY RUN — ${moves.length} tickets ready.`);
    console.log(`  ${moves.length} originals  ${opts.dir}/<id>.md  ->  ${archiveDir}/<id>.md   (git mv, verbatim)`);
    console.log(`  ${moves.length} migrated   ${opts.out}/<id>.md  ->  ${opts.dir}/<id>.md`);
    console.log(`  1 generated  ${path.join(archiveDir, 'INDEX.md')}  (${index.length} bytes)`);
    reportLeftBehind();
    console.log('re-run with --apply to perform the moves (it does not commit, and does not run board:gen)');
    return 0;
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  for (const m of moves) {
    // `git -C <the ticket dir>` rather than the repo root, so a rehearsal on a
    // COPY of the corpus in a throwaway repo works exactly as the real one does.
    const r = spawnSyncGit(['-C', opts.dir, 'mv', path.relative(opts.dir, m.from), path.relative(opts.dir, m.archive)]);
    if (r !== 0) { console.error(`git mv failed for ${m.f} — STOPPING; nothing further is moved`); return 1; }
  }
  for (const m of moves) fs.renameSync(m.staged, m.from);
  fs.writeFileSync(path.join(archiveDir, 'INDEX.md'), index);
  console.log(`promoted ${moves.length} tickets; originals archived under ${archiveDir}`);
  reportLeftBehind();
  console.log('NOT committed and board:gen NOT run — compose the single cutover commit yourself.');
  return 0;
}

function spawnSyncGit(args) {
  return spawnSync('git', args, { stdio: 'inherit' }).status ?? 1;
}

/* ══════════════════════════════════════════════════════════════════════ CLI */

function parseArgs(argv) {
  const o = {
    dir: path.join(ROOT, 'docs/bugs'), out: path.join(ROOT, 'docs/bugs/.migrated'),
    provider: 'openai', model: 'gpt-5.6-sol', timeoutMin: 8, concurrency: 4,
    ids: null, all: false, limit: 0, force: false, dryRun: false, apply: false,
    mode: 'migrate', today: null, allowLegacy: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === '--dir') o.dir = path.resolve(take());
    else if (a === '--out') o.out = path.resolve(take());
    else if (a === '--provider') o.provider = take();
    else if (a === '--model') o.model = take();
    else if (a === '--timeout-min') o.timeoutMin = Number(take());
    else if (a === '--concurrency') o.concurrency = Number(take());
    else if (a === '--limit') o.limit = Number(take());
    else if (a === '--ids') o.ids = take().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--today') o.today = take();
    // Repeatable. `--allow-legacy A,B` names ids; `--allow-legacy 'A=why'` names
    // one id WITH its reason, and a reason may contain commas, so a value that
    // carries an `=` is never split.
    else if (a === '--allow-legacy') {
      const v = take();
      for (const entry of (v.includes('=') ? [v] : v.split(','))) {
        const eq = entry.indexOf('=');
        const id = (eq === -1 ? entry : entry.slice(0, eq)).trim();
        const reason = eq === -1 ? null : entry.slice(eq + 1).trim();
        if (id) o.allowLegacy.set(id, reason || null);
      }
    }
    else if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--validate-set') o.mode = 'validate';
    else if (a === '--reconcile') o.mode = 'reconcile';
    else if (a === '--report') o.mode = 'report';
    else if (a === '--promote') o.mode = 'promote';
    else { console.error(`unknown argument ${JSON.stringify(a)}`); process.exit(2); }
  }
  return o;
}

function selectFiles(opts) {
  const all = fs.readdirSync(opts.dir).filter((f) => TICKET_FILE_RE.test(f)).sort();
  let files = all;
  if (opts.ids) {
    const want = new Set(opts.ids);
    files = all.filter((f) => want.has(idFromFilename(f)));
    const found = new Set(files.map((f) => idFromFilename(f)));
    for (const id of want) if (!found.has(id)) console.error(`  no ticket file for ${id}`);
  } else if (!opts.all) {
    console.error('refusing to migrate: pass --ids <A,B,C> or --all');
    process.exit(2);
  }
  return opts.limit > 0 ? files.slice(0, opts.limit) : files;
}

const usd = (n) => `$${n.toFixed(4)}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'validate') {
    const set = validateSet(opts);
    for (const r of set.rows) {
      if (r.ok) continue;
      console.log(`FAIL ${r.file}`);
      for (const v of r.violations) console.log(`     ${v}`);
    }
    console.log(`\nvalidate-set: ${set.rows.filter((r) => r.ok).length}/${set.rows.length} staged tickets pass; ${set.quarantined?.length ?? 0} quarantined`);
    return set.ok ? 0 : 1;
  }
  if (opts.mode === 'reconcile') {
    const r = reconcileRelations(opts);
    console.log(`reconcile: ${r.files} staged ticket(s), ${r.added} back-edge(s) added`);
    for (const d of r.dangling) console.log(`  DANGLING  ${d}`);
    for (const s of r.selfEdges) console.log(`  SELF-EDGE ${s}`);
    // A self-edge is not drift the reconciler may leave behind quietly: it is
    // the one shape it would otherwise DUPLICATE. Exit non-zero so a pipeline
    // stops on it (BUG-128).
    return r.selfEdges.length ? 1 : 0;
  }
  if (opts.mode === 'promote') return promote(opts);
  if (opts.mode === 'report') {
    const reportFile = path.join(opts.out, 'run-report.json');
    if (!fs.existsSync(reportFile)) { console.error(`no run report at ${reportFile}`); return 1; }
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    printSummary(rep.rows, opts);
    return 0;
  }

  const files = selectFiles(opts);
  fs.mkdirSync(opts.out, { recursive: true });
  console.error(`migrating ${files.length} ticket(s) → ${opts.out}  (${opts.provider}/${opts.model}, concurrency ${opts.concurrency}${opts.dryRun ? ', DRY RUN' : ''})`);
  const t0 = Date.now();
  const rows = await runPool(files, opts, (r, done, total) => {
    console.error(`  [${String(done).padStart(3)}/${total}] ${r.status.padEnd(11)} ${r.id.padEnd(9)} ${r.attempts ? `attempt ${r.attempts}` : ''} ${r.usd ? usd(r.usd) : ''} ${r.seconds ? `${r.seconds.toFixed(0)}s` : ''}`);
    if (r.status === 'quarantined') for (const v of r.violations.slice(0, 6)) console.error(`        ! ${v}`);
  });
  const elapsed = (Date.now() - t0) / 1000;
  if (!opts.dryRun) {
    fs.writeFileSync(path.join(opts.out, 'run-report.json'), JSON.stringify({ generated: new Date().toISOString(), elapsed, opts: { ...opts, dir: path.relative(ROOT, opts.dir), out: path.relative(ROOT, opts.out) }, rows }, null, 2));
  }
  printSummary(rows, opts, elapsed);
  return rows.some((r) => r.status === 'quarantined') ? 1 : 0;
}

function printSummary(rows, opts, elapsed = null) {
  const by = (s) => rows.filter((r) => r.status === s).length;
  const spend = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
  const priced = rows.filter((r) => (r.usd ?? 0) > 0).length;
  const tin = rows.reduce((a, r) => a + (r.tokens?.input ?? 0), 0);
  const tout = rows.reduce((a, r) => a + (r.tokens?.output ?? 0), 0);
  const corpus = fs.readdirSync(opts.dir).filter((f) => TICKET_FILE_RE.test(f)).length;
  console.log('');
  console.log(`migrated      ${by('migrated')}`);
  console.log(`cached        ${by('cached')}`);
  console.log(`quarantined   ${by('quarantined')}`);
  if (by('dry-run')) {
    console.log(`dry-run       ${by('dry-run')}`);
    const pb = rows.map((r) => r.promptBytes ?? 0);
    console.log(`prompt bytes  min ${Math.min(...pb)} / mean ${Math.round(pb.reduce((a, b) => a + b, 0) / pb.length)} / max ${Math.max(...pb)}`);
    console.log(`must-appear   ${rows.reduce((a, r) => a + (r.mustAppear ?? 0), 0)} provenance tokens across the set`);
    return;
  }
  console.log(`retried once  ${rows.filter((r) => r.attempts > 1).length}`);
  console.log(`tokens        in ${tin} / out ${tout}`);
  console.log(`spend         ${usd(spend)} over ${priced} priced dispatch(es)`);
  if (priced) {
    const per = spend / priced;
    console.log(`per ticket    ${usd(per)}`);
    console.log(`extrapolated  ${usd(per * corpus)} for all ${corpus} tickets, against the §5.4 forecast of $${FORECAST_TOTAL_USD}`);
  }
  if (elapsed !== null) console.log(`elapsed       ${elapsed.toFixed(0)}s`);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
