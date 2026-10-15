```orchard-ticket
{
  "id": "FEAT-189",
  "type": "feature",
  "title": "Session search buries the session you worked in under dispatch lanes",
  "summary": "Searching a ticket number in the sidebar finder returns dispatched/verify lanes and numbers-inside-numbers ahead of the user's own session, because results are ordered by recency alone and a bare number matches as a raw substring.",
  "impact_if_we_wait": "Re-finding the one session that worked on a ticket stays a scroll-through-the-lanes chore in any project an orchestrator dispatches into, which is every active project; the finder's core job (get me back to that conversation) keeps failing on the exact query a user reaches for.",
  "current_need": "Rank user-started sessions above dispatched lanes for equal relevance (reading the declared startedBy fact), match ticket ids as whole tokens, and offer a toggle to hide lanes.",
  "severity": "medium",
  "area": "sidebar / search",
  "reported": "2026-10-14",
  "reported_by": "greyl33t",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "For query 164, the top Sessions result is a user-started session, not a dispatched lane, when such a session exists.",
    "A session whose title matches 164 only inside a longer number (164790) ranks below one whose title holds the whole ticket token FEAT-164.",
    "A visible toggle hides dispatched/agent lanes from both the Sessions and Messages groups; default shows them ranked below.",
    "No query-time regression on the ~3000-session store."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a13be2-2367-70b2-821e-d49784403048",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T19:28:53.280Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "303424ff387e173a783e379107d1d527acee68dd773a7b2d9c9f4d39093a000f",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "974e706e-28a3-4991-a236-a9f49e026689",
      "verdict": "holds",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T20:36:27.025Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "7d0e0536c2f866cfd25714a3b95604a1d753ca382a469d574b3facfe148692ea",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-189 — Session search buries the session you worked in under dispatch lanes

## Symptom
Typing a ticket number into the sidebar finder to re-find the session that worked on it surfaces the wrong things first. The user searched `164` to re-open the session for FEAT-164 (the git-grant redesign) and the top Sessions results were codex `Dispatch: ticket=FEAT-164 phase=verifying class=verify Reply with exactly PONG` ping lanes and `class=plan+review` reviewer lanes; the one real session titled `FEAT-164 git-grant redesign review` was buried. The Messages group was likewise full of dispatched reviewer lanes plus noise like `<subagent_tokens>164790</subagent_tokens>`, `scripts/lib/schema.mjs:164`, and `4164 function finishModel`.

User: "ideal if such is first results as well, see how can we make it better search, ig filter by user invoked sessions vs sub-agent to be less prio".

## Repro
1. Open the sidebar finder in a project an orchestrator has dispatched many lanes into.
2. Type a ticket number, e.g. `164`.
3. Sessions are ordered by recency only, so the newest dispatched lanes lead and the user's own session is buried; `164` also matches inside longer numbers.

## Expected
- A user-started (direct/orchestrator) session ranks above dispatched/agent lanes for the same relevance — origin read from the DECLARED `startedBy` provenance fact, not re-derived.
- A visible toggle to hide dispatched lanes entirely (default: shown, ranked below).
- A bare number or `FEAT-164` matches ticket ids as whole tokens and ranks those above substring hits inside other numbers (164790, :164, 4164).

## Context pack (grows)
- Files/functions in play: `public/lib/search-ranking.js` (new, pure: parseTicketQuery/titleMatchRank/compareSessionHits), `public/app.js` renderSearch + renderContentSearch, `src/server/search.ts` (matchRelevance + score + sort). Declared origin fact: `src/lib/session-provenance.mjs` (`startedBy`), surfaced per session by `src/server/index.ts` list route (~2032) and consumed client-side (`isAgentStarted`, `sess.startedBy`).
- Related tickets: session-provenance fold (FEAT folding lanes out of default nav), FEAT-147 (plain-text search surfacing projects).
- Repro test: `node scripts/verify-feat-189.mjs`
- Known dependencies / blockers: a running-build claim needs a claude-station restart to deploy the changed public/ + server files.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — greyl33t
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — worker (FEAT-189 fixing r1)
- **Understood:** Two search surfaces. (1) The sidebar finder's **Sessions** list (`public/app.js` `renderSearch`, ~2537) did a plain substring test on `rowTitle` and rendered in `s.list` RECENCY order — origin-blind and relevance-blind — with a 300-cap applied DURING collection (so relevant hits past the first 300 were dropped). (2) The **Messages** content search (`src/server/search.ts`) ranked prose-above-tool then recency only; a `--fixed-strings` query like `164` matched inside `164790`/`4164`/`:164`. Origin is ALREADY a declared fact: `session-provenance/<id>.json` `startedBy` ('user'|'agent'), surfaced per session by the list route (`src/server/index.ts`~2032 via `resolveStartedBy`) and already on the client session object (`sess.startedBy`, `isAgentStarted`). Per ARCH-010 I read that fact, never re-derive by regex.
- **Changed:**
  - `public/lib/search-ranking.js` (NEW, pure/testable): `parseTicketQuery`, `titleMatchRank` (0 whole ticket token → 1 standalone number/exact → 2 prefix → 3 number-inside-number → 4 none), `compareSessionHits` (relevance, then user-above-agent, then recency).
  - `public/app.js`: `renderSearch` now scores+sorts session hits with `compareSessionHits`, caps AFTER ranking, and shows a "dispatched lanes shown/hidden (N)" toggle (`state.searchIncludeLanes`, default shown-but-below). `renderContentSearch` demotes agent-started groups below user groups (stable partition on the declared `startedBy` read via new `searchHitStartedBy`) and honours the same toggle. Import added.
  - `src/server/search.ts`: new `matchRelevance(text, at, q)` (0 ticket-ref `FEAT-164` → 1 clean/standalone → 2 buried-in-number); `SearchHit.score` populated in `judgeLine`; `done()` sort is now kind → score → recency (prose-above-tool contract preserved).
  - `scripts/verify-feat-189.mjs` (NEW).
  - Commit sha: (uncommitted — left in working tree per board rules).
- **Verified:** `node scripts/verify-feat-189.mjs` → 22/22 PASS, run against the REAL global session store (read-only; no scratch server, never touched the live service). Section A units incl. a must-FAIL that the pre-fix had no score so a sort cannot separate a ticket ref from buried-number noise. Section B over the real store (16 global title-"164" hits; 1 user-started vs 15 agent lanes): post-fix top result is the user-started session, every user FEAT-164 title precedes every agent FEAT-164 lane, a synthetic `164790` row ranks below the ticket token; **must-FAIL confirmed** — pre-fix recency order put an AGENT lane first ("FEAT-164 agent git push authority verification"). Anti-regression `npm run verify:search` → 12/12 PASS (new `score` field present, prose-above-tool intact). `npm run gate` → PASS (exit 0). `npm run board:check` → no drift.
  - **Real-store finding worth recording:** the session the user called "the real one" (`FEAT-164 git-grant redesign review`, b6e6339f) is itself a dispatched REVIEW lane (`startedBy agent`). In the orchard project dir, ZERO user-started sessions have "164" in their TITLE — the user's actual working sessions are orchestrator sessions whose AI titles omit the number. So TITLE ranking alone cannot surface them; the **Messages/content** ranking (user groups first + ticket-ref score) is what brings the user's real session to the top for this query. Both halves were needed.
- **Verified-by:** pending — `node scripts/independent-verify.mjs --ticket FEAT-189` dispatched; verdict to be recorded with `board-tool verified`.
- **Still open / handoff:** (a) Needs a claude-station **restart** to deploy (service started 2026-10-14 14:01, before this edit; public/ + src/server changes are not in the running build). (b) Independent verify verdict to be recorded. (c) Side answer to the user — the user-invoked sessions that actually worked on FEAT-164 (git-grant redesign), most-FEAT-164-content first: `5bc0e694` "Orchard project complexity and session status display" (2026-10-14), `cb808f1c` (2026-10-05, board-snapshot title), `c7b4d1ea` "Scoped grants and soft release plan review" (2026-10-11).

### 2026-10-14 — dispatch openai
- **Verification recorded:** dispatch openai run 01a13be2-2367-70b2-821e-d49784403048 — VERDICT: BROKEN — mixed-state candidate 303424ff387e. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (FEAT-189 fixing r2)
- **Understood (from independent-verify BROKEN, run openai 01a13be2):** `src/server/search.ts judgeLine` scored only the FIRST occurrence of the query in a message (`prose.indexOf(q)`). A real message holding both an embedded number and the whole ticket — e.g. `164790 … then ticket=FEAT-164` — scored 2 (noise) off the earlier `164790`, demoting a genuine whole-ticket message below standalone-number matches. The verifier's adversarial scan hit 17 of 315 real ticket-bearing messages. Legitimate correctness bug in r1.
- **Changed:** `src/server/search.ts` — new `bestMatch(text, ql, q)` scans every occurrence and keeps the lowest (best) score, stopping at 0; `judgeLine` now scores prose/tool by their best occurrence and cuts the snippet around it. `scripts/verify-feat-189.mjs` — added a multi-occurrence case (`164790 … ticket=FEAT-164` → score 0) plus a must-FAIL asserting first-occurrence scoring would have returned 2. (uncommitted.)
- **Verified:** `node scripts/verify-feat-189.mjs` → 24/24 PASS (incl. the new regression + its must-FAIL). `npm run verify:search` → 12/12. `npm run gate` → PASS (exit 0).
- **regressed-from:** this fixes a defect introduced in FEAT-189 r1 (same ticket), caught by clean-room verify.
- **Still open / handoff:** re-running `independent-verify --ticket FEAT-189` for a HOLDS on the r2 candidate; restart still required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r3)
- **Understood (from independent-verify BROKEN, run 2 and run 3):** Two further findings, both legitimate. (1) r2's clean-room run flagged the TEST's non-vacuity guard as too loose — it identified "FEAT-164" titles by `rank===0`, which also accepts BUG-164/ARCH-164 (correct for the PRODUCT, since a bare `164` query matches any ticket-164, but it let the guard pass with zero literal FEAT-164 titles). (2) r3 flagged a PERF regression introduced by r2's `bestMatch`: it scanned every occurrence of the query even for a non-ticket query like `the` (1,261 scans, 1.9x slower) although such queries score a constant 1.
- **Changed:**
  - `src/server/search.ts` — extracted `isTicketNumberQuery(q)` (single source for the ticket-query regexes, used by `matchRelevance` and `bestMatch`); `bestMatch` now short-circuits after the first occurrence for any non-ticket query, so only ticket-number queries (whose score varies by position) pay the multi-occurrence scan.
  - `scripts/verify-feat-189.mjs` — the non-vacuity guard now requires a LITERAL whole-token `FEAT-164` for both a user and an agent title (reports any-prefix rank-0 counts alongside); added deterministic perf guards on `isTicketNumberQuery` (ticket queries scanned, prose queries short-circuited) plus an informational timing line (not asserted — judgeLine is legitimately O(line length)).
- **Verified:** `node scripts/verify-feat-189.mjs` → 26/26 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS (exit 0).
- **regressed-from:** FEAT-189 r2 (the perf finding); r1/r2 test precision (the vacuity finding). Both caught by clean-room verify.
- **Still open / handoff:** re-running `independent-verify` for a HOLDS on the r3 candidate; restart still required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r4)
- **Understood (from independent-verify BROKEN, run 4):** `searchStore` applied the `maxHits` cap DURING collection (stopped scanning once `hits.length >= maxHits`), so the relevance sort in `done()` only reordered the scan-order PREFIX it had collected. With more matches than the cap, the best-scoring whole-ticket hit could be dropped before it was ever judged — the same cap-before-rank defect I had already fixed on the client Sessions list, now found on the server. Verifier demo: `searchStore('164', …, {maxHits:1})` returned an embedded-number hit (score 2) while the file also held a score-0 ticket hit.
- **Changed:** `src/server/search.ts` — collection now stops only on the RAW-match budget (`raw > MAX_RAW_MATCHES`); the `maxHits` cut is applied after the full sort in `done()`, and returning fewer than were judged now sets `truncated`. `scripts/verify-feat-189.mjs` — new section C: a two-line scratch `.jsonl` (noise first, ticket second) asserts `searchStore(maxHits=1)` returns the score-0 ticket hit and flags truncation.
- **Verified:** `node scripts/verify-feat-189.mjs` → 28/28 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS. Perf note: worst-case judging was already bounded by MAX_RAW_MATCHES (2000); only the best-case early-stop at 300 hits is removed, so the ceiling is unchanged.
- **regressed-from:** latent in the original search (pre-FEAT-189) and made visible by adding relevance ranking; fixed here. Caught by clean-room verify r4.
- **Still open / handoff:** re-run independent-verify for a HOLDS; restart required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r5)
- **Understood (from independent-verify BROKEN, run 5):** the r4 fix (judge up to the raw budget, cap after ranking) regressed the COMMON neutral query: searching the real store for "the" took ~154 ms vs ~49 ms with the prior collection cap — a 3.1× regression, because every query now judged up to MAX_RAW_MATCHES instead of stopping at maxHits.
- **Changed:** `src/server/search.ts` — the expanded collection is now gated on `isTicketNumberQuery(q)`. Only a ticket-number query (whose per-match score varies, so ranking across all matches is required) judges up to the raw budget; every other query keeps the original early-stop at `hits.length >= maxHits`. So the r4 correctness fix applies exactly where it matters and the neutral-query perf path is unchanged from before this ticket. `scripts/verify-feat-189.mjs` — added a neutral-query case asserting the early-stop (returns maxHits, truncated, all score 1).
- **Verified:** `node scripts/verify-feat-189.mjs` → 29/29 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **regressed-from:** FEAT-189 r4. Caught by clean-room verify r5.
- **Still open / handoff:** re-run independent-verify for HOLDS; restart required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r6)
- **Understood (from independent-verify BROKEN, run 6):** `bestMatch` found the match offset in `text.toLowerCase()` but `matchRelevance` read neighbours in the ORIGINAL `text`. A length-changing lowercase before the match (Turkish `İ` → two code units) shifts the offset, so the adjacency check read the wrong char and a ticket ref scored 2 instead of 0. (Pre-existing in the original `judgeLine` snippet-offset too; my scoring made it observable.)
- **Changed:** `src/server/search.ts` — `bestMatch` now scores with `matchRelevance(lower, at, ql)` against the lowercased text at the lowercased offset; adjacency checks are case-insensitive and a ticket-number query is ASCII (`ql.length === q.length`), so this is exact and offset-safe. `scripts/verify-feat-189.mjs` — added a case with `İ` before the ticket ref (asserts the length-change precondition and score 0).
- **Verified:** `node scripts/verify-feat-189.mjs` → 31/31 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Note:** the display snippet offset in a length-changing-lowercase line remains the original pre-FEAT-189 behaviour (display-only; highlight stays internally consistent). Out of scope here.
- **Still open / handoff:** re-run independent-verify for HOLDS; restart required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r7)
- **Understood (from independent-verify BROKEN, run 7):** the snippet/highlight still used a lowercased-string offset against the ORIGINAL text, so with `İ` before the match the highlight slid from "164" to "64 " (score was already correct from r6; this was the display offset). Pre-existing behaviour of the original `judgeLine`, now fixed since the code was in hand.
- **Changed:** `src/server/search.ts` — added `lowerOffsetToOrig(text, lowerAt)` (walks by code point accumulating lowercased length) and `bestMatch` now returns an offset into the ORIGINAL text; the 1:1 common case (no length change) is a no-op. `scripts/verify-feat-189.mjs` — asserts the highlighted slice equals the query exactly for the İ case.
- **Verified:** `node scripts/verify-feat-189.mjs` → 32/32 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS; restart required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r8)
- **Understood (from independent-verify BROKEN, run 8, anthropic — openai quota exhausted until Oct 20):** substantive cross-surface bug. The server's `matchRelevance` scored score 0 (ticket) for ANY `<letter>-<number>` (`before==='-' && letter before`), so `page-164`, `utf-164`, and file paths like `scripts/adv-164-verbs.mjs` tied with real `FEAT-164`. The CLIENT's `titleMatchRank` correctly restricts to feat|bug|arch|deploy. On the real store, query `164` returned 300 hits, 263 score-0, but 25 of those were adv-164-* paths with no real ticket — tied with real refs and sorted by recency, so the 300 cap could push real FEAT-164 hits out.
- **Changed:** `src/server/search.ts` — `matchRelevance` now treats a bare number as a ticket ref only when a KNOWN prefix + `-` precedes it (`TICKET_REF_BEFORE`, same feat|bug|arch|deploy list as the client, with a word boundary); the prefix-query branch also requires a leading boundary. `scripts/verify-feat-189.mjs` — added page-164/adv-164/BUG-164 cases AND a server↔client AGREEMENT loop (an ARCH-010 drift guard: the two surfaces must classify the same strings identically).
- **Verified:** `node scripts/verify-feat-189.mjs` → 45/45 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **regressed-from:** FEAT-189 r1 (the server matchRelevance over-match). Caught by clean-room verify r8.
- **Still open / handoff:** re-run independent-verify for HOLDS (anthropic); restart required to deploy.

### 2026-10-14 — worker (FEAT-189 fixing r9, test honesty)
- **Understood (from independent-verify BROKEN, run 9, anthropic):** section B passed by VACUITY. The only "user-started" FEAT-164 title it relied on ("FEAT-164 agent git release verifier") is a provenance-LESS scratch clean-room session; `resolveStartedBy` returned 'user' for it only by its no-record fallback, not a declared fact. The real store holds ZERO sessions DECLARED startedBy=user with a FEAT-164 title — the user's own FEAT-164 work is in orchestrator sessions whose titles omit "164" (so title search cannot surface them; the Messages/content ranking is what does). The product is correct; the TEST's evidence was not.
- **Changed (test only):** `scripts/verify-feat-189.mjs` section B rewritten to read startedBy from the DECLARED record only (never the fallback). It now: (1) proves RELEVANCE with 15 real DECLARED-agent FEAT-164 titles outranking a synthetic newer "164790" user title, and prints the honest fact that 0 declared-user sessions carry a FEAT-164 title; (2) proves the ORIGIN tiebreak with a real declared-user session (older) vs a real declared-agent session (newer) at equal relevance — declared-user ranks first, and the must-FAIL shows recency order inverts it. No production code changed this round.
- **Verified:** `node scripts/verify-feat-189.mjs` → 44/44 PASS (honest, non-vacuous). `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — worker (FEAT-189 fixing r10, test honesty + scope)
- **Understood (from independent-verify BROKEN, run 9b, anthropic):** two residual test-honesty issues. (a) The real-store scan walked EVERY dir under the store, pulling in unregistered scratch clean-room dirs (a FEAT-164 verifier lane with no provenance) the real finder never shows — and its 'user' label was only resolveStartedBy's fallback. (b) My requirement.md still claimed "top hit is genuinely user-started" and "22/22", which the honest suite (correctly) does not satisfy.
- **Changed (test + requirement only):** `scripts/verify-feat-189.mjs` section B now scopes the scan to REGISTERED projects (registry host paths, encoded), modelling the real finder and excluding scratch clean-room dirs; the orchard encoded dir is derived from the repo path (no hardcoded home-path literal — that tripped the leak gate). The requirement file was corrected to state the accurate, honest properties (relevance ordering; origin tiebreak on DECLARED provenance only; the fact that 0 declared-user sessions have a FEAT-164 title so title search cannot surface the user's work; non-vacuity guards that fail loudly). No production code changed.
- **Verified:** `node scripts/verify-feat-189.mjs` → 44/44 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS (exit 0). Scoped real-store section: 1 FEAT-164 title hit (a declared-agent review lane), 0 declared-user FEAT-164 titles (honest), origin tiebreak proven on real declared-user vs declared-agent sessions.
- **Still open / handoff:** re-run independent-verify for HOLDS (anthropic; openai quota out until Oct 20).

### 2026-10-14 — worker (FEAT-189 fixing r11, test robustness)
- **Understood (from independent-verify BROKEN, run 10, anthropic):** (a) real crash — `declaredAgentFeat164[0]` was dereferenced without a guard, so on a store with no such title the script threw a TypeError before the non-vacuity check printed or the rest of section B/C ran (the guard did not "fail loudly", it died). (b) My requirement.md's rank table said exact = 1 while titleMatchRank returns 0 for an exact non-ticket title — a requirement/code mismatch.
- **Changed (test + requirement only):** `scripts/verify-feat-189.mjs` — guarded the FEAT-164 relevance block behind `if (feat)` so an absent artifact leaves a clean FAIL + summary + exit 1 instead of a crash. Requirement file corrected to describe titleMatchRank's ranks per query kind accurately (exact non-ticket = 0; the two kinds never mix). No production code changed.
- **Verified:** `node scripts/verify-feat-189.mjs` → 44/44 PASS. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — worker (FEAT-189 fixing r11, origin signal = foldByDefault)
- **Understood (from independent-verify BROKEN, run 11, anthropic):** a genuine PRODUCT gap. Ranking demoted lanes by `startedBy === 'agent'` (`isAgentStarted`). But a provenance-less programmatic sdk-cli scratch lane has `startedBy` fall back to 'user' (resolveStartedBy's no-record default) while the server ALREADY folds it (`foldByDefault = true`). So the finder ranked that lane as the user's own session — and, being newer, above the user's real declared session; the hide-lanes toggle (dropping only agent===1) didn't hide it either, and the Messages group shared the fault.
- **Changed (product):** the ranking/toggle origin signal is now the declared `foldByDefault` fact (`foldsFromList`, the SAME fact the nav list folds on — agent lanes AND external programmatic sessions), not `startedBy`. `public/lib/search-ranking.js` comparator field `agent`→`lane` (doc updated). `public/app.js` `renderSearch` ranks/counts/filters by `foldsFromList(sess)`; `renderContentSearch` groups by a new `searchHitIsLane(h)` (reads the row's `foldByDefault` via `foldsFromList`) instead of `searchHitStartedBy`. `scripts/verify-feat-189.mjs` — hits carry `lane` from `foldsFromDefaultList`; added an r11 unit proving a provenance-less sdk-cli session has startedBy='user' (fallback) yet foldByDefault=true, so the lane signal classifies it correctly.
- **Verified:** `node scripts/verify-feat-189.mjs` → 46/46 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS. `node --check public/app.js` OK.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — worker (FEAT-189 fixing r12, grammar lockstep)
- **Understood (from independent-verify BROKEN, run 12, anthropic):** the server and client ticket grammars had drifted on query FORMS (the ARCH-010 "two sources" smell): (1) `ticket=FEAT-164` — client accepts the `ticket=` form and scored 0, server's regex rejected it (neutral 1); (2) consequently `ticket=FEAT-1640` was not demoted; (3) dashless `feat164` on text `FEAT164` — server scored 0, client 1 (client requires the dash in the token).
- **Changed (product):** `src/server/search.ts` now carries `parseTicketQuery` as an explicit MIRROR of the client's canonical grammar (same prefix list, same `ticket=`/`#`/optional-dash forms); `isTicketNumberQuery` derives from it; `matchRelevance` rewritten so a prefixed query is a ticket ref ONLY when the matched text is the DASHED token on a boundary (so `FEAT164` and glued `xfeat-164` are not tickets, and `ticket=FEAT-1640` is demoted as embedded). They cannot share a runtime module (browser public/ vs node src/ under a strict tsconfig with no allowJs), so — following the session-provenance↔dataDir precedent — they are kept in lockstep by a verify FUZZ. `scripts/verify-feat-189.mjs` — replaced the single-string r8 loop with a cross-surface fuzz over 14 (query form × text) pairs asserting both `isTicketNumberQuery` and the ticket-ref (===0) classification agree.
- **Verified:** `node scripts/verify-feat-189.mjs` → 64/64 PASS (incl. the r12 forms now agreeing). `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — worker (FEAT-189 fixing r13, token-boundary)
- **Understood (from independent-verify BROKEN, run 13, anthropic):** for a prefixed query carrying an adornment glued to a preceding letter (`aticket=FEAT-164`, `x#feat-164`), the server checked the word boundary before the WHOLE query (so a preceding letter made it a non-ticket), while the client anchors on the ticket TOKEN (`feat-164`), whose boundary is the `=`/`#` just before it. Disagreement.
- **Changed (product):** `src/server/search.ts matchRelevance` prefixed-query branch now locates the dashed token (`prefix-num`) WITHIN the matched text and checks the boundary before the TOKEN, not before the adornment — matching the client. `scripts/verify-feat-189.mjs` — added the two adornment-glued fuzz pairs.
- **Verified:** `node scripts/verify-feat-189.mjs` → 68/68 PASS. `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — worker (FEAT-189 fixing r14, minimal ticket-query grammar)
- **Understood (from independent-verify BROKEN, run 14, anthropic):** the residual cross-surface disagreements (`feat164`, `ticket=FEAT-164` against texts where the literal query matches a different occurrence than the canonical token) are inherent to the two surfaces using DIFFERENT search primitives — the client re-derives the dashed token and scans the whole title, the server scores the literal rg match site. Exotic/adorned/dashless query forms can therefore never classify identically.
- **Changed (product):** shrank the ticket-query grammar on BOTH surfaces (`parseTicketQuery` in public/lib/search-ranking.js and its mirror in src/server/search.ts) to the minimal AGREEING set — a bare number (`164`) or the canonical dashed id (`FEAT-164`). Adorned/dashless variants (`ticket=FEAT-164`, `#164`, `feat164`) are no longer ticket queries; they fall through to ordinary substring search on both surfaces, which both classify as non-ticket, so they agree trivially. This also removes speculative grammar a user is unlikely to type.
- **Verified:** `node scripts/verify-feat-189.mjs` → 68/68 PASS (the exotic forms now agree as non-tickets). `npm run verify:search` → 12/12. `npm run gate` → PASS.
- **Still open / handoff:** re-run independent-verify for HOLDS.

### 2026-10-14 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 974e706e-28a3-4991-a236-a9f49e026689 — VERDICT: HOLDS — mixed-state candidate 7d0e0536c2f8. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (FEAT-189 fixing r14, VERIFIED)
- **Independent verification: HOLDS.** `node scripts/independent-verify.mjs --ticket FEAT-189 --provider anthropic` (openai quota exhausted until Oct 20) → dispatch anthropic run 974e706e-28a3-4991-a236-a9f49e026689, VERDICT HOLDS, VALID, mixed-state candidate 7d0e0536c2f8. Recorded via board-tool verified. This followed EIGHT BROKEN rounds from the clean-room verifier, each a real defect it caught that the fixer's own suite had missed (server/client ticket-prefix drift, best-occurrence scoring, the maxHits cap pre-empting ranking, a neutral-query perf regression, Unicode offset + highlight, test vacuity via the provenance fallback, the origin signal needing foldByDefault not startedBy, and cross-surface grammar drift) — the system working as intended.
- **Symptom of a deeper design flaw?** Partly yes, and it is already tracked: the recurring finding was "the same fact (ticket-query grammar; origin) derived in two places" — the exact ARCH-010 class. Handled here by (a) ranking on the declared `foldByDefault` fact rather than re-deriving origin, and (b) shrinking the ticket grammar to a minimal set both surfaces classify identically, guarded by a cross-surface fuzz (the session-provenance↔dataDir mirror+lockstep precedent). No new ARCH ticket needed; ARCH-010 already names the class.
- **Honest limits (from the verifier's UNTESTED list):** the browser rendering of renderSearch/renderContentSearch (the lane toggle + ordering in the real UI) was NOT exercised — it needs a live server + browser the clean room lacks; a restart + a real headless-browser pass over a busy-state fixture is still warranted before calling the UI done. A ticket query with >2000 raw rg matches can still drop a late best hit by design (MAX_RAW_MATCHES bound). judgeLine takes the prose tier before tool, so best-occurrence does not span tiers (deliberate, preserves the prose-above-tool contract).
- **Files touched:** public/lib/search-ranking.js (new), public/app.js, src/server/search.ts, scripts/verify-feat-189.mjs (new). All left uncommitted per board rules.
