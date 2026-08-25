```orchard-ticket
{
  "id": "FEAT-056",
  "type": "feature",
  "title": "Repeated fixes in one area never triggered a design review",
  "summary": "Fixes were chosen one ticket at a time, so nobody asked whether a subsystem should be reshaped. A detector now clusters closed tickets by subsystem and raises a finding when the same area keeps breaking. Run against this board, it rediscovered the long-running display-liveness cluster without being told.",
  "impact_if_we_wait": "Structural problems keep getting patched one ticket at a time until the detector runs inside the review loop. Bounded: this affects which work gets proposed, not any shipped behaviour, and nothing is ever refactored automatically.",
  "current_need": "Regenerate the board index so this row moves to Done; the detector already proved itself by rediscovering the recurring cluster unprompted.",
  "severity": "medium",
  "area": "Board tooling and methodology",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-09",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A subsystem with three closed tickets raises a finding naming those tickets",
    "A subsystem with one closed ticket stays silent",
    "A dismissed finding stays dismissed until a new ticket joins the cluster",
    "The architecture ticket template scaffolds and the board handles its ids without drift",
    "A broken board never prevents the server from starting",
    "Run against this repo, the detector names the recurring display-liveness cluster unprompted"
  ],
  "code_refs": [
    {
      "path": "scripts/arch-watch.mjs",
      "symbol": null,
      "note": "recurrence detector added by FEAT-056; pure computation over the board and git, no model judgement"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": null,
      "note": "learns the architecture ticket prefix for the open and done tables and the drift check"
    },
    {
      "path": "docs/bugs/TEMPLATE-ARCH.md",
      "symbol": null,
      "note": "architecture template: invariant, options with trade-offs, migration path, proof bar"
    }
  ],
  "related": [
    {
      "id": "FEAT-019",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-047",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-060",
      "relation": "blocks"
    },
    {
      "id": "FEAT-079",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [
    "BUG-004",
    "BUG-017",
    "BUG-020",
    "BUG-030",
    "BUG-033",
    "BUG-034"
  ],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-056-architecture-review-loop.md",
    "sha256": "2443c8516cbb4013b56e165c1216896669360835b0d02a201b1a0bda81fb530d",
    "bytes": 9739,
    "original_title": "architecture-review loop: stop ticket-driven work from only ever patching locally",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head; the four design parts, both explicit guards, the fixture cases and the real-data acceptance criterion are all present above.",
    "dropped": [
      "the verbatim quotation of the user's original wording of the request",
      "the parenthetical cross-reference to the working agreement's section letters"
    ]
  }
}
```

# FEAT-056 — Repeated fixes in one area never triggered a design review

## Diagnosis

A ticket board optimises for closing tickets, and each agent is scoped to a single ticket, so every fix is local by construction. The working agreement already says a symptom fixed three times means the design is wrong, but that rule only fires when a person happens to notice the pattern. The fifth patch of the agent-strip liveness class was caught by memory alone, and memory does not survive compaction or carry across sessions and projects.

## Evidence

The recurrence detector suite passed 37/37, the board tooling suite 13/13, the working-agreement self-maintenance suite 39/39, the findings-rail suite 18/18, the needs-you rail suite 17/17 and the scope check 12/12. Typecheck and the board drift check stayed clean. The real-data acceptance run against this repo's own board rediscovered the agent-strip liveness cluster (BUG-004, BUG-017, BUG-020, BUG-030, BUG-033, BUG-034) without being pointed at it.

## Implementation notes

Four parts. The detector clusters closed tickets by touched files or declared area and flags a cluster crossing a threshold — roughly three tickets in a subsystem, or two within thirty days — emitting a needs-human finding through the existing findings channel from FEAT-047 so it lands in the Needs-You rail. A distinct architecture ticket class forbids symptom framing and demands the violated invariant, the design producing the class, options with trade-offs, a migration path and a proof bar. The consolidation loop from FEAT-019, which runs after capture and at server boot, gained an arch-watch pass under the same failure-tolerant contract. The standard ticket template gained one required closing line asking whether the symptom points at a deeper design flaw, so structural suspicion is handed forward instead of dropped.

## Verification plan

Scratch board fixtures cover the threshold, the silent single-ticket case, and dismissal persisting until a new ticket joins the cluster. The template must scaffold and the board tooling must handle architecture ids in both check and generate without drift. The consolidation integration is exercised with a broken board to confirm boot still succeeds. The honest proof is the real-data run against this repo's board.

## Risks

The detector could become noise, so it is threshold-tuned, deduplicated by cluster, dismissible like any other finding, and required to state which tickets and files produced it. Cross-provider review is the default when a finding is dispatched, so blind spots stay decorrelated. Two guards are explicit: nothing auto-refactors, since the loop only raises questions for people to decide, and an architecture ticket is not a licence to rewrite working code without a stated invariant, migration and proof bar.

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
