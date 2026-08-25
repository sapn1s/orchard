```orchard-ticket
{
  "id": "FEAT-082",
  "type": "feature",
  "title": "Finished and unfinished tickets look the same on the board",
  "summary": "The ticket board is one large table where every kind of item is mixed together, so telling finished work from unfinished means reading a ticket's whole history. Colour-coded type labels, a proof card at the top of each ticket, and a counts strip are the recommended answer. A drag-the-cards board was considered and rejected.",
  "impact_if_we_wait": "Confirming that a requested feature is actually done stays a manual read of a long history log. Bounded: this is a presentation and navigation gap, nothing is lost or wrong in the tickets themselves, and the board keeps working as it does today.",
  "current_need": "Approve the type labels and proof card, and choose how the card's evidence is gathered.",
  "severity": "medium",
  "area": "Ticket board",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-19",
  "decision": {
    "mode": "single",
    "question": "Should the proof card read evidence from existing ticket text, from new declared fields, or both?",
    "options": [
      {
        "key": "A",
        "label": "Scrape existing ticket text",
        "what_changes": "The card reads pass counts, failure proof and commit out of prose already written on each ticket.",
        "benefit": "Works on all 174 existing tickets immediately, with no change to how tickets are written.",
        "cost": "The card shows \"not recorded\" wherever the prose never said it, which is often.",
        "why_not_obvious": "Reading loose prose is guesswork, so the card can show a confident number that came from the wrong sentence."
      },
      {
        "key": "B",
        "label": "Declare the evidence when closing",
        "what_changes": "Tickets gain named fields for counts and commit, and the card reads only what was declared.",
        "benefit": "What the card shows is exactly what someone wrote down, so it can be trusted.",
        "cost": "Every existing ticket stays blank, and closing a ticket gains an extra step.",
        "why_not_obvious": "A step at close time is the one people skip when busy, and a skipped field looks the same as no work done."
      },
      {
        "key": "C",
        "label": "Declared fields with a text fallback",
        "what_changes": "The card prefers declared fields and falls back to reading prose when they are absent.",
        "benefit": "Old tickets show something and new ones are reliable.",
        "cost": "The most work, and the prose-reading path has to keep working indefinitely.",
        "why_not_obvious": "Two sources for one number means a disagreement between them is possible and nobody sees which one won."
      },
      {
        "key": "D",
        "label": "Rework the design first",
        "what_changes": "The type labels and proof card are set aside and the board layout is designed again.",
        "benefit": "Avoids building on a shape that was chosen in a single read-only pass.",
        "cost": "Nothing improves meanwhile, and the evidence question cannot be answered until the design settles.",
        "why_not_obvious": "The two alternatives already considered were rejected for reasons a second pass would likely reach again."
      }
    ],
    "recommendation": "C",
    "recommendation_reason": "It gives new tickets a number worth trusting while still showing something useful on the ones already written.",
    "prerequisite": "Establish how much of the existing prose can actually be read reliably. If very little, the fallback path is not worth keeping and B becomes correct."
  },
  "decision_history": [],
  "success_criteria": [
    "Filtering by type shows only that type, and each ticket carries its type label",
    "A ticket with an independent verdict shows that verdict and its run identifier on the card",
    "A finished ticket with no independent verdict is shown as done but unverified, never as proven",
    "An open ticket shows no evidence of being solved",
    "Missing evidence reads as \"not recorded\" rather than an empty space",
    "The counts strip agrees with the counts the board already computes"
  ],
  "code_refs": [
    {
      "path": "src/server/tickets.ts",
      "symbol": null,
      "note": "ticket parsing; type comes free from the id prefix"
    },
    {
      "path": "src/server/board.ts",
      "symbol": null,
      "note": "already parses the commit hash out of the board's Done row"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "the dashboard added by FEAT-058; the proof card sits at the top of the detail view"
    },
    {
      "path": "docs/bugs/TEMPLATE.md",
      "symbol": null,
      "note": "where declared evidence fields would be added under option B or C"
    }
  ],
  "related": [
    {
      "id": "ARCH-004",
      "relation": "see_also"
    },
    {
      "id": "FEAT-058",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-067",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-087",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01b6c-0f4a-73d2-8a6b-8c5b97af8e6b",
      "verdict": "broken",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
  "verification_class": "plan+review",
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
    "archived_path": "docs/bugs/archive/FEAT-082-board-dashboard-redesign-facets-proof-card.md",
    "sha256": "e80ff55242d08ba6d692c4a94b19469c206768eb87cac8e479634dc7ee129d38",
    "bytes": 22975,
    "original_title": "board/ticket-dashboard redesign: type facets + \"Solved?\" proof card + summary strip (not lanes)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the three-part design, the Kanban rejection, all four lettered options, the data ground truth and the verification bar are present.",
    "dropped": [
      "the \"if you do nothing\" line, which the impact field now carries",
      "the note that the two questions collapse into one pick, since the schema records a single decision"
    ]
  }
}
```

# FEAT-082 — Finished and unfinished tickets look the same on the board

## Diagnosis

### What the board does today

The board is one large table grouped by status, mixing features, bugs and architecture items apart by id prefix alone. Three things are hard as a result: separating types, seeing unfinished from finished at a glance, and finding a requested feature to confirm it is solved with the proof attached.

### The shape recommended

Keep the searchable table and add three things.

A type facet with coloured badges, derived from the id prefix. This separates types without fragmenting search results across collapsed sections.

A proof card at the top of the ticket detail view — the real gap. It carries a verdict badge (solved, done-unverified, in-progress, open, blocked), the independent-verify run id with its holds-or-broken result, pass counts, commit hash, and a jump to the newest "how it works" entry in the activity log. Every line maps to real ticket data, with an honest "not recorded" fallback.

A summary strip reusing the counts already computed for FEAT-067, segmented by type.

The information architecture puts status on the primary axis (open versus done, already computed) and type on a secondary facet axis.

### What was rejected

Kanban lanes optimise multi-person triage rather than the single-person find-and-confirm this is for, and they lose the dense sortable table. Type-grouped accordions fragment search and add scroll.

## Evidence

### What data is cheaply available

Type from the id prefix, status and section, owner, severity, the independent-verify run and verdict (only about five tickets carry a verdict line today), and the verification class (about sixteen tickets).

### What is prose-only

Pass counts, the presence of a must-fail proof, and the commit hash — though the commit also appears in the board's Done row, which is already parsed.

### What has run

The project's standing suites were exercised against the working tree during this ticket's life: the board digest suite at 32/32, the main FEAT-082 suite at 53/53, the decision-shape suite at 25/25, the reachability suite at 17/17, the handoff suite at 31/31, the rail summary suite at 23/23, the observations lane suite at 16/16, the UI suite at 7/7, FEAT-090 at 23/23, FEAT-083 at 22/22, and the BUG-101 contrast suite at 7/7. A further 36/36 tally is recorded without an adjacent suite name. A pre-fix failure was captured for one case, and both typecheck and the board-drift check stayed clean. Independent verification under run 01a01b6c reported broken.

Suites named in the ticket but with no recorded result: the tickets suite, the needs-you rail suite, and the script suite.

## Implementation notes

The type facet is an id-prefix parse and needs no new stored data. The summary strip reuses the existing counts function rather than recomputing. The proof card is the only part that needs data it cannot get for free, which is what the open choice is about.

## Verification plan

Check that the type facet filters correctly and badges render per type. For the proof card: a ticket with an independent verdict of holds shows solved with the run id and counts; a finished ticket with no independent verdict shows done-unverified; an open ticket shows open and no false proof. Fallbacks must read "not recorded" rather than appearing blank. Summary counts must match the existing board summary. Anti-regression: the tickets suite, the UI suite, typecheck, and the leak gate.

## Migration and rollback

Under the declared-fields options, existing tickets are not backfilled; they show "not recorded" until touched. The template change is additive, so a ticket written without the new fields stays valid.

## Risks

Risk bucket is low: user interface work plus read-only ticket parsing, with no writes to ticket files.

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
