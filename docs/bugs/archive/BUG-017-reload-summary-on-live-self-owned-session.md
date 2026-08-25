# BUG-017 — Reload shows "N agents ran" summary on a LIVE self-owned session opened at a deep index

- **Status:** VERIFIED
- **Severity:** high (recurring, jarring — the flagship reload UX; sibling of BUG-004/BUG-014)
- **Area:** routing-transcript / reload live-vs-summary
- **Reported:** 2026-08-04 by user (reload of this 32-agent / 14MB session showed the agent-run summary)

## Symptom
Reloading a LIVE, still-running session (that owns its own dashboard bridge) which
is scrolled to / opened at an OLD index shows the historical "N agents ran in this
session" summary INSTEAD of the continuing conversation. Confirmed the session was
genuinely live at the time: `/api/sessions` listed an active bridge for it
(`busy:true`) — so it should never have shown the summary.

## Root-cause lead (verify before fixing)
`liveRecordFor(sessionId)` (public/app.js ~3777) short-circuits: `if (!sessionId ||
state.live) return null;` — i.e. when THIS client owns the bridge (`state.live`
true), it returns `null` on the theory that "the live path owns the tail." But
BUG-014's guard in openSession (~2860) is `if (th.gap && !liveRec) th.agentsPending
= true;`. For a big transcript opened at a deep index a forward `gap` exists, and
`liveRec` is null (from the short-circuit), so `!liveRec` is true → `agentsPending`
is set → `loadRecordedAgents` splices the historical summary. So a LIVE self-owned
session + deep-index gap defeats the BUG-004/014 fixes.

## Expected
A session that is live by ANY signal — including `state.live` (we own the bridge) —
must NEVER show the historical agents-ran summary on reload; it shows the
conversation. Deeper: the "N agents ran" summary should arguably be a collapsible
ADJUNCT within the transcript, never a full replacement of the convo.

## Fix direction
- In the gap/agentsPending guard, treat `state.live` as live too:
  `if (th.gap && !liveRec && !state.live)` (or have liveRecordFor's short-circuit
  return a truthy live-record instead of null so every downstream `!liveRec` guard
  sees it). Audit ALL `!liveRec` / agentsPending sites for the same hole.
- Consider the stronger fix: never let the ran-stack summary REPLACE the
  conversation — render it as a collapsible element.

## Verification (REQUIRED)
Real browser: a live, self-owned (state.live) session with many recorded agents,
opened/reloaded at a deep index so a forward gap forms → assert the CONVERSATION
renders and the "N agents ran" summary is NOT spliced in as a replacement; a
genuinely finished session (no bridge, stale file) still shows the summary. Must
FAIL on current code. Note: app.js is a static asset, so the fix applies on reload
withOUT a server restart. verify:ui offline + typecheck.

## Context pack
- Suspect: public/app.js `liveRecordFor` (~3777) + openSession gap guard (~2860) +
  loadRecordedAgents (~2714). Siblings: BUG-004 (f4fc2a3), BUG-014 (2850d5b).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user reload report. Confirmed live via active bridge in /api/sessions.
  Root-cause lead: state.live short-circuit in liveRecordFor defeats the !liveRec
  gap guard. Awaiting user go-ahead to fix (they just interrupted a restart).

### 2026-08-04 — agent (JOB 1 fix + JOB 2 detach/reattach audit)
- **Understood:** confirmed the exact lead. `liveRecordFor` (`public/app.js`
  ~3778) returns `null` when `state.live` is true ("our own bridge already
  owns the tail"), but the two gates right after it in `openSession` only
  checked `liveRec`, not `state.live` itself: the outer gate
  `if (th.gap || liveRec) { … }` (~2851) and the `agentsPending` queue
  `if (th.gap && !liveRec) th.agentsPending = true;` (~2860). For a
  `state.live` session with an outstanding deep-index gap, `liveRec` is
  `null`, so `!liveRec` reads true and `agentsPending` gets queued anyway →
  `loadNewer`'s existing `if (th.agentsPending)` gate (BUG-014's fix) drains it
  into `loadRecordedAgents`, splicing the historical summary at the live end.
  Audited every `!liveRec`/`agentsPending`/`loadRecordedAgents` reference in
  `public/app.js` (grep for `liveRec\b`): all live inside this one
  `openSession` block (~2837-2896) — no other site had the same hole.
  (Structural note for future readers: `closeSocket()`, called unconditionally
  at the TOP of every `openSession()`, sets `state.live = false` synchronously
  before `liveRecordFor` ever runs — so this exact condition can only arise
  from a genuinely concurrent `connect()` racing in during `openSession`'s
  awaited fetches, e.g. another in-flight `startTurn()` on the same tab. Rare
  in the wild but real, and the fix must hold regardless of how state.live
  became true.)
- **Changed (`public/app.js`, not committed):**
  - `openSession`'s outer gate: `if (th.gap || liveRec) {` → `if (th.gap ||
    liveRec || state.live) {` (~2857) — a self-owned live session with NO gap
    no longer falls into the `else` branch that calls `loadRecordedAgents`
    unconditionally.
  - The `agentsPending` queue: `if (th.gap && !liveRec)` → `if (th.gap &&
    !liveRec && !state.live)` (~2867) — matches BUG-014's exact fix shape,
    extended to cover `state.live` the same way it already covers the
    mtime/bridge union.
  - Exposed `openSession` on `window.__station` (boot(), ~5368) — needed so a
    verify script can construct the "state.live true while liveRecordFor runs"
    condition deterministically (see verify script header for why this is
    honest, not a cheat: `openSession` runs synchronously up to its first
    `await` — closeSocket() included — before returning, so setting
    `state.live = true` right after the call lands exactly in the race window
    a real concurrent `connect()` would occupy).
  - Added `scripts/verify-reload-live-summary.mjs` +
    `package.json` `verify:reload-live-summary`.
- **Verified:**
  - Confirmed the new test FAILS on unpatched code: temporarily reverted just
    the two condition lines (keeping the `__station.openSession` export, since
    the test needs it regardless of the fix), reran directly →
    **9 passed, 1 failed** — the exact repro (`ranStacks:1` spliced in after
    the gap was paid off). Restored the fix; confirmed the diff matched
    exactly what's described above.
  - `npm run verify:reload-live-summary` (fixed code) → **10 passed, 0
    failed** — self-owned-live case shows the conversation with no summary
    spliced in, AND the control (genuinely finished session, `state.live`
    left false) still shows its summary (no over-suppression).
  - `npm run verify:routing` → **11 passed, 0 failed**.
  - `npm run verify:reload-live` → **3 passed, 0 failed**.
  - `npm run verify:reattach-approval` → **11/11 checks passed** (anti-
    regression on the detach path — see JOB 2 below).
  - `npm run verify:ui -- --offline` → **3 passed, 0 failed**.
  - `npm run typecheck` → clean.
  - Anti-regression on the siblings whose machinery this touches:
    `npm run verify:deep-index-agent-summary` → **11/11** (BUG-014),
    `npm run verify:agent-summary` → **3/3** (BUG-004).
  - Screenshot: `docs/bugs/assets/BUG-017-after.png` — the self-owned-live,
    deep-index-restored fixture showing the live tail with no stray "agents
    ran" summary after the gap was paid off.
- **Status → VERIFIED.**
- **JOB 2 (detach/reattach guarantee — investigate, do not fix here):**
  Read `src/server/agent-bridge.ts` + `src/server/index.ts`'s ws close/detach
  path. A RAW/abrupt socket disconnect (crashed tab, or a genuine hard browser
  reload — there is no `beforeunload` handler in `public/app.js`, so a hard
  reload just drops the TCP connection) is SAFE: `ws.on('close')`
  (`index.ts` ~2018-2029) checks `session.busy` and calls `session.detach()`
  — confirmed correct by the passing `verify:reattach-approval` run above (raw
  `ws.close()`, pending approval replays on reattach).
  BUT: `public/app.js`'s own `closeSocket()` (~3884-3893) — called
  UNCONDITIONALLY at the top of every `openSession()`, i.e. on ordinary
  in-app session-switch/reopen navigation, not just page-close — sends an
  EXPLICIT `{type:'close'}` command that the server's `case 'close':` handler
  (`index.ts` ~2006-2009) handles WITHOUT any busy check: it calls
  `session.close()` unconditionally, which (per `agent-bridge.ts` ~754-795)
  synchronously auto-DENIES every pending approval and instantly removes the
  session from the live-bridge registry — a real divergence from the
  detach-not-kill guarantee, reproduced live with two throwaway scripts
  against a scratch server (not committed). Filed as **BUG-018** (critical,
  new ticket) with the exact code paths and evidence — NOT fixed here per the
  JOB 2 instruction to report only. Verdict: **a genuine reload/crash
  detaches, but the SPA's own routine navigation can silently deny pending
  approvals and vacate the bridge registry** — narrower than "reload kills
  work outright" (the underlying turn was NOT violently killed in the repro —
  it drained to completion), but still a real, previously-unverified gap in
  the guarantee (existing `verify-detach.mjs`/`verify-reattach-approval.mjs`
  only exercise the raw-disconnect path, never the explicit-close command the
  real client actually sends).
- **Still open / handoff:** none for BUG-017's own symptom. BUG-018 (new,
  critical, server-side) is queued separately — see that ticket for its own
  fix direction and required verify coverage; it does not block this one and
  touches a different file (`src/server/index.ts`, not `public/app.js`).
