# FEAT-019 — Living-doc self-maintenance: capture what to persist + know when to consolidate

- **Status:** VERIFIED — §L operationalized as CLI tooling (capture + consolidate), and per the 2026-08-05 user decision consolidation is now an AUTOMATIC system (`--apply` safe classes, git-recoverable, auto-run after captures + at server boot; 39/39 checks, real first pass applied — see 2026-08-05 agent entry). UI half (nudge/metadata, Context pack) still OPEN.
- **Severity:** med
- **Area:** claude-station templates / methodology
- **Reported:** 2026-08-04 by user (the "reimproving & re-consolidating is a missing gap")
- **Related:** FEAT-017 (durable working system); WORKING_AGREEMENT.v2 §L (the agent-facing rule)

## Problem
A living instruction doc has two opposite failure modes: **under-persist** (a rule
taught in a session fades with its context and is lost) and **over-accumulate**
(append-only growth → contradictions, redundancy, generic platitudes, over-strict
rules). The gap is the MAINTENANCE loop: knowing WHEN to consolidate and doing it
with nuance, not just piling on. §L of WORKING_AGREEMENT.v2 encodes the agent-facing
behavior; this ticket is the station machinery that operationalizes the "when".

## Design
claude-station already owns living docs (templates with `living: true`) and backs
up on overwrite (saveTemplate → .bak). Build on that:

1. **Per-living-doc metadata:** track size / section-count, `lastConsolidatedAt`,
   count of additions since last consolidation. Cheap, computed on read.
2. **Nudge, don't auto-rewrite:** when a threshold trips (grew > X% or > N
   sections since last consolidation, or a flagged contradiction), surface a
   glanceable "review this living doc?" nudge in the UI. Never silently rewrite.
3. **Consolidate action → an agent proposal:** runs an agent that reads the whole
   doc and surfaces tensions — duplicates, contradictions, over-generic
   platitudes, over-strict rules that backfired, project-specific rules leaking
   into the universal set — and proposes a re-consolidated version as a
   **diff + rationale**. Human approves; prior version recoverable via the
   existing .bak/backupOnce + git. The agent surfaces, the user decides.
4. **Capture flow (the under-persist side):** when a session teaches a standing
   preference or a recurring failure mode, offer to persist it to the RIGHT doc
   (universal Working Agreement vs the project's own doc) — proposed, not silent.

## Verification (REQUIRED)
- Metadata: a doc past threshold reports needs-review; below, does not.
- Consolidate proposal on a doc with a planted duplicate + a planted contradiction
  surfaces both and proposes a merge; approving writes a .bak and the new body;
  rejecting leaves the doc untouched. Real run (a cheap model turn for the agent).
- verify:ui offline + typecheck.

## Context pack
- Touches: src/server/templates.ts (metadata + consolidate endpoint), index.ts
  (routes), public/app.js + styles.css (nudge + diff/approve UI). app.js →
  serialize with other FE tickets.

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
