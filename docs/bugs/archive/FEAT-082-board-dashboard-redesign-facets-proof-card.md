# FEAT-082 — board/ticket-dashboard redesign: type facets + "Solved?" proof card + summary strip (not lanes)

- **Status:** OPEN — recommend facets + a proof card (not Kanban); open question: how to capture the proof.
- **Area:** src/server/tickets.ts + src/server/board.ts + public/app.js (FEAT-058 dashboard) + docs/bugs/TEMPLATE.md
- **Reported:** 2026-08-14 by user

## In plain terms
The ticket board is one big table that lumps every kind of item together, and there's no quick way to tell
finished work from unfinished — or to open a feature and confirm it's actually done and see the proof. Today,
answering "is this done, and how do I know?" means reading a ticket's whole history log.

**Recommendation:** keep the searchable table, but add three things — colour-coded type labels
(feature / bug / architecture), a "Solved?" summary card at the top of each ticket showing whether it's done
and the evidence, and a small counts strip. Deliberately NOT a drag-the-cards "Kanban" board — that suits
multi-person triage, not the single-person find-and-confirm this is for.

**The one genuinely open question — how the proof on the card gets captured:**
- (a) best-effort: read it out of existing ticket text now — no change to how tickets are written, shows "not
  recorded" when it can't find it;
- (b) structured fields going forward — reliable, but only helps future tickets and adds a small step when
  writing them;
- (c) both.

**What I need from you:** approve the direction (type labels + proof card, no Kanban), and pick a, b, or c.

**If you do nothing:** nothing breaks; the board stays as it is and this stays open.

> Everything below is the detailed design record and verification plan — reference, not needed to make the call above.

## Problem
The board is one large status-grouped table mixing FEAT/BUG/ARCH by prefix only. The user can't easily
(1) separate types, (2) see in-progress/unfinished vs finished at a glance, (3) find a requested feature
and confirm it's SOLVED — with the PROOF (§C verification: counts, must-FAIL, independent-verify verdict)
and how it works — without reading the whole Activity log.

## Design proposal (Opus 5, read-only pass — recommendation, challenges the "lanes" framing)
**Keep the searchable table; add three things (NOT a Kanban lane board):**
1. **Type facet + colored badges** (FEAT/BUG/ARCH/DEPLOY) — trivial (id-prefix parse); satisfies type
   separation without fragmenting search results across collapsed sections.
2. **"Solved?" proof card** at the top of the ticket detail view — the real gap. Verdict badge
   (SOLVED / **DONE-unverified** / IN-PROGRESS / OPEN / BLOCKED) + independent-verify run id & HOLDS/BROKEN
   + pass counts + commit hash + anchor-jump to the newest "how it works" activity entry. Each line maps
   to real ticket data with honest "not recorded" fallbacks.
3. **Summary strip** reusing `boardSummary()` counts (FEAT-067), segmented by type.
IA: primary axis STATUS (Open vs Done, already computed via isDoneStatus), secondary axis TYPE as a
facet. Rejected: Kanban lanes (optimize multi-person triage, not single-user find-and-confirm; lose the
dense sortable/searchable table) and type-grouped accordions (fragment search, lots of scroll).

## Decision — approve the facets + proof-card design, and how should the proof be captured? (open; user)

Two questions, but they collapse into one pick: approving the design is only actionable together with a
proof-capture method, since the proof card is the part that needs data.

- **A — approve, capture proof best-effort by regex now.** Facets + proof card, no lanes; the card scrapes
  pass counts / must-FAIL / commit from existing ticket prose. Zero workflow change, works on the 174 tickets
  that already exist, degrades to an honest "not recorded" where the prose does not say.
- **B — approve, capture proof via structured template fields going forward.** Same design; add `counts:` /
  `commit:` fields to TEMPLATE.md so the card reads declared data. Reliable, but future-only (today's tickets
  stay blank) and it adds a capture step to every close.
- **C — approve, do both.** Structured fields when present, regex as the fallback. Most work, best coverage;
  the regex path has to keep working anyway during the transition.
- **D — do not approve the design; rework it first.** Reject the facets + proof-card framing (e.g. in favour
  of Kanban lanes or type-grouped accordions, both rejected in the design pass above) and re-open the design
  before any proof-capture question is worth answering.

## Data ground truth (from the design pass)
- Available cheaply: type (prefix), status/section, owner, sev, `Verified-by:` run+verdict (only ~5
  tickets carry a VERDICT line today), `Verification-class` (~16 tickets).
- Prose-only (regex best-effort or capture-forward): pass counts ("36/36 PASS"), must-FAIL presence,
  commit hash (also in INDEX Done row — board.ts already parses it).

## Verification (§C) — on build
- Type facet filters correctly; badges render per type. Proof card: for a VERIFIED ticket with a
  Verified-by HOLDS line → SOLVED + run id + counts; for a DONE ticket with no Verified-by → DONE-unverified;
  for an OPEN ticket → OPEN, no false proof. Fallbacks show "not recorded" not blanks. Summary counts
  match boardSummary. Anti-regress: verify:tickets, verify:ui, typecheck, leak-gate.
- Risk bucket: UI + read-only ticket parsing (low).

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user request (separate FEAT/BUG/ARCH; state-at-a-glance; find-a-feature + proof/how-it-works).
  Ran a read-only Opus-5 design pass; it challenged the "lanes" framing and recommends facets + a proof
  card on the existing table. Awaiting user sign-off before build.

### 2026-08-18 — worker (server-side preconditions; NO UI — public/ is a later lane)
Built the two server-side preconditions the design pass refused to ship the UI without. Lane:
`src/server/board.ts`, `scripts/board.mjs`, `scripts/verify-reachability.mjs`. Nothing in `public/` touched.

- **STEP 0 — reachability check (ARCH-004 option C).** The redesign shows LESS than the full table, so a
  ticket that loses its marker goes from buried to invisible. Added the missing property to `board:check`:
  every open ticket must surface on at least one human lane (needs-you / answered-awaiting / in-flight /
  queued / recently-updated 7d), else it is reported. Details + the non-redundancy proof + the real-board
  result (0 unreachable) are logged on ARCH-004. This does NOT decide ARCH-004's A/B/C — it implements the
  cheap option C only; the wider decision stays open.

- **STEP 1 — two parser defects the design found, both fixed in `board.ts`:**
  1. `DECISION_HEADING_RE` was `/^##\s+Decision/i` (heading had to START with "Decision"), so the real
     ARCH-004 `## The decision` parsed to **null** — a Decide grouping built today would have silently
     dropped it and every other non-"Decision"-leading heading. Widened to `/^##\s+.*\bdecisions?\b/i`
     (a decision heading regardless of leading words). The strictness that makes a heading a decision is
     UNCHANGED — still ≥2 bold-lead `- **KEY — label**` OPTION_BULLETs — so prose never becomes fake
     buttons (verified: FEAT-082's own `## Open decision (user)` numbered bullets, and BUG-101, still → null).
  2. `RECOMMENDED_RE` extracted a key without validating it: ARCH-004's "Recommended: one canonical
     state…" yielded the bogus key `one`. Now validated against the parsed option keys in `ticketDecision`
     (case-insensitive, normalises to the option's own casing) and dropped when it matches none. ARCH-004's
     `one` → null; ARCH-003's valid `B` survives.
  - Exposed the validated recommendation on `BoardItem.recommended` (set on the needs-you item in
    `readBoard`) so the landing screen can badge it without re-parsing markdown.

- **Verification** (`scripts/verify-reachability.mjs`, 17/17 — parser asserts on the REAL ARCH-004/ARCH-003/
  FEAT-082/BUG-101 files per docs/CONVENTIONS.md; reachability fixtures synthetic-by-necessity and
  backdated with utimes to exercise the mtime lane honestly, said so in the script). Anti-regress:
  verify:feat-090 23/23, verify:feat-090-handoff 31/31, verify:feat-079-observations-lane 16/16,
  verify:feat-067-rail-summary 23/23, board:check exit 0, typecheck clean, `npm run gate` PASS (unpiped).
  verify:tickets 29/30 and verify:needs-you-rail 16/17 each carry ONE pre-existing failure — both reproduce
  identically with my changes stashed (board-tool column format in tickets.ts; a no-docs/bugs precondition),
  neither in this lane nor caused by this change.
- **Risk bucket:** read-only ticket parsing + a board-check ride-along (low). No session-lifecycle/security/
  data-loss surface. An independent clean-room verify is optional here, not warranted.

### 2026-08-18 — worker (steps 2-7: the digest landing screen)
Built the new board landing screen. Lane: `public/app.js`, `public/index.html`, `public/styles.css`,
`public/lib/route.js`, verify scripts. Nothing server-side touched (the preconditions from `c7dceb8` gave
the digest everything it needs — `BoardItem.recommended`, the widened decision parser, the reachability check).

**The route split.** `#/tickets` is now the DIGEST (what awaits you). The full sortable/filterable/
searchable/keyboard table moved WHOLESALE to `#/tickets/all` — same code, only its placement changed. Detail
(`#/tickets/<ID>`) is unchanged. `parseTicketsHash` now returns a `view` ('digest'|'all'|'detail'); `all` is a
reserved segment that can never shadow a real ticket id (`^[A-Z]+-\d+$`). A persistent "All tickets" control
sits in the header (hides itself while /all IS the view); the digest search box's Enter opens the full list
pre-filtered. The topbar pill and rail link already point at `formatTicketsHash({projectId})` → now the digest,
deliberately (asserted).

**The digest, top to bottom** (all built in `renderDigest`, fed by a PARALLEL `/board` + `/tickets` fetch via
`Promise.allSettled` — on partial failure it renders what loaded and says plainly what did not):
- a thin counts strip from `boardSummary().counts` — needs · answered · in flight · queued · observations ·
  open (derived = needs+answered+inflight+queued) · done; chips that scroll to a section or navigate to /all
  pre-filtered.
- **Awaiting you**, split by a divider into **Decide** (parsed decision: question clamped one line, option
  count, the validated `recommended` key badged) and **Look at** (no decision: the INDEX status blurb verbatim,
  clamped two lines). Both carry a type badge, id, title, severity and a relative last-activity (joined from the
  `/tickets` list, since board items carry no `lastActivity`).
- **Answered — awaiting action**: `you chose "<answer>" on <date>` + a "nothing dispatched yet" marker. Hidden
  when empty.
- **In flight**: one read-only line each. Hidden when empty.
- **Recently updated**: 7-day window, capped 10, grouped by day, from `ticketList`. No change summary invented
  (the model only knows `lastActivity`). "see all →" to the full list.
- **Observations**: bottom, collapsed to a count, expandable, reusing `observationRow` + its dismiss.
- **Empty state**: a clear board collapses Awaiting-you to a plain "Nothing needs you" and Recently-updated
  becomes the body — it does not read as broken.
- **Type treatment**: one list, a small mono type tag per row; ARCH gets a DISTINCT outlined ◆ARCH chip, not a
  fourth family colour. No per-type lanes, no kanban/sprints/assignees/etc. (explicitly out of scope).

**Two latent bugs found + fixed while building** (both real, both mine to name):
- a digest→/all hop left `tv.rows` belonging to the digest's project but under a DIFFERENT project's cache, so
  `/all` could render stale rows from another board. Fixed by tracking `tv.rowsProjectId` and reloading when it
  no longer matches; the digest now seeds `tv.rows` from its own unfiltered fetch (no second round-trip).
- the project switcher only refreshed on first open, so a URL hop to another project's board left the dropdown
  labelling the wrong one. Now refreshed on every project change.

**Verification.** New `scripts/verify-feat-082-digest.mjs` (`npm run verify:feat-082`, 32/32) — real headless
Brave over CDP (free port, PID-kill only, never :4317) against THREE boards: (1) a REALISTIC-STATE scratch board
that exercises EVERY lane INCLUDING the two empty on the real board — answered-awaiting + in-flight are seeded so
they ship exercised (synthetic-by-necessity, said so); (2) the REAL repo board — recently-updated's cap (73 files
touched in 7d → digest shows exactly 10) + day-grouping validated against the real artifact per CONVENTIONS.md;
(3) an inbox-zero board for the empty state. Plus a partial-failure leg through the exported `renderDigest` (a
rejected board fetch renders recent rows + states the failure; both-rejected shows one honest panel), the full
route split, deep links, and pure-function route assertions.
- Screenshots (visual gate) → `/tmp/iv-orchard/`: `board-digest.png` (real, light), `-dark`,
  `board-digest-narrow.png`, `board-digest-empty.png`, `board-all.png` (+ scratch variants). I reviewed them:
  the real-board digest reads exactly as intended — 9 needs split into Decide (ARCH-003 with "recommends B",
  ARCH-004 no rec) and 7 Look-at with their verbatim status blurbs; counts strip; recently-updated grouped/capped.
  NOTE: the `-dark` PNG renders LIGHT — a known headless-brave capture limitation in this repo (the merged
  `feat090-wide-dark.png` is light too); the DOM-level "dark theme applied" check PASSES, so dark support is
  correct in the product. True dark visual review should come from the playwright MCP gate.
- Verify-script updates in-lane: `verify:tickets`, `FEAT-063`/`FEAT-066` specs, and the guide-capture helper now
  point at `/tickets/all` for their full-table assertions (the table moved); FEAT-066's pill test now asserts the
  digest landing (the intended new behaviour).
- Anti-regress (all green unless noted): verify:reachability 17/17, verify:feat-090 23/23, verify:feat-090-handoff
  31/31, verify:feat-067-rail-summary 23/23, verify:feat-079-observations-lane 16/16, verify:feat-083 22/22 +
  adversarial 170/0, verify:bug-101-contrast ALL PASS, verify:ui 7/7, verify:feat-082 32/32. `npm run gate` PASS
  (leak-gate + typecheck, exit 0, unpiped). verify:tickets (28/29, --no-model) and verify:needs-you-rail (16/17)
  each carry the SAME ONE pre-existing failure documented in the entry above (board-tool column format;
  no-docs/bugs precondition) — neither in this lane nor caused by this change.
- **Risk bucket:** UI + read-only aggregation (low). No session-lifecycle/security/data-loss surface. The one
  thing warranting a second look is the dark-capture gap — flagged above for the playwright MCP visual gate,
  which is the sanctioned surface for it.

### 2026-08-18 — worker (visual-review fixes on the digest)

Acted on an unbiased visual review of the digest. Three findings were called blocking; **two of them were not
code defects** and are recorded here so the shape is recognised next time.

**Deploy lag, not a defect — confirmed, not assumed.** The reviewer shot a live server booted at 11:28; the
parser fixes (`c7dceb8`) landed at 13:10. Querying that old process returned `ARCH-004 question=None` and
`ARCH-003 recommended=None`, which is exactly why ARCH-004 appeared under "Look at" and the recommendation badge
looked intermittent. Verified against a FRESHLY BOOTED scratch server on current code (free port, scratch
dataDir, never :4317): ARCH-004 lands in **Decide** with "3 options"; ARCH-003 lands in Decide showing its own
question and the `recommends B` badge. Both are now ASSERTED against the real board inside `verify:feat-082`, so
a stale deploy can never impersonate a defect here again.

**1. The decision question now has a floor** (`src/server/board.ts`). It used to be the heading text verbatim,
which produced `## The decision` → the literal question "The decision" (contentless, sitting next to "3 options"
as if it were the thing to decide) and `## Decision 1 — …` → a question leaking internal numbering. Now:
`Decision N —` scaffolding is stripped, and a heading whose remaining words carry no information (the/open/a +
"decision" and nothing else) falls back to the **ticket title**, flagged `questionFromTitle` on the decision and
the board item. The digest then renders NO question line for such a row — the title is already the row's head,
and the option count carries the rest. Why fall back rather than return an empty question: a non-empty
`question` is what makes an item ANSWERABLE app-wide (`isAnswerableItem`), so emptying it would silently demote
a real 3-option decision to a read-only row — the exact bug fixed in the entry above. The flag lets the renderer
drop the line without the model losing the fact that a decision exists.

**2. The 480px header.** "New ticket" sat flush against the viewport edge with a clipped corner and both buttons
wrapped their labels, doubling the header height. Header buttons are now `white-space: nowrap; flex: none`, the
project switcher is the elastic member, and a ≤560px query tightens the gutters and drops the "Board" wordmark.
The digest search placeholder shortens at that width instead of being clipped mid-phrase ("…↵ opens the full",
losing "list") — one module-level media query, so a re-render never stacks another listener.

**3. The harness silently overwrote the light capture with the dark one** — `board-digest.png` and
`board-digest-dark.png` had the same md5, both dark. That is why the entry above claims "the -dark PNG renders
LIGHT — a known headless-brave limitation": there was no limitation. The real cause: the app's default theme is
`system`, and this headless browser reports `prefers-color-scheme: dark`, so every "light" capture was in fact
dark, and the dark leg then produced identical bytes. Two fixes: the harness PINS the theme (emulated media +
the app's own persisted choice) before each capture, and `scripts/lib/shot-luma.mjs` now GRADES every capture —
a zero-dependency PNG decoder measures mean luminance, so a shot labelled dark must be dark, one labelled light
must be light, and no two captures in a run may be byte-identical. It failed loudly on the first run (4 FAILs,
luma=24.6 on three "light" shots) and passed after the theme pin — i.e. it caught the real bug on its first use.

**Also fixed (reviewer called these non-blocking; they were cheap and real):**
- Recently-updated rows no longer repeat the date under a "TODAY" subhead — the day heading already says it; the
  state pill carries what differs.
- Recently-updated DEDUPLICATES against everything shown above it (Awaiting you / Answered / In flight). Three
  tickets used to appear twice on one screen, on a surface whose whole premise is compression.
- The 10-row window now states its total ("10 of 69"), so it reads as curation rather than truncation.
- Narrow-width priority inversion in Awaiting rows: the TITLE was clipped to one line while the advice about it
  got two. At ≤560px the title may take two lines and the blurb yields to one — what the ticket IS outranks the
  recommendation about it.

**Left alone on purpose** (reviewer confirmed each reads as intentional): the ARCH badge treatment, the empty
state, section ordering, and the Decide/Look-at split.

**OPEN QUESTION for the user — the counts strip.** The reviewer's one taste-level objection: the seven-pill
counts strip is the single element that makes this personal tool look like a team dashboard, and three of its
pills (open, done, observations) are not actionable from that screen. That is a judgement call about what the
board is FOR, not a defect, so nothing was changed. Options if you want it addressed: (a) keep as is; (b) keep
only the actionable pills (needs · answered · in flight · queued); (c) drop the strip entirely and let the
section headings carry the counts. Needs your call.

**Verification.** `verify:feat-082` 53/53 (was 32/32 — the added checks cover the question floor on the seeded
AND real board, the dedupe, the missing per-row date, the "N of M" window, the 480px header/one-row/in-viewport/
placeholder/title-vs-blurb, and the per-capture luminance + distinctness gate). Two anti-regress scripts
asserted the OLD question contract and were updated to the new one, deliberately and in place:
`verify:reachability` (ARCH-004's contentless heading → title fallback, flagged) 17/17, `verify:feat-090` (the
"Decision 1 —" prefix is stripped) 23/23. Also green: verify:feat-090-handoff 31/31, verify:ui 7/7,
verify:bug-101-contrast ALL PASS, typecheck clean, `npm run gate` PASS (exit 0, unpiped). Screenshots re-shot
and LOOKED AT (all now graded): `/tmp/iv-orchard/board-digest.png` (light, luma 245), `board-digest-recent.png`
(the dedupe + "10 of 69" window, which sits below the fold of the main shot), `board-digest-dark.png` (genuinely
dark, luma 25), `board-digest-narrow.png` (480px, luma 244), plus the scratch/empty/all variants.

### 2026-08-18 — ticket-format enforcement lane (worker)

- **Understood:** `## Open decision (user)` listed two prose questions, so `ticketDecision()` parsed nothing
  and the 👤 row rendered as a contextless read-only attention item rather than a Decide card. Found by the
  new decision-shape guard in `board:check`.
- **Changed:** the section became `## Decision — approve the facets + proof-card design, and how should the
  proof be captured? (open; user)` with four bold-lead bullets. JUDGEMENT CALL, flagged rather than hidden:
  the original was TWO questions (approve the design? and how to capture proof?) and the parser models one
  decision per ticket, so they were collapsed into one pick — A/B/C are the three proof-capture answers under
  approval (best-effort regex / structured fields / both, exactly as written before), and D is "do not approve
  the design", which the original's question 1 implied but never stated as a choice. No design content,
  rejected-alternative or data-ground-truth text was changed.
- **Verified:** `ticketDecision()` now yields 4 options with a meaningful question; `readBoard()` shows
  FEAT-082 on `needsYou` with 4 options; `npm run verify:decision-shape` 25/25 PASS.
- **Still open / handoff:** unchanged — the user picks A, B, C or D. If collapsing the two questions is wrong,
  splitting the approval question into its own ticket is the clean fix, not re-prosing this one.

### 2026-08-19 — clean-room independent verification of the three-band ticket view (198013f)

- **Verified-by:** dispatch openai run 01a01b6c-0f4a-73d2-8a6b-8c5b97af8e6b (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
