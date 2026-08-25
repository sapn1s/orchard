# FEAT-056 — architecture-review loop: stop ticket-driven work from only ever patching locally

- **Status:** VERIFIED (2026-08-09 — `verify:arch-watch` 37/37; acceptance test rediscovered the
  liveness class unprompted; board:gen still owed by the orchestrator to move this row to Done)
- **Area:** methodology / board tooling (the system that decides HOW work is chosen)
- **Reported:** 2026-08-09 by user ("whenever we get an issue, agents fix whatever is current in an
  isolated scope of arch, but will not reconsider if some architecture should literally change for
  long-term reliability — wonder how to introduce it")

## The hole (accurate statement of the problem)
A ticket board optimises for closing tickets. Each agent is scoped to one ticket, so each fix is
local by construction. Nothing in the loop ever asks "should this subsystem exist in this shape at
all?" WA §N exists ("a symptom fixed 3× means the design is wrong — redesign, don't patch") but it
fires only when a human/orchestrator HAPPENS to notice the pattern — today's BUG-034 escalation
(5th patch of agent-strip liveness) was caught by memory, not by any mechanism. Memory does not
scale across sessions, compaction, or projects.

## Design (mechanical first — the human-dependent parts are the ones that fail)
1. **Recurrence detector (`scripts/arch-watch.mjs`)** — pure computation over the board + git:
   cluster CLOSED tickets by touched files/subsystem (git show --stat per ticket's commit(s), or
   the ticket's declared Area), and flag any cluster crossing a threshold (e.g. >=3 tickets in the
   same subsystem, or >=2 within 30 days). Output = a needs-human finding, reusing FEAT-047's
   findings channel so it appears in the Needs-You rail. No LLM judgment in the detector.
2. **`ARCH-###` ticket class** — a distinct template (`docs/bugs/TEMPLATE-ARCH.md`) that forbids
   symptom framing: it asks for the invariant being violated, the design that produces the class,
   options with trade-offs, the migration path, and what would have to be true to prove the new
   design right. `scripts/board.mjs` learns the prefix (Open/Done tables, drift check).
3. **Periodic architecture review** — the consolidation loop (already runs post-capture + at server
   boot, FEAT-019) gains an arch-watch pass, same failure-tolerant contract; findings surface, they
   never auto-refactor. Cross-provider by default when dispatched (ROUTING rule: the other provider
   reviews, decorrelated blind spots).
4. **Fix-ticket closing question** — the standard ticket template gains one required line at close:
   "Symptom of a deeper design flaw? (no / yes → ARCH-### filed)". Cheap; it makes every agent hand
   its structural suspicion forward instead of dropping it.

## Explicit non-goals / guards
- Do NOT auto-refactor. The loop RAISES architecture questions; humans+design decide. (§L's lesson:
  lossy judgment calls surface, mechanical safety auto-applies — refactors are never mechanical.)
- Do not let arch-watch become noise: threshold-tuned, deduplicated by cluster, dismissible like
  other findings (FEAT-047 acks), and it must state the evidence (which tickets, which files).
- An ARCH ticket must not become a licence to rewrite working code; it demands a stated invariant
  + migration + proof bar before any build.

## Verification
Scratch board fixtures: a subsystem with 3 closed tickets → finding raised naming them; a
subsystem with 1 → silent; dismissal sticks until a NEW ticket joins the cluster; ARCH template
scaffolds and board.mjs handles ARCH ids in check/gen without drift; consolidation pass integration
is failure-tolerant (broken board never breaks boot). Real-data smoke: run against THIS repo's
board — it must independently rediscover the agent-strip liveness cluster (BUG-004/017/020/030/033
/034) without being told, which is the honest proof the detector works.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from the user's observation. The real-data smoke (rediscovering the liveness cluster we
  caught by hand) is the acceptance test that matters.

### 2026-08-09 — build agent (all four parts + cross-project scope)
- **Understood:** the loop must fire mechanically (memory doesn't scale) and must work in EVERY
  onboarded project, reusing the three transports that already exist (WA for the rule, onboard/
  fleet-sync for the tool, each project's own board for the findings). ARCH-### is the OUTPUT
  CONTAINER for a redesign decision, not the finder.
- **Changed:**
  - `scripts/arch-watch.mjs` (new) — pure-computation recurrence detector. **Signal:** each
    ticket's DECLARED `- **Area:**` line + H1 title, tokenised, tokens outside a document-frequency
    band dropped (a token in >25% of a board — "server", "ui", "session" — carries no subsystem
    information; the ceiling is disabled below 20 tickets where it cannot mean anything), plus a
    similarity bonus for ticket ids cited IN THE AREA LINE ("(BUG-020 sibling)") — a human
    explicitly declaring kinship. Partitioned by AVERAGE-LINK agglomerative clustering.
    **Git-touched files are EVIDENCE ONLY, never the key** — measured on this board:
    ticket→commit attribution is commit-message grep and triage commits name 3–8 ids at once
    (BUG-030's grep-derived file list is dominated by FEAT-037's codex files); `public/app.js` is
    touched by ~30 of 83 tickets so a file-keyed partition is one meaningless blob; and open /
    never-committed tickets (BUG-034 — the 6th member of the class this had to find) have no
    commits at all. Two other clusterings were built and rejected on the real board:
    one-cluster-per-shared-token → 91 overlapping "clusters"; SINGLE-link → a 19-ticket blob.
    Each cluster also reports its nearest neighbour ("adjacent — may be ONE class") because a
    partition draws a hard line where the data has a gradient.
  - `scripts/board.mjs` — `ARCH` is a first-class prefix (Open/Done tables, drift check, gen).
  - `docs/bugs/TEMPLATE-ARCH.md` (new) — symptom framing forbidden: violated invariant, the design
    producing the class, why local patches did not hold, ≥2 options with trade-offs (incl. "keep
    patching", priced), migration path, proof bar + what would falsify it, decision record.
  - `docs/bugs/TEMPLATE.md` + `README.md` — the required closing question ("Symptom of a deeper
    design flaw? (no / yes → ARCH-### filed)") and the rule to answer it when closing.
  - `scripts/wa-consolidate.mjs` — the arch pass rides the existing loop (boot + post-capture),
    loaded by DYNAMIC import inside try/catch so any detector failure degrades to one warning;
    plus standalone `--check-arch [--board-dir …]` and `--no-arch`.
  - `src/server/board.ts` + `src/server/index.ts` — findings are PER PROJECT
    (`docs/bugs/.arch/findings.json`, derived + self-ignoring): every project's rail shows its own,
    dismissible on any project (arch ids route to the project; WA findings stay home-scoped).
  - `scripts/onboard.mjs` / `scripts/fleet-sync.mjs` — `arch-watch.mjs` is copied and re-synced
    exactly like `board.mjs`, `arch:watch` is wired into the target's package.json, and
    TEMPLATE-ARCH + the loop's description are scaffolded into the project's board README.
  - canonical `~/projects/methodology/WORKING_AGREEMENT.v2.md` §N extension (commit 9af3666) +
    `npm run sync:methodology` — the RULE travels to every project via injection.
  - `docs/ARCHITECTURE-REVIEW.md` (new) — what fires, when, what the user sees, what it will NEVER
    do, thresholds, dismissal, and how one `onboard` run gives a project the whole loop.
- **Verified:** `node scripts/verify-arch-watch.mjs` → **37 passed, 0 failed** (scratch fixtures:
  3-ticket cluster raises a finding naming its evidence, 1-ticket subsystem silent; finding id
  stable across re-runs and CHANGED by a new cluster member; ARCH round-trip through board
  check/gen incl. real drift; `--check-arch` on absent/malformed boards exits 0; REAL server:
  finding on project A's rail only, dismiss sticks across a re-run, a new ticket re-raises it;
  a deliberately broken `arch-watch.mjs` still boots and serves the server). RED pre-change
  (verified in a temp worktree at HEAD: module not found → 0 passes).
  **ACCEPTANCE (real board, unprompted):** every member of the agent-strip liveness class landed
  in a flagged cluster — `[agent+live+bridge] BUG-020, BUG-030, BUG-033, BUG-034` (the class
  BUG-034 escalated) and its adjacent `[transcript+agent+live] BUG-004, BUG-011, BUG-014,
  BUG-017, FEAT-016` — with `src/server/agent-bridge.ts` corroborating.
  Anti-regressions: verify:board-tool 13/13, verify:wa-selfmaintain 39/39,
  verify:feat-047-findings-rail 18/18, verify:needs-you-rail 17/17, verify:check-scope 12/12,
  typecheck clean, board:check clean. (verify:ui is RED at HEAD for unrelated BUG-036 — untouched.)
- **Still open / handoff:** (a) `package.json` was NOT edited per instruction — add
  `"verify:arch-watch": "node scripts/verify-arch-watch.mjs"` and
  `"arch:watch": "node scripts/arch-watch.mjs --persist"`; (b) this ticket is VERIFIED so the
  orchestrator should `npm run board:gen`; (c) 17 other clusters flag on the real board today
  (the loop is deliberately capped to the 5 strongest on the rail) — the interesting unexpected
  ones are `[cros+project+shar]` (FEAT-020/030/038/039/041/044 — onboarding/cross-project
  scaffolding re-cut six times) and `[need+rail+decision]` (BUG-016/BUG-025/FEAT-018/FEAT-029/
  FEAT-053 — the Needs-You rail itself re-specified five times); both are legitimate
  architecture questions for a human, not this agent, to answer.
