# BUG-028 — server-restart turn break renders as "[Request interrupted by user]"

- **Status:** VERIFIED
- **Area:** claude-station UI (+ transcript/resume path) — state honesty
- **Reported:** 2026-08-05 by user ("still says '[Request interrupted by user]' even tho i did no action — idk if a bug or expected")

## Symptom (observed live)
During a deploy restart of :4317, the orchestrator session SURVIVED in its FEAT-015 scope, but
the in-flight turn was cut when the WS bridge died with the old server. On resume, the transcript
shows "[Request interrupted by user]" — attributing the interruption to the USER, who did nothing.

## Why it matters
State-honesty class (FEAT-040 / BUG-027 sibling): the label asserts a false cause. A user reading
it thinks they (or a misclick) killed the turn; the real cause was a server restart / bridge drop.
Interruption labels must attribute the actual cause.

## Fix direction (investigate first)
Find where the interrupt marker text is produced (client render? SDK resume artifact? bridge
injecting an interrupt on socket death?). If the marker comes from the SDK/CLI on stdin
interruption, the bridge/broker knows WHY (restart-survival drain / socket drop, vs a real user
stop click) — carry that cause through and render honestly, e.g. "[Turn interrupted — server
restarted; session survived and reattached]" vs user-initiated stop. If the SDK hardcodes the
string, remap at render time using the known restart/reattach event window.

## Verification (REQUIRED)
Scratch server + driven session (free port, never :4317): restart the scratch server mid-turn
(FEAT-015 path), reattach, and assert the rendered marker attributes the break to the restart —
NOT to the user. A REAL user stop must still render as user-initiated (don't break the honest
case). Must FAIL on current code. typecheck + verify:ui offline.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from a live user report immediately after the dogfooded deploy restart. Pairs with
  BUG-027 (health under-report) as post-restart state-honesty gaps.

### 2026-08-05 — fix agent — ROOT CAUSE + FIX — VERIFIED

**Root cause (grounded — live transcript forensics + direct CLI probes, not assumed).**
The string "[Request interrupted by user]" / "…for tool use]" is written by the
**`claude` CLI itself** (v2.1.220) as a user-role transcript entry — it appears
nowhere in this repo's source. The decisive finding: **the CLI already records
the true cause on the entry**, claude-station just dropped it:
- **Shutdown-cut turn** (the CLI got a graceful signal mid-turn — a restart's
  SIGTERM): entry carries **`interruptedByShutdown: true`**. The live BUG-028
  instance (orchestrator transcript `87564f3e…`, line 6328, ts
  2026-08-05T06:35:05.564Z — 26 ms after the last pre-restart tool_result) has
  exactly this flag. So do all 8 earlier restart-era markers in that file.
- **Real user stop** (interrupt request): entry carries `interruptedMessageId`
  (or, via the station's WS `{type:'interrupt'}` path, neither field) and
  **never** `interruptedByShutdown`. Census over this machine's whole
  `~/.claude/projects` store: 45 shutdown-flagged vs 181 user-stop entries,
  **zero overlap** — a perfect per-entry discriminator, no timing heuristics
  needed.
- Trigger probes (direct CLI, stream-json, mid-turn): SIGTERM → marker WITH the
  flag + `result: error_during_execution`; stdin-EOF → NO marker (turn
  truncates silently); SIGKILL then `--resume` → NO marker synthesized at
  resume. So the marker is stamped at shutdown time by the dying CLI, and the
  flag is trustworthy.
- The station bug: every transcript render path funnels through ONE seam —
  `toMessage()` (`src/server/jsonl.ts`), used by tail/forward paging
  (`transcript.ts`), the file-follow watcher (`watcher.ts`), and subagents —
  and it dropped `interruptedByShutdown`; the client's `renderMessages()`
  (`public/app.js`) then rendered every user-role text block as a `.you`
  bubble, i.e. asserted the user said/did it.

**Fix (minimal, at the confirmed seam).**
- `src/lib/session-history.ts` — `TranscriptMessage.interruptedByShutdown?: boolean` (documented).
- `src/server/jsonl.ts` (`toMessage`, ~line 113) — carry the flag through (only
  present when true; wire shape unchanged for ordinary messages). One seam =
  tail, forward, live file-follow, and subagent renders all get it.
- `public/app.js` — `shutdownBreakCaption()` (next to `commandCaption`, ~line
  2639) + one line in `renderMessages`'s user branch: a marker text whose
  message has `interruptedByShutdown === true` renders as a system caption
  `"[Turn interrupted — the server restarted or shut down mid-turn, not a user
  stop; the thread resumed from its saved transcript]"` (class
  `ran-lbl shutdown-break`) instead of a user bubble. An unflagged marker (real
  stop) still renders as the user's own bubble — the honest case untouched.

**Attribution boundary (stated, per ticket bar).** `interruptedByShutdown` means
"the CLI process was shut down mid-turn", which covers a server
restart/redeploy AND any other graceful termination of the CLI (an explicit
close that escalates, drain-backstop SIGTERM). The caption therefore says
"restarted or shut down", not "restarted" alone. The bar — never attribute a
shutdown-cut turn to the USER — holds exactly: the flag never appears on a real
user stop. Conversely, a fully-scoped FEAT-015 survivor whose drain COMPLETES
the turn writes no marker at all (nothing to attribute); the marker only exists
when the CLI was actually cut, which is precisely when honest attribution is
needed.

**Verified (scratch only; :4317/claude-station.service never touched; killed by
pid / own transient unit; real service confirmed 200 after the runs; no leftover
scratch units/brokers/dirs).**
- NEW `scripts/verify-restart-interrupt-label.mjs` + package.json
  `"verify:restart-interrupt-label"` — deploy-shaped: scratch transient
  `--user` service (KillMode=control-group), real driven haiku session mid-turn
  (python sleep fixture), REAL `systemctl --user stop` as the cut, fresh server
  over the same dataDir as the reattach, REAL dashboard render in headless
  Brave (playwright, system binary) for both cases + screenshots.
  - PRE-FIX (fix hunks stashed): **8/11 — bug reproduced exactly**: on-disk
    entry flagged `interruptedByShutdown:true` (CLI ground truth PASS) but
    `/api/transcript` dropped the flag and the dashboard rendered the cut as a
    `.you` bubble "[Request interrupted by user]".
  - POST-FIX: **11/11 PASS** — API carries the flag; dashboard renders the
    honest restart caption and NO user bubble for the cut (CASE A); a REAL
    `{type:'interrupt'}` stop still renders as the user-attributed bubble with
    no shutdown caption (CASE B, the don't-break-honest guard).
- Screenshots: `docs/bugs/assets/BUG-028-restart-label.png` (honest caption),
  `docs/bugs/assets/BUG-028-user-stop.png` (user stop unchanged).
- Anti-regression: `verify:restart-survives` **15/15**, `verify:ui -- --offline`
  **3/3**, `typecheck` clean, `verify:restart-reconnect-race` **10/10** (after
  the BUG-027-flagged side-fix below).
- Side-fix (BUG-027 handoff, one hunk): `verify-restart-reconnect-race.mjs`'s
  fixture `sleep 30` → `python3 -c 'import time; time.sleep(30)'`, so the
  harness stops false-failing on dev boxes whose agent hook blocks bare sleeps
  — it now passes 10/10 here (was 9/10 environmental). Noted on BUG-027's log.

**Go-live note.** Render fix is client+server; it takes effect on :4317 at the
next deliberate deploy restart (and the existing shutdown-cut markers in old
transcripts — including the one the user reported — will re-render honestly,
since the flag is read from the transcript itself, not from new state).
