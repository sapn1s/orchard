```orchard-ticket
{
  "id": "FEAT-203",
  "type": "feature",
  "title": "Overlap transcript fetch with session-list load on deep-link open",
  "summary": "On deep-link/page-load/phone open, applyRoute awaits the cold session-list load before fetching the transcript, so the two run serially. Starting the tail fetch in parallel (it only needs the URL's id+dir) cuts first paint on the real 54MB session from 1077ms to 641ms.",
  "impact_if_we_wait": "Every fresh page load, shared link, and phone open waits ~100-440ms longer than necessary for the first message, worst on large sessions.",
  "current_need": "Land the proven 3-hunk client patch once public/app.js frees (held by a live lane at filing); consider the secondary server lever (cold full-file count blocks the tail).",
  "severity": "medium",
  "area": "ui/performance",
  "reported": "2026-10-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Measured first-paint on the deep-link path drops vs baseline for small/medium/large sessions, biggest win on large",
    "Same transcript content and order; scroll-up, deep links, finder and load-more unchanged (verify-feat-199 suites green)"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ad44f6b7-f5aa-4223-affe-136823a01b95",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T13:48:28.404Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "7240ac338f456f9eb1b0b989457de9bb9615b15b6e6d7ccaa7be53ff00d37e1e",
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

# FEAT-203 — Overlap transcript fetch with session-list load on deep-link open

Dispatched FEAT-199 finding lane. Measured on a scratch server pointed read-only at the REAL store (~/.claude/projects), orchard project, via headless Playwright.

WHERE THE TIME GOES (ranked):
1. Deep-link/page-load/phone: applyRoute -> resolveRouteSession awaits the cold session-LIST load (~460-650ms) to learn which row the URL names BEFORE openSession fires the transcript fetch. The two are serial though the tail only needs the id+dir the URL already carries.
2. Cold first-ever open of a large session: the tail route runs a FULL-FILE message count (countThenTail) before serving the backward tail. Measured server-side on the real 54MB/7979-msg session: cold count 274ms vs tail 6ms; warm (sidecar/mem cache) count ~0.3ms. One-time per session (sidecar-persisted across restart).
3. Same-project sidebar click is ALREADY fast (openSession in ~6ms, paint ~90ms) thanks to prior FEAT-199 tail-first work; not a remaining problem. Rendering 200 tail messages is ~0 long-task.

FIX BUILT (lever 1, low-risk, client-only): in applyRoute start api.transcriptTail(route.dir, route.sessionId) in parallel with resolveRouteSession and hand it to openSession via its existing opts.prefetchedTail (consume site changed to await a possibly-promised value). Advisory: a failed prefetch resolves null -> openSession falls back to its own fetch; a dir the resolver corrects away from is not consumed. 3 hunks.

MEASURED before -> after (deep-link path, warm sidecar, cold-list reload), first visible message:
- small (46 msgs): 660 -> 553 ms
- medium (230 msgs): 866 -> 580 ms
- large (7979 msgs, 54MB): 1077 -> 641 ms (-436ms, -40%)
Content identical (same rendered message counts). After-paint collapses to the list-load floor because the transcript fetch now overlaps it; cold-transcript win is larger (the 274ms count also overlaps).

VERIFIED on the edited copy (/tmp/f199wt): verify-feat-199 r3-deeplink, r3-client(browser), r7(browser), r8(browser), r9(browser), keyset all PASS; pagination PASS on re-run (first run flaked on a live-store concurrent append 2924 vs 2923, not this change); verify-sessions 52/52 (real store byte-identical); npm run gate PASS exit 0 (leak+typecheck).

PATCH: clean 3-hunk patch at ~/.local/state/claude-station/scratch/feat199-prefetch-clean.patch (apply to public/app.js once its FEAT-129 lock frees; the raw working-tree diff is polluted by BUG-286 edits made after the copy was taken). NOT landed: public/app.js was locked by a live lane (pid 870451) throughout; change proven in an isolated hardlinked copy, left for the orchestrator to land.

SECONDARY LEVER (NOT built, needs a decision + skeptic): defer the cold full-file count so the tail is served immediately (saves 274ms on first open of a 54MB session). Changes the total/index-labelling contract (would return a lower-bound total + unnumbered indices on first open, as the >512MB path already does) -> high-stakes session-lifecycle, warrants its own round and independent clean-room verify.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run ad44f6b7-f5aa-4223-affe-136823a01b95 — VERDICT: HOLDS — mixed-state candidate 7240ac338f45. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane (round 1)
- **Landed** the proven 3-hunk patch on the REAL working-tree `public/app.js` (2 edit sites: openSession's prefetched-tail consume `(await opts.prefetchedTail) ?? …`; applyRoute's parallel `tailPrefetch` started before `await resolveRouteSession`, handed to openSession only when the resolved row's (dir,id) matches the prefetch). The file was held by live co-lanes (FEAT-129 lock, owners aa2bd3ad… then ad530166…) for ~2.5h; waited (never bypassed) for a sustained release, then re-anchored by content (co-lane had shifted lines; anchors byte-identical) and applied with minimal Edits. Left UNSTAGED.
- **Timing (my re-measure, interleaved A/B, real store read-only, headless brave, 9 iters/session, medians):** deep-link first-visible-message — small (46 msgs) 1127→838ms (-289), medium (230 msgs) 1130→854ms (-276), huge (7979/54MB) 1240→990ms (-250). Absolute ms higher than the finding lane's (machine under heavy concurrent lane load); the DELTA is the signal and reproduces the win across all sizes. Content/order identical.
- **Suites (against the patched working-tree copy):** verify-feat-199 r3-deeplink PASS, r3-client PASS, r7 PASS, r8 PASS, r9 PASS, keyset PASS. verify-sessions 51/52 — the 1 FAIL is a live-store concurrent-append flake (another session wrote `-cleanroom-verify-`/`trading-volume` jsonl mid-run; this check asserts the real store is byte-identical start→end and does not load app.js). BUG-278 suite 65/70 patched; the 5 fails are all the `live` driving-turn harness precondition + its dependent recovery legs (M-git, Q) — the UNPATCHED base copy fails the SAME class (59/66, legs I/M), confirming a pre-existing load-induced harness flake, not this change (which does not touch recovery). `node --check` OK.
- **`npm run gate`:** PASS, exit 0 (leak-gate + typecheck), read directly, unpiped.
- **Independent verify (working tree):** `independent-verify.mjs --ticket FEAT-203 --files public/app.js` → mixed-state candidate 7240ac338f45 (base 61af1564 → tree 492157aa, my hunk + 7 other-ticket hunks disclosed). OpenAI quota spent (resets 6:38PM) → fell back to anthropic same clean room (NOTE: author anthropic too → cross-provider decorrelation reduced this round). VERDICT HOLDS (VALID, manifest-backed). Verifier's own adversarial suite adv-feat203 PASS: must-FAIL old shape (tail only after list, 1659ms vs list 1647ms) vs new overlap (tail 753ms vs list 2275ms); exactly one tail fetch (prefetch consumed, no double); content+order identical (16 rows); stale-dir correction → prefetch NOT consumed, own fetch with corrected dir; aborted/500 prefetch → fallback, no unhandled rejection; superseded deep-link never paints A over B; recovery tail object consumed unchanged + atomicReopen still swaps in. r3-client exit 0.
- **Benign behavior note (not a defect):** `opts.prefetchedTail` is now a Promise (always truthy), so openSession's `painted && opts.prefetchedTail` soft-error branch (BUG-278 r3) can now fire on the deep-link path. It only fires when `painted===true` (content already shown) and the `scope !== state.txScope` guard above it runs first — so it correctly KEEPS a painted transcript instead of blanking it on a later enrichment failure. The verifier flagged this as UNTESTED; analysis shows it is correct, arguably an improvement over the prior blank-on-late-failure.
- **Artifacts:** measurement scripts `/tmp/feat203-base/_measure_ab.mjs`; requirement `/tmp/feat203-req.txt`; verdict `/tmp/feat203-verdict.json`; iv log `/tmp/feat203-iv.out`.
