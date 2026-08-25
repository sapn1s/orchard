```orchard-ticket
{
  "id": "BUG-017",
  "type": "bug",
  "title": "Live reload replaces conversation with agent summary",
  "summary": "Live self-owned sessions now keep showing the conversation when reloaded at an older transcript position. Previously, a forward gap could replace the conversation with the historical agent-run summary.",
  "impact_if_we_wait": "Reloading a large live session can misleadingly hide its continuing conversation behind a historical summary. Bounded: this is display-correctness, not data loss, and finished-session summaries remain valid.",
  "current_need": "Keep the ticket closed: targeted deep-index reload and agent-summary suites passed, and type checking stayed clean.",
  "severity": "high",
  "area": "Live session reload",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Reloading a live self-owned session at a deep index shows the continuing conversation",
    "The historical agent summary does not replace a live session conversation",
    "A genuinely finished session can still show its historical agent summary"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "liveRecordFor",
      "note": "Returned null when the current client owned the live bridge"
    },
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "The gap guard could mark recorded agents pending despite a self-owned live session"
    },
    {
      "path": "public/app.js",
      "symbol": "loadRecordedAgents",
      "note": "Spliced the historical agent summary into the transcript"
    }
  ],
  "related": [
    {
      "id": "BUG-004",
      "relation": "see_also"
    },
    {
      "id": "BUG-014",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-018",
      "relation": "see_also"
    },
    {
      "id": "BUG-019",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "see_also"
    },
    {
      "id": "FEAT-031",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [
    "BUG-004",
    "BUG-014"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-017-reload-summary-on-live-self-owned-session.md",
    "sha256": "1e6d3d0154c4acd27cb9ed85e015b8f0aeaa164969f70fcedeb16a2bbd2f103d",
    "bytes": 9622,
    "original_title": "Reload shows \"N agents ran\" summary on a LIVE self-owned session opened at a deep index",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, live-session evidence, gap mechanism, expected behavior, fix direction, regression coverage, and sibling recurrence remain represented.",
    "dropped": [
      "Approximate source line numbers",
      "Session size details that do not change reproduction",
      "Speculation about making the summary a collapsible transcript element"
    ]
  }
}
```

# BUG-017 — Live reload replaces conversation with agent summary

## Diagnosis

`liveRecordFor(sessionId)` returned `null` whenever `state.live` was true, assuming the live path owned the transcript tail. At a deep index, a forward gap still existed. The `openSession` guard interpreted the missing live record as permission to set `agentsPending`, after which `loadRecordedAgents` replaced the conversation with the historical summary.

## Evidence

The affected session was genuinely live: `/api/sessions` reported an active bridge with `busy:true`. `verify:reattach-approval` passed 11/11, `verify:deep-index-agent-summary` passed 11/11, and `verify:agent-summary` passed 3/3. The standing `typecheck` check was clean.

## Implementation notes

Treat `state.live` as a live signal wherever a forward gap could schedule the historical agent summary. The ticket proposed guarding `agentsPending` with `!state.live` or returning a truthy live record, then auditing related `!liveRec` checks. Because `public/app.js` is static, reload applies the change without restarting the server.

## Verification plan

Reload a live self-owned session with many recorded agents at a deep index that creates a forward gap. Confirm the conversation renders without the summary replacing it. Then open a finished session without a bridge and confirm its summary still appears. The ticket also named broader UI, routing, reload, and detach suites.

## Migration and rollback

The change is confined to static client behavior and takes effect on reload. Roll back the live-signal guard if finished-session summary behavior regresses.

## Risks

A broad interpretation of `state.live` could suppress the historical summary for a session that is no longer genuinely active. The finished-session case must remain covered.

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
