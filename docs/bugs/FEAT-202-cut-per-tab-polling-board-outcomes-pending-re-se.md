```orchard-ticket
{
  "id": "FEAT-202",
  "type": "feature",
  "title": "Cut per-tab polling: board/outcomes/pending re-sent unchanged every 5s",
  "summary": "One foreground tab makes ~8,100 requests/hr (~2.3/s) and ~170 MB/hr, dominated by the board poll (166 KB every 5s). board, agent-outcomes and lanes-pending are byte-identical across polls yet re-fetched continuously. Add ETag/304, dedupe the doubled outcomes fetch, and push change events over the existing per-tab watch socket.",
  "impact_if_we_wait": "With 15-25 tabs open the UI ships ~3.4 GB/hr of mostly-unchanged JSON and can lag or crash the tab; cost scales linearly with tabs.",
  "current_need": "plan+review: adopt the ETag/304 + dedupe quick wins, then the watch-socket change channel; confirm fit with FEAT-197.",
  "severity": "medium",
  "area": "ui/transport",
  "reported": "2026-10-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "board, agent-outcomes and lanes-pending return 304 (or push-driven) when unchanged; per-tab bytes/hr drop by >=90%",
    "agent-outcomes is fetched at most once per rail cycle",
    "processes/summary stops polling while the tab is hidden",
    "a shared per-tab push channel drives board/outcomes/pending updates with polling demoted to a slow fallback"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "c880e5da-96fb-4f06-9604-5e2dc036bf61",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T10:56:49.646Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b8df00420c9d51698915cec702bac6b320ef4bbb7ebf500e62d2d8c42c531045",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "5b838160-9f9b-46b3-b77d-5844626a474e",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T13:40:03.964Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "faad022df9b8086cf2af889fad8acd77c2d5bc4c074a5aedbd6ecf7cc27d8e62",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "1bd5aa13-a368-45f2-b604-3aaf57084a67",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T14:58:03.468Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "round-3 fingerprint fix on the working tree; 27/27 fixer + 3 adversarial (same-size-rewrite-x30, fs-attacks-1s-cache, client-railcycle) all pass"
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
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

# FEAT-202 — Cut per-tab polling: board/outcomes/pending re-sent unchanged every 5s

## Diagnosis

One browser tab, with a project selected, a session open, and the tab in the
foreground, issues **~8,100 requests/hr (~2.25/s)** and pulls **~170 MB/hr** —
consistent with the user's observed ~7,000/hr (~2/s) and the earlier ~2.45/s
estimate. Measured read-only against the live station (:4317, project
`claude-station`) with `scripts/http-get.mjs`.

### Periodic-request inventory (per tab)

All loops below pause while the tab is hidden **except** `processes/summary`.
Sizes are live measurements; `running` is estimated (no live session at
measure time). "Changes?" = whether 5 fetches ~2s apart differed.

| Endpoint | Driver (app.js) | Interval | Paused when hidden | View-scoped | Bytes | Changes between polls | req/hr | bytes/hr |
|---|---|---|---|---|---|---|---|---|
| `/api/projects/:id/board` | pollRail→refreshRail(force) | 5s | yes | no (always on) | **166 KB** | **NO (identical x5)** | 720 | **119.5 MB** |
| `/api/agent-outcomes` | refreshOutcomes **x2/cycle** (refreshRail end + pollRail) | 5s | yes | project | 19 KB | **NO** | 1440 | **27 MB** |
| `/api/lanes/pending` | refreshPending | 5s | yes | project | 26 KB | **NO** | 720 | **18.7 MB** |
| `/api/sessions/:id/requests` | refreshRequests | 5s | yes | session | small | rarely | 720 | ~1 MB |
| `/api/sessions/:id/running` | pollRunning | 4s | yes | session | est. modest | yes | 900 | est. |
| `/api/sessions/live` | refreshLive | 5s | yes | no | 2.5 KB | YES | 720 | 1.8 MB |
| `/api/sessions` (bridges) | refreshLive (conditional) | 5s | yes | no | 2.9 KB | sometimes | <=720 | <=2 MB |
| outbox / starts | OUTBOX loop | 2s | yes | session/project | small | yes | 1800 | ~2 MB |
| `/api/sessions/:id/access-requests` | refreshSessionAccess | 5s | yes | session | small | rarely | 720 | ~0.5 MB |
| `/api/usage` | refreshUsage | 30s | yes | no | 2.5 KB | occasionally | 120 | 0.3 MB |
| `/api/processes/summary` | refreshProcSummary | 15s | **NO — runs hidden** | no | 0.9 KB | occasionally | 240 | 0.2 MB |
| git status/changes/fetch | git-view | 15s TTL / fetch loop | yes | only when git view open | varies | — | 0 unless git open |
| usage-countdown tick | startUsagePolling | 1s | yes | no network | — | — | 0 |

**Totals** (foreground, session open): **~8,100 req/hr (~2.25/s), ~170 MB/hr/tab.**
- **Hidden tab:** only `processes/summary` (~240 req/hr, ~0.2 MB) + WS reconnect keepalive. Everything else is correctly paused.
- **20 foreground tabs:** ~162,000 req/hr, ~3.4 GB/hr. **20 hidden tabs:** ~4,800 req/hr, ~4 MB/hr.

### Top 3 offenders (by bytes)
1. **board — 119.5 MB/hr (70%)**: 166 KB re-sent every 5s, **byte-identical across polls**.
2. **agent-outcomes — 27 MB/hr**: 19 KB, unchanged, and **fetched twice per rail cycle** (refreshRail's tail + pollRail both call refreshOutcomes).
3. **lanes-pending — 18.7 MB/hr**: 26 KB, unchanged.

The three biggest payloads never changed across 5 consecutive polls — the dominant cost is re-shipping identical bytes.

### What the server already pushes

A **page-lifetime passive "watch" WebSocket per tab** (`state.watchWs`, app.js ~11717) is already open for the life of every tab. The server pushes `session-appended`, `follow-status`, and versioned `session-account` facts to **every connected socket** (index.ts ~5774/5811). There is **no change-event bus** for board/outcomes/pending — those are file-backed stores (outcomes.ts, decisions.ts) read fresh per HTTP request, so the client can only discover changes by polling. The existing watch socket is the natural carrier for change events.

## Implementation notes — recommendation

### Quick wins (do first, low risk)
1. **ETag / If-None-Match (304) on board, agent-outcomes, lanes-pending.** Because these are byte-identical between polls, a conditional GET returns 304 (empty body) on the ~95%+ of polls where nothing changed. Request **count** is unchanged, but **bytes drop from ~170 MB/hr to ~5-10 MB/hr/tab** (and the client skips re-parse/re-render on 304). Biggest single win. *Est. ~95% byte reduction.*
2. **Dedupe the double agent-outcomes fetch** per rail cycle. *Saves 720 req/hr + ~13 MB/hr/tab.*
3. **Longer interval for slow-moving board** (15-30s instead of 5s) and **gate `processes/summary` on visibility** (it currently polls in hidden tabs). *Board reqs/bytes cut 3-6x.*
4. **View-scope the project-level polls** (outcomes/pending/board) so they idle when the rail/board surface isn't shown.

### Structural option (the real fix)
**One shared push channel per tab.** Extend the **existing watch WebSocket** so the server emits `board-changed` / `outcome-added` / `pending-changed` events (the stores know when they write). The client re-fetches (or applies a delta) **only on an event**, demoting the 5s board/outcomes/pending polls to a ~60s safety fallback. This removes ~95% of rail **requests and bytes**: ~8,100 req/hr -> a few hundred/hr/tab; ~170 MB/hr -> a few MB/hr/tab.

**Fit with FEAT-197:** FEAT-197's fan-out is about the **driving** socket (multi-client input arbitration + live session stream). This change channel rides the **watch** socket and carries project change events — no input arbitration, so it is smaller and independent. Both are "one multiplexed WS per tab"; build this change channel on the watch socket first, then FEAT-197's harder driving-socket fan-out can reuse the same transport.

### Build order
1. ETag/304 on board + outcomes + pending, and dedupe the double outcomes fetch (immediate ~95% byte cut, low risk).
2. Longer board interval + visibility-gate processes/summary.
3. Structural push channel on the watch socket (eliminates request **count** too); unify transport with FEAT-197 later.

## Evidence — DevTools vs the app's own cost

Part of the perceived lag is the **observer**, not the app. With the DevTools **Network** panel open (especially "Preserve log"), the browser **retains every request and response body** — at ~170 MB/hr of mostly-board JSON this grows memory unbounded and is a real CPU/memory sink that **vanishes when DevTools is closed**. Separately, the **app's own** cost is genuine: it `JSON.parse`s and re-renders the 166 KB board every 5s (720x/hr), identical bytes each time. Recommendation: reproduce the lag with **DevTools closed** to isolate the two; the repeated board parse/render is real app-side cost and the push channel (or 304, which also lets the client skip the re-render) fixes it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — fixing (round 1, quick wins; NO push channel)
Built the ticket's build-order steps 1 and 2 (ETag/304 + dedupe, then longer board
interval + visibility-gate); the structural push channel (ticket step 3) is NOT in scope.

**Server (`src/server/index.ts`).** New `sendJsonConditional(req,res,body)`: a strong ETag
(`"` + base64url(sha256(serialized body)) + `"`) + `Cache-Control: no-cache`; an
`If-None-Match` that matches returns a bodyless 304. Wired into the four hot polled
endpoints: `/api/projects/:id/board`, `/api/agent-outcomes`, `/api/lanes/pending`,
`/api/processes/summary`. ETag is computed on the UNCOMPRESSED JSON so it is stable
whether or not the body is gzipped on the wire.

**Client (`public/lib/api.js`).** New `conditionalGet`/`conditionalOptional`: remembers the
last ETag + parsed body per URL, sends `If-None-Match`, and on a 304 returns the remembered
body (`cache:'no-store'` keeps the browser's own cache out of the loop). This is EXPLICIT
because — measured on Chromium (google-chrome-stable + brave) — `fetch()` does NOT
auto-revalidate a `Cache-Control: no-cache` response: it stores only `max-age>0` and then
serves it stale without ever sending `If-None-Match`. So the dispatch's preferred
"let the browser revalidate automatically" path does not work here; the explicit layer does.
board/agentOutcomes/pendingLanes/processSummary now route through it.

**Client (`public/app.js`).** (a) `refreshOutcomes` wrapped in an in-flight coalescing guard
(`outcomesInFlight`) so the double agent-outcomes fetch per rail cycle (refreshRail's tail +
pollRail) collapses to ONE. (b) `pollRail` polls the board on its own `BOARD_POLL_MS`=20s
cadence (outcomes/pending stay on `RAIL_POLL_MS`=5s), cutting both board requests AND the
expensive 166 KB board re-render from every 5s to every 20s. (c) `refreshProcSummary`
returns early while `document.hidden`, and `visibilitychange` catches it up on return — the
one loop that previously ran in a hidden tab.

**Measured — one foreground tab, 10 min, scratch server, real docs/bugs board (166 KB) +
synthetic outcomes/pending ledgers (`scripts/verify-feat-202-poll-cost.mjs`, A/B lab):**
| endpoint | before req/hr · bytes/hr | after req/hr · bytes/hr · 304% |
|---|---|---|
| board | 678 · 38.76 MB | 186 · 0.38 MB · 97% |
| agent-outcomes | 1356 · 3.67 MB | 708 · 0.17 MB · 99% |
| lanes-pending | 672 · 0.68 MB | 702 · 0.16 MB · 99% |
| processes-summary | 240 · 0.05 MB | 240 · 0.05 MB · 98% |
| **TOTAL** | **2946 · 43.17 MB** | **1836 · 0.76 MB** |
Per-tab bytes/hr −98.2% (criterion was ≥90%); requests/hr −38% (outcomes deduped + board
cadence). Board ETag changed 0× in 600 s — evidence it moves slowly, which is what justifies
the 20 s cadence. (Measurement note: CDP ground truth — a 304 fires
`responseReceived`+`loadingFailed`, not `loadingFinished`, so `requestfinished`/`sizes()`
silently miss 304s; the harness counts on the Network domain.)

**Correctness (`scripts/verify-feat-202-correctness.mjs`, self-contained, 16/16):** all four
endpoints serve a strong ETag and a bodyless 304 on an unchanged body; a board change on disk
(a needsYou ticket's INDEX row) appears in the UI within one board interval via a full 200,
NOT a stale 304; a new agent outcome appears within one rail interval; processes/summary
stops polling while hidden and catches up on return.

**Anti-regression (suites touching these endpoints/rail):** `verify-rail-refresh` 10/10,
`verify-needs-you-rail` 19/19, `verify-feat-067-rail-summary` 23/23, `npm run gate` exit 0
(typecheck clean). `verify-agent-outcomes` (31/32, Part B session-startup timeout) and
`verify-processes` (2 fails) FAIL IDENTICALLY on a FEAT-202-reverted copy — confirmed
pre-existing/environmental, not this change.

**Touched `scripts/verify-rail-refresh.mjs` (BUG-016 regression test):** its board-grid
reconcile wait was `RAIL_POLL_MS+4s`=9 s, which the new 20 s board cadence outran (it passed
only by timing luck). Updated to wait one BOARD cycle (reads `window.__station.BOARD_POLL_MS`
if exposed, else a 20000 fallback) + slack. The BUG-016 live-mirror invariant (reconciles
without a manual reload) is preserved; only the timing bound moved from 5 s to 20 s.
`regressed-from:` none — this is a stale timing assumption my sanctioned cadence change
invalidated, not a masked defect.

**Concurrency:** index.ts/api.js/app.js all edited surgically (exact-string hunks) in regions
disjoint from BUG-278's app.js work (BUG-278's 25 hunks preserved; verified). The app.js edits
waited out BUG-278's FEAT-129 file lock rather than bypassing it.

**High-stakes note:** regression-prone (touches index.ts + app.js, files with history). An
independent clean-room verify (`scripts/independent-verify.mjs --ticket FEAT-202`, anthropic,
self-contained correctness run) was launched against the working-tree files; verdict recorded
separately.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run c880e5da-96fb-4f06-9604-5e2dc036bf61 — VERDICT: HOLDS — mixed-state candidate b8df00420c9d. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing (round 2, plan+review; PLAN ONLY, nothing built)
Designed the structural step (ticket step 3) and had it refuted cross-provider.
OpenAI dispatch was out of quota (`[quota-window]`, resets 1:37 PM) so the refutation
ran on a fresh-context Claude reviewer per the fallback. The review changed the design
materially — the push-first plan did NOT hold; the plan below is the revised one.

**Confirmed facts that drove the design (read-only, working tree):**
- The watch socket (`state.watchWs`, app.js ~11764) is page-lifetime, passive, open even
  with NO session open, reconnects with backoff [1,2,5,10,30]s, and already re-follows +
  re-reads the account fact on reconnect. The server already broadcasts to a Set of EVERY
  open socket (`accountFactSockets`, index.ts ~5862/5946, populated in `wss.on('connection')`
  ~6752) and BUG-278 keepalive (~6706, 15s ping / terminate-on-missed-pong) already defeats
  the tailscale/NAT idle-drop. So the carrier, audience, and keepalive all already exist.
- **All three in-process stores write temp+rename** (`writeAtomic`): outcomes.ts:177,
  decisions.ts:128, lanes.ts:506. **Board ticket `.md` are written by EXTERNAL processes**
  (board-tool.mjs, agents) — no in-process write hook (ARCH-010 exception: nobody in-process
  announces the board write).

**What the review refuted (grounded):**
1. *fs.watch on a file PATH goes deaf after the first atomic rename* — it follows the inode,
   and temp+rename swaps the inode. watcher.ts:301-303 documents this exact hazard and gets
   away with it only because session `.jsonl` are appended in place, never rename-replaced.
   Our stores are the opposite. "One fs.watch per backing FILE" ships a detector that works
   once then silently stops; with polling demoted to 60s, a deaf watcher = up to 60s of
   staleness masquerading as live. MUST watch the DIRECTORY, not the file.
2. *In-memory version counters reset to 0 on server restart* while a client holds a high
   version → V_client > V_server → client may never re-fetch. Needs a persisted BOOT
   generation prefix, exactly the `(boot, rev)` pattern BUG-255 already proves
   (`accountFactBoot`, index.ts ~5855).
3. *A 5s→60s safety-poll demotion is a real staleness REGRESSION* for a NAT'd client whose
   socket is silently half-open in both directions (the server's terminate close-frame can't
   traverse a dead middlebox either), and the plan did not flag it.
4. *Reconnect race*: a catch-up fetch can land between an external write and the version bump,
   read the pre-write ETag, mark itself current, and miss the bump broadcast while the socket
   was still mid-handshake (not yet in the audience Set). The current version must be
   CO-RETURNED with the fetched body, not fetch-then-assume-latest.
5. *A simpler alternative beats the push channel on risk/reward*: the bytes are already solved
   (round 1, -98%); the only thing left is request COUNT to a localhost/tailscale server,
   which is close to free. A single aggregate `GET /api/versions` collapses the 4 polls into
   1 tiny poll and is self-healing by construction — it has NONE of failure modes 1-4.

**REVISED FINAL PLAN — aggregate-version poll first; push channel only if measured to matter.**

- **Primary (land this):** `GET /api/versions` → a tiny ETag'd body
  `{ boot, board:{<projectId>:v}, outcomes:v, pending:v, proc:v }`. Versions are maintained
  server-side by ONE **directory-level** fs.watch per store dir (board dir per project;
  dataDir for outcomes/lanes/decisions), armed once, debounced ~300ms — robust across atomic
  rename because the DIR inode is stable. Belt-and-suspenders: also bump the counter in-process
  at the server-owned write chokepoints (outcomes.record/dismiss, decisions.raise/resolve,
  lanes persist) for zero-latency and as a backstop if fs.watch is flaky. `boot` is a persisted
  generation token (reuse the `accountFactBoot` pattern) so a restart can't strand a client.
  Client: ONE versions poll on a single ~5s timer (replaces the board/outcomes/pending/proc
  "did anything change" questions); on a changed counter, fire round-1's existing
  `conditionalGet` for ONLY that store → 304/200. Keeps today's 5s liveness (NO 60s regression),
  self-healing, reuses round 1 end-to-end. Detection cost O(projects) fs.watch + O(1) stat-free
  reads; per-poll cost one small request, not four.
- **Optional phase 2 (only if 20-tab request COUNT is shown to be a real problem):** push the
  same `{t:'versions-changed', boot, …}` frame over the watch socket to drop the 5s versions
  poll to a slow ~60s safety poll. If built, the review's mandatory fixes apply: watch
  directories not files; co-return the current version with every conditionalGet; prefix
  versions with the persisted boot generation; and FLAG the half-open-socket staleness floor.
  This is the per-tab broadcast channel FEAT-197's session fan-out later rides (same
  `accountFactSockets` Set + per-session seq + ring-buffer replay added on top) — one channel,
  not two.

**Expected reduction (on top of round 1's bytes):** ~1836 req/hr/tab → ~**800** (versions-poll
720/hr + occasional change-only fetches, mostly 304); ~2.3×, self-healing, near-zero new risk.
Phase 2 would reach ~300-400/hr/tab (~5×) but trades in a stateful bus with the 4 failure modes
above — justified only at scale (20 tabs: ~16k/hr vs ~7k/hr). Bytes stay at round-1 levels.

**Landable steps:**
1. Server: directory-level fs.watch per store dir maintaining boot-prefixed monotonic counters;
   in-process chokepoint bumps as backstop. Add `GET /api/versions` (ETag'd). Observe-only.
2. Client: replace the four independent change-polls with one `/api/versions` poll; on a changed
   counter call the existing `conditionalGet`-backed refresh for that store only.
3. Verify request-count cut + liveness (a real board edit / new outcome / new pending appears
   within one versions cycle) + restart safety (boot bump re-syncs the client).
4. OPTIONAL phase 2 push, gated on a measured 20-tab request-count problem, with the four
   mandatory fixes and FEAT-197 transport unification.

**Risk / high-stakes:** session-lifecycle-adjacent (touches the watch-socket path and the
server store readers) and regression-prone (index.ts + app.js both have history). An independent
clean-room verify pass is warranted when this is BUILT; this round is plan-only, nothing built,
no git writes.

**Review outcome:** REFUTED (push-first). Reviewer verdict: the version-plus-fetch push plan does
not hold as written (file-level fs.watch goes deaf on atomic renames; missing boot-generation
guard; unflagged 5s→60s staleness regression); recommended the `/api/versions` aggregate poll
instead. Revised plan above adopts that as the primary deliverable and demotes the push channel
to a measured, optional phase 2. Cross-provider note: OpenAI quota-exhausted, reviewed on fresh
Claude context instead.

### 2026-10-28 — fixing (round 2, build; aggregate /api/versions poll)
Built the revised plan's landable steps 1–2. Step-1 (SERVER) is landed on the working
tree and verified; step-2 (CLIENT) is complete and lab-verified but is NOT yet on the
working tree — `public/app.js` has been held by a sibling lane's edit lock
(`cs-mvrtp3kd-1`, the BUG-278 app.js work) for ~95 min and I did not bypass it (FEAT-129).

**Server (landed, unstaged):**
- NEW `src/server/store-versions.ts` — boot-prefixed counters per store, fed by TWO
  detectors into one counter: (1) DIRECTORY-level `fs.watch` per store dir (board dir per
  project; the dataDir for outcomes/lanes/decisions) — a directory watch, so it survives
  the temp+rename inode swap a file-level watch dies on (watcher.ts:301); (2) in-process
  bumps at the write chokepoints as a zero-latency backstop. Board is a COMPOSITE (needsYou
  merges tickets + lane cards + decisions), so lanes/decisions writes bump a global
  `boardEpoch` added into every project's board version — over-eager but safe (a stale board
  conditionalGet is a 304, never stale bytes).
- `src/server/index.ts` — `+import storeVersions`, `+GET /api/versions` (ETag'd via the
  round-1 `sendJsonConditional`; `boot` = persisted `accountFactBoot`; arms the dir/board
  watches lazily + idempotently per request so new projects are picked up).
- `src/server/outcomes.ts` / `decisions.ts` / `lanes.ts` — `bumpOutcomes/Decisions/Pending`
  at each store's single `writeAll` chokepoint (lanes also at the group-seal writer).

**Client (ready + lab-verified, NOT on working tree — lock):** `public/lib/api.js` landed
(`+export const versions = conditionalOptional('/api/versions')`). `public/app.js` edit is
ready: `pollRail` becomes a versions-driven cycle — one `/api/versions` poll per 5s;
`versionsRailCycle` refetches (round-1 `conditionalGet`) only a store whose counter moved; a
changed `boot` (restart) or first poll refetches everything; `legacyRailCycle` is the exact
round-1 poll-each path, used when `/api/versions` is 404 (older server) or on a transient
versions failure (so an outage never goes stale). `proc` stays on its own 15s poll
(deliberately NOT folded: it is not file-backed — PIDs come and go via external processes —
so no reliable change signal exists; folding it in would risk the staleness the round-2
review existed to avoid). The exact edit is preserved verbatim at
`~/.local/state/claude-station/scratch/feat202-r2lab-FHIhvv/public/app.js` and as a safe
two-replacement apply script `~/.local/state/claude-station/scratch/feat202-apply-app-js.mjs`
(string-replace, so it cannot clobber the sibling's other app.js edits; a raw diff would).

**Proof (all run; honest counts):**
- `scripts/verify-feat-202-round2.mjs` (server, real booted server + real docs/bugs board;
  synthetic outcomes(50)/lanes(18)) — **15/15**: /api/versions shape + strong ETag + bodyless
  304; dir watch catches TWO successive atomic renames (the inode hazard); in-process bump is
  a backstop AFTER the watcher errored (dir removed → missed event caught); per-store liveness
  (outcomes/pending/board) moves within 5s on an atomic-rename write; external board ticket
  edit moves the project's board counter; a server-owned write (dismiss) moves the counter via
  the in-process chokepoint; restart against the same data dir strictly bumps `boot`.
- `scripts/verify-feat-202-round2-poll-cost.mjs` (one scratch server; TWO real headless-Chromium
  foreground tabs — round2 reaches /api/versions, round1 has it 404'd so the SAME client falls
  to its round-1 legacy cycle; CDP Network ground truth; 10 min). **round1 1872 req/hr · 772 KB/hr
  → round2 1200 req/hr · 640 KB/hr** (−36% requests, −17% bytes). Per endpoint round1→round2 req/hr:
  outcomes 720→78, pending 714→72, board 186→78, proc 246→246 (own poll, unchanged), versions 6→726.
  LIVENESS: an on-disk atomic-rename write made the round2 tab issue a fresh 200
  agent-outcomes refetch **2103 ms** later (<5s). Client driven via the lab copy (working-tree
  app.js locked); said so.
- Anti-regression on the WORKING TREE (old client + new server): `verify-rail-refresh` 10/10,
  `verify-needs-you-rail` 19/19, `verify-feat-067-rail-summary` 23/23, `npm run gate` exit 0
  (leak-gate + typecheck clean).

**Contract check:** no stale UI beyond 5s for board/outcomes/pending (versions poll is 5s;
liveness 2103 ms); restart-safe (boot bump → refetch-all); fewer requests than round 1
(−36%); fallback present and exercised (versions 404 → legacy). Contract HOLDS in the lab;
needs the client edit landed to hold on the working tree.

**Status / decision for the orchestrator:** server half landed+verified; client half
ready+lab-verified but BLOCKED on the sibling `public/app.js` lock. Apply the app.js edit
(apply-script above) once the lock frees, then run the independent clean-room verify on the
complete working tree. High-stakes (session-lifecycle-adjacent + index.ts/app.js history):
an independent clean-room pass is warranted once app.js lands — not recorded as a verdict
here because the working tree is incomplete.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 5b838160-9f9b-46b3-b77d-5844626a474e — VERDICT: BROKEN — mixed-state candidate faad022df9b8. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing (round 3, fix; watchers are hints, not truth)
Addresses the round-2 BROKEN verdict (anthropic 5b838160): on Linux, removing a
watched directory emits NO error event, so the directory-level `fs.watch` went
silently deaf, stayed in the Map, and a re-arm was a no-op — after a board-dir
remove+recreate, external ticket writes never moved the counter and the board
went stale forever. Watcher liveness is a timing, not a shape, so it could not be
made correct across every filesystem event.

**Server (`src/server/store-versions.ts`, full rewrite — was untracked round-2).**
Each store's version is now derived ON DEMAND from a cheap STAT FINGERPRINT, with
NO watchers: the board dir's own (mtimeNs, ino) plus every entry's (name, mtimeNs,
size, ino) hashed, and each dataDir store file's (mtimeNs, size, ino). A recreated
dir (new ino), an atomic temp+rename (new ino), an external editor (new mtime/size)
all move the fingerprint by construction — there is no watcher state left to go
deaf. The per-dir scan is cached ~1s and shared across tabs, so N tabs polling
within one second cost ONE scan. The board fingerprint folds in lanes+decisions
(its needsYou composite inputs). In-process bumps (outcomes/pending/decisions) are
KEPT, folded into the fingerprint and read live (not cached) as a zero-latency
accelerator — but correctness does not depend on them; a chokepoint-bypassing write
still moves the fingerprint via its stat change. `boot` (accountFactBoot, BUG-255)
still prefixes the body for restart safety.

**Server (`src/server/index.ts`).** The `GET /api/versions` handler no longer arms
any watcher; it calls `storeVersions.snapshot(dataDir(), boards)` with each project's
board dir. Shape unchanged except per-store values are now opaque fingerprint
STRINGS (client only compares `!==`).

**Client (`public/app.js`).** LOST-UPDATE FIX: `versionsRailCycle` now advances its
remembered per-store fingerprint ONLY after that store's refetch succeeds; a
transient refetch failure leaves the old fingerprint so the next cycle retries
(round 2 set `lastVersions = v` up front, stranding a store whose refetch failed
until the NEXT server change). `refreshRail`/`refreshOutcomes`/`refreshPending` now
return a success boolean for this. `public/lib/api.js` comment updated to round 3.

**Scan-cost measurement (real board dir, 507 entries; real dataDir):** board-dir
scan mean **1.40 ms** over 200 iters; dataDir 4-file stat mean **0.008 ms**. Cached
~1s, so 20 tabs cost one 1.4 ms scan/sec, not twenty. Confirmed live: 20 concurrent
`/api/versions` requests returned one coherent fingerprint in **12 ms** total.

**Proof (all run; honest counts; real output one-liners):**
- MUST-FAIL `scripts/verify-feat-202-round3-mustfail.mjs` — PROVED: round-2 watcher
  STUCK (armed=1, beforeExt=2, afterExt=2) after dir remove+recreate+write; round-3
  fingerprint MOVES (base→afterRecreate→afterWrite all distinct). Fixture:
  `scripts/fixtures/feat-202/old-store-versions.mjs` (frozen round-2 module).
- `scripts/verify-feat-202-round3.mjs` — **20/20**: module attack matrix (remove+
  recreate+external-write; rename away/back; mtime-pinned size change; same
  mtime+size different inode; in-process accelerator; ~1s cache holds within the
  window then refreshes) + real booted server (shape+ETag+304; the remove+recreate
  regression over HTTP moves within 5s incl. a SECOND write; atomic rename; dismiss
  chokepoint; 20-tab coherent+cheap; restart boot bump).
- `scripts/verify-feat-202-round2.mjs` (rewritten to the fingerprint model) —
  **16/16**: module + HTTP shape/ETag/304 + per-store liveness within 5s + restart.
- `scripts/verify-feat-202-round3-client.mjs` (REAL headless Chromium + real server)
  — **3/3**: with /api/agent-outcomes failing the new outcome is NOT shown
  (failure exercised); after recovery WITHOUT a further ledger write it appears (no
  stranded counter — the lost-update fix); with /api/versions failing the rail
  falls back and still surfaces the outcome.
- `scripts/verify-feat-202-correctness.mjs` (anti-regression, real browser) —
  **16/16**; board change now fresh in ~4 s (one versions cycle), outcome in 5.2 s,
  proc-gate holds.
- `scripts/verify-feat-202-round2-poll-cost.mjs` (A/B, 60 s window, real browser):
  versions-driven **1740 req/hr** vs round-1 fallback **2280 req/hr** — FEWER
  requests than round 1; liveness refetch 2205 ms (<5s).
- Anti-regression: `verify-rail-refresh` 10/10, `verify-needs-you-rail` 19/19,
  `verify-feat-067-rail-summary` 23/23, `verify-bug-070-outcomes-rail` 22/22,
  `npm run gate` exit 0 (leak-gate + typecheck clean).
- `verify-arch-017-rail` FAILS at "second server never became healthy" — the test
  intentionally overlaps TWO servers on ONE data dir, which the committed
  single-server data-dir lock (index.ts:8115, landed in e79aada) now refuses after
  30s. Emitted at startup, before any request handler; my only index.ts edit is
  inside the `/api/versions` handler, so this failure is independent of FEAT-202
  (pre-existing test/feature clash), not a regression of this change.

**Contract:** no store stale beyond 5s under any filesystem event incl. dir
remove+recreate (proved over HTTP within 5s; cache ≤1s + 5s poll); restart-safe
(boot bump); fallback present+exercised; fewer requests than round 1 (−24%).

**Concurrency:** `public/app.js` edited surgically (exact-string hunks) after
waiting out the sibling lane's FEAT-129 lock; no whole-file write/reset.
`regressed-from: FEAT-202 round 2` (the watcher design this replaces).

**High-stakes:** regression-prone (index.ts + app.js history). An independent
clean-room verify (`scripts/independent-verify.mjs --working-tree`, anthropic) was
launched against the working-tree files; verdict recorded separately in verification[].

### 2026-10-28 — fixing (round 3 addendum; composite-board staleness, from the independent verify)
The first round-3 independent clean-room verify (anthropic, `--working-tree`)
returned BROKEN with a REAL, previously-unseen finding: the board card is a
COMPOSITE whose needsYou/observations merge more inputs than the first fingerprint
stated. It demonstrated three stale-forever cases (all file-backed):
`docs/bugs/.arch/findings.json` and `.arch/acks.json` (a SUBDIRECTORY, rewritten
IN PLACE — a Linux dir's own mtime does not move on an existing entry's content
change, and the scan was non-recursive), and `dataDir/access-requests.json` (the
FEAT-200 access card, not in the stat set). It also named, untested, the
server-DERIVED inputs with no backing file: the base-update notice, grant-rebuild
rail items, and the pilot-only ref-ledger alarm. NOTE: this gap is not specific to
the fingerprint design — round-2's per-dir `fs.watch` was also non-recursive and
watched neither access-requests nor the derived state, and gating the board
refetch on ANY change signal (watcher or fingerprint) requires that signal to
cover every board input.

**Fix (`src/server/store-versions.ts`, `index.ts`, `public/app.js`):**
- The board-dir stat scan is now RECURSIVE (`walk`), so an in-place rewrite of
  `.arch/findings.json` / `.arch/acks.json` moves the fingerprint by the file's own
  (mtimeNs, size, ino).
- `access-requests.json` is folded into the board fingerprint (added to the dataDir
  store set); the methodology `needs-human.json` + `needs-human-acks.json` are folded
  in too (`snapshot(dataDir, boards, methodologyDir)`, wired to `methodologyDir()`).
- For the server-DERIVED inputs that no stat fingerprint can observe (base notice,
  grant-rebuild, ref-ledger alarm — all produced in-process, no stable file; some on
  internal timers), the client keeps a slow **BOARD_POLL_MS (20s) board safety
  refresh** in the versions path as a backstop, so they are never stale with no time
  limit. It is cheap: round 1's conditionalGet makes each idle backstop poll a
  bodyless 304 unless the board truly changed. File-backed inputs stay ≤5s via the
  fingerprint; derived inputs are bounded to ≤20s (vs round-1's own 20s board poll —
  no worse — and no longer stale-forever). `bumpBoard()` (bumped by lanes/decisions)
  is folded into the fingerprint as a zero-latency accelerator.

**Proof (re-run; honest counts):**
- `scripts/verify-feat-202-round3.mjs` — **24/24** (added the verifier's exact attacks:
  in-place `.arch/findings.json` + `.arch/acks.json`, `access-requests.json`,
  methodology `needs-human.json` all move the board fp; Part B now synthesizes a
  realistic 120-ticket board when the real docs/bugs is unavailable, e.g. the clean
  room, said so).
- `scripts/verify-feat-202-round3-client.mjs` — **5/5** (added: the board is refetched
  on the 20s backstop while idle, as a cheap 304 — the derived-input safety net).
- Re-run green: round3-mustfail PROVED; round2 16/16; correctness 16/16;
  rail-refresh 10/10; needs-you-rail 19/19; bug-070-outcomes-rail 22/22;
  feat-067-rail-summary 23/23; `npm run gate` exit 0.
- A second independent clean-room verify was launched on the fixed working tree;
  verdict recorded in verification[].

**Residual (flagged for the orchestrator):** the ≤20s board backstop bounds the
server-derived inputs; it is not ≤5s for those (they have no observable signal). If
sub-5s latency for the base notice / grant-rebuild / ledger alarm is required, the
follow-up is to bump `bumpBoard()` at each of their in-process mutation points
(grant-rebuild is DI'd and self-ticking, so this needs an injected onChange, not a
call-site bump) — deferred as higher-risk than the 20s backstop and out of this
round's demonstrated scope.

### 2026-10-28 — fixing (round 3 addendum 2; ctimeNs + project-switch, from the 2nd independent verify)
The second independent clean-room verify returned BROKEN with two more real
findings (both now fixed and regression-tested):

1. **ctimeNs omitted from the fingerprint** (`src/server/store-versions.ts` `fileFp`).
   A same-size, same-inode content rewrite with the mtime RESTORED (cp -p, rsync -t
   --inplace, tar -x, touch -r, or a coarse-clock collision) left (mtimeNs, size,
   ino) unchanged, so the fingerprint never moved — stale indefinitely. FIX: fold
   `ctimeNs` into `fileFp` (and the dir stat). ctime cannot be set from user space,
   so it is the one field such a write cannot hide behind; over-sensitive at worst
   (a chmod moves it), which is just a 304. Proof: round3 (4b) — a chmod (changes
   ONLY ctime) moves the fp, and a same-size rewrite with mtimeNs restored to the
   exact prior value + same ino still moves it.

2. **Project-switch leaves the prior project's held lanes on the rail**
   (`public/app.js` `versionsRailCycle`). `/api/lanes/pending` and `/api/agent-outcomes`
   are project-scoped VIEWS, but their fingerprints are GLOBAL (one lanes.json /
   one ledger). Switching A→B without any lanes write never moved the `pending`
   fingerprint, so B kept showing A's held lanes (round 1 polled pending every 5s —
   a regression). FIX: the remembered snapshot is now keyed by project
   (`lastVersions.pid === pid` in the `prev` guard); a pid change forces a refetch
   of board + outcomes + pending for the project just opened. Proof: round3-client —
   on A the rail shows A's held lane; after `selectProject(B)` with NO lanes write it
   shows B's lane within ~5s and A's is gone.

**Proof (re-run; honest counts):** round3 **26/26** (adds the chmod/ctime and
same-size-rewrite cases); round3-client **7/7** (adds the project-switch case + the
idle board backstop); round3-mustfail PROVED; round2 16/16; correctness 16/16;
rail-refresh 10/10; needs-you-rail 19/19; bug-070-outcomes-rail 22/22; `npm run gate`
exit 0. A third independent clean-room verify was launched on the fully-fixed tree;
verdict recorded in verification[].

### 2026-10-28 — fixing (round 3 addendum 3; outcomes coalescing race, from the 3rd independent verify)
The third independent clean-room verify returned BROKEN with one more real race
(now fixed + regression-tested): `refreshOutcomes` coalesces concurrent callers
onto a single in-flight fetch (`if (outcomesInFlight) return outcomesInFlight`,
the round-1 double-fetch dedupe). If that in-flight fetch was started by an
EARLIER trigger — a `focus`/`visibilitychange`/access-card `refreshRail` tail —
BEFORE the versions snapshot was read, it may carry pre-snapshot bytes; yet
`versionsRailCycle` would see the join resolve `true` and commit the NEWER
outcomes fingerprint against those older bytes, stranding the store (verifier
observed ~50s, indefinite in principle; outcomes has no board-style backstop).

**Fix (`public/app.js`):** track `outcomesAppliedAt` — the client-clock time the
fetch whose bytes are CURRENTLY in `state.outcomes` STARTED — set inside
`refreshOutcomes` (and on the caps-absent path). `versionsRailCycle` captures
`vReadAt` when it reads the snapshot and commits the outcomes fingerprint only
when `outcomesAppliedAt >= vReadAt`. A within-cycle coalesce (the `refreshRail(true)`
tail started AFTER vReadAt) still commits; a pre-snapshot join (started before
vReadAt) does not → it retries next cycle, which starts a fresh fetch and commits.
Pending and board have no analogous hole: `refreshPending` does not coalesce (each
call fetches fresh), and `refreshRail`'s `boardBusy` guard already returns false
(uncommitted) when another board fetch is in flight.

**Proof:** `scripts/verify-feat-202-round3-client.mjs` — **8/8**, adding a REAL
browser repro: a `focus`-started outcomes fetch is HELD and answered with the
pre-append ledger; a new death is appended while it is held; a versions cycle
JOINs the held fetch; on release the stale bytes do NOT strand the new death — a
later cycle fetches fresh and surfaces it. (Under the pre-fix commit it would be
stranded: the fingerprint committed, no further write, never refetched.)
Discriminating by construction. gate exit 0; round3 26/26; all prior suites green.
A fourth independent clean-room verify was launched; verdict in verification[].

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 1bd5aa13-a368-45f2-b604-3aaf57084a67 — VERDICT: HOLDS — round-3 fingerprint fix on the working tree; 27/27 fixer + 3 adversarial (same-size-rewrite-x30, fs-attacks-1s-cache, client-railcycle) all pass. Typed entry in the record's verification[]; this line is an echo, not proof.
