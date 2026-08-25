```orchard-ticket
{
  "id": "BUG-018",
  "type": "bug",
  "title": "Session navigation now preserves pending approvals and running work",
  "summary": "Session navigation now preserves busy work and unanswered approval cards for reattachment. Previously, switching or reopening a session silently denied approvals and removed the active session before its work finished.",
  "impact_if_we_wait": "Leaving the old behavior would silently reject user choices and make active work appear finished. Bounded: it affected session continuity and display correctness, not stored user data or process termination.",
  "current_need": "Treat the ticket as closed: explicit-close, detach, reattach, routing, reload, and interface behavior passed, with type checking clean.",
  "severity": "high",
  "area": "Session detach and reattach",
  "reported": "2026-08-04",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Navigating away from a busy session preserves its running turn",
    "A pending approval survives explicit close and reappears after reattachment",
    "Busy sessions remain available for live reattachment until their work finishes",
    "Idle sessions can still close normally"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "closeSocket",
      "note": "Sends the explicit close command before closing the socket during session navigation."
    },
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "Invokes closeSocket when switching to or reopening a session."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "case 'close'",
      "note": "Originally closed sessions unconditionally instead of preserving busy sessions through detach."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "ws.on('close')",
      "note": "The raw-disconnect path already detached busy sessions safely."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "AgentSession.close",
      "note": "Removes the live session and denies pending approvals before the running turn drains."
    }
  ],
  "related": [
    {
      "id": "BUG-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-017",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "blocks"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-018-explicit-close-auto-denies-approvals-and-vacates-bridge.md",
    "sha256": "93a609a24e42a92d0e7b80008fcc451a6bccc5924bda38c02879cf8b1742d5c0",
    "bytes": 13528,
    "original_title": "client's explicit `{type:'close'}` (sent on EVERY session switch/reopen) auto-denies pending approvals and instantly vacates the live-bridge registry, unlike a raw disconnect",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared BUG-018 against the supplied original; its symptom, cause, reproduction, expected behavior, related tickets, coverage gap, and executed evidence survive above.",
    "dropped": []
  }
}
```

# BUG-018 — Session navigation now preserves pending approvals and running work

## Diagnosis

The client sent `{type:'close'}` before closing its socket whenever a session was switched or reopened. The server handled that command with `AgentSession.close()` regardless of whether the session was busy. Closing synchronously removed the session from the live registry and resolved every pending approval as denied. By contrast, a raw socket disconnect used a busy check and detached the session, allowing work and approval state to survive for reattachment.

## Evidence

Real-server reproduction showed that an explicitly closed busy turn still reached `STORY-DONE-A`, proving the underlying process was not killed. With a real pending `Write` approval, explicit close removed the live session, reattachment fell back to an incompletely flushed transcript, and the approval card was not replayed.

After correction, `verify:reattach-approval` passed 11/11, `verify:detach` passed 7/7, `verify:close-busy-detach` passed 13/13, `verify:reload-live-summary` passed 10/10, `verify:routing` passed 11/11, and `verify:ui` passed 3/3. Type checking was clean.

## Implementation notes

The required behavior was to make explicit close follow the same busy-session detach contract as an abrupt socket loss. The regression coverage drives the client sequence of sending `{type:'close'}` and then closing the socket, which the earlier detach tests did not exercise.

## Verification plan

Exercise explicit close during a busy turn and while an approval is pending. Confirm the turn continues, the live session remains reattachable, and the same approval card reappears. Also cover ordinary detach, busy close, reload summaries, routing, interface behavior, and type checking.

## Risks

The busy and idle paths must remain distinct. Treating every close as detach could retain idle sessions unnecessarily, while closing a busy session would restore the approval-loss and false-finished behavior.

## Activity log (APPEND-ONLY)

### 2026-08-04 — agent (JOB 2 of a BUG-017 dispatch)
- **Understood:** dispatched to verify the detach/reattach guarantee while
  fixing BUG-017. Traced `agent-bridge.ts` + `index.ts`'s ws close/detach path.
- **Verified:** a raw/abrupt socket disconnect is safe (busy-checked, detaches,
  reattach replays pending approvals — matches `verify-reattach-approval.mjs`).
  But the CLIENT'S OWN `closeSocket()` — invoked on every `openSession()`, i.e.
  on ordinary session-switch/reopen navigation, not just page-close — sends an
  explicit `{type:'close'}` that the server handles WITHOUT the busy check,
  auto-denying pending approvals and instantly vacating the live-bridge
  registry. Reproduced live against a scratch server with two throwaway
  scripts (see Evidence); not committed (per JOB 2 instructions: report, do
  not fix).
- **Still open / handoff:** fix the `case 'close':` handler to share the
  busy-check-and-detach logic with `ws.on('close')` (see Fix direction), and
  add the missing verify coverage for the EXPLICIT-close path (both existing
  detach tests only cover the raw-disconnect path). Do not conflate with
  BUG-017's fix (different file already in flight — `public/app.js`); this is
  a server-side (`src/server/index.ts`) fix, safe to parallelize once BUG-017's
  `app.js` work lands.

### 2026-08-04 — fix + verification (subagent)
- **Understood:** inherited the full diagnosis above. The `case 'close':`
  handler (`src/server/index.ts` ~2006) called `session.close()` with no busy
  check; `AgentSession.close()` (`agent-bridge.ts` ~754) synchronously
  `sessions.delete(id)` (vacates the live registry mid-turn) and
  `for (const [,p] of #approvals) p.resolve({behavior:'deny'})` (auto-denies
  every unanswered card — defeating BUG-008's `replayPending`). The
  raw-disconnect path `ws.on('close')` (~2018) already does the correct thing:
  `if (session && session.busy && !session.closed) session.detach(); else close()`.
- **Layering choice (deliberate):** put the authoritative guard in the
  `case 'close':` handler ONLY — make it mirror `ws.on('close')` verbatim
  (busy+not-closed ⇒ `detach()`, else `close()`). I did NOT add an
  unconditional busy⇒detach guard inside `AgentSession.close()` itself, because
  `close()` has two LEGITIMATE force-close callers that must still tear down a
  busy session: project deletion (`index.ts` ~404 `s.close('project deleted')`)
  and socket-closed-during-start (~1840). Routing `close()` to detach
  unconditionally would leak a busy session when its project is deleted. The
  handler is the exact and complete site of the bug (the only unguarded
  `close()` on a still-driven session). Left the client (`public/app.js`
  `closeSocket()`) unchanged: the server guard makes the explicit
  `{type:'close'}` safe for ALL clients/tabs, symmetric with the proven-safe
  raw-drop path — cleaner than a client-side idle/busy heuristic, and it can't
  be bypassed by a stale client.
- **Changed:**
  - `src/server/index.ts` — `case 'close':` now
    `if (session && session.busy && !session.closed) session.detach(); else void session?.close('client closed').catch(()=>{});`
    (mirrors `ws.on('close')`; idle sessions still close normally). Race note:
    the client sends `{type:'close'}` THEN `ws.close()`; the handler detaches +
    sets `session = null`, so the following `ws.on('close')` is a no-op and the
    detached session survives for reattach.
  - `scripts/verify-close-busy-detach.mjs` + `package.json` script
    `verify:close-busy-detach` — new real-ws/real-haiku test driving the EXACT
    client sequence (`ws.send({type:'close'})` then `ws.close()`).
- **Verified (real scratch server on a free port, real haiku turns; 4317 never
  touched, killed by pid):**
  - `npm run verify:close-busy-detach` → **PASS 13/13** (with fix). Busy Write
    card + exact client close ⇒ (a) session STAYS in `/api/sessions` registry
    and stays busy (not auto-denied), (c) reattach replays the SAME requestId,
    (a') answering lands the Write on disk (`REATTACHED`) with a non-interrupted
    turn-end, exactly-once duplicate-answer refusal; (d) CONTROL: explicit close
    of an IDLE session still leaves the registry (closes normally).
  - **Negative control (fix reverted to unconditional `close()`):** same test →
    **FAIL 5/13** — the 8 load-bearing checks fail (registry vacated
    immediately, session gone, reattach `reattached:false`, card never replayed
    (auto-denied), Write never lands). The IDLE control still PASSES on both —
    proves the test is non-vacuous and the control isn't trivially green.
  - `npm run verify:reattach-approval` → **PASS 11/11** (BUG-008 contract intact).
  - `npm run verify:detach` → **PASS 7/7** (raw-disconnect detach unregressed).
  - `npm run verify:reload-live-summary` → **PASS 10/10**.
  - `npm run verify:routing` → **PASS 11/11**.
  - `npm run verify:ui -- --offline` → **PASS 3/3**.
  - `npm run typecheck` → **PASS** (tsc --noEmit, exit 0).
- **Robustness (anticipating the refuter §N):** rapid switch/reopen mid-turn —
  each explicit close of a busy session detaches; a reattach (`start` +
  `resumeSessionId`) finds the still-detached session and `replayPending()`s.
  Multiple simultaneous pending approvals — `detach()` preserves the whole
  `#approvals` map; `replayPending()` re-emits every entry. Close→immediate
  reattach race — detach keeps the session live in the registry, so the
  reattach resolves the in-memory session (never the not-yet-flushed
  transcript). A turn blocked on a pending card never reaches turn-end, so a
  detached session with an open card can't self-close before reattach.
- **Handoff:** none — fixed and verified. Orchestrator to review + commit.
  Shares `src/server/index.ts` with other bridge tickets (BUG-008/017); the
  change is a self-contained 5-line handler edit — serialize commits.

### 2026-08-04 — orchestrator (§N adversarial refute — VERDICT: fix HOLDS)
An independent refuter attacked the fix (real scratch servers, real haiku turns,
direct + container isolation): explicit-close on a busy session w/ pending approval
(direct & container), multiple simultaneous approvals, rapid reattach, client-bypass
— all held (registry preserved, approvals replayed once). It probed the two
force-close call sites the fix deliberately left: project-delete is explicit
`?force=1`-gated (consented); the `closedEarly`-during-start path is genuinely
unguarded but NOT practically reachable on a warm host (0/43+ race trials; only a
one-time cold image *build* opens the window). Reported as **residual THEORETICAL
risk**, not a filed bug (no repro — ticket discipline). Noted here so it's not lost:
if hardening is ever wanted, add the same busy⇒detach guard to the `closedEarly`
branch.
