```orchard-ticket
{
  "id": "FEAT-199",
  "type": "feature",
  "title": "Load session list and history incrementally for fast first paint",
  "summary": "On a fresh page load (PC and phone) the session list takes a while to appear, and opening a session takes a while to load history. User wants recent sessions and recent history first, older items loaded progressively, since almost all work is on recent sessions.",
  "impact_if_we_wait": "Every page load and session open is slow.",
  "current_need": "measure current load times and payload sizes, then paginate the session list and history (recent first, lazy older).",
  "severity": "medium",
  "area": "ui/performance",
  "reported": "2026-10-26",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Measured time to first visible session list and to first visible history drops vs a recorded baseline",
    "Older sessions and history still reachable by scrolling or paging"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "f15d0796-ed57-487e-b5db-1fb5eb0e44b3",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T21:16:09.980Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "ffe675154ed30665998011b069ace1cef5ef97fb1cfbafd2a14dd2feb9cc0661",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "0ebe209e-bc09-488c-a8a8-86c92bd01c5d",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T21:43:01.250Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "0a640c843f75e072abeccf8e76c1665c3d6c3ec89b50195c760bab2bd62e99eb",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "b757f33e-78d9-40a4-99df-6fb1fe79e715",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T21:47:16.722Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c5124e2e61f20b7307f9ec555c79a35719f0793e6c02e2227f921b9fdbed69d8",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "f345cc2a-73f7-4225-ba2a-449627693630",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T22:16:29.739Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c3970f8b02de1030d16130db43120fc23212bae67e03760c2a1034dfa9cb5061",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "c44745cb-bbc9-4172-bfd4-423b565016bc",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T22:21:23.617Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "7d32cac3cda4cc8653e6e0aff700566b1a1b6ed947599355d0c4e8563c6929bc",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "72b30fd7-a1ee-4e12-9b8d-b1cd3e712158",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T22:51:26.004Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "74e21aa67d95b67dabe7aaace4044eea59e042c3daa69e1d1335e853b0378404",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "0675f242-706e-4062-b3ca-da149ada1a75",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T22:54:56.348Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "31728c984575d69ec6935f1ef80a78567704e64a2b99724f1aaa0f70816be575",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "459a68fa-f3aa-4254-89af-65e479237694",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T23:15:57.518Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "a3e6acf1976723f51ccb2e3460fddf142dbf294e11db19de1fd2c7f6e4dba8e3",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "d37b0ba5-c8f5-4667-8f8e-099dae1f4277",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T23:19:15.127Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "46728b372620c41510aff9c0752e445d34b302b9b4aee2285b8a12e493a342bb",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "87bdfef5-c22f-4cbf-a393-74f0eaf75913",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T23:37:07.269Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "6f76c02c23dbc75e527cbcd403cb168101a025be17ec7bce6f3f19ff7c94e130",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17fbc-0a7d-7c91-9abd-b2a4175968c1",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T23:42:16.619Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c8868a86786cdb8007aab8f170587d471eb7bccd4b8009dcf34876a26f48ea06",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "5824d6f4-f27b-4a4f-8453-f99125cb46ea",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T00:12:10.523Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "0da29c0207fae4fffde895bad12a858bab277e103b7407966cac6aaf9e0e811a",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17fdd-7ee9-75c2-aee5-7d57aa1e0d83",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T00:18:26.770Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "6287b09d57b9ff70c29d33124fae8fd848d1b5a80b7cb712aab8846a7cf05d9b",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "b75a6a71-dcd6-44fb-8bfe-cf17267b7f3f",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T00:50:17.345Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "3fdcea5bf8075a63142f2bfd221a508dfe42a0ef3c6d5219c011413e220c7a5f",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "6567f228-2fa7-4b9e-bea9-ad7213be1ec6",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T00:55:39.380Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "cc511c2d8b508bf33aace5689e251be4acb608075dddef21779c8b6d78f1d2bc",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "64129a8c-3304-4f7d-a6c4-203b1baefdbd",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T03:45:39.926Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "93348e163b7e31458e468011b7a9a6306fcb88796be2989a9165196e2151593d",
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

# FEAT-199 — Load session list and history incrementally for fast first paint

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-26 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-26 — finding lane (explore)
**Live measurement BLOCKED.** curl to the running server on :4317 and any read of the
real store at `~/.claude/projects` were both refused by an unanswered Orchard
permission prompt (30-min timeout, not a user decision). So the requested median
time-to-response / payload-size numbers and the store's file counts/sizes could NOT
be gathered this pass. Everything below is code-path analysis + the numbers already
recorded in-code. Re-dispatch with curl + `~/.claude` read granted to record the
baseline.

**Hypothesis verdict.**
- LIST side — CONFIRMED (and worse structurally): the list is returned UNPAGINATED.
- HISTORY side — REFUTED: opening a session does NOT send the whole transcript. The
  UI already loads newest-first and the server already windows (see below).

**Where the time goes (file:line).**
- List endpoint `GET /api/projects/:id/sessions` — handler `src/server/index.ts:2141`
  building via `sessionsForProject` (`src/server/index.ts:529`). Returns ALL sessions
  for the project, no limit/cursor.
  - Cold (fresh server / after restart): `hist.listSessions` →
    `readSessionMeta` (`src/lib/session-history.ts:751`) SAMPLES up to 256 KB head +
    256 KB tail = ~512 KB read PER FILE (`DEFAULT_HEAD/TAIL_BYTES`, lines 296-297),
    over every file in every store dir (claude store + container + pastPaths +
    orchard-owned + native codex scans). `metaCache` (`session-history.ts:572`) is
    in-memory and mtime-keyed → CLEARED on restart, so the first load after a restart
    pays the full per-file sample cost.
  - Per row even when warm: `smut.readTitleMeta` (`src/server/session-mutations.ts:421`,
    its own mtime cache, samples 512 KB window on big files), plus a `statSync` per
    file in `listSessions`. `loadProvenanceMap` and `closedReader` are loaded ONCE per
    request (good). `closedBy` reads a file tail ONLY for sessions that have a close
    record (`src/server/session-closed.ts:128-148`), so closed-check is cheap for most
    rows.
  - So warm cost ≈ (statSync × all files) + full JSON payload of every row's meta +
    full client render of the whole sidebar. Cold cost ≈ that + ~512 KB read × all files.
- History open — `openSession` (`public/app.js:7096`) already calls
  `api.transcriptTail(..., { limit: TAIL_PAGE })`, `TAIL_PAGE = 200` (`app.js:5271`),
  older pages `OLDER_PAGE = 120` on scroll-up. Server route `src/server/index.ts:2532`:
  the tail is a BACKWARD scan from EOF (O(page), never reads bytes it doesn't need).
  The ONLY whole-file work is the message COUNT needed to label absolute indices —
  `tx.countThenTail` (`src/server/transcript.ts:996`) → `countMessages` (`:884`), a full
  fold measured in-code at **249 ms on a 53 MiB session, ~2.3 s on the 286 MiB one**
  (comment `transcript.ts:739`). That count is `countCache`-memoised AND persistable to
  a validated sidecar (`enableCountPersistence`), so a warm/previously-counted open is a
  delta or a 0-byte cache hit. A truly cold first-ever open (or after a counting-code
  change that invalidates the sidecar) still pays the full fold before first paint.

**Design + expected win (from the code, not measured).**
1. (FIRST — biggest lever, lowest risk) Paginate `GET /api/projects/:id/sessions`:
   return recent N (e.g. 30-50, ordered by `lastUserMessageAt`) + a cursor for older,
   loaded on scroll. The list is the first-paint blocker and is 100% unpaginated today.
   A page of N instead of all-M cuts cold per-load file-sampling and payload roughly
   M/N (e.g. ~10× if a busy project has ~10 pages). Warm, it shrinks the JSON + render.
2. (SECOND) Persist/warm the list meta across restarts (mirror the count-sidecar
   pattern) or a per-dir index, so a cold first load isn't O(all files × 512 KB). Lower
   priority once (1) lands, because a page then touches only N files.
3. (THIRD) History: confirm `enableCountPersistence` is ON in the running server; and
   consider rendering the tail WITHOUT the absolute count for first paint (number
   lazily) so a cold first-ever open of a huge session paints before the full fold.
   Already fast warm, so lowest priority.

**Risks to carry into the build.**
- Search over all sessions: a paginated list can't be the search corpus — needs a
  server-side search/index or an explicit "search all" fallback.
- Deep links to an old session/turn: must resolve one session by id regardless of which
  page it's on (`hist.resolveSessionFile` already does id→file, so the open path is
  fine; only the sidebar highlight needs a "fetch this row if off-page" path).
- Badges/status from the full list: `pinned` rows must be force-included on page 1;
  `live` already comes from the separate cheap `/api/sessions/live`; `closed` is
  per-row and stays correct per page.

**Success target to record as baseline (needs the blocked perms to measure):**
list first paint < 300 ms warm / < 800 ms cold; history first paint < 400 ms for a
recent large session. Record medians of 3 once curl + store read are granted.

### 2026-10-27 — fixing lane (worker)
- **built: paginated session list:** Shipped server-side pagination of GET /api/projects/:id/sessions (opt-in ?limit/offset; full path unchanged for search + internal callers) plus client wiring.

  BASELINE (user's busiest real project trading-volume, ~2.73k sessions, 2.0 GB store; isolated scratch server reading the real store read-only):
  - live warm list call (full, unpaginated): median ~357 ms, 2.85 MB payload.
  - library cold full listSessions: 3245 ms; route-level readTitleMeta over all rows cold: 5971 ms — cold route ≈ 9-18 s (measured cold full HTTP 11.3-18.5 s across boots).

  AFTER:
  - COLD first page (?limit=60): 1.6-4.7 s vs cold full 11.3-18.5 s (>2x, measured each on a fresh boot).
  - WARM first page: ~110-166 ms, 64 KB vs full 2.85 MB (44x smaller payload).
  - Real headless browser (brave): first session row visible ~440-800 ms; boot now fetches ONLY page 1 (regression caught + fixed: loadAllSessions boot-warm was briefly made full-load; split into warm=page1 vs finder=loadAllSessionsFull).
  - Union of all pages == full set (2735==2735, page.total exact); off-page old session resolves by ?session=<id>; deep link to a rank-2000 session opens (no "not here"); "N more" fetches deeper pages (6->126 rows). Desktop + phone + deeplink screenshots captured.

  Mechanism: listSessionStubs (stat-only, src/lib/session-history.ts) orders candidates by file mtime; only the window's files are parsed (readSessionMeta) + readTitleMeta. sessionPageForProject + sessionByIdForProject in src/server/index.ts; sessionsForProject (full path) untouched. Client: loadSessions paginates, loadMoreSessions appends (dedupe by sessionId), resolveRouteSession resolves off-page deep links, visibleSessions.hidden + header badge account for the server remainder.

  INDEPENDENT VERIFY (anthropic, run dd92b8e5, MIXED-STATE candidate 610bb8e6): verdict BROKEN on SYNTHETIC adversarial stores (real store passed union-equivalence). 3 findings: (1) dedupe keyed filename stem vs full path's in-file sessionId -> a duplicate; (2) cross-dir dup tie-break larger-file vs canonical-cwd -> different copy; (3) mtime ordering (ticket-SANCTIONED). HARDENED (1) post-parse dedupe by true sessionId + (2) canonical-dir tie-break; proven by scripts/verify-feat-199-adversarial.mjs (F1/F2 now match full path; page.total is an exact-in-healthy / upper-bound-on-pathological stem count). The BROKEN verdict is bound to the PRE-hardening candidate; a fresh IV re-verify against current files is warranted (I used my one IV run).

  Files: src/lib/session-history.ts, src/server/index.ts, public/app.js, public/lib/api.js, scripts/verify-feat-199-pagination.mjs (real-store+browser), scripts/verify-feat-199-adversarial.mjs (synthetic). Gate PASS. No regression in verify-sessions (52/52, real store byte-identical), verify-bug-085/193, verify-session-recency, verify-search, verify-feat-070-sidebar; verify-bug-252 fixed-mode 15/15 (its round1 crash is a pre-existing undefined writeLongTranscript, file untouched by me).

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run f15d0796-ed57-487e-b5db-1fb5eb0e44b3 — VERDICT: BROKEN — mixed-state candidate ffe675154ed3. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane r2 (worker)
- **Structural fix: KEYSET cursor keyed by the TRUE session id.** Addresses all three findings of run f15d0796 (BROKEN). regressed-from: the r1 offset-pagination build (same ticket, prior Activity entry).

  WHAT CHANGED:
  - **True-id pool.** `sessionPageForProject` now keys its candidate pool on the IN-FILE sessionId, recovered cheaply by a new `readSessionIdHead` (src/lib/session-history.ts) — a 16 KB head read + field match, NO full parse (measured ~25 ms warm / ~130 ms cold for 2.6 k files; the sessionId is a top-level field on the first entry). Falls back to the stem when the head carries no id (truncated/empty), exactly as readSessionMeta does. So the pool collapses the SAME duplicates the full path collapses (finding 1): a file whose stem ≠ its in-file id occupies ONE slot and surfaces once across the whole walk.
  - **Keyset cursor replaces offset.** The order is recency desc, true-id asc (a UUID — a stable, store-dir-independent tiebreak). The page is the rows STRICTLY AFTER an opaque `{m,s}` cursor (base64url JSON). A delete/insert ABOVE the cursor between fetches can no longer skip or double a later page (findings 2 & 3). `encodePageCursor`/`decodePageCursor` + a `badRequest` helper in src/server/index.ts; route returns `page:{limit,total,hasMore,cursor}`.
  - **Forged cursor** → HTTP 400 (garbage base64, wrong shape, wrong field types); empty cursor → first page; server never crashes.
  - **"Newer" merge — hypothesis CONFIRMED, no new param needed.** The sidebar already re-fetches page 1 on live updates: loadSessions({force:true}) fires from the live tick when a session ends (app.js ~11789) and via refreshCurrentProjectSessions on run-finish; each re-anchors s.serverCursor from the top. So an updated below-cursor session reappears on that refresh — it never vanishes. Verified e2e (keyset PART B). Client: loadSessions/loadMoreSessions carry `cursor` not `offset` (app.js); api.js projectSessions takes `{limit,cursor}`.

  PROOF (all green):
  - scripts/verify-feat-199-keyset.mjs (NEW) 20/20. PART A models offset-vs-keyset slicers: must-FAIL reproduced — OFFSET skips survivor s4 after a delete; OFFSET re-returns s3 after an update; KEYSET strands/doubles neither; page-1 refresh surfaces the bumped row. PART B real scratch server: finding 1 (walk surfaces each once, total==distinct true-id count), finding 2 e2e (bumped below-cursor session reappears on refresh), finding 3 e2e (delete strands no survivor), equal-mtime cross-dir pair each once + deterministic, limit=1/==N/>N, empty project, exactly-N, forged/garbage/wrong-shape/wrong-type cursor → 400, empty cursor → first page, server healthy after.
  - scripts/verify-feat-199-adversarial.mjs 5/5 — F1 no dup, set==full, F2 canonical copy kept, page.total == distinct true-id (now EXACT, not upper-bound).
  - scripts/verify-feat-199-pagination.mjs (REAL store, trading-volume 2735 sessions): cold first page 1853 ms vs cold full 11779 ms (>2x); warm page 174 ms/64 KB vs 2856 KB; union over the CURSOR walk == full (2735==2735); page.total==2735; deep link by id (rank ~2000); browser "N more" cursor walk 6→126 rows; desktop/phone/deeplink shots.
  - Gate PASS (exit 0). Regressions: verify-sessions 52/52, verify-session-recency 11/11, verify-search 12/0, verify-feat-070-sidebar 14/14, verify-bug-085 11/11, verify-bug-193 all PASS (post-test crash is a PRE-EXISTING uncleared OUTBOX_POLL_MS timer firing after teardown — reproduced identically on HEAD app.js, not mine), verify-bug-252 fixed-mode 15/15 (pre-existing `writeLongTranscript` crash, file untouched).
  - full path sessionsForProject unchanged.

  Files: src/lib/session-history.ts, src/server/index.ts, public/app.js, public/lib/api.js, scripts/verify-feat-199-keyset.mjs (new), scripts/verify-feat-199-adversarial.mjs, scripts/verify-feat-199-pagination.mjs. Independent re-verify (anthropic) launched on the working-tree files with the r2 contract; verdict recorded by the orchestrator.

- **IV verdict BROKEN (anthropic run 0ebe209e, mixed-state candidate 0a640c843f75) — two real defects, BOTH now fixed in the working tree.** The run was contract-VALID; it found:
  1. **readSessionIdHead diverged from readSessionMeta.** The first cut read only 16 KB and regex-matched the first `"sessionId"` string. A file whose first entry is a >16 KB snapshot with no top-level id (and whose stem ≠ in-file id) was keyed by stem → the session appeared twice across the walk, page.total 7 vs full 6. FIXED: readSessionIdHead now PARSES JSONL lines (no raw regex) over the SAME regions readSessionMeta samples (whole file when small; else 256 KB head, then 256 KB tail), with a 32 KB fast path for normal files, so it returns EXACTLY the id readSessionMeta resolves (before the stem fallback). src/lib/session-history.ts.
  2. **Comparator mismatch.** The pool sort used `a.sessionId.localeCompare(b.sessionId)` while the cursor filter used a code-unit `>`. At equal mtimes with mixed-case ids (a…, B…, c…) a limit=1 walk dropped B… and a limit=2 walk doubled a…. FIXED: one code-unit `cmpId` used in BOTH the sort tiebreak and the cursor filter. src/server/index.ts.

  Re-proof: scripts/verify-feat-199-keyset.mjs extended with BOTH adversarial shapes (a >32 KB snapshot-first-entry file with stem≠id colliding with uuid(6); a mixed-case equal-mtime trio a…/B…/c…) — now 25/25 PASS. Adversarial 5/5, real-store pagination PASS (cold first page 2680 ms vs 10200 ms full, union 2735==2735), gate PASS (exit 0). The BROKEN verdict is bound to the PRE-fix candidate 0a640c843f75; the post-fix files are a NEW candidate that still needs a fresh IV (HOLDS) before close — generation must not be its own only verifier for this regression-prone, session-lifecycle change. I have used my one IV run this lane.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 0ebe209e-bc09-488c-a8a8-86c92bd01c5d — VERDICT: BROKEN — mixed-state candidate 0a640c843f75. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run b757f33e-78d9-40a4-99df-6fb1fe79e715 — VERDICT: BROKEN — mixed-state candidate c5124e2e61f2. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run f345cc2a-73f7-4225-ba2a-449627693630 — VERDICT: BROKEN — mixed-state candidate c3970f8b02de. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r3 (worker)
- **Two structural fixes for run b757f33e (BROKEN), plus a follow-up for the interleaving IV run f345cc2a found.** regressed-from: the r2 keyset build (same ticket, prior Activity entry).

  DEFECT 1 (server, off-page deep link). `sessionByIdForProject` resolved by FILENAME (`resolveSessionFile` → `<id>.jsonl`), so a deep link to a session whose file STEM ≠ its in-file sessionId returned null — the exact row the paginated list shows (keyed by the TRUE in-file id) could not be opened by id. FIX: extracted `buildSessionCandidatePool(p)` (src/server/index.ts) — the ONE recency/true-id index the paginated list already builds — and routed the resolver through it: the id is a map key, only the single matching candidate's file is parsed. One index, one derivation; a stem match is just the common case where a file's name equals its id. Same-id twins now resolve to the SAME copy the list shows (shared pool), and a tail-recovered id behind a >256 KB first entry resolves (readSessionIdHead already samples head+tail).

  DEFECT 2 (client, finder search). The finder searched the paginated sidebar list (`s.list`); any forced page-1 refresh (live tick, run-finish, pin) replaced `s.list` with only page 1 while `state.searchLoaded` stayed true, dropping every beyond-page-1 session from search. FIX: a SEPARATE `state.searchCorpus` (Map<projectId, Map<sessionId,row>>) that only GROWS — seeded by a full load, refreshed by merging each page-1/load-more in by sessionId, never shrunk by a forced reload. The finder reads `searchRowsFor(id)` (corpus if built, else the page-1 list as a fallback), and the "of N" count follows the corpus. public/app.js.

  RACE (client, charter's could-not-test item). A `loadMoreSessions` in flight when a forced page-1 reload lands no longer appends stale-cursor rows: `s.listGen` is bumped on every page-1 (re)load; a load-more captures its generation and drops its response if the generation moved. public/app.js.

  FOLLOW-UP (independent-verify run f345cc2a, BROKEN, contract-VALID — a real defect in the Defect-2 fix). When `loadAllSessionsFull` fired WHILE a forced page-1 reload was in flight, `loadSessions`'s `if (s.loading) return s.inflight` handed the `{full:true}` caller the in-flight PAGE-1 promise, so the corpus latched at 60/N and `searchLoaded` stuck true — the rest of the store unsearchable for the page's life (same Defect-2 symptom, different interleaving). FIX: a full/forced caller no longer accepts a lesser in-flight load — it awaits the in-flight load (tracked by `s.inflightFull`/`s.inflightForce`) then runs its OWN load; a plain caller still shares. public/app.js.

  KNOWN LIMITATION (named per the verifier's could-not-test list): the corpus prunes only on a full load, and `searchLoaded` latches, so a session DELETED after the full load lingers in finder results for the page's life; clicking a stale hit resolves gracefully (deep-link returns null → "not here"). Low severity, consistent with the ticket's "corpus only grows / refreshed on its own terms" design; left for a future pass rather than widening scope here.

  PROOF (all green):
  - scripts/verify-feat-199-r3-deeplink.mjs (NEW) — real scratch server: lone stem≠id, tail-recovered id behind a >256 KB first entry, same-id twin (resolver == the copy the paginated list shows), stem==id, unknown id → 0 rows, server healthy. MUST-FAIL reproduced by temporarily restoring the r2 filename-only resolver: the two stem≠id deep links returned 0 rows.
  - scripts/verify-feat-199-r3-client.mjs (NEW) — PART A model must-FAIL on the r2 shape (list-search loses a beyond-page-1 row after a forced refresh; no-gen append mixes a stale-cursor row); PART B real headless browser over a 150-session/3-page scratch store (finder finds a rank-140 session; after a forced reload the sidebar LIST shrank to 60 while the corpus kept 150 and the finder still finds it; load-more racing a forced reload → no duplicate rows, gen advanced); PART C the f345cc2a interleaving — full-load during a forced reload builds the complete 150/150 corpus. MUST-FAIL for PART C reproduced by temporarily reverting the inflight fix (corpus 60/150).
  - scripts/verify-feat-199-r3.mjs (NEW) — canonical runner chaining both r3 suites.
  - Regressions: verify-feat-199-keyset 25/25, verify-feat-199-adversarial 5/5, verify-feat-199-pagination (REAL store, 2735 sessions: union 2735==2735, cold first page 1.6 s vs 11.3 s full, deep link rank ~2000 opens in brave), verify-sessions 52/52, verify-session-recency 11/11, verify-feat-070-sidebar 14/14, verify-bug-193 31/31, verify-search 12/0, verify-finder 5/0. verify-session-scope FATAL on a precondition that needs a REAL live `haiku` session (this lane cannot spawn a live agent) — environmental, not a regression; verify-bug-252 FAIL is the pre-existing `writeLongTranscript`-undefined crash in the test's PRE-FIX path (fixed-mode 15/15 PASS), file untouched.
  - npm run gate PASS (exit 0).
  - full path `sessionsForProject` unchanged.

  HIGH-STAKES / regression-prone (session-lifecycle + deep-link + search). The IV run f345cc2a BROKEN verdict is bound to the PRE-follow-up-fix candidate c3970f8b02de; the post-fix files are a NEW candidate that still needs a FRESH independent verify (HOLDS) before close — I have used my one IV run this lane. Files: src/server/index.ts, public/app.js, scripts/verify-feat-199-r3.mjs, scripts/verify-feat-199-r3-deeplink.mjs, scripts/verify-feat-199-r3-client.mjs.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run c44745cb-bbc9-4172-bfd4-423b565016bc — VERDICT: BROKEN — mixed-state candidate 7d32cac3cda4. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — fixing lane r4 (worker)
- **round-4 structural fix: one canonical session index + cursor rescope:** Structural fix for run c44745cb (BROKEN), breaks 1 & 2, per ARCH-010. regressed-from: the r3 buildSessionCandidatePool host-dir tie-break (same ticket, prior entry).

  ONE OWNER OF SESSION IDENTITY. New hist.canonicalSessionIndex(encodedDirs, opts) (src/lib/session-history.ts) is the single function that decides which file is the canonical copy of each session id. The full list (listLogicalProjectSessions), the paginated pool (buildSessionCandidatePool -> sessionPageForProject) and the deep-link resolver (sessionByIdForProject) ALL read it; the pool's OWN host-encoded-dir tie-break is DELETED. No reader re-derives the fact (ARCH-010). It is built cheaply: stat + one HEAD parse per file via the new readSessionHeadFacts (returns the in-file sessionId AND cwd from the SAME head/tail regions readSessionMeta samples; readSessionIdHead is now a thin wrapper). The common no-twin walk never reads a whole file, so the first page stays cheap. HYPOTHESIS CONFIRMED: the canonical rule needs only the head (cwd is a top-level first-entry field like sessionId).

  TIE-BREAK (lives only in canonicalSessionIndex): (1) the copy with MORE real messages wins (completeness); (2) equally complete -> the copy whose own cwd encodes to its dir (canonical); (3) else larger file. The message count is read LAZILY and only on a same-id twin collision (rare), memoised by readSessionMeta, so the winner's later parse is a cache hit.

  CURSOR RESCOPE (round-4 DECISION, break 3). A page cursor is a POSITION, not an authorisation: it holds no secret and grants nothing, so a client that edits a well-formed cursor just gets a different valid page. Only a MALFORMED cursor (garbage base64 / wrong shape / wrong field types) returns 400. No HMAC. The keyset suite contract wording + a positive assertion (a fabricated well-formed cursor -> 200, a subset of a fresh walk) were updated to match.

  IV (anthropic run 72b30fd7-a1ee-4e12-9b8d-b1cd3e712158, MIXED-STATE candidate 74e21aa67d95) returned a VALID BROKEN on my FIRST cut, which guarded only fileBytes>0: a >0-byte host-dir twin that was TRUNCATED to its first line (235 B, 1 msg) or METADATA-ONLY (149 B, 0 msgs) counted as non-empty and then won on canonical-cwd over the real 80-/60-message sibling, so full/page/deep all served the stub and hid the real transcript. FIXED by replacing the fileBytes>0 check with the real-message-count completeness measure above. The BROKEN verdict is bound to the PRE-fix candidate 74e21aa67d95; the post-fix files are a NEW candidate.

  PROOF (all green): scripts/verify-feat-199-r4-canonical.mjs (NEW) PART A models the r3 full-vs-pool disagreement (S1 host non-canonical larger; S2 0-byte host) AND the r4-first-cut break (S3 truncated host; S4 metadata-only host) as must-FAIL, then proves the real canonicalSessionIndex + listLogicalProjectSessions keep the real OTHER copy (2/80/120/100 msgs) for all four; PART B drives the live route over twins across 3 dirs -> full list, page union and ?session= deep link agree on every id and resolve A->d1 (canonical over larger), B->d2 (canonical over larger non-canonical), C/D/E (0-byte/truncated/metadata host stub) -> the real sibling. keyset 26/26 incl the fabricated-cursor-as-position case; adversarial 5/5; r3 (deeplink+client) PASS (r3-deeplink twin fixture corrected: both-canonical was ill-posed, now a clear canonical-vs-non-canonical so the canonical copy is the unambiguous winner); pagination REAL store (union 2740==2740, page.total 2740, cold first page ~1.8 s vs ~full, deep link rank ~2000 opens in brave, first-page 64 KB vs 2.8 MB). verify-feat-199-r4.mjs (NEW) is the single canonical runner. Regressions: verify-sessions 52/52 (real store byte-identical), verify-session-recency 11/11, verify-feat-070-sidebar 14/14, verify-search 12/0, verify-finder 5/0, verify-feat-078-native-codex 36/36, verify-bug-193 31/31, verify-bug-252 fixed-mode 15/15 (its PRE-FIX path still crashes on the pre-existing undefined writeLongTranscript, file untouched). npm run gate PASS (exit 0, typecheck included). full path sessionsForProject unchanged.

  HIGH-STAKES (session-lifecycle + deep-link + could hide a real transcript). I used my one IV run this lane on the pre-follow-up candidate; the post-fix files need a FRESH independent verify (HOLDS) before close. Files: src/lib/session-history.ts, src/server/index.ts, scripts/verify-feat-199-r4-canonical.mjs (new), scripts/verify-feat-199-r4.mjs (new), scripts/verify-feat-199-keyset.mjs, scripts/verify-feat-199-r3-deeplink.mjs, scripts/verify-feat-199-pagination.mjs.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 72b30fd7-a1ee-4e12-9b8d-b1cd3e712158 — VERDICT: BROKEN — mixed-state candidate 74e21aa67d95. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 0675f242-706e-4062-b3ca-da149ada1a75 — VERDICT: BROKEN — mixed-state candidate 31728c984575. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 459a68fa-f3aa-4254-89af-65e479237694 — VERDICT: BROKEN — mixed-state candidate a3e6acf19767. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r5 (worker)
- **round-5 structural fix: the full list reads the ONE canonical pool across ALL sources, and completeness tolerates sampled counts.** Structural fix for run 0675f242 (BROKEN). regressed-from: the r4 one-canonical-index build (same ticket, prior entry), which unified only the GROUP dirs; and the r4 completeness rule (msgCount) for the sampled-count defect.

  AUDIT (places that CHOOSE among same-id copies), before → after:
  - BEFORE (6): (1) `hist.canonicalSessionIndex` claude tie-break; (2) `sessionsForProject` container-dir `seen.has` merge; (3) its pastDirs `seen.has` merge; (4) its orchard `seen.has` merge; (5) its native-codex `seen.has` merge; (6) `buildSessionCandidatePool` mergeRow (orchard/native precedence over the canonical claude base). (`listLogicalProjectSessions` is a pure pass-through over #1, not a chooser.)
  - AFTER (1): `buildSessionCandidatePool` is the ONE pool builder — `hist.canonicalSessionIndex` over the COMPLETE claude dir set (group + container + past) for claude twins, then one mergeRow for the orchard/native precedence. `sessionsForProject` now DELEGATES to it (parses each pool entry, chooses nothing); the container/past/orchard/native `seen.has` loops in the full list are DELETED. The page and the deep link already read the pool. HYPOTHESIS CONFIRMED: exactly one chooser remains.

  DEFECT 1 (the 0675f242 break). `sessionsForProject` ran `canonicalSessionIndex` over the GROUP dirs only and then first-seen-merged the container, past-path and orchard dirs — a SECOND derivation. A host-dir copy, "seen" first, shadowed the real past-dir/container transcript, so the full list could serve a truncated/0-byte/metadata-only HOST stub while the page and the deep link (reading the complete index) served the real transcript. r4's PART B never caught it because its three dirs shared a basename (all in the logical group). FIX: the complete claude dir set now flows through the single index; src/server/index.ts.

  DEFECT 2 (independent-verify run 459a68fa, VALID BROKEN, candidate a3e6acf19767 — a real defect this round's own IV found). `canonicalSessionIndex`'s completeness rule compared `readSessionMeta.messageCount`, which for a file past the head+tail sample budget is a SAMPLED LOWER BOUND. A 512 KB, 29-line truncated PREFIX in the canonical host dir (counted ~28) beat a 5.6 MB, 120-message real transcript in a past store (sampled ~10), so full/page/deep ALL served the prefix and hid the real session. FIX: compare messageCount ONLY when BOTH `statsExact`; when either is sampled, fall back to FILE SIZE — a truncated prefix is strictly fewer bytes than the whole transcript it was cut from. src/lib/session-history.ts (`canonicalSessionIndex` preferCur/stats; `CanonicalSessionEntry.messagesExact`). Proven by a standalone probe: host 539298 B count 28 (sampled) vs past 11.8 MB count 10 (sampled) — OLD count-first picks HOST (the bug); NEW size-fallback picks past.

  PROOF (all green):
  - scripts/verify-feat-199-r5-sources.mjs (NEW): PART A re-implements the r4 `sessionsForProject` claude merge EXACTLY and shows it serves the 1-msg HOST stub for a host↔past twin (MUST-FAIL), while the complete `canonicalSessionIndex` keeps the real past-dir transcript. PART B drives the REAL server over twins across host/past/container/orchard/native: full list, keyset page union and ?session= deep link agree on every id; host stubs (truncated / metadata-only / 0-byte / missing-cwd) never shadow the real transcript in past or container stores; three-way (host/container/past); past↔container; the sampled-vs-truncated BIG twin (run 459a68fa) → past; orchard-owned + native-codex + symlinked twin present once in both; extreme cursors (m=1e308, huge m+s, negative) → 200 valid page; malformed cursor → 400; server healthy after.
  - Regressions: verify-feat-199-{r4-canonical, keyset 26/26, adversarial 5/5, r3 both suites}; pagination REAL store (union 2747==2747, cold first page ~3.5 s vs ~12.6 s full, deep link rank ~2000 opens); verify-sessions 52/52 (real store byte-identical, 7879==7879); verify-session-recency 11/11; verify-feat-070-sidebar 14/14; verify-search 12/0; verify-finder 5/0; verify-feat-078-native-codex 36/36; verify-bug-193 31/31. The r3 suite's PART B/C are the REAL headless-browser client checks (generation guard, finder corpus never shrinking, load-more race) — unchanged by this server-side fix and still green.
  - npm run gate PASS (exit 0, typecheck included).

  HIGH-STAKES (session-lifecycle + deep-link + could hide a real transcript). The IV BROKEN verdict (459a68fa) is bound to the PRE-fix candidate a3e6acf19767; the post-fix files are a NEW candidate that still needs a FRESH independent clean-room verify (HOLDS) before close — I used my one IV run this lane and it found Defect 2, so generation must not be its own only verifier here. Files: src/server/index.ts, src/lib/session-history.ts, scripts/verify-feat-199-r5-sources.mjs (new).

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run d37b0ba5-c8f5-4667-8f8e-099dae1f4277 — VERDICT: BROKEN — mixed-state candidate 46728b372620. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 87bdfef5-c22f-4cbf-a393-74f0eaf75913 — VERDICT: BROKEN — mixed-state candidate 6f76c02c23db. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r6 (worker)
- **round-6 structural fix: the canonical twin tie-break uses the EXACT real-message count — no proxy.** Structural fix for run d37b0ba5 (BROKEN). regressed-from: the r5 size-fallback completeness rule (same ticket, prior entry).

  THE BREAK (run d37b0ba5). r5's completeness rule fell back to FILE SIZE whenever either twin's messageCount was a sampled lower bound (a file past the 512 KB head+tail budget). Size is a PROXY for completeness, and the proxy broke: an 822 KB metadata-only twin (0 real messages, all `summary`/`isMeta` lines, sitting in the canonical host dir) is BIGGER than an 80-message real transcript, so size picked the metadata stub and hid the real session from the full list, the page AND the deep link. Every completeness proxy has now broken in turn — fileBytes>0 (run 72b30fd7), sampled messageCount (run 459a68fa), file size (run d37b0ba5).

  FIX (src/lib/session-history.ts). On a same-id twin collision, `canonicalSessionIndex` now computes the EXACT count of real (`user`/`assistant`, non-meta, non-sidechain) messages of EACH copy by a FULL streaming parse of the whole file — no head/tail sampling, no maxBytes cap (new `exactRealMessageCount`, memoised in `exactCountCache` keyed by (path, mtime, size); cleared by `clearSessionCache`). The winner is picked by a TOTAL-ORDER sort key (collect every copy, compute the key, pick the max — NOT pairwise "prefer" calls, so 3+ copies pick a unique transitive winner independent of dir-walk order): (1) more exact real messages; (2) equal counts → the canonical-cwd copy; (3) then newest mtime; (4) then a stable path comparison (smaller path). The exact parse runs ONLY on an actual collision (rare); the common no-twin walk stays at stat + one head parse per file (no whole-file read).

  HYPOTHESIS (collisions rare) CONFIRMED on the REAL store: a full walk of every project source — 1659 encoded dirs, 7290 session files, 7290 distinct in-file ids — found ZERO twin ids (0 same-id files, 0 cross-dir). So the exact-count cost is never paid in practice; first-page timing is unchanged (pagination suite: cold first page 3302 ms vs 12960 ms full, union 2747==2747).

  DEFECT (independent-verify run 87bdfef5, VALID BROKEN, candidate 6f76c02c23db — my own IV found it; it also PRE-existed in r5). `isCanon` compared plain `encodeCwd(e.cwd)` with `encodedDir`. For a cwd over 200 chars the SDK truncates to 200 and appends a hash (`sdkEncodeDir`, BUG-243), so plain `encodeCwd` NEVER matches the real dir and tie-break rule (b) silently never fired for long-path projects — a newer non-canonical twin then beat the genuinely canonical copy on mtime, and the full list/page/deep link all served the wrong copy. FIX: `isCanon` now uses `sdkEncodeDir` (the SDK's real store-placement authority). Proven by a new long-cwd case (334-char cwd) in the r6 suite.

  PROOF (all green):
  - scripts/verify-feat-199-r6-exact-count.mjs (NEW): PART A — MUST-FAIL reproduction of the r5 size-fallback (re-implemented as `r5PreferCur`): the 822 KB metadata-only twin (0 msgs) beats the 80-msg real transcript on size; r6 keeps the real transcript (exact 80>0). Plus: sampled-size real (240 msgs) beats the 29-line truncated prefix (459a68fa); equal counts → canonical-cwd over a LARGER non-canonical twin; equal counts+canon → newest mtime; 3 copies (big-meta/truncated/real) → the 100-msg real, 2 dropped, winner independent of all dir orders; twin grows between builds → cache key changes, winner flips (10→60); symlinked twin → one winner, no crash (a symlink is not enumerated as a 2nd copy — `Dirent.isFile()` is false); long >200-char cwd → canonical (sdkEncodeDir) copy wins over a newer non-canonical twin. PART B — REAL server over the 822 KB metadata twin and a 3-way host/past/container mix: full list, keyset page union and ?session= deep link agree on every id and serve the REAL past transcript.
  - Regressions: verify-feat-199-{r4-canonical, keyset, adversarial, r3 (both, incl. the REAL headless-browser client: generation guard, finder corpus, load-more race), pagination (real store + browser deep link)} all PASS; r5-sources PASS; verify-sessions 52/52 (real store byte-identical); verify-session-recency 11/11; verify-session-reorder-usermsg 6/6. verify-session-reorder-durable timed out on "S1 turn never finished" — it drives a real agent turn needing a live provider; unrelated to the twin tie-break and environmental.
  - npm run gate PASS (exit 0, typecheck included).

  HIGH-STAKES (session-lifecycle + deep-link + could hide a real transcript). The IV BROKEN verdict (87bdfef5) is bound to the PRE-fix candidate 6f76c02c23db; the post-fix files (isCanon → sdkEncodeDir + the long-cwd test) are a NEW candidate that still needs a FRESH independent clean-room verify (HOLDS) before close — I used my one IV run this lane and it found the long-cwd defect, so generation must not be its own only verifier here. Files: src/lib/session-history.ts, scripts/verify-feat-199-r6-exact-count.mjs (new).

### 2026-10-27 — dispatch openai
- **Verification recorded:** dispatch openai run 01a17fbc-0a7d-7c91-9abd-b2a4175968c1 — VERDICT: BROKEN — mixed-state candidate c8868a86786c. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 5824d6f4-f27b-4a4f-8453-f99125cb46ea — VERDICT: BROKEN — mixed-state candidate 0da29c0207fa. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r7 (worker)
- **round-7: the transcript read resolves THROUGH the one canonical-index owner (not by filename), and a finder load failure never latches.** Fixes the two defects openai run 01a17fbc (BROKEN) found on r6.

  STEP-1 MEASUREMENT (real store, read-only). Scanned every file under `~/.claude/projects` (the store `resolveSessionFile` reads): 7294 files, **0** whose filename stem ≠ their in-file sessionId (1627 have no in-file id → stem IS the id by fallback, so no mismatch). The in-file-id preference (`resolvedId = sessionId ?? base`, `readSessionMeta`) predates FEAT-199 (initial public release 609db5e), so defect (1) is a **PRE-EXISTING gap, NOT a FEAT-199 regression** — but it is the simplest case of the same twin-shadowing the ticket has fought, so it is fixed in scope (small change), not shelved.

  DEFECT (2) — finder load failure latched (FIXED). `loadAllSessionsFull` set `state.searchLoaded=true` unconditionally after `Promise.all`. But `loadSessions` NEVER rejects: a network blip is caught inside it, recorded on `s.error`, and it RESOLVES — so `Promise.all` settles even when a project failed, latching a PARTIAL corpus the finder treated as complete, and the retry (guarded by `searchLoaded`) never ran. FIX (public/app.js): latch `searchLoaded` ONLY when EVERY project load succeeded (`results.some(s => s.error)` → leave corpus as is, `searchLoaded` false, `searchLoadError` true); the finder shows a "results may be incomplete" retry hint; the next finder open/focus retries the whole set (loaded projects return early inside `loadSessions`, only the failed ones re-fetch) and completes the corpus. New state `searchLoading` (re-entry guard) + `searchLoadError`.

  DEFECT (1) — transcript read by filename shadowed the canonical copy (FIXED). The route resolved the claude file by `hist.resolveSessionFile(encodedDir, sessionId)` = `<sessionId>.jsonl` by FILENAME, re-deriving (ARCH-010 violation) the choice the list/page/deep-link resolver make through `canonicalSessionIndex`. My FIRST cut added a canonical fallback only when the filename lookup MISSED — which IV run 5824d6f4 (VALID BROKEN, candidate 0da29c0207fa — my own one IV run found it) showed still loses when the filename HITS: a truncated `<X>.jsonl` stub next to a renamed full copy with the same in-file id served the stub; a stem collision (`<Y>.jsonl` holding in-file id Z) served session Z when the caller asked for Y. FIX: resolve the claude file INDEX-FIRST through the one owner — new `hist.resolveCanonicalSessionFile(encodedDir, sessionId)` (= `canonicalSessionIndex([encodedDir]).get(id)?.filePath`, same path-safety guards as `resolveSessionFile`); the transcript route uses it and no longer calls `resolveSessionFile` for the claude store. regressed-from: this round's own first cut (the miss-only fallback).

  PROOF (all green):
  - scripts/verify-feat-199-r7.mjs (NEW): PART A — real server over a stem≠id scratch store: `?session=<inFileId>` resolves the row and `GET /api/transcript/<dir>/<inFileId>` serves the REAL transcript (status 200, 7 msgs); MUST-FAIL probe that `resolveSessionFile(dir, inFileId)` is null (the r6 404 path); anti-regressions (normal stem==id still reads, unknown id still 404s). PART D — the IV's own two twin-shadowing shapes over the real server: MUST-FAIL probe that `resolveSessionFile` picks the stub `<X>.jsonl` / the colliding `<Y>.jsonl`, while the route (via the index) serves the 41-msg canonical copy for X, session Y for Y, and session Z for Z. PART B — pure model, MUST-FAIL on the r6 unconditional latch; r7 keeps `searchLoaded` false on failure and the retry completes. PART C — REAL headless browser (brave) over a 2-project busy-state store (alpha 80, beta 150; both >1 page so the full fetch really hits the network): beta's full fetch aborted → `searchLoaded` stays false, `searchLoadError` true, corpus partial (alpha 80, beta stuck at page-1 60), finder renders the retry hint; network restored → next open completes the corpus (beta 150) and latches `searchLoaded`.
  - Regressions (all PASS, re-run AFTER the index-first change): verify-feat-199-{r3, r3-client, r3-deeplink, r4, r4-canonical, r5-sources, r6-exact-count, keyset, adversarial, pagination}; verify-sessions.ts 52/52 (real store byte-identical, 7885==7885, after a first-run concurrent-write flake on the LIVE store that cleared on re-run); verify-session-recency 11/11; verify-session-reorder-usermsg 6/6; verify-session-provenance 25/25; verify-session-switch-url 7/7. verify-session-scope and verify-session-reorder-durable need a LIVE provider (a session going live with model "haiku") and time out in this environment — unrelated to the deep-link/finder change (same environmental limit r6 noted).
  - npm run gate PASS (exit 0, typecheck included — read unpiped).

  HIGH-STAKES (session-lifecycle + deep-link + could serve the wrong/stale transcript). I used my one IV run this lane and it found the miss-only-fallback defect; the post-fix index-first candidate is a NEW candidate that still needs a FRESH independent clean-room verify (HOLDS) before close — generation must not be its own only verifier here. Files: src/lib/session-history.ts (new `resolveCanonicalSessionFile`), src/server/index.ts (transcript route), public/app.js (loadAllSessionsFull + searchLoading/searchLoadError + retry hint), scripts/verify-feat-199-r7.mjs (new).

### 2026-10-28 — dispatch openai
- **Verification recorded:** dispatch openai run 01a17fdd-7ee9-75c2-aee5-7d57aa1e0d83 — VERDICT: BROKEN — mixed-state candidate 6287b09d57b9. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run b75a6a71-dcd6-44fb-8bfe-cf17267b7f3f — VERDICT: BROKEN — mixed-state candidate 3fdcea5bf807. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r8 (worker)
- **round-8: close the "external append, no live tick" hole — load-more carries a high-water mark AND a count-guarded full reconcile.** Fixes openai run 01a17fdd (BROKEN), then the defect this round's own IV (anthropic run b75a6a71, VALID BROKEN) found on the first cut. regressed-from: the r2 keyset/offset build whose "newer merge" relied on the page-1 refresh (same ticket, prior entry).

  THE BREAK (run 01a17fdd). The keyset "More" walk returns only rows STRICTLY AFTER the cursor. A session an EXTERNAL process appends to (a CLI outside Orchard) fires NO Orchard live tick, so no page-1 refresh happens. If that session was OFF-PAGE (below the consumed cursor) and the append bumps its recency ABOVE the cursor, the row jumps from below the cursor to above it: it is in no later page and page 1 never refreshes. After exhausting "More" the union was 149 of 150. r2 had deferred carrying a client mark, relying on the live page-1 refresh — which that scenario never fires.

  FIX PART 1 (the charter's prescribed design — the common case). Every load-more carries the client's high-water mark (`since` = the newest row it saw on the first page, returned as `page.headCursor`). The server returns, alongside the page, a `newer` array of rows STRICTLY NEWER than that mark in the total order (recency desc, true-id asc — SAME code-unit comparator as the cursor filter, so an equal-mtime boundary row lands on exactly one side of each). The client merges `newer` at the top, deduped by sessionId (an update to a row already shown refreshes in place, never duplicates). A forged `since` → HTTP 400, like a forged cursor. Server: `sessionPageForProject`/route in src/server/index.ts; client: `upsertSessionRows` + loadMoreSessions carry `since`, loadSessions captures `serverHead`; api.js passes `since`.

  FIX PART 2 (the correctness safety net — the IV's defect). IV run b75a6a71 (VALID BROKEN, candidate 3fdcea5bf807 — my own one IV run found it) showed PART 1 ALONE is insufficient: a row bumped ABOVE the consumed cursor but BELOW the head mark is in neither a later page nor `newer`. Reachable in reality (cases D1/D1b) when page 1's newest row has a FUTURE / clock-skewed mtime (a container or remote filesystem), so a normal append at the real current time sorts under the mark → still 149/150. FIX: when, and ONLY when, the exhausted walk's union is SHORT of the server's declared total (`!serverHasMore && serverTotal > s.list.length`), the client reconciles ONCE against the authoritative full list (`reconcileFullList` → `api.projectSessions(id)`, the same canonical pool the pages read — `sessionsForProject` delegates to `buildSessionCandidatePool`), which is complete by construction regardless of recency/clock skew. The count guard means the common walk — and the common `newer`-caught bump — never pays this fetch; only a real discrepancy does. public/app.js.

  PROOF (all green):
  - scripts/verify-feat-199-r8.mjs (NEW): PART A pure keyset model — MUST-FAIL (1) r7 walk strands a bumped off-page row (9/10); r8 `newer` recovers an above-mark bump (10/10); MUST-FAIL (2) `newer` ALONE strands an above-cursor/below-mark bump (the IV D1/D1b case, 9/10) while the count-guarded full reconcile recovers it (10/10); defensive equal-mtime id-tiebreak partition. PART B+C REAL headless browser (brave) over busy 150-session (>2-page) stores, external append = file content + mtime with NO live event (live route stubbed empty so refreshLive never force-refreshes page 1): B1 MUST-FAIL reproduces 149/150 with the full r7 contract (newer+headCursor stripped AND the reconcile blocked); B2 FIX 150/150 (newer catches the common off-page bump, present once, sorts to top); C1 several updates mid-scroll all present; C2 update to an already-shown page-1 row present exactly once (no dup); C3 delete+update together → union == full (149), updated present, deleted gone, no dup; D1 the IV's skew case (future-dated page-1 head) — MUST-FAIL 149/150 with the reconcile blocked, FIXED 150/150 with it intact.
  - Regressions (all PASS, re-run after the client change): verify-feat-199-{r3 (both suites incl. the REAL headless-browser client: generation guard, finder corpus never shrinking, load-more race), keyset, pagination (REAL store, union 2735==2735, cold first page vs full), r7 (REAL browser finder-latch), adversarial, r4, r4-canonical, r5-sources, r6-exact-count}; verify-sessions 52/52 (real store byte-identical); verify-session-recency 11/11; verify-session-reorder-usermsg 6/6; verify-session-provenance 25/25; verify-session-switch-url 7/7. verify-session-scope and verify-session-reorder-durable need a LIVE provider and are environmental (same limit prior rounds noted), not a regression.
  - npm run gate PASS (exit 0, typecheck included — read unpiped).
  - full path `sessionsForProject` unchanged; first page (no `since`) and every existing caller (search, deep link, ?session=) are byte-for-byte what they were.

  HIGH-STAKES / regression-prone (session-lifecycle + list-completeness + could drop a real session from the sidebar). The IV BROKEN verdict (b75a6a71) is bound to the PRE-reconcile candidate 3fdcea5bf807; the post-fix files (count-guarded reconcileFullList) are a NEW candidate that still needs a FRESH independent clean-room verify (HOLDS) before close — I used my one IV run this lane and it found the skew defect, so generation must not be its own only verifier here. Files: src/server/index.ts, public/app.js, public/lib/api.js, scripts/verify-feat-199-r8.mjs (new).

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 6567f228-2fa7-4b9e-bea9-ad7213be1ec6 — VERDICT: BROKEN — mixed-state candidate cc511c2d8b50. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 64129a8c-3304-4f7d-a6c4-203b1baefdbd — VERDICT: HOLDS — mixed-state candidate 93348e163b7e. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r9 (worker)
- **round-9 / BUG-282: the end-of-walk reconcile is UNCONDITIONAL and BY ID; a failed reconcile is retried and never silently latches.** Fixes the two gaps independent run 6567f228 (BROKEN) found in the r8 count-guarded reconcile. regressed-from: the r8 count-guarded reconcileFullList (same ticket, prior entry).

  STEP-1 MEASUREMENT (real store, read-only). Scanned every `.jsonl` under `~/.claude/projects` (the store the pages + reconcile read): **13141 files, 0 with a future mtime** (max skew 0.000 h). So the clock-skew precondition both breaks need does NOT occur on this machine today — the fix is by-construction insurance for a container/remote-FS clock skew, not a live-reproduced loss here.

  THE TWO BREAKS (run 6567f228), both classified:
  - BREAK 1 — equal-count / different-members. The r8 guard reconciled ONLY when the exhausted union was SHORT of the server total (`serverTotal > list.length`). A DELETE of an already-shown row (the client keeps a GHOST — upsert never removes) PLUS a stranded off-page add (a below-head-mark/above-cursor append `newer` cannot see — reachable with a future-dated page-1 mtime) keep the union COUNT equal to the new total while the MEMBERS differ, so the guard never fired: the bumped row stayed lost and the ghost stayed.
  - BREAK 2 — a failed reconcile was swallowed by loadMoreSessions' catch-all with no retry and no flag, silently latching a possibly-incomplete list (the "N more" was already gone, so nothing re-triggered it).

  THE FIX (public/app.js). When the keyset walk reaches the end (`!s.serverHasMore`), ALWAYS reconcile ONCE — no count guard — via `ensureListComplete` → `reconcileFullList`, which replaces the in-hand list with the authoritative complete pool (`api.projectSessions(id)`, no paging), adding any stranded row and dropping any ghost BY ID. Complete by construction regardless of recency/clock skew, so it covers both breaks. A failed reconcile is NOT swallowed: `ensureListComplete` flags `s.listIncomplete` (a visible "list may be incomplete — retry" hint renders in the project's sidebar group, public/styles.css `.list-incomplete`), `scheduleReconcileRetry` retries with 1s/2s/4s… backoff capped at 30s, and the hint's retry button (`retryListReconcile`) or the next successful reconcile clears the flag. A page-1 (re)load resets the flag + cancels the pending retry (the fresh walk reconciles at its own end); a forced-reload mid-reconcile drops the stale response by generation. Reaching the end is rare (the charter's accepted cost).

  PROOF (all green):
  - scripts/verify-feat-199-r9.mjs (NEW): PART A pure model — MUST-FAIL (1) the r8 count guard misses the equal-count/diff-members case (union size==total, s07 lost + s01 ghost), r9's unconditional by-id reconcile == full set; MUST-FAIL (2) the r8 catch swallows a failed reconcile (no retry, no flag), r9 flags + the backoff retry recovers. PART B REAL headless browser (brave) over busy 150-session (>2-page) stores, external append with NO live tick: E1 future-head delete+bump (equal-count/diff-members) → union == full BY ID (bump present, ghost gone, no dup, not flagged); E2 the authoritative full-list reconcile FAILS during the walk → `listIncomplete` true, union short, the `.list-incomplete` hint renders (NOT a silent latch), then restore + retry → union 150/150 and the flag clears.
  - Regressions (all PASS, re-run after the client change): verify-feat-199-{r8, r7, r3 (+client), keyset, pagination (REAL store — union 2768==2768, page.total exact, cold first page >2x the full list on a warm-cache run; one cold run was 1.83x = a page-cache timing flake, re-ran 3.67x, correctness identical), adversarial, r4, r4-canonical, r5-sources, r6-exact-count}; verify-sessions 52/52 (real store byte-identical); verify-session-recency 11/11; verify-session-reorder-usermsg 6/6; verify-session-provenance 25/25; verify-session-switch-url 7/7.
  - npm run gate PASS (exit 0, typecheck included — read unpiped).

  INDEPENDENT VERIFY (anthropic run 64129a8c, mixed-state candidate 93348e163b7e): VERDICT **HOLDS** (VALID, manifest-backed). The verifier built its OWN adversarial runs and all passed: a REAL DOM "N more" click-walk on a 2-page store with delete+bump recovering by the AUTOMATIC backoff timer (no manual call) + an HTTP-500 (not just aborted) reconcile failure + a DOM retry-button click that keeps the flag while the server still fails and clears it on recovery; and a forced-reload-supersedes-inflight-reconcile race (3s-held full-list response, page-1 reload mid-flight → stale reconcile dropped, page 1 kept, flag cleared, re-walk == full by id, boot loads page 1 only, forged since/cursor → 400). HIGH-STAKES bucket (session-lifecycle + list-completeness) — satisfied by this fresh clean-room HOLDS; generation was not its own only verifier. Verifier's UNTESTED notes: no real-store browser run (synthetic 100–150-session stores), a forever-hanging reconcile fetch (flag set only on reject), backoff beyond n=3/the 30s cap, phone-width/collapsed-group layout, and the live tick was stubbed in every run.

  Files: public/app.js, public/styles.css, scripts/verify-feat-199-r9.mjs (new).
