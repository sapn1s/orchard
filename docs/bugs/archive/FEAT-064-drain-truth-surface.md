# FEAT-064 — post-restart drain truth surface: the refusal and the chip say WHAT holds the drain

- **Status:** VERIFIED 2026-08-11 — verify:feat-064-drain-truth 18/18 (pre-fix FAIL proven: 7/18, incl. a MEASURED mid-turn stdin-EOF); all anti-regressions green. Needs a later DEPLOY — not deployed.
- **Area:** session-host broker heartbeats → index refusal → BUG-045 chip
- **Reported:** 2026-08-11, from BUG-048's explore (commit 3f1da4e)

## Scope (exactly the explore's "first dispatchable increment")
No lifecycle change. Extend the broker's existing decline/status heartbeats with
`backgroundLive` (bool/count), the background task ids it sniffed, and `drainHeldSince`;
surface that through the index.ts resume-refusal payload and the BUG-045 drain-wait chip:
"waiting on drain — held 43s by 1 background agent (FEAT-062 loop) — retries itself" instead
of the bare "try again in a few seconds". Health/doctor may carry the same fields.

## Also in scope (the latent bug the explore found — fix while here)
`commitDrain()` re-checks only background lifetime, not `midTurn`: an injected/late turn could
be truncated by the EOF (BUG-022 §3 class). Gate the commit on midTurn/fresh-result too. This
is a genuine pre-existing hazard of the BUG-044 hold, independent of future delivery work.

## Verification (§C)
Real-shape: restart with a background-holding survivor → refusal payload + chip carry the held
reason/elapsed/count (must FAIL pre-fix: today's payload has none of it); commitDrain midTurn
gate proven (planted mid-turn commit attempt declines). Anti-regressions (explore's list):
verify:resume-refusal, verify:refusal-visible, verify:bug-044-restart-background,
verify:restart-survives, verify:health-survivor, typecheck.

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
