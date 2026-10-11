```orchard-ticket
{
  "id": "BUG-248",
  "type": "bug",
  "title": "Session list rescans a whole untagged transcript for its pin tag",
  "summary": "Found by BUG-245 r3 measurement. readTitleMeta resolves the pin tag by a full backward scan whenever size or mtime moved; an untagged session has no tag line, so it reads the whole file: 875 ms on the real 286 MiB session, 630-650 ms of the sessions list on each live reopen, which first paint awaits.",
  "impact_if_we_wait": "A live session over ~100 MiB still waits most of a second before its first message paints. Nothing is lost; it only gets slower as the session grows.",
  "current_need": "Make the pin-tag lookup O(appended) for an appended file, like the BUG-245 r3 resumable fold: last tag wins, so a grow scans only new bytes; full rescan otherwise.",
  "severity": "medium",
  "area": "server session list / session-mutations readTitleMeta",
  "reported": "2026-10-09",
  "reported_by": "worker (BUG-245 fixing r3)",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-09",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A live reopen of the 286 MiB session does no whole-file scan in the sessions list.",
    "Pin state equals a fresh full scan after any append, tag, untag, compaction, truncation or replace."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-245",
      "relation": "see_also"
    },
    {
      "id": "FEAT-168",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "02ee6fc4-94f2-4e37-bbb9-b1a506ff2278",
      "verdict": "broken",
      "verdict_on": "2026-10-09",
      "recorded_at": "2026-10-09T18:31:52.172Z",
      "author": "fixing r4",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean room (anthropic; OpenAI quota). Tag fold 15/15; 62MiB live 1.7ms vs full 342ms. Breaks: (1) adv 33e5e2abbb45 foldTagRegion prefilter skips a non-compact/escaped tag record the full scan accepts (SDK writes compact, latent); (2) interior same-size rewrite = accepted residual."
    },
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "66a3df09-1093-4fc8-ab73-6590df47e57f",
      "verdict": "holds",
      "verdict_on": "2026-10-09",
      "recorded_at": "2026-10-09T18:52:02.480Z",
      "author": "fixing r5",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean room (anthropic/opus; OpenAI quota-window; cross-provider attempted first). r5 removed foldTagRegion prefilter; delta now uses the SAME per-line parse+predicate as the full scan. HOLDS: verifier tag fuzz 1338 + count fuzz 801, 0 mismatch; r4-vs-r5 +0.13ms median. M4 residual out of contract."
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

# BUG-248 — Session list rescans a whole untagged transcript for its pin tag

Measured with the BUG-245 r3 Playwright harness (/tmp/b245r3/ttfp.mjs, isolated scratch server, real transcripts copied to a scratch store); per-request timings in /tmp/b245r3/ttfp-after-r3-dbg.json. src/server/session-mutations.ts carries another lane's uncommitted edits, which is why BUG-245 r3 did not change it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-09 — worker (BUG-245 fixing r3)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-09 — fixing r4
- **Verification recorded:** dispatch anthropic/opus run 02ee6fc4-94f2-4e37-bbb9-b1a506ff2278 — VERDICT: BROKEN — Clean room (anthropic; OpenAI quota). Tag fold 15/15; 62MiB live 1.7ms vs full 342ms. Breaks: (1) adv 33e5e2abbb45 foldTagRegion prefilter skips a non-compact/escaped tag record the full scan accepts (SDK writes compact, latent); (2) interior same-size rewrite = accepted residual.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-09 — fixing r4
- **BUILD+VERIFY — pin tag made a resumable fold; clean room BROKEN on a prefilter gap + the accepted interior residual:** HYPOTHESIS VERIFIED FIRST. BUG-248 is real and as claimed: session-mutations.readTitleMeta resolves the pin via scanTagBackward, which parses EVERY complete line from EOF; for an untagged session (no tag record) that reads to byte 0, and the cache (dev+ino+size+mtime+ctime, no cross-change reuse) misses on every live append, so a growing session re-pays the whole-file scan each reopen. The charter's "bounded region" alternative is REFUTED by FEAT-168 r1/r2 (a tag can live in the unsummarised middle; the SDK's 64 KiB-tail reader has exactly that bug). The "same resumable owner as the count" option does not fit: the session-list route never calls countMessages. So the fix is the resumable-fold form.

  BUILD (unstaged) src/server/session-mutations.ts. The tag is now a RESUMABLE FOLD mirroring the BUG-245 r3 count contract. New TagCheckpoint {size0, lastNlPos, tag, head/boundary sha256} on the CacheEntry. On a changed file: if same dev+ino, size grew, and head+boundary windows still hash equal (tagCheckpointHolds), foldTagRegion scans only [lastNlPos, size) forward and "last tag record wins" — (last tag in the appended bytes) ?? prior.tag; else a full scanTagBackward (shrink / same-size rewrite via ctime / compaction head-rewrite / replace new-inode). An uncommitted (no-newline) trailing tag line never takes effect until its newline lands. Titles stay head+tail sampled (already bounded); only the tag resolution became incremental.

  TESTS scripts/verify-bug-248-tag-fold.mjs (new, 15 cases): C1 pin buried in the MIDDLE is found (why a bounded read is wrong); C2 append stays untagged; C3/C4/C5 pin/untag/re-pin via delta (last record wins); C6 uncommitted tag not yet live until newline; C7 compaction head-rewrite→full rescan; C8 truncate→full rescan; C9 replace new-inode→full rescan; C10 same-size in-place rewrite (mtime restored, only ctime moves)→full rescan; D0/D1 60+ MiB untagged — a warm live reopen deltas (1.7 ms) vs a full scan (342 ms); R1/R2 REAL 53 MiB transcript + REAL cut at 4 growing offsets + a shrink — tag == a fresh full scan each time. All 15 PASS on the real module. MUST-FAIL (synthetic): a pinned pre-fix sibling (no fold) reddens D1 (warm 347 ms ≈ full 356 ms — no speedup) while the correctness cases stay green (the fold is a perf fix, correctness-neutral). npm run gate PASS.

  TTFP (Playwright, isolated scratch server; real 286 MiB). This is the user-facing win: the ~650 ms /api/projects/:id/sessions pin scan on a live reopen is GONE. 286 MiB live-reopen-after-append 906-919 ms → 257-267 ms; restart-cold-after-append 914 → 260 ms (the shell-warm cold scan builds the checkpoint, the post-append reopen deltas). Pin state unchanged. (/tmp/b245r3/ttfp-r4-before.json vs ttfp-r4-after.json.)

  VERIFY (independent clean room, scripts/independent-verify.mjs --working-tree; OpenAI quota-window → provider anthropic, SAME-provider; run 02ee6fc4-94f2-4e37-bbb9-b1a506ff2278; VERDICT-CONTRACT VALID, verdict BROKEN). Fold correctness 15/15 and the perf property held. TWO breaks: (1) adv tag-fold-noncompact-mid-rewrite, manifest 33e5e2abbb45 — foldTagRegion's prefilter `line.indexOf('"type":"tag"')` skips an appended tag record that is NON-COMPACT ({"type": "tag", …}, a space) or has an escaped type, so the DELTA reads unpinned while the full scanTagBackward (no prefilter) reads pinned: delta != full. (2) same-length INTERIOR mid-rewrite of a pin record + grow preserving the head+boundary windows — the accepted out-of-contract interior residual (r2/01a121a2), now vs the tag fold.

  ADJUDICATION (reported, NOT acted on — round non-renewable). Finding (1) is the one genuinely NEW, in-contract-adjacent gap: my delta prefilter is stricter than the module's own full scan, so the two paths disagree on a record the full scan honours. LATENT in production — the writer (SDK tagSession) does JSON.stringify → compact `"type":"tag"`, and the room marks "whether the real CLI writes non-compact/escaped tag JSON" UNTESTED — but it is a real self-inconsistency. Cheap fix (drop the substring prefilter and parse every appended line, matching the full scan; delta stays O(appended) because the appended region is small). Finding (2) is the accepted interior-rewrite residual (no real writer rewrites a transcript interior in place at same length). Did NOT patch either, per the one-round charter. For technical adjudication: Finding (1) warrants a follow-up (relax the prefilter) given it is a fixer-introduced path divergence, not the pre-existing residual.

### 2026-10-09 — fixing r5
- **Verification recorded:** dispatch anthropic/opus run 66a3df09-1093-4fc8-ab73-6590df47e57f — VERDICT: HOLDS — Clean room (anthropic/opus; OpenAI quota-window; cross-provider attempted first). r5 removed foldTagRegion prefilter; delta now uses the SAME per-line parse+predicate as the full scan. HOLDS: verifier tag fuzz 1338 + count fuzz 801, 0 mismatch; r4-vs-r5 +0.13ms median. M4 residual out of contract.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-09 — fixing r5 (fix + verify)
- **FIX — removed the foldTagRegion prefilter so the delta path parses EXACTLY like the full scan; clean room HOLDS:** ORCHESTRATOR ADJUDICATION of run 02ee6fc4 (recorded verbatim-in-substance): (a) the interior same-length rewrite residual, as it now shows up against the F2 count re-check and the tag fold, falls under the SAME supported contract BUG-245 r2 already rescoped with producer evidence (append-only, or head/size/inode changes; no real writer does interior same-length rewrites) — accepted as out of contract, no code change, documented with an M4-style test. (b) BUG-248's `"type":"tag"` substring prefilter in foldTagRegion made the delta path stricter than the module's own full scan — a real in-contract divergence the fixer introduced; fix so the delta uses EXACTLY the same per-line parse and predicate as the full scan, factored into one shared per-line function both paths call.

  HYPOTHESIS VERIFIED FIRST (measured, not asserted): removing the prefilter costs nothing on the real live-reopen path because the fold only ever runs over APPENDED bytes. Real 53 MiB transcript (87564f3e), delta reopen median 1.13 ms (prefilter) vs 1.02 ms (no prefilter) — within noise. A pathological single-delta burst scales ~5 ms/MiB of appended region (1 MiB → 8 ms), still vastly under the 342–875 ms whole-file scan BUG-248 removed. The independent verifier reproduced this side-by-side on the real transcript (60 turns avg 161 KiB): r4 1.03 ms vs r5 1.15 ms median, +0.13 ms (~13%, bar <2 ms) — immaterial.

  BUILD (unstaged) src/server/session-mutations.ts: new `tagOfLine(line) = parseRecord(line) then tagOfRecord(rec)` — THE one per-line tag classifier with NO text-shape prefilter. foldTagRegion now calls tagOfLine for every appended complete line (prefilter `line.indexOf('"type":"tag"')` deleted); scanTagBackward's pick is still `tagOfRecord(rec)` on scanBackward's parsed line. Both tag paths now apply the identical parse (parseRecord) and predicate (tagOfRecord), so a non-compact (`{"type": "tag", …}`) or escaped-type (`"type":"tag"`) tag record the full scan accepts can no longer be skipped by the delta. The generic scanBackward / promptMatchOf (FEAT-168 closed watermark) were NOT touched — kept the blast radius to the tag paths (the shared file carries other lanes' edits).

  TESTS scripts/verify-bug-248-tag-fold.mjs 15→20: N0 proves the r4 prefilter skips a non-compact + an escaped record a full parse accepts (the gap); N1/N2 a non-compact / escaped pin appended in the delta region folds to pinned == fresh; N3 a non-compact clearing tag folds == fresh; P a property test — 80 random append/tag/untag/partial-no-newline/truncate steps on a COPY of the REAL transcript, fold tag == a fresh full scan at every step; M4 (adjudication a) documents the accepted interior same-length rewrite residual as INFORMATIONAL (delta pinned, fresh null, divergent — out of contract, not graded). 20/20 on the real module. MUST-FAIL (synthetic r4, not HEAD-anchored): a mutant with the prefilter re-added reddens EXACTLY N1/N2/N3/P while compact C3/C5 stay green — non-vacuous and gap-specific. Anti-regression: FEAT-168 close-session 187/187 (no regression from touching the shared file). npm run gate: leak-gate PASS, check-nul PASS, typecheck PASS; the ONE gate FAIL is prompt-privacy on another lane's docs/prompts/ROUTING.md edit (pre-existing, not mine).

  VERIFY (independent clean room, scripts/independent-verify.mjs --working-tree, author anthropic). Cross-provider attempted FIRST (OpenAI) — dispatch 01a121fe failed [quota-window]; fell back to Claude Opus per standing rule (don't wait for reset), SAME-provider. Run 66a3df09-1093-4fc8-ab73-6590df47e57f, VERDICT-CONTRACT VALID, verdict HOLDS. Fixer suites re-ran green in the room. The verifier built its OWN fuzzers: tag-fold differential 1338 reopen-vs-cold over byte-split appends (CRLF, BOM, duplicate `type` keys, decoys, whitespace-padded, U+2028, blank/broken JSON, non-string tag, 1 MiB tag lines straddling the chunk boundary, random truncations) — 0 mismatch; count-fold differential 801 warm-vs-cold — 0 mismatch; the prefilter-cost measurement above. UNTESTED by the room: inode reuse with identical head+boundary (btrfs scratch does not reuse soon; ext4 can); truncate+byte-identical regrow without a reopen (same O(1)-window-vs-O(n)-prefix class as the accepted M4 residual, out of contract); concurrent short-read at the fd level; multi-MB single-turn append timing. No in-contract break. Done.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
