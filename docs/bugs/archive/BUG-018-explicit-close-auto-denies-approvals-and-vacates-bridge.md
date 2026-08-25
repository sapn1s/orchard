# BUG-018 — client's explicit `{type:'close'}` (sent on EVERY session switch/reopen) auto-denies pending approvals and instantly vacates the live-bridge registry, unlike a raw disconnect

- **Status:** VERIFIED
- **Severity:** critical
- **Area:** server / agent-bridge / detach-reattach contract
- **Reported:** 2026-08-04 by an agent investigating BUG-017 (JOB 2: "does reload kill in-flight work?")

## Symptom
The user fears a dashboard reload/interrupt KILLS in-flight subagents/work. A
**raw socket disconnect** (browser tab closed, real crash, or a hard page reload
— there is no `beforeunload` handler in `public/app.js`, so a hard reload just
drops the TCP connection) is verified SAFE: server's `ws.on('close')` handler
(`src/server/index.ts` ~2018-2029) checks `session.busy` and calls
`session.detach()` — the turn keeps running, and a reattach replays any pending
approval card (BUG-008, `verify-reattach-approval.mjs` proves this).

BUT `public/app.js`'s own `closeSocket()` (~3884-3893) — called **unconditionally
at the top of every `openSession()`** (~2794), i.e. on **every session switch
AND every reopen of the session you're currently driving** — sends an EXPLICIT
`{type:'close'}` command over the socket BEFORE calling `ws.close()`. The server
handles that command differently and dangerously:

```
// src/server/index.ts ~2006-2009
case 'close':
  void session?.close('client closed').catch(() => {});
  session = null;
  return send({ t: 'ack', of: 'close' });
```

`AgentSession.close()` (`src/server/agent-bridge.ts` ~754-795) — **with no busy
check at all**:
- synchronously sets `this.busy = false` and `sessions.delete(this.id)` —
  instantly removing the session from the live-bridge registry
  (`/api/sessions`, `liveSessions()`), WHILE the turn may still be actively
  finishing in the background;
- synchronously **auto-denies every pending approval**:
  `for (const [, p] of this.#approvals) p.resolve({ behavior: 'deny', message:
  'session closed' });` — a permission/plan card the user has not yet answered
  is silently rejected, not preserved for reattach;
- calls `this.#input.end()` (does not SIGKILL the underlying process — the
  current in-flight model turn is allowed to drain to completion; confirmed
  empirically, see Repro/Evidence below).

Net effect: switching away from — or simply **reopening** — a session that is
mid-turn on the current tab does NOT violently kill the process, but it DOES
silently deny any open approval card, and it DOES make the session vanish from
the live registry immediately (well before the turn/its subagents actually
finish), which is a second, independent contributor to BUG-017-style "looks
finished when it isn't" bugs, and breaks the reattach contract that BUG-008
built (`replayPending()` can't replay what was already auto-denied).

## Evidence (real server, scratch port, real haiku turns — no fixture/mock)
Two throwaway repro scripts (not part of the deliverable, deleted after use)
against a scratch server:
1. **Plain busy turn**: opened a real session, let it get mid-turn (busy),
   sent the EXACT client message `closeSocket()` sends (`{type:'close'}`)
   while busy, then polled the transcript file. The turn **did finish**
   (`STORY-DONE-A` landed) — confirms it is NOT a violent kill at the process
   level.
2. **Pending approval**: same but with a default-mode `Write` (forces a real
   `approval-request` card, turn blocked in `canUseTool`). Sent `{type:'close'}`
   while the card was pending, then reattached with a NEW socket + the same
   `resumeSessionId`. Result: the reattach could not find a live session
   object (deleted from `sessions` synchronously by `close()`), fell back to
   resuming from the on-disk transcript, and **failed outright**
   (`"cannot resume …: no transcript for it"` — the on-disk file was not fully
   flushed yet), and the approval card was **never replayed**
   (`replayed approval-request on reattach: null`). Contrast with
   `verify-reattach-approval.mjs`'s raw-`ws.close()` path, which replays the
   SAME card correctly by design.

## Expected
`closeSocket()`'s explicit `{type:'close'}` — sent on ordinary navigation
(session switch, or reopening the session you're already driving) — must NOT
be more destructive than an abrupt socket drop. It should hit the SAME
busy-check-and-detach path as `ws.on('close')` (server ~2027:
`if (session && session.busy && !session.closed) session.detach(); else
void session?.close(...)`), not unconditionally call `session.close()`. A
still-open approval/plan card must survive an ordinary "I'm looking at
something else now" navigation, exactly as it survives a crashed tab.

## Context pack
- Client: `public/app.js` `closeSocket()` (~3884-3893, sends `{type:'close'}`
  then `ws.close()`), called unconditionally at the top of `openSession()`
  (~2794) and `startNew()`/similar (~3200).
- Server: `src/server/index.ts` `case 'close':` handler (~2006-2009) — the
  unconditional, no-busy-check path. Compare `ws.on('close')` (~2018-2029) —
  the SAFE, busy-checked path.
- `src/server/agent-bridge.ts` `AgentSession.close()` (~754-795) — the
  `sessions.delete` + `#approvals` auto-deny happen synchronously, before
  `#input.end()`/`#pump` drain the actual turn to completion.
- Siblings: BUG-008 (8a1306e, pending-approval replay on reattach — this bug
  defeats it for the explicit-close path specifically), BUG-017 (this session's
  companion ticket — the vanished-bridge-registry entry is a second contributor
  to "reopen shows the historical summary instead of the live conversation").
- Existing verify scripts (`verify-detach.mjs`, `verify-reattach-approval.mjs`)
  only exercise the RAW `ws.close()` path (a genuine socket drop) — **neither
  covers the explicit `{type:'close'}` command the real client actually sends
  on every session switch/reopen.** That gap is why this shipped unnoticed.
- Fix direction (NOT implemented here — filed per JOB 2 instructions to report,
  not fix): make the `case 'close':` handler share the busy-check-and-detach
  logic with `ws.on('close')` instead of calling `session.close()`
  unconditionally; or have the client only send `{type:'close'}` when it knows
  the session is idle.
- Repro test: none yet as a committed script — the fixing agent MUST add a
  verify script (model it on `verify-reattach-approval.mjs`, but drive the
  EXACT client sequence: `ws.send({type:'close'})` then `ws.close()`, not a
  raw close) that FAILS on current code (approval lost / reattach fails) and
  passes after the fix (approval replayed, exactly like the raw-disconnect
  case).

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
