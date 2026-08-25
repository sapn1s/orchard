# FEAT-032 — Agentic workflow improvements (gaps observed this session)

- **Status:** DONE — #1/#4 (WA rules) + #5 (board tool) + #2 (self-QA foundation) shipped; #3 folded into #2
- **Area:** methodology + claude-station
- **Reported:** 2026-08-04 by user ("what else to integrate for best software results")

## Observed gaps → proposed integrations (ranked by leverage)

### 1. Root-cause escalation — stop serial-patching a bug CLASS (highest leverage)
Evidence: the reload/agents-summary bug is now on its 3rd variant — BUG-004 →
BUG-014 → BUG-017 — because each fix added a LOCAL guard instead of fixing the
fragile live-vs-summary DESIGN (the "N agents ran" summary should never *replace*
the convo; liveness detection is brittle). Integrate: a WA rule — when a bug is the
Nth in a sibling class, the fix MUST address the root design or explicitly justify
another patch; mark sibling classes on the board so we see the pattern.

### 2. Proactive self-QA — the user shouldn't be the test suite
Evidence: nearly every bug this session was found by the USER testing the live app,
not by our process. We ran an adversarial bug-hunt ONCE (found 9). Integrate: a
recurring QA agent that drives the LIVE app under realistic conditions (huge/32-agent
sessions, live bridges, restarts, reload) and files what it finds.

### 3. Validate the REAL deployed state, not just scratch isolation
Evidence: every fix passed its scratch-port verify, yet the live systemd service /
rail / reload still broke — because scratch fixtures are tiny and stateless.
Integrate: a post-deploy smoke check against the running service + realistic-scale
fixtures (14MB / many-agent sessions), so "green" reflects production.

### 4. Actually USE the rules we already wrote
- Adversarial refute-verify on high-risk fixes (a 2nd agent tries to find the NEXT
  variant) — would likely have caught the reload siblings before the user did.
- Model-tier-by-cost-of-mistake — the subtle recurring-logic areas (reload/liveness)
  are top-tier work; I've defaulted to sonnet. Match model to stakes.

### 5. Derive the board from ticket frontmatter (kill hand-drift)
Evidence: my scripted INDEX edits silently dropped 6 rows (real board drift). The
board is hand-maintained and fragile. Integrate: generate INDEX from ticket files
(single source of truth) so it cannot silently desync.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from a user reflection. Items 1 & 4 are WA rules (cheap); 2, 3, 5 are
  claude-station features. Awaiting user prioritization.
### 2026-08-04 — orchestrator (avoidable-bug vs emergent-feature framing)
Reflection prompted by the user ("more effort, or nature of agile?"): the two must
be separated.
- **Features were genuinely EMERGENT, not avoidable.** The rail, boot-aware, queue
  framing, cross-project handoff — you can't reliably spec these before feeling the
  friction in real use. Front-loading them would've been speculative over-engineering
  (violates §B/§E). This is agile working AS INTENDED, not a failure.
- **A real fraction of the BUGS were avoidable with cheap upfront rigor**: input
  validation (BUG-012), out-of-band/live-refresh thinking (BUG-016), verifying my
  own writes (board drift), realistic-scale testing (reload class). Craft gaps, not
  "agile nature."
- **A recurring bug CLASS is NOT natural** (reload 004→014→017) — that's the signal
  of patching over root-causing (= item #1).
- **Calibration, not "more effort everywhere":** blanket rigor kills the velocity
  that makes agentic dev worth it. Concentrate rigor where cost-of-mistake is high
  (stateful / concurrent / reload / data-loss); stay fast on reversible things. Same
  cost-of-mistake principle as model selection, applied to EFFORT.
- **Role split:** the user is the requirements ORACLE (unavoidable, valuable); the
  user should NOT be the QA oracle (avoidable — item #2).
### 2026-08-04 — orchestrator (proceeding per user go-ahead)
- **#1 + #4 ADOPTED** as WA v2 §N ("Escalate rigor by cost-of-mistake"): high-stakes
  changes (stateful/concurrent/reload/data-loss or Nth-in-a-class) get root-cause
  (not another patch) + adversarial refute-verify + a top-tier model. Goes live on
  the next service restart (read-through, no manual POST).
- **#5 DISPATCHED** (board reconciler/generator — kill silent INDEX drift).
- **#2 (self-QA)** next, after #5. **#3** folds into #2.

### 2026-08-04 — orchestrator (#5 built: `scripts/board.mjs`)
- **Understood:** the board (`docs/bugs/INDEX.md`) is hand-maintained, and a
  scripted string-replace this session silently dropped 6 rows — the exact
  failure mode item #5 exists to kill. Tickets are the durable source of truth
  (per `docs/bugs/README.md`); the board should be reconcilable/generable FROM
  them, not hand-edited independently.
- **Changed:**
  - `scripts/board.mjs` (new) — parses every `docs/bugs/{BUG,FEAT,DEPLOY}-NNN-*.md`
    ticket (ID from filename + H1, must agree; title from H1; severity from
    `- **Severity:**`; DONE-vs-OPEN from `- **Status:**` — VERIFIED or a `DONE`
    token ⇒ Done, else Open) and the two `INDEX.md` tables.
    - `check`: reports drift — ticket with no INDEX row ("MISSING FROM BOARD",
      the exact dropped-row bug), INDEX row with no ticket file ("ORPHAN INDEX
      ROW"), ticket H1-ID vs filename-ID mismatch, ticket-vs-board
      section (Open/Done) mismatch, and severity mismatch — all hard FAILs,
      exit 1 on any. Title divergence is a soft advisory WARN only (word-overlap
      < 0.12), because the real board's titles are legitimately paraphrased
      from the ticket H1 (e.g. DEPLOY-003's board title is even tense-flipped
      once resolved) — flagging every paraphrase as "drift" would be pure noise
      and bury the real signal.
    - `gen`: rewrites the Open/Done tables, DERIVING Title/Severity/section
      from the ticket, while PRESERVING Owner (Open) and Commit (Done) — and,
      as a judgment call beyond the literal brief, also preserving the Open
      table's free-text Status blurb (e.g. "design (→FEAT-017)") by ID from the
      current INDEX, since that phrasing is curated orchestrator commentary
      that no ticket field literally contains (same category as Owner/Commit,
      not something to invent). New tickets not yet on the board fall back to
      the ticket's raw Status text. Row order is preserved from the current
      INDEX (new rows appended, sorted by ID) to keep diffs minimal — verified
      idempotent (see below).
  - `scripts/verify-board-tool.mjs` (new) — the verification deliverable. Runs
    entirely in an OS-temp dir (`fs.mkdtempSync`), seeded from a copy of the
    real `docs/bugs/`; never touches the real `INDEX.md`, never touches the
    live systemd service on 4317 (spawns no server, no port used).
  - `package.json` — added `board:check`, `board:gen`, `verify:board-tool`.
- **Verified** (`npm run verify:board-tool`, 13/13 PASS):
  - (a) PASS — `check` exits 0 on a temp board freshly `gen`'d clean.
  - (b) PASS — deleted BUG-016's row from the temp `INDEX.md` → `check` exits 1
    and output contains `MISSING FROM BOARD: BUG-016` — reproduces and catches
    the exact silent-drop bug that motivated this ticket.
  - (c) PASS — `gen` restored the BUG-016 row: title matches the ticket H1
    verbatim, and it lands back in the Done table (ticket Status: VERIFIED).
    Also proved non-destructive to untouched rows: FEAT-032's Owner `👤`
    (a non-default value, not the "—" fallback) and BUG-004's Commit `f4fc2a3`
    both survived the drop-and-regenerate round trip unchanged. `check` is
    clean again afterward.
  - (d) PASS — a second `gen` run produced a byte-identical `INDEX.md`
    (idempotent).
  - `npm run typecheck` — PASS (clean, no output/exit 0).
  - `npm run board:check` against the **real** current board — 35 ticket files
    scanned, exit 1, 4 pre-existing FAILs (no MISSING/ORPHAN rows — this
    session's earlier board-reconcile commits already fixed the drop; these
    are genuine ticket/board looseness, not tool false positives):
    - `DEPLOY-003` ticket says `BLOCKED (on user action)`, board has it in Done
      (it WAS resolved — the server got restarted — but the ticket's Status
      field was never updated to reflect that).
    - `FEAT-018` ticket says `IN-PROGRESS`, board has it in Done (rail's
      "first cut" shipped; ticket Status stayed IN-PROGRESS since it's still
      mid-series with FEAT-029/BUG-016).
    - `FEAT-020` ticket says `SYNTHESIS DONE`, board still has it in Open
      (labeled "done-synthesis" there, i.e. board already half-tracks this but
      never got the row moved to Done).
    - `FEAT-028` ticket says `OPEN → building`, board has it in Done (systemd
      service is committed and running; ticket Status was never bumped).
    - Per this ticket's own instruction, NOT force-fixed here (`INDEX.md` is
      off-limits for this ticket; also `gen` would additionally rewrite every
      row's Title to the ticket-H1 wording, which is a much bigger, separate
      diff the orchestrator should review deliberately, not as a side effect
      of shipping the tool).
- **Still open / handoff:** the 4 real mismatches above are legitimate
  `board:check` findings, not tool bugs — the next agent to touch DEPLOY-003 /
  FEAT-018 / FEAT-020 / FEAT-028 should update the ticket's Status line (cheap)
  before that ticket's own work is called done; `board:check` will confirm
  it's actually cleared. Wiring `board:check` as a hard CI/pre-commit gate
  (so a future scripted INDEX edit can't drop rows silently again) is a
  natural follow-up but out of scope here — this ticket asked for the tool,
  not the gate.
### 2026-08-04 — orchestrator (user-observable verification gap)
User asked why the backend fix (reload doesn't kill work) shipped verified while the
UX side (reloaded UI shows no agents) went unchecked. Root: subagents were scoped to
BACKEND CONTRACTS (close⇒detach, approval-replay, transcript-continues) and each
verified its slice in isolation; no ticket's success criteria included the
user-observable render after reload. Adopted WA §C rule: "Verify the user-OBSERVABLE
outcome, not just backend state" — a correct backend with a broken render is still
broken; include the end-to-end from-the-user's-seat check. This is precisely the gap
#2 (self-QA driving the real UI) and #3 (validate real deployed state) exist to close
— they'd have caught the reload-shows-no-agents display bug that the backend tests couldn't.
### 2026-08-04 — orchestrator (integrated ≠ used — the Serena gap)
User asked whether finishing the Serena integration was planned or lost. Honest: it
was PARKED, not lost — FEAT-025 marked "repo-enabled", but the "actually use it +
confirm value" step had no owner / done-criterion / trigger, so it stalled silently
and only resurfaced because the user asked. Gap: "installed" read as "done"; nothing
in the workflow flags an integrated-but-unused capability (dead weight). Same root as
the §C user-observable-outcome rule + consolidation Q10 (earning its keep). Adopted WA
§C rule: "'Installed' is not 'done' for an integration" — done requires demonstrated
use or an explicit park-with-trigger. Also a self-QA/consolidation candidate:
periodically ask "what did we build/integrate that isn't actually being used?"

### 2026-08-04 — agent (#2 self-QA foundation — FIRST journey, shipped AS FEAT-033's Playwright adoption)
- **Understood:** #2 asks for a recurring QA agent driving the LIVE app so the
  user isn't the sole tester; FEAT-033's verdict 3/3 already committed to
  adopting `@playwright/test` opt-in on this exact repo, shipping a real
  `.spec.ts`. Combined both into one deliverable rather than building a
  second bespoke harness.
- **Changed:** `package.json` (`@playwright/test@1.62.1`, official npm,
  provenance = `github.com/microsoft/playwright`; `qa:sweep` script) +
  `playwright.config.ts` (new — reuses system Brave via
  `launchOptions.executablePath=/usr/bin/brave`, zero chromium download) +
  `scripts/qa/reload-preserves-work.spec.ts` (new — the first journey: a real
  scratch server + a real haiku session that launches a real Task-tool
  sub-agent, a real `page.reload()`, then the real user recovery gesture
  (type + Enter). Asserts, via `getByRole`/DOM + one `toMatchAriaSnapshot` on
  the static composer chrome: (a) the conversation renders, not the
  historical "N agents ran" summary (BUG-017's invariant), and (b) the
  agents-running strip re-shows the in-flight sub-agent by role/name
  (BUG-020's invariant), then that the sub-agent genuinely finishes and its
  marker lands on disk (never killed by the reload).
- **Verified:** `npm run qa:sweep` — PASS, 2 consecutive clean runs (~27-31s
  each). Non-vacuousness: temporarily inverted the BUG-017 conversation/
  summary assertions → FAIL (confirmed the harness genuinely sees the live
  conversation, not a stub); separately inverted the BUG-020 strip-row
  assertion → FAIL (confirmed the row genuinely renders); both reverted,
  diffed byte-identical to the shipped version afterward. Could not flip
  `public/app.js` itself for the red-check (another agent owns that file this
  session per dispatch) — the inversion was done in the SPEC's own
  expectations instead, which still proves the harness is not a no-op.
  `npm run typecheck` — clean. `npm run verify:ui -- --offline` — 3/3 PASS.
  Browser download confirmed ZERO: `~/.cache/ms-playwright` has 0 files after
  install + every test run. Port :4317 (live systemd service) never touched
  — confirmed still healthy and untouched by these runs.
- **Still open / handoff:** this is the FIRST journey, not full coverage. A
  natural second (noted, not built here, to stay scoped): the Needs-You rail
  round-trip (seed a 👤 ticket row → card renders → answer → card leaves),
  which `scripts/verify-needs-you-rail.mjs` already covers via raw CDP and
  would migrate cleanly to a second `.spec.ts`. Future journeys should live
  as additional files under `scripts/qa/*.spec.ts` — `qa:sweep` picks up any
  matching spec automatically, no config changes needed. This journey does
  NOT reproduce BUG-017's own narrow deep-scroll-index/padded-transcript
  trigger (that fixture-heavy edge case stays covered by
  `scripts/verify-reload-live-summary.mjs`); it exercises the ordinary shape
  of the bug class instead — see the spec's own header comment for the
  scoping rationale.
