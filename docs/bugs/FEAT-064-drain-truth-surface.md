```orchard-ticket
{
  "id": "FEAT-064",
  "type": "feature",
  "title": "Restart refusal did not say what was holding the session",
  "summary": "After a restart, a session that could not resume was told only to try again in a few seconds. It now says what is holding it, how long it has been held, and that the retry is automatic. A separate hazard that could truncate a turn arriving mid-restart was closed at the same time.",
  "impact_if_we_wait": "The change is built and proven but not live, so people still see the uninformative wait message. Bounded: this is message content and a rare mid-restart truncation, not lost sessions or lost data, and waiting still resolves on its own.",
  "current_need": "Deploy the built change so the informative wait message and the mid-turn guard take effect for real sessions.",
  "severity": "medium",
  "area": "Restart and resume messaging",
  "reported": "2026-08-11",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The resume refusal names what holds the wait, how long it has been held, and the count",
    "The waiting indicator carries the same held reason and elapsed time",
    "A turn arriving mid-restart is not truncated by the shutdown signal",
    "Existing restart, resume and health behaviour stays unchanged"
  ],
  "code_refs": [
    {
      "path": "src/index.ts",
      "symbol": null,
      "note": "resume-refusal payload extended to carry the held reason, elapsed time and count"
    },
    {
      "path": "src/session-host/broker.ts",
      "symbol": "commitDrain",
      "note": "re-checked only background lifetime; now also gated on mid-turn or fresh-result state"
    }
  ],
  "related": [
    {
      "id": "BUG-044",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-062",
      "relation": "see_also"
    },
    {
      "id": "FEAT-065",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-064-drain-truth-surface.md",
    "sha256": "a1fed86ffe96d67168b5829a0e7a1685ff7058504d40b81a90058f9a8becc233",
    "bytes": 6998,
    "original_title": "post-restart drain truth surface: the refusal and the chip say WHAT holds the drain",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the heartbeat fields, the refusal and indicator wording, the mid-turn commit gate, the anti-regression list and the not-deployed state are all present.",
    "dropped": [
      "the internal names of the two heartbeat kinds",
      "the cross-reference to the earlier truncation ticket's section number"
    ]
  }
}
```

# FEAT-064 — Restart refusal did not say what was holding the session

## Diagnosis

The broker already sent decline and status heartbeats during a post-restart wait, but they carried none of the reason. The index layer therefore had nothing to put in the refusal beyond a generic retry hint, and the wait indicator had nothing to show. Separately, `commitDrain()` re-checked only whether background work was still alive. It never looked at whether a turn was in progress, so an injected or late turn could be cut off by the shutdown signal — the same class of truncation as the earlier stdin-EOF hazard.

## Evidence

The dedicated suite ran 18/18. Before the change the same suite failed 7 of 18, including a measured mid-turn stdin-EOF, so the corrected behaviour is proven against a reproduced fault rather than asserted. The anti-regression set stayed green: resume-refusal 13/13, refusal-visible 19/19, restart-with-background-work 15/15, restart-survives 15/15, health-survivor 14/14, with 240/240 across the wider tally and typecheck and the leak gate clean.

## Implementation notes

Scope was held to the first dispatchable increment identified by the earlier exploration at 3f1da4e: no lifecycle change. The heartbeats gained a live-background flag or count, the background task ids they sniffed, and the timestamp the wait started. Those fields flow through the refusal payload and into the wait indicator, producing a message of the form "waiting on drain — held 43s by 1 background agent — retries itself". Health and doctor output may carry the same fields.

## Verification plan

Restart with a survivor holding background work, then assert the refusal payload and the indicator both carry the held reason, elapsed time and count — this must fail before the change, since the old payload contains none of it. Plant a mid-turn commit attempt and assert it declines. Re-run the resume, refusal-visibility, restart-with-background, restart-survival and health-survivor suites plus typecheck.

## Migration and rollback

The change is not deployed. Until it is, sessions keep the old generic wait message and the old commit gate.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed per BUG-048 explore recommendation; delivery ((c+) stdin injection) stays a separate
  future ticket pending the five live probes (recorded in BUG-048).

### 2026-08-11 — FIX + verification (fix agent, in-place on main)
- **THE FIX, exactly the explore's first increment (no lifecycle change):**
  - `src/server/session-host.mjs` — EVERY `writeStatus` (incl. the abandon-net and held-drain
    decline heartbeats) now carries `backgroundLive` (task COUNT from the CLI's own level
    frames), `backgroundTaskIds` (sniffed `task_id`/`taskId`/`id`), `backgroundLifetime`
    (the broker's `yes|unknown|no` answer), and `drainHeldSince` — stamped ONCE at the first
    decline (abandon decline, commit decline, escalation decline), stable across heartbeats.
  - **The latent bug (BUG-022 §3 class), fixed:** `commitDrain()` now also gates on
    `state.midTurn` — a turn in flight when the background level empties DECLINES the commit
    (no stdin-EOF mid-turn) and re-checks on the drain cadence; the turn's `result` clears the
    gate. BOUNDED by `CLAUDE_STATION_HOST_DRAIN_MIDTURN_MS` (default 90s — the same posture as
    gracefulReap's 90s result backstop), so a result-less turn cannot wedge the drain; EOF +
    the existing escalation then bound the CLI as before.
  - `src/server/survival.ts` — `HostStatus` gains the four optional fields (older brokers'
    status files simply lack them; readers null-coalesce).
  - `src/server/index.ts` — the BUG-022/038 resume-refusal now sends a structured
    `drain: { backgroundLive, backgroundTaskIds, backgroundLifetime, drainHeldSince, heldForMs,
    brokerState }` and the message names the holder ("— the drain is held Ns so far by 1
    background agent (id) still working; your message retries itself when they settle");
    `/api/health`'s `brokerOf` (live + surviving-unadopted rows) carries the same fields.
  - `src/server/events.ts` — the `error` wire event gains the optional `drain` payload.
  - `public/app.js` — `queueRetryableRefusal(drain)` stores the payload on the drain-wait row
    (refreshed on every re-refusal so elapsed stays honest); the BUG-045 chip renders
    "waiting on drain — held Ns by N background agent(s) (ids) — retries itself; edit or
    discard below" when the payload names a holder, and keeps BUG-045's exact wording when it
    does not (older server / non-drain retryables — verify-resume-refusal's planted-status
    shape still renders the old text by design).
  - `scripts/verify-feat-064-drain-truth.mjs` (new) + package.json `verify:feat-064-drain-truth`.
- **Verification (§C — scratch ports/dataDirs, kill by pid, :4317 untouched).**
  - **Pre-fix at HEAD: FAILED as required — 7/18.** Load-bearing observations: broker status
    heartbeats had NONE of the fields; refusal payload had no `drain` and the bare message;
    health broker row bare; chip showed only "waiting for the previous turn to finish
    draining"; and the planted mid-turn sequence (turn opens, level empties) MEASURED
    `{ev:'stdin-eof', midTurnOpen:true}` — the BUG-022 §3 truncation, real at HEAD.
  - **Post-fix: 18/18.** S1 heartbeats carry count/ids/drainHeldSince, stamp stable while
    updatedAt advances; S2 the commit DECLINES mid-turn (no EOF), commits only after the
    `result` (`midTurnOpen:false`), reaps cleanly, and the 3s-knob'd bound proves a
    result-less turn cannot wedge the drain; S3 a REAL session-host broker (fake CLI declaring
    the seed session's sdk id + one live bg task) held its drain through a real boot re-adopt:
    refusal payload carried `backgroundLive:1, ids, drainHeldSince, heldForMs`, /api/health's
    surviving-unadopted row carried the same, and the REAL app.js chip rendered
    "waiting on drain — held 2s by 1 background agent (bg-feat064-live) — retries itself".
  - **Anti-regressions: ALL GREEN.** verify:resume-refusal 13/13 (first run 12/13 — the
    known transcript-baseline sampling flake on the phantom-bubble check, clean on rerun);
    verify:refusal-visible 19/19; verify:bug-044-restart-background 15/15 (held/bounded/
    unknown/controls + the full 240/240-beat deploy-shaped restart — the midTurn gate changed
    no drain outcome); verify:restart-survives 15/15; verify:health-survivor 14/14;
    typecheck clean; leak-gate PASS.
- **Operational note: needs a later DEPLOY (service restart) to reach the running service;
  not deployed here.** Until then the live broker heartbeats stay bare and the live chip keeps
  the old wording — the fix is inert on disk.
- **Residuals, named:** (a) the chip's elapsed only refreshes on repaint (each ~7s retry), a
  static readout between retries — accepted; (b) `drainHeldSince` is stamped at the first
  decline, so a refusal that lands BEFORE any decline (broker mid foreground drain) carries
  `heldForMs:null` and the bare message — honest, not a gap; (c) the midTurn bound accepts the
  same bounded-truncation posture as the pre-existing 90s reap backstop for a turn whose
  `result` never lands — the declared contract, not new risk; (d) delivery ((c+) stdin
  injection) remains BUG-048's future ticket, unchanged here.
