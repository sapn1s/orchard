```orchard-ticket
{
  "id": "FEAT-117",
  "type": "feature",
  "title": "Working Agreement v4 — one document superseding v1/v2/v3",
  "summary": "A single standalone Working Agreement replacing v1/v2/v3. It restores every measured-failure rule v3 silently dropped (the whole §I dispatch/verification contract, most of §C, §N file/build boundary, §H/§J/§K/§L/§M/§E, v1 §6), cuts redundancy, and preserves stable anchors A–N so cross-references resolve. Canonical in ~/projects/methodology, byte-identical mirror. Rolled out live to all 14 projects (methodVersion 3).",
  "impact_if_we_wait": "None outstanding — v4 is live fleet-wide. The one deferred item is the new-project default in src/server/templates.ts, which needs a server restart (user's call) before newly-added projects auto-attach v4 instead of v3.",
  "current_need": "Nothing blocking. Optional: restart the station at the user's discretion so the new-project default and CURRENT_METHOD_VERSION=3 take effect for future projects; existing 14 projects are already on v4/mv3.",
  "severity": "high",
  "area": "working agreement / injected instructions",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "v4 contains every rule the v3 condensation dropped (mechanical rule-by-rule coverage proof + an independent clean-room inventory reviewer).",
    "Stable anchors A–N preserved with their meanings so §-cross-references in docs/CONVENTIONS.md, docs/bugs/README.md, src/server/templates.ts, ROUTING.md and patterns resolve.",
    "Both v3 active regressions removed: no 'inspect the project before adding code' inline-read instruction, and section letters exist.",
    "Canonical in ~/projects/methodology, mirror byte-identical, do-not-edit banner present, npm run sync:methodology clean.",
    "Rolled out to all 14 projects via the API with a pre-change backup of registry and template store; before/after recorded."
  ],
  "code_refs": [],
  "related": [],
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

# FEAT-117 — Working Agreement v4 — one document superseding v1/v2/v3

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — agent (build + coverage proof + live rollout)
**What v4 is.** One standalone document (`docs/prompts/WORKING_AGREEMENT.v4.md`, canonical
`~/projects/methodology/WORKING_AGREEMENT.v4.md`) that supersedes v1/v2/v3. Built from all three,
not a rollback and not a patch on v3. 5,448 words / 34,296 chars vs v1+v2's 6,732 words and v3's
500 — a 20% cut from v1+v2 while folding ALL of v1 in as lettered sections (v2 alone was 5,763).
The floor is set by the measured specifics, not prose: every threshold, dollar figure, percentage
and both decision tables survive verbatim.

**The portability split (the root cause v3 got wrong).** Codex classed "agent orchestration,
ticket systems, tool-channel mechanics" as product infrastructure and excluded them — they are
universal METHOD, not Orchard machinery. v4 states the split explicitly in a "Scope & portability"
preamble: every lettered rule is universal and stays universal even when it names a concrete tool
(the rule is the principle, not the command); genuinely project-specific material (board file
layout, CLI command names, injection-budget limits) is marked inline as "if the project provides
it" or lives in the "Project-specific conventions" tail. When in doubt, a rule is universal.

**Stable anchors.** A clean-room map of every §-reference in the repo confirmed the externally
cited letters are A,B,C,D,E,H,I,J,K,L,M,N (no real §F/§G refs exist). v4 preserves all of A–N with
their meanings; v1-only content that had no letters is appended as §O (blocked≠stopped), §P
(user-facing quality bar) and §Q (final report). No cross-reference in docs/CONVENTIONS.md,
docs/bugs/README.md, src/server/templates.ts, ROUTING.md or patterns/ is left dangling.

**Both v3 regressions removed:** the "inspect the project before adding code" inline-read
instruction is gone (§B now says explicitly "not licence to read the codebase inline; see §I"), and
section letters exist again.

**Coverage proof (two independent methods).**
1. Mechanical rule-by-rule grep against the attribution inventory: every dropped item PRESENT —
   the full §I inline threshold / context-is-a-liability / orchestrator-does-not-implement /
   dispatch-class table / generation-must-not-verify clean-room contract / executed-evidence bar /
   fixer-demonstrates-verifier-attacks / report-reader-is-not-a-verifier (0-of-7) / harm-class
   rounds table / falsifiable-hypothesis; §C two-signals, installed≠done, completion-notice
   (51.6-min) rule; §N two-reasons file/build boundary, stopping rule, ARCH container; §H/§J/§K/§L
   /§M/§E; v1 §6 parallelism. All measured numbers present ($444/$131, 93.2%, ~300k, 51.6, ~12/~68).
2. An INDEPENDENT clean-room reviewer (separate process, given ONLY v1/v2/v4 and an inventory
   question — none of this task's framing) confirmed every threshold and both tables survive, and
   flagged: one genuinely absent rule ("preserve intentional deviations") and a few weakened ones
   (general reversible-by-default, "what would prove it", narrow-scoped reviewers, explore
   cross-provider optionality). All were RESTORED. The remaining reviewer findings were dropped
   ILLUSTRATIVE measurements/examples (the "a third of rounds" figure, the detach example, the
   five/six-rounds example, the landing-page example, the 2026-08-11 stall date, "7.6 min") whose
   checkable rule and threshold are retained — a deliberate prose cut, listed here rather than
   silent.

**Consolidations (merged, not dropped):** "generation must not verify itself" stated in full in
§I with a one-line pointer from §C (v2 had it twice); §N's stopping-rule prose folded into the §I
harm-class rounds table with a §N pointer (v2 had both).

**Canonical/mirror:** written canonical-first, `npm run sync:methodology` byte-identical (5 files
in sync incl v4), do-not-edit banner present this time (v3's mirror lacked it). `sync-methodology.mjs`
FILES list gained the v4 entry.

**Live rollout — done, after the document was finished and coverage proven (not before).**
- Backups first: current (v3-state) registry → `~/.local/share/claude-station/registry.pre-wa-v4-20260902T181821.json`;
  template store → `~/.local/share/claude-station/templates.pre-wa-v4-20260902T181821.tgz`. The
  earlier pre-v3 registry backup at `registry.pre-wa-v3-20260902T1445.json` remains the path back
  to v1+v2.
- Created a source-backed `working-agreement-v4` template in the live store via `POST /api/templates`
  (source: docs/prompts/WORKING_AGREEMENT.v4.md), so the running server read-through resolves it
  with no restart.
- PATCHed all 14 projects via `PATCH /api/projects/:id` to `instructions:[{working-agreement-v4}]`,
  `methodVersion:3`. BEFORE: every project `[working-agreement-v3]` mv=2. AFTER: every project
  `[working-agreement-v4]` mv=3. Persistence confirmed in the live registry (14/14).
- End-to-end proof: `verify:wa-injected` 10/10 PASS — the composed system prompt for a real
  registered project carries v4 markers, absent in the empty-stack control, wiring reports ok, no
  template failed to resolve. v4 adds ~8,503 tokens/session (vs v3 ~900) — the deliberate cost of
  restoring every measured rule, flagged for the record.

**methodVersion decision:** bumped `CURRENT_METHOD_VERSION` 2→3 (v1+v2=1, v3=2, v4=3) so the number
stays meaningful — each value maps to the canonical method doc rolled out. Existing projects
explicitly stamped mv=3 via the API; the source constant takes effect for new projects on restart.

**Restart-gated (user's call):** the new-project auto-attach default and CURRENT_METHOD_VERSION live
in compiled `src/server/templates.ts`/`wiring.ts`/`registry.ts`; a newly-ADDED project keeps
getting v3/mv2 until the station is restarted. Not restarted here (never restart a live station
mid-flight). No :4317 restart, no service/scope touched — API calls only.

**Anti-regressions:** typecheck exit 0; leak-gate clean on all my files (only the 3 pre-existing
stray `.py` files fail, not mine; v4 doc scanned — no home paths/usernames/private names);
verify:methodology-sync OK, verify:template-readthrough 18/18, verify:local-conventions 18/18,
verify:routing-inject 18/18, verify:wa-selfmaintain 43/43. (verify-bug-099-attach-wa-coherent is a
standalone, non-gated script testing the OBSOLETE two-doc attach model — already non-current since
the v3 rollout; not chased.)

**Risk bucket:** fleet-wide injected-instruction change + live registry mutation across 14 real
projects — high-stakes/regression-prone. Self-verified via mechanical proof + an independent
clean-room inventory reviewer, but a second fresh-context clean-room verify pass over the
document-vs-inventory diff is warranted before this is considered closed.

**Contended files (carry other lanes' uncommitted work too):** `src/server/registry.ts`,
`src/server/wiring.ts`, `src/server/templates.ts` already held the v3 lane's uncommitted changes;
my hunks build coherently on top (registry 1→3 subsumes the v3 lane's 1→2; wiring WA_DEFAULT_ID→v4
keeps the v3 lane's waRefState/coherentWaStack logic; templates adds the v4 seed after v3).
Committing these files commits both lanes' work as one coherent "v4 supersedes v3" change.
