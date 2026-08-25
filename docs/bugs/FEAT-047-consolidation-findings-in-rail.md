```orchard-ticket
{
  "id": "FEAT-047",
  "type": "feature",
  "title": "Consolidation findings that need a person stayed invisible",
  "summary": "Checks that run at startup and after capture flag things a person must judge, such as contradictions and stale routing. Those flags only reached the server console, so nobody saw them. They now persist and appear as dismissible rows in the existing Needs-You rail, proven by a new harness that failed before the change and passes now.",
  "impact_if_we_wait": "Judgement calls raised by the consolidation checks would go unread indefinitely. Bounded: the checks still ran and still logged, so nothing was lost or corrupted, and no other rail item was affected.",
  "current_need": "Nothing is outstanding. The new rail harness failed before the change and passed after, with the rail and decision anti-regressions and standing type checks clean.",
  "severity": "medium",
  "area": "Needs-You rail",
  "reported": "2026-08-06",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A planted contradiction or stale routing surfaces as a row in the rail",
    "Acknowledging a finding removes its row",
    "A pass with no findings leaves the rail unchanged",
    "The new harness fails before the change and passes after"
  ],
  "code_refs": [
    {
      "path": "$METHODOLOGY_DIR/.station/needs-human.json",
      "symbol": null,
      "note": "persisted findings the rail reader includes for the methodology-home project"
    }
  ],
  "related": [
    {
      "id": "BUG-025",
      "relation": "see_also"
    },
    {
      "id": "BUG-036",
      "relation": "see_also"
    },
    {
      "id": "FEAT-019",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-046",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-046",
      "relation": "see_also"
    },
    {
      "id": "FEAT-053",
      "relation": "see_also"
    },
    {
      "id": "FEAT-056",
      "relation": "blocks"
    },
    {
      "id": "FEAT-079",
      "relation": "blocks"
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
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-047-consolidation-findings-in-rail.md",
    "sha256": "0ac32ee29c8bcc62b713700657263e63df2952bd6bdeed5386875bea76bf2e6f",
    "bytes": 6443,
    "original_title": "WA consolidation needs-human findings surface in the Needs-You rail",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the console-only symptom, the persistence path, the reuse-the-rail constraint, the acknowledge behaviour and the required proof bar are all present.",
    "dropped": [
      "the ticket's own status-line phrasing, whose content is carried by the summary and evidence"
    ]
  }
}
```

# FEAT-047 — Consolidation findings that need a person stayed invisible

## Diagnosis

The boot and post-capture consolidation passes emitted needs-human findings — contradictions, routing-stale, rules-without-why — to the server console only, so they never reached the dashboard. They are literally "needs you" items, so the existing rail was the right home rather than a new surface. This completes the deferred UI half of FEAT-019 in its post-auto-apply scope, where only judgement calls ever surface, scoped down by the FEAT-046 audit that listed it as the top offender.

## Evidence

18/18 in the new findings-rail harness, proven FAIL before the change. Anti-regressions: needs-you-rail 17/17, runtime-decision 16/16, wa-selfmaintain 39/39, ui 3/3, bug-025-question 1/1. Typecheck clean.

## Implementation notes

Findings persist to `$METHODOLOGY_DIR/.station/needs-human.json`, a small JSON the board/rail reader includes. They render as read-only dismissible rows on the methodology-home project's rail; acknowledging clears them.

## Verification plan

Run a consolidation pass with a planted contradiction and stale routing, and assert the finding appears in the rail, read-only or answerable per BUG-025 semantics. Acknowledge it and assert it leaves. With no finding, assert the rail is unchanged. Playwright plus the offline UI suite, typecheck, and the rail anti-regressions.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed from FEAT-046 audit (offender #1). Queued behind FEAT-045.

### 2026-08-06 — agent (built + verified)
**Design decisions:**
- **Storage: `$METHODOLOGY_DIR/.station/needs-human.json`** (+ `needs-human-acks.json`
  beside it), NOT dataDir. Why: every producer (boot pass, `wa-capture` mini-pass, any
  project) and the server already resolve METHODOLOGY_DIR by the one shared rule
  (env, else `~/projects/methodology`), so scratch suites get isolation for free —
  dataDir would have let a scratch-METHODOLOGY suite pollute the REAL rail. Because a
  clean canonical-repo porcelain is itself an asserted invariant (verify-wa-selfmaintain
  T6), `.station/` is excluded via the LOCAL `.git/info/exclude` (appended idempotently
  by the persist step; local config, never a commit, never dirties `git status`).
- **Overwrite + carried-forward dates:** the JSON is rewritten on EVERY full pass
  (apply AND propose share the code path, so boot + post-capture both feed it); a
  finding whose stable id was already on file keeps its previous `date`. Stable id =
  `type-sha1(type|where|evidence)` with all digits normalized (line numbers shift,
  ages/similarity scores drift — the SAME finding must keep the SAME id).
- **Dismiss semantics:** ack = `{id → the finding's date}`. A row is hidden iff the ack
  date equals the finding's current date — so a dismissal survives reloads AND re-runs
  where the finding merely persists (date carried forward), and the finding resurfaces
  exactly when it disappears (clean pass) and REAPPEARS in a later pass with a fresh
  newer date. Unknown id → 400 (dismissing a finding not on file is a bug).
- **Placement: methodology-home project only.** The board route appends the finding
  rows only when the project's hostPath resolves to `projectRoot()` (this repo — the
  consolidation tooling and the docs/prompts mirror live here). Every other project's
  rail stays clean; appended AFTER tickets (standing attention, not asks). BUG-025
  semantics respected: `kind:'finding'`, NO `question`, so the rows are read-only.

**Changes:**
- `scripts/wa-consolidate.mjs` (~line 398 after detectors): `persistNeedsHuman()` —
  mkdir `.station/`, idempotent `.git/info/exclude` append, prev-date carry-forward,
  capped one-line `summary`, failure-tolerant (a write error warns, never breaks the pass).
- `src/server/board.ts` (end of file): `needsHumanFile()`, `consolidationFindings()`
  (reads findings + acks → read-only `BoardItem`s titled "WA consolidation: <label>",
  `detail` = evidence line), `dismissConsolidationFinding()`; `BoardItem.kind` gains
  `'finding'`, new optional `detail` field.
- `src/server/index.ts`: `methodologyDir()` helper (same resolution rule as the
  script, ~line 41); board GET merges findings for the methodology-home project
  (~line 520); new `POST /api/projects/:id/board/dismiss` (~line 545).
- `public/lib/api.js`: `dismissFinding(id, findingId)`.
- `public/app.js`: `needsFindingRow()` (read-only card, "WA consolidation" label,
  detail line, Dismiss button with optimistic remove + reconcile) + `needsCard()`
  branches on `kind === 'finding'` first (~line 3301).
- NEW `scripts/verify-feat-047-findings-rail.mjs` — the §C harness.

**Verified (all observed, scratch METHODOLOGY_DIR + scratch server on a free port,
real brave over CDP; :4317 and the real methodology repo never touched):**
- NEW harness **18/18 PASS**: server BOOT pass writes the JSON with exactly the two
  planted findings (contradiction Jaccard 0.50 + ROUTING.md researched 2025-01-01,
  582d stale); scratch repo porcelain stays clean; board route surfaces both
  `kind:'finding'` rows on the methodology-home project and ZERO on another project;
  rail renders them read-only (no textarea/options, labeled, Dismiss only); dismiss
  removes only that row, ack recorded `{id→date}`, row stays gone across a full page
  reload; a RE-RUN pass re-detects both with the same ids + carried-forward dates and
  the dismissal still holds; a CLEAN pass (contradiction removed, routing refreshed)
  empties the JSON, board + rail drop all finding rows; an answerable `## Question`
  ticket in the other project still renders textarea + 2 option buttons.
  **Proven NON-VACUOUS:** with the five changed files `git stash`ed, the harness FAILS
  at check 1 (boot pass never writes needs-human.json) — restored, 18/18.
- Anti-regressions: `verify:wa-selfmaintain` **39/39**, `verify:needs-you-rail`
  **17/17**, `verify:bug-025-question` **1/1**, `verify:runtime-decision` **16/16**,
  `verify:ui -- --offline` **3/3**, `typecheck` clean.
- Screenshots: `docs/bugs/assets/FEAT-047-findings-rail.png` (both rows + Dismiss),
  `FEAT-047-dismissed.png` (routing row gone after reload, contradiction row stays).

**package.json entry for the orchestrator to add** (scoped off package.json):
- `"verify:feat-047-findings-rail": "node scripts/verify-feat-047-findings-rail.mjs"`

No commit (working tree only). Status → VERIFIED.
