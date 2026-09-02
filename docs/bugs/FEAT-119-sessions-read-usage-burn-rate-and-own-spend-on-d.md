```orchard-ticket
{
  "id": "FEAT-119",
  "type": "feature",
  "title": "Sessions read usage, burn rate and own spend on demand for dispatch",
  "summary": "A session cannot answer 'can I afford to dispatch this, and at what tier?' before it fans out: it cannot see how much of each provider's rate-limit window is gone, the burn rate against the reset, or its own spend. This makes that data obtainable by a session on demand, keeping volatile numbers out of the cached system prompt.",
  "impact_if_we_wait": "Sessions dispatch blind: they over-commit a nearly-spent window and hit the wall mid-fleet, or park conservatively for no reason. The one number that changes the decision — burn rate vs time-to-reset — is nowhere available to the entity making the decision.",
  "current_need": "An on-demand command a session runs before fanning out, showing per-provider window percent, reset, burn rate and projected exhaustion versus reset, plus its own spend as a separate lower-bound estimate. Credential-free, degrading to unavailable; nothing volatile in the system prompt.",
  "severity": "medium",
  "area": "Session cost/usage awareness — dispatch decisions",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session runs one command (npm run usage; add --json to parse) and gets per-provider window percent, reset and as-of timestamp, reusing the FEAT-116 reader.",
    "Burn rate is labelled observed %/hr across successive reads of one window, else window-average; projected exhaustion compared to time-to-reset gives a park/ok verdict.",
    "Workspace spend is shown from the cost model as a lower-bound estimate, in a section separate from the provider quota, never a fraction of it.",
    "Never fabricates: unavailable says unavailable, a first read withholds the observed rate, an unknown reset withholds a verdict; bounded, non-blocking, no credential anywhere.",
    "A running session obtains it (a bare process, independent of session and server); new sessions see a static pointer in the first-turn preamble.",
    "The system prompt stays byte-identical across resumes with this change in (verify-feat-113 still passes); no volatile usage number rides the cached prefix."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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

# FEAT-119 — Sessions read usage, burn rate and own spend on demand for dispatch

## What this is

The request: make new and existing sessions aware of usage, burn rate across time, and their own workspace spend, so a session can decide model dispatches (tier, and go-vs-park) from data rather than a guess.

## Delivery shape and why

**On-demand command + a static first-turn pointer.** FEAT-113 established that per-turn-volatile numbers in the system prompt bust the whole cached prefix (~$255-318/month of cache_miss_reason:system_changed). Live usage is the most volatile number there is, so it must not ride the system prompt. A command is always current, only paid for when a decision is being made, and obtainable by a RUNNING session (which cannot have its system prompt changed mid-flight). New/resumed sessions additionally get a STATIC one-line pointer to the command in the first-turn board preamble (boardStateSection) — off-system, so cache-safe.

## How a running session gets it

`npm run usage` (add `-- --json` to parse) is a bare Node process that imports the provider reader directly. It needs no session context and no station server, so any running session can invoke it at any time. A resumed session also re-reads the first-turn board preamble (refreshed every launch/resume), so it learns the pointer without a system-prompt change. A truly-never-resumed continuous session gets the capability the same way — by running the command — but learns of it only via the pointer at its next resume or from the user; that is inherent to not touching a running session's system prompt, and is stated plainly rather than papered over.

## What a session sees

Per provider: each window's percent used, time to reset, burn rate (labelled observed vs window-average), sustainable %/hr, projected hours-to-cap, and a PARK/OK verdict, plus an overall dispatch recommendation driven by the harshest (binding) window. Then a separate OUR-OWN-SPEND section: dollars this workspace's lanes spent over recent windows, labelled a lower bound and explicitly NOT the provider quota.

## Burn-rate derivation

Two rates, each labelled (scripts/lib/usage-burn.mjs, pure/testable):
- OBSERVED — true %/hr between two successive reads of the same window instance (matched on resetsAt; a prior from a different instance is ignored so no burn is computed across a window boundary). Null on the first read — no history to diff, and inventing one would be a fabrication.
- WINDOW-AVERAGE — the single-read fallback: percent consumed / how long the window has been open (reset minus window duration). For a rolling window this is an approximation and is labelled as such, so the FIRST call is still decision-shaped.
Projection prefers the observed rate when it is a positive signal, else the window-average. Verdict = compare projected hours-to-cap against hours-to-reset: exhaust-before-reset -> park; resets-first -> ok. A window not being consumed projects to never (not a fabricated zero); an unknown reset yields no verdict guess. A small append-only history file in the station data dir (only this command writes it) enables the observed rate on the next call.

## Files

- scripts/lib/usage-burn.mjs — pure burn/verdict derivation.
- scripts/usage.mts — the on-demand CLI (npm run usage), reuses src/server/provider-usage.ts (FEAT-116) and scripts/cost-collect.mjs.
- src/server/board.ts — one static pointer line in boardStateSection (first-turn preamble, cache-safe).
- package.json — usage + verify:feat-119 scripts.
- scripts/verify-feat-119-usage-awareness.mjs — the graded suite.

## Verification

scripts/verify-feat-119-usage-awareness.mjs (26/26): pure burn math (PARK vs OK, observed beats window-average, first-read withholds honestly, cross-window prior ignored, unknown-reset yields no fabricated projection); the real command against the live providers (bounded return, per-window verdicts with as-of, no credential in output, spend separated from quota); degrade path; and the cache-safe placement, including running scripts/verify-feat-113-system-prompt-stable.mjs to prove the system prompt stayed byte-identical. Must-FAIL on the pre-change tree (the module and command do not exist there).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — agent
- **finding+fixing r1:** Built the on-demand capability and verified it against the REAL providers. Delivery shape chosen: **on-demand command (`npm run usage`) + a static first-turn pointer** — justified by FEAT-113 (per-turn-volatile numbers in the system prompt bust the cached prefix; live usage is the most volatile number there is). Reuses `src/server/provider-usage.ts` (FEAT-116) — no second reader — and `scripts/cost-collect.mjs` for workspace spend.
  - **Burn derivation:** OBSERVED %/hr between successive reads of the same window instance (matched on `resetsAt`), else a labelled WINDOW-AVERAGE fallback on the first read; projected hours-to-cap compared to hours-to-reset → PARK/OK verdict + a sustainable-%/hr ceiling. First read withholds the observed rate; unknown reset withholds a verdict; nothing fabricated.
  - **Real run (max/plus accounts):** anthropic 5h 80% used, resets 2.7h, sustainable ≤7.3%/hr → PARK; openai 5h 22%, resets 3.0h → OK. Own-spend shown separately as a list-rate lower bound, never as provider quota. No credential in output (asserted against the on-disk token).
  - **Verify:** `scripts/verify-feat-119-usage-awareness.mjs` 26/26; `scripts/verify-feat-113-system-prompt-stable.mjs` still 11/11 (system bytes byte-identical). Must-FAIL confirmed: with `scripts/lib/usage-burn.mjs` / `scripts/usage.mts` moved aside the suite dies unreachable (exit 1). Gate: typecheck + check-nul PASS; leak-gate FAILs only on three foreign untracked root files (`adversarial_twosided_*.py`, `verify_brake_adv.py` leaking `/home/.../temp_things/...`) — not mine, present at dispatch. My files are leak-clean.
  - **Independent verify warranted:** this is a session-lifecycle + cost-regression-prone change (touches the launch preamble); a fresh-context clean-room pass is advisable before it is treated as settled.


