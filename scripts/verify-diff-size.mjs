#!/usr/bin/env node
/**
 * verify-diff-size.mjs — FEAT-107 proof suite.
 *
 *   node scripts/verify-diff-size.mjs
 *
 * Built against REAL artifacts wherever one exists: the real BUG-154 ticket prose
 * (which records its commit sha the way the convention says), the real git object
 * store on this checkout, and the real collector wired end to end. Only the
 * attribution edge cases that no real instance can be authored on demand are
 * synthesized, and each says so.
 *
 * MUST-FAIL discipline: every behavioural claim carries a proof that the check
 * reddens against the PRE-FIX behaviour, and each pre-fix rule is re-implemented
 * inline rather than read from HEAD, so the baseline cannot drift with its subject.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { extractRecordedShas, parseNumstat, median, attributeDiffs, fixClassBaseline } from './lib/diff-size.mjs';
import { collectDiffs } from './cost-collect.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, observed) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${observed === undefined ? '' : `  [${observed}]`}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${observed === undefined ? '' : `  [observed: ${observed}]`}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/* ================================================= 1. sha extraction */

section('1. Recorded-sha extraction — against the real BUG-154 ticket');

const boardDir = path.join(REPO, 'docs', 'bugs');
const bug154 = fs.readdirSync(boardDir).find((f) => /^BUG-154/.test(f));
ok('LOUD: the real BUG-154 ticket exists to test against', !!bug154, String(bug154));
if (bug154) {
  const body = fs.readFileSync(path.join(boardDir, bug154), 'utf8');
  const shas = extractRecordedShas(body);
  // BUG-154 records: "**committed:** Committed as 303f851 (...)."
  ok('the capital-C "Committed as 303f851" is extracted from real prose', shas.includes('303f851'), shas.join(','));

  // MUST-FAIL, synthesized pre-fix rule: the same matcher WITHOUT the /i flag —
  // the exact bug caught against this real ticket. It missed every capital-C sha.
  const caseSensitive = /\b(?:commit(?:ted)?|sha)\b(?:\s+as)?\s*[:=]?\s*`?\b([0-9a-fA-F]{7,40})\b/g;
  const preFix = [...body.matchAll(caseSensitive)].map((m) => m[1].toLowerCase());
  ok(
    'MUST-FAIL: a case-sensitive matcher MISSES the capital-C recorded sha',
    !preFix.includes('303f851') && extractRecordedShas(body).includes('303f851'),
    `pre-fix found [${preFix.join(',') || 'none'}]`,
  );
}

// A bare hex run with no commit/sha keyword must NOT be read as a commit.
ok('a bare hex in prose is not mistaken for a recorded sha', extractRecordedShas('see line ab12cd3 for the guard').length === 0);
ok('all documented shapes are caught', (() => {
  const s = extractRecordedShas('commit `d302908`, committed 6b5b061, sha e9432ae6, Commit f4fc2a3d');
  return s.length === 4 && s.includes('d302908') && s.includes('e9432ae6');
})());
ok('the same sha named twice is returned once, in order', (() => {
  const s = extractRecordedShas('committed abc1234 ... later commit abc1234');
  return s.length === 1 && s[0] === 'abc1234';
})());

/* ================================================= 2. numstat parsing */

section('2. numstat parsing — against real git output');

// REAL: git show of BUG-154's own fix commit. Hand-computed on the wire earlier:
// added=553 deleted=3 files=4.
const raw154 = git(['show', '--numstat', '--format=', '303f851']);
const st = parseNumstat(raw154);
ok('parseNumstat matches git show --numstat by hand (added)', st.added === 553, `added=${st.added}`);
ok('...deleted', st.deleted === 3, `deleted=${st.deleted}`);
ok('...files', st.files === 4, `files=${st.files}`);

// SYNTHETIC: a binary file (git writes `-\t-\t<path>`) is a file-change with no
// line count — it must count toward files, not silently become 0 lines of a
// real change nor crash the parser.
const bin = parseNumstat('10\t2\tsrc/a.js\n-\t-\tassets/logo.png\n');
ok('a binary file counts as a file-change, contributes 0 added/deleted, and is flagged', bin.files === 2 && bin.binary_files === 1 && bin.added === 10, JSON.stringify(bin));

ok('median of an even set averages the middle two', median([1, 3, 5, 9]) === 4);
ok('median of an odd set is the middle', median([5, 1, 3]) === 3);
ok('median of nothing is null, not 0', median([]) === null);

/* ================================================= 3. attribution rule */

section('3. Attribution — window vs preceding, and the honest unattributed bucket');

const stat = (at, added = 100, deleted = 10, files = 3) => ({ added, deleted, files, binary_files: 0, at_ms: Date.parse(at) });

// A lane whose window CONTAINS the commit -> provenance `window`.
const inside = attributeDiffs({
  lanes: [{ lane_id: 'L1', primary_ticket: 'BUG-1', started_at: '2026-08-20T10:00:00Z', ended_at: '2026-08-20T11:00:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 1 }],
  ticketShas: new Map([['BUG-1', ['aaa']]]),
  commitStats: new Map([['aaa', stat('2026-08-20T10:30:00Z')]]),
});
ok('a commit inside a lane window attributes to it as `window`', inside.lanes[0].diff.added === 100 && inside.provenance.window === 1, JSON.stringify(inside.provenance));

// The BUG-154 shape, synthesized to isolate it: a human commits AFTER the lane
// ended. Strict window-only would drop it; the chosen rule ties it to the lane
// by recency, labelled `preceding`.
const after = {
  lanes: [{ lane_id: 'L2', primary_ticket: 'BUG-2', started_at: '2026-08-20T10:00:00Z', ended_at: '2026-08-20T10:20:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 1 }],
  ticketShas: new Map([['BUG-2', ['bbb']]]),
  commitStats: new Map([['bbb', stat('2026-08-20T12:00:00Z')]]),
};
const post = attributeDiffs(after);
ok('a commit made AFTER the lane ties to it as `preceding`, not dropped', post.lanes[0].commit_shas.length === 1 && post.provenance.preceding === 1);
// MUST-FAIL, synthesized pre-fix rule: window-only attribution.
const windowOnly = after.lanes.filter((l) => Date.parse('2026-08-20T12:00:00Z') >= Date.parse(l.started_at) && Date.parse('2026-08-20T12:00:00Z') <= Date.parse(l.ended_at));
ok('MUST-FAIL: a window-only rule leaves the human-committed diff unattributable', windowOnly.length === 0 && post.counts.links_unattributed === 0, `window-only matched ${windowOnly.length}`);

// A commit that PREDATES every lane on its ticket cannot be the lane's work.
const before = attributeDiffs({
  lanes: [{ lane_id: 'L3', primary_ticket: 'BUG-3', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:20:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 1 }],
  ticketShas: new Map([['BUG-3', ['ccc']]]),
  commitStats: new Map([['ccc', stat('2026-08-25T22:00:00Z')]]),
});
ok('a commit older than any lane on its ticket is UNATTRIBUTED with a reason, not forced on', before.counts.links_unattributed === 1 && before.unattributed[0].reason === 'commit-precedes-lanes' && before.lanes[0].commit_shas.length === 0);

// Several commits across rounds map to their own round by recency.
const rounds = attributeDiffs({
  lanes: [
    { lane_id: 'r1', primary_ticket: 'BUG-4', started_at: '2026-08-20T10:00:00Z', ended_at: '2026-08-20T10:30:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 1 },
    { lane_id: 'r2', primary_ticket: 'BUG-4', started_at: '2026-08-20T12:00:00Z', ended_at: '2026-08-20T12:30:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 2 },
  ],
  ticketShas: new Map([['BUG-4', ['c1', 'c2']]]),
  commitStats: new Map([
    ['c1', stat('2026-08-20T11:00:00Z', 40)], // after round1, before round2
    ['c2', stat('2026-08-20T13:00:00Z', 90)], // after round2
  ]),
});
const r1 = rounds.lanes.find((l) => l.lane_id === 'r1');
const r2 = rounds.lanes.find((l) => l.lane_id === 'r2');
ok('commit-of-round-1 lands on the round-1 lane', r1.diff.added === 40 && r1.commit_shas[0] === 'c1');
ok('commit-of-round-2 lands on the round-2 lane', r2.diff.added === 90 && r2.commit_shas[0] === 'c2');

/* ================================================= 4. don't-silently-drop invariants */

section('4. Non-vacuity — absent is absent, never a silent zero');

// A ticket with NO recorded sha does not appear as a zero row.
const none = attributeDiffs({
  lanes: [{ lane_id: 'z', primary_ticket: 'BUG-9', started_at: '2026-08-20T10:00:00Z', ended_at: '2026-08-20T11:00:00Z' }],
  ticketShas: new Map(),
  commitStats: new Map(),
});
ok('a ticket with no recorded sha yields no per-ticket row (absent, not a 0)', none.perTicket.length === 0 && none.counts.unique_commits === 0);
ok('a lane that produced no commit is excluded from the median, not counted as a 0-line change', none.classMedians.length === 0 && none.counts.lanes_no_commit === 1);

// A recorded sha whose numstat we never resolved is a MISSING stat on the ticket,
// not a zero contribution.
const unresolved = attributeDiffs({
  lanes: [],
  ticketShas: new Map([['BUG-8', ['deadbeef']]]),
  commitStats: new Map(), // caller could not resolve it
});
ok('an unresolved sha is recorded as missing_stats, not summed as zero', unresolved.perTicket[0].missing_stats.includes('deadbeef') && unresolved.perTicket[0].total.commits === 0);

// Shared commit: counted per ticket, deduped in the fleet total.
const shared = attributeDiffs({
  lanes: [],
  ticketShas: new Map([['BUG-6', ['sh1']], ['BUG-7', ['sh1']]]),
  commitStats: new Map([['sh1', stat('2026-08-20T10:00:00Z', 50, 5, 2)]]),
});
ok('a sha shared across two tickets counts toward BOTH tickets', shared.perTicket.every((t) => t.total.added === 50));
ok('...but the fleet total dedups it (added 50 once, not 100) and lists it as shared', shared.globalTotal.added === 50 && shared.counts.shared_commits === 1);

/* ================================================= 5. end to end on the real repo */

section('5. End to end — the collector against the real board + git');

const diffs = collectDiffs([
  // A synthetic lane placed to catch BUG-154's real recorded commit by recency:
  // its window need not contain the commit (the human committed after).
  { lane_id: 'BUG154-fix', primary_ticket: 'BUG-154', started_at: '2026-08-25T18:00:00Z', ended_at: '2026-08-25T21:00:00Z', dispatch_class: 'fix', dispatch_class_source: 'declared', round: 1, verdict: null },
], { project: REPO });
ok('collectDiffs runs against the real repo without throwing', !diffs.unavailable, diffs.unavailable || 'ok');
if (!diffs.unavailable) {
  const t154 = diffs.attributed.perTicket.find((t) => t.ticket === 'BUG-154');
  ok('the real BUG-154 ticket resolves to its recorded commit end-to-end (+553/-3/4)', t154 && t154.total.added === 553 && t154.total.deleted === 3 && t154.total.files === 4, t154 && JSON.stringify(t154.total));
  const lane = diffs.attributed.lanes.find((l) => l.lane_id === 'BUG154-fix');
  ok('...and a fix lane preceding that commit is credited with it (proves the baseline can populate)', lane.diff.added === 553 && lane.dispatch_class === 'fix');
  const base = fixClassBaseline(diffs.attributed, 20);
  ok('...so the fix-class baseline is non-empty once a fix lane precedes a recorded commit', base.n >= 1 && base.median_added === 553, `n=${base.n} median=${base.median_added}`);
  // Real unresolvable shas (pre-relocation history) are DROPPED with a name, not zeroed.
  ok('pre-relocation shas that no longer resolve are dropped, not zeroed', Array.isArray(diffs.unresolved) && diffs.unresolved.every((u) => typeof u.raw === 'string'));
}

/* ----------------------------------------------------------------- verdict */

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
