```orchard-ticket
{
  "id": "BUG-074",
  "type": "bug",
  "title": "Finished background work trapped queued messages",
  "summary": "The fix prevents completed background work from holding queued messages across turn boundaries. A stale active-turn marker caused the delay; the background count self-corrected independently. Failure-then-pass runs covered message delivery and drain release, but the change still awaited a later deployment.",
  "impact_if_we_wait": "Queued messages can remain blocked for tens of minutes, and the broker cannot finish winding down. Bounded: this affects delivery latency and process cleanup, not message retention or user data.",
  "current_need": "Keep the ticket closed: the pre-fix cases failed, corrected behavior passed, and the delivery suite and standing checks stayed clean.",
  "severity": "high",
  "area": "Background message delivery",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Completed background work stops counting as active without another foreground turn",
    "Queued messages deliver within one retry tick after a foreground-idle boundary",
    "The drain commits and reaps after the final lane ends"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-002",
      "relation": "see_also"
    },
    {
      "id": "BUG-072",
      "relation": "see_also"
    },
    {
      "id": "BUG-083",
      "relation": "see_also"
    },
    {
      "id": "FEAT-065",
      "relation": "see_also"
    },
    {
      "id": "FEAT-067",
      "relation": "see_also"
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-074-stale-background-level-holds-drain.md",
    "sha256": "dd30d20e22b93962447d548029b6aa2d169f1ad9eba1509f8baa81212acc834a",
    "bytes": 10979,
    "original_title": "drain held by a GHOST: finished background agent still counted, queued messages stuck 26min through turn boundaries",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived BUG-074 text; the symptom, confirmed cause, refuted suspect, deployment gap, bounds, and executed evidence remain.",
    "dropped": []
  }
}
```

# BUG-074 — Finished background work trapped queued messages

## Diagnosis

The background count was not the lasting fault: the CLI eventually removed completed agents and ARCH-002 bounded the carry-over behavior. The confirmed fault was a stale `midTurn` marker. At foreground-idle boundaries it remained true, preventing the delivery gate from releasing queued drain-wait messages.

## Evidence

The reported holder had completed and was committed as `32e41fb` more than 30 minutes before delivery, while `backgroundLive:1` still appeared. Holds persisted across agent-free gaps and a restart. Messages waited 26m09s and 8m54s. The pre-fix clean-room run at HEAD passed 6/11, with all five suspect cases failing. After the fix, `verify:bug-074-ghost-drain` passed 11/11 and `verify:feat-065-delivery` passed 35/35. Recorded anti-regression tallies were 18/18, 15/15, 5/5, 47/47, 96/96, and 240/240. Typecheck and leak-gate were clean.

## Implementation notes

Refresh the foreground-turn marker at turn boundaries so the delivery gate observes the session as idle. Preserve the CLI's self-healing removal behavior and the ARCH-002 bound on carried background tasks.

## Verification plan

Run a background task through completion without starting another foreground turn. Confirm the background count reaches zero, a queued drain-wait message delivers within one retry tick, and the drain commits after the final lane ends. Repeat the named delivery and anti-regression suites.

## Migration and rollback

The fix required a later deployment and was not deployed when the ticket closed. Deploy through the normal release path. Roll back the boundary-marker change if delivery or liveness regressions appear.

## Risks

Incorrect boundary freshness could release a queued message while foreground work is still active. Hidden or stale browser tabs may expose timing paths not represented by the server-side correction.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's queued-26-minutes report. ARCH-002 note: the level is DECLARED evidence
  and the holds are designed to trust it — which is exactly why its staleness must be impossible
  or bounded; a ghost in the level inherits all the authority the design gives real work.

### 2026-08-12 — FIX + verification (worker, in-place on main)

**REAL-CLI PROBES FIRST (claude 2.1.227, headless subscription auth; scratch, no :4317).** Two
throwaway stream-json harnesses mirroring `session-host.mjs`'s sniffer drove a real CLI through a
background bash and a background Task subagent while the foreground was idle. The captured frame
sequences (in the task log) decided both suspects:

**SUSPECT 1 (stale level) — REFUTED.** The real CLI DOES emit a `background_tasks_changed` empty
frame when background work completes while foreground-idle (bash: at +15706ms `tasks:0`; subagent:
`tasks:0` at +31368ms), each followed by a spontaneous surfacing turn. The broker always drains
stdout, and BUG-072's carrying logic rebuilds `backgroundTasks` from every frame — an empty frame
DOES remove. So the level self-heals in seconds; there is no shape where the empty frame never
arrives. The 30-min "ghost" is best explained as GENUINE near-continuous work: the subagent probe
reproduced the incident's "each successive holder id replaced the last" verbatim (`tasks:0` then
`tasks:1` 3ms apart at +29542/+29545) — the level was ~correct, ~always 1 live. Critically, a stale
`yes` does NOT block delivery anyway (the gate already delivers on `yes`), so suspect 1 was never the
user harm.

**SUSPECT 2 (boundary delivery) — CONFIRMED; THIS is the 26-minute defect.** After the foreground
turn's `result` (which sets `midTurn:false`), the background SUBAGENT streams its inner frames on the
SAME stdout, every one carrying a top-level `parent_tool_use_id` (foreground frames carry
`parent_tool_use_id:null`). Pre-fix `onStreamJsonLine`'s `else { state.midTurn = true }` took each as
foreground-turn activity — probe measured 23 such frames pinning `midTurn:true` after the foreground
result — and there is no foreground `result` to clear it. So for a background agent's entire
multi-minute life the FEAT-065 gate's `midTurn===false` stayed shut → every 7s client retry refused →
the user's message waited the whole agent. (Background BASH lanes, by contrast, emit no inner frames,
so `midTurn` stayed false and BUG-072's sessions delivered fine — the two incidents reconcile.) The
`background_tasks_changed`/`task_*` lifecycle frames hit the same `else` and compounded it.

**THE FIX (server-side only; no client change; no new process/signal/lifecycle branch):**
- `src/server/session-host.mjs` — `onStreamJsonLine` now classifies each frame: a background-lane
  frame is one carrying a top-level `parent_tool_use_id` OR a background lifecycle system subtype
  (`background_tasks_changed`, `task_started`, `task_updated`, `task_notification`, `task_progress`,
  the new `BACKGROUND_LIFECYCLE_SUBTYPES` set). Such frames are kept OUT of `midTurn` tracking
  entirely — `midTurn` now reflects only the FOREGROUND turn, so it stays false while a background
  agent works and the delivery gate fires at the next boundary tick. (`result`/`init`/genuine
  foreground frames drive `midTurn` exactly as before — a real open foreground turn still pins it,
  BUG-022 reap guard intact.)
- `src/server/session-host.mjs` — SUSPECT 1 bounded-trust (ARCH-002, belt-and-suspenders):
  `lastBackgroundActivityAt` is refreshed by every corroborating frame (non-empty level, task
  lifecycle, or subagent inner frame — all a live agent emits continuously). `backgroundOutlivesTurn()`
  downgrades a `yes` whose level has gone uncorroborated for `BG_STALE_MS` (env
  `CLAUDE_STATION_HOST_BG_STALE_MS`, default 300000) to `unknown`. The downgrade NEVER forces an EOF
  (`unknown` still HOLDS the drain), so genuinely-live-but-quiet work is never truncated — the HARD
  BUG-044 line holds. The window is generous by design so a live agent (which emits frames well
  within it) never trips it.
- `src/server/index.ts:~2788` — delivery gate reconciled with the downgrade: `lifetimeDeliverable =
  backgroundLifetime==='yes' || (backgroundLifetime==='unknown' && backgroundLive>0)`. The
  `unknown+backgroundLive>0` case is uniquely the staleness downgrade (the dispatch-observed
  `unknown` has `backgroundLive===0` — a commit imminent, so it KEEPS FEAT-065's queue-and-wait).
  Without this the staleness relabel would have STOPPED delivery for a stale-but-live session — the
  two changes are net-safe together (stale `yes`→`unknown` but still delivers).

**FIX MAP:** `src/server/session-host.mjs` — `BACKGROUND_LIFECYCLE_SUBTYPES` set + `lastBackgroundActivityAt`
state; `onStreamJsonLine` classification (`isSubagentFrame`/`isBackgroundLifecycle`/`isBackgroundLaneFrame`)
and the guarded midTurn chain; `backgroundOutlivesTurn()` staleness branch + `BG_STALE_MS`.
`src/server/index.ts` — `bgCount`/`lifetimeDeliverable` in the `deliverable` gate.

**VERIFICATION (§C — scratch ports/dataDirs, real seed haiku session + a REAL session-host broker
whose fake stream-json CLI replays the probe-captured ordering and appends to the REAL transcript;
kill by pid; :4317 untouched):**
- `scripts/verify-bug-074-ghost-drain.mjs` (new) + `verify:bug-074-ghost-drain`. **POST-FIX 11/11.**
  S1 the sub-agent stream leaves `midTurn:false` and the send is ACKED `deliveredVia:survivor` in
  149ms, exactly one engine user frame, no second `claude`, turn-done. S2 the uncorroborated level is
  downgraded to `unknown` while `backgroundLive:1` AND the CLI stays alive (no EOF — BUG-044) AND a
  send still delivers AND the empty frame later commits+reaps cleanly. S3 a genuine open foreground
  turn STILL pins `midTurn:true` and keeps queue-and-wait.
- **PRE-FIX must-FAIL, clean-room `git worktree` at HEAD (32e41fb) with the new script copied in:
  6/11** — the 5 suspect checks failed exactly (S1a midTurn pinned true, S1b delivery refused, S1c×2
  by consequence, S2a lifetime stayed a confident `yes`); the anti-regression S3 and the self-heal
  S2b/c/d passed in BOTH (they are not the must-FAILs).
- **Anti-regressions ALL GREEN:** verify:feat-065-delivery **35/35** (script UNMODIFIED),
  feat-064-drain-truth **18/18**, bug-044-restart-background **15/15** (incl. the load-bearing
  "240/240 beats + DONE through restart" and "no leak" — a genuinely-live background agent is still
  never EOF'd), bug-068-bash-background **5/5**, bug-072-delivery-visible **47/47**, restart-survives
  **15/15**, liveness-conformance **96/96**; typecheck clean; leak-gate PASS (320 files).

**Operational note: needs a later DEPLOY (service restart) to reach :4317 — NOT deployed. NOT
restarted.** The midTurn fix takes effect for any broker started after the deploy; the running
survivor keeps mis-pinning until then.
