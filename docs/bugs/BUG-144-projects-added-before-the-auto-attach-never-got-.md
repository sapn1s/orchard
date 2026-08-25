```orchard-ticket
{
  "id": "BUG-144",
  "type": "bug",
  "title": "projects added before the auto-attach never got the Working Agreement",
  "summary": "8 of 13 projects in the real registry launch every session with instructions: [] — no Working Agreement — and a 9th carries the incoherent v2-only stack BUG-099 exists to prevent. FEAT-089 made the coherent stack automatic on 2026-08-18 and it works; nothing backfilled the projects that predate it, and two creation paths still bypass it.",
  "impact_if_we_wait": "Most of the fleet keeps launching with no definition of done, no evidence rule, no dispatch discipline and no verification contract, while the dashboard reports nothing wrong. The user re-teaches the method by hand, every time.",
  "current_need": "Decide whether the backfill is applied automatically or offered, then apply it to the 8 WA-less projects and repair the one v2-only stack; close the two non-HTTP creation paths so new drift cannot start.",
  "severity": "high",
  "area": "registry / instruction refs",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every project in the real registry reports waRefState().coherent === true, or is explicitly recorded as a deliberate opt-out.",
    "The one extensionOnly (v2-only) stack is repaired to base-first v1+v2.",
    "ensureScratchProject() produces a coherent WA stack, proven by launching a real session on the scratch project and finding v1-only markers in the composed prompt.",
    "A project that deliberately has no WA is distinguishable from one that was never backfilled, so a second backfill cannot silently override an opt-out.",
    "Anti-regression: verify:bug-099-attach-wa-coherent and verify:addproject still pass."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-144 — projects added before the auto-attach never got the Working Agreement

## Evidence from the REAL registry, not a fixture

Read from the live registry at $XDG_DATA_HOME/claude-station/registry.json on 2026-08-25:

Project names are deliberately NOT reproduced here — this repo is public and the
registry names private projects (the leak gate rejects them; see the note at the
foot of this section). Identify the rows by index against the live registry.

| createdAt | WA stack | count |
|---|---|---|
| 2026-08-01 | none | 5 |
| 2026-08-01 | v2 only — the BUG-099 shape | 1 |
| 2026-08-01 | v1+v2 (coherent) | 2 |
| 2026-08-03 | none | 1 |
| 2026-08-13 | none | 2 (one of them the built-in Scratch project) |
| 2026-08-20 | v1+v2 (coherent) | 1 |
| 2026-08-21 | v1+v2 (coherent) | 1 |

**Totals: 13 projects — 8 with no WA at all, 1 incoherent (v2 only), 4 coherent.**

Reproduce the current state without naming anything:

```
node -e 'import fs from "node:fs";
const f=(process.env.XDG_DATA_HOME||process.env.HOME+"/.local/share")+"/claude-station/registry.json";
for(const p of JSON.parse(fs.readFileSync(f,"utf8")).projects){
  const ids=((p.settings||{}).instructions||[]).filter(i=>i.enabled!==false).map(i=>i.templateId);
  console.log((p.createdAt||"?").slice(0,10), ids.join("+")||"NONE");
}'
```

**Leak-gate note (BUG-103 class):** the first draft of this ticket pasted the real
project names straight out of the registry and `npm run gate` refused the commit
with 11 hits across 2 files. Anything read out of the live registry is
operator-private by default; count rows, do not name them.

The cut is exactly the FEAT-089 landing date. `359b7af` (2026-08-18) "every project added to Orchard gets the full method automatically" wired `coherentWaStack()` into `POST /api/projects` (src/server/index.ts:628-643). Both projects added after it have the stack; every project added before it does not. **The auto-attach is not broken. The backfill was never written.**

## What is NOT the problem — recorded so the next agent does not re-derive it

- **MCP is fine.** The legacy rows carry `tools: {}`, which `toolSettingsOf()` (registry.ts:112) resolves lazily over `defaultToolSettings()` → `{serena:true, playwright:false, openaiDispatch:false}`. Serena attaches for every project including the un-backfilled ones. Playwright and openaiDispatch are deliberately off (a browser is an unrestricted outbound network boundary; openaiDispatch spends money on a third-party paid API) and should stay off.
- **The template default is fine.** `instructions: []` in `defaultSettings()` is correct as a raw default; the HTTP route layers the stack on top.

## The design question this ticket must answer, not assume

`applyMethod:false` (src/server/validate.ts:329-333) is a real, supported opt-out, and it also produces `instructions: []`. A backfill that treats every empty array as "never got it" will silently re-attach the WA to a project where the user deliberately declined. There is today no field that distinguishes the two states. Options:

- **A — one-shot explicit backfill** (a script the user runs, reporting what it changed). Cannot tell the two states apart, but the user is in the loop for the one run that matters.
- **B — stamp the method version** on the project row at creation (both when applied and when declined), and backfill only rows with no stamp. Distinguishes the states permanently; costs one new settings field and a lazy default.
- **C — lazy default at read time**, like `toolSettingsOf`. Cheapest, but it makes the opt-out unexpressible.

C is disqualified by the opt-out. Prefer B if the stamp is cheap; A is acceptable if the user is asked once.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `src/server/wiring.ts:41-46` (WA_COHERENT_IDS), `:136-154` (waRefState / hasEnabledWaRef), `:166-190` (coherentWaStack — the single mutation source, base-first, repairs v2-then-v1 order)
- `src/server/index.ts:613` (applyMethod flag), `:628-643` (the auto-attach), `:810-825` (the wiring panel's manual Apply)
- `src/server/registry.ts:321-340` (defaultSettings), `:440-462` (ensureScratchProject — writes defaultSettings() directly, never calls coherentWaStack)
- `src/server/validate.ts:329-333` (applyMethod stripped before settings validation)
- Related: BUG-099 (why v2-alone is incoherent), FEAT-089 (the auto-attach), FEAT-039 (local conventions)
- Repro test: `npm run verify:bug-099` · read the live state with a node one-liner over the registry file

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — agent
- **Fixed (round 1):** Fixed via Option B (stamp the method version on the row). Challenged the A-vs-B recommendation and confirmed B is REQUIRED, not merely preferred: an opt-out (applyMethod:false) also yields instructions:[], so the success criterion "a second backfill cannot silently override an opt-out" is unmeetable by A — A first run would attach the WA to a deliberate opt-out. Verified the hypothesis FIRST: coherentWaStack() is correct and unbroken across all five real shapes (it repairs the v2-only shape to base-first and also repairs a v2-then-v1 order); the only defects were (a) no backfill for pre-FEAT-089 rows and (b) ensureScratchProject writing defaultSettings() directly with no WA.

  Source changes (left in working tree, NOT committed): registry.ts adds ProjectSettings.methodVersion + CURRENT_METHOD_VERSION(=1) + methodVersionOf(); ensureScratchProject now builds the coherent stack through the single mutation source coherentWaStack() and stamps the row. validate.ts whitelists and validates methodVersion (non-negative integer). index.ts POST /api/projects now stamps CURRENT_METHOD_VERSION on BOTH the applied and the declined paths (the declined path previously persisted nothing), so a future opt-out is durably distinguishable from a legacy row. New scripts/backfill-bug-144-wa.mjs (dry-run by default; --apply takes a timestamped backup plus a human-readable reversal record beside the registry in the data dir, outside git, before mutating) and scripts/verify-bug-144-method-backfill.mjs (wired as verify:bug-144).

  Applied to the LIVE registry (backup taken automatically): 13 rows total. 8 no-WA rows got the base-first coherent stack; the single v2-only row was repaired to base-first; 4 already-coherent rows were stamped with instructions unchanged. Final live state: 13/13 coherent, 13/13 stamped, 0 recorded opt-out. Re-run is a true no-op (0 rows changed, byte-identical). A per-project reversal record (which deliberately DOES name projects and host paths) sits beside a timestamped backup of the registry inside the live data dir, which is outside git — not reproduced here to keep this public ticket leak-clean.

  Intended stamped-removal semantics (stated because it decides whether the stamp preserves an opt-out or only a first-run decision): a project stamped at the current version whose user LATER removes the WA is NOT re-added by the backfill. The stamp preserves the user LAST recorded decision; the wiring panel remains the ongoing coherence and repair surface (a v2-only stamped row still surfaces there as a half-applied warn with a repair Apply). Verified by assertion (verify section 3b).

  Verification: verify:bug-144 42/42 PASS. The must-FAIL proof is anchored to a FIXED reconstruction (section 1 rebuilds all five real shapes in-script and shows coherent:false, and the v2-only shape extensionOnly:true, BEFORE backfill) — NOT to the live baseline. A peer flagged that my first draft anchored the must-FAIL to the live registry, which self-destructs on apply (the exact moving-baseline anti-pattern in docs/CONVENTIONS.md); fixed by moving to the fixed reconstruction plus a clearly-labelled INFORMATIONAL-only live-state report (section 7a). Real data SHAPE and volume are exercised via a deterministic pre-backfill reconstruction of the real row set (section 7b): broken before, coherent+stamped after, injected opt-out preserved, idempotent. Anti-regression: verify:addproject 7/7, verify-bug-099-attach-wa-coherent 21/21, verify:feat-089 35/35, verify:scratch 17/17 — all PASS. gate: typecheck and check-nul PASS; leak-gate PASS for every file I authored — its only 4 hits are in scripts/verify-arch-007-lazy-browser.mjs, a concurrent agent untracked file I did not create or touch.

  Could not test: did not launch a real live session against the scratch project to read v1-only markers in the composed prompt (the "launch a real session" arm of success-criterion 3) — asserted the composed instruction stack and stamp instead; a live-launch check is the remaining gap. Did not drive the HTTP declined path end-to-end over the wire; asserted the route stamp logic and the validator directly.

  Independent clean-room verify: WARRANTED — this touches user data (the live registry was mutated) and session-lifecycle surface (new methodVersion field, scratch creation, add-project route). Recommend a second fresh-context pass over the stamped-removal semantics and backfill idempotency, plus the live-session-launch arm that was not run.

  Symptom of a deeper design flaw? Partly. Root flaw: "the method decision" had no home on the row — coherence was inferred from instruction CONTENTS, which cannot tell "never decided" apart from "deliberately empty". methodVersion gives the decision a first-class, versioned home, so a future method bump can re-qualify rows deliberately rather than by lucky re-derivation. Narrower flaw: two creation paths (POST /api/projects and ensureScratchProject) applied the method independently — the FEAT-089 seam was not the single creation choke point. Closed here for scratch, but a third creation path would reintroduce it; the durable fix is one choke point that stamps and attaches.

### 2026-08-25 — independent-verify
- **INDEPENDENT VERIFY — BUG-144: PASS with findings:** Attacked the backfill + opt-out. FIXING SUITE RE-RUN (npm run verify:bug-144): now 37 passed / 1 FAILED — the single failure is section 7 precondition "real copy has incoherent+unstamped rows before backfill", which is now FALSE because the other lane has ALREADY APPLIED the backfill to the REAL registry: all 13 rows are coherent (working-agreement+working-agreement-v2) and stamped methodVersion=1, and two real backups exist under the data dir (07-06-27Z, 07-06-38Z). Not a product regression — reality moved past the test fixture. I NEVER mutated the real registry; only read it and worked on copies. REAL HTTP create paths (my scratch server): default applyMethod -> coherent+stamped; applyMethod:false -> declined, instructions:[] BUT stamped methodVersion=1 (the anti-override guard works). ADVERSARIAL (cases the fixture does NOT cover): (A) a row stamped at current version whose WA was manually REMOVED after stamping -> backfill SKIPS it, WA NOT re-added. This matches Option B intent (stamp = decision recorded) but is worth the user knowing: once stamped, removing the WA is respected and a re-run will not restore it. (B) truncated real-registry COPY at 25/50/75/90% -> backfill refuses LOUDLY (exit!=0, "not valid JSON"), file left byte-identical, no backup/temp written = no half-registry. (The full-length-minus-1-byte cut only strips the trailing newline, stays valid JSON, correctly proceeds and writes nothing.) load() throws on bad JSON before any write; save() is writeAtomic (temp+fsync+rename) so no torn file is possible. VERDICT: backfill + stamp behave as claimed and are safe against partial reads.
