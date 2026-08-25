# FEAT-057 — agent deaths must be recorded + visible WITHOUT the orchestrator being awake

- **Status:** VERIFIED (2026-08-10 — built WITH BUG-034 on the one server-owned structure)
- **Area:** server (agent outcome record) + UI (rail/banner) + session resume briefing
- **Reported:** 2026-08-09 by user: "agents run into usage limit and stop; you wouldn't get a
  notification because that'd require usage for you to find out — so there'd be no information
  that it happened until I send a message, and even then idk if it shows it properly"

## The gap (accurate)
1. **Notification requires a model turn.** An agent ending fires a harness notification, but the
   ORCHESTRATOR must run a turn to process it. In an account-wide usage limit the orchestrator
   cannot run either → nothing is recorded, nothing is shown, and the information exists only in a
   transient notification nobody consumed.
2. **Subagent failure REASONS are lost.** BUG-031 attributes provider errors for the MAIN session's
   turns (quota-window/auth/overloaded, with resetsAt). A SUBAGENT that dies on a usage limit
   settles as a generic failed/killed row (BUG-030) — the user never learns it was a quota wall,
   or when it resets.
3. Consequence: work silently stops, and the user discovers it by noticing nothing happened.

## Design (MUST be model-free — that is the whole point)
The server already receives the frames; recording and rendering must cost ZERO model tokens.
1. **Outcome record (server-authored):** when an agent/turn ends, persist WHY —
   `{agentId, label, endedAt, kind: completed|failed|killed|cut|provider-error, providerError?
   {kind, detail, resetsAt}}`. Reuse BUG-031's `ProviderError` taxonomy; the runtime already
   classifies quota-window with resetsAt.
2. **Visible without the orchestrator:** a persistent, dismissible surface rendered from that
   server state — Needs-You rail item and/or session banner: "3 agents stopped — usage limit
   (resets 13:40)". It must appear even if the orchestrator never ran a turn after the deaths.
3. **"While you were away" briefing at resume:** on the orchestrator's next turn start, the server
   injects a compact summary of agent outcomes since its last turn (what died, why, when), so the
   orchestrator cannot continue as if nothing happened. Small, factual, bounded (cap N + counts).
4. Optional (only if trivial): a browser Notification when the dashboard tab is open.

## Guards
- Never fabricate a cause: if the reason is unknown, say unknown (§C). "Ended, reason unknown" is
  honest; "completed" is not.
- Bounded storage: cap retained outcomes per session; never grow unbounded.
- The briefing must not spam a healthy session — if nothing died, inject nothing.

## Verification (REQUIRED, non-vacuous)
Scratch server: drive a session with a subagent, then (a) induce a provider quota-shaped failure
(fixture/injected frame with resetsAt) and (b) kill an agent outright. WITHOUT running any
orchestrator turn afterwards, assert: the outcome is persisted with the right kind+reason, and the
UI shows it (rail/banner) on a fresh page load. Then start a new orchestrator turn and assert the
briefing names the deaths. Assert a healthy session gets NO briefing and NO banner. Must FAIL
pre-change (today: reason lost, nothing visible without a turn). Anti-regressions: BUG-030 settle
invariants, BUG-031 provider errors, BUG-033 reaper, verify:stale-agent-cards, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from the user's operational question. Sequence WITH BUG-034 (server-authored running-set):
  the same server structure that answers "what is running" should answer "what ended and why" —
  building them separately would re-create the split-brain that caused this class.

### 2026-08-10 — build agent — BUILT & VERIFIED (with BUG-034 / ARCH-001 phase 2, one structure)

**Charter.** Built together with BUG-034 so that the structure answering "what is running" is the
same one answering "what ended and why" — building them apart is what created the split-brain this
family keeps paying for. ARCH-001 phase 1's `ended` slot was a designed hole; this fills it.

#### 1. WHAT IS RECORDED, AND WHERE THE CAUSE COMES FROM

`src/server/outcomes.ts` (new) — a bounded, atomically-written JSON ledger under the data dir:
```
AgentOutcome { id, at, projectId, projectName, stationSessionId, sdkSessionId,
               agentId ('main' for the orchestrator's own turn), row:'main'|'agent'|'tool',
               label, description,
               kind:'completed'|'failed'|'killed'|'cut'|'provider-error'|'unknown',
               detail, providerError:{kind,provider,detail,retryable,resetsAt}|null,
               dismissedAt, briefedAt }
```
Rules, enforced in code rather than documented at:
- **Deaths only.** A `completed` end is dropped (`record()` returns null) — nobody needs to be told
  after the fact that a thing worked, and storing every finished `local_bash` row would add hundreds
  of records per session. Cap 200, oldest pruned.
- **Never fabricate a cause (§C).** `kind:'unknown'` — rendered "ended, reason unknown" — is the
  fallback wherever the engine reported no outcome. In particular the turn-boundary sweep does NOT
  write `completed` for an agent that was still open at `result`: the display row settles
  (BUG-030's invariant) but the RECORD says the honest thing.
- **First observation wins** per (session, agent): a later, vaguer sweep can never overwrite a
  named cause.

**Where each `kind` comes from (all frames the server already receives — zero model tokens):**

| kind | site |
|---|---|
| `failed` / `killed` | the engine's own terminal frame (`task_updated` / `task_notification`) |
| `provider-error` | the runtime's BUG-031 classification of a TERMINAL provider error, latched on the session for the turn (cleared at every turn start, so last turn's outage can never be blamed for this turn's death) |
| `cut` | the session ended while work was in flight — the reaper, a transport death, a killed CLI, a close mid-turn |
| `unknown` | the turn ended with an agent still open and the engine said nothing about it |

**The subtlest bug this build found and fixed — FEAT-057's own gap #2, proven not assumed.** The
first end-to-end run recorded the three subagents as bare `killed` and only the MAIN turn as
`provider-error`. Reason (observed in the frame order, then confirmed in `codex-runtime.ts`
`#finishTurn`): the engines settle every open agent FIRST and report why the turn failed AFTER. So
the cause genuinely arrives after the deaths — which is exactly the reported symptom, "a subagent
that dies on a usage limit settles as a generic failed/killed row". `outcomes.attachProviderError()`
now upgrades the records of THAT TURN ONLY (bounded by `turnStartedAt`, and never touching a record
that already names its own cause), keeping the engine's own word and ADDING the turn's failure as
the context it happened in. Post-fix all four rows carry `quota-window (openai)` with the
provider's verbatim text.

`resetsAt` is normalised ONCE (`outcomes.resetsAtMs`) because BUG-031's taxonomy documents it as
"epoch seconds OR ms" and the two engines differ — a "resets 13:40" that is off by decades is the
same fabricated-number class. Unknown stays unknown: no reset time is shown when none was given.

`liveness.ts`'s `ended` slot is now filled from the same evidence (`BridgeLike.lastProviderError`),
so the authority itself can say `{kind:'provider-error', providerError}` where the engine reported
one and `unknown` everywhere else.

#### 2. WHERE IT SHOWS — with ZERO model tokens

- **Rail item** (`#railStopped`, above the needs cards): a headline the SERVER also computes
  (`outcomes.headline`, mirrored in the client so the two surfaces cannot word it differently) —
  `3 agents stopped — quota-window, resets 13:40` — plus one line per death, and a **dismiss** that
  is a SERVER write, so a cleared banner stays cleared across reloads and one that was not cleared
  comes back. Fetched at boot and on the existing 5s rail poll: it appears on a fresh page load with
  no session open, no socket, and no orchestrator turn anywhere in the story.
- **Routes:** `GET /api/agent-outcomes[?projectId=&sessionId=&all=1]`,
  `POST /api/agent-outcomes/dismiss {ids|all}`. Outcomes also ride every BUG-034 running-set
  snapshot (`snapshot.ended`), so an attached tab learns about a death in the same frame that tells
  it the work stopped.
- **"While you were away" briefing**, injected at the orchestrator's NEXT turn start (`send()`, and
  the resume path in `start()` so a session resumed after its CLI died is covered): a bounded block
  (≤6 named deaths + "…and N more") ending with an explicit "this is a server-recorded fact, not a
  request". Each record is marked `briefedAt`, so no death is reported twice, and
  **nothing at all is injected when nothing died.**

#### 3. VERIFICATION — `scripts/verify-agent-outcomes.mjs` (new): **26/26**

Real `outcomes` module against a scratch data dir (part A), then a real server + real bridge + the
schema-validated fake `codex app-server` + a real browser (parts B/C). No API cost: the fixture's
`usageLimitExceeded` failure is the shape the real binary emits and is classified by the SAME
BUG-031 code path as a live one. A new fixture scenario `HOLD_AGENTS:<n>[;QUOTA]` holds N subagents
genuinely running and then fails the turn on the usage limit; `CODEX_FAKE_INPUT_LOG` records the
exact prompt text the ENGINE received, which is the only way to prove the briefing actually
travelled (and that a healthy turn's prompt is untouched).

- A: `resetsAt` seconds→ms / ms→ms / null→null; `completed` not stored; first-observation-wins;
  headline names the wall and its reset; "ended, reason unknown" for an unknown cause; the briefing
  names the deaths, never twice, and is `null` for a healthy session; dismissal persists.
- B (quota, the reported case): all **three subagents AND the main turn** recorded `provider-error`
  with `quota-window / openai / "You've hit your usage limit…"`; a **FRESH page load** shows the
  rail item with **no orchestrator turn anywhere after the deaths**; dismissal survives a reload;
  the next turn's prompt carries the briefing naming what died and why; the turn after it carries
  nothing (`observed: "again?"`).
- C (killed outright): the engine SIGKILLed mid-flight → main + both agents recorded `cut`, never
  "completed", each saying "…while work was in flight (…)"; visible on a fresh load with no
  orchestrator turn in between.

**PRE-CHANGE (same script, HEAD in a clean worktree): 4/13** — `src/server/outcomes.ts` does not
exist, nothing is recorded for either the quota or the kill, `/api/agent-outcomes` 404s, the rail
shows nothing on a fresh load, and no briefing is injected. (The 4 passes are structurally vacuous:
"dismissal persists" and "a healthy turn gets no briefing" pass when there is nothing to dismiss and
nothing to inject.)

**Anti-regressions** — the full list is in BUG-034's entry (same build): `typecheck` PASS,
`verify:liveness-conformance` 96/96 incl. the R-D regrowth guard clean, `verify:stale-agent-cards`
12/12, `verify:reattach-agent-backfill` 15/15, `verify:agent-summary` 3/3,
`verify:reload-live-summary` 10/10, `verify:zombie-busy` A–D 34/34 (E 4/4 red, pre-existing and
documented), `verify:refusal-visible` 16/16, `verify:tickets` 30/30,
`verify:running-snapshot --runs=5` 47/47 and `--live` 4/4.

**package.json entries — reported, NOT edited (per charter):**
`"verify:running-snapshot": "node scripts/verify-running-snapshot.mjs"` (sub-runs `--runs=N`,
`--live`) and `"verify:agent-outcomes": "node scripts/verify-agent-outcomes.mjs"`.

#### Closing assessment

**Symptom of a deeper design flaw? — YES, the same one as BUG-034 (ARCH-001), which is why they
were built together and not sequentially.** "Nobody recorded what died" and "nobody could say what
was running" are one missing structure, not two features; had this been built on its own it would
have grown a second in-memory list of agents next to the strip's, and the next ticket would have
been the two disagreeing.

What I would flag as genuinely unresolved rather than done:
1. **`resetsAt` is only end-to-end-proven for the Claude path's shape, not the Codex one.** The
   Codex runtime does not extract a reset time from `usageLimitExceeded` at all (it is not in the
   frame), so the live quota test asserts `quota-window` without a reset. The seconds/ms
   normalisation is proven at the unit level against the real exported function, and the renderer is
   proven to print `resets HH:MM` when one exists — but no single test carries a real reset time all
   the way from an engine to the rail. Naming it rather than implying coverage.
2. **The briefing is injected into the prompt text.** That is what the ticket asked for and it is
   bounded, but it is model-visible input that the user did not type — it appears in the transcript
   prefixed `[station]`. If that ever becomes noise, the alternative is a system-prompt append at
   turn start, which costs the same tokens and is less visible to the user, i.e. worse for honesty.
3. **Deaths are recorded per session, but the rail is scoped by PROJECT.** A death in a session
   whose project record is gone (project deleted) is retained but never rendered. Bounded and
   harmless, deliberately not special-cased.

**Handoff:** none — built and verified. Shares `src/server/index.ts` / `public/app.js` /
`src/server/agent-bridge.ts` with in-flight work; serialize commits. Nothing committed by this agent.
