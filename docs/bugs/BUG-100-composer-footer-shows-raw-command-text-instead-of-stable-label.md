```orchard-ticket
{
  "id": "BUG-100",
  "type": "bug",
  "title": "Running work replaced the footer’s stable access label",
  "summary": "The footer now keeps its stable access label while dispatched work runs, instead of showing raw commands or a cost summary. A bounded indicator represents running work. The separate question about whether a displayed cost covered one dispatch or a longer period was not resolved here.",
  "impact_if_we_wait": "Raw commands can alarm users and hide the access level needed while composing. Bounded: this affects display correctness and user trust, not command execution or user data.",
  "current_need": "Treat the ticket as closed: the reverted handlers reproduced the failure, corrected behavior passed, and standing leak checks stayed clean.",
  "severity": "medium",
  "area": "Composer footer",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The footer retains its stable access label while dispatched work runs",
    "Running work uses a compact indicator instead of raw command text",
    "Footer content remains bounded for commands of any length",
    "Run summaries do not replace the stable access label"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "BUG-100 footer handlers previously replaced the stable label with raw running-command text"
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "Composer footer presentation and bounded status display"
    }
  ],
  "related": [
    {
      "id": "BUG-082",
      "relation": "see_also"
    },
    {
      "id": "BUG-101",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": "docs/bugs/archive/BUG-100-composer-footer-shows-raw-command-text-instead-of-stable-label.md",
    "sha256": "3d955934fe6cbd344d45282e9dde00c99dab8b2476ba54f7501a7b4b0decf732",
    "bytes": 8422,
    "original_title": "the composer footer replaces its stable label with raw running-command text (and a cost line)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the supplied ticket; the symptom, intended footer behavior, cost question, bounds, implementation locations, and recorded runs remain present.",
    "dropped": []
  }
}
```

# BUG-100 — Running work replaced the footer’s stable access label

## Diagnosis

The composer footer is a persistent access-status display, but running dispatch updates replaced its stable label with raw command text. Long commands were truncated mid-word and could expose alarming fragments such as `rm -rf` despite referring to sandboxed scratch work. Completion then replaced the label with a duration, cost, and turn summary.

## Evidence

Reverting the two handlers to their previous raw-dump behavior produced 5 PASS / 9 FAIL. With the correction, `verify:proc-chip` passed 16/16 and `verify:feat-083` passed 22/22. Another recorded tally was 14/14, without an adjacent suite name. `leak-gate` was reported clean. No independent `Verified-by:` verdict was recorded.

## Implementation notes

Keep the stable isolation and access label primary. Represent active work with compact bounded text, and keep raw commands out of the footer. Run outcomes belong somewhere that does not displace the access label. The displayed `$65.5067 · 3 turns` cost requires separate measurement before interpreting it as dispatch-specific or cumulative.

## Verification plan

Exercise the real interface with a dispatched agent running a long multi-line command. Confirm the stable label remains, the running indicator is bounded, and raw command text never appears. Fuzz with a 2,000-character command. `verify:ui`, `verify:bug-100-footer-label`, `verify:processes`, and `verify:feat-083-adversarial` were named, but no results were recorded for them.

## Migration and rollback

The pre-fix behavior can be reproduced by reverting the two corrected handlers. That rollback is diagnostic only because it restores raw command leakage into the footer.

## Risks

Functional risk is low because the change concerns status presentation. User-trust impact is moderate: flashing destructive-looking command fragments beneath the input can appear dangerous even when execution is sandboxed.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user report while a harness-repair worker was running sandboxed codex tests. Same family as
  BUG-082 (proc chip port list too long): unbounded machine detail displacing a stable status label.

### 2026-08-14 — worker (VERIFIED)
**Mechanism found.** The footer is `#fine` (`.fine`), written ONLY by `say(text, isErr)`
(public/app.js). It is dual-purpose: it holds the resting isolation/access label AND transient
ticker messages. The stable label ("Direct · full access to this machine" / Container / Sandbox) was
set inline in `paintSeal()` when `!state.busy`. Two paths displaced it with unbounded/inappropriate
content:
  - `case 'status'` (onEvent) did `if (!state.busy) say(e.status)`. The server (agent-bridge.ts:2520)
    emits `t:'status'` with an agent task-notification `String(m.message ?? …)` — for a dispatched
    shell/codex agent that is the RAW command line (the multi-hundred-char heredoc), dumped raw into
    the footer.
  - `case 'turn-end'` built `bits = [subtype, "37.8s", "$65.5067", "3 turns"]` and did
    `say(bits.join(' · '))`, replacing the label with the run summary — including a bare `$` figure
    that reads as real spend.
There was NO length cap anywhere; `say()` wrote `textContent` verbatim.

**Cost question (ticket §36-39).** `e.costUsd` is the SDK `result` cost for ONE turn/dispatch (per
FEAT/`turn-end`), not cumulative and not billed money — an API-EQUIVALENT ESTIMATE (user is on a fixed
plan). The reported `$65.5067` was a single cross-provider codex dispatch's estimate. Handled by
labelling, not by treating it as a spend fact.

**Fix map (public/ only — stayed out of src/server/*):**
  - `say()` now hard-caps at `MAX_FINE=88`, truncating on a word/`·`/`/` boundary + ellipsis and
    stashing the full/raw text on the element `title` (nothing lost to hover). Universal safety net
    for EVERY caller.
  - `.fine` CSS: `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%` — a
    wide item can never wrap to a 2nd line or spill past the composer.
  - Extracted `isoLabel(p)` (single source for the label) + `restLabel()` (re-asserts it as the
    resting content) + `runningAgentCount()`.
  - `case 'status'`: never adopts raw command text. While agents run it shows
    `"<isoLabel> · N agents running"` (bounded); the raw command rides the title; the running rail
    (#strip) remains the home for what's in flight. Short human notices still show (capped).
  - `case 'turn-end'`: cost labelled `~$X est.`; a clean/interrupted run summary goes to a durable
    transcript OUTCOME line (`appendTurnOutcome` → `.ran-lbl.turn-outcome`, with a "not billed"
    title) and `restLabel()` returns the footer to its label. An ERROR still speaks up in the footer
    ticker (that IS a transient, marked alert).

**Where the run summary belongs — decision.** The running/outcomes RAIL, not the footer. The footer
`#fine` exists to hold the isolation label; the strip (#strip) hides on completion, so a *durable*
per-turn outcome lands as a `.ran-lbl` line at the foot of the main transcript (the same durable
outcome surface the codebase already uses for compact-boundary markers — see the app.js comment
praising a "transcript card (durable, unlike the one-line #fine ticker)"). Errors are the one thing
that still uses the footer ticker, because an error IS a transient alert.

**Verification (§C).** New suite `scripts/verify-bug-100-footer-label.mjs` — real UI in headless
brave over CDP, free port, PID-kill only, never :4317. Realistic busy-state fixture: server snapshot
reports TWO running agents and one emits the reported multi-LINE `GUARD_BYPASS=1 rm -rf … codex exec`
heredoc.
  - 14/14 PASS with the fix.
  - Must-FAIL pre-fix (reverted the two handlers to the old raw-dump): 5 PASS / 9 FAIL — (2c) LEAKED
    "GUARD_BYPASS, rm -rf, harness.mjs, codex exec, mkdir" into the footer; (4a/4c) the bare
    `$65.5067` summary displaced the label. Restored the fix → 14/14.
  - Fuzz: a 3,137-char command routed through the footer renders 86≤88 chars, single line, no spill,
    ellipsis, full text on title.
  - Anti-regress: verify:ui 7/0 (its transcript now correctly shows the new
    `success · 2.5s · ~$0.1041 est. · 1 turns` outcome line), verify:proc-chip 16/16,
    verify:processes 9/0, verify:feat-083 22/22, verify:feat-083-adversarial 170/0, `tsc --noEmit`
    clean, leak-gate PASS (0 hits / 439 files).

**Screenshots (idle + agent-running, both themes):** /tmp/iv-orchard/footer-after.png (light) and
/tmp/iv-orchard/footer-after-dark.png (dark) — footer reads "Direct · full access to this machine ·
2 agents running" in both. An unbiased visual review is expected to follow.

**Risk bucket / skeptic note.** UI/status surface — low functional risk, moderate user-trust impact.
Not security/session-lifecycle/data-loss; routine enough that an independent clean-room pass is not
required, but an unbiased *visual* review of the two screenshots is warranted (functional asserts are
not sufficient for a UI change).
