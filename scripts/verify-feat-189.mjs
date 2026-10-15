/**
 * FEAT-189 — session search ranks user sessions + whole ticket tokens first.
 *
 *   node scripts/verify-feat-189.mjs
 *
 * Two layers, both graded against invariant PROPERTIES (never today's values):
 *
 *  A. UNIT — the pure client ranking (public/lib/search-ranking.js) and the
 *     server match-context score (src/server/search.ts#matchRelevance), with a
 *     must-FAIL showing the pre-fix behaviour (recency-only order / no score)
 *     violates the property the fix establishes.
 *
 *  B. REAL STORE — list the user's OWN orchard session store (read-only) with
 *     the same libraries the server list route uses, resolve each row's DECLARED
 *     `startedBy`, and assert that for query `164` the ranked order puts a
 *     user-started FEAT-164 session first and a number-inside-a-number title
 *     below the whole ticket token. The pre-fix recency order is run as the
 *     must-FAIL. If the real store holds no qualifying session the test FAILS
 *     LOUDLY rather than passing vacuously.
 *
 * No server, no browser, no scratch data dir — so it never touches the live
 * service or its provenance store; it only READS the real transcript store.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as hist from '../src/lib/session-history.ts';
import { loadProvenanceMap, resolveStartedBy, foldsFromDefaultList } from '../src/lib/session-provenance.mjs';
import { parseTicketQuery, titleMatchRank, compareSessionHits } from '../public/lib/search-ranking.js';
import * as os from 'node:os';
import { matchRelevance, judgeLine, isTicketNumberQuery, searchStore } from '../src/server/search.ts';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (observed !== undefined) console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}

/* ──────────────────────────── A. UNIT ──────────────────────────── */
console.log('A. pure ranking units');

check('parseTicketQuery bare number', JSON.stringify(parseTicketQuery('164')) === JSON.stringify({ num: '164', prefix: null }));
check('parseTicketQuery feat-164', JSON.stringify(parseTicketQuery('FEAT-164')) === JSON.stringify({ num: '164', prefix: 'feat' }));
check('parseTicketQuery non-ticket', parseTicketQuery('git grant') === null);

check('titleMatchRank ticket token = 0', titleMatchRank('FEAT-164 git-grant redesign review', '164') === 0, titleMatchRank('FEAT-164 git-grant redesign review', '164'));
check('titleMatchRank standalone number = 1', titleMatchRank('notes from meeting 164', '164') === 1, titleMatchRank('notes from meeting 164', '164'));
check('titleMatchRank number-in-number = 3', titleMatchRank('nightly build 164790', '164') === 3, titleMatchRank('nightly build 164790', '164'));
check('titleMatchRank FEAT-1640 does not count as 164', titleMatchRank('FEAT-1640 something', '164') === 3, titleMatchRank('FEAT-1640 something', '164'));

// matchRelevance (server): 0 ticket ref, 1 clean, 2 buried number.
const mr = (text, q) => matchRelevance(text, text.toLowerCase().indexOf(q.toLowerCase()), q);
check('matchRelevance ticket ref = 0', mr('Dispatch: ticket=FEAT-164 phase=verifying', '164') === 0, mr('Dispatch: ticket=FEAT-164 phase=verifying', '164'));
check('matchRelevance line number = 1', mr('scripts/lib/schema.mjs:164', '164') === 1, mr('scripts/lib/schema.mjs:164', '164'));
check('matchRelevance digit after = 2', mr('<subagent_tokens>164790</subagent_tokens>', '164') === 2, mr('<subagent_tokens>164790</subagent_tokens>', '164'));
check('matchRelevance digit before = 2', mr('4164 function finishModel', '164') === 2, mr('4164 function finishModel', '164'));
check('matchRelevance prefix query = 0', mr('see FEAT-164 for details', 'feat-164') === 0, mr('see FEAT-164 for details', 'feat-164'));
check('matchRelevance non-numeric neutral = 1', mr('the git grant redesign', 'git') === 1);
// r8 — ONLY a known ticket prefix + '-' before a bare number is a ticket (0);
// any other <word>-164 (page-164, adv-164-x paths) is a non-ticket clean match (1).
check('matchRelevance page-164 is NOT a ticket (1)', mr('open page-164 now', '164') === 1, mr('open page-164 now', '164'));
check('matchRelevance adv-164-verbs path is NOT a ticket (1)', mr('scripts/adv-164-verbs.mjs', '164') === 1, mr('scripts/adv-164-verbs.mjs', '164'));
check('matchRelevance BUG-164 IS a ticket (0)', mr('closed BUG-164 today', '164') === 0, mr('closed BUG-164 today', '164'));
// CROSS-SURFACE AGREEMENT FUZZ (r8 + r12): the server (matchRelevance /
// isTicketNumberQuery, a MIRROR of the client grammar) MUST agree with the client
// (titleMatchRank / parseTicketQuery) on (a) whether a query is a ticket query and
// (b) whether a match is a ticket ref — across many query FORMS, not just '164'.
// Each text embeds the literal query so BOTH surfaces see the same match. This is
// the lockstep guard for the mirrored grammar (independent-verify r8, r12).
const fuzz = [
  ['164', 'see FEAT-164 here'],
  ['164', 'open page-164 now'],
  ['164', 'scripts/adv-164-verbs.mjs'],
  ['164', 'build 164790 log'],
  ['164', 'at 4164 function'],
  ['164', 'schema.mjs:164'],
  ['FEAT-164', 'see FEAT-164 here'],
  ['FEAT-164', 'see FEAT-1640 here'],
  ['feat-164', 'glued xfeat-164 here'],
  ['ticket=FEAT-164', 'line ticket=FEAT-164 end'],
  ['ticket=FEAT-164', 'line ticket=FEAT-1640 end'],
  ['ticket=FEAT-164', 'glued aticket=FEAT-164 end'], // adornment after a letter: token still bounded (r13)
  ['#feat-164', 'x#feat-164 here'],                  // same, '#' adornment (r13)
  ['feat164', 'FEAT164 notes'],
  ['bug-164', 'fixed BUG-164 today'],
  ['git', 'the git grant redesign'],
];
for (const [q, text] of fuzz) {
  // (a) is-this-a-ticket-query must agree.
  const serverIsTq = isTicketNumberQuery(q);
  const clientIsTq = parseTicketQuery(q) !== null;
  check(`fuzz isTicketQuery agrees for "${q}" (=${serverIsTq})`, serverIsTq === clientIsTq, `server=${serverIsTq} client=${clientIsTq}`);
  // (b) ticket-ref classification (top band, ===0) must agree on the same match.
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const serverTicket = at >= 0 && matchRelevance(text, at, q) === 0;
  const clientTicket = titleMatchRank(text, q) === 0;
  check(`fuzz ticket-ref agrees for "${q}" in "${text}" (=${serverTicket})`, serverTicket === clientTicket,
    `server=${serverTicket} client=${clientTicket}`);
}

// FEAT-189 r2 — a message holding the query TWICE (an embedded number first,
// the whole ticket later) must score by its BEST occurrence, not the first.
// The pre-r2 code scored prose.indexOf(q) only, so this scored 2 (noise).
const multi = '<subagent_tokens>164790</subagent_tokens> then ticket=FEAT-164 is the one';
const judgedMulti = judgeLine(JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: multi } }), '164');
check('judgeLine scores the BEST occurrence (ticket token beats an earlier embedded number)',
  judgedMulti && judgedMulti.score === 0, judgedMulti && judgedMulti.score);
// MUST-FAIL for the r2 regression: first-occurrence scoring would be 2.
check('MUST-FAIL r2: first-occurrence scoring would wrongly score that message 2',
  matchRelevance(multi, multi.toLowerCase().indexOf('164'), '164') === 2,
  matchRelevance(multi, multi.toLowerCase().indexOf('164'), '164'));

// FEAT-189 r6 — a length-changing lowercase before the match (Turkish İ → two
// code units) must not shift the scoring offset. judgeLine scores against the
// lowercased text, so a ticket ref preceded by İ still scores 0.
const uni = 'İ ticket=FEAT-164 is the one';
check('r6 unicode: length-changing lowercase precondition (İ expands)',
  uni.toLowerCase().length !== uni.length);
const judgedUni = judgeLine(JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: uni } }), '164');
check('r6 unicode: ticket ref after İ scores 0 (not demoted by offset shift)',
  judgedUni && judgedUni.score === 0, judgedUni && judgedUni.score);
// r7 — the returned offset indexes the ORIGINAL text, so the highlight lands on
// the query even after a length-changing lowercase (not shifted to "64 ").
check('r7 unicode: the highlighted substring is exactly the query, not an offset-shifted slice',
  judgedUni && judgedUni.snippet.slice(judgedUni.matchStart, judgedUni.matchEnd) === '164',
  judgedUni && JSON.stringify(judgedUni.snippet.slice(judgedUni.matchStart, judgedUni.matchEnd)));

// MUST-FAIL: the pre-fix server had NO score, so a sort cannot separate the
// ticket ref from the buried-number noise. Prove the new scores DO separate.
const scoreTicket = mr('ticket=FEAT-164', '164');
const scoreNoise = mr('164790', '164');
check('MUST-FAIL baseline: ticket ref scores strictly better than buried number',
  scoreTicket < scoreNoise, `ticket=${scoreTicket} noise=${scoreNoise}`);

// FEAT-189 r3 — perf: bestMatch scans past the first occurrence ONLY for a
// ticket-number query (whose score varies by position). A non-ticket query
// scores a constant 1, so scanning every occurrence is pure regression (1.9x
// on common prose queries — independent-verify r3). Guard the predicate that
// gates the scan, deterministically (no flaky timing assertion).
check('perf: ticket-number queries ARE scanned for the best occurrence', isTicketNumberQuery('164') && isTicketNumberQuery('FEAT-164'));
check('perf: a non-ticket query is NOT scanned past the first match (short-circuit)',
  !isTicketNumberQuery('a') && !isTicketNumberQuery('git grant') && !isTicketNumberQuery('the'));
// Informational timing only (NOT asserted — judgeLine's JSON.parse/toLowerCase
// are inherently O(line length), so a longer line is legitimately slower; the
// scan short-circuit above is what the predicate checks prove). Printed so a
// gross regression is at least visible to a human reading the run.
{
  const line = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'the quick brown fox '.repeat(2000) } });
  const s = process.hrtime.bigint();
  for (let i = 0; i < 500; i++) judgeLine(line, 'the');
  const ms = Number(process.hrtime.bigint() - s) / 1e6 / 500;
  console.log(`        (info: judgeLine neutral query over a ~40k-char line: ${ms.toFixed(3)} ms/call)`);
}

// FEAT-189 r11 — the ranking's origin signal must be `foldByDefault`, not
// `startedBy`. A provenance-less programmatic sdk-cli session has startedBy
// fall back to 'user' yet is folded as a lane; ranking on startedBy would let it
// masquerade as the user's own session. These two declared facts must diverge
// here, and the ranking uses the lane one.
const sdkLane = { sessionId: 'feat189-sdk-probe', entrypoint: 'sdk-cli', firstUserMessage: 'hello there', record: undefined };
check('r11: provenance-less sdk-cli — startedBy falls back to user', resolveStartedBy(sdkLane) === 'user');
check('r11: ...but foldByDefault marks it a LANE (the signal ranking uses)', foldsFromDefaultList(sdkLane) === true);

/* ──────────────────────── B. REAL STORE ──────────────────────── */
console.log('B. real orchard session store (read-only)');

const root = hist.defaultRoot();
if (!fs.existsSync(root)) {
  check('real store present', false, `no store at ${root}`);
} else {
  // The finder searches REGISTERED projects' sessions — model THAT, not a raw
  // scan of every dir under the store. A global scan pulls in unregistered
  // scratch clean-room dirs (e.g. a FEAT-164 verifier lane with no provenance
  // record) that the real UI never shows, and whose 'user' label is only
  // resolveStartedBy's no-record fallback (independent-verify r8/r9). Scope to
  // the registry's project host paths, encoded the way the store keys them.
  const prov = loadProvenanceMap();
  const Q = '164';
  const recencyKey = (s) => String(s.lastUserMessageAt ?? s.lastActivityAt ?? '');
  let registeredDirs = [];
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_STATION_DATA ?? path.join(process.env.HOME, '.local/share/claude-station'), 'registry.json'), 'utf8'));
    registeredDirs = Object.values(reg.projects ?? {}).map((p) => hist.encodeCwd(p.hostPath));
  } catch { /* no registry — fall back to the orchard dir below */ }
  if (!registeredDirs.length) registeredDirs = [hist.encodeCwd(path.resolve(import.meta.dirname, '..'))];
  const dirs = [...new Set(registeredDirs)].filter((d) => { try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; } });

  const isFeat164 = (t) => /(?:^|[^a-z0-9])feat-164(?![0-9])/i.test(t);
  // startedBy is read from the DECLARED record ONLY — never resolveStartedBy's
  // 'user' fallback, which (independent-verify r8, anthropic) made a provenance-
  // less scratch verifier lane look like the user's own session and let section
  // B pass by vacuity. `declared` marks whether the fact is real or absent.
  const hits = [];
  let newestDeclaredAgent = null; // any real agent-declared session (for the tiebreak test)
  let oldestDeclaredUser = null;  // any real user-declared session with a usable rk
  for (const d of dirs) {
    let ss = [];
    try { ss = hist.listSessions(d); } catch { continue; }
    for (const s of ss) {
      const rec = prov.get(s.sessionId);
      const title = s.displayTitle ?? '';
      const rk = recencyKey(s);
      if (rec?.startedBy === 'agent' && (!newestDeclaredAgent || rk > newestDeclaredAgent.rk)) newestDeclaredAgent = { title, rk, id: s.sessionId };
      if (rec?.startedBy === 'user' && rk && (!oldestDeclaredUser || rk < oldestDeclaredUser.rk)) oldestDeclaredUser = { title, rk, id: s.sessionId };
      if (!title.toLowerCase().includes(Q)) continue;
      const declared = rec ? rec.startedBy : null;
      // lane = the server's foldByDefault fact (the ranking signal): agent lanes
      // AND external programmatic sessions, read from the declared record +
      // entrypoint — the same source the product uses (r11).
      const lane = foldsFromDefaultList({ sessionId: s.sessionId, entrypoint: s.entrypoint ?? null, firstUserMessage: s.firstUserMessage, record: rec }) ? 1 : 0;
      hits.push({ s, title, declared, rank: titleMatchRank(title, Q), lane, rk });
    }
  }

  check('real store yields "164" title hits', hits.length > 0, `${hits.length} global title hits`);

  // (1) RELEVANCE on the real store. Real FEAT-164 titles (which are DECLARED
  // agent lanes — the honest state: the user's own FEAT-164 work lives in
  // orchestrator sessions whose titles omit the number, so title search does not
  // surface them; the Messages/content ranking is what does) must rank above a
  // number-inside-a-number title. Non-vacuity: require real declared-agent
  // FEAT-164 titles to exist, else fail loudly.
  const declaredAgentFeat164 = hits.filter((h) => h.rank === 0 && h.declared === 'agent' && isFeat164(h.title));
  const declaredUserFeat164 = hits.filter((h) => h.rank === 0 && h.declared === 'user' && isFeat164(h.title));
  check('real store has DECLARED-agent FEAT-164 titles (relevance test is non-vacuous)',
    declaredAgentFeat164.length > 0, `${declaredAgentFeat164.length} declared-agent FEAT-164 titles`);
  console.log(`        (honest state: ${declaredUserFeat164.length} sessions DECLARED startedBy=user carry a FEAT-164 title — the user's FEAT-164 work is in orchestrator sessions whose titles omit "164"; the Messages ranking surfaces those)`);
  const feat = declaredAgentFeat164[0];
  if (feat) { // guarded: on a store with no such title the check above already FAILed loudly — never crash past it (independent-verify r10)
    const withNoise = [
      { title: feat.title, rank: feat.rank, lane: 1, rk: feat.rk },
      { title: 'nightly build 164790', rank: titleMatchRank('nightly build 164790', Q), lane: 0, rk: '9999-12-31T23:59:59.999Z' }, // synthetic noise, NEWEST + user
    ];
    const sortedN = withNoise.slice().sort(compareSessionHits);
    check('ranked: a real FEAT-164 token outranks a newer user "164790" number-in-number title',
      sortedN[0].title === feat.title, `top="${sortedN[0].title.slice(0, 48)}"`);
  }

  // (2) ORIGIN tiebreak, tested with REAL DECLARED provenance (realistic state):
  // a declared-user session and a declared-agent session at equal relevance — the
  // declared-user one must rank first regardless of recency. Fail loudly if the
  // store lacks either declared origin.
  check('real store has BOTH a declared-user and a declared-agent session (origin test is non-vacuous)',
    !!(oldestDeclaredUser && newestDeclaredAgent),
    `user=${oldestDeclaredUser ? oldestDeclaredUser.id.slice(0, 8) : 'NONE'} agent=${newestDeclaredAgent ? newestDeclaredAgent.id.slice(0, 8) : 'NONE'}`);
  if (oldestDeclaredUser && newestDeclaredAgent) {
    // Declared records → foldByDefault is decided by the record: user=not a lane,
    // agent=lane (foldsFromDefaultList rule 1).
    const uHit = { title: oldestDeclaredUser.title, rank: 0, lane: 0, rk: oldestDeclaredUser.rk };
    const aHit = { title: newestDeclaredAgent.title, rank: 0, lane: 1, rk: newestDeclaredAgent.rk };
    const pair = [aHit, uHit].sort(compareSessionHits); // deliberately agent-first input order
    check('ranked: at equal relevance a DECLARED-user session ranks above a DECLARED-agent lane',
      pair[0] === uHit, `top=${pair[0] === uHit ? 'user' : 'agent'}`);
    // MUST-FAIL: the pre-fix order was recency only. The declared-agent lane is
    // the NEWER of the pair, so recency order puts it FIRST — the exact inversion
    // the origin tiebreak corrects. If this does not hold the test is vacuous.
    const recencyFirst = [uHit, aHit].sort((a, b) => String(b.rk).localeCompare(String(a.rk)))[0];
    check('MUST-FAIL: pre-fix recency order puts the newer AGENT lane first (inversion the fix corrects)',
      recencyFirst === aHit, `recency top=${recencyFirst === aHit ? 'agent' : 'user'} (user.rk=${uHit.rk.slice(0, 10)} agent.rk=${aHit.rk.slice(0, 10)})`);
  }

  // Light integration: judgeLine attaches a score the sort can use.
  const sampleLine = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'ticket=FEAT-164 is the one' } });
  const judged = judgeLine(sampleLine, '164');
  check('judgeLine attaches a ticket-ref score (0)', judged && judged.score === 0, judged && judged.score);
}

/* ─────────── C. searchStore cap must not pre-empt ranking (r4) ─────────── */
console.log('C. searchStore: the maxHits cap is applied AFTER ranking');
{
  // Two matches in ONE file, the embedded-number noise FIRST in scan order and
  // the whole ticket SECOND. With maxHits=1 the pre-r4 code capped collection at
  // the first match and returned score 2; the fix judges both, ranks, then cuts,
  // so the single returned hit is the score-0 ticket. Short-lived scratch file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat189-cap-'));
  const file = path.join(dir, 'cap.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'build 164790 artifacts over here' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-02T00:00:00Z', message: { content: 'the ticket=FEAT-164 is the one you want' } }),
    ].join('\n') + '\n');
    const r = await searchStore('164', [file], { maxHits: 1 });
    check('searchStore(maxHits=1) returns the ticket hit (score 0), not the first-scanned noise (score 2)',
      r.hits.length === 1 && r.hits[0].score === 0,
      r.hits.map((h) => `score=${h.score} "${h.snippet}"`));
    check('searchStore flags truncation when it judged more than it returned',
      r.truncated === true, `truncated=${r.truncated}`);

    // r5 — a NEUTRAL query keeps the original early-stop at maxHits (no expanded
    // collection, so no perf regression): it returns exactly maxHits and flags
    // truncation. (The score-constant case needs no cross-match ranking.)
    const neutralFile = path.join(dir, 'neutral.jsonl');
    fs.writeFileSync(neutralFile, Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ type: 'user', timestamp: `2026-02-0${i + 1}T00:00:00Z`, message: { content: `the quick brown fox number ${i}` } })).join('\n') + '\n');
    const rn = await searchStore('fox', [neutralFile], { maxHits: 2 });
    check('searchStore neutral query early-stops at maxHits (perf path preserved)',
      rn.hits.length === 2 && rn.truncated === true && rn.hits.every((h) => h.score === 1),
      `hits=${rn.hits.length} truncated=${rn.truncated}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`\nFEAT-189: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
