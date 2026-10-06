# BUG-198 — picking another project in the sidebar silently wipes the open session's saved settings

- **Status:** IN PROGRESS — **round 3 STOPPED for a decision (2026-09-29)**: the cross-tab lost update is REAL (reproduced in ONE browser context, 3/3 forced, 12/20 unforced), but no whole-blob write can close it, because the stale copy is the browser's per-process localStorage cache. Closing it needs per-session keys, which means migrating the existing `cs-overrides` blob, and CONVENTIONS says to stop and ask before that. See the round-3 entry for options A/B/C. The round-2 verifier's OWN two-tab repro was an artifact: it used two browser CONTEXTS, which do not share storage. The four round-2 UNTESTED attacks are now in the fixer test and green (25/25), with no round-2 regression. New sibling BUG-213 was filed and NOT fixed. History: round-2 verify contract-VALID BROKEN run f594b6fd; round-1 verify contract-VALID BROKEN run 7ed11350.)
- **Severity:** medium
- **Area:** sidebar / composer (per-session overrides) — `public/app.js`
- **Reported:** 2026-09-29 by the BUG-196 round-3 fixing lane (adjacent defect found, out of scope there)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED
  (data-loss of user settings + the same view-vs-session confusion class as BUG-196; the fix lands
  in a file with a regression history — `public/app.js`).

## Symptom
A session A is open in the dock. The user clicks another project's row in the sidebar (a "look at
another project" header click — the dock still shows A). From that foreign view the next thing that
persists a per-session override — e.g. toggling permission mode — silently ERASES A's other saved
overrides. `permissionMode` (and any other armed field) that A had persisted is gone: on the next
reopen of A the setting the user had set is simply no longer there. No error, no notice.

## Repro
1. Open session A (its transcript pins any provider; A has `permissionMode: "bypassPermissions"`
   armed and persisted under its key in `localStorage['cs-overrides']`).
2. Click a DIFFERENT project's row in the sidebar. `selectProject(B)` runs; A stays open in the dock
   (`state.current.sessionId`/`encodedDir` unchanged), but `state.overrides` is cleared to `{}`.
3. From that foreign view, cause any `persistOverrides()` — e.g. change permission mode
   (`finishPermMode` → `persistOverrides`, `public/app.js:3410`), or any drawer/composer override edit.
4. `persistOverrides()` still keys off `state.current` (session A). `keep = {...state.overrides}` is
   now empty, so `Object.keys(keep).length === 0` → `delete all[k]` erases A's WHOLE entry
   (`public/app.js:924-925`), including `permissionMode`.
5. Reopen A. `restoreOverrides` finds nothing. A's setting is silently lost.

Note: A's in-memory overrides are already wiped at step 2; step 3 makes the loss durable on disk.

## Expected
The invariant: **a session's persisted overrides change only by an explicit edit to THAT session.**
Selecting a different project in the sidebar changes the sidebar selection, not the open session's
armed settings. `selectProject` must not clear (nor cause `persistOverrides` to erase) the overrides
that belong to the session still open in the dock. Clearing `state.overrides` on a project switch is
only correct when it is NOT going to be persisted back under a still-open foreign session's key —
i.e. the clear must be scoped to the session identity the overrides belong to, not to the sidebar
projectId.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play (current tree):
  - `public/app.js:5893` `selectProject(id)` — on a projectId change, `:5896`
    `for (const k of Object.keys(state.overrides)) delete state.overrides[k];` clears ALL of
    `state.overrides` regardless of which session is open in the dock. It touches only
    `state.current.projectId`; `state.current.sessionId`/`encodedDir` (session A) are unchanged, so
    the dock's subject session and the just-cleared overrides now disagree.
  - `public/app.js:914` `persistOverrides()` — the ONE `cs-overrides` writer. Keys off
    `state.current` (`k = \`${encodedDir ?? ''} ${sessionId}\``, `:918`). With `state.overrides`
    emptied it writes nothing and DELETES A's entry (`:924-925`).
  - `public/app.js:930` `restoreOverrides(encodedDir, sessionId)` — reads back the (now deleted) entry
    on reopen; finds nothing.
  - `persistOverrides()` callers reachable from a foreign view include `finishPermMode` (`:3410`),
    `pickProvider`/related (`:3364`, `:3484`), drawer override edits (`:12681`, `:13124`, `:13353`,
    `:13652`, `:13689`), and the session-init hand-off (`:11008`).
- Related tickets:
  - **BUG-196** (round 3, 2026-09-29 — "fixing lane, round 3" Activity entry): made the per-session
    provider override id-keyed and heal/strip a provider for a pinned session, and NAMED this exact
    adjacent defect for its other override fields ("selectProject() clears ALL of state.overrides
    while the dock's subject session stays A … erases A's armed non-provider overrides (e.g.
    permissionMode). Worth its own ticket."). BUG-196 removed provider from the blast radius (it is
    now stripped for a pinned id); this ticket covers the REMAINING fields. **Fix is sequenced after
    BUG-196** (both touch `public/app.js` — serialize).
  - **BUG-106** (project-switch scoping in `selectProject`), **BUG-083** (project switch leaks
    draft/running list), **BUG-194/195** (other uncommitted `public/app.js` work) — same file,
    serialize.
- Same design class as **ARCH-010** (a fact — here "which session do these overrides belong to" —
  read/acted-on by a surface that re-derived it from the wrong owner, the sidebar projectId rather
  than the open session's identity). A close should answer whether this warrants folding into that
  ARCH thread.
- Repro test: add `npm run verify:bug-198` (or extend the BUG-196 provider-lock suite's foreign-dock
  cases) — a REAL headless-browser must-FAIL over a realistic `cs-overrides` state: session A with
  a persisted `permissionMode` (and other fields), click project B, trigger a persist, assert A's
  saved non-provider overrides SURVIVE.
- Known dependencies / blockers: sequenced after BUG-196; serialize on `public/app.js`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — finding lane (Opus 4.8)
- **Understood:** Filing the adjacent defect BUG-196 round 3 named. Verified the code path READ-ONLY
  on the current tree before filing (no fixture — read the live `public/app.js`):
  - `selectProject` (`:5893`) clears all of `state.overrides` (`:5896`) whenever the sidebar
    `projectId` changes, without regard to the session open in the dock; it does not touch
    `state.current.sessionId`/`encodedDir`, so A stays the dock's subject.
  - `persistOverrides` (`:914`) keys the write off `state.current` (A) and, with the overrides
    emptied, DELETES A's `cs-overrides` entry (`:924-925`) — erasing `permissionMode` and any other
    armed field. `restoreOverrides` then finds nothing on reopen. Divergence reproduced by code path.
  - `finishPermMode` (`:3410`) is a concrete foreign-view trigger for that erasing persist.
- **Not changed:** file-only finding lane — no code changed, no live data touched. Fix is sequenced
  after BUG-196 and must serialize on `public/app.js`.
- **Still open / handoff:** the fixer should scope the `selectProject` clear (and/or `persistOverrides`)
  to the session identity the overrides belong to, so a project selection never rewrites the open
  session's key. Write a REAL-browser must-FAIL over a realistic multi-field `cs-overrides` state
  (not just the minimal case) proving A's saved non-provider overrides survive a foreign project
  click plus a persist.

### 2026-09-29 — fixing lane, round 1 (class=fix, Opus 5.5)
- **Hypothesis verified FIRST, against live code — CONFIRMED (not stale after BUG-196).** `selectProject`
  still emptied `state.overrides` on any sidebar project change (then `:5930`), and `persistOverrides`
  still keyed its write off `state.current` (session A, unchanged by the click). BUG-196 changed only
  `provider` handling in that writer; the empty-bag erase was intact. Reproduced on the REAL pre-fix
  page before any edit (below): a bare persist from the foreign view turned A's entry
  `{model,effort,permissionMode:"plan"}` into `null`.
- **Root, stated per ARCH-010:** "which session does the in-memory bag belong to" was never declared;
  the writer re-derived it from VIEW state at write time. So the bug was not only the clear. A fork
  staged from A had the same shape: `state.current` still names A until session-init, so a staged
  edit wrote under A's key.
- **Choice: the bag declares its owner (a form of option 1, "key the in-memory overrides by session
  id"). The persist-no-op-unless-edit option was rejected.** Rejected because the step-3 trigger IS an
  explicit edit. The composer acts on the dock's session A, so a permission or effort click from B's
  view legitimately persists. A "was there an edit" gate would still write the stale, emptied bag
  under A. A full `Map<sessionId, bag>` was also rejected: `state.overrides` is one object shared by
  reference with the drawer (`createDrawer({ overrides: state.overrides })`) and read in ~40 places.
  The owner stamp gives the same guarantee without that churn: the key a persist writes is the key
  the bag was loaded for, and no reader derives it.
- **Built (`public/app.js`, every hunk marked `BUG-198`; BUG-194/195, FEAT-154/155 and BUG-196 hunks
  untouched):**
  - `overridesOwner` + `ovrKeyOf` + `resetOverrides(ownerKey)` + `adoptPendingOverrides()` (after
    `declareLockedProvider`).
  - `persistOverrides` writes ONLY under `overridesOwner`. A pending bag (owner null) persists nothing.
  - `restoreOverrides` resets with owner = its own key.
  - `selectProject` no longer touches the bag.
  - `startNew` → `resetOverrides(null)`.
  - `armFork` → owner pending. Contents keep the pre-fix behaviour: a cross-project fork starts clean,
    a same-project fork keeps the source's armed values.
  - `session-init` → `adoptPendingOverrides(encodedDir, e.sessionId)` before its existing persist.
  - Dead-link route (`applyRoute`, no session) → `resetOverrides(null)`, because `selectProject` no
    longer clears there.
  - Every transition that changes which session the bag is for now declares it. Navigation and repaints
    do not write.
- **Proof — REAL page: `scripts/verify-bug-198-overrides-survive-project-switch.mjs` (`npm run
  verify:bug-198`).**
  - Setup: a real server on a free port with isolated `CLAUDE_STATION_DATA` + `CLAUDE_PROJECTS_DIR`,
    real headless Brave, and real on-disk Claude transcripts.
  - Busy store (SYNTHETIC, shaped like the user's real 64-entry store): 40 other sessions with mixed
    fields, one B session, and A = `{model:sonnet, effort:low}`.
  - Steps:
    1. A real `#planBtn` click on A.
    2. A real click on B's sidebar header.
    3. (3a) A bare `persistOverrides()` from B's view, then (3b) a real `#modelBtn` → effort click
       from B's view.
    4. A real reload of A's URL.
    5. Check `#planBtn aria-pressed=true` AND `cs-overrides[A].permissionMode==="plan"`.
  - Control: an explicit plan-OFF click on A persists.
  - Owner transitions:
    - (N) "+" new session: plan armed before the start persists nothing, then lands under the id
      session-init names.
    - (F) fork through the REAL row menu (right-click → Fork → project), same-project and
      cross-project: a staged edit leaves A byte-identical, and session-init lands the staged bag
      under the fork id.
  - AFTER (fixed tree): **14/14, exit 0.**
  - REAL PRE-FIX (frozen copy of the pre-edit `app.js`, sha256 `2dc56218…`, run in a scratch tree
    `~/.local/state/claude-station/scratch/bug198-r1/tree-pre`): **5/14, exit 1**.
    - Failed: step 2 (bag `{}`), 3a (A's entry → `null`), 3b (`{effort:"high"}` only), both step-5
      checks (plan OFF in UI, `permissionMode` gone), the control, and both fork cases (a staged edit
      rewrote A's entry).
    - The 14th row (synthesized must-FAIL) errors on that tree by design: its rewrite anchor exists
      only post-fix, so it throws loudly rather than passing vacuously.
  - IN-SUITE SYNTHESIZED MUST-FAIL (anchored to fixed text, not a revision): the served `app.js` is
    rewritten in flight. The clear goes back into `selectProject` and the persist key is re-derived
    from `state.current`; each anchor must match exactly once or the suite throws. The same scenario
    then goes red on step 2, 3a, 3b, both step-5 checks and the control, graded as one PASS row
    ("pre-fix LOSES A's permissionMode").
- **BUG-196 not regressed:**
  - `verify-bug-196-provider-lock.mjs`: **60/60**, exit 0.
  - `verify-bug-196-matrix.mjs --leg=unit,wire,order,fresh`: **225/225**, exit 0.
- **Anti-regressions:**
  - Green:
    - `verify-new-session-overrides` 5/5.
    - `verify-bug-195-new-session-nav` 6/6.
    - `verify-bug-194-palette-project-select` 9/9.
    - `verify-feat-145-session-override` 34/34.
    - `verify-openai-model-inheritance` 19/19.
  - Red, NOT mine: `verify-bug-106-crossproject-strip` 32/33. It fails "the permission SEAL chip does
    not assert A's skips prompts under B", and the SAME check fails with the same count on the frozen
    pre-fix tree (`pre-106.log`). Fresh project B registers container-isolated on this machine, so B's
    own predicted posture is "skips prompts".
  - `npx tsc --noEmit` exit 0; `npm run gate` exit 0 (unpiped).
- **Behaviour change to note:** a turn sent from a foreign view (dock A, sidebar B) now carries A's
  armed overrides. Before, they had been silently dropped for that turn because the bag was emptied.
  That follows BUG-196 round 3's model that the dock's surfaces act on `state.current`'s session.
  Pre-existing and out of scope: `setPermissionMode` reads `currentProject()` (the sidebar project B)
  for `iso` while it persists under A.
- **Could not test:**
  - A real engine turn (session-init is driven through the real `onEvent` dispatcher, not a live CLI).
  - Two live tabs.
  - A resume whose session-init names a DIFFERENT id than a non-null owner: the bag keeps its prior
    owner by design. No engine is known to do this on resume; forks and new sessions are pending
    owners.
- **regressed-from:** none. The clear predates the public history (`609db5e`). BUG-196 round 3 named
  the defect but correctly left it out of scope.
- **High-stakes:** data-loss of user settings in `public/app.js`, a file with a regression history.
  An INDEPENDENT clean-room verify is REQUIRED before VERIFIED. Suggested attacks: a drawer
  session-scope edit from a foreign view; the ignored-model heal (`effective-config.ignoredOverrides`)
  arriving after a switch; `resumeOnNextSend` / subagent views; a second tab.
- **Not done (no authority):** no git writes. `board:gen` + `board:check` run after this entry.
  Scratch: `~/.local/state/claude-station/scratch/bug198-r1/`.
- **Files:** `public/app.js`, `scripts/verify-bug-198-overrides-survive-project-switch.mjs` (new),
  `package.json` (`verify:bug-198` line), this ticket.

### 2026-09-29 — independent clean-room verify lane, round 1 (verify class, Opus 4.8 orchestrating; verifier Sonnet)
- **Verified-by:** dispatch anthropic/claude-sonnet-5 run 7ed11350-a7a8-41ad-afd8-d3f9def80d04
  (clean-room `cleanroom-verify-RVwsrD`, record `cleanroom-record-fPHQgd`,
  `scripts/independent-verify.mjs --working-tree`; contract VALID, manifest-backed [2 recorded runs])
  — **VERDICT: BROKEN.** Status → IN PROGRESS (round-2 fix required). The fix was left UNTOUCHED.
- **Isolation (charter: verifier sees ONLY the BUG-198 hunks).** Built an isolated tree
  `~/.local/state/claude-station/scratch/bug198-r1-verify/iso-only` = the round-8-proven BUG-196 iso
  tree (HEAD a977e76 + BUG-196 hunks, uncommitted 194/195/154/155 + the drawer.js Dockerfile change
  already stripped there) COMMITTED as the base (scratch throwaway repo, synthetic id
  `verify@example.invalid` per CONVENTIONS.md), then applied ONLY the 7 BUG-198 hunks to
  `public/app.js` + copied the new verify script + added the one `package.json` `verify:bug-198`
  line. The BUG-198 hunks were extracted as the pure diff between the fixer's frozen pre-fix
  `bug198-r1/tree-pre/public/app.js` (sha 2dc562…, = HEAD+194+195+196+154, no BUG-198) and the live
  `public/app.js` — 7 hunks, 48 insertions / 6 deletions, zero added lines mentioning any other
  ticket. Base app.js confirmed byte-identical to the round-8 HEAD+BUG-196 tree (sha 46ef5a…) and
  free of BUG-198 markers before the hunks were applied. Pre-flight on the iso tree: `tsc --noEmit`
  exit 0, BUG-198 owner fns present (`overridesOwner`/`ovrKeyOf`/`resetOverrides`/
  `adoptPendingOverrides`), BUG-196 `resumeProviderOf` base intact. `--working-tree` diff =
  **3/3 allow-list paths** (public/app.js, package.json, the new script), 30443 bytes, untruncated;
  docs stripped + boot stubs seeded by the harness; ambient (CLAUDE.md/AGENTS.md/.claude) stripped
  in the room. The verifier was NOT shown this ticket text or the fixer's report.
- **FIXER-TEST (the ONE canonical test):** `npm run verify:bug-198` → exit 0, **14/14** (manifest
  e8a97fa865f5). Every scenario the fix targets is green in the clean room: a real `#planBtn` arm on
  A; a real sidebar click to project B leaving A the dock's session with its bag intact; a bare
  persist and an explicit effort edit from the foreign view both landing under A (permissionMode
  kept); all 41 other busy-store entries byte-identical; A's plan mode surviving a reload; the
  control (explicit plan-OFF persists); and the owner transitions — pending "+" new session, and
  same-project + cross-project forks through the real row menu — each landing the staged bag under
  the id session-init names while A stays byte-identical. The synthesized pre-fix must-FAIL reddened
  6 checks (the divergence reproduced).
- **ADVERSARIAL that HELD — two live tabs (`adv-bug198-two-tabs`, run 8ce99b77a1c9, exit 0, 4/4):**
  two tabs editing DIFFERENT sessions with interleaved cross-tab persists; each session kept BOTH of
  its own fields, neither tab clobbered the other's saved overrides, and a reopen saw the true
  cross-tab-persisted state.
- **ADVERSARIAL that BROKE it — `pending-stale-init-vs-dead-link` (run 802f2eba5b4c, exit 1, 2/3).**
  The attack the FIXER-TEST never builds: a "+" new session is started (`startNew` →
  `resetOverrides(null)`, owner pending/null) and ABANDONED before its `session-init` arrives; the
  user then follows a DEAD LINK (route resolves to no session → `applyRoute` dead-link branch →
  `resetOverrides(null)`, still null owner) and arms an override there (bag now has content, owner
  still null); the abandoned "+" session's `session-init` then arrives LATE →
  `adoptPendingOverrides(encodedDir, staleId)` claims the dead-link-armed bag under the STALE,
  abandoned "+" id, and `persistOverrides()` writes the unrelated edit under a session the user
  abandoned. Failing check: "the dead-link-armed override is NOT attributed to the stale, abandoned
  + session id" — it WAS (`staleEntry: {permissionMode:"plan"}`). A (the originally-open session)
  was never touched, so this is not the filed data-loss-of-A defect — it is a NEW mis-attribution
  the null-owner conflation admits. ROOT (verifier's, confirmed against the diff): `resetOverrides(null)`
  is used for BOTH "pending new session, not yet born" and "no session at all (dead-link route)", so
  a late `session-init` cannot tell which pending intent the bag belongs to and adopts the wrong one.
- **UNTESTED (verifier's honest list; none counted as a break):** a genuine two-tab lost-update race
  under artificial clock control (the owner-key logic itself held under real interleaving, above);
  the `effective-config`/`ignoredOverrides` model-forgetting handler (`app.js` ~10817-10839) which
  appears to mutate `state.overrides` + `persistOverrides()` without checking the event's session id
  against the current owner — NOT verified reachable via a real stale WebSocket frame, and it
  predates the BUG-198 diff (its own comments are BUG-196), so likely a separate pre-existing
  surface, not part of this change. Worth a fixer's attention alongside the round-2 fix.
- **Verify-process note (harness framing, not substance).** The FIRST dispatch this round
  (run 751916d8-24fb-4ddc-b53e-81384c54dbf2, clean-room `cleanroom-verify-QX1779`) returned the SAME
  substantive signal but was contract-INVALID: the verifier wrapped the fixer test as
  `timeout 280 npm run verify:bug-198`, so the recorded command did not byte-match the harness-supplied
  `npm run verify:bug-198` (the contract compares character-for-character). Root was this lane's own
  requirement text ("wrap anything you are unsure will finish in timeout"). ONE sanctioned corrective
  re-dispatch with the requirement tightened (run the fixer test verbatim, wrapper only on the
  verifier's own adversarial scripts) produced the contract-VALID BROKEN above — this is a single
  framing correction, not a loop on a substantive disagreement. That first run's own FIXER-TEST was
  also 14/14 and its two-tabs 4/4; it additionally probed a stray session-init naming a foreign id
  while B is open and found NO data-loss break (the persist still landed under B's key; its one FAIL
  was an over-strict `state.current.sessionId` assertion the verifier itself downgraded to INFO).
- **DECORRELATION (honest limitation).** SAME provider (anthropic) as the Opus-class fixer, DIFFERENT
  model (claude-sonnet-5). Cross-provider (openai) not used this round. The break was found regardless.
- **Out of scope, not counted (per charter):** the BUG-196 provider/engine lock (separately verified);
  BUG-205/206/208/209; network churn (`net::ERR_*`) is UNTESTED, not a break.
- **High-stakes / independent-skeptic.** Data-loss-class change in a regression-heavy file; an
  independent clean-room dispatch (not an in-process subagent) was the right instrument and it EARNED
  its keep — it broke a fix that passed its own author's 14/14 suite. The round-2 fixer should
  distinguish the two pending intents (a "+ new session" pending owner vs. a dead-link "no session"
  state) so a late session-init can only adopt a bag armed for a still-pending NEW session, never one
  armed after the pending attempt was abandoned; and should look at the `ignoredOverrides` handler
  the verifier flagged UNTESTED.
- **Cleanup / no orphans:** kept both clean rooms + record dirs for audit
  (`cleanroom-verify-RVwsrD`/`cleanroom-record-fPHQgd` valid; `cleanroom-verify-QX1779`/
  `cleanroom-record-I8whwi` the INVALID first run), plus the iso tree, requirement, logs and
  verdicts under `~/.local/state/claude-station/scratch/bug198-r1-verify/` (`build-198.mjs`,
  `req-198.txt`, `verify.log`+`verdict.json` [invalid run], `verify-2.log`+`verdict-2.json` [valid
  BROKEN]). Only pids this lane spawned were signalled; port 4317 untouched; no `pkill`.
- **regressed-from:** n/a (verify lane; no code changed — the fix was left untouched).
- **Not done (no authority):** no git writes (the iso-tree base commit is a throwaway SCRATCH repo,
  never the real repo — CONVENTIONS.md's sanctioned verify-script exception, synthetic id). Ticket
  status header + this entry only; `board:gen` + `board:check` run after the edit.

### 2026-09-29 — fixing lane, round 2 (class=fix, Opus 5.5)
- **Hypothesis verified FIRST, against live code — CONFIRMED.**
  - `overridesOwner` was `string|null`. `startNew`, `armFork` and the dead-link branch of
    `applyRoute` all wrote `null`.
  - `adoptPendingOverrides` adopted on ANY `null`, with no check of which start the init answered.
  - Reproduced on the real round-1 code before any edit (below).
- **Found beyond the charter's reading: a missed owner path that round 1 regressed.** The
  frozen-bar fork (`#forkBtn`) is reached from a Windows-origin session or a server `needs-fork`
  refusal. It never re-owned the bag, so the owner stayed the SOURCE session A:
  - an edit made while the fork was staged wrote under A;
  - the fork's session-init did not adopt, because the owner was a session and not null;
  - so every later edit to the RUNNING fork wrote under A's key.
  - Before round 1 the key came from `state.current`, which names the fork id after its init. So
    after-init edits were correct then. **regressed-from: BUG-198 round 1.**
  - Round 1's "could not test" row assumed that forks are always pending owners. That is true of
    `armFork`, but not of `#forkBtn`.
- **Design (`public/app.js`, 17 lines marked `BUG-198 round 2`; no other ticket's hunks touched):**
  - The owner kinds:
    - `{kind:'session', key}` — the only kind `persistOverrides` writes.
    - `{kind:'pending', token}` — a unique client-side token, minted at "+" (`startNew`), at
      `armFork`, and at `#forkBtn`.
    - `OVR_NONE` — used by the dead link. It persists nothing and is never adopted.
  - `stampPendingStart(ws, bornFresh)` runs in `startTurn`, in the same tick the `start` frame is
    sent. It binds `{token, ws}` for any start that BIRTHS a session (new, or fork).
    - If the bag is not already pending, it is re-owned to a fresh token, WITHOUT touching storage.
      This covers a dead-link view, where a send is an explicit act that births a session, and a
      fresh start from another session's bag.
    - The in-memory contents are exactly what the frame carries.
  - `onEvent(e, fromWs)`: the driving socket's message listener passes its own `ws`.
  - `adoptPendingOverrides(dir, id, fromWs)` adopts only when all of these hold: the init came over
    the bound socket, the owner is still pending, and its token equals the bound token.
    - A frame from any other source (stray, injected, another socket) neither adopts nor consumes
      the binding.
  - `closeSocket` clears the binding.
  - `#forkBtn` re-owns to a fresh pending token and keeps the armed values, as `armFork` does for
    a same-project fork.
- **Owner inventory** — every path that sets or adopts the owner, checked against the invariant
  (a session's persisted overrides change only through an explicit user edit to that session):

  | Path | Owner after | Holds? | Case |
  |---|---|---|---|
  | open (`openSession` → `restoreOverrides`) | `session(key)` | yes (socket closed first) | main scenario (steps 1–5, control) |
  | new "+" (`startNew`) | `pending(new token)` | yes | N |
  | fork via row menu (`armFork`) | `pending(new token)`, same-project keeps values | yes | F same-project, F cross-project |
  | fork via frozen bar (`#forkBtn`) | was the source session (BROKEN); now `pending(new token)` | yes after fix | **W (new)** |
  | dead link (`applyRoute`, no session) | was null (BROKEN, round-1 break); now `none` | yes after fix | **S1 (new)** |
  | send that births a session (`startTurn`, new or fork) | `pending` bound to token + socket | yes | N, D (new), S2 (new) |
  | session-init adopt | `session(new id)` only for its own pending token over its own socket | yes | N, D, S2, W, F |
  | reattach / resume session-init (`reattachDriving`, `reconnectDropped`, a plain resume) | unchanged `session` | yes | **R (new)** |
  | sidebar `selectProject`, repaints | untouched | yes | steps 2–3 |

  Other writers checked: `restoreOverrides` writes storage only under its own key (the BUG-196
  heal). `declareLockedProvider` touches only `provider`. The drawer and composer edits go through
  `persistOverrides` to the owner. None of them sets the owner.
- **`ignoredOverrides` handler (the verifier's UNTESTED row, `case 'effective-config'`): NO
  mis-attribution. Filed BUG-212 (low) and did NOT fix it.**
  - `effective-config` carries no session id and arrives only over the driving socket. Every
    transition that re-owns the bag while a socket is live closes that socket first (open, new,
    `armFork` via `openSession`, dead link). A closed WebSocket delivers no further frames. So the
    frame always concerns the bag's owner.
  - `#forkBtn` does not close a socket, but it is reached only from a frozen or refused session,
    which has no live bridge. Even if a frame did arrive, a pending bag persists nothing.
  - The residual is a different class. The `!dockIsForeign()` guard is now over-conservative: under
    a foreign view the forget is SKIPPED, so an ignored model stays armed for A until a non-foreign
    start. That is a missed forget, not a wrong write.
- **Proof.** `scripts/verify-bug-198-overrides-survive-project-switch.mjs` was extended and runs as
  `npm run verify:bug-198`.
  - The owner transitions now drive the REAL composer send (`#go`) over the page's own driving
    WebSocket. `page.routeWebSocket` passes every frame through to the real server except `start`.
    The test HOLDS each `start` (no engine spawns) and answers it on that socket, so the ordering is
    forced deterministically.
  - The test answers `needs-fork` refusals and live `set-permission-mode` requests with the
    server's own frame shapes.
  - Late or stray inits go through the real dispatcher, as in the verifier's attack.
  - The cases are N, S1, S2, D, R, W, F same-project and F cross-project. S1 is the verifier's
    ordering verbatim.
  - Busy-store fixture: SYNTHETIC, unchanged from round 1.
  - **Must-FAIL on the REAL round-1 code**, run before any edit (frozen copy
    `bug198-r2/app.round1.js`): **16/19, exit 1**. S1 failed: `staleEntry {permissionMode:"plan"}`
    under the stale id. S2 failed: the stale init was adopted and the second attempt's entry was
    `null`. W failed: the staged plan was written under A and there was no fork entry. N, D, R and
    both F cases passed. (That run predates the in-suite round-1 row.)
  - **AFTER: 20/20, exit 0.** The 14 earlier checks are all green: the 10 main-scenario rows, the
    round-0 must-FAIL row, N, and both F rows. N and F now use a real send over a real socket.
  - New rows: S1, S2, D, R, W, and a **synthesized ROUND-1 must-FAIL**. That row takes the served
    `app.js`, rewrites it in flight back to the nullable owner (adopt on `kind !== 'session'`, no
    token or socket binding, no `#forkBtn` re-own, no send stamp) and requires S1, S2 and W to go
    red. They do; N, D, R and both F cases stay green. Its anchors are the round-2 text, and each
    must match exactly once or the row errors.
  - The round-0 must-FAIL anchor was updated to the new `persistOverrides` line. It still reddens
    6 checks.
  - The verifier's own `adv-bug198-pending-stale-init.mjs`, copied verbatim from the clean room,
    run and removed: **3/3, exit 0** (round 1 was 2/3).
- **BUG-196 kept green:**
  - `verify-bug-196-provider-lock.mjs`: **60/60**, exit 0.
  - `verify-bug-196-matrix.mjs --leg=unit,wire,order,fresh`: **225/225**, exit 0.
- **Anti-regressions:**
  - Green: `verify-new-session-overrides` 5/5, `verify-bug-195-new-session-nav` 6/6,
    `verify-bug-194-palette-project-select` 9/9, `verify-feat-145-session-override` 34/34,
    `verify-openai-model-inheritance` 19 passed, 0 failed.
  - `verify-bug-106-crossproject-strip` is 32/33. The SAME pre-existing seal-chip failure was
    recorded in round 1 against the frozen pre-fix tree, so it is not caused by this change.
  - `npx tsc --noEmit` exit 0. `npm run gate` exit 0, run unpiped.
- **Behaviour notes:**
  - A plan armed on a dead-link view persists nothing unless the user SENDS from there. The send
    births the session and its init keeps the bag.
  - A frozen-bar fork that is staged and then abandoned leaves A's entry untouched.
- **Could not test:**
  - A real engine turn. `start` is held; the frames come from the test's side of a real routed
    socket.
  - A frame arriving on a socket the page has already closed. The browser drops it by spec, and S2
    confirms the socket was closed before the late answer.
  - A Windows-origin frozen bar. W reaches `#forkBtn` through the `needs-fork` refusal; both open
    the same handler.
- **High-stakes:** this changes session-lifecycle and data attribution in `public/app.js`, a file
  with a regression history. An INDEPENDENT clean-room verify is REQUIRED before VERIFIED.
  Suggested attacks:
  - a start refused and then retried on a new socket (BUG-029 rollback) before its init;
  - the drain-wait self-retry;
  - two "+" attempts sent back to back.
- **Not done (no authority):** no git writes. Scratch and logs:
  `~/.local/state/claude-station/scratch/bug198-r2/`.
- **Files:** `public/app.js`, `scripts/verify-bug-198-overrides-survive-project-switch.mjs`, this
  ticket, `docs/bugs/BUG-212-ignored-model-pick-not-forgotten-while-another-p.md` (new).

### 2026-09-29 — independent clean-room verify lane, round 2 (verify class, Opus 4.8 orchestrating; verifier Sonnet)
- **Verified-by:** dispatch anthropic/claude-sonnet-5 run f594b6fd-45de-4a6f-8d1c-1a780288fa5d
  (clean-room `cleanroom-verify-pPQBXA`, record `cleanroom-record-1Ub80a`,
  `scripts/independent-verify.mjs --working-tree`; contract VALID, manifest-backed [2 recorded runs])
  — **VERDICT: BROKEN.** Status stays IN PROGRESS (round-3 fix required). The fix was left UNTOUCHED.
- **Isolation (charter: verifier sees ONLY the BUG-198 hunks, rounds 1+2).** Reused round-1's
  construction exactly. Built `~/.local/state/claude-station/scratch/bug198-r2-verify/iso-only` = the
  BUG-196 iso tree (`bug196-r6-verify/iso-only` = HEAD a977e76 + BUG-196 hunks, uncommitted
  194/195/154/155 + the drawer.js Dockerfile change already stripped there) COMMITTED as the base
  (scratch throwaway repo, synthetic id `verify@example.invalid`), then applied ONLY the BUG-198 hunks
  (rounds 1+2) to `public/app.js` + copied the new verify script + added the one `package.json`
  `verify:bug-198` line. The BUG-198 hunks were extracted as the pure diff between the fixer's frozen
  pre-fix `bug198-r1/tree-pre/public/app.js` (sha 2dc562…, = HEAD+194+195+196+154, no BUG-198) and the
  live `public/app.js` (rounds 1+2) — 12 hunks, 104 insertions / 8 deletions, **zero** added lines
  mentioning any other ticket (194/195/154/155 cancel because pre-fix and live both carry them). Base
  app.js confirmed byte-identical to the round-8 HEAD+BUG-196 tree (sha 46ef5a…) and free of BUG-198
  markers before the hunks; after apply, 22 BUG-198 markers (= live) and all round-2 owner primitives
  present (`overridesOwner`/`ovrKeyOf`/`resetOverrides`/`adoptPendingOverrides`/`stampPendingStart`/
  `OVR_NONE`). `--working-tree` diff = **3/3 allow-list paths** (public/app.js, package.json, the new
  script), 50450 bytes, untruncated; docs stripped + boot stubs seeded by the harness; ambient
  (CLAUDE.md/AGENTS.md/.claude) stripped in the room. The verifier was NOT shown this ticket text or
  the fixer's report; requirement = round-1's `req-198.txt` verbatim + an appended ROUND-2 PRIORITY
  ADVERSARIAL SURFACES block (attack surfaces only — refused-start-retry, drain-wait, two "+" back to
  back, fork-of-fork, reconnect/reattach on a different socket, and re-run pending-stale-init — no fixer
  reasoning).
- **FIXER-TEST (the ONE canonical test):** `npm run verify:bug-198` → exit 0, **20/20** (manifest
  2bafdbc4c8e4). The round-2 fix's targeted transitions are all green in the clean room: main scenario
  (steps 1–5, control); owner N ("+" → real send → own-socket init lands it); **S1** ("+" abandoned →
  dead link → armed → the abandoned attempt's LATE init does NOT adopt the dead-link bag); **S2** (a
  late init for the abandoned first "+" is not adopted by the second pending bag; the second lands
  under its own id); **D** (dead-link arm + real send lands under its own init); **R** (reattach/resume
  init naming the open session's own id leaves A byte-identical; a stray foreign init writes nothing);
  **W** (frozen-bar `#forkBtn` fork stages/lands under the fork id, never the source); F same-project
  and F cross-project. The synthesized ROUND-1 must-FAIL reddens S1/S2/W and the pre-fix must-FAIL
  reddens 6 checks. **The round-1 `pending-stale-init-vs-dead-link` break is CLOSED.**
- **ADVERSARIAL that BROKE it — `two-live-tabs-concurrent-edit` (run 255105fd9698, exit 1, 1/2).**
  Two live tabs, each with a DIFFERENT session docked, each firing a real explicit `#planBtn` edit
  near-simultaneously. Tab1's edit to A persisted (kept its other fields); **tab2's explicit plan edit
  to B VANISHED** after both settled (observed B entry `{model:opus,effort:medium}` — permissionMode
  gone). ROOT (verifier's): `persistOverrides()` does a synchronous full-blob read→mutate-one-key→write
  of `cs-overrides` with no cross-tab coordination, so the later tab's write is based on a stale read
  predating the other tab's write — a lost update. That is not "an explicit edit to that session,"
  violating invariant 5 (no field silently lost).
- **Scope caveat (honest — for the round-3 fixer / orchestrator to decide).** The non-atomic blob
  read-modify-write in `persistOverrides()` PREDATES the BUG-198 owner-tagging change; round 1's
  two-tabs adversarial HELD 4/4 under a different (interleaving) construction. So this break is not
  obviously INTRODUCED by rounds 1/2 — it may be a pre-existing localStorage-concurrency defect that
  the requirement's two-tab invariant (#1/#5) surfaces. The round-3 fixer should judge whether to fold
  a cross-tab-safe write (re-read + merge under the owner key on each persist) into BUG-198 or file a
  new sibling. Either way the verdict per the executed-evidence contract is BROKEN.
- **UNTESTED (verifier's honest list; none counted as a break):** the round-2 priority surfaces beyond
  S2 — a refused start retried on a brand-new socket before its own init (BUG-029 rollback), a
  drain-wait self-retry, a legitimate reconnect/reattach delivering session-init on a DIFFERENT socket
  for a still-pending session, and a fork-of-a-fork — were not exercised (reproducing the internal
  retry/drain/reconnect socket timing deterministically exceeded the turn budget). Also untested:
  net::ERR_* / headless boot timeouts (known host limitation). The round-3 fixer should still exercise
  the legit reconnect-adopt case, since the socket-binding guard could in principle refuse a
  legitimate adoption that arrives on a new socket.
- **DECORRELATION (honest limitation).** SAME provider (anthropic) as the Opus-class fixer, DIFFERENT
  model (claude-sonnet-5). Cross-provider (openai) not used this round. The break was found regardless.
- **Out of scope, not counted (per charter):** the BUG-196 provider/engine lock (separately verified);
  BUG-205/206/208/209; BUG-212; network churn (`net::ERR_*`) is UNTESTED, not a break.
- **High-stakes / independent-skeptic.** Data-loss-class change in a regression-heavy file; the
  independent clean-room dispatch (not an in-process subagent) EARNED its keep again — it confirmed the
  round-2 fix closed the round-1 break AND found a distinct lost-update on a fresh surface that the
  fixer's own 20/20 suite passes. A round-3 fix in this lifecycle/data-attribution area again warrants
  an independent clean-room verify before VERIFIED.
- **Cleanup / no orphans:** kept the clean room + record for audit
  (`cleanroom-verify-pPQBXA`/`cleanroom-record-1Ub80a`), plus the iso tree, pure diff, requirement,
  log and verdict under `~/.local/state/claude-station/scratch/bug198-r2-verify/` (`build-r2.mjs`,
  `bug198-pure.diff`, `req-198-r2.txt`, `verify-r2.log`, `verdict-r2.json`). Only the pid this lane
  spawned was waited on; port 4317 untouched; no `pkill`; only containers/rooms this lane created.
- **regressed-from:** n/a (verify lane; no code changed — the fix was left untouched).
- **Not done (no authority):** no git writes (the iso-tree base commit is a throwaway SCRATCH repo,
  never the real repo — CONVENTIONS.md's sanctioned verify-script exception, synthetic id). Ticket
  status header + this entry only; `board:gen` + `board:check` run after the edit.

### 2026-09-29 — fixing lane, round 3 (class=fix, Opus 5.5) — STOPPED for a decision; no product code changed
- **Verdict: needs-you.** The lost update is real. The only design that closes it needs a migration
  of existing records, so per CONVENTIONS (ARCH-010 section) this lane stopped before building it.
  `public/app.js` is byte-identical to round 2 (sha256 `caab8443…`, frozen at
  `scratch/bug198-r3/app.round2.js`).
- **Hypothesis verified FIRST, on the real round-2 page. The break is real, but the verifier's own
  repro did not show it.**
  - The round-2 verifier's `adv-two-tabs.mjs` opened two browser CONTEXTS. Contexts do not share
    localStorage. Its tab 2 never saw the seed (`{}`) and wrote B's plan into its OWN store, then the
    check read tab 1's store. Re-run here (P1): ctx2 store after = `{B:{permissionMode:"plan"}}`,
    ctx1 store after = B without plan. So that observation was an artifact.
  - The defect is real anyway. P2 (two TABS in ONE context, real `#planBtn` clicks fired together):
    **12/20** iterations lost one tab's update. P3 (forced interleave: tab 2's main thread held
    busy across tab 1's write, then its explicit edit in the same task): **3/3** real changes lost
    (the other 2 iterations were no-op toggles, so a revert could not show). Probe:
    `scratch/bug198-r3/probe.mjs` (SYNTHETIC two-entry store). The probe is the must-FAIL on the
    REAL round-2 code, not a synthesized variant.
  - **Where the stale copy comes from: neither option the charter named.** `persistOverrides()` has
    no cached blob, and its read is not early. `ovrStore()` runs synchronously in the SAME task as
    `setItem`, so the charter's "preferred" design is already what the code does. The stale copy is
    the BROWSER's per-renderer localStorage cache. A write in tab 1 reaches tab 2's cache by an async
    message, measured at **~2.4 ms idle** (`scratch/bug198-r3/latency.mjs`, 15 samples 1.7–4.2 ms),
    and it cannot land while tab 2 runs a task. So tab 2's whole-blob write carries tab 1's key back
    as it was. Any whole-blob read→write has this window; no same-task re-read closes it.
  - Web Locks do not close it either. The lock grant and the storage-change message travel on
    different pipes with no ordering guarantee, so a fix built on them would be a timing bet.
- **What closes it: each write touches only its own storage key.** localStorage applies different
  keys independently, so a stale cache in another tab cannot revert them. There are three options:
  - **(A) Per-session keys `cs-overrides:<encodedDir> <id>` with a one-time idempotent migration.**
    The blob is exploded into per-session keys on load and then removed. This is the clean ARCH-010
    answer: one place per fact. It rewrites the user's existing records, which is why this lane
    stopped. The mixed-version window matters: a tab still running old code writes to the blob,
    which nothing reads any more.
  - **(B) Per-session keys; the blob is frozen as read-only legacy (copy-on-write).** No existing
    record is modified. A session's per-key entry, when present, always wins over its blob entry;
    clearing a bag that still has a legacy blob entry writes `{}`, so the old value cannot come back.
    `declareLockedProvider` and the restore heal write per-key copies too. The cost is that a legacy
    session's fact sits in two places (per-key wins by rule), which ARCH-010 lists as "out".
  - **(C) Accept the ~ms residual and file it as its own low ticket.** A person cannot click two tabs
    ~2 ms apart. The realistic trigger is a background write in one tab (a session-init persist, the
    BUG-196 provider heals) landing while another tab runs a long task that ends in an edit.
  - Lane recommendation: **A**, if a one-time migration of `cs-overrides` is approved. Otherwise **B**.
- **The four round-2 UNTESTED attacks are now fixer-test cases. All green, no round-2 regression.**
  Each drives real `submit`→`startTurn` over the page's real routed socket, and the test answers
  that socket in the server's frame shapes:
  - (X1) a "+" start refused before ack (BUG-029 `rollBackPendingStart`), then retried by Enter
    on a NEW socket. The torn-down socket's late init adopts nothing, and the retry's own init lands
    the bag under the new id.
  - (X2) a retryable refusal, then the BUG-045 drain-wait SELF-retry, which is the client's own 7 s
    timer on a new socket. The bag lands under the retry's id.
  - (X3) a fork of a fork. F1 is a real row-menu fork, born by its init and then written to disk.
    F1 is forked again. The staged edit leaves A and F1 byte-identical, and F2's init lands the
    bag under F2.
  - (X4) the legit reconnect the verifier asked about: a pending "+" whose socket DROPPED before
    init. The init that arrives on the NEW socket STILL ADOPTS. This works because `startTurn`
    re-stamps the binding on every birth start.
  - **Synthesized must-FAIL for these cases (non-vacuity):** a client whose adoption stays bound to
    the FIRST socket (`if (!ovrStart) ovrStart = …`, anchored to the round-2 text, exactly-once or it
    throws) turns X1, X2 and X4 red. Graded as one row.
  - Honest note: X3 is graded only on the served tree. In the synthesized runs its F1 row did not
    appear in the sidebar within 10 s, because the store is busier by then. It is not graded there.
- **Found beyond the charter; filed as BUG-213 and NOT fixed (it is fork lifecycle, not the overrides
  writer).** A REFUSED FORK retries as a plain resume of its SOURCE.
  - Mechanism: `submit()` clears `forkFrom`, and the rollback re-arms `resumeOnNextSend` with the
    source id.
  - Observed on the real page: the first frame was `{fork:true, resume:A}` and the retry was
    `{fork:null, resume:A}`, carrying the fork's staged overrides.
  - BUG-198 consequence: the staged bag stays pending, because a resume is not a birth. Explicit
    edits made on the resumed source for the rest of that run are therefore not persisted.
  - Fixing BUG-213 (keep the fork intent through the rollbacks) removes that consequence.
    Probe: `scratch/bug198-r3/probe-forkrefuse.mjs`.
- **Proof / counts:**
  - `node scripts/verify-bug-198-overrides-survive-project-switch.mjs` (= `npm run verify:bug-198`):
    **25/25, exit 0**. The 20 prior rows are green, plus X1, X2, X3, X4 and the round-3 must-FAIL.
    The round-0 and round-1 synthesized must-FAIL rows still redden their targets.
  - BUG-196, unchanged by this round and re-run anyway:
    - `verify-bug-196-provider-lock.mjs`: **60/60**, exit 0.
    - `verify-bug-196-matrix.mjs --leg=unit,wire,order,fresh`: **225/225**, exit 0.
  - `npx tsc --noEmit` exit 0. `npm run gate` exit 0, run unpiped.
- **NOT in the suite, deliberately:** the two-tab forced-interleave case. It is red on the current
  code by design and belongs in the suite together with whichever fix (A/B) is chosen, as its
  must-FAIL: run the round-2 client under P3 and expect the revert. `probe.mjs` P2/P3 is that
  case, ready to port.
- **regressed-from:** none. The whole-blob writer predates BUG-198 (`609db5e`). Rounds 1 and 2 did
  not introduce the lost update.
- **High-stakes:** whichever storage design is chosen, the fix changes persistence of user settings,
  and A also migrates records. An independent clean-room verify is REQUIRED. Its two-tab attack
  must use ONE browser context.
- **Not done (no authority):** no git writes. `board:gen` + `board:check` run after this entry.
  Scratch: `~/.local/state/claude-station/scratch/bug198-r3/` (`probe.mjs`, `latency.mjs`,
  `probe-forkrefuse.mjs`, `app.round2.js`, run logs).
- **Files:** `scripts/verify-bug-198-overrides-survive-project-switch.mjs` (hunks marked
  `BUG-198 round 3`), this ticket, `docs/bugs/BUG-213-a-refused-fork-retries-as-a-plain-resume-of-its-.md`
  (new).
