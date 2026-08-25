```orchard-ticket
{
  "id": "BUG-145",
  "type": "bug",
  "title": "the WA states the no-inline-work rule as a slogan with no threshold",
  "summary": "WA §I already says the orchestrator does not implement, and it is injected whole into every session. It is not holding: on the real FEAT-096 log, 48.4% of main-session tool calls would be refused by a dispatch-only profile, 29 of them Bash. A categorical rule with no stated threshold and no reason gets eroded by the it-is-just-one-check exception.",
  "impact_if_we_wait": "Every fresh orchestrator rediscovers inline work and drifts further into it, at a measured $444 per Mtok of output against $131 for a dispatched lane. The user re-teaches the rule by hand in every session that matters.",
  "current_need": "Rewrite WA §I's categorical bullet as a decision procedure with the measured threshold, the compounding-cost reason, and the retry argument that makes the exception narrower than it looks.",
  "severity": "high",
  "area": "working agreement / injected instructions",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "WA §I states the threshold as a question with two branches, and names the context level above which the inline exception closes entirely.",
    "The retry argument is stated: a mis-guessed command becomes three turns at full context, so one check does not cost one call.",
    "The reconciliation with the prior categorical wording is explicit, not stacked beside it (WA §L forbids stacking a contradicting rule).",
    "check:scope stays clean — the rule is universal and must not read as project-specific.",
    "The added text's injected size is measured and reported — the WA is already 67% of the injected budget, paid every turn.",
    "A real launched session on a real project is shown to receive the new text — not the template asserted to contain it."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-145 — the WA states the no-inline-work rule as a slogan with no threshold

## The user's own diagnosis, verbatim

> "it always thinks 'its just one check' but it actually costs full context of the orchestrator… i wonder if its truly one command, it might be cheaper than dispatching a new subagent? but then i see scenarios where it thinks its one command, but it fails cuz its not aware of syntax, tries again, perhaps multiple retries until it works… so even if it may be slightly cheaper, probably not by much anyway, its more likely to offset it with such scenarios by far, plus derail because it sees itself running inline commands, so it starts doing it more and more"

The retry half of that is the part written down nowhere, and it is the strongest argument: the "one command" estimate is itself unreliable, so the expected cost of "just one check" is not one call.

## Why "add another delegate-more paragraph" is the wrong fix

WA §I already carries: the categorical rule ("even a trivial one-line fix goes to a dispatched agent"), a six-class dispatch taxonomy, the default-up tiebreak, and the no-own-subagents verification rule. All of it is injected WHOLE — the WA is not capped on any injection path. So this is not an awareness gap. Restating it louder is duplication, and §L forbids stacking.

What genuinely does not exist anywhere in the injected surface: **a threshold, a reason, and the retry argument.** "Be concise" and "delegate more" have both failed here repeatedly; stating the number and why has not been tried.

## The measurement, so nobody re-derives it

From `docs/analysis/inline-vs-dispatch-crossover-2026-08-20.md`:
- An orchestrator's context is re-read on **every request**. 93.2% of one session's spend was context maintenance buying nothing.
- Per Mtok of output produced: orchestrator **$444**, dispatched lane **$131** — 3.4x, and the orchestrator produced 4.7x less.
- A lane's cold start is ~11.8k tokens (~$0.046) — one fifth of a single orchestrator tool call.
- Break-even at 450k context: **3.7** tool calls with no reading, **2.8** with one file read per call. Read-then-edit is already 3.
- A 10k-token inline read costs $0.25 now and ~$0.65 spread over the next 131 requests, attributed to unrelated turns, and cannot be put back.

From `docs/analysis/orchestrator-surface-retroactive-2026-08-20.md`: 86.7% of tool calls would have been blocked early in a session, 38.2% late, and not one restricted write in the orchestrator window touched product code.

## The live proof that the current wording is not holding

`npm run orchestrator:surface` over the REAL FEAT-096 log (2,508 records) on 2026-08-25, with the current WA text injected into every session:

```
main-session calls   :     64
within the profile   :     33   51.6%
WOULD HAVE BLOCKED   :     31   48.4%
  BLOCK  Bash    29   45.3%
  BLOCK  Read     1    1.6%
  BLOCK  Edit     1    1.6%
```

This is not the A-E1 finding FEAT-096 is waiting for (that needs bucketing by someone who did not write the profile) and must not be quoted as one. It is enough to establish the narrow claim this ticket makes: **the rule is injected and is being ignored roughly half the time.**

## The tension that must be reconciled, not stacked

§I today says a trivial one-line fix is **still dispatched**. The crossover measurement says the opposite for one narrow case — it names lane "BUG-103 NUL byte fix and guard" (2 requests, 0 files read, $0.037; $0.64 with overhead against ~$0.53 inline) and concludes **it should have been done inline**. §I's reason for dispatching trivia was traceability, not cost, and the measurement does not speak to traceability. A correct rewrite keeps both: cost permits a ≤2-call no-read exception; traceability still requires a dispatch for anything that lands as a ticketed change.

## Cost of the change itself

The WA is 24,403 injected chars, **67% of the ~36k composed append** every session pays on every turn. Any addition here is charged fleet-wide and forever. Record the delta in the activity log.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Canonical: `~/projects/methodology/WORKING_AGREEMENT.v2.md` §I. `docs/prompts/WORKING_AGREEMENT.v2.md` is a MIRROR — edit canonical, then `npm run sync:methodology`.
- `docs/CONVENTIONS.md` is the wrong home: it is hard-capped at 4,000 chars (`templates.ts:301`) and ~79% of it never reaches a session (see the truncation ticket).
- FEAT-096 is the wrong home too: it is deliberately log-only and deliberately never emits a decision or a nudge (`scripts/hooks/orchestrator-surface-log.mjs:17-31`).
- Guards: `npm run check:scope` (universal vs project-specific), `npm run gate`.
- Related: BUG-144 (the projects that receive no WA at all — a rule they never see cannot hold), FEAT-096, FEAT-100.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — orchestrator
- **WA §I rewritten as a decision procedure:** **Understood:** the rule already existed and was already injected whole — WA §I:170-172 "the orchestrator does not implement — even a trivial one-line fix goes to a dispatched agent". So this was never an awareness gap, and another "delegate more" paragraph would have been duplication (WA §L forbids stacking). What did not exist anywhere in the injected surface: a THRESHOLD, a REASON, and the retry argument.

  **Checked what already exists before adding text, per WA §B.** Three candidate homes, two rejected on evidence: (1) `docs/CONVENTIONS.md` is auto-injected but hard-capped at 4,000 chars while the file is 18,277 — ~79% never reaches a session and the cut already lands mid-table-row, so a rule written there past line ~66 is a no-op on live sessions (filed as BUG-146). (2) FEAT-096s tool-surface recorder is deliberately log-only and deliberately never emits a decision or a nudge (`scripts/hooks/orchestrator-surface-log.mjs:17-31`); the ticket argues that never-emit property is what keeps it out of BUG-118s hole, so putting a nudge there crosses a stated line and needs a decision, not code. (3) The WA is injected WHOLE and uncapped on every path — the only home where the text is guaranteed to land.

  **Changed:** `~/projects/methodology/WORKING_AGREEMENT.v2.md` §I (the CANONICAL doc; `docs/prompts/` is a mirror), then `npm run sync:methodology`. Two edits:
  - Replaced the bare categorical bullet with the threshold as a question with two branches — needs a read → dispatch at any size; no read and ≤2 calls → inline — plus the context level at which the exception closes (~300k), the retry argument ("price the retries, not the happy path"), the compounding-cost reason with the measured numbers, and the "your context is a liability, not an asset" corollary.
  - Reconciled rather than stacked (§L): the `trivial` row of the dispatch-class table said "(Still dispatched — §I: the orchestrator does not implement.)", which flatly contradicts the new ≤2-call exception. Both are now kept on their own grounds — cost buys the exception for checks and one-line edits; traceability still requires a dispatch for anything landing as a ticketed change, and no measurement of tokens speaks to traceability. The crossover doc itself names lane "BUG-103 NUL byte fix and guard" (2 requests, 0 files, $0.037 vs ~$0.53 inline) as work that SHOULD have been inline, so the old absolute was wrong on cost grounds for that one narrow case.

  **Verified so far:**
  - `npm run check:scope` → clean, both before and after. The new text is universal and does not read as project-specific.
  - `npm run sync:methodology` → mirror synced, 1 copied.
  - **Size, since the WA is 67% of the injected budget and is paid on every turn of every project:** 24,598 → 26,427 bytes, **+1,829 (+7.4%), ≈ +457 tokens per turn.** Set against the measured waste it targets ($1,514 of context maintenance in a single window; $444/Mtok vs $131), that is worth paying, but it is a fleet-wide recurring cost and is recorded here deliberately rather than left implicit.

  **The live proof the OLD wording was not holding**, from the real FEAT-096 log (2,508 records, `npm run orchestrator:surface`, 2026-08-25), with the old text injected into every session the whole time: 64 main-session calls, 33 within the dispatch-only profile, **31 (48.4%) would have been refused** — 29 Bash, 1 Read, 1 Edit. Per FEAT-096 own handoff this is NOT the A-E1 finding and must not be quoted as one; it supports only the narrow claim made here, that an injected categorical rule was being ignored about half the time.

  **Still open / handoff:** the decisive check is NOT done — nobody has yet confirmed that a REAL launched session on a REAL project receives this text, as opposed to the template asserting it. That is success criterion 6 and it is the whole point of the exercise; a session whose project has `instructions: []` (BUG-144 — 8 of 13 real projects) receives NONE of this no matter how well it is written. **BUG-144 must land before this ticket can be verified**, and the verifying agent should launch a real session and grep the composed prompt for "the inline-work threshold", not read `templates.ts`.

  **Symptom of a deeper design flaw?** Not closing yet. Noted for whoever does: this is the second time a rule was believed to be in force while its delivery was unverified (BUG-144 is the same shape at the project level, BUG-146 at the document level). Three instances of "written, committed, believed injected, not delivered" in one sweep is an ARCH candidate about the injected surface having no delivery receipt.

### 2026-08-25 — independent-verify
- **INDEPENDENT VERIFY — BUG-145 real launched session: PASS:** Attacked the claim, could not break it. SEAM: agentBridge.startSession() in-process on a project created through the REAL POST /api/projects route, reading session.composed.systemPrompt — the exact value agent-bridge.ts:1064 folds board state onto and hands the CLI at :1151 (systemPrompt: sp). This spawns the real claude CLI, not a re-composition. Booted my own scratch server (free port, isolatedServerEnv, scratch DATA + CLAUDE_PROJECTS_DIR under ~/scratch). 14/14 PASS: fresh project via HTTP gets base-first coherent stack + methodVersion=1; the launched session receives all four required strings — the v1-only marker Evidence over narrative (proves coherent v1+v2, not v2-only), plus inline-work threshold, Price the retries, closes above ~300k. Captured the live §I region from the real composed prompt. VERDICT: claim HOLDS — a real launched session on a coherent-stack project does receive the new WA §I text.

### 2026-08-25 — orchestrator
- **independent pass: claim holds against a real launched session:** **Independent verification complete — the claim HOLDS.** A separate fresh-context agent attacked it rather than checking it.

  **The seam, and why it is the real one:** `agentBridge.startSession()` called on a project created through the real `POST /api/projects` route, reading `session.composed.systemPrompt` — the exact value `agent-bridge.ts:1064` folds board state onto and hands the CLI at `:1151`. `startSession()` spawns the real `claude` CLI; this is not a re-composition of `composeInstructions()`. Own scratch server, OS-assigned free port, `isolatedServerEnv({PORT, CLAUDE_STATION_DATA, CLAUDE_PROJECTS_DIR})`, scratch dirs outside the repo. Harness: `real-launch.mjs` under the operator's scratch dir (outside the repo).

  **14/14 PASS.** The launched session received all four required strings: `Evidence over narrative` (the v1-only marker — proves the coherent v1+v2 stack rather than v2 alone), `inline-work threshold`, `Price the retries`, `closes above ~300k`. Both create paths were driven over the real HTTP route: default → base-first coherent stack + `methodVersion=1`; `applyMethod:false` → declined with `instructions:[]` but still stamped, so the anti-override guard is real.

  **Count reconciliation, recorded because two honest runs disagree.** The verifier re-ran `verify:bug-144` and got 37/1, with the failure being section 7 precondition "real copy has incoherent+unstamped rows before backfill" — false, because the live registry had already been backfilled. That is the moving-baseline defect I flagged to the fixing lane mid-flight. The lane then re-anchored the proof to a committed scrubbed fixture; the suite has read **42/42 ALL PASS** on every run since, including after the commit (`46549f6`). The verifier observed the file between those two states. No product regression at any point.

  **What the independent pass added that the fixing lane could not:** truncated-registry attacks at 25/50/75/90% — the backfill refuses loudly (exit≠0, "not valid JSON"), the file stays byte-identical, and no backup or temp is written, so a half-registry is not reachable (`load()` throws before any write; `save()` is writeAtomic temp+fsync+rename). And the stamped-then-manually-removed case: the backfill skips it and does NOT re-add the WA — intended under option B, and now stated rather than assumed.

  **Two findings filed separately, not fixed here** — see the new strict-MCP ticket: `--strict-mcp-config` is always passed (serena is always on), so Orchard REPLACES rather than merges the user MCP config, documented only in code comments; and provisioning is not triggered by boot/create/launch, so a fresh data dir is handed an MCP config naming a binary that does not exist and fails silently. The first is the most likely explanation for the users original report that MCP is not enabled by default.

  **Could not test, carried forward:** a full serena MCP tool-call round-trip inside a live model turn (binary starts and config is injected; the handshake was not driven to completion), and a true concurrent-write interleaving — the backfill is a read-modify-write with no lock, so a lost update is possible if a live server writes between its read and write. Neither side can write a half file. That race is inherent to the registry design, not introduced here.

  **Symptom of a deeper design flaw?** Yes, and it is the through-line of this whole sweep: three separate defects in one pass were all "written, committed, believed in force, never delivered" — a rule injected but ignored (this ticket), projects that received no rules at all (BUG-144), and a conventions doc truncated to a fifth (BUG-146). The injected surface has no delivery receipt. Worth an ARCH ticket about making delivery observable rather than assumed.
