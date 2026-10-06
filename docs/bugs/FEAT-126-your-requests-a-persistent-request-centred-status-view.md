# FEAT-126 — "Your requests": a persistent, request-centred status view

- **Status:** OPEN (priority — data-loss) — round-3/4 fixes CONFIRMED to hold (run 2cfc221a); the round-5 wrong-shape fix's declared cases + 2 of 3 not-enumerated variants CONFIRMED to hold (clean-room verify 2026-09-30, run 8e8e3761, VERDICT BROKEN VALID), BUT THREE NEW data-loss/integrity defects remain in `src/server/requests.ts`: (1) quarantine renames onto `<file>.corrupt-<ms>` with no existence check → a same-name pre-existing quarantine file is silently overwritten; (2) two quarantines in the same millisecond destroy the first corrupt evidence; (3) the 4 MB guard is stat-then-unbounded-read (TOCTOU) → a file that grows past 4 MB between stat and read is fully read/parsed, bypassing the guard. NOT VERIFIED; handoff in the latest Activity-log entry. Finding 3b (`board.ts` `doneIds`) still open/off-limits. — design approved by the user; this ticket is the build spec. plan+review round 1 (finding). No product code written this round. Recommended path: the request↔work binding is a DECLARED fact owned by the orchestrator (Dispatch `request=` key + an `orchard-request` block), never derived from chat; the surface holds only that binding and JOINS every status live from the board / liveness / outcomes so it cannot go stale.
- **Severity:** high (this is the dominant defect an independent OpenAI review found in the session: the absence of a persistent state surface separate from the chat stream)
- **Area:** Web UI — the right-hand rail (`public/app.js` renderRail / renderRailSummary, `public/styles.css`) · server store (new `requests.ts`, `src/server/index.ts` board endpoint) · dispatch grammar (`scripts/lib/cost-model.mjs`) · injected declaration surface (`docs/prompts/RESPONSE_FORMAT.md`)
- **Reported:** 2026-09-05 by user (via an independent OpenAI review of this session)
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED. This round is design only; each build step below carries its own class and proof bar.

## Symptom
The user cannot answer "what happened to each thing I asked for" without scrolling
back through the chat stream. State is narrated turn-by-turn and then lost: the
digest rail is ephemeral by design (`public/lib/digest.js:24-27` — "Ephemeral by
design … does not accumulate a cross-turn digest"), the Needs-You rail shows only
open blockers, and the board is per-project ticket rows with no notion of the
user request that spawned them. The independent review's verdict: the dominant
defect is the **absence of a persistent state surface separate from the chat
stream**; verbosity is secondary and shorter replies already failed to fix it
(FEAT-125 shipped brevity and the problem remained). The single most damaging
confusion is that **"0 lanes running" reads as "everything is done"** — execution
being idle looks identical to the work being complete.

## Expected
A persistent surface whose unit is the USER REQUEST. Tickets and lanes nest under
a request. Each request row shows: the request → its latest outcome → verification
status → running work → next step / owner → a link back to its source message.
EXECUTION status is visually distinct from COMPLETION status — "0 lanes running"
can never render as "done". Real blockers reuse the existing Needs-You rail (no
second rail). Routine lane chatter lives in an expandable history, not the main
surface. Explicitly out of scope (the review rejected these): more chat messages,
a conversation-per-lane, another unmaintained summary rail, hard truncation, a
broad redesign.

## The hard design question — what a "request" IS, and how work binds to it

**Answer, applying ARCH-010 (docs/CONVENTIONS.md:7-51 — "whoever owns a fact writes
it down once; no reader works it out again").**

A request boundary is a fact a reader (this view) must act on. Who OWNS it? Only
the actor that knows, at the moment it is true, that a new thing is being asked and
what it is — and that is the **orchestrator**, when it reads the user's message and
decides to act on it. The server sees frames (turn boundaries, agent starts,
deaths) but not intent: it cannot tell whether message N opens a new request or
refines request N−1. The user's raw chat is not a reliable declaration either — one
message can open several requests; several messages can refine one.

Therefore **deriving request boundaries heuristically from chat is exactly what
ARCH-010 rejects**: a reader reconstructing a fact its owner never wrote down. It
fails the rule's own decision procedure — it "leaves a second place able to hold a
different answer" (the heuristic's guess vs. what the user meant), and it "patches
each surface as someone finds it" as the heuristic is tuned. Rejected.

**The request is DECLARED by the orchestrator, exactly as the `Dispatch:` line
declares a lane's ticket** (CONVENTIONS.md:53-93 names FEAT-100 as an ARCH-010
worked example; the parser is `parseDispatchDeclaration`, `scripts/lib/cost-model.mjs:603`,
grammar `DISPATCH_DECL_KEYS` at :509). Two declaration surfaces, one owner, each a
place the orchestrator is already writing:

1. **Lane→request binding: an optional `request=REQ-N` key on the `Dispatch:` line.**
   Add `request` to `DISPATCH_DECL_KEYS` and validate it like `ticket=`
   (cost-model.mjs:553). The orchestrator already writes the charter; this adds one
   token. A lane whose charter carries `ticket=FEAT-126 request=REQ-7` binds that
   run AND (via the ticket id already there) that ticket to REQ-7. Omitted ⇒ the
   field is null and the lane is "undeclared" — a gap, not a guess (the FEAT-100
   principle, cost-model.mjs:493-495: "A gap is a fact. A guess is not.").

2. **Request identity (title + source message): a leading `orchard-request` block
   in the orchestrator's own turn**, parallel to `orchard-digest`
   (`docs/prompts/RESPONSE_FORMAT.md` injected core; parser shape reusable from
   `public/lib/digest.js`). JSON: `{ "id": "REQ-7", "title": "…", "source":
   "<user-message-uuid>", "tickets": ["FEAT-126"] }`. Emitted once when the request
   opens, updatable latest-wins per id (like a ticket status line). This is the
   orchestrator writing the identity fact once, in a place it is already composing.

**The keystone (this is what makes the surface trustworthy):** the request store
owns ONLY the binding + title + source link. It stores **no status of its own**.
Every status cell is JOINED LIVE at render from the fact's existing owner:

| Row fact | Owner it is read from (never copied) |
|---|---|
| running work (execution) | the running-set snapshot — `RunningEntry` (`src/server/running-set.ts:54`), `state.snap.running` in the client, pushed via the `running-snapshot` socket event and `GET /api/sessions/:id/running` (`src/server/index.ts:2040`) |
| a lane that died | the agent-outcomes ledger — `AgentOutcome` (`src/server/outcomes.ts:71`), `GET /api/agent-outcomes` (`index.ts:1996`), client `state.outcomes` |
| completion / verification | the board — `BoardItem.status` / `owner` / `verification` (`src/server/board.ts:29`), `readBoard` (`board.ts:648`), `GET /api/projects/:id/board` (`index.ts:1051`) |
| next step / owner (you vs lane vs queued) | the ticket owner cell 👤/🤖/— on the board + the latest Activity-log handoff |

Because the request holds no status, it **cannot disagree with the board — it IS
the board, liveness and outcomes, grouped by the declared request key.** That is
both the ARCH-010 answer and the anti-staleness guarantee (see Risks).

## Where the view lives, and what it looks like

**Placement: the right-hand rail** (`<aside id="rail">`, `public/index.html:448`;
`renderRail()` `public/app.js:5401`). The rail is already the per-session
persistent surface beside the chat, already carries both live state
(`state.snap.running`) and board state, and already hosts the Needs-You cards the
review told us to reuse. "Your requests" becomes the rail's primary top section —
it is the evolution of the existing `renderRailSummary()` counts strip
(`app.js:5480`), which today shows aggregate counts with no request grouping.
Requests render ABOVE `#railNeeds`, which is reused unchanged for real blockers.

**Row shape** (reuse the established `.dg-item` / `.needs-card` card idiom,
`styles.css:3353` / `:2827`; no new card primitive):
- **Title** — the declared request title (visible, primary).
- **Execution channel** — a live badge from the running snapshot, reusing the
  strip's `.lag` states + the `--live` moss token: `▶ N running` (moss, in motion) /
  `idle` (muted) / `stalled` (from `RunningEntry.stall`). This channel is driven by
  lane COUNT only.
- **Completion channel** — a SEPARATE badge from the request's tickets' board
  statuses, reusing `--st-done` / `--st-needs` / `--st-prog`: `open` · `N/M
  verified` · `done`. Driven by ticket STATUS only.
- The two channels are rendered as **two distinct visual elements from two
  independent reads** — this is the structural guarantee that idle ≠ done: a
  request with 0 running lanes and any open/unverified ticket shows `idle · open`,
  never `done`. `done` requires every ticket VERIFIED/DONE, regardless of lane
  count.
- **Next step / owner** — from the tickets' owner cells; a 👤 ticket routes into
  the existing Needs-You card below (reuse), not a new control.
- **Source link** — a deep link back to the user message (`source` uuid → the
  transcript anchor; user prompts are recorded as `type:'user'` entries,
  `orchard-transcripts.ts:181`).
- **Collapsed by default** — per-lane chatter via the existing read-only subagent
  thread view (`app.js:4726`, `sessionSubagents`) behind an expander. Routine
  detail never occupies the main surface.

**Degradation (must be graceful, per the WA "busy/mixed-state" testing rule):**
- request with tickets not yet filed → title + execution badge + "no tickets yet".
- request referencing a ticket the board no longer has → "referenced ticket
  missing" (honest), never a fabricated status.
- session with NO declared requests → the existing rail summary renders unchanged
  (purely additive; the surface is never emptier than today's rail).

## Per-session or per-project, and where it persists

**Per SESSION.** "Your requests" answers a per-conversation question ("what happened
to the things I asked in this session"), and the `source` message lives in the
session transcript. Keyed by `stationSessionId` (the same key `AgentOutcome` and
`DecisionRecord` already carry).

**Persistence: a new server-owned store `dataDir()/requests.json`**, modelled
exactly on `src/server/decisions.ts` (`decisions.ts:77-93`) and `outcomes.ts`
(`outcomes.ts:123-140`): single writer, `writeAtomic` (temp+fsync+rename, so a
crash mid-write never truncates it), bounded, many-read, survives reload / server
restart / context compaction (`decisions.ts:10-17`). The tickets and lanes it
references are project/global and are joined live — only the binding is stored.
**Single writer = the SERVER**, which upserts a request record when it observes the
orchestrator's `orchard-request` declaration in the assistant frames it already
receives (the outcomes.ts precedent: "written by the server from frames it already
receives", `outcomes.ts:6-10`; the frame path is `AgentSession`, `agent-bridge.ts:479`).
No second writer, ever — a cached status on the request would recreate the
"unmaintained summary rail" the review rejected.

## Build plan (landable steps, highest value first; each independently shippable)

**Step 1 — the declared binding + the server store (data plumbing; class=fix; headless).**
Add `request` to the Dispatch grammar (`cost-model.mjs:509` + validation at :553,
round-tripped through `formatDispatchDeclaration` at :670). Define the
`orchard-request` block grammar (reuse the digest fence machinery). Create
`src/server/requests.ts` (the decisions.ts/outcomes.ts shape) keyed by
stationSessionId. Wire the server frame-observer that upserts on an `orchard-request`
declaration (confirm the exact hook in `AgentSession`'s assistant-frame handling).
Verify: parser tests for `request=` incl. the two-declarations-conflict and
in-fence-ignored strictnesses; store round-trip; **partial/truncated read tests**
(the store is written while read — WA rule). No UI. This lands the OWNED FACT.

**Step 2 — "Your requests" in the rail, with the execution≠completion invariant
(class=fix; VISUAL verification required — Playwright headless).** New rail top
section joining request → tickets(board) → lanes(running snapshot) → deaths(outcomes),
rendering the two-channel row. This is the highest USER value: it is the persistent
state surface the review asked for. Reuse `.dg-item`/`.needs-card`, `.lag`/`--live`,
`.st-*`. Visual-verify against a BUSY fixture (many requests, mixed
running/idle/died/verified) in light and dark — the invariant must hold under load
and read as a hierarchy, not a wall.

**Step 3 — real blockers route through the existing Needs-You rail (class=fix).**
A request with a 👤 ticket surfaces its Decide card in `#railNeeds` below the
request row (reuse `reconcileNeeds`, `app.js:5634`; no second rail). Next-step/owner
on the row links to it.

**Step 4 — source deep-link + collapsed lane history (class=fix; visual).** Row →
source user message; per-lane chatter behind the existing subagent-thread expander.

**Step 5 — make the declaration cheap and defaulted (class=docs-only).** Add the
`orchard-request` open-a-request instruction to the injected RESPONSE_FORMAT core
so every session emits it by default (same surface as the digest), keeping the
byte-budget discipline (`RESPONSE_FORMAT.md` inject markers; the size budget note
there). Adoption depends on this — see Risks.

## The proof bar (what must be true to call this right; and the falsifiers)

- A request with 0 running lanes and ≥1 open/unverified ticket renders visibly
  NOT-done. **Falsifier:** any state where "0 running" is worded or styled as done.
- Every status cell on a request row equals the board/liveness/outcomes it joins.
  **Falsifier:** the request view shows a ticket open that the board shows VERIFIED
  (or the reverse). Test: mutate a ticket's board status, re-read, assert the row
  moved with it — the view has no independent copy to disagree from.
- A request the orchestrator never declared does not appear. **Falsifier:** a
  request row invented from chat text / heuristics.
- Request membership is read from the declared binding, never re-derived.
  **Falsifier:** any code path inferring membership from message prose.
- Survives reload + session switch + server restart. **Falsifier:** requests vanish
  on reload (they must be server-owned, like decisions.json).
- Under a realistic busy session (dozens of requests, mixed states) the surface
  reads as a hierarchy and the invariant holds. **Falsifier:** it only works on a
  minimal 1–2 request fixture (the WA sidebar-cap lesson).

## Risks — above all, staleness / disagreement with the board

1. **The surface goes stale or disagrees with the board — the failure that makes it
   worse than nothing.** MITIGATED STRUCTURALLY: the store owns only the
   binding+title+source and holds NO status; every status is joined live from its
   owner. It cannot disagree with the board because it renders the board. HARD RULE
   for the build: never cache a status on a request record — that single shortcut
   recreates the rejected unmaintained rail. Residual: a stale BINDING (ticket
   renamed/closed) — handled by joining on live id and showing "missing" honestly.
2. **Adoption depends on the orchestrator DECLARING requests** — prose-injection
   discipline, the exact "a discipline that lives only as prose is not held" class
   that bit FEAT-096 / FEAT-100 / FEAT-108 / ARCH-016. If the orchestrator forgets,
   the surface is partial. Mitigations: make the declaration a default injected
   instruction (Step 5), as cheap as the digest; and design the surface so an
   UNDECLARED session degrades to today's rail summary, never emptier. This is the
   single biggest risk to the feature's value — named, not hidden.
3. **Two-writer hazard on the store.** Only the server writes `requests.json`;
   concurrent sessions write their own session-keyed entries; reads must tolerate a
   partially-written file (Step 1 truncation tests).
4. **Reintroducing a second rail / a second decision surface.** Forbidden by the
   origin review; the design reuses `#railNeeds` and `decisions.json` rather than
   inventing either.
5. **Per-session store vs per-project board.** No conflict: the request is
   session-keyed, the tickets it joins are project/global and joined by id.

## Context pack (grows — where to look, so no agent cold-starts)
- Surfaces to REUSE (do not duplicate): rail `renderRail` `public/app.js:5401`,
  `renderRailSummary` `app.js:5480`, Needs-You `reconcileNeeds` `app.js:5634` /
  `public/lib/decide.js:171`; digest (ephemeral, the thing this is NOT)
  `public/lib/digest.js:24-27`; running snapshot `src/server/running-set.ts:54`,
  `GET /api/sessions/:id/running` `src/server/index.ts:2040`; outcomes
  `src/server/outcomes.ts:71`; board `src/server/board.ts:29` / `:648`,
  `GET /api/projects/:id/board` `index.ts:1051`.
- Binding mechanism: `scripts/lib/cost-model.mjs:503-644` (`DISPATCH_DECL_KEYS`,
  `parseDispatchDeclaration`, `formatDispatchDeclaration`); `scripts/cost-collect.mjs:286-347`
  (`buildLane` — how a lane already carries its declared ticket + parent linkage).
- Persistence precedents: `src/server/decisions.ts:1-93`, `src/server/outcomes.ts:1-140`
  (server-owned, atomic, survives restart, single-writer). Store dir `dataDir()`.
- Declaration surface for Step 5: `docs/prompts/RESPONSE_FORMAT.md` inject markers,
  `src/server/templates.ts#responseFormatSection`.
- Transcript / source-message model: `orchard-transcripts.ts:181` (recordUserPrompt),
  `parentUuid` chains, no existing request grouping (confirmed: `requestId` in the
  code is the permission-prompt correlation id, `agent-bridge.ts:1754`, unrelated).
- ARCH-010 rule: `docs/CONVENTIONS.md:7-51`; FEAT-100 dispatch precedent `:53-93`.
- CSS tokens: `public/styles.css` `:root` 10-53 — `--live` (running moss),
  `--st-done` / `--st-needs` / `--st-prog` / `--st-high`, ink ramp `--ink`..`--ink-4`,
  surfaces `--rail`/`--window`/`--sunken`; card idioms `.needs-card` (2827) /
  `.dg-item` (3353); counts chips `.rs-chip` (2990) / `.dg-chip` (3296); live rows
  `.lag` (912).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-05 — plan+review lane (finding, round 1)
- **Understood:** the user pre-approved building a persistent, request-centred
  status view. Charter: answer the hard binding question under ARCH-010 first, then
  survey what to reuse, then a landable build plan. Build no product code this round.
- **Surveyed (two parallel read-only lanes) the surfaces to reuse** — the rail /
  Needs-You / rail-summary, the ephemeral digest, the live running snapshot,
  agent-outcomes, the board reader + endpoint, the Dispatch grammar, the
  transcript model, and every server-side persisted store. Citations folded into
  the Context pack above. Confirmed there is NO existing "user request" concept and
  that `requestId` in the code is the permission-prompt correlation id (unrelated).
- **Decided the binding under ARCH-010:** the orchestrator DECLARES the request
  (Dispatch `request=` key + an `orchard-request` block); a chat heuristic is
  rejected by name as the ARCH-010 anti-pattern. The store holds only the
  binding+title+source; every status is joined live from its existing owner, which
  is both the ARCH-010 answer and the anti-staleness guarantee.
- **Chose per-session persistence** in a server-owned `requests.json` on the
  decisions.ts/outcomes.ts pattern (atomic, survives restart, single writer).
- **Delivered** the row shape, rail placement, the execution≠completion structural
  guarantee (two independent reads → two channels), the 5-step build plan (highest
  value = Step 2, the rail surface; Steps 2 and 4 need visual verification), the
  proof bar with falsifiers, and the risk set led by staleness.
- **No code changed.** Design only; the user pre-authorized the build, so this is a
  build ticket, not a decision parked on a human.
- **Skeptic flag / high-stakes:** Step 1 touches the Dispatch grammar and a new
  concurrently-written store, and the whole feature is session-lifecycle
  presentation reading three concurrently-written sources (liveness, outcomes,
  board) — warrants independent clean-room verify per step, against a realistic
  busy-state fixture, before VERIFIED. The biggest open risk is adoption
  (declaration is prose-injection discipline) — named in Risks, mitigated by Step 5.
- **Handoff:** build Step 1 (owned fact) → Step 2 (the surface + invariant, visual)
  → Step 3 (reuse Needs-You) → Step 4 (source link + collapsed history, visual) →
  Step 5 (default the declaration). Confirm the exact `AgentSession` assistant-frame
  hook before wiring the server observer in Step 1.

### 2026-09-05 — build lane, Steps 1 + 2 (class=fix, round 1)

Built the DECLARED binding + server store (Step 1) and the "Your requests" rail
surface with the execution≠completion invariant (Step 2). Steps 3–5 untouched.

- **Step 1 — the owned fact.** Added `request` to the Dispatch grammar
  (`DISPATCH_DECL_KEYS`, validation `REQUEST_ID_ONE = /^REQ-\d+$/`,
  `formatDispatchDeclaration` round-trip) in `scripts/lib/cost-model.mjs`; it
  inherits the existing two strictnesses (a quoted line in a fence declares
  nothing; two disagreeing declarations yield a gap, not a guess). New
  server-owned store `src/server/requests.ts` on the decisions.ts/outcomes.ts
  pattern — `writeAtomic`, tolerant read, keyed by `stationSessionId`. THE
  KEYSTONE HELD: the record holds ONLY `{id,title,source,tickets,projectId,
  createdAt,updatedAt}` and NO status field (a test asserts the exact key set and
  the absence of status/exec/completion/…). The server observer is wired in
  `agent-bridge.ts` `case 'assistant'`, gated on `m.parent_tool_use_id == null`
  (orchestrator main turn only — confirmed hook), parsing leading/quoted-ignored
  `orchard-request` fenced blocks and upserting latest-wins. New route
  `GET /api/sessions/:id/requests` in `index.ts` (empty list, never 404, for a
  session this server is not driving).

- **Step 2 — the surface + the invariant.** New rail top section `#railRequests`
  ABOVE the reused `#railNeeds` (`public/index.html`), painted by
  `renderRailRequests` (`public/app.js`) which delegates to a shared, headless-
  testable join+row module `public/lib/requests-view.js`. THE INVARIANT IS
  STRUCTURAL: execution and completion are two independent reads into two
  separate row fields, rendered as two chips — execution from the board OWNER
  column (🤖 in-flight) gated by live-snapshot liveness/stall; completion from the
  board STATUS column only. `completion:'done'` requires every bound ticket done
  regardless of lane count; an idle request with any open ticket reads
  `idle · open`, never done. Degrades gracefully: no declared requests (or an
  older server with no route) → the section is hidden and the rail is exactly as
  before. Client fetch (`refreshRequests`) is session-keyed and re-joins live on
  every running-snapshot without refetching, so the store cannot go stale.
  Visuals reuse only existing tokens — `--live` (moss, execution running), the
  `--st-done/--st-prog/--st-needs` status tints (completion + ticket chips), the
  `.rail-sub .sub-h` eyebrow, the `--ink` ramp, `--hair-2`, `--sunken`, `--warn`
  (stall); no new hue or card primitive. `#railNeeds` and neighbours untouched.

- **A DESIGN POINT WHERE THE SPEC ASSUMES UNPLUMBED DATA (flagged, not silently
  substituted).** The spec's execution channel reads the running SNAPSHOT
  per-request, but `RunningEntry` (running-set.ts) carries no ticket/request id,
  so a live lane cannot be attributed to a specific request from the snapshot
  alone. This round reads per-request execution from the board's OWNER cell (🤖),
  gated by whether the session has ANY live lane, so it never claims motion the
  live snapshot does not confirm — preserving the two-independent-channels
  invariant (owner column vs status column). TRUE per-lane snapshot attribution
  needs the declared `ticket`/`request` carried onto `RunningEntry` (an extension
  of the Step-1 binding into the live lane); recommended as a follow-up.

- **Verification.** Step 1: `scripts/verify-feat-126-requests-store.mjs` — 21/21
  (grammar incl. conflict + in-fence-ignored; orchard-request parse incl. quoted-
  example-ignored + malformed→null; store round-trip; NO-cached-status key-set
  assertion; live join; the invariant; mutate-board-moves-the-row; missing-ticket
  honesty; **truncated read at every byte offset → clean-or-empty, never a throw
  or wrong value**). Must-FAIL proven: collapsing the two channels (deriving
  completion from execution) fails the invariant test (and two others); reverting
  → 21/21. Step 2: Playwright headless over the REAL modules + REAL styles.css
  (shared row builder, not a copy), five scenarios × light/dark — (a) none →
  section hidden, rail unchanged; (b) running → `▶ 1 running` + `open`; (c) the
  invariant → `idle` + `open`, visibly NOT done; (d) busy 6-request mixed state →
  reads as a hierarchy; (e) stalled → `stalled` (warn, no moss motion) + `open`.
  Judged as a designer: consistent with the rail language; one minor nit — in the
  rare stall state the execution `stalled` (warn) and completion `open` (ochre)
  chips are both amber-ish, distinguished by text + position. `npm run gate` PASS
  (leak + typecheck). Anti-regression: `verify-feat-067-rail-summary.mjs` 23/23
  (the adjacent rail-summary section is unaffected).

- **Skeptic flag / high-stakes.** Touches the Dispatch grammar and a new
  concurrently-written store, and the whole surface reads three concurrently-
  written sources — an independent clean-room verify pass is warranted per step
  before VERIFIED, per the plan's own skeptic flag. Screenshots (repo root):
  `feat126-a-none-{light,dark}.png`, `feat126-b-running-{light,dark}.png`,
  `feat126-c-invariant-{light,dark}.png`, `feat126-d-busy-{light,dark}.png`,
  `feat126-e-stall-light.png`.

- **Left unstaged for the user** (no git writes): `scripts/lib/cost-model.mjs`,
  `src/server/requests.ts` (new), `src/server/agent-bridge.ts`,
  `src/server/index.ts`, `public/lib/requests-view.js` (new), `public/lib/api.js`,
  `public/app.js`, `public/index.html`, `public/styles.css`,
  `scripts/verify-feat-126-requests-store.mjs` (new), and this ticket.

### 2026-09-05 — build lane, round 2 (attribution gap + Steps 3–5 + e2e; class=fix)

Closed the round-1 attribution gap and landed Steps 3, 4, 5, plus the missing
end-to-end proof. `npm run gate` PASS (leak + check-nul + typecheck, exit 0).

- **Attribution gap CLOSED (the round's headline).** `RunningEntry`/`LiveAgent`
  now carry an OPTIONAL declared `ticket[]` / `request`. The server reads the
  charter's `Dispatch:` line at the dispatching `Task` `tool_use` (its `prompt`),
  keyed by tool_use_id, and STAMPS it onto the `LiveAgent` at that lane's
  `task_started` (same id — a 1:1, charter-stated fact, expressly NOT the
  arrival-time owner resolution ARCH-003 forbids; the map is consumed there and
  cleared at `result`). `snapshotOfSession` carries it onto the snapshot entry.
  `requests-view.executionOf` now does TRUE per-lane attribution first: a request
  with a running lane declared to it (by request id or a bound ticket) reads
  `running` with a real lane count and lights up NO sibling; it DEGRADES to the
  round-1 coarse owner-column-gated-by-liveness read when no snapshot lane carries
  attribution (undeclared/older/survivor). Execution and completion stay two
  independent reads — the must-FAIL channel-collapse still trips (probe: deriving
  completion from execution → 20/26, the invariant test FAILS; reverted → 26/26).
- **Step 3 — reuse Needs-You (no second rail).** A row whose bound ticket is 👤
  renders a quiet `● needs you` route in its (collapsed) body that scrolls to the
  existing `#railNeeds` card; the blocker itself is still surfaced by the unchanged
  `reconcileNeeds`, driven independently off `board.needsYou`.
- **Step 4 — source deep-link + collapsed history.** The row is now a `<details>`:
  the SUMMARY (id + title + the two channels) is the always-visible state surface;
  ticket chips + `⤴ source` + the needs route live in the body, COLLAPSED by
  default, so routine detail never occupies the main surface. User bubbles are
  stamped `data-uuid` (transcript entries carry a server uuid); `goToSource`
  scrolls to an exact-uuid match, else to the first user bubble CONTAINING the
  source string (a short quote), else a quiet no-op. **Design gap, flagged not
  hidden:** the orchestrator cannot know the server-generated message uuid at
  declaration time, so the injected core (Step 5) asks for a `<short quote>` as
  `source` and the link resolves by quote-substring; exact-uuid anchoring is wired
  and ready but not the practical path. This is a deviation from the spec's literal
  `source=<uuid>` and is called out for the orchestrator's decision.
- **Step 5 — declaration defaulted in the injected core.** Added an "Opening a
  request" line to `RESPONSE_FORMAT.md` (a declaration, not an explanation). BUDGET
  (verify:feat-084 cap 5900 B, unchanged): 5880 → 5895 B. Paid for by compressing,
  NO rule lost: the `kind` ALIAS enumeration collapsed to "(common aliases map in;
  unknown→fyi)" — aliases still PARSE and are documented below the marker; plus
  word-level trims to the digest `ref` line and four "Inside a block" bullets. 5 B
  headroom. verify:feat-084 37/37, verify:feat-091 277/277.
- **END-TO-END proven (the piece nothing had shown).** New
  `scripts/verify-feat-126-e2e.mjs`: a REAL server + REAL bridge + REAL store +
  REAL routes; only the model process is scripted (the standard `CLAUDE_STATION_
  CLAUDE_BIN` fake-`claude` harness). It emits a real orchestrator turn — a leading
  `orchard-request` block AND a `Task` charter carrying the `Dispatch:` line — and
  asserts, 7/7: the block reaches the store via `GET /requests` (with NO cached
  status); the live lane carries its declared `request`+`ticket` on `GET /running`;
  and the shared `joinRequests` reads REQ-1 `running·attributed·count=1` while a
  sibling with no attributed lane reads `idle`, with execution≠completion holding
  on the real row. HONEST scope: closest faithful equivalent to a live session
  (scripted model), not a live-model turn.
- **Verification.** verify:feat-126-requests-store 26/26 (21 prior + 5 new
  per-lane-attribution incl. the degrade path); verify:feat-126-e2e 7/7;
  verify:feat-084 37/37; verify:feat-091 277/277. Anti-regression: rail-summary
  23/23, arch-003 owner-sweep 5/5 (the task_started stamp did not disturb owner
  resolution), running-snapshot 47/47. VISUAL (Playwright headless, real modules +
  real styles.css over a 6-request busy mixed-state fixture, both themes): the
  invariant is visually unmistakable — `idle · DONE` (done request) vs
  `▶ running · OPEN` (attributed live lane); nowhere does idle read as done; reads
  as a hierarchy; only existing tokens (`--live`, `--st-*`, `--warn`, ink ramp).
  Pre-existing round-1 nit persists (stall amber ≈ open ochre, distinguished by
  text/position). Screenshots (repo root): `feat126-r2-requests-{light,dark}.png`.
- **Skeptic flag / high-stakes.** Touches the Dispatch grammar consumer, a
  concurrently-written store, and session-lifecycle presentation reading three
  concurrently-written sources; the task_started stamp is regression-prone (owner
  lifecycle). An independent clean-room verify pass is warranted before VERIFIED,
  per the plan's own skeptic flag — self-verified suite is not the last word.
- **Left unstaged for the user** (no git writes): `src/server/events.ts`,
  `src/server/running-set.ts`, `src/server/agent-bridge.ts`,
  `public/lib/requests-view.js`, `public/app.js`, `public/styles.css`,
  `docs/prompts/RESPONSE_FORMAT.md`, `scripts/verify-feat-126-requests-store.mjs`,
  `scripts/lib/cost-model.d.mts` (new), `scripts/verify-feat-126-e2e.mjs` (new),
  `feat126-r2-requests-{light,dark}.png` (new), and this ticket.

### 2026-09-29 — clean-room independent verify (round 1, verifying) — VERDICT: BROKEN (VALID)

- **Requirement verified:** the request↔work binding is a DECLARED fact (fence-inert;
  a QUOTED declaration declares nothing; two DISAGREEING declarations yield a gap, never
  a guess); the store holds ONLY the binding with NO status; every status cell is JOINED
  LIVE from the board / running snapshot / outcomes with execution and completion as two
  independent channels (0 running + open ticket is NEVER done); per-lane attribution
  lights only the request a live lane is declared to; honest degradation; and a torn/
  partial store read yields the last intact ledger or empty, never a throw/wrong value.
  Full text: `/tmp/req-FEAT-126.txt`.
- **Command (exact):** `CLAUDE_CONFIG_DIR=<grey account 5a23b2f0…> node
  scripts/independent-verify.mjs --repo ~/projects/orchard --range 561ad6b
  --requirement @/tmp/req-FEAT-126.txt --run "node scripts/verify-feat-126-requests-store.mjs
  && node scripts/verify-feat-126-e2e.mjs" --test-file scripts/verify-feat-126-requests-store.mjs
  --test-file scripts/verify-feat-126-e2e.mjs --provider anthropic --timeout-min 8
  --max-diff-bytes 120000`. Range note: the FEAT-126 commit 131cce8 could NOT be a
  clean-room head — the current BUG-182 boot-stub guard requires `src/server/seed-sources.mjs`,
  which was extracted from `templates.ts` only later (ca672b9), so a room built from the
  pre-consolidation 131cce8 tree refuses to boot. `561ad6b` is the earliest bootable tree
  that carries BOTH the FEAT-126 core AND the FEAT-153 `rqSig` fix (present in that commit's
  `public/app.js`, confirmed); `requests.ts` / `requests-view.js` are byte-identical to
  131cce8, so the exported FEAT-126 code is the shipping code. The 1.3 MB diff truncated to
  120 KB is CONTEXT only — the verdict is driven by re-running the fixer tests and
  adversarial cases against the exported tree.
- **Verdict: BROKEN, contract VALID.** Fixer store suite re-run 26/26 (manifest
  fae4bec5375d). Adversarial case `fence-attrs-conflict-olddone-sibling-unk` (manifest
  155840e59439) surfaced SIX defects, several of them the ticket's OWN named falsifiers:
  - **FINDING (keystone / fence-inert):** an `orchard-request` quoted inside a multi-token
    info-string fence (```` ```markdown title=… ````) still DECLARES — `FENCE_OPEN_RE` in
    `requests.ts extractRequestBlocks` accepts only a single-token info string, so the outer
    fence never "opens" and the inner block is parsed top-level (REQ-999 lands in the store).
  - **FINDING (keystone / conflict→gap):** two DISAGREEING `orchard-request` blocks for one
    id in one turn produce a GUESS not a gap — `observeAssistantText` upserts both, last-wins
    ("Title two", [FEAT-2]). Violates "a guess is not a fact".
  - **FINDING (falsifier: view disagrees with the board):** `indexBoardTickets` reads only
    `board.doneToday`, and `readBoard` puts a Done row there only if the file changed in the
    last 24h — so a ticket verified 3 days ago renders `open · 1 missing` (state missing),
    not done. Answered-awaiting tickets are also never indexed.
  - **FINDING (falsifier: sibling attribution):** a lane declared to REQ-8 lights REQ-7 as
    running — the coarse fallback in `executionOf` gates REQ-7's 🤖 owner cell on session-wide
    liveness, which the REQ-8 lane supplies.
  - **FINDING (unconfirmed motion):** with `snap=null`, `executionOf` returns `running` for
    any 🤖 ticket, claiming motion no snapshot confirms (the rqSig gate discriminates snap
    shape but this join path still asserts running on unknown liveness).
  - **FINDING (DATA-LOSS, concurrent write):** a write that lands on a torn read WIPES the
    store — `readAll` returns `[]` on a truncated file and `upsert` then writes `[newRecord]`
    over it, erasing every other session's bindings (sess-G 3 → 0).
- **Could-not-test (verifier):** the e2e chain (`verify-feat-126-e2e.mjs`) aborted with
  "no start ack" — the scratch server refused the session start with `runtime-check-pending`
  (the test starts a session before the boot runtime check completes); an ENVIRONMENT/harness
  timing issue in the room, not a product defect, but the e2e chain was not re-proven this
  pass. The rail DOM (`renderRailRequests` and whether the rqSig gate repaints on board
  change) was NOT rendered in a real browser (no headless browser in the clean room), so the
  rqSig fix's runtime behaviour is unverified here — only `executionOf`'s code path was read.
  The outcomes-ledger "deaths" channel is joined nowhere in `requests-view.js`. A true
  two-process concurrent writer of `requests.json` was not simulated (only single-process
  torn-read-then-write).
- **Status:** left OPEN — six valid defects are the handoff. The keystone strictnesses
  (fence-inert, conflict→gap) and the board-agreement invariant are breached, plus a
  cross-session data-loss on torn-read-then-write. NOT VERIFIED.
- **Verified-by:** dispatch anthropic run 25cdb5ae-e435-476a-9b31-0e758ad26bb5 (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: BROKEN. Same-provider fallback, grey account;
  OpenAI window exhausted and Default and the personal account parked — decorrelation reduced
  (author-provider anthropic), noted per VERIFY.md #5.

### 2026-09-29 — fix lane (fixing, round 3, class=plan+review) — DATA-LOSS defect only

Scope was the round-1 verifier's DATA-LOSS finding (cross-session wipe in the
store's write path). The other five findings (fence-inert, conflict→gap, board
staleness via `doneToday`, sibling attribution, unconfirmed-motion) were NOT in
this charter and remain OPEN — untouched, still the handoff for a later round.

- **Reproduced FIRST (both, against the current tree).** A standalone repro drove
  the REAL `src/server/requests.ts`: (A) six OS processes, each the server for its
  own session, writing the shared store at once — 2–3 of 6 sessions fully wiped,
  30–39 records dropped; (B) the verifier's torn-store case, cross-session — a
  brand-new session opening a request while the store is torn wiped both prior
  sessions (G 3→0, H 2→0).

- **Invariant (one testable sentence):** an upsert for one session must never
  remove or overwrite another session's bindings, even when the store is being
  written concurrently or is transiently unreadable.

- **Root cause.** The store was ONE shared `requests.json` mutated read-all →
  write-all. `readAll()` returned `[]` for BOTH "no store yet" AND "couldn't read
  it right now" (torn/partial), and `upsert` then rewrote the WHOLE array — so a
  concurrent write from a stale read (lost update), or any write following a torn
  read, clobbered every other session. The read path documented tolerating torn
  reads; the write path turned that tolerance into a total wipe.

- **Fix (design, not a guard; confined to `requests.ts`).** ONE FILE PER SESSION,
  `dataDir()/requests/<enc(sessionId)>.json`, each holding only that session's
  records. A write for session A can only ever open A's file, so disturbing
  session B is STRUCTURALLY impossible (ARCH-010 — no shared array to clobber, no
  second place to hold a different answer). Each session has one writer, so its
  own file is never torn by a concurrent write of itself. Belt-and-braces for the
  torn half: `readSession` distinguishes "no file (ENOENT → genuinely empty, safe
  to create)" from "present but unreadable (torn/corrupt)", and `upsert` REFUSES
  to write over an unreadable file (returns null — a gap that re-emits and
  self-heals, never a clobber). Public API unchanged (`listForSession`,
  `observeAssistantText`, `upsert`), so `index.ts` and `agent-bridge.ts` need no
  edit — verified those two carry OTHER sessions' uncommitted work and were NOT
  touched. No live `requests.json` exists on this machine, so no migration; a
  legacy shared file (if any) is simply ignored by the per-session reader.

- **Verification.** `scripts/verify-feat-126-requests-store.mjs` 28/28 (26 prior +
  2 new: a real multi-process concurrent-writers test and a deterministic
  cross-session torn-store test; layout-dependent assertions updated to the
  per-session path). MUST-FAIL proven, anchored to the committed pre-fix tree
  (`a977e76`): running the suite against `git show HEAD:src/server/requests.ts`
  reddens both new DATA-LOSS tests (torn-store wipe; concurrent counts
  `[0,6,0,0,3,1]` — 3 sessions lost data); reverting to the fix → 28/28. Command
  for the standalone repro: `REQ_FILE=<prefix copy> node /tmp/repro-feat126-dataloss.mjs`
  fails 2/2 on pre-fix, passes 2/2 on the fix. Anti-regression: `verify-feat-153-board-grid.mjs`
  35/35 (exercises `observeAssistantText` through the real app path). `npm run gate`
  and `npm run board:check` run below.

- **Could-not-run (honest).** `verify-feat-126-e2e.mjs` FATALs at `startSession`
  with "no start ack" — the SAME environment/harness timing issue (scratch server
  `runtime-check-pending`) the round-1 verifier hit; it aborts BEFORE any store
  interaction, so it is unrelated to this change, not a regression. The rail DOM
  was not re-rendered in a browser this lane (data-store fix only; no
  `requests-view.js` change).

- **Skeptic flag / high-stakes.** DATA-LOSS + a concurrently-written store — an
  independent clean-room re-verify is warranted before VERIFIED (this lane's
  self-authored suite is not the last word). arch-watch: `decisions.ts` and
  `outcomes.ts` carry the SAME read-all/write-all-one-shared-file shape and the
  same latent defect (lower-frequency); flagged in the `requests.ts` header, not
  fixed here.

- **Left unstaged for the user** (no git writes): `src/server/requests.ts`,
  `scripts/verify-feat-126-requests-store.mjs`, and this ticket. Ticket left OPEN;
  NOT marked VERIFIED.

- **Symptom of a deeper design flaw?** yes → the shared-single-file read-all/
  write-all store pattern (also in `decisions.ts`/`outcomes.ts`) is the recurring
  shape; noted for arch-watch rather than filed this lane (scope was the FEAT-126
  data-loss defect).

### 2026-09-29 — fix lane (fixing, round 4, class=plan+review) — the other five r1 findings

Continued in-lane on the round-1 verifier's OTHER five findings (the data-loss
one was round 3). Each reproduced first (`/tmp/repro-feat126-r4.mjs`, 6/6 fail on
current tree), then fixed where confined to files carrying no other session's
uncommitted edits. Re-checked `git status`: OFF-LIMITS this lane = `public/app.js`,
`src/server/index.ts`, `src/server/agent-bridge.ts`, AND `src/server/board.ts`
(all carry other sessions' work). Editable: `src/server/requests.ts`,
`public/lib/requests-view.js`, and the (clean) verify scripts.

| # | finding | outcome |
|---|---|---|
| 1 | fence-inert: an `orchard-request` quoted inside a MULTI-token info-string fence (```` ```markdown title=… ````) still declared | **fixed** — `requests.ts` |
| 2 | conflict→gap: two DISAGREEING blocks for one id in one turn were a last-wins guess | **fixed** — `requests.ts` |
| 3a | answered-awaiting tickets were never indexed → read `missing` | **fixed** — `requests-view.js` |
| 3b | a ticket Done >24h ago is absent from the board payload → reads `missing` | **needs `board.ts`** (off-limits) — hunk below |
| 4 | sibling attribution: a lane declared to REQ-8 lit REQ-7 as running | **fixed** — `requests-view.js` |
| 5 | unconfirmed motion: `snap=null` + a 🤖 ticket read running | **fixed** — `requests-view.js` |

- **Finding 1.** `FENCE_OPEN_RE` anchored `[ \t]*$` right after a single info
  token, so a multi-token info string did not match and the fence never opened —
  its body leaked as top-level. Now the regex captures the whole info string and
  keys on its FIRST token; every fence's body stays inert, a real single-token
  `orchard-request` still opens.
- **Finding 2.** `parseRequestsFromText` now resolves per id WITHIN one turn:
  identical repeats collapse to one; two declarations that disagree (title/source/
  tickets-as-a-set) drop that id entirely — a gap, not a guess. Cross-turn
  latest-wins is untouched (that is separate `observeAssistantText` calls).
- **Findings 3a/4/5** all in `requests-view.js`. 3a: `indexBoardTickets` now also
  indexes `board.answeredAwaiting` (state `answered`; not `done`, so completion is
  unchanged, but it is no longer `missing`). 4+5: the coarse execution fallback now
  reads liveness from UNATTRIBUTED lanes only (`coarseLiveness`), so a sibling's
  attributed lane cannot light an unrelated request (4); and it returns `idle` when
  there is NO snapshot (`known:false`) rather than asserting running on unknown
  liveness (5).

- **Finding 3b — EXACT hunk needed (left for the orchestrator; `board.ts` off-limits).**
  The board payload's only Done list is `doneToday`, gated to 24h in `readBoard`
  (`board.ts:723-729`), so a ticket verified days ago is in no list and the join
  reports it `missing`. Fix has two parts:
  1. `src/server/board.ts` — add `doneIds: string[]` to the `Board` interface
     (near `doneToday` at :166) and to both the empty and populated literals
     (:650, :659); in the Done branch (:723-730) push `id` to `board.doneIds`
     UNCONDITIONALLY (before/around the `if (recent)` that gates `doneToday`).
  2. `public/lib/requests-view.js` — in `indexBoardTickets`, after the
     `add(board?.doneToday, 'done')` line, add:
     `for (const id of board?.doneIds ?? []) if (id && !map.has(id)) map.set(id, { state: 'done', item: { id } });`
     (A comment already marks this spot.) I did NOT add the client half now — it
     would be dead code until the payload carries the field.

- **Verification.** `scripts/verify-feat-126-requests-store.mjs` now 33/33 (28 +
  5 new FINDING tests for 1, 2, 3a, 4, 5). MUST-FAIL proven, anchored to the
  committed pre-fix tree: running the suite against `git show HEAD:` copies of BOTH
  `requests.ts` and `requests-view.js` reddens all five FINDING tests (9 failed
  total incl. the round-3 data-loss/layout tests); restoring the fix → 33/33. The
  standalone `/tmp/repro-feat126-r4.mjs` goes 6-fail → all-pass. Anti-regression:
  `verify-feat-153-board-grid.mjs` 35/35.
- **Regressed-from FEAT-153 (r5).** Finding 5's correct fix (no motion on unknown
  liveness) invalidated FEAT-153 board-grid check `(z)`, which had asserted
  `snap=null` → "1 running" as its observable — i.e. it encoded the exact
  unconfirmed-motion behaviour the r1 verify flagged. I updated `(z)` to encode the
  corrected behaviour and re-prove its real guarantee (the exec badge repaints
  across liveness changes: null→idle → confirmed-lane→running → empty-poll→idle).
  The rqSig repaint mechanism in `app.js` was NOT touched.
- **Could-not-run.** `verify-feat-126-e2e.mjs` still FATALs at `startSession`
  ("no start ack") — the same pre-existing environment/harness `runtime-check-pending`
  timing (round-1 verify + round-3 saw it); aborts before any store/parse access,
  not a regression.
- **Skeptic flag.** Findings touch the declaration recogniser (fence grammar +
  conflict resolution) and the execution-attribution join — an independent
  clean-room re-verify is warranted before VERIFIED. Ticket stays OPEN.
- **Left unstaged for the user** (no git writes): `src/server/requests.ts`,
  `public/lib/requests-view.js`, `scripts/verify-feat-126-requests-store.mjs`,
  `scripts/verify-feat-153-board-grid.mjs`, and this ticket. NOT marked VERIFIED.

### 2026-09-30 — clean-room independent verify (round 3/4 fixes, verifying) — VERDICT: BROKEN (VALID)

Verified the UNCOMMITTED round-3 (per-session store, data-loss) + round-4 (the
other four r1 findings: fence-inert multi-token, conflict→gap, 3a answered-awaiting,
sibling attribution, unconfirmed motion) fixes via `scripts/independent-verify.mjs`
`--working-tree`. Requirement framed as confirming a software fix (`/tmp/req-FEAT-126.txt`):
cross-session loss under concurrency; a torn/unreadable per-session file (cut at
many offsets); session ids that encode to colliding or path-traversing filenames;
upgrade from a legacy shared `requests.json`; the recogniser changes (multi-token
info-string fences; conflict→gap) with near-miss/nested/escaped fences; and an
INDEPENDENT judgement of the round-4 change to FEAT-153 check `(z)`. Finding 3b
(needs `board.ts`, off-limits) was explicitly excluded and NOT counted.

- **Command (exact):** `CLAUDE_CONFIG_DIR=<second anthropic acct, not the fixer> node scripts/independent-verify.mjs
  --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-126.txt
  --run "node scripts/verify-feat-126-requests-store.mjs && node scripts/verify-feat-153-board-grid.mjs"
  --test-file scripts/verify-feat-126-requests-store.mjs --test-file scripts/verify-feat-153-board-grid.mjs
  --provider anthropic --timeout-min 22 --verdict-out /tmp/verdict-FEAT-126.txt`. Exit 1
  (BROKEN, contract VALID).

- **Everything the round-3/4 charter targeted HOLDS.** Fixer suite re-run 33/33 +
  board-grid 35/35 (manifest d7422207d531, exit 0). Adversarial
  `concurrent-8proc-traversal-ids-truncate` (manifest 81ab77225611, exit 0) confirmed
  the fixes independently, on cases the fixer's fixtures do not cover:
  - **A (concurrency):** 8 concurrent OS-process writers each retained all 25 of their
    own records `[25×8]` — no cross-session drop. Round-3 data-loss fix HOLDS.
  - **B (torn read):** 1898 cut offsets of a unicode-heavy store — read never
    threw/wrong, write DECLINED, the torn file was left byte-for-byte unchanged, the
    sibling session file untouched, the restored intact file read all 6.
  - **C (id→filename):** 19 awkward ids (`../`, `/abs/path`, `a/b`, `..`, `.`, `C:\x`,
    NUL, `é`, `x.json`, …) each read exactly their own record; every file stayed INSIDE
    the store dir; no escape file; 19 distinct ids → 19 distinct files.
  - **D (legacy upgrade):** a live session keeps its per-session data with a legacy
    `requests.json` present; no legacy record mis-attributed; a torn legacy file does
    not crash reads/writes.
  - **E (recogniser fences):** multi-token ```` ```markdown title=note ````, `~~~ md a=b`,
    4-backtick outer, nested, and near-miss (`orchard-request-v2`, `orchard-requests`,
    `orchard-request{`) + escaped all stayed INERT; single-token/tilde/4-backtick real
    blocks still declare. Round-4 finding-1 fix HOLDS.
  - **F (conflict→gap):** differing title/source/ticket-set → gap; A,B,A → gap (no
    re-resolve); identical repeat collapses to one; a conflict on one id leaves the
    sibling intact; the store keeps its prior binding (no last-wins guess). Round-4
    finding-2 fix HOLDS.
  - **FEAT-153 (z) judged INDEPENDENTLY:** at-least-as-strong, NOT weakened — the
    rewritten check asserts idle→running→idle in order, so a badge that stopped
    repainting across liveness changes would still fail at the running or idle step.
    (Verifier could not `git show` the old (z) in the clean room — no `.git`; judged
    from the new assertion's structure. A reviewer with the diff should confirm.)

- **NEW valid defect → VERDICT BROKEN (data-loss-adjacent; NOT a round-3/4 regression,
  a pre-existing gap the per-session rework did not close).** Adversarial
  `corrupt-wrong-shape-session-file` (manifest fdae12babe90, exit 1): the round-3 torn
  handling only distinguishes ENOENT vs unparseable; it does NOT validate the SHAPE of a
  file that IS valid JSON. So a session file that is well-formed JSON of the wrong shape
  (`[null,…]`, `[1]`, `[{}]`, `["x"]`, records missing `createdAt`) is treated as readable
  and:
  - `listForSession` THROWS `TypeError: …reading 'localeCompare'` when ≥2 entries lack
    `createdAt`, and returns junk (`1`, `{}`, `"x"`) as records otherwise
    (`src/server/requests.ts` ~:126 readSession accept-any-array, ~:334 sort).
  - `upsert`/`observeAssistantText` THROW `TypeError: …reading 'id'` on a `null` entry
    (~:281).
  - `upsert` OVERWRITES (clobbers) a wrong-shape file such as `[{}]` / `[1]` instead of
    declining (~:302) — the same "never clobber a corrupt file" guarantee round-3 aimed
    at, breached for the valid-JSON-wrong-shape case (round-3 only proved it for
    cut-prefix corruption). Harm class: data-loss + throw on read.

- **Could-not-test (verifier, honest):** case-insensitive-FS filename collisions (Linux
  room only); two processes writing the SAME session id at once (design assumes one writer
  per session; requirement covered cross-session only); ENAMETOOLONG session ids (reads
  return empty / writes decline → silent drop, untested); the FEAT-153 (z) old-vs-new diff
  (no `.git` in room). Rail DOM not rendered (no headless browser in the clean room).

- **Status:** left OPEN. All round-3/4 targeted fixes are independently CONFIRMED to hold;
  the ticket is not VERIFIED because a NEW data-loss-adjacent defect (valid-JSON-wrong-shape
  session file → throw on read + clobber on write) remains. HANDOFF: extend `readSession`
  in `src/server/requests.ts` to validate array-of-well-formed-records (each an object with
  a string `id`; treat a wrong-shape-but-parseable file as UNREADABLE, so `upsert` declines
  rather than clobbers and `listForSession` returns empty rather than throwing) — the same
  ENOENT-vs-unreadable discipline round-3 introduced, extended from "parses" to "parses AND
  is the right shape". Finding 3b (`board.ts` `doneIds`) still open, still off-limits here.
- **Verified-by:** dispatch anthropic run 2cfc221a-a1e5-436d-9f00-c8f732b37090 (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: BROKEN (contract VALID).
  Same-provider fallback, a SECOND anthropic account (DIFFERENT from the fixer's; primary near
  cap, openai parked) — decorrelation reduced (author-provider anthropic), noted per
  VERIFY.md #5.

### 2026-09-30 — fix lane (fixing, round 5, class=fix) — wrong-shape session file

Fixed the round-5 verify's one new defect (run 2cfc221a): a session file that is
valid JSON of the WRONG SHAPE slipped past `readSession`'s parse-only check, so a
read THREW (sorting a row with no `createdAt`) and a write CLOBBERED it. Round-3/4
fixes were all independently confirmed to hold; this is the last open code defect
(3b — `board.ts doneIds` — is still off-limits here). Re-checked `git status`:
`requests.ts` carries only my own round-3/4/5 edits (no other session); editable.
`decisions.ts`/`outcomes.ts` are OTHER sessions' work (BUG-202) — left untouched,
convention matched.

- **Root cause.** `readSession` returned `ok:true` for ANY `Array.isArray(parsed)`,
  so an array of malformed rows became "records": `listForSession`'s
  `.sort((a,b)=>a.createdAt.localeCompare…)` threw on a row lacking `createdAt`,
  and `upsert` merged/overwrote the file — the "never clobber a corrupt file"
  guarantee (round-3) breached for the valid-JSON-wrong-shape case it never proved.

- **Fix (confined to `requests.ts`).** `readSession` now validates the FULL shape:
  the top level must be an array and EVERY element a well-formed `RequestRecord`
  (`isRequestRecord` — object, non-empty string `id`/`stationSessionId`, string
  `title`, string|null `projectId`/`source`, string[] `tickets`, string
  `createdAt`/`updatedAt`; unknown extra fields tolerated for forward-compat). One
  bad row ⇒ the WHOLE file is `ok:false` (corrupt). A size guard
  (`statSync` before read, `MAX_SESSION_FILE_BYTES = 4 MB`) refuses a "huge file"
  WITHOUT reading it (no OOM/stall). A wrong-shape file is now treated exactly like
  torn/unreadable: `listForSession` returns empty and NEVER throws.
- **Quarantine + self-heal (BUG-202 convention).** `upsert` no longer refuses-and-
  returns-null on `!ok`; it QUARANTINES the corrupt bytes (`renameSync` to
  `<file>.corrupt-<ts>`, one-shot, preserves bytes) then writes fresh. Because
  requests re-emit latest-wins, the session self-heals — unlike pure-refuse, a
  persistently wrong-shape file no longer blocks the session forever. Matches
  `decisions.ts`/`outcomes.ts` `quarantineCorruptStore`. `upsert` now always
  returns a `RequestRecord` (never null); `observeAssistantText` simplified.

- **Verification.** `scripts/verify-feat-126-requests-store.mjs` now 39/39 (33 +
  6 WRONG-SHAPE cases: array-instead-of-object, top-level object, missing field,
  wrong field types, null, huge >4 MB — each asserts read empty+no-throw, write
  quarantines+self-heals with bytes preserved verbatim, and the sibling session
  survives). The 33 prior tests stay green. MUST-FAIL proven against a synthesized
  pre-round-5 baseline (readSession reverted to parse-only, no size guard):
  `REQ_FILE=<baseline> node /tmp/repro-feat126-r5.mjs` reddens every shape case
  (garbage records returned / clobbered / huge threw); the fix passes all 18
  checks. Anti-regression: `verify-feat-153-board-grid.mjs` 35/35 (still exercises
  `observeAssistantText`). `npm run gate` + `board:check` run below.
- **Could-not-run.** `verify-feat-126-e2e.mjs` still FATALs pre-store at
  `startSession` ("no start ack") — the same pre-existing environment/harness
  timing seen since round 1; unrelated to this change.
- **Skeptic flag.** Data-loss-adjacent store change — an independent clean-room
  re-verify is warranted before VERIFIED. Ticket stays OPEN (3b still needs
  `board.ts`).
- **Left unstaged for the user** (no git writes): `src/server/requests.ts`,
  `scripts/verify-feat-126-requests-store.mjs`, and this ticket. NOT VERIFIED.

### 2026-09-30 — clean-room independent verify (round 5, verifying) — VERDICT: BROKEN (VALID)

Verified the UNCOMMITTED round-5 wrong-shape/quarantine fix in `src/server/requests.ts`
(full-shape validation, a 4 MB size guard, wrong-shape files quarantined not clobbered)
via `scripts/independent-verify.mjs --working-tree`. Requirement framed as confirming a
software fix (`/tmp/req-FEAT-126-r5.txt`): the round-5 validation correctly handles
wrong-shape variants the fixer did NOT enumerate — extra fields on a record, valid-but-
duplicated rows, a file that GROWS past 4 MB between the stat and the read, a quarantine-
name COLLISION — and that quarantined bytes are preserved VERBATIM (never clobbered/
truncated). SCOPE was round 5 only; rounds 3/4 were already confirmed by run 2cfc221a and
were not re-litigated. Finding 3b (`board.ts` `doneIds`, off-limits) excluded.

- **Command (exact):** `CLAUDE_CONFIG_DIR=<the grey account> node
  scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree
  --requirement @/tmp/req-FEAT-126-r5.txt --run "node scripts/verify-feat-126-requests-store.mjs"
  --test-file scripts/verify-feat-126-requests-store.mjs --provider anthropic --timeout-min 22
  --verdict-out /tmp/verdict-FEAT-126-r5.txt`. Exit 1 (BROKEN, contract VALID). Manifest:
  5 recorded runs.

- **The fixer suite re-run HOLDS: 39/39** (manifest 3b293af12bb0, exit 0) — every declared
  wrong-shape case (array-instead-of-object, top-level object, missing field, wrong types,
  null, >4 MB) reads empty + no-throw, quarantines + self-heals, sibling session survives.

- **Two of the three not-enumerated variants HOLD** (adversarial run 8054f8472a3a, exit 0):
  extra-field records are accepted intact (forward-compat, not quarantined) while a record
  missing a REQUIRED field but carrying extras is still corrupt; duplicate ids read without
  throw and upsert is deterministic with no rows destroyed; and quarantined bytes are
  byte-for-byte verbatim across 15 corrupt kinds (invalid UTF-8, BOM, NUL, UTF-16, empty,
  4 MB+1, oversized-valid 5.6 MB), with the sibling session's file untouched.

- **THREE NEW valid defects → VERDICT BROKEN (data-loss / data-integrity):**
  - **FINDING (quarantine-name COLLISION → silent overwrite):** `quarantineCorruptSession`
    (`src/server/requests.ts` ~:192-194) renames onto `<file>.corrupt-<ms timestamp>` with
    NO existence check, so a pre-existing quarantine file of that name is silently
    overwritten (adversarial `quarantine-name-collision`, run bad3f33c16a3, exit 1: 20,000
    pre-existing quarantine files → count stayed 20,000, one file's earlier bytes replaced).
  - **FINDING (same-ms double quarantine → first evidence destroyed):** two quarantines of
    the same session within one millisecond leave a single `.corrupt-` file holding only the
    SECOND corrupt bytes; the first quarantined bytes are destroyed with no throw and no
    warning (same run).
  - **FINDING (4 MB guard TOCTOU / unbounded read):** the size guard (`readSession`
    ~:155-163) is stat-then-`readFileSync` with NO length cap on what was actually read; a
    file 182 B at `statSync` and 7,537,781 B at read was fully read, parsed and returned as
    40,000 records instead of being treated as unreadable, and the following upsert rewrote
    it as a 10.2 MB live file with no quarantine (adversarial `grow-past-4mb-between-stat-
    and-read`, run 2030b9988674, exit 1). No rows were lost in that specific case, but the
    guard is bypassed and the OOM/stall protection it exists for does not hold under a
    concurrent grow.

- **Could-not-test (verifier, honest):** a genuinely concurrent second-process writer during
  the stat→read window (forced deterministically by hooking `statSync` in one process); a
  same-ms collision on the real clock (frozen `Date`); quarantine when the `rename` itself
  fails (EACCES / read-only dir / path-is-a-directory) — the throw path in
  `quarantineCorruptSession` and whether it strands the session is unverified; memory/stall
  behaviour when the file grows to hundreds of MB/GB (only a 7.5 MB grow exercised, 46 ms).

- **Status:** left OPEN (priority — data-loss). The round-5 fix's declared cases and two of
  the three not-enumerated variants HOLD, but three NEW data-loss/integrity defects remain
  (quarantine-name collision + same-ms double quarantine destroy earlier corrupt evidence;
  the 4 MB guard is TOCTOU-bypassable). NOT VERIFIED. HANDOFF: in `src/server/requests.ts`,
  (1) make quarantine collision-safe — never rename onto an existing name (append a counter/
  random suffix, or O_EXCL create), so no earlier quarantined bytes are ever overwritten;
  (2) cap the actual read — either re-check length after `readFileSync` against
  `MAX_SESSION_FILE_BYTES` and treat an over-cap read as unreadable, or read at most N bytes,
  so a file that grows across the stat→read window is refused rather than parsed. Finding 3b
  (`board.ts` `doneIds`) still open, still off-limits here.
- **Verified-by:** dispatch anthropic run 8e8e3761-1562-429e-922e-157f12c6e29d (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: BROKEN (contract VALID).
  Same-provider fallback, the grey account (openai window parked; author-provider anthropic,
  decorrelation reduced) — noted per VERIFY.md #5.

### 2026-09-30 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 8e8e3761-1562-429e-922e-157f12c6e29d — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-09-30 — fix lane (fixing, round 6, class=fix) — quarantine/read defects → shared store-io.ts

Fixed the round-6 verify's three new defects (run 8e8e3761) and, per ARCH-010,
consolidated the quarantine + capped-read logic that requests.ts / decisions.ts /
outcomes.ts had each grown separately into ONE owner, `src/server/store-io.ts`.
Re-checked `git status` first: `requests.ts` carried only my own r3–r5 edits;
`decisions.ts`/`outcomes.ts` were dirty only with BUG-202's hunks (confirmed via
`git diff`) — this round (ticket=FEAT-126,BUG-202) is authorized to edit them.

- **The three defects (all three stores shared the shape):** (1) quarantine renamed
  onto `<file>.corrupt-<ts>` with no existence check → overwrote an earlier
  quarantine; (2) two quarantines in one millisecond destroyed the first; (3) the
  size guard was `statSync`-then-unbounded-`readFileSync`, bypassed by a file that
  grows across the stat→read window.
- **Fix — `src/server/store-io.ts` (single owner, ARCH-010):**
  `quarantine(file, label)` reserves a unique name atomically with `O_EXCL`
  (`Date.now()`+6 random bytes, retry on collision) then moves the bytes onto it —
  no earlier quarantine is ever overwritten, even same-ms or cross-process.
  `readCapped(file, max)` reads bounded by the fd (≤ `max+1` bytes), with NO
  separate stat, so there is no TOCTOU and an over-cap file is `toobig` (refused),
  never read unbounded. `requests.ts` now imports both; its private
  `quarantineCorruptSession` and `statSync`+`readFileSync` guard were DELETED (the
  now-unused `fs` import too). `decisions.ts`/`outcomes.ts` routed through the same
  helper (see BUG-202's round-6 entry).
- **Verified.** `scripts/verify-store-io.mjs` NEW 7/7 (inline pre-fix sims are the
  must-FAIL for each defect; helper passes). FEAT-126 store suite 41/41 (39 prior +
  2 new SHARED QUARANTINE tests: two same-ms quarantines both preserved; an
  oversized VALID-records file refused fd-bounded + quarantined + self-heals).
  MUST-FAIL proven by swapping `store-io.ts` for a pre-round-6 baseline
  (`Date.now`-only name + unbounded read): both new FEAT-126 tests and all 4 new
  BUG-202 tests redden; restore → all green. Anti-regression:
  `verify-bug-202-store-dataloss.mjs` 15/15, `verify-feat-153-board-grid` 35/35,
  `tsc` 0, `npm run gate` PASS.
- **Could-not-run.** `verify-feat-126-e2e.mjs` still FATALs pre-store at
  `startSession` ("no start ack") — the same pre-existing environment/harness
  timing since round 1; unrelated to this change.
- **Skeptic flag.** Data-loss; a shared helper now under three stores. Independent
  clean-room re-verify warranted before VERIFIED. Finding 3b (`board.ts doneIds`)
  still open, still off-limits here. Ticket stays OPEN.
- **Left unstaged (no git writes):** `src/server/store-io.ts` (new),
  `src/server/requests.ts`, `src/server/decisions.ts`, `src/server/outcomes.ts`,
  `scripts/verify-feat-126-requests-store.mjs`, `scripts/verify-store-io.mjs` (new),
  `scripts/verify-bug-202-store-dataloss.mjs`, and both tickets. NOT VERIFIED.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run ccde50b4-34c6-4152-bdf5-d703f9b80475 — VERDICT: HOLDS — clean-room independent-verify --working-tree; same-provider fallback, a second anthropic account (not the fixer's); openai window exhausted. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — clean-room independent verify (round 6 store-io, verifying) — VERDICT: HOLDS (VALID); ticket STAYS OPEN (3b)

Verified the UNCOMMITTED round-6 fix (the three quarantine/read defects run
8e8e3761 found, now consolidated into the shared `src/server/store-io.ts`)
TOGETHER with BUG-202 — both stores route through the same new module — via
`scripts/independent-verify.mjs --working-tree`. SCOPE was the round-6 data-loss
module only; the recogniser/attribution fixes of rounds 3–5 were already confirmed
(runs 2cfc221a, 8e8e3761) and were not re-litigated. Finding 3b (`board.ts`
`doneIds`, off-limits) was NOT in scope and remains open.

- **Command (exact):** as recorded in the BUG-202 entry of the same date (one
  combined run), `--run "node scripts/verify-store-io.mjs && node
  scripts/verify-feat-126-requests-store.mjs && node
  scripts/verify-bug-202-store-dataloss.mjs"`, requirement
  `@/tmp/req-FEAT-126-BUG-202.txt`, `--provider anthropic --timeout-min 22`,
  verdict `/tmp/verdict-FEAT-126-BUG-202.txt`. Exit 0 (HOLDS, contract VALID).
- **Everything the round-6 charter targeted HOLDS.** FEAT-126 store suite re-run
  41/41 + `verify-store-io.mjs` 7/7 + `verify-bug-202-store-dataloss.mjs` 15/15
  (manifest cfedf63ead7c, exit 0). Adversarial cases (not covered by the fixtures)
  all held: O_EXCL quarantine leaves no stray 0-byte placeholder and preserves
  bytes untouched when the move itself throws (EXDEV); a requests session file at
  exactly 4 MiB is kept and 4 MiB+1 is quarantined with bytes intact; a realistic
  store truncated at 60 offsets never admits a partial record; and all three stores
  (requests/decisions/outcomes) route through `store-io.ts` with no private
  read/rename copy. The round-6 quarantine-collision, same-ms-collapse, and
  TOCTOU-unbounded-read defects are independently confirmed fixed.
- **Verifier UNTESTED (honest):** a true crash between O_EXCL create and rename (not
  a real process kill); network/FUSE atomicity of O_EXCL/rename; the live HTTP/WS
  routes (direct module imports only); the rail DOM was not rendered (no headless
  browser in the clean room).
- **Status:** left OPEN. The round-6 store-io data-loss defects are independently
  CONFIRMED to hold, so the data-loss risk flagged across rounds 3–6 is closed for
  the three stores. The ticket is NOT marked VERIFIED because finding 3b
  (`src/server/board.ts` `doneIds` — a ticket Done >24h ago reads `missing` in the
  request row) remains open and was off-limits to the fix lanes; the exact hunk is
  in the round-4 Activity entry. HANDOFF for the orchestrator: land 3b (board.ts +
  the one requests-view.js line), then a final verify can take FEAT-126 to VERIFIED.
- **Verified-by:** dispatch anthropic run ccde50b4-34c6-4152-bdf5-d703f9b80475
  (clean-room, `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: HOLDS
  (contract VALID). Same-provider fallback, a second anthropic account (different
  from the fixer's); openai window exhausted — decorrelation reduced (author-provider
  anthropic), noted per VERIFY.md #5. (Proof is the typed entry in the board ledger;
  this line is a pointer, not the proof.)
