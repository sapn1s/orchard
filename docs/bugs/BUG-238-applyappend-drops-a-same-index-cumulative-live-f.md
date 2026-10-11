```orchard-ticket
{
  "id": "BUG-238",
  "type": "bug",
  "title": "applyAppend drops a same-index cumulative live-follow append (second block never renders)",
  "summary": "public/app.js applyAppend() dedupes by index > th.lastIndex. If a session-appended batch re-delivers an already-shown message index with MORE blocks (first [Bash], then [Bash, Read]), the batch is dropped and the added block never renders. Truncation-independent; pre-dates all BUG-234 work.",
  "impact_if_we_wait": "IF live-follow transport ever re-emits an existing renderable index with extra blocks, those blocks silently vanish until a full refetch. Real-transport reachability is UNCONFIRMED — the watcher assigns a fresh index per new line. Filed to track the applyAppend fragility.",
  "current_need": "Confirm whether any real transport path (watcher live follow, resync, gap-fill) can deliver a same-index batch with grown blocks; if so, make applyAppend merge/replace rather than drop. If not, decide whether to harden applyAppend defensively or close as not-reachable.",
  "severity": "low",
  "area": "drawer (reading view / live follow)",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A live-follow batch re-delivering a rendered index with ADDITIONAL blocks renders those blocks, or the path is proven unreachable and the ticket closes as such.",
    "Probe: untruncated same-index+uuid cumulative append renders BOTH chips (order.length === 2)."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
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

# BUG-238 — applyAppend drops a same-index cumulative live-follow append (second block never renders)

## Diagnosis

`applyAppend` (public/app.js) dedupes an incoming `session-appended` batch by index:

```
const fresh = msgs.filter((m) => Number.isInteger(m?.index)
  ? (th.lastIndex == null || m.index > th.lastIndex)
  : true);
if (!fresh.length) return;
```

Once a message at index N has been rendered, `th.lastIndex` is N. A later batch that carries index N again — but with MORE blocks than before — fails `m.index > th.lastIndex`, so `fresh` is empty and the batch is dropped. The appended block is never rendered; only a full refetch recovers it. This filter is byte-identical between `git show HEAD:public/app.js` and the working tree, so the behaviour pre-dates every BUG-234 round.

## Evidence

Surfaced by the BUG-234 r6 clean-room probes `independent-run.mjs existing|later` (scratch/cleanroom-verify-3PtQ9g), which re-append the same index/uuid with cumulative blocks and observed one group containing only Bash instead of Bash to Read.

Decision-point-3 pre-existing check (BUG-234 r7): a pristine `git archive HEAD` tree was exported to scratch and an `untrunc` probe mode (BOTH blocks untruncated, no note machinery) was run against HEAD's own app.js:

```
node scripts/independent-run.mjs untrunc
-> readRendered: false
   actual.order = ["\u25b6Bashecho first"]          (Read dropped)
   baseline.order = ["\u25b6Bashecho first","\u25b6Read/second"]
   pass: false
```

So the drop reproduces on HEAD with NO truncation anywhere — it is not a BUG-234 effect. Per the BUG-234 r7 orchestrator decision, break #1 is filed here and left unfixed in BUG-234.

## Open / handoff

UNCONFIRMED whether real transport produces a same-index cumulative batch. The watcher (`src/server/watcher.ts`) seeds `nextIndex` from the renderable count and increments per new whole line, so each new jsonl line gets a fresh sequential index — it is not known to re-emit an existing index with grown blocks. The probe is SYNTHETIC (it calls `applyAppend` directly with a hand-built same-index batch). Next agent: trace whether resync/gap-fill or a watcher rotation can ever deliver index N twice with more blocks the second time; if yes, fix applyAppend to merge; if provably no, close as not-reachable.

**Symptom of a deeper design flaw?** no — a local dedupe-vs-merge gap in one function.

## Activity log (append-only)
