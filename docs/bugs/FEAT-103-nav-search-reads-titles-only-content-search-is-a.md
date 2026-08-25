```orchard-ticket
{
  "id": "FEAT-103",
  "type": "feature",
  "title": "nav search reads titles-only: content search is a hidden Enter-only mode",
  "summary": "Content search over session transcripts already ships (src/server/search.ts + rg), but typing in the nav bar runs the title-only tier and content search fires only on Enter, behind a placeholder that says 'Search sessions'. The user therefore experiences the search as titles-only. A real-store needle also exposed a locate() off-by-one that lands a hit one message early.",
  "impact_if_we_wait": "A shipped, fast, correct search stays invisible; users conclude the app cannot search what they said, and the one hit they do click lands on the wrong message.",
  "current_need": "none — the suite is green again over the real store after its needle stopped being unique",
  "severity": "medium",
  "area": "nav search / transcript content search",
  "reported": "2026-08-24",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Typing a word that exists only in the prose body of one old session surfaces that session without pressing Enter.",
    "Clicking that hit opens the session scrolled to the exact matched message, not the one before it.",
    "The landed message is visibly highlighted for a few seconds.",
    "Content hits are grouped per session with a hit count, a per-group cap and a show-more control; title matches remain first and visually separate.",
    "Debounced typing never leaves more than one search process in flight, and the server never blocks on a scan.",
    "Verified in a real headless browser against the real read-only transcript store, with the rendered result inspected as a screenshot."
  ],
  "code_refs": [
    {
      "path": "src/server/search.ts",
      "note": "rg spawn, judgeLine classification, locate() canonical index mapping"
    },
    {
      "path": "public/app.js",
      "note": "renderSearch title tier, runContentSearch, renderContentSearch, searchHitRow, openSearchHit"
    },
    {
      "path": "scripts/verify-search.mjs",
      "note": "existing coverage to extend with discoverability and grouping"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# FEAT-103 — nav search reads titles-only: content search is a hidden Enter-only mode

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-24 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-24 — agent (browser verification of the uncommitted implementation)
- **First actual browser run.** The implementation had never been driven in a
  browser; the sandbox that wrote it could not bind a socket. Own server on a
  free ephemeral port, scratch data dir, headless Brave over CDP, real
  read-only transcript store (993 sessions, 5 registered projects).
- **The one test that matters PASSES.** Typing the body-only phrase
  (`available only to approved organizations through Project Glasswing`) with
  no Enter surfaces the one old session that contains it, in a different
  project from the open one, matched on prose the title never mentions.
- **Three defects found in the browser, all fixed here.**
  1. Clicking any content hit threw `ReferenceError: loc is not defined`
     (`openSearchHit` read a `const` scoped to the `try` block) — every hit was
     dead on click. Fixed by hoisting the `exact` flag.
  2. The hit row is one clamped line, and the server's ~90-character run-up
     pushed the highlighted match off it: 12 of 13 rendered hits showed no
     visible match at all. The row now keeps at most a short lead-in.
  3. A slow typist waited **9.6 s** after their last keystroke: every
     superseded request still paid ~1.03 s for the SYNCHRONOUS store walk
     before noticing it had been abandoned. The handler now yields to the poll
     phase and checks the abort first — measured 9.6 s → 2.4 s.
- **locate() off-by-one: does not exist in the browser path.** Server
  `locate(line 19)` returns `{index:4, exact:true}`; the rendered message
  carrying the phrase is `data-i="4"`; the click lands on it and highlights it.
  Judged on a screenshot, not only on assertions.
- **Measured on the real store:** debounce 226 ms, rg scan 26–98 ms, render
  ~1 ms, and ~1.05 s of store enumeration that `/api/projects` pays too — so
  ~1.4 s keystroke→hits, of which the search itself is a twentieth. That
  enumeration is pre-existing and wants its own ticket. Never more than one rg
  child alive; the UI kept rendering ~60 fps while typing.
- **Counts:** `verify:feat-103` 8/8 (was 5 passed / 1 failed before the fix,
  and two of its checks were vacuous: the rg counter read only the main
  thread's children and answered 0 forever, and the busy case registered one
  project so the caps were never reached). `verify:search` 12/12,
  `verify:finder` 5/5, `verify:finder-scope` 7/7, `npm run gate` PASS (exit 0
  — it failed first on home-path leaks in the two verify scripts, now derived
  from `os.homedir()`).

### 2026-08-24 — agent
- **rendered verification:** Real-browser verification against the real read-only store passed the one test that matters: typing the Glasswing phrase with no Enter surfaces the single old session that contains it, and clicking lands on the exact matched message (data-i=4, matching locate()), visibly highlighted. The Phase-2 off-by-one was against a legacy reader only; the browser-facing reader shares locate()'s coordinate space. Three defects were found only by looking: openSearchHit() read loc outside its try block so every hit was dead on click with a ReferenceError; the mark fell off the clamped snippet line so 12 of 13 hits showed no visible match; and each superseded request paid a ~1.03s synchronous store walk before noticing it was abandoned, making a slow typist wait 9.6s (now 2.4s). verify:feat-103 8/8, verify:search 12/12, verify:finder 5/5, verify:finder-scope 7/7, gate PASS exit 0. Measured separately and NOT this ticket's: GET /api/projects costs the same ~1.05s enumeration, worth its own ticket.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). `npm run verify:feat-103` was RED at HEAD and it was the fixture, not the product. The needle is a phrase quoted out of a real transcript; agents have since discussed this suite in their own sessions, so the phrase now appears in several REAL sessions that outrank the fixture, and the check clicked `.cs-hit` first — some other session first row — and then waited for the fixture session to open. Fixed the fixture, not the assertion: the suite now finds the fixture session OWN hit by session id, recomputing the flat rendered index with renderContentSearch own grouping and caps so it addresses the row a user would click, and it fails loudly (a new named check) if the fixture session is not rendered at all, so it can never pass by having lost its subject. The property under test is unchanged and is still the ticket point: clicking a hit lands on and highlights that hit exact rendered message. Re-ran: 9 passed, 0 failed, exit 0 read directly — landing index is still 4 with the needle highlighted, hit index 10 in the busy list, one rg child at a time, caps and show-more honest, no clipped mark. Closing as verified. Symptom of a deeper design flaw? Worth handing forward: a verifier whose needle is a real phrase from a real corpus contaminates itself as soon as anyone writes about it, and the survivable shape is to select the subject by identity rather than by rank.
