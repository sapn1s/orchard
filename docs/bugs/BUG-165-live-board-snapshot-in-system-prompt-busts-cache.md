```orchard-ticket
{
  "id": "BUG-165",
  "type": "bug",
  "title": "Live board snapshot in system prompt busts cache prefix each resume",
  "summary": "Each orchestrator (re)launch folded the live board snapshot into the system prompt. The board changes as tickets are filed, so the system block differed on every resume; the prompt cache keys the whole system block as one prefix, so this busts the entire cached prefix. The provider records cache_miss_reason:system_changed — ~$318/month on the real session.",
  "impact_if_we_wait": "Continues to pay ~$255-318/month (projection) in avoidable full-prefix cache rewrites on the costliest session, on top of the context-maintenance spend FEAT-113 already tracks.",
  "current_need": "Keep the system prompt byte-stable across a session's resumes: the live board snapshot must not sit inside the cached system block. Verify nothing the session relied on is lost.",
  "severity": "medium",
  "area": "Session launch prompt assembly",
  "reported": "2026-09-02",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The assembled system prompt is byte-identical across consecutive resumes unless a system-prompt SOURCE doc (WA/conventions/routing/response-format) genuinely changed.",
    "The board snapshot still reaches the session at every launch/resume, carrying live board state including tickets filed mid-session.",
    "A board-less project still assembles a valid, board-free first turn (opt-in preserved).",
    "The cache_miss_reason:system_changed share attributable to the board snapshot is eliminated."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-113",
      "relation": "see_also"
    },
    {
      "id": "FEAT-021",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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

# BUG-165 — Live board snapshot in system prompt busts cache prefix each resume

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — agent
- **fix r1 (implemented, self-verified, awaiting independent verify + commit).**
  **Root cause (confirmed, not assumed):** `AgentSession.#launch` (src/server/agent-bridge.ts) folded `boardStateSection(hostPath)` into the system prompt (`appendToSystemPrompt(sp, boardStateSection(...))`) on every launch AND resume — the same method runs both paths. It was the ONLY per-resume-VOLATILE component of the system block. The other components (WA v2/v3, local conventions, routing, response-format) are all repo-file-backed and change only when a doc is genuinely edited (git shows ~8 such commits across the ~27-day session window vs 49 `system_changed` events, so the large majority of misses were board-driven). The board snapshot changes on essentially every resume (a ticket filed, a status flipped, a needs-you answered).
  **Why it costs so much:** the prompt cache keys the entire system block as one prefix segment, so a changed tail (the board sits after WA/routing/response-format) still busts the whole segment AND the accumulated message history behind it — the transcript's `system_changed` diagnostics carry `cache_missed_input_tokens` of 392k–516k, i.e. full-prefix rewrites, not a 10k re-cache. FEAT-113's finding measured $318/month, 49 events.
  **Fix:** move the snapshot OUT of the system prompt and into the FIRST TURN (a user-side orientation preamble folded into `firstPrompt`, ahead of the user's prompt and the FEAT-057/090 briefings). Injected once per launch/resume exactly as before — only its LOCATION moved (system → first user turn). The session loses nothing: it still gets the same live snapshot at launch, and can re-read the live board on demand (board tool + the INDEX.md the snapshot names). The board's per-resume churn now lands in new, uncached message tokens (~a few hundred, ~$0.003) instead of rewriting the cached prefix.
  **Verification (`scripts/verify-feat-113-system-prompt-stable.mjs`, 11/11, no server, realistic busy board mutated mid-"session"):** PART A (must-FAIL) reproduces the bug — OLD assembly (board in system) differs by 69+ bytes across two resumes. PART B proves the fix — system prompt byte-identical (43,281 bytes) across the two board states, board snapshot absent from system, and the UPDATED board (incl. a mid-session-filed ticket) still reaches the first turn. `scripts/verify-boot-aware.mjs` 12/12 still green. Typecheck PASS. Gate leak-gate FAIL is entirely non-mine files (3 stray user `.py` at repo root + another lane's untracked `scripts/verify-session-switch-order.mjs`); my three files are leak-clean.
  **model_changed ($79) checked, NOT a defect:** the session used 3 distinct model families (claude-opus-5, claude-opus-4-8, claude-fable-5) — deliberate user model switching. No code path auto-switches the model on resume (`setModel` is user-invoked). Left as-is.
  **Saving:** projection ~$255–318/month (the board-attributable share of the measured `system_changed` spend); labelled a projection — re-running 27 days of live requests to measure exactly is not cheap. The fix removes the board as a `system_changed` cause entirely; residual `system_changed` would only be genuine doc edits, which are legitimate and rare.
  **Scope:** three files only — `src/server/agent-bridge.ts` (board relocation), `scripts/verify-feat-113-system-prompt-stable.mjs` (new), `scripts/verify-ticket-dashboard.mjs` (test wording/assertions updated for the new split: WA in system, ticket in the first turn). Did NOT touch the WA-v3 condensation work (templates.ts / WORKING_AGREEMENT.v3.md / sync-methodology.mjs / working-agreement.md) — that is a separate lane's uncommitted work and is fully independent of this stability fix.
  **High-stakes flag:** cost/regression-prone, session-lifecycle-adjacent — warrants an independent clean-room verify pass (a second fresh-context agent composing the real launch prompt across two resume states and diffing the system block).
