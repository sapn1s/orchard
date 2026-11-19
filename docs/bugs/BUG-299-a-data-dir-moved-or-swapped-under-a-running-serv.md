```orchard-ticket
{
  "id": "BUG-299",
  "type": "bug",
  "title": "A data dir moved or swapped under a running server double-sends",
  "summary": "Split from BUG-217 (agent-added scope, not the user's request). The single-writer data-dir lock re-checks the dir's identity only at outbox delivery transitions, so an idle holder never notices its dir was replaced, and a dir moved away and back (ABA) lets the old holder send a queued row a second time.",
  "impact_if_we_wait": "Only reachable by moving, copying or swapping the Orchard data directory while a server runs; ordinary use (reload, switch, restart) is not affected.",
  "current_need": "Decide whether this guarantee is worth building (re-check dir identity on a timer or inode watch, and detect ABA), or rule moved/swapped data dirs out of scope.",
  "severity": "low",
  "area": "server / outbox data-dir lock",
  "reported": "2026-11-19",
  "reported_by": "worker (BUG-217 rescope lane)",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An idle holder whose data dir is replaced at its path stops and exits loudly within a bounded time",
    "A dir moved away and restored (ABA) never lets the old holder send a row twice"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-217",
      "relation": "see_also"
    }
  ],
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

# BUG-299 — A data dir moved or swapped under a running server double-sends

## Origin

Split out of BUG-217 on 2026-11-19. The user's BUG-217 request (session 70531fb4, 2026-09-29) was only "why was my message not sent, clearly it should have been" and "ui/ux as said it is not intuitive". The two-servers / moved-data-dir guarantee entered BUG-217 through the round-6 verifier's requirement text (written by an agent), and rounds 7-10 were spent on it.

## Open breaks (from BUG-217 round 10, anthropic run f6129491-8551-4023-85b6-d0acfb81b82b)

- move-copy-then-move-back (ABA): holder A sends the row again after B served the copy; CLI x2.
- idle-holder-after-replace: the identity re-check runs only inside delivery transitions (lanes.ts isWriter); an idle holder keeps serving and writes registry.json into a dir another server holds.

The current wiring (claimDataDir boot lock, exit 78/75) lives in src/server/index.ts, src/server/lanes.ts, src/server/outbox.ts; legs L1-L4, M1-M7, D1-D4, F1, P6-P8 of scripts/verify-bug-217-queued-message-strand.mjs cover it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-19 — worker (BUG-217 rescope lane)
- **Filed:** through the board tool; the record was validated before it was written.
