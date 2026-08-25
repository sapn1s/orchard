# ARCH-005 — the client's live-session state is globally readable, so any paint surface can render a project the user is not looking at

- **Status:** OPEN — NEEDS A HUMAN DECISION (4 options below). **No build starts until an option below is chosen.** Recommended: 3 — land the ratchet first, because it is the only option that produces the inventory the 1-vs-2 choice needs, and it is a step of both. The three surfaces named in BUG-106's last verdict stay unfixed until then, deliberately: a fourth point-fix is the thing this ticket exists to stop.
- **Severity:** medium. Deliberately not higher: this is a single-user local tool, nothing is deployed, and the leak is display correctness and trust, **not** a security boundary between users — no other person's data is exposed and nothing is lost or corrupted. Deliberately not lower: the user hit it themselves, and a dashboard that reports another project's agent as running under the project in view is actively misleading about what is executing on the machine — the one question the app exists to answer.
- **Area:** client view model — `public/app.js` (the module-level live-session fields and every surface that paints from them).
- **Reported:** 2026-08-18, promoted from BUG-106 by the recurrence in its own verification record (its Deeper-flaw note names this promotion trigger explicitly, and BUG-083 is the first instance of the same conflation).
- **Recurrence evidence:** BUG-083 (first boundary), BUG-106 (second boundary, plus **eleven** distinct leaking surfaces found across three independent adversarial rounds — see below).

## Violated invariant

**No rendered surface may display state belonging to a session that the currently selected project does not own.**

That is testable as stated: for any surface S and any state where a live session owned by project A exists while project B is selected, S's rendered output must be identical to its output in a state where no live session exists at all. It is one sentence, it is checkable per surface, and every ticket in the recurrence evidence is a different surface breaking it. That is what makes this a class and not a bug.

## The design that produces the class

Live session state lives in mutable module-level fields — `state.snap`, `state.live`, `state.effective`, `state.liveTools`, `liveWireModel` — that describe **the session the dock has open**, not the project the sidebar has selected. Every paint function in a ~10,900-line file can read them, and nothing about reading them says which project they belong to. The ownership fact lives somewhere else entirely (`state.openProjectId`), in a separate predicate a reader must remember to consult.

So the default behaviour of a newly written paint function is to leak, and correctness is the exception that requires the author to know a rule that the code does not state. A leak is not a mistake in the sense of writing something wrong; it is what you get by writing the obvious thing. There is no compiler error, no runtime error, and no visible symptom in the developer's own single-project session — the bug only appears when a user has two projects and switches between them, which no unit of the code exercises by itself.

The second half of the design is that "what is on screen" has no single owner. `state.current` conflates *the project I am browsing* with *the project that owns the session I am looking at*; the dock reads one half and the sidebar reads the other. Every surface picks whichever half it happened to need. The two halves diverge the moment a project header is clicked, and nothing reconciles them.

## Why the local fixes did not hold

- **BUG-083** scoped the running strip at the `openSession` / `startNew` boundaries with a scope token. Correct for those boundaries, still intact. It left the `selectProject` boundary — looking at a project without opening a session — untouched, because that boundary was not in scope.
- **BUG-106 first fix (Option A)** added `state.openProjectId` and a `dockIsForeign()` predicate, then called it at four sites (strip, permission hairline, live-count chip, running poll). It fixed what it enumerated. An independent adversary immediately found the crown model/provider chip, which reads the same fields at a fifth site.
- **BUG-106 remediation** did the right structural thing available to it: it introduced accessors — `dockSnap()` / `dockLive()` / `dockEffective()` / `dockLiveTools()` / `dockLiveModel()`, each returning absent when the dock is foreign — and routed the paint surfaces through them, which is correct *by construction for any reader that uses an accessor*. That round found and closed seven more surfaces, including a sidebar activity dot keyed to the wrong project. It also added an enumeration test that asserts every known live-reading surface blanks under a foreign dock.
- **The remediation's own author stated the real fix and declined it**, in the ticket, honestly: making the underlying fields unreachable except through the accessors would be "an unsafe refactor of a 10k-line single-file surface with many non-paint readers." That judgement may well be correct. It is precisely why this is an ARCH ticket: the choice between "unsafe refactor" and "permanent guard" is a human's to make with the cost in front of them, not an agent's to make mid-lane under a fix charter.
- **The third adversarial round then found three more.** `paintComposerFor` computes an agent thread's running display from `th.status === 'running' && state.live`; `runningAgentCount()` reads `state.snap` directly, painting "1 agent running" in the wrong project's footer; `paintAuto()` reads `state.live` directly, leaving the autonomous-session control visible under an empty project. (Two of those three came from dispatches ruled invalid on contract shape but substantively sound — the findings are real; see BUG-106.)

The pattern across all three rounds is the same and it is the whole argument: **every round of verification finds roughly three new surfaces, and each round's fix only covers the surfaces that round could name.** The accessors made every *converted* reader safe and did nothing to make an *unconverted* reader unsafe-looking. The enumeration test can only assert about surfaces someone thought to enumerate — it reports leaks that are already known and cannot fail on one nobody listed. Three independent adversaries, three distinct surfaces, after a fix designed specifically to close the class: the design is what is wrong, not the patches.

## Decision — end the class by construction, guard it, or keep paying per surface?

Priced against the observed rate: **~3 new leaking surfaces per verification round, 11 found so far, 0 rounds that found none.** There are ~46 direct reads of the five fields left in the file (67 mentions, ~21 of them writes); an unknown subset are paint surfaces, and "unknown subset" is itself the problem.

- **1 — make a direct read impossible or loud (encapsulation).** Move the five fields behind a closure or module boundary so the only handle on them is the accessor set; non-paint readers that legitimately need the raw value get an explicitly named escape (`rawLiveUnscoped()`), which is greppable and reviewable. *Cost:* the refactor the remediation declined — every one of ~46 read sites must be classified as paint or non-paint, in the file that is the project's serialized single-file bottleneck. *Gives:* the class ends; a new paint function cannot express the leak, and an author who wants the raw field must name that intent. *Risk:* misclassifying a non-paint reader as paint changes real behaviour silently — this is the failure mode to design the migration around.

- **2 — scope the view state by construction.** Instead of gating reads, make the dock's live state hang off the owning project — one live-view object per project id, and the render pass receives *the selected project's* view. A foreign read is then not merely blocked but unrepresentable: there is no expression that reaches another project's live state from a paint function, because the paint function never had a global to reach. *Cost:* the largest — it changes the shape of the client's state, not just its access path, and touches the socket/poll write side too. *Gives:* the strongest guarantee, and it also dissolves the `state.current` conflation that produced BUG-083, rather than patching around it. *Gives up:* short-term velocity, and it is the option most likely to need its own regression round.

- **3 — a lint or test that fails on any direct read.** A grep-shaped guard: no line outside the accessor definitions may read the five fields, with an allowlist for known non-paint readers. *Cost:* a day, not a refactor; no product code moves. *Gives:* it does catch the next surface at commit time rather than at the third adversarial round, and unlike the enumeration test it is complete over the *file* rather than over the *list of surfaces someone remembered*. *Gives up:* it is a guard, not an elimination — the allowlist rots, a reader can launder the value through a local variable, and correctness still depends on a check outside the language. Cheapest real improvement available and the natural first step of options 1 and 2.

- **4 — keep patching each surface as it is found.** *Price, stated honestly rather than defaulted into:* at the observed rate this costs ~3 fixes plus a full adversarial round per round, indefinitely, with no convergence signal — the rounds are not finding *fewer* each time. It also spends the expensive resource (independent clean-room verification) on rediscovering a known class instead of on new risk, and every round ships an interval during which the dashboard lies to the user about what is running. This is a defensible choice only if the answer is "the file is being replaced anyway" — if it is not, it is the most expensive option on the list.

## Migration path

The 10,900-line single file is the central constraint: any option that requires touching it wholesale needs a way to land in pieces. Proposed sequence, each step landable and verifiable alone, and each one useful even if the next never lands:

1. **Land option 3 first, as a ratchet, allowlisting today's direct reads.** Nothing changes behaviourally; the allowlist becomes the exact, complete, machine-checked inventory of the problem — which currently does not exist. The count in that allowlist is the migration's progress bar and the honest measure of how large options 1/2 really are.
2. **Classify the allowlist**: paint / non-paint / unclear. Publish the counts on this ticket. If "unclear" is small, option 1 is much safer than it looked; if it is large, that is the evidence for or against proceeding.
3. **Convert paint readers to accessors in small batches**, one surface family per commit (crown, composer, footer, sidebar, rail), removing entries from the allowlist as they go. Each batch keeps the BUG-106 and BUG-083 suites green; each is independently revertable. The strip stays working throughout because the accessors already exist and already behave.
4. **When the allowlist contains only named non-paint readers, close the door** (option 1): the fields become unreachable, the non-paint readers use the explicit escape. This step is small *because* steps 1–3 already did the work — it is the last commit, not the first.
5. **Option 2, if chosen, is a re-entry at step 3** with per-project view objects as the conversion target instead of accessors. Deciding 1 vs 2 can therefore be deferred until after step 2 produces the counts, which is the point of sequencing it this way.

Rollback at every step is a single revert; the ratchet in step 1 is the only thing that must not be reverted quietly.

## Proof bar — and the thing that is hard to prove

The redesign is right if:
- **Completeness over the file, not over a list.** The guard/type boundary fails on *any* direct read introduced anywhere in the file, including in a surface that did not exist when the guard was written. This is the property the current enumeration test does not have.
- **A synthetic new leak is caught.** Write a fresh paint function that reads a raw field and renders it; the guard must fail before that code can land. A test that could only fail on the eleven already-known surfaces proves nothing.
- **Both directions still hold** at every step: foreign state blanks, the selected project's OWN live work still shows, an empty project shows nothing, switching back restores the real state — over a *busy* fixture (several projects, several sessions, one live) and driven through the real click path in a real browser, not a clean two-project minimum.
- **A next adversarial round finds zero new leaking surfaces.** Necessary, not sufficient.

**The observability difficulty, stated plainly:** "no new surface leaked" is not directly observable, because a surface nobody enumerated cannot be asserted about. This is why an enumeration test is structurally the wrong instrument no matter how many entries it has. What *is* observable, and is therefore the real proof bar, is the **absence of the capability**: zero direct reads outside the accessor set, machine-checked over the whole file, with the escape hatch named and countable. Option 1 makes that observable at the language level; option 3 makes it observable at commit time; option 4 never makes it observable at all.

**What would falsify the redesign:** if step 2's classification shows the raw fields are read predominantly by *non-paint* logic (socket handlers, lifecycle, queueing) and only marginally by paint, then encapsulation buys little — the escape hatch would swallow most of the call sites and the guard would be theatre. In that case the right answer is option 2 or a scoped re-render pass, and options 1/3 should be abandoned rather than half-landed. Equally falsifying: if a converted surface regresses real behaviour because a reader classified as "paint" was load-bearing for lifecycle, the conversion is not mechanical and the batch size is wrong.

## Decision record (filled in once an option above is chosen)

- **Chosen option:** — (pending; human decision required)
- **Explicitly rejected:** — (record here with the reason, so the next round inherits the judgement)

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
