```orchard-ticket
{
  "id": "FEAT-204",
  "type": "feature",
  "title": "Server-owned persistent session index for instant lists",
  "summary": "Session lists and /api/projects should be pure reads of a per-project index of id, title, lastActivityAt, mtime and size, maintained incrementally from stat diffs and built with the canonicalSessionIndex rules. Plan and a Claude skeptic review are in FEAT-199 r12; three blocking gaps remain: atomic writes, live validation of by-id reads, and request-path cost independent of file count.",
  "impact_if_we_wait": "List loads keep scaling with the number of session files and stall under machine load.",
  "current_need": "resolve the three blocking gaps, get a real OpenAI plan review, then build with an independent verify.",
  "severity": "medium",
  "area": "ui/performance",
  "reported": "2026-11-05",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-11-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session list page and /api/projects respond in under 50 ms warm, independent of session-file count",
    "Order and contents equal the canonical full list"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "0a29a3f4-d129-4d98-9564-c8ba94f3728b",
      "verdict": "holds",
      "verdict_on": "2026-11-05",
      "recorded_at": "2026-11-05T10:54:28.602Z",
      "author": "worker (FEAT-204 fixing lane; author-provider openai)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "2beb618da4629c857a4027bcadb537b6cf77be3872cb7cd2fe142e7170af8f01",
      "verify_mode": "mixed-state",
      "note": "Step-1 head-facts memo. IV ran own 12/12 adversarial suite (real 4076-file cold==warm, cross-dir twins, rename-over same size+mtime, chmod-000 open-fail, emptied+recreated dir, 200 rapid rewrites). Two prior BROKEN rounds fixed."
    }
  ],
  "verification_class": "plan+review",
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

# FEAT-204 — Server-owned persistent session index for instant lists

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-11-05 — board tool
- **Note:** Step 1 (quick structural win) landed in the working tree: memoised readSessionHeadFacts — the per-file head open+parse canonicalSessionIndex does for EVERY file on EVERY list request. New readSessionHeadFactsCached() in src/lib/session-history.ts keyed by (path, mtimeNs, size, ino) via a bigint stat; canonicalSessionIndex now calls it and prunes cache entries for files that vanished from the dirs it scanned (bounded by the live file set). Uncached readSessionHeadFacts stays the source of truth; cache only skips redundant re-reads. In-memory only — NO sidecar persisted this step (the ticket's optional cold-start sidecar is deferred to a later index step). MEASURED, real store, busiest project (trading-volume, 4071 files), read-only scratch: canonicalSessionIndex warm 2.8-3.4s -> ~48-57ms; cold ~3.5s unchanged (first build still reads every file); stat-only pass 16-19ms. Byte-identical canonical results cold-vs-warm on a FROZEN snapshot (4071 entries, 3 passes identical) and per-file cached-vs-uncached across the live store (9563 files, 0 mismatches; per-dir over 1784 dirs, 0 mismatches). Invalidation 15/15 (append, head rewrite incl. same-size, rename, delete+twin ino-change, delete). Regressions: all 16 verify-feat-199-* suites exit 0; verify:sessions 51/52 (the 1 fail is the test's own live-store manifest snapshot racing active appends — differing file grew 532307->703954 bytes between two runs — not this change, which writes nothing); npm run gate PASS. How it fits FEAT-204: this is the request-path cost reduction (gap 3, request-path cost independent of file count) for the CURRENT canonicalSessionIndex path; the full persistent per-project index (atomic writes, by-id live validation) still builds on top. Fit note: the cache makes warm lists cheap but cold start after restart is still O(files); the persistent sidecar/index step addresses cold.

### 2026-11-05 — worker (FEAT-204 fixing lane; author-provider openai)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 0a29a3f4-d129-4d98-9564-c8ba94f3728b — VERDICT: HOLDS — mixed-state candidate 2beb618da462 — Step-1 head-facts memo. IV ran own 12/12 adversarial suite (real 4076-file cold==warm, cross-dir twins, rename-over same size+mtime, chmod-000 open-fail, emptied+recreated dir, 200 rapid rewrites). Two prior BROKEN rounds fixed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-05 — board tool
- **Note:** Independent verify (cross-provider: author-provider openai, verifier anthropic via dispatch.mjs, --timeout-min 30, mixed-state freeze) took TWO BROKEN rounds before HOLDS, each a real robustness gap the first fix missed: (1) run 180052d9 BROKEN — an in-place same-size rewrite that a restore tool (cp -p / rsync -t / tar over an existing file) performs keeps mtime+size+ino identical and served stale facts; fixed by adding ctimeNs to the stat signature (ctime always advances on a write and cannot be set backwards). Same run also flagged the cache handing back its own stored facts object (a caller mutating it would poison the entry); fixed by returning a fresh copy. (2) run dd04fb58 BROKEN — a transient open/read failure (EMFILE under fd pressure) made readSessionHeadFacts return {null,null}, which was memoised under a VALID stat signature and replayed on every later call until the stat changed, with canonicalSessionIndex then keying the session by its stem instead of its in-file id; fixed by splitting out readSessionHeadFactsChecked (reports ok=false only on a swallowed open/read error, distinct from a legitimately empty/headless file) so readSessionHeadFactsCached caches ONLY a successful read and a failure is retried next call. Final HOLDS: run 0a29a3f4 (recorded in verification[]), candidate 2beb618da462; the verifier's own 12/12 adversarial suite covered all of the above plus real 4076-file cold==warm full-entry equality. Both adversarial cases added to scripts/verify-feat-204-headfacts-cache.mjs (now 26/26). Known benign limitation (reasoned, not a correctness bug): the vanished-file prune only runs for dirs that still have >=1 live file, so a dir that empties entirely leaves its stale entries in memory until clearSessionCache; never served; the persistent-index step owns full lifecycle.
