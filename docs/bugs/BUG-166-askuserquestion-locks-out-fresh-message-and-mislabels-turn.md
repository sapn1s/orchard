# BUG-166 — an AskUserQuestion prompt locks the user out of sending a fresh message, and mislabels their reply as "main turn working"

- **Status:** OPEN
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
