# BUG-166 — an AskUserQuestion prompt locks the user out of sending a fresh message, and mislabels their reply as "main turn working"

- **Status:** DONE
- **Severity:** medium
- **Area:** composer / bridge / turn-labelling (AskUserQuestion handling)
- **Reported:** 2026-09-05 by the user (relayed via ARCH-016 build lane — file only, do not fix in that lane)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
When the orchestrator presents an **AskUserQuestion**, the user is **locked out of
sending a new, unrelated message** — the only thing the UI lets them do is reply to
the question. They cannot start a fresh turn/topic until they have answered.

Then, when they **do** answer the AskUserQuestion, the turn is **mislabelled as
"main turn working"** — the reply is not presented as the user's own initiated
turn, it is shown as if the main turn is busy/working.

## Repro
1. Have the orchestrator raise an `AskUserQuestion` (the interactive picker prompt).
2. Try to type and send a NEW message on the main thread that is NOT an answer to
   the question → the composer does not let it through; the user is forced to
   answer the question first.
3. Answer the AskUserQuestion → observe the turn label reads "main turn working"
   instead of reflecting a user-initiated reply.

## Expected
- Presenting an AskUserQuestion must NOT block the user's own composer. A user must
  always be able to send a fresh message (BUG-159 already established this
  principle for a busy session: a typed message is HELD, never refused). An
  AskUserQuestion is a prompt for input, not a lock on all input.
- Answering the AskUserQuestion should be labelled honestly as the user's reply /
  a user-initiated turn — not as "main turn working".

## Context / likely-related
- BUG-159 made a busy session HOLD a typed message rather than refuse it, and
  fixed a related mislabel: "even if the current `busy` was a stuck woken claim,
  this interject will drive a real turn, so the honest-main-turn gate must stop
  downgrading it" (`#turnUserInitiated = true` in `AgentSession.send`,
  `src/server/agent-bridge.ts`). The AskUserQuestion path appears to have the same
  two defects BUG-159 fixed for the general busy case: (a) the composer is gated
  off, and (b) the resulting turn is not marked user-initiated. Start there and in
  the client composer's AskUserQuestion state.

## Symptom of a deeper design flaw?
Possibly — this is the second instance (after BUG-159) of "an in-flight prompt/turn
state wrongly gates the user's own composer and then mislabels their reply." If a
third surfaces, file an ARCH. For now: no ARCH — treat as a scoped `fix`.

## Activity log (append-only)

### 2026-09-05 — filed by ARCH-016 build lane
- **Understood:** the user reported this UX bug while ARCH-016 was being built; my
  charter was to FILE it with the repro, not fix it. Filed here verbatim.
- **Did NOT investigate or fix** — this is a file-only handoff. Next agent: confirm
  the AskUserQuestion composer-gate in the client and the turn-label path in
  `agent-bridge.ts` (see Context), reproduce both halves (lockout + mislabel), and
  fix in a dedicated lane.

### 2026-09-23 — fixing lane (round 1, class=fix; public/app.js only)
- **Hypothesis CONFIRMED against the code.** Both symptoms trace to one signal,
  `state.busy`, being read by two client surfaces that need to tell "the model is
  working" from "the model is paused on a question, waiting on the user" — which
  `busy` cannot do. (a) LOCKOUT: `submit()`'s busy branch dropped a fresh message
  into the CLIENT hold-queue (`queueMessage`), which only flushes at a client
  `turn-end` — and a pending AskUserQuestion produces none until the user's OWN
  answer, so the fresh topic was held behind the question. (b) MISLABEL:
  `computeSessState()` returned `'thinking'` → "Thinking… / Claude is working".
  The composer is NOT DOM-disabled; the "lockout" is the silent hold, not a
  refusal. NB the `state.decisionsByRequest` map already existed but was
  write-only (no readers) — the perfect unused owner.
- **Fix (ARCH-010).** The pending question is declared the OWNER of "the model
  stopped, waiting on you": `decisionsByRequest` holds exactly the cards still
  awaiting the user, and is now PRUNED the instant a card settles
  (`settleDecisionOwner`, called from the answered path and
  `settleDecisionFromResult`). A single declaration, `awaitingUserDecision()`,
  reads that map; BOTH readers consult it instead of re-deriving from `busy`:
  - `computeSessState()` → new `'awaiting'` state ("Waiting on you"), gated on
    `busy` so a card left behind by a finished turn can't wedge an idle session.
  - `submit()` routes a fresh send during a pending decision down the server send
    path (BUG-159's HELD-not-refused channel, `#turnUserInitiated`) instead of the
    silent client hold-queue — so it LANDS as the user's turn.
- **BUG-150 respected:** no change to `resetTranscript`/`queueKey` ownership; the
  edits are in the decision helpers, `computeSessState`, `SESS_STATUS_META`,
  `submit`, and the `__station` test surface. No conflict.
- **Proof (real browser, real server, real render path):**
  `node scripts/verify-bug-166-decision-composer.mjs` → 10/10 PASS. Renders a REAL
  AskUserQuestion card, drives REAL `submit()`/`computeSessState()`. Must-FAIL
  baseline is a CONSTRUCTED pre-fix client (awaitingUserDecision neutered to
  `return false`, hit-count asserted, NOT HEAD): it reproduces BOTH symptoms from
  one neuter (label `'thinking'`; message held, queue +1, nothing sent). Synthetic
  busy+pending-question fixture (stated): no live model — the lockout+mislabel are
  purely `(busy && a pending card)`, both produced by the real code under test.
- **Anti-regression:** `verify-bug-150-load-window-queue.mjs` 16/16,
  `verify-bug-150-adversarial.mjs` 25/25, gate exit 0. `verify-decisions.mjs` is
  17/18 with the one failure a LIVE-MODEL harness timeout in §5 (waits for a real
  haiku session to close) — that suite drives the server over raw WS and never
  loads `app.js`, so a client-only change cannot affect it; environmental.
- **Residual for the verifier (server-side, out of this lane's file scope):** the
  ticket's literal phrase "main turn working" is the SERVER honest-main-turn gate
  (`hasMainThreadWork`/`#turnUserInitiated`, `agent-bridge.ts`). Answering a
  question is a `question-response` that resumes the SAME turn and does NOT run
  `AgentSession.send`, so it never sets `#turnUserInitiated` the way BUG-159's
  send path does. This lane fixed the CLIENT session-status label (the proof the
  charter named); whether the server-side turn-attribution on the
  `question-response` path also needs BUG-159's `#turnUserInitiated = true` is a
  separate, server-scoped question worth an independent look.
- **Verification class:** this is session-lifecycle-adjacent (composer send path +
  turn labelling). An independent clean-room verify pass is warranted before
  VERIFIED — flagged per the standing high-stakes rule.

### 2026-09-23 — independent verify (round 2, class=verify) — PASS
- **Ran, real output:** fixer suite `verify-bug-166-decision-composer.mjs` 10/10.
  Regressions `verify-bug-150-load-window-queue` 16/16, `verify-bug-150-adversarial`
  25/25. Own adversarial browser probe (5 attacks the fixture does not cover) 5/5.
- **Attacks & outcomes:** (A) two questions pending at once — settle one, other
  still keeps `awaiting`: PASS. (B) INVERSE FAIL hunted — after a card settles the
  label must NOT stay stale-`awaiting` while the model works: returns to `thinking`,
  card pruned: PASS. (C) an answered-but-unpruned card is guarded by the `answered`
  flag in `awaitingUserDecision()`, not counted: PASS. (D) session-boundary leak —
  `resetTranscript()` (the single BUG-150 boundary, line 3499) clears
  `decisionsByRequest`, so it cannot leak across sessions/projects: PASS. (E) a card
  lingering with `busy=false` (finished turn) does NOT read `awaiting` — the label is
  gated on `busy`: PASS. A never-resolving requestId leaves the composer UNLOCKED and
  the label `awaiting` — the SAFE direction (model genuinely is paused), not a FAIL.
- **User-observable:** confirmed against the REAL client in a real headless browser:
  with a card pending the send lands on the wire (`type:"send"`, tracked as
  `pendingSend`), the queue does not grow, and `#sessStatusLbl` reads "Waiting on you".
- **Server-residual answer (charter item 5): NO server change is required for the
  user-visible symptom.** The literal "main turn working" is NOT a server string —
  grep finds it nowhere; it is the user's paraphrase of the CLIENT label
  "Thinking… / Claude is working" (`SESS_STATUS_META`/`computeSessState`), now owned
  and fixed client-side. The server honest-main-turn gate
  (`hasMainThreadWork`/`#turnUserInitiated`, `agent-bridge.ts`) governs liveness/reap,
  not the visible label. `answerQuestion()` resolves the pending approval promise and
  resumes the SAME turn — the turn that raised the question was opened by a user
  `send()`, so `#turnUserInitiated` was already `true`; nothing to re-set. The fresh
  interject during a pending question DOES reach `AgentSession.send`, which holds it in
  the runtime InputQueue and sets `#turnUserInitiated = true` (agent-bridge.ts:1677) —
  fully wired.
- **Could NOT test (and why):** (1) a real live-model AskUserQuestion end-to-end — no
  cheap deterministic steering; fixture is synthetic busy+pending-card, faithful for
  this bug (same basis the fixer stated). (2) Multi-client cross-tab answer race —
  reasoned only: after another client answers, THIS tab keeps the card until its own
  `tool-result` arrives, a bounded window where it reads `awaiting` and permits a send
  (held server-side, never lost) — minor, not data-loss. (3) LIMITATION (not a
  regression): reload with a genuinely-pending question does NOT re-register the card —
  `renderMessages` replays a persisted AskUserQuestion as a plain `historyChip`, not
  through `renderQuestion`, so `decisionsByRequest` is empty after reload and both
  symptoms could reappear if the server re-marks the session busy. Pre-existing (the
  question isn't even answerable after reload); out of this fix's scope, worth a
  follow-up note.
- **Verdict: PASS.** No code modified. Anti-regressions named and green.
- **Verified-by:** independent verify lane (round 2, class=verify), clean-room, ticket
  excluded from own generation.

### 2026-09-29 — closing (verifying, round 1)
- **Closed as DONE (obsolete: fixed + independently verified; only the status flip remained).**
- **Recheck (current tree):** fix present at commit 7d652c6 ("BUG-166: a pending question is the owner of 'waiting on you'"). `public/app.js` carries `decisionsByRequest` as the owner (`:211`), `awaitingUserDecision()` (`:9210`), `settleDecisionOwner()` (`:9249`), and `computeSessState()` returns `'awaiting'` gated on `state.busy` (`:10462`). Cites the 2026-09-23 round-2 independent verify: PASS (fixer suite 10/10, adversarial 5/5, BUG-150 regressions 16/16 + 25/25). Round 2 also answered the server-residual: no server change required for the user-visible symptom.
- **Symptom of a deeper design flaw?** no — the prior log noted this is the 2nd instance of "an in-flight state gates the composer"; still below the "third → file ARCH" threshold. No ARCH filed.
