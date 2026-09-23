# BUG-174 — A cancelled tool call is reported to the model as a user rejection

- **Status:** FIXED (PARTIAL — option A chosen and built, 2026-09-08). The three deny messages Orchard owns and that reach the model verbatim now each name their own mechanism; the standing instruction was corrected, not deleted. **The originally-reported case (an interrupted turn reported as a user rejection) is STILL NOT FIXED** and cannot be fixed in this repo: the CLI discards Orchard's abort message and substitutes its own `user-rejected` text. Awaiting independent verification before VERIFIED.
- **Severity:** medium
- **Area:** server (agent-bridge / canUseTool denial messages)
- **Reported:** 2026-09-08 by fixing lane (round 1)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
A model in an Orchard session is told **the user rejected its tool call** when the
user did nothing at all — the turn was merely interrupted while a permission card
was pending. The reader stops and waits for a person who never objected, and work
that was never blocked stalls. The orchestrator has made that false report to the
user more than once.

The text the model receives is indistinguishable from a genuine denial:

> The user doesn't want to proceed with this tool use. The tool use was rejected
> (eg. if it was a file edit, the new_string was NOT written to the file). STOP
> what you are doing and wait for the user to tell you how to proceed.

Three different events currently read almost identically — a cancel/abort, a real
user denial, and a rule/hook block — and they share the opener "The user doesn't
want to…", so a reader that pattern-matches the opener attributes all three to
the user.

## Repro
1. Start a session; have the model call a tool that needs approval.
2. While the approval card is pending, interrupt the turn (Orchard resolves the
   pending card at `agent-bridge.ts:3408` with `{behavior:'deny', message:'aborted'}`).
3. Read the tool_result the model received.

Observed: the CLI's **`user-rejected`** literal above, `toolDenialKind:"user-rejected"`.
Orchard's `'aborted'` string is nowhere in it.

Reproduced standalone, twice, deterministically:
`node scripts/scratch-denial-probe-abort.mjs` (real SDK query, real interrupt,
reads the real transcript the CLI wrote).

## Expected
A model reading a stopped tool call can tell **cancellation**, **user rejection**
and **rule/hook block** apart from the message text alone, without inference —
and the cancelled case never attributes intent to the user.

## Decision — how far do we go, given Orchard only controls three of the five sites?

**TAKEN 2026-09-08: A** (not re-litigated here — see the round-2 log entry for what
was built and what it does not fix).

- **A — Fix the three sites Orchard actually owns; correct (do NOT delete) the standing instruction.**
  Rewrite the deny literals whose text is proven to reach the model verbatim (user
  Deny, plan reject, dashboard deny) so each names its own cause. The abort and
  session-close sites stay as they are, because their text is discarded. Then
  **rewrite** `~/.claude/CLAUDE.md`'s denial section rather than removing it — it is
  still needed, and it is currently **wrong** (it says "doesn't want to proceed" is
  always a genuine denial; in an Orchard-aborted turn it is not). Cost: a small text
  change plus a corrected instruction. Buys: three of five cases self-describing, and
  the reader stops being actively mis-taught. Does not fix the reported case.
- **B — Change nothing in Orchard; correct the standing instruction only, and file upstream.**
  Accept that the wording is the CLI's, correct `~/.claude/CLAUDE.md`, and open an
  issue asking that the interrupt path get the treatment its siblings already got
  ("Nothing refused it; re-run it if still needed."). Cost: nothing now. Buys: the only
  path to a real fix for the reported case. Leaves three fixable sites unfixed and
  keeps a standing token cost in every session.
- **C — A, plus investigate an Orchard-side annotation for the abort case.**
  As A, but additionally test whether Orchard can annotate the abort at a point it
  *does* control — e.g. prepending one line to the next user frame it delivers into a
  session whose turn it just interrupted with a card pending. Cost: an investigation
  lane with a real chance of coming back empty (hooks were already proven unable to
  see a cancel — `_scratch-denial-hook-options.md` §3). Buys: the only in-repo route
  to fixing the case that actually cost the user trust.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `src/server/runtime/claude-runtime.ts:590` — passes `canUseTool` into the Agent SDK.
  - `src/server/agent-bridge.ts:3408` — abort resolves a pending card: `'aborted'`. **Text discarded by the CLI.**
  - `src/server/agent-bridge.ts:2642` — session close: `'session closed'`. Same family, untested.
  - `src/server/agent-bridge.ts:1890` — user pressed Deny: `'Denied by user'`. **Reaches the model verbatim.**
  - `src/server/agent-bridge.ts:1870` — plan rejected: `'The user rejected this plan — keep planning.'` **Verbatim.**
  - `src/server/survivor-delivery.ts:210` — dashboard deny: `'denied from the dashboard'`. **Verbatim (same channel).**
- Probes (scratch, kept as the repro): `scripts/scratch-denial-probe.mjs` (plain deny),
  `scripts/scratch-denial-probe-abort.mjs` (abort path).
- Related: `docs/bugs/_scratch-denial-diagnosis.md`, `docs/bugs/_scratch-denial-hook-options.md`
  (prior lane; its §5 claim that all five literals are effective is corrected here).
- Known dependencies / blockers: the wording on the abort path is a compiled string
  literal in the CLI bundle (2.1.263) — not configurable, no override path.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — fixing lane, round 1 (investigation; STOPPED before editing, per charter)

- **Understood:** The dispatch's hypothesis was that all five deny literals are
  Orchard-authored with no external consumer, making this a contained text change.
  The charter required verifying that against the code first and stopping if any
  site turned out to be a pass-through of CLI-generated text. It is one — and it is
  the site the bug is about. **No source file was edited and `~/.claude/CLAUDE.md`
  was NOT deleted.**

- **Verified (mechanism, live, against the real CLI and real transcripts):**

  1. **Nothing in `src/` contains the three ambiguous literals.** They are CLI
     constants, not Orchard text:
     `grep -rn "doesn't want to" --include=*.ts --include=*.tsx --include=*.mjs .`
     → hits only in `docs/bugs/_scratch-denial-*.md`. Orchard authors the *deny
     reasons* it hands to `canUseTool`, not the sentences the model reads.

  2. **A plain `canUseTool` deny DOES reach the model verbatim** —
     `node scripts/scratch-denial-probe.mjs`:
     ```
     [probe] canUseTool fired for Bash; denying with "ORCHARD-PROBE-DENY-MARKER-XYZ"
     === tool_result frames the MODEL saw ===
     "ORCHARD-PROBE-DENY-MARKER-XYZ"
     containsOrchardMessage=true
     ```
     In the transcript it is classified `toolDenialKind=permission-rule`, content
     exactly `"ORCHARD-PROBE-DENY-MARKER-XYZ"` — no CLI prefix, no wrapper. So for
     the deny sites, rewriting the literal fully controls the model-visible text.

  3. **The abort path DISCARDS Orchard's message** — `node scripts/scratch-denial-probe-abort.mjs`,
     run twice, identical both times:
     ```
     [probe2] canUseTool pending for Bash; interrupting turn
     [probe2] abort signal fired -> deny(ORCHARD-ABORT-MARKER-XYZ)
     === tool_result frames the MODEL saw ===
     toolDenialKind=user-rejected
     "The user doesn't want to proceed with this tool use. The tool use was rejected
      (eg. if it was a file edit, the new_string was NOT written to the file). STOP
      what you are doing and wait for the user to tell you how to proceed. …"
     containsOrchardMessage=false
     ```
     The probe resolves the deny synchronously inside the abort handler — exactly
     what `agent-bridge.ts:3408` does — and the CLI still substitutes its own
     `user-rejected` literal. Changing `'aborted'` would have had **no effect on
     what the model reads**.

  4. **Worse than the dispatch assumed, and worse than the prior lane's note.** An
     Orchard-interrupted turn is labelled `user-rejected`, not `cancelled`. The
     existing standing instruction in `~/.claude/CLAUDE.md` teaches that "doesn't
     want to **proceed with this tool use**" is the *only real* user denial — which
     is precisely the string an Orchard abort produces. The instruction is not
     merely redundant; on this path it is **wrong**, and deleting it (dispatch step
     5) would have removed a caution while leaving the misattribution intact.

  5. **Corpus check on real transcripts** (`~/.claude/projects`, 437 files carrying
     `toolDenialKind`): 991 `permission-rule`, 90 `user-rejected`, 13 `cancelled`.
     Sampling every distinct denial text found **no** occurrence of any
     Orchard-authored string (`Denied by user`, `denied from the dashboard`,
     `keep planning`, `session closed`, `aborted`) in a real tool_result — the only
     matches were file contents an agent had read. Consistent with (3): the paths
     that would have shown Orchard's text are rare, and the common stop paths are
     CLI-generated.

- **Changed:** nothing in `src/`. Added two scratch probes:
  `scripts/scratch-denial-probe.mjs`, `scripts/scratch-denial-probe-abort.mjs`.
  Both use a scratch cwd (`/tmp`) and `settingSources: []`.
  Note for anyone re-running probe 1: a bare tool name in `allowedTools`
  auto-approves before `canUseTool` is consulted, and local settings allow-rules
  shadow it too — the first run silently never fired the callback. Use a command no
  allow-rule covers.

- **Still open / handoff:** the decision above. If A or C is chosen, the wording
  the prior lane suggested is a good starting point for the three effective sites
  (`'DENIED BY THE USER at the approval prompt. …'`), and the fix's test can reuse
  `scripts/scratch-denial-probe.mjs` — it already prints the model-visible string.
  Also still untested: whether `agent-bridge.ts:2642` (`'session closed'`) reaches
  the model or is discarded like the abort; it is in the same teardown family, so
  assume discarded until probed.

- **Symptom of a deeper design flaw (round 1)?** Not closing the ticket, so not answered.
  Worth flagging for whoever does: the invariant the dispatch wrote ("a model can
  tell the three cases apart from the message text alone") is **not fully
  achievable inside Orchard**, because the component that owns the fact (the CLI's
  interrupt handler) is not the component we can edit. That is the ARCH-010 shape
  failing across a process boundary we do not control.

### 2026-09-08 — fixing lane, round 2 (option A implemented)

- **Decision taken:** **A**, as recommended. Fix the three sites Orchard owns whose
  text is proven to reach the model verbatim; leave the abort/session-close sites
  alone (their text is discarded); keep the corrected standing instruction in
  `~/.claude/CLAUDE.md` (already rewritten in round 1 — **not touched here**).

- **Changed (3 literals, model-visible; each now names its own mechanism):**
  - `src/server/agent-bridge.ts` — `answerApproval()` deny default:
    `'Denied by user'` →
    `'DENIED AT THE ORCHARD APPROVAL PROMPT — the user saw this call and said no. Do not retry it; ask what they want instead.'`
  - `src/server/agent-bridge.ts` — `answerPlan()` reject default:
    `'The user rejected this plan — keep planning.'` →
    `'PLAN REJECTED BY THE USER at the Orchard plan prompt. Keep planning; do not start executing.'`
  - `src/server/survivor-delivery.ts` — dashboard deny default:
    `'denied from the dashboard'` →
    `'DENIED FROM THE ORCHARD DASHBOARD — the user declined it there, not at a prompt in this session. Do not retry it; ask what they want instead.'`

  All three keep the useful half of the old text (what to do next), none attributes
  intent to a user who did not act (all three fire only on a real human answer), and
  no two share an opener. The line numbers in the context pack above have shifted by
  a few lines — each literal is now a multi-line object with a `BUG-174` comment.

- **STILL BROKEN AFTER THIS CHANGE — the case that was originally reported.** An
  interrupted turn with a pending permission card still reaches the model as the
  CLI's `user-rejected` literal ("The user doesn't want to proceed with this tool
  use…"). `agent-bridge.ts`'s abort resolution (`signal … deny 'aborted'`) is a
  pass-through: the CLI throws Orchard's message away (round 1 proved this twice,
  live). Nothing in this repo can change that text. This ticket fixes three
  *neighbouring* cases so they can no longer be confused with it; it does not fix
  it. Do not read the status header as "closed".

- **Proof — must-FAIL before, PASS after.** New test:
  `scripts/verify-bug-174-denial-wording.mjs`. It hardcodes no expected sentence:
  the two agent-bridge defaults are extracted from the real source (the run ABORTS,
  exit 2, if extraction finds nothing — a green on missing input is worse than no
  test), and the dashboard default is **observed on the real wire** — a fake broker
  socket accepts a real `deliverIntoSurvivor()`, sends a real `can_use_tool`
  control_request, and the test reads the deny message out of the resulting
  `control_response` bytes. It prints all three strings, then asserts: distinct
  text, distinct 4-word opener, each mechanism word ("approval prompt" / "plan" /
  "dashboard") owned by exactly one message, each says what to do next, none opens
  with the CLI's ambiguous phrasing, each ≤160 chars (hot path).

  Command: `node scripts/verify-bug-174-denial-wording.mjs`

  BEFORE the change — **exit 1**:
  ```
  === model-visible deny strings ===
    [agent-bridge answerApproval (user pressed Deny)]      "Denied by user"
    [agent-bridge answerPlan (plan rejected)]              "The user rejected this plan — keep planning."
    [survivor-delivery … dashboard deny) [OBSERVED ON WIRE]] "denied from the dashboard"
  …
  BUG-174 denial wording: FAIL — 3 problem(s)
    - mechanism word "approval prompt" appears in exactly one message — found in: none
    - approval prompt: says what to do next
    - dashboard: says what to do next
  ```
  AFTER the change — **exit 0**, 19/19 checks ok, printed strings exactly the three
  new sentences above, including `ok  wire-observed dashboard text matches the
  source literal`.

- **Dependents on the old wording:** grepped `--include=*.ts,*.tsx,*.mjs,*.js,*.html,*.md`
  for `Denied by user` / `denied from the dashboard` / `keep planning`. **No code
  consumer parses these strings** — the only non-source hits are this ticket and
  `docs/bugs/_scratch-denial-hook-options.md` (both quoting the old text as
  history; left as written, since an append-only log must keep saying what was
  true then). `public/` renders the deny reason as opaque text. Nothing to update.

- **Not done, deliberately:** `agent-bridge.ts` session-close (`'session closed'`)
  is still unprobed — same teardown family as the abort, so presumed discarded;
  rewording it would be unverifiable cosmetics.

- **Verification posture:** low-risk (three string defaults, no control flow
  touched, `npm run gate` PASS incl. typecheck). Independent verification is
  cheap here and the ticket's class asks for it; the one thing worth an outside
  eye is the claim that no consumer parses the old text.
