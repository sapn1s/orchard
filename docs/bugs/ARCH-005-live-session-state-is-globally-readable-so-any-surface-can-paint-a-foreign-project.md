```orchard-ticket
{
  "id": "ARCH-005",
  "type": "architecture",
  "title": "Project views can show another project's live activity",
  "summary": "Selecting one project can leave three known displays showing live activity from another project. Earlier fixes protected named displays, but newly written views can still read shared session state without ownership checks. The remaining displays are deliberately unfixed until a class-wide approach is chosen.",
  "impact_if_we_wait": "Three known displays remain misleading today, and further views may repeat the fault. Bounded: this affects display correctness and trust in a single-user local tool, not security between users, data loss, corruption, or another person's information.",
  "current_need": "Build option 2: the server states which project owns a live session, and each project's view carries its own live state, so a surface reads the selected project's activity instead of working ownership out.",
  "severity": "medium",
  "area": "Project live activity display",
  "reported": "2026-08-18",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-18",
      "question": "Should direct reads be blocked first, before choosing encapsulation or project-scoped state?",
      "mode": "staged",
      "options_keys": [
        "1",
        "2",
        "3",
        "4"
      ],
      "chosen": "2",
      "chosen_on": "2026-08-25",
      "chosen_by": "user, through the ARCH-010 class decision",
      "note": "The class rule answers both stages at once, and it answers stage one by cancelling it. Stage one offered a ratchet that counts direct reads (3) or another round of per-surface patches (4); the first is the check-the-workings-out option the class decision rejects by name, and the second is patch-on-discovery, which three adversarial rounds showed does not converge. At stage two, encapsulation (1) leaves ownership derived inside an accessor, so a reader that does not call it still paints a foreign project: the same defect with fewer copies, which is explicitly not the bar. Option 2 is the only one where the owning project is stated and a view reads it."
    }
  ],
  "success_criteria": [
    "Live state reaches a view only through the project that owns it, so a new display has no raw field to read",
    "A display handed another project's session shows none of it without having to ask who owns it",
    "Foreign live state blanks while the selected project's own activity remains visible",
    "Switching away and back restores the correct live display",
    "A clean-room adversarial round finds zero new leaking displays"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "state.snap",
      "note": "One of five globally readable live-session fields."
    },
    {
      "path": "public/app.js",
      "symbol": "state.live",
      "note": "Directly read by remaining display code."
    },
    {
      "path": "public/app.js",
      "symbol": "state.effective",
      "note": "Protected only when readers use the scoped accessor."
    },
    {
      "path": "public/app.js",
      "symbol": "state.liveTools",
      "note": "Protected only when readers use the scoped accessor."
    },
    {
      "path": "public/app.js",
      "symbol": "liveWireModel",
      "note": "Protected only when readers use the scoped accessor."
    },
    {
      "path": "public/app.js",
      "symbol": "state.openProjectId",
      "note": "Ownership fact stored separately from globally readable live state."
    },
    {
      "path": "public/app.js",
      "symbol": "dockIsForeign",
      "note": "Determines whether the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "dockSnap",
      "note": "Returns absent state when the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "dockLive",
      "note": "Returns absent state when the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "dockEffective",
      "note": "Returns absent state when the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "dockLiveTools",
      "note": "Returns absent state when the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "dockLiveModel",
      "note": "Returns absent state when the open session belongs to another project."
    },
    {
      "path": "public/app.js",
      "symbol": "paintComposerFor",
      "note": "Still derives an agent thread's running display from unscoped live state."
    },
    {
      "path": "public/app.js",
      "symbol": "runningAgentCount",
      "note": "Still reads snapshot state directly for the footer count."
    },
    {
      "path": "public/app.js",
      "symbol": "paintAuto",
      "note": "Still reads live state directly for the autonomous-session control."
    }
  ],
  "related": [
    {
      "id": "BUG-083",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-106",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-122",
      "relation": "see_also"
    },
    {
      "id": "BUG-123",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-083",
    "BUG-106"
  ],
  "verification": [],
  "verification_class": "arch",
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
    "archived_path": "docs/bugs/archive/ARCH-005-live-session-state-is-globally-readable-so-any-surface-can-paint-a-foreign-project.md",
    "sha256": "dd72a9ab4fd368c9e1289662e4db6211714ecaa8b755d5e5726d13e226a589be",
    "bytes": 17574,
    "original_title": "the client's live-session state is globally readable, so any paint surface can render a project the user is not looking at",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket prose; the recurrence, four options, staged recommendation, current damage, bounds, migration, proof bar, falsifiers, and executed suite result remain represented.",
    "dropped": []
  }
}
```

# ARCH-005 — Project views can show another project's live activity

## Diagnosis

Live-session values are stored in mutable module-level fields describing the session open in the dock, while project selection is tracked separately. Any rendering function can read those values without expressing ownership. Existing accessors return absent values for a foreign dock, but raw fields remain reachable.

The project being browsed and the project owning the open session are also conflated in shared client state. They diverge when a project header is selected without opening its session, allowing different displays to choose incompatible interpretations.

## Evidence

BUG-083 fixed the first ownership boundary but left project selection untouched. BUG-106 added an ownership predicate, scoped accessors, and an enumeration test. Three adversarial rounds still found eleven leaking displays, roughly three per round, with no round finding none.

Three known direct readers remain: the composer running indicator, footer agent count, and autonomous-session control. Approximately 46 reads of five shared fields remain among 67 mentions; about 21 mentions are writes, while the display-versus-lifecycle split is not yet classified.

`suite verify:decision-shape` ran with 25/25 passing, showing that the four-option staged decision record satisfies the decision-shape checks.

## Implementation notes

Land the direct-read check with an allowlist of current readers. Classify every entry as display, non-display, or unclear, then publish the counts. Convert display readers in small families and remove their entries. If encapsulation is chosen, make raw fields unreachable after only named non-display readers remain. If project-scoped state is chosen, use per-project view objects as the conversion target.

## Verification plan

Introduce a synthetic display that reads a raw field and confirm the guard rejects it. Exercise foreign, owned, empty, and switch-back states through real project clicks in a busy browser fixture. Keep the existing BUG-083 and BUG-106 coverage passing after each batch. Finish with an independent adversarial round seeking previously unnamed leaking displays.

## Migration and rollback

Each migration batch should cover one display family and remain independently revertible. The initial ratchet creates the inventory and progress measure used by both structural options. Revert individual conversion batches if behaviour changes, but do not remove the ratchet quietly. Encapsulation becomes the final small step after the allowlist contains only named non-display readers.

## Risks

A display classification may hide lifecycle behaviour, causing silent session regressions. An allowlist can rot or permit values laundered through local variables. Project-scoped state touches writers as well as readers and has the broadest regression surface. If most raw reads serve non-display logic, encapsulation provides little value and its escape hatch becomes theatre.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — promotion lane (worker)
- **Understood:** BUG-106's third verification round is the promotion trigger its own Deeper-flaw note pre-committed to. Three independent adversaries each found a *different* surface reading `state.snap` / `state.live` directly, after a remediation designed to close exactly that class. The accessors are correct and the enumeration test is honest; neither can prevent a reader that does not use them, which is why the class survives correct patches. Filed to the ARCH contract: the invariant is stated testably (a surface's output under a foreign live session must equal its output under no live session), so this is an ARCH and not a BUG.
- **Changed:** this ticket, and an append-only entry on BUG-106. No product code, no scripts, no `public/*`, no `src/server/*`.
- **Verified:** nothing to verify — this ticket builds nothing by design. `npm run gate` run before commit, exit 0.
- **Still open / handoff:** a human picks 1, 2, 3 or 4. The cheapest information-gathering move, and the one that makes the 1-vs-2 decision evidence-based instead of a guess, is migration steps 1–2 (ratchet + classify) — those produce the direct-read inventory that nobody currently has. The three surfaces named in BUG-106's last verdict (`paintComposerFor`, `runningAgentCount`, `paintAuto`) stay unfixed pending that choice; if the decision is 4, they are three ordinary point-fixes and should be filed as such.

### 2026-08-18 — ticket-format enforcement lane (worker)

- **Understood:** the user's report was about this ticket but the defect is the ticket SYSTEM: this ticket
  declared "NEEDS A HUMAN DECISION" and argued four options as numbered prose, which `ticketDecision()`
  (`src/server/board.ts`) does not parse, so no Decide card rendered and the question never reached the rail.
  Nothing failed — the silence is the bug. Three other open tickets were in the same state (FEAT-082, BUG-104,
  FEAT-092).
- **Changed:** FORMATTING ONLY on this ticket — no argument, cost, sequencing or proof-bar text was rewritten.
  `## Options` became `## Decision — end the class by construction, guard it, or keep paying per surface?`;
  the four numbered items became bold-lead bullets keyed `1`-`4` (keys preserved, because the migration path
  and the falsification note refer to the options by number); `## Decision` became `## Decision record`; and
  the Status header gained `Recommended: 3`, which restates the migration path's own "land option 3 first"
  rather than introducing a new opinion. An INDEX.md Open row was added with Owner 👤 (the ticket had no row
  at all, so it was also failing MISSING FROM BOARD).
- **Verified:** the rail now renders it — `readBoard()` puts ARCH-005 on `needsYou` with 4 options, question
  "end the class by construction, guard it, or keep paying per surface?", recommended `3`. Before the change
  `ticketDecision()` returned null. New guard `npm run board:check` FAILED on this ticket as it stood and
  passes now; `npm run verify:decision-shape` 25/25 PASS.
- **Still open / handoff:** unchanged — a human picks 1, 2, 3 or 4. Nothing about the decision itself moved.

### 2026-08-25 — settled by the class decision (ARCH-010 option A); no build in this lane

- **Understood:** this ticket was one of eight instances of one habit, and the user settled the
  habit on 2026-08-25 instead of settling eight tickets. Applied here, the rule cancels stage one
  and answers stage two. Stage one asked whether to land a ratchet first: a ratchet counts the
  places that work the fact out, which is the option the class decision rejects by name, and the
  alternative at that stage was another round of per-surface patches. At stage two, encapsulation
  (option 1) leaves ownership derived *inside* an accessor, so a display that simply does not call
  it still paints a foreign project — the same defect with fewer copies, which the decision states
  is not the bar. Option 2 stands alone: the owning project is declared, and a view reads its own
  project's live state because that is the only live state it is given.
- **Re-measured before recording it, because this ticket is a week old and had been described to
  this lane as already fixed. It is not.** There is no declared owner anywhere on this path today:
  `RunningSnapshot` carries no project id (`src/server/running-set.ts:85-118`, built at `:210-216`),
  so nothing on the wire says which project a live session belongs to. `dockIsForeign()`
  (`public/app.js:5571-5598`) still answers ownership by comparing `state.openProjectId` with
  `state.current.projectId`, and the five `dock*` accessors are still derivations layered over five
  global slots. The three surfaces BUG-106's last verdict named are **unchanged, line for line**:
  `runningAgentCount` (`app.js:584`), `paintComposerFor` (`app.js:3507`), `paintAuto`
  (`app.js:6996`). No ratchet script exists. Roughly 34 raw reads remain outside the accessors.
  Two smaller facts found while checking: the drawer bridge is asymmetric — `getEffective`
  (`app.js:670`) reads raw while its sibling `getLiveTools` (`app.js:675`) goes through the scoped
  accessor — and the rationale comment at `app.js:5590` cites
  `scripts/verify-bug-106-foreign-surfaces.mjs`, **a file that does not exist** (the suite is
  `scripts/verify-bug-106-crossproject-strip.mjs`).
- **The prerequisite was checked, not assumed.** "Establish whether the client file is being
  replaced soon" — `public/app.js` is not being replaced; it took ordinary feature commits this
  week. So continued patching does not become reasonable by default, and option 2's cost has to be
  paid rather than waited out.
- **Changed:** this ticket's record only — the staged decision moved to `decision_history` with 2
  chosen, `human_action` is now `none`, `current_need` states the build. Two success criteria were
  restated because they were option 3's bars (a file-wide check rejecting direct reads, and a
  synthetic display being rejected before landing) and no longer describe what has to be true; the
  other three are untouched. No code, no scripts, no `public/`, no `src/`. `work_state` stays
  `open` because nothing has been built.
- **Verified:** `validateTicket` ok; `npm run board:check` exit 0, read directly. No behaviour
  changed in this lane, so there is no must-fail to show.
- **Still open / handoff:** all of the build, and it is the largest of the three the class settles.
  The first commit is the declaration, not the refactor: have the server state the owning project
  on live session state (`RunningSnapshot` has no `projectId`; the `effective` config event already
  carries one at `src/server/events.ts:29`, which is the shape to follow). Only then move the
  client's five global slots into per-project view state and delete the `dock*` derivations. **This
  is a high-stakes surface** — session lifecycle plus every paint path, with a history of three
  adversarial rounds each finding roughly three more leaks — so it wants an independent clean-room
  pass, and the fixture must be a busy multi-project state, not one project with one session.
