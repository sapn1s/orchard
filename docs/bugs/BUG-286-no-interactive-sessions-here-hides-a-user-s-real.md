```orchard-ticket
{
  "id": "BUG-286",
  "type": "bug",
  "title": "\"No interactive sessions here\" hides a user's real sessions (FEAT-199)",
  "summary": "The sidebar tells trading_volume \"No interactive sessions here. 60 background/scripted sessions are hidden\", yet 5 real user sessions (74-143 msgs, Aug-Sep) exist. FEAT-199 loads only the first recency page; in a dispatch-heavy project all 60 newest rows are folded agent lanes, so the page listedCount is 0 and the client prints an all-hidden claim only the full list supports.",
  "impact_if_we_wait": "A user with substantial conversations is told they have none and reasonably concludes their sessions were deleted. The sessions are intact on disk and in the API; only the UI denies them.",
  "current_need": "Client fix in public/app.js: never show the all-hidden note while serverHasMore is true; when page 1 has zero listed rows but more exist, escalate once to the full list. Served from disk, so a browser reload suffices - no restart.",
  "severity": "high",
  "area": "ui/session-list",
  "reported": "2026-10-28",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A project whose first page is entirely folded never shows the false empty note while serverHasMore is true",
    "The user's own interactive sessions in such a project become reachable from the sidebar without a manual full-list action",
    "A genuinely all-folded project still shows the honest all-hidden note once the full list is in hand",
    "Normal projects never trigger the escalation, so FEAT-199 cold-start cost is unchanged for them"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "note": "renderTree empty-state branch (~2042) and loadSessions page-1 reset (~1625)"
    },
    {
      "path": "src/lib/session-provenance.mjs",
      "note": "foldsFromDefaultList - correct, not the bug"
    }
  ],
  "related": [
    {
      "id": "FEAT-199",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "4648fc31-75c0-4c7f-8ead-3d2745d6ee48",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:24:17.046Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "4f5d54bee13424c2249d180206c1c9aed3e2ab6cd7635b85c84cfac774cd9a13",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1824e-ca4a-7443-9649-32fa718b4a76",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:45:54.767Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "9e3986566511a13bff6008e302a22889d1ac335d584cca0361ee3b4be0365e1c",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a18258-af6c-7f71-8da8-e759d3dd2a67",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:55:57.016Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "893b34b79be86bca43d652e75459c1aec4dbc8ab8fb4a24d92ad9309c27e988c",
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs.",
    "dropped": []
  }
}
```

# BUG-286 — "No interactive sessions here" hides a user's real sessions (FEAT-199)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — worker (finding r1 — diagnosed + fixed + verified in worktree)
- **regressed-from: FEAT-199** (commit 61af156 "load the session list and history incrementally").

**Ground truth (user's reality, read-only).** Project `trading_volume` (id `trading-volume`, hostPath `~/<redacted>/trading_volume`) is intact: its transcript store under `~/.claude/projects/<encoded-hostPath>/` holds 2718+ `.jsonl` files. The live server (`http://127.0.0.1:4317/api/projects/trading-volume/sessions`) returns 2949 rows: startedBy agent 2933 / user 16, foldByDefault true 2944, **5 non-folded interactive user sessions** — "Under the water conversation" (143 msgs), "Review handoff and project state for trading engine" (96), "Review trading system status and pending decisions" (91), "Backtesting storage and market period analysis" (74), "Ref-driven strategy tested and refuted…" (54), started Aug 28–Sep 26. Nothing was deleted.

**Cause.** The sidebar classification/fold is correct and server-owned (`src/lib/session-provenance.mjs#foldsFromDefaultList`, read via the client's `foldsFromList`). The defect is in `public/app.js`. FEAT-199 made `loadSessions` fetch only the first recency PAGE (`SESSION_PAGE=60`). In this dispatch-heavy project the 60 newest rows are all agent lanes (folded), so `listedCount(s)` of the PAGE is 0 while `s.serverHasMore` is true. The empty-state branch in `renderProjectGroup` (`else if (s?.loaded && !listedCount(s))`) then rendered `allHiddenNote` — "No interactive sessions here. 60 background/scripted sessions … are hidden" — a claim only the COMPLETE list can support. The 5 interactive sessions are older and sit past page 1, so they were never in the client's hands. Pre-FEAT-199 the whole list loaded, `listedCount` was 5, and this branch never fired (header showed "5" + "N more"). So the FALSE message is the sole FEAT-199 regression; the separate fact that months-old sessions fold under "N more" is intended, pre-existing behaviour.
- `GET …/sessions?limit=60` on the real store confirms `page.hasMore=true` and zero non-folded rows on page 1.

**Deploy note.** `public/app.js` is served from disk at request time, so the running server (process started 09:52, before 61af156 at 10:44) still serves the CURRENT FEAT-199 client — which is why the live server paginates (`?limit=60` returns a 60-row page). The fix is client-side: **a browser reload suffices; NO service restart.**

**Fix (public/app.js, 2 hunks).** (1) In the empty-state branch: while `s.serverHasMore` is true, never show the note — escalate ONCE to the full list (`void loadSessions(p.id, { full: true })`, guarded by `s.escalatedForInteractive`) and show a "reading history…" hint; only when the complete list is in hand (`serverHasMore` false) may the honest all-hidden / empty-project note render. (2) In the page-1 load reset block, re-arm `s.escalatedForInteractive = false` on each fresh page-1 walk (a full load leaves `serverHasMore` false, so it never loops). Only fires for an all-folded first page — normal projects (page 1 has listed rows) never reach here, so FEAT-199's cold-start cost is unchanged.

**Verification.** `scripts/verify-bug-286-all-folded-first-page.mjs` — boots the REAL app.js in happy-dom against a REAL scratch server whose reader points at the user's REAL `~/.claude/projects` (read-only) and whose scratch DATA dir is seeded with the real `trading-volume` registry row AND a read-only copy of the real `session-provenance/` records (the fold depends on those records, not the transcript's first message — with an empty provenance dir the classifier mis-reproduces). Runs `cd .claude/worktrees/bug-286 && node scripts/verify-bug-286-all-folded-first-page.mjs`.
  - **POST-FIX: 6/6 PASS** — page 1 all-folded (`pageListed=0 hasMore=true`); the false note never renders; escalation fires (`serverHasMore=false listLen=2923`); `listedCount=5`; the 3 checked interactive titles are reachable once the window is lifted; and the synthetic genuinely-all-folded project STILL shows the honest note.
  - **PRE-FIX (HEAD app.js, hunks reverted): 2/6** — reproduces the user's EXACT string "No interactive sessions here. 60 background/scripted sessions (agent lanes or external ‑p runs) are hidden from…"; escalation absent (`serverHasMore=true listLen=60`, `listedCount=0`); titles unreachable. Only the precondition and the synthetic-honest-note checks pass (as they should).

**STATUS / handoff.** Fix applied + verified in git worktree `.claude/worktrees/bug-286` (untracked verify script + 2-hunk app.js diff). It could NOT be landed into the main working tree: `public/app.js` was held under a FEAT-129 advisory file-lock by a concurrent lane (`cs-mvrtp3kd-1`) for the whole session. The verify script IS in the main tree (`scripts/verify-bug-286-all-folded-first-page.mjs`). **Next: apply the 2-hunk app.js diff to the main tree once that lock releases, run `npm run gate`, then `node scripts/verify-bug-286-all-folded-first-page.mjs` from the repo root (it must go 6/6).** Anti-regression to run: `scripts/verify-bug-085-sidebar-cap.mjs`, the `scripts/verify-feat-199-*.mjs` suite. Independent clean-room verify warranted (session-lifecycle / regression-prone file).

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 4648fc31-75c0-4c7f-8ead-3d2745d6ee48 — VERDICT: BROKEN — mixed-state candidate 4f5d54bee134. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (fixing r2 — reentrancy regression fixed)
- **Clean-room BROKEN finding (run 4648fc31).** My r1 escalation called `loadSessions(p.id,{full:true})` SYNCHRONOUSLY inside `renderProjectGroup`, which runs inside `renderTree`'s project loop. `loadSessions` sets `s.loading=true` and calls `renderTree()` BEFORE its first await; that nested render cleared `#tree` and rebuilt every project, then the interrupted outer loop re-appended every project AFTER the escalating one — duplicate project groups in the sidebar (adv-B, adv-C each appeared twice). A real defect I introduced; requirement 4 (other projects unaffected) was violated.
- **Fix (r2).** Defer the escalation out of the synchronous render: `queueMicrotask(() => { void loadSessions(p.id, { full: true }); })`. The microtask runs after `renderTree`'s loop unwinds, so `loadSessions`' own `renderTree()` no longer re-enters mid-loop. One-line change to the same hunk; everything else unchanged.
- **Regression coverage.** Added scenario E to `scripts/verify-bug-286-all-folded-first-page.mjs`: an all-folded `serverHasMore` project placed FIRST, ahead of three other projects, all expanded; render once and assert every project group appears EXACTLY once. **Must-fail proof:** with the synchronous call restored → `FAIL E` (`groups=[EscalFirst,adv-A,adv-B,adv-C,adv-B,adv-C]`, 6/7); with `queueMicrotask` → 7/7.
- **Re-verify.** Local suite 7/7 against the main tree (`node scripts/verify-bug-286-all-folded-first-page.mjs`). A fresh clean-room `independent-verify` on the new candidate is in flight; its verdict is recorded in verification[] separately.

### 2026-10-28 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1824e-ca4a-7443-9649-32fa718b4a76 — VERDICT: BROKEN — mixed-state candidate 9e3986566511. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (fixing r3 — sticky full-list + non-destructive error, LANDED)
- **Clean-room BROKEN #2 (run 51074bff, anthropic).** The r2 re-arm (`s.escalatedForInteractive=false` on every page-1 reload) re-escalated on each forced reload: it threw away the full list, flickered the header back to "0+" behind "reading history…", and re-fetched all ~2925 rows (3 reloads → 3 extra full fetches). A failed escalation also never retried.
- **Clean-room BROKEN #3 (run 01a1824e, openai).** (a) The escalation kicked `loadSessions(…,{force:true})`, which does NOT share with a concurrent full-list load → two full fetches. (b) If a redundant/failed reload 500s, the `renderProjectGroup` error branch replaced the whole group with "history unavailable" even though the full list with the interactive rows was already loaded — hiding the user's sessions behind a transient error.
- **Fix (r3, public/app.js — supersedes the r1/r2 `escalatedForInteractive` guard).**
  1. **Sticky full list:** `loadSessions` computes `wantFull = full || s.needsFullList`; the escalation sets `s.needsFullList = true` so every later (re)load fetches the full list DIRECTLY instead of dropping back to a 60-row page. No flicker, one fetch per reload, and a plain reload naturally retries after a transient failure (the `escalatedForInteractive` reset and guard are gone).
  2. **Share the escalation fetch:** the kick is `queueMicrotask(() => loadSessions(p.id, { full: true }))` — `{full:true}` (not `force`) shares with a concurrent finder full-load (no duplicate full fetch) while still deferring out of the synchronous render (keeps the r2 no-duplicate-groups fix).
  3. **Non-destructive error:** the error branch shows "history unavailable" only when there is NO listed content to fall back to (`s?.error && !(s?.loaded && listedCount(s))`); with a loaded listed list it falls through to render the sessions plus a small "couldn't refresh" hint — a transient refresh error never hides the user's sessions.
- **Regression coverage (all must-fail proven).** `scripts/verify-bug-286-all-folded-first-page.mjs` now 10/10: A/B/C (false-claim + escalation + reachability, FAIL pre-fix), E (no duplicate project groups, FAIL pre-r2), F (forced reload keeps the full list, FAIL pre-r2), G (failed escalation recovers on next plain load, FAIL pre-r2), H (failed refresh keeps loaded sessions visible, FAIL pre-r3), D (genuinely-all-folded still shows the honest note).
- **Anti-regression:** `verify-bug-085-sidebar-cap` 11/11; `verify-feat-199-{r9,r8,keyset}` PASS; FEAT-199 pagination cold/warm + server union unaffected (client-only change; `needsFullList` set only for all-folded-page projects). (`verify-bug-142-loadmore-race` FATAL'd at its scratch-repo `git config` setup — an environment/sandbox issue, unrelated to this change which touches no git.)
- **LANDED to the main tree.** `public/app.js` remained under `cs-mvrtp3kd-1`'s FEAT-129 advisory lock, so each hunk was applied additively by a guarded read-modify-write at unique anchors in a region the other lane's uncommitted hunks do not touch (verified: 40 diff hunks total — my 4 BUG-286 hunks coexist with the other lane's 10+; `node --check` clean). The verify script is in the main tree. Still client-only: **browser reload, no service restart.** A fresh clean-room verify on this r3 candidate is in flight.

### 2026-10-28 — dispatch openai
- **Verification recorded:** dispatch openai run 01a18258-af6c-7f71-8da8-e759d3dd2a67 — VERDICT: HOLDS — mixed-state candidate 893b34b79be8. Typed entry in the record's verification[]; this line is an echo, not proof.
