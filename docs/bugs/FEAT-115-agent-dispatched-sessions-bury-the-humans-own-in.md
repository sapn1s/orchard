```orchard-ticket
{
  "id": "FEAT-115",
  "type": "feature",
  "title": "Agent-dispatched sessions bury the human's own conversations in the session picker",
  "summary": "An orchestrator's dispatched worker lanes (scripts/dispatch.mjs runs real top-level claude -p / codex sessions in the project cwd) fill the store with ticket-titled rows the user never opened. A user reported their session list spammed so they could not find their own thread. Fixed by recording provenance at creation and folding non-live agent-started rows out of the default picker.",
  "impact_if_we_wait": "In a project agents work in, the human's own conversations are buried under dispatched worker rows and become hard to find. Nothing is lost — every row is still reachable — but the picker stops being usable for its one job: getting back to the thread you were in.",
  "current_need": "Record provenance explicitly at creation (never inferred from how a row looks), join it onto the session list, and fold non-live agent-started rows into the existing \"N more\"; keep them URL/search reachable and never fold live/open work.",
  "severity": "medium",
  "area": "sidebar picker + session listing",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session records whether a person or an agent started it, DECLARED at creation, never inferred from a title that looks like a ticket id.",
    "Agent-started sessions leave the default picker view; a user-started session stays.",
    "Folded agent sessions remain reachable — by the existing \"N more\", by direct URL, and by search — never permanently hidden.",
    "A live agent-started session, and the open session, are NEVER folded.",
    "Pre-existing sessions (no recorded provenance) default to SHOWN; only a conservative structural signal (the machine Dispatch declaration line) may fold one, erring toward showing.",
    "Verification suites that create sessions and assert on the sidebar keep asserting against a NON-empty list, because provenance is settable/defaulted, not keyed on the caller."
  ],
  "code_refs": [
    { "path": "src/lib/session-provenance.mjs", "symbol": "resolveStartedBy", "note": "Write-once record store + conservative pre-existing Dispatch-line fallback; self-contained (no .ts import) so the dispatch subprocess can record too." },
    { "path": "src/server/index.ts", "symbol": "GET /api/projects/:id/sessions", "note": "Joins startedBy onto each row via loadProvenanceMap (once per request)." },
    { "path": "src/server/agent-bridge.ts", "symbol": "AgentSession system:init", "note": "Records StartOptions.startedBy (default 'user') at init." },
    { "path": "scripts/dispatch.mjs", "symbol": "dispatchAnthropic/dispatchOpenai", "note": "Records 'agent' when the dispatched session id is known." },
    { "path": "public/app.js", "symbol": "visibleSessions", "note": "Folds non-live agent-started rows into 'N more'; live/open bypass via alwaysIds." }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-115 — Agent-dispatched sessions bury the human's own conversations in the session picker

## Diagnosis

A prior round investigated "hide agent-spawned sessions" and concluded no build
was needed, because the one session the user linked turned out to be their own.
That conclusion was right about that session and wrong about the general case,
and it was never written to the board — so this ticket re-derives it (itself an
instance of this project's dominant defect class: a fact nobody wrote down).

The distinction that round found still holds:

- **Task subagents live one directory down and never appear** in the picker —
  uniform, by design. That is why most projects look clean.
- **Agent-*dispatched* full sessions DO appear as ordinary rows.** These are the
  worker lanes `scripts/dispatch.mjs` starts: a real top-level `claude -p`
  (anthropic) or codex run in the project's own cwd, which writes its own
  session into the CLI transcript store keyed by that cwd. They cluster in
  whichever project agents actually work in, and they carry the dispatch
  charter's ticket id as their title.

The tempting fix — hide rows whose title looks like a ticket id — is wrong: a
human who types a ticket id would be mislabelled by it, and this project's
dominant defect class is exactly a fact that each reader re-derives instead of
its owner writing it down. So provenance is **declared at creation**.

## Implementation notes

- **`src/lib/session-provenance.mjs`** (+ `.d.mts`) — the store. One tiny JSON
  per session, keyed by the engine's own (globally-unique) session id, under
  `<dataDir>/session-provenance/<sessionId>.json` = `{ startedBy, source, at }`.
  Write-once (the first declaration wins; a re-record cannot flip it) and
  best-effort (never throws — a failed record must not break a start or a
  dispatch). Self-contained on purpose: it is imported by BOTH the server (`.ts`,
  type-stripped) AND `scripts/dispatch.mjs` running in a spawned subprocess under
  whatever `node` the host has, so it imports no `.ts` — its data-dir resolution
  MIRRORS `src/lib/paths.ts#dataDir` and a verify suite asserts they never
  diverge. Its only non-builtin import is the PURE shared dispatch grammar
  (`scripts/lib/cost-model.mjs#parseDispatchDeclaration`).
- **Write sites (declared, not inferred):**
  - `scripts/dispatch.mjs` — the anthropic and openai paths record `'agent'` the
    moment the session id is known (on success or failure — a failed turn still
    wrote a store row).
  - `src/server/agent-bridge.ts` — a new `StartOptions.startedBy` (default
    `'user'`) is recorded at `system:init`, once the engine's session id exists.
    Default `'user'` keeps interactive/UI and verify-suite sessions VISIBLE.
- **Join site:** `GET /api/projects/:id/sessions` (`src/server/index.ts`) loads
  the provenance map ONCE per request (not a read per row — keeps listing cheap,
  cf. BUG-158) and adds `startedBy` to each row via `resolveStartedBy`: an
  explicit record wins; else the conservative fallback; else `'user'`.
- **Pre-existing fallback (conservative, showing-biased):** a row with NO record
  whose first user message BEGINS with the machine declaration line
  (`Dispatch: ticket=… phase=… round=… class=…`) is tagged `'agent'`, parsed
  through the same grammar the dispatcher formats with. A human would have to
  type that exact key=value line verbatim as their opening message; a bare
  "dispatch:" with no declared field is NOT enough. Everything else defaults to
  `'user'` — hundreds of pre-existing real sessions are never defaulted to hidden.
- **Fold (`public/app.js#visibleSessions`):** agent-started rows fold out of the
  DEFAULT view exactly like an out-of-recency-window row — revealed by the same
  "N more" affordance (BUG-085's collapse-back applies), always URL/search
  reachable. Live and open rows already bypass the pool via `alwaysIds`, so
  running/on-screen agent work is NEVER folded.

## Verification plan

Ran (all isolated; the user's real store never touched):

- `verify:session-provenance` (module unit + the dataDir drift-guard) — 25/25.
- `verify:session-provenance-endpoint` (REAL server + REAL transcript store +
  REAL records: record-wins, agent-record, pre-existing Dispatch-line fallback,
  record-overrides-content) — 7/7.
- `verify:session-provenance-fold` (REAL `app.js#visibleSessions` in happy-dom):
  user visible, agent folded, "N more" reveals, live/open never folded — 7/7,
  with a genuine must-FAIL control (the same suite against a copy of `app.js`
  with the two-line fold removed: the 3 fold checks FAIL, agent rows appear).
- Real-browser (brave-CDP) drive over `scripts/prov-fixture-server.mjs`, both
  themes, screenshots read.
- Anti-regression: `verify:bug-085-sidebar-cap` 11/11, `verify:feat-070-sidebar`
  14/14, `verify:session-recency` 11/11 — all still green and non-empty (the
  fold is transparent to fixtures that do not set `startedBy`).

## Migration and rollback

No migration. The provenance store is created lazily on first record; absent =
"unrecorded" = shown. Rollback is inert: revert the two-line `visibleSessions`
predicate and every row shows again; the recorded JSON is harmless if left.

## Risks

- **A verify suite going invisible while still passing** — the dangerous failure
  the design guards against. Provenance is settable/defaulted, NOT keyed on "the
  caller was an agent", so a fixture with no `startedBy` stays visible; the three
  named sidebar suites confirm non-empty assertions.
- **A false hide of a real human session** — bounded by the showing-biased
  fallback (requires the verbatim machine declaration line) and by the write-once
  `'user'` record overriding content.
- Risk bucket: **regression-prone** (touches the session picker fold, a surface
  with a history of hiding live work — BUG-085). An independent clean-room verify
  pass is warranted before VERIFIED.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — agent (fixing r2)
- **Understood:** the reopened report (session list spammed with ticket-named
  rows). Inherited the prior round's Task-subagent-vs-dispatched-full-session
  distinction (never persisted; re-derived here).
- **Changed:** `src/lib/session-provenance.mjs` (+ `.d.mts`), `scripts/dispatch.mjs`,
  `src/server/agent-bridge.ts`, `src/server/index.ts`, `public/app.js`; added
  `scripts/verify-session-provenance.mjs`, `verify-session-provenance-endpoint.mjs`,
  `verify-session-provenance-fold.mjs`, `scripts/prov-fixture-server.mjs`, and
  three `package.json` script entries. NOT committed (no git writes).
- **Verified:** unit 25/25; endpoint E2E 7/7; fold suite 7/7 over the REAL app.js
  with a must-FAIL control (3 fold checks fail without the change); anti-regression
  bug-085 11/11, feat-070 14/14, session-recency 11/11. Real-browser brave drive
  dispatched. `npm run gate`: typecheck PASS, check-nul PASS; leak-gate red ONLY
  on 3 pre-existing stray `.py` files at repo root (adversarial_twosided_*.py,
  verify_brake_adv.py) that predate this work, are not mine, and leak a private
  path — reported for removal, not touched. My own files scan leak-clean.
- **Verified-by:** independent clean-room pass still owed (regression-prone bucket).
- **Still open / handoff:** collect the brave verifier's verdict; commit the
  explicit file list once the user authorises; remove the 3 stray `.py` files.

### 2026-09-02 — agent (fixing r2, real-browser pass + sweep)
- **Verified (real browser):** dispatched brave-CDP drive over
  `scripts/prov-fixture-server.mjs` (real headless Brave, not synthetic DOM),
  VERDICT PASS on all four: (1) default view folds the 6 agent rows, shows only
  the 2 human rows + "6 more"; (2) "6 more" reveals all agent rows; (3) a folded
  agent session deep-linked by URL loads its transcript (reachable); (4) both
  themes read cleanly. Screenshots at `/tmp/fold-shots/`. The verifier surfaced a
  fixture-timing trap: server liveness is mtime-based (`liveness.ts`
  LIVE_WINDOW_MS=30s), so freshly-written seed files read as LIVE (hence
  fold-exempt) for ~30s — CORROBORATING "live work is never folded". Hardened the
  fixture to backdate seed mtimes so the trap cannot cause a false result.
- **Verify-suite sweep (the named risk):** all sidebar-asserting suites stay
  GREEN and NON-empty, because the fold keys on `startedBy` (fixtures that don't
  set it default to 'user' = visible): bug-085-sidebar-cap 11/11, feat-070-sidebar
  14/14, session-recency 11/11, session-reorder-usermsg 6/6 (independently asserts
  "a live agent session is NEVER folded"), session-reorder-durable 6/6,
  git-branch-switch live-gating pass. New: session-provenance 25/25,
  session-provenance-endpoint 7/7, session-provenance-fold 7/7 (+ must-FAIL control).
- **Pre-existing default:** SHOWN. A row with no record defaults to 'user'; the
  only fallback that folds one is the verbatim machine `Dispatch:` declaration
  line (errs toward showing) — verified in the endpoint suite.
- **Declared, never inferred:** an explicit record always wins over content (the
  endpoint suite proves a human who pastes a Dispatch line but carries a 'user'
  record stays 'user').
- **Gate:** typecheck PASS, check-nul PASS. leak-gate red is entirely 3
  pre-existing stray `.py` files at repo root (adversarial_twosided_*.py mtime
  2026-08-29, verify_brake_adv.py mtime 2026-08-28 — both PREDATE this 2026-09-02
  session, never committed, not in this change's file list). My files scan clean.
