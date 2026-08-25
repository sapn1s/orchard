# BUG-074 — drain held by a GHOST: finished background agent still counted, queued messages stuck 26min through turn boundaries

- **Status:** VERIFIED 2026-08-12 — SUSPECT 2 (midTurn pin) CONFIRMED and fixed; SUSPECT 1 (stale
  level) REFUTED (the CLI self-heals) but bounded per ARCH-002 anyway. New verify:bug-074-ghost-drain
  11/11 post-fix; pre-fix clean-room at HEAD 6/11 (the 5 suspect must-FAILs failed). Anti-regressions
  green (feat-065-delivery 35/35, feat-064 18/18, others below). **Needs a later DEPLOY — not deployed.**
- **Area:** broker background-level staleness (session-host sniffing) + drain-wait delivery latency at boundaries
- **Reported:** 2026-08-12 by user, with the chip text as evidence:
  > "1 queued message · waiting on drain — held 635m24s by 1 background agent (a3b01c6ed0ac822d4)
  > — retries itself" … "and again, why is subagent blocking main" … "u will see how long the msg
  > was queued for thats whole time it was stuck" (26m09s and 8m54s queue times)

## Evidence
- The named holder (a3b01c6ed0ac822d4) is the BUG-072 fix agent — it COMPLETED and its work was
  committed (32e41fb) 30+ minutes before the queued message finally delivered. Yet the broker's
  level still counted it: `backgroundLive:1`, lifetime 'yes', drain held.
- `drainHeldSince` ≈ 2026-08-11T20:28 (the 635m figure) — the hold has been continuous since
  yesterday's deploy across MANY completed agents; each successive holder id replaced the last,
  the hold itself never released even in agent-free gaps (orchestrator confirmed zero dispatch
  processes/agents in one such gap while the chip still said "1 background agent").
- User messages queued 26m09s and 8m54s, spanning multiple orchestrator turn boundaries. At each
  boundary (midTurn false + lifetime 'yes' + draining) the FEAT-065 delivery gate SHOULD have
  delivered within one retry tick (~7s). It did not — messages delivered only much later
  (plausibly only when the main turn began by other means, or after the deploy restart).
- Deploy restart (pid 713172) happened inside the window — investigator must separate pre/post
  restart behavior.

## Two suspects (investigator must confirm/refute with evidence)
1. **Stale level:** the CLI's `background_tasks_changed` empty/removal frame either never fires
   for completed Task agents in this shape, fires only at the next turn (so an idle gap keeps the
   stale claim), or fires but the broker's sniffer misses it (e.g. only sniffing during certain
   states, or the survivor's frames flowing when no client is attached). Determine which. Note
   the broker carries tasks "across level frames" since BUG-072's change — check that carrying
   logic can ever REMOVE.
2. **Boundary delivery not firing:** even with lifetime 'yes', a foreground-idle boundary should
   deliver the queued drain-wait message via FEAT-065 within ~7s. Check the client retry loop's
   interaction with a session whose page tab may be stale/hidden, and the server gate's midTurn
   freshness (status writes at boundaries — FEAT-065 added that; did the survivor's midTurn stay
   true spuriously? cross-check suspect 1's shape).

## Impact
The user's messages block for tens of minutes behind ghosts; the drain hold also blocks the
broker's own wind-down forever (the permanent-survivor state BUG-072 made visible but did not
release). This is now the TOP user-facing defect.

## Verification (§C)
Real-shape: background Task agent runs to completion → within a bounded window the broker's
level empties (backgroundLive:0) WITHOUT requiring a new foreground turn (must FAIL pre-fix if
suspect 1 confirmed); queued drain-wait message delivers within one retry tick of a foreground-
idle boundary (must FAIL pre-fix if suspect 2 confirmed); drain commits/reaps after the last
lane ends. Anti-regressions: feat-065-delivery 35/35, feat-064 18/18, bug-044 15/15, bug-068 5/5,
bug-072 47/47, restart-survives, liveness-conformance 96/96, typecheck.

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
