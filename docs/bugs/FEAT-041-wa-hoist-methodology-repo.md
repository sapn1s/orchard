```orchard-ticket
{
  "id": "FEAT-041",
  "type": "feature",
  "title": "Working Agreement had no home outside this project",
  "summary": "The shared Working Agreement now lives in its own project-neutral repository, with a committed copy kept inside this project so a session still launches when that repository is absent. A sync command copies the canonical text into the copy and warns when the two diverge. The read-through injection suite passed 18 of 18.",
  "impact_if_we_wait": "None outstanding: the shared agreement has a stable home and the injected instructions are unchanged. Bounded either way to where the document is stored, not to what any session receives.",
  "current_need": "Nothing is outstanding. The read-through injection check passed unchanged after the move, and standing type checks stayed clean.",
  "severity": "medium",
  "area": "Cross-project methodology sharing",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Where should the universal Working Agreement live once it is shared across projects?",
      "mode": "single",
      "options_keys": [
        "dedicated-repo"
      ],
      "chosen": "dedicated-repo",
      "chosen_on": "2026-08-04",
      "chosen_by": "user",
      "note": "The user asked for a dedicated repository and left the design to the agent; this became FEAT-041, filed as the second gap of FEAT-039."
    }
  ],
  "success_criteria": [
    "The composed session instructions still emit the full Working Agreement after the move",
    "Sync copies the canonical document into the in-project copy",
    "Sync completes without crashing when the canonical repository is absent",
    "The drift check reports a divergence between copy and canonical",
    "Type checking stays clean"
  ],
  "code_refs": [
    {
      "path": "scripts/sync-methodology.mjs",
      "symbol": null,
      "note": "copies canonical to mirror, no-ops when the methodology checkout is missing, warns on drift; run via npm run sync:methodology"
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": null,
      "note": "committed mirror kept at its original path so template read-through is untouched"
    },
    {
      "path": "src/templates.ts",
      "symbol": "composeInstructions",
      "note": "reads the mirror path; unchanged by the hoist"
    }
  ],
  "related": [
    {
      "id": "FEAT-027",
      "relation": "see_also"
    },
    {
      "id": "FEAT-039",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-092",
      "relation": "see_also"
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
    "archived_path": "docs/bugs/archive/FEAT-041-wa-hoist-methodology-repo.md",
    "sha256": "a7fafb5d15726edcd2dcc0cae1a2f5d33c548f432f66e3518a8c9f968065bc91",
    "bytes": 6797,
    "original_title": "WA hoist: canonical methodology repo + committed mirror (FEAT-039 gap 2)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section; the goal, the canonical-plus-mirror design, the sync and drift behaviour, the deferred multi-consumer policy and the proof bar are all present.",
    "dropped": [
      "the parenthetical noting the v1 and v2 files were the already-appended richer copies, kept in the implementation notes in shortened form",
      "the section-reference shorthand for the design principle cited in the original heading"
    ]
  }
}
```

# FEAT-041 — Working Agreement had no home outside this project

## Diagnosis

### Why the document needed moving

The universal Working Agreement lived only inside this project, so a rename or a change of vendor would have taken it with it, and a second project could only get a copy that drifts.

## Evidence

### What ran

The read-through injection suite `verify:template-readthrough` passed 18/18 after the hoist, showing the composed instructions still emit the full agreement byte-for-byte. Standing `typecheck` was clean. `verify:methodology-sync` is named in the plan; no result for it is recorded here.

## Implementation notes

### Shape of the change

Canonical home: `~/projects/methodology` as a git repository, seeded from the current v1 and v2 agreement files plus a README declaring it the cross-project source of truth.

Mirror: `docs/prompts/WORKING_AGREEMENT*.md` stays at the same path as a committed copy, so a missing methodology checkout never breaks a session launch and the project stays portable across a dual-boot setup.

Sync: `scripts/sync-methodology.mjs`, exposed as `npm run sync:methodology`, copies canonical to mirror and no-ops gracefully when the canonical checkout is absent. A drift check warns when the two differ. Edits land canonically and sync outward.

Deliberately not built: the full multi-consumer drift policy, including pull and push-back for external consumers. It is parked until a second project actually consumes the agreement.

## Verification plan

### The bar set when the work was filed

Prove the live injection is unchanged after the hoist; prove sync copies canonical to mirror; prove sync does not crash when the canonical repository is absent; prove the drift check flags a divergence; keep type checking clean.

## Migration and rollback

### Reverting

The mirror is committed at its original path, so removing the canonical repository and the sync script leaves the project exactly as it was before the hoist.

## Risks

### What could still go wrong

Edits made directly to the mirror instead of the canonical repository would be silently overwritten by the next sync. The drift check is a warning, not a gate, so a divergence can persist unnoticed.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed to execute FEAT-039 gap 2 after the user chose the dedicated-repo option. Scoped off
  `templates.ts`/`app.js`/`index.ts` (FEAT-025 in flight) and off `package.json` (deferred to
  the orchestrator). Dispatched.

### 2026-08-04 — agent (light hoist implemented + verified)
**Understood:** `templates.ts` read-through (FEAT-027) resolves the WA body LIVE from
`docs/prompts/WORKING_AGREEMENT.md` + `.v2.md` at compose time (via `source:` +
`DEFAULT_SEED_SOURCES`). The whole raw file is the injected body (`.trim()`ed), so anything
prepended to those files becomes part of the injected prompt. To keep injection valid I must
never break those two paths' content — must NOT edit `templates.ts` (FEAT-025 holds it).

**Key design call — header must be byte-identical in mirror AND canonical.** Verification (b)
requires `mirror == canonical` byte-for-byte and the `--check` drift mode compares them
directly. A header only in the mirror would make sync (canonical→mirror) wipe it and make the
drift check always fire. So: added the banner to the mirror FIRST, then seeded canonical
VERBATIM from the (now-headered) mirror → the two are byte-identical, sync is a pure copy,
drift is a pure byte comparison, and the pointer note still ships. Simpler = more robust.

**Changed** (scope-clean — only the allowed paths):
- NEW local git repo `~/projects/methodology` (git init; commit `495fc75`): verbatim
  `WORKING_AGREEMENT.md` (v1) + `WORKING_AGREEMENT.v2.md` (v2) + a `README.md` declaring it the
  product-agnostic cross-project source of truth. This is a new, reversible local repo; no
  remote, no push.
- `docs/prompts/WORKING_AGREEMENT.md` + `.v2.md`: prepended a 4-line HTML-comment banner
  ("canonical source: ~/projects/methodology; edit there then `npm run sync:methodology`;
  everything below is byte-identical to canonical so FEAT-027 read-through is unaffected").
  Everything below the banner is byte-identical to the pre-change file.
- NEW `scripts/sync-methodology.mjs`: copies canonical (`$METHODOLOGY_DIR` default
  `~/projects/methodology/WORKING_AGREEMENT*.md`) → the two mirror paths. No-ops gracefully
  (clear message, exit 0) when the methodology dir is absent — the committed mirror is
  authoritative on its own (portability/dual-boot). `--check` mode reports drift with a
  first-differing-line diff and exits 1 (0 when in sync; 0 when repo absent). `--check` never
  writes.
- Did NOT touch `templates.ts` / `app.js` / `index.ts` / `package.json` (per scope). npm-script
  entries to add are reported to the orchestrator.

**Verified (observed values):**
- (a) `git -C ~/projects/methodology log --oneline` → `495fc75 Initial commit…`; `ls-files`
  = README.md, WORKING_AGREEMENT.md, WORKING_AGREEMENT.v2.md.
- (b) `node scripts/sync-methodology.mjs` with repo PRESENT → both files "unchanged";
  `cmp` mirror vs canonical → v1 EQUAL, v2 EQUAL; counts identical (v1 116L/6126B,
  v2 230L/13943B on both sides). Non-vacuous: appended a DIRTY line to the mirror → `--check`
  reported DRIFT (mirror 6143B vs canonical 6126B, first diff line 118) exit 1; `sync` then
  copied 1 and restored byte-equality.
- (c) repo ABSENT (temp `mv` of the dir): both `sync` and `--check` printed the "not found …
  nothing to sync" message and exited 0 (no crash). Restored; post-restore `--check` OK.
- (d) `--check` when identical → "OK — mirror == canonical (2 file(s) in sync)" exit 0; the
  1-line divergence in (b) proved it flags drift with exit 1.
- (e) MOST IMPORTANT: `npm run verify:template-readthrough` → 18/18 PASS (exit 0). Plus a
  direct `seedTemplates()`+`composeInstructions([working-agreement, working-agreement-v2])`
  probe: injected 20119 bytes; asserts TRUE for the banner AND the WA v1 short-form line, the
  WA v1 tail line ("round trips on *execution*, not on *intent*"), and the WA v2 heading →
  "FULL WA STILL INJECTS (with header) — PASS". Injection is unchanged (header is purely
  additive above the byte-identical body).
- `npm run typecheck` → exit 0, clean.

**package.json entries for the orchestrator to add** (scoped off package.json intentionally):
- `"sync:methodology": "node scripts/sync-methodology.mjs"`
- `"verify:methodology-sync": "node scripts/sync-methodology.mjs --check"`

**Status → VERIFIED.** No commit inside claude-station (working-tree changes left for the
orchestrator: the two banner-edited WA files, `scripts/sync-methodology.mjs`, this ticket).
The methodology repo's own initial commit is expected/fine. No remote touched.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
