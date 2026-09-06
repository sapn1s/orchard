# FEAT-126 — "Your requests": a persistent, request-centred status view

- **Status:** OPEN — design approved by the user; this ticket is the build spec. plan+review round 1 (finding). No product code written this round. Recommended path: the request↔work binding is a DECLARED fact owned by the orchestrator (Dispatch `request=` key + an `orchard-request` block), never derived from chat; the surface holds only that binding and JOINS every status live from the board / liveness / outcomes so it cannot go stale.
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
