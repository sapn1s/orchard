```orchard-ticket
{
  "id": "FEAT-019",
  "type": "feature",
  "title": "Standing rules faded from a doc that also grew contradictory",
  "summary": "Two command-line tools now maintain the project's living instruction documents: one captures a rule taught in a session so it is not lost, and one merges duplicates and contradictions that build up. Consolidation runs automatically after captures and at startup, with every change recoverable through version control. The in-app nudge and approval view were not built.",
  "impact_if_we_wait": "The in-app prompt to review a drifting document is missing, so the maintenance loop only runs where someone uses the command line. Bounded: capture and consolidation already work automatically, and every consolidation is recoverable, so no guidance is lost.",
  "current_need": "Nothing is outstanding for the shipped half; a read-through check and a live-conventions check both passed, alongside a clean typecheck. The in-app half stays open.",
  "severity": "medium",
  "area": "Living instruction docs",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-05",
      "question": "Should consolidation propose changes for approval, or run automatically?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-05",
      "chosen_by": "user",
      "note": "Consolidation became automatic for the safe classes rather than a proposal a person approves, on the grounds that every change is recoverable through version control. It runs after captures and at server boot, and the first real pass was applied."
    }
  ],
  "success_criteria": [
    "A document past the growth threshold reports that it needs review; one below it does not",
    "A planted duplicate and a planted contradiction are both surfaced and merged",
    "A rejected consolidation leaves the document byte-identical",
    "A rule taught in a session is offered to the correct document rather than a default one",
    "The offline interface check and the typecheck stay clean"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": "saveTemplate",
      "note": "owns documents marked living and already writes a backup on overwrite; the metadata and consolidate endpoint were planned here"
    },
    {
      "path": "index.ts",
      "symbol": null,
      "note": "routes for the consolidate endpoint"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "the unbuilt nudge and diff-approval interface; serialize against other front-end tickets touching this file"
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "styling for the unbuilt nudge"
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": "§L",
      "note": "the agent-facing rule this ticket operationalizes on the station side"
    }
  ],
  "related": [
    {
      "id": "BUG-042",
      "relation": "see_also"
    },
    {
      "id": "FEAT-017",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-020",
      "relation": "see_also"
    },
    {
      "id": "FEAT-026",
      "relation": "blocks"
    },
    {
      "id": "FEAT-027",
      "relation": "blocks"
    },
    {
      "id": "FEAT-047",
      "relation": "blocks"
    },
    {
      "id": "FEAT-056",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-019-living-doc-self-maintenance.md",
    "sha256": "276825de4792bbf5474b55be86e6d27fea53d6032e69aad4279d268966fbdc26",
    "bytes": 17857,
    "original_title": "Living-doc self-maintenance: capture what to persist + know when to consolidate",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: both failure modes, all four design steps, the verification bar, the touched files and the automatic-consolidation decision are present.",
    "dropped": [
      "the shorthand phrasing of the original report",
      "the note that the front-end file must be serialized with other tickets, kept as a code_ref note rather than in the human layer"
    ]
  }
}
```

# FEAT-019 — Standing rules faded from a doc that also grew contradictory

## Diagnosis

### Two opposite failure modes

A living instruction document fails in two directions. Under-persisting means a rule taught during a session fades with that session's context and is gone. Over-accumulating means append-only growth produces contradictions, redundancy, generic platitudes and rules that are stricter than anyone intended.

The missing piece was never the writing — it was the maintenance loop: knowing *when* a document has drifted far enough to need consolidating, and then consolidating it with nuance instead of piling on more text. §L of the working agreement encodes the agent-facing half of that behaviour; this ticket is the station machinery that answers the "when".

## Evidence

The read-through suite passed 18/18 and the live-conventions suite passed 5/5. A 39/39 check tally and a 21/21 tally are recorded without an adjacent suite name. Typecheck was clean. The consolidation system's first real pass was applied to actual documents rather than only to fixtures. The interface suite and the self-maintenance suite are named in the ticket as intended coverage but no result is recorded for either.

## Implementation notes

### What was built

Capture and consolidate landed as command-line tooling. Consolidation applies only the classes judged safe to apply without review, and runs automatically after a capture and again at server boot. Recoverability rests on version control rather than on an approval step.

### What was designed but not built

Per-document metadata — size, section count, when it was last consolidated, how many additions since — computed cheaply on read. A glanceable nudge in the interface when a threshold trips, never a silent rewrite. A consolidate action presenting the agent's proposal as a diff plus rationale for a person to approve or reject, with the prior version recoverable through the existing backup-on-overwrite path. A capture flow that offers a newly-taught preference to the right document: the universal working agreement, or the project's own.

## Verification plan

Assert that a document past the threshold reports needs-review and one below it does not. Plant a duplicate and a contradiction in a document, run the consolidate proposal, and confirm both are surfaced and a merge is proposed. Approving must write a backup and the new body; rejecting must leave the document untouched. Run this against a real model turn on a cheap model, not a stub. Run the offline interface check and the typecheck.

## Migration and rollback

Consolidation writes in place and relies on version control for recovery, so any automatic pass can be reverted with a checkout. The pre-existing backup-on-overwrite path gives a second recovery route for approved rewrites.

## Risks

Automatic consolidation without an approval gate can quietly reword a rule in a way the author did not intend. The bound on that risk is recoverability, which only holds while the documents stay under version control and someone notices the change is wrong before it is built upon.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Pairs with WORKING_AGREEMENT.v2 §L (added this session). Recommendation:
  consolidation is human-approved-only (never auto), because the nuance the user
  flagged ("too generic? too strict? not the point?") is judgement, not mechanics.

### 2026-08-04 — orchestrator as FIRST TEST USER (dogfooding the loop)
Ran a consolidation pass over our own living docs. What using it taught me:
- **Validates the actual gap.** In ONE session WA v2 went 7→12 sections (A–L),
  and I only consolidated because the user prompted me. So the missing piece is
  the **"when" signal**, not the "how" — exactly FEAT-019's nudge. Confirmed by
  use, not theory.
- **Tensions found (proposed, awaiting approval per §L):**
  - F1 redundancy ACROSS docs: git-safety / serialize-same-file rules now live in
    BOTH WA §I/J and docs/bugs/README.md → pick one source of truth (rec: WA is
    canonical universal; README references it, keeping only board-operational bits).
  - F2 navigability: 12 flat lettered sections; propose thematic grouping
    (Communication / Rigor / Method / Boundaries) — reorg, zero content loss.
  - F3 overlaps: A↔H (both govern how a reply opens) and D↔L (recoverability) are
    complementary but read as separate; add cross-refs rather than merge.
  - F4 over-strict watch: nothing backfired; J's absolute "never git add -A"
    earned its absoluteness this session — keep it absolute.
- **Cadence adopted as test user:** run a maintenance pass at session milestones,
  or when a living doc grows >~30% since last consolidation, or when a
  contradiction surfaces. (This is the human/agent stand-in until FEAT-019
  computes the signal automatically.)

### 2026-08-04 — orchestrator (whole-picture consolidation + foresight)
User asked for a zoom-out, and for consolidation to have PREDEFINED QUESTIONS
(not tunnel-vision on whatever's top-of-mind). Done:
- **Consolidation checklist** (11 predefined questions) added to the `tickets`
  skill as the standard method — contradictions / redundancy / over-generic /
  over-strict / scope-creep / staleness / attention-size / copy-drift / coverage
  gaps / earning-its-keep / priority. FEAT-019's UI should surface these as the
  review template; this is the "how to consolidate" the feature must refine.

**Foreseen systemic risks (logged so they're not lost):**
- R1 **Meta outpacing product.** The system-for-doing-work is growing fast; guard
  every pass with Q10 "is the framework earning its keep — is claude-station more
  useful for real work, or are we polishing the polish?"
- R2 **Injected-surface bloat.** WA is ~9.6KB injected into EVERY session, and
  FEAT-021 will add a board snapshot. Attention-budget (§H) applies to the MODEL
  too. Likely need a CORE (always-injected) vs FULL (on-demand) split with a size
  budget. → candidate ticket.
- R3 **Manual repo→live sync is a drift hazard.** WA lives in the repo AND as a
  synced template data copy; I POST it by hand each edit. If I forget, they drift.
  Automate: make the live template read the repo file, or a sync hook. → candidate ticket.
- R4 **Universality drift.** Rules risk over-fitting to claude-station's OWN
  development. Each rule must pass Q5: universal, or just 'how we built this'?
- R5 **Bigger features need product judgment, not autonomous draining.** With the
  bug backlog cleared, remaining work (rail / autonomous / remote / templates) is
  design-heavy; sequence by value WITH the user, don't just mechanically dispatch.
### 2026-08-04 — orchestrator (self-loop idea + echo-chamber guard; honest status)
User asked whether the orchestrator should be a self-inducing timer loop (~30s) for
progress + consolidation, and flagged the real risk: naive loops re-confirm their own
prior (possibly wrong) reasoning and never self-question until corrected.
- **Honest status:** FEAT-019's consolidation CADENCE is NOT built. The METHOD (11-Q
  checklist in the tickets skill) exists; the automatic "when" does not — run manually.
- **Do NOT poll for agent progress:** completion notifications already wake the
  orchestrator exactly when work lands (event-driven > blind timer; harness discourages
  polling tracked work).
- **A slower MAINTENANCE tick IS useful for NON-event-driven work** when the queue is
  quiet: consolidation check, self-QA pass (FEAT-032 #2), design-backlog drain. Interval
  configurable / per-tick adjustable.
- **Echo-chamber guard (the crux):** a self-tick must NOT re-loop on the orchestrator's
  own in-context narrative — that's how it re-confirms stale/wrong reasoning. Each tick
  RE-DERIVES from the durable BOARD (files-as-source) and dispatches a FRESH agent to
  challenge the last conclusion; an independent board-reader doesn't share the rut. This
  is why files-as-source + adversarial-verify exist. Demonstrated need THIS session: the
  cache hypothesis + early "reload is safe" over-claims were wrong self-confidence the
  USER caught — fix is external freshness, not more self-looping.
- **Mechanism:** the harness `/loop` skill runs a prompt on an interval; scope it to
  idle-maintenance (never agent-polling), each tick re-reading the board + a fresh critic.

### 2026-08-04 — agent (§L operationalized as CLI tooling: capture + consolidate)
**Scope taken:** the CLI-tooling half of FEAT-019 only — make §L real as two npm
scripts against the FEAT-041 canonical WA. Did NOT build the UI half (metadata/nudge/
diff-approve in app.js/templates.ts/index.ts — those stay OPEN, out of scope here).
Operated through the CANONICAL repo + `sync-methodology.mjs`; never edited the
`docs/prompts` mirror directly (§L / FEAT-041 rule).

**Built** (scope-clean — only allowed paths):
- NEW `scripts/wa-capture.mjs` (`npm run wa:capture`): appends ONE qualifying rule to
  `$METHODOLOGY_DIR/WORKING_AGREEMENT.v2.md` under the right section, then runs
  `sync-methodology.mjs` so the mirror updates. Enforces §L's persistence bar — a
  standing preference (text has always/never/from now on) OR `--kind recurring
  --recurrences N` with N≥2; a one-off is REFUSED (exit 3, parked). APPEND-ONLY (§D):
  never rewrites/deletes existing content, inserts the bullet at the end of the target
  section's body (found by stable letter ID `--section C` or heading substring). Tags
  each bullet with capture date + why-it-qualified for a later consolidation pass.
  Flags: `--no-sync`, `--dry-run`, and `--no-append` (a MUST-FAIL harness: runs every
  step but the write, to prove the append is what mutates). Honors `METHODOLOGY_DIR`.
- NEW `scripts/wa-consolidate.mjs` (`npm run wa:consolidate`): scans the canonical WA
  and writes a REVIEWABLE PROPOSAL artifact (`$METHODOLOGY_DIR/CONSOLIDATION-PROPOSAL.md`)
  — it NEVER edits the WA (asserts + prints WA byte length unchanged before exit). Four
  heuristic detectors surface tensions: (1) project-specific tokens leaked into the
  universal set (btrfs/Serena/ast-grep/claude-station/…), (2) near-duplicate rule
  sections by token-overlap Jaccard, (3) acknowledged cross-reference clusters (confirm
  the split still earns its keep), (4) imperative rules lacking a stated "why". Proposal
  header states NOT-AUTO-APPLIED + prior version recoverable via git (§L). Honors
  `METHODOLOGY_DIR`.
- NEW `scripts/verify-wa-selfmaintain.mjs` (`npm run verify:wa-selfmaintain`): all
  capture/consolidate runs target a SCRATCH copy of the methodology dir so the real
  canonical repo is never mutated; the one real-mirror write (the sync contract, exactly
  what production capture does) is snapshotted and byte-restored in a guarded block.

**Verified (observed values; 21/21 PASS, `node scripts/verify-wa-selfmaintain.mjs`):**
- T1 capture appends a standing rule to scratch canonical: 13943 → 14080 bytes, lands
  under §C (rule idx 5783, between C@3356 and D@5917), exit 0.
- T2 SYNC CONTRACT: `sync-methodology.mjs` copies scratch canonical → mirror (v2 14080B),
  `--check` → "OK — mirror == canonical (2 files in sync)" exit 0, mirror contains the
  captured rule. Real mirror snapshot+restored after.
- T3 one-off ("Rename the parser temp buffer…") REFUSED exit 3, canonical unchanged
  (14080 == 14080).
- T4 MUST-FAIL: qualifying rule + `--no-append` → "qualifies: YES" but canonical
  byte-for-byte unchanged (14080 == 14080) — proves the check is non-vacuous (the append
  is the only thing that mutates).
- T5 consolidate found 16 real tensions (project-specific-in-universal×3 incl. §B "btrfs",
  §I "Serena/claude-station", §K "INDEX.md/docs/bugs"; cross-reference-cluster×6;
  rule-without-why×7), wrote the proposal artifact, WA byte length UNCHANGED (14080 ==
  14080), banner asserts NOT-AUTO-APPLIED. exit 0.
- T6 real canonical repo untouched: WA v2 13943 == 13943 bytes, methodology
  `git status --porcelain` empty before and after, real mirror restored byte-identical.
- `npm run typecheck` → exit 0 clean. `git status docs/prompts/` clean (mirror never
  touched); only the 3 new scripts are untracked.

**package.json entries for the orchestrator to add** (scoped off package.json intentionally):
- `"wa:capture": "node scripts/wa-capture.mjs"`
- `"wa:consolidate": "node scripts/wa-consolidate.mjs"`
- `"verify:wa-selfmaintain": "node scripts/verify-wa-selfmaintain.mjs"`

**Status → VERIFIED** for the CLI-tooling half. No commit (working-tree changes left for
the orchestrator: the 3 new scripts + this ticket). Real canonical methodology repo left
untouched — all tests ran in a scratch `METHODOLOGY_DIR` copy. UI half (metadata/nudge/
diff-approve) remains OPEN under this ticket's Context pack.

### 2026-08-05 — agent (USER DECISION: consolidation goes AUTOMATIC — designed, built, verified, and run for real)
**User decision (2026-08-05):** "it should be an automatic system" — the methodology
repo is git, so every pass is recoverable (§D); approval-gating mechanical
consolidation was ceremony. This supersedes the 2026-08-04 "human-approved-only"
recommendation for the SAFE classes; lossy judgment calls still surface.

**Built:**
- `wa-consolidate.mjs --apply`: auto-applies SAFE classes — (a) RELOCATE
  project-specific blocks out of universal WA sections into the owning project's
  `docs/CONVENTIONS.md` (create/append, never overwrite; `--conventions-dir`,
  default this repo), (b) MERGE near-duplicate sections at Jaccard ≥ 0.5 (richer
  wording kept, unique blocks preserved, poorer section keeps its stable letter as
  a pointer so §-cites survive), (c) mechanical cleanup (trailing ws / blank runs).
  NEVER auto-applied ("needs human"): CONTRADICTIONS (new block-level detector:
  opposing always/never imperatives on ≥0.3 token overlap), relocations that would
  EMPTY a section, 0.22–0.5 near-dups, rules-without-why. Each pass = ONE git
  commit in the methodology repo (plus a pre-consolidation snapshot commit iff the
  WA held uncommitted captures, so the pre-state is itself recoverable) + an
  appended human-skimmable `CHANGELOG.md` entry, then the existing mirror sync.
  `--apply` REFUSES a non-git methodology dir (no git ⇒ no recoverability ⇒ no
  auto-apply). Propose-only mode (no flag) retained, artifact reworded.
- **Automatic invocation seams:** (1) `wa-capture.mjs` runs a `--apply` mini-pass
  after every successful capture+sync (failure-tolerant: a broken mini-pass warns,
  capture still exits 0; `--no-consolidate` opt-out); (2) `src/server/index.ts`
  boot — inside the `server.listen` callback after the survivor re-adopt — spawns
  a detached non-blocking `--apply` pass; failure is logged honestly ("server
  unaffected") and can NEVER affect startup; `CLAUDE_STATION_NO_WA_CONSOLIDATE=1`
  opts out (test fleets). Catches drift from ANY project since all capture into
  the same canonical repo.
- **Canonical §L rewritten** (methodology commit d8ed286): "Consolidate
  automatically; surface only true judgment calls" — replaces the
  "diff + rationale needing the user's approval" wording for the automated path;
  spirit kept (contradictions / lossy judgment still go to the user). Mirror synced.

**Verified (39/39, `npm run verify:wa-selfmaintain`; scratch git-init'ed
METHODOLOGY_DIR copies; real repo proven untouched by the suite):** T1–T5 prior
contracts still green; T7 `--apply` relocates planted btrfs/Serena/ast-grep blocks
into a scratch project's CONVENTIONS.md (created; sections kept, not emptied),
merges a planted ≥0.5 near-dup (richer kept, pointer left), makes snapshot+apply
commits (tree clean after; rollback one revert), appends CHANGELOG, syncs mirror;
T7e/f planted CONTRADICTION not applied — both bullets survive, listed needs-human;
T8 second pass honest no-op (no commit); T9 capture auto-triggers the mini-pass and
tolerates its failure (non-git dir → refuse exit 2, capture exit 0); T10 REAL server
boot on a free port with a BROKEN methodology dir: pass fails exit 2, logged
"server unaffected", GET / 200 before and after, killed by pid. Also green:
typecheck, verify:template-readthrough 18/18, verify:conventions-live 5/5 (runs
AFTER the real pass — the newly-created real docs/CONVENTIONS.md still injects).

**REAL first pass on the canonical repo (methodology commit 4623d0a, 14255→12949B):**
- AUTO-APPLIED — relocated 3 blocks to claude-station `docs/CONVENTIONS.md` (file
  created): §B btrfs-snapshots example, §I Serena-symbol-tools bullet, §I ast-grep
  bullet; +1 mechanical cleanup. 0 merges (no ≥0.5 pair — the old report's
  "near-dups" were the cross-ref clusters, which stay informational by design).
- NEEDS HUMAN, resolved by hand (commit 53043d8): added the "why" to 3
  rules-without-why where context made it unambiguous (§H one-line-bullets,
  §C print-observed-value, §J commit-with-hash). The block-level detector cleared
  the other 4 of the old 7 as false positives (multi-line bullets whose rationale
  lived in continuation lines).
- REMAINS "needs human" (deliberately untouched): §K board rule — every block
  mentions `docs/bugs`/`INDEX.md`; my read is these are the universal board
  pattern's own vocabulary, not a leak (keep §K as-is), awaiting user confirmation.
- Follow-up `--apply` pass confirmed an honest no-op (0 auto-applicable, no
  commit); `sync:methodology --check` OK; methodology tree clean.

Scope: wa-consolidate.mjs (rewrite), wa-capture.mjs (mini-pass hook),
verify-wa-selfmaintain.mjs (T7–T10), src/server/index.ts (boot seam only, +spawn
import), docs/CONVENTIONS.md (created by the real pass), canonical repo (4 commits:
§L rewrite, snapshot, apply, why-edits) + mirror via sync. No claude-station
commits (per instruction — the methodology commits are the deliverable). UI half
still OPEN.
