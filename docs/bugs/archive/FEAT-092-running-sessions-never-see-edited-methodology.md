# FEAT-092 — a running session never sees an edited instruction doc, so the longest-lived session is the most stale

- **Status:** OPEN — NEEDS DECISION: build the per-turn amendment channel, or accept the cheap workaround. Nothing is broken for users; this is a "should we build it at all" call, not a fix to schedule.
- **Severity:** medium
- **Area:** bridge (session construction + per-turn seam) / templates (instruction composition) / methodology docs
- **Reported:** 2026-08-18 by user (from a read-only investigation; evidence reused below, not re-derived)
- **Verification-class:** plan+review — this ticket records a proposal and a decision, it builds nothing. If the amendment channel is later approved, THAT work is `fix` and needs independent verification.

## In plain terms

Injected methodology — the Working Agreement, the project conventions, provider routing, the response-format
spec — is what actually governs how a session behaves. That text is composed **once**, when the session's
process starts, and handed to the CLI as its system prompt. **Nothing re-reads it.** So the moment you edit
any of those documents, every session already running keeps behaving by the old version until its process is
replaced. The edit ships and reaches nobody who is already working.

**Why it matters:** this is the same shape as the deploy-lag rule already in `docs/CONVENTIONS.md` — a change
that lands in the tree but does not reach the running system. The whole method here depends on injected
instructions actually steering behaviour. The cruel part is the asymmetry: the **longest-lived** session —
usually the orchestrator session you talk to all day — is the one that has had the most time to go stale, so
your most important session is the one most likely to be running yesterday's rules.

**Why this is not an alarm:** nothing is broken for users, and the workaround is cheap. Cycle the session
(any path that reconstructs it re-reads the docs), or just paste / ask it to read the changed doc mid-session.
Recording "the workaround is sufficient, do not build the channel" is a legitimate and possibly correct
outcome of this ticket.

## Decision — accept the cheap workaround, or build the per-turn amendment channel?

This ticket exists to put that choice in front of a human rather than let it be made by default (by nobody
building anything).

- **A — accept the workaround, and write it down as the standing practice.** Cycle the session (any path that
  reconstructs it re-reads the docs), or paste / ask it to read the changed doc mid-session. *Cost:* nothing
  to build. *Gives up:* the lag stays, and it stays worst on the longest-lived session — the orchestrator you
  talk to all day. Recording "the workaround is sufficient, do not build the channel" is a legitimate and
  possibly correct outcome of this ticket.
- **B — approve building the per-turn amendment channel sketched below.** Hash each injectable section at
  launch, re-hash from disk per turn, and prepend a bounded once-per-change notice carrying only the CHANGED
  section, via the `#withBriefing` seam that already exists. *Cost:* zero tokens on an unchanged turn, ~750
  tokens once per edit, plus the risks recorded below (dated-supersede wording, a per-change floor, and the
  BUG-104 clean-room strip). *Gives:* an edit reaches sessions already running.

## The evidence it is real, not argued

Confirmed live, not reasoned from the code alone:

- The orchestrator session composed its instructions at **18:57:04** today.
- `docs/prompts/RESPONSE_FORMAT.md` gained its layer-2 block spec (FEAT-091) at **22:12:53** today — three
  hours later.
- That session's turns after 22:12, in the response-format metrics log, emit `orchard-digest: 1` but
  `orchard-answer: 0` / `orchard-notes: 0` — i.e. silently non-compliant with a spec written three hours
  after it launched, while the metrics file dutifully recorded the non-compliance.

The stale session cannot know it is stale; only an outside observer comparing timestamps can see it. That is
exactly the deploy-lag failure mode, one level up: instead of a stale build, a stale prompt.

---

# Technical detail

## Where it happens

- **Composition is once, at construction.** `AgentSession`'s constructor (`src/server/agent-bridge.ts`
  ~628) calls `composeInstructions` (`src/server/templates.ts` ~497), folding WA → local conventions →
  routing → response-format into one system prompt. That prompt is handed to the CLI at spawn and never
  recomputed for the life of the process.

Three facts that are easy to get wrong, stated precisely:

- **Restarting the service does NOT recompose a running session.** Survivable sessions hand off into their
  own systemd scopes and keep their original system prompt. Recomposition happens only when a later message
  takes the resume-from-disk path, which constructs a *new* `AgentSession`. A plain restart of a survivor
  does not.
- **Reattaching to a live session never recomposes.** And delivery into a still-draining survivor writes a
  bare user frame with no composed prompt at all — so a message sent at the wrong moment silently rides the
  old instructions.
- **The orchestrator session is not special.** It goes through the identical path. It is merely long-lived,
  which is the only reason the lag is visible there first.

## What was NOT determined (do not overclaim)

There is no direct proof that the CLI applies a freshly composed prompt on resume. The transcript store keeps
no system-prompt record, so this is inference — from the SDK sending the prompt at every spawn, and the CLI
having nothing else to restore it from. If Option B is built, this inference should be pinned down first,
because the whole "cycle the session to refresh" workaround depends on it.

## The shape of a fix, IF approved (record as proposal — do not build)

A per-turn seam already exists: `#withBriefing` (`src/server/agent-bridge.ts` ~1043) runs on every `send()`
and already prepends bounded, exactly-once content from the board and the outcomes store. The proposal reuses
it:

1. At launch, store a hash of each injectable section.
2. Per turn, recompute each section's hash from disk.
3. When a hash differs, prepend a bounded, once-per-change notice carrying **only the CHANGED section**.

Cost: **zero tokens on an unchanged turn**, roughly **750 tokens once per edit**. Re-injecting the whole
stack would be wrong — it is ~41,000 characters, and paying that every turn is exactly the kind of always-on
cost the response-format work was careful to avoid.

## Risks to design against (record honestly — these shape whether it is worth it)

- **An amendment can contradict the launch prompt.** A doc edited mid-transcript may say the opposite of what
  the agent was told at spawn. The notice must therefore be worded as a **dated supersede** ("as of
  <time>, section X now says…"), never a silent swap — the agent needs to know it is being corrected, not
  handed a fresh consistent world.
- **Edit-in-a-tight-loop fires a notice per turn.** Editing a doc repeatedly would emit a notice on every
  turn. Wants a floor (debounce / coalesce), or it becomes noise.
- **A briefing has less authority than the system prompt, and can be lost to compaction.** It rides the user
  message channel, so it is an **amendment, not a replacement** for launch injection. It cannot be the only
  place the rule lives.
- **Clean-room strip still applies.** Any new channel that injects document text must respect the same
  clean-room strip BUG-104 covers — a supersede notice must not leak stripped content into an exported tree.

## Relationship to existing work

- Same shape as the deploy-lag rule (`docs/CONVENTIONS.md`, "Before diagnosing a UI defect, check what build
  is actually running") — a shipped change that does not reach the running system. That rule is about a stale
  *build*; this is about a stale *prompt* in a still-running process.
- Touches the response-format lane (FEAT-091) only as the concrete instance that exposed the lag; it is not a
  response-format bug.
- Adjacent to methodology-integrity work (FEAT-039 / FEAT-041, hoisting and syncing the shared WA) — those
  make the canonical doc correct; this is about a running session noticing when it changed.

## Context pack (grows — the "where to look", so no agent cold-starts)

- Files/functions in play: `src/server/agent-bridge.ts` (`AgentSession` constructor ~628; `#withBriefing`
  ~1043; `send()` ~955/1059), `src/server/templates.ts` (`composeInstructions` ~497), the injected docs
  under `docs/prompts/` + `docs/CONVENTIONS.md`.
- Evidence: `~/.local/share/claude-station/logs/response-format-metrics.jsonl` (the stale-compliance
  record — verify the two timestamps against your own environment before quoting them onward).
- Related tickets: FEAT-091 (the spec whose late edit exposed this), BUG-104 (clean-room strip the new
  channel must respect), FEAT-039 / FEAT-041 (methodology integrity/hoist), `docs/CONVENTIONS.md` deploy-lag
  rule (same shape, one level down).
- Repro test: none yet — add `npm run verify:feat-092` only if Option B is approved (would assert: edit an
  injectable doc between two `send()` calls → the second turn's prompt carries a dated supersede notice
  for exactly the changed section and nothing else).
- Known dependencies / blockers: the undetermined resume-recomposition fact above; a decision between Option
  A (workaround) and Option B (channel).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (filing lane)

- **Understood:** injected methodology is composed once at `AgentSession` construction and never re-read, so
  a running session silently keeps old instructions after any doc edit; confirmed live via the orchestrator's
  18:57 composition vs the 22:12 RESPONSE_FORMAT edit and the metrics log's recorded non-compliance. Verified
  the code references (`agent-bridge.ts` 628/1043, `templates.ts` 497) and the deploy-lag rule in
  `docs/CONVENTIONS.md` before filing.
- **Changed:** this ticket only. No product code touched.
- **Verified:** grep-confirmed the four cited line references and the deploy-lag section exist as described.
  The two live timestamps and the metrics-log content are reused from the source investigation, not
  independently re-derived — a future agent acting on this should re-confirm them in the running environment.
- **Still open / handoff:** the decision (Option A workaround vs Option B per-turn amendment channel). If B:
  first pin down whether the CLI truly re-applies a freshly composed prompt on resume (undetermined above),
  then build against `#withBriefing` with a dated-supersede wording, a per-change floor, and the BUG-104
  clean-room strip.
- **Symptom of a deeper design flaw?** Not closing, so not final. Provisional: leaning yes — "instructions
  are injected once and never reconciled with their source" is a structural property, not a one-off. If
  Option B is declined AND this recurs, that is the ARCH ticket to file.

### 2026-08-18 — ticket-format enforcement lane (worker)

- **Understood:** the Status header said "NEEDS DECISION" and the body named Option A and Option B in a prose
  paragraph ("What we need from you"), which `ticketDecision()` does not parse — no Decide card, so the
  "should we build it at all" call sat in front of nobody. Found by the new decision-shape guard.
- **Changed:** FORMATTING plus a faithful restatement. The "What we need from you" paragraph became
  `## Decision — accept the cheap workaround, or build the per-turn amendment channel?` with two bold-lead
  bullets, A and B, whose text is assembled from wording already in the ticket (the workaround described in
  "In plain terms", the `#withBriefing` proposal and its zero-tokens/~750-tokens pricing from "The shape of a
  fix", and the recorded risks). Nothing new was decided or claimed; an INDEX.md Open row was added with
  Owner 👤 (the ticket had no row).
- **Verified:** `ticketDecision()` now yields 2 options; `board:check` clean for FEAT-092;
  `npm run verify:decision-shape` 25/25 PASS.
- **Still open / handoff:** unchanged — A or B. If B, the undetermined resume-reinjection question in "What
  was NOT determined" must be pinned down first, as that section already says.
