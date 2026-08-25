```orchard-ticket
{
  "id": "BUG-040",
  "type": "bug",
  "title": "Scratch server boots changed the project’s architecture findings",
  "summary": "Server maintenance now targets the project registered to that server, and the opt-out suppresses both architecture passes. Before the fix, booting a scratch server changed this project’s findings. The pre-fix case failed, the corrected behavior passed, and standing checks remained clean.",
  "impact_if_we_wait": "Scratch servers could corrupt test isolation by changing architecture findings used by later checks. Bounded: this affected repository verification state, not application data or production server behavior.",
  "current_need": "Treat the ticket as closed: the pre-fix scratch boot changed repository findings, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Server boot isolation",
  "reported": "2026-08-09",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A scratch server boot leaves this project’s architecture findings unchanged",
    "Boot maintenance targets the server’s registered project",
    "The environment opt-out suppresses both architecture passes",
    "Real server boot maintenance still runs against the real project"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/.arch/findings.json",
      "symbol": null,
      "note": "BUG-040 tracked unintended changes to this repository file during scratch server boots"
    },
    {
      "path": "wa-consolidate.mjs",
      "symbol": null,
      "note": "Boot-time maintenance previously used its module-relative repository root"
    }
  ],
  "related": [
    {
      "id": "BUG-039",
      "relation": "see_also"
    },
    {
      "id": "FEAT-068",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-040-server-boot-mutates-real-repo-state.md",
    "sha256": "fb02a5c3d05787decf969f3dc815a1a6d0cc0272a3429eae3671f506e93bd8d3",
    "bytes": 6961,
    "original_title": "booting a server (even a scratch one) mutates THIS repo's real arch-findings",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the cross-repository mutation, systemic isolation impact, chosen fix, opt-out behavior, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-040 — Scratch server boots changed the project’s architecture findings

## Diagnosis

Server boot unconditionally ran `wa-consolidate.mjs --apply`. Its architecture pass used the tool’s on-disk `REPO_ROOT` instead of the server’s configured project root. Consequently, even a scratch server with a scratch data directory could write this repository’s `docs/bugs/.arch/findings.json`.

## Evidence

Before the fix, the isolation cases recorded 6/11, with five failures including creation of the real findings file by a scratch boot. Afterward they recorded 11/11. `verify:arch-watch` passed 37/37, `verify:wa-selfmaintain` passed 43/43, and `verify:boot-aware` passed 12/12. Typecheck and leak-gate were clean.

## Implementation notes

Boot-time maintenance receives explicit project arguments so every pass targets the server’s registered world instead of a module-relative default. `CLAUDE_STATION_NO_WA_CONSOLIDATE=1` now suppresses the architecture ride-along and the post-capture mini-pass.

## Verification plan

Boot a scratch server with scratch storage and project roots, then compare the real findings file before and after. Boot the real server and confirm maintenance still runs against the real project. Exercise the opt-out across both architecture passes.

## Risks

Incorrect project arguments could redirect maintenance to the wrong board. Overbroad opt-out handling could also suppress maintenance during legitimate real-project boots.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from BUG-039's sibling audit. Systemic half of the same problem; the suite-level fix is
  already committed.

### 2026-08-11 — SEVERITY EVIDENCE (from BUG-042's fix): the boot/capture passes ran a HALF-BUILT script against the REAL repo
While BUG-042's agent was mid-edit on wa-consolidate.mjs, the running station's post-capture passes
executed the half-built version against the real methodology repo and relocated the real §K THREE
times in a loop (the stub re-classified itself; twin stubs auto-merged). All three methodology
commits had to be reverted. Two lessons for this ticket: (1) the boot/capture pass must act on the
SERVER'S configured world, never a hardcoded repo path; (2) it executes whatever code is currently
on disk — including a mid-edit working tree — so it should either pin to committed state or be
suppressible while the repo is being modified. Raises this ticket's priority: it is not just test
pollution, it can corrupt the shared methodology through a window of broken code.

### 2026-08-11 — fix agent (CLASS: fix)
Hypothesis CONFIRMED: `src/server/index.ts` spawned `wa-consolidate.mjs --apply` BARE, and the
script's project-side defaults (`conventionsDir`, and through it the arch board dir) resolve
module-relative (`REPO_ROOT = script's own repo`) — so every boot, scratch or not, wrote this
repo's `docs/bugs/.arch/findings.json` and would have appended relocations to this repo's
`docs/CONVENTIONS.md`.

**Fix — the boot pass acts on the SERVER'S configured world (src/server/index.ts):** at spawn
time the server checks ITS OWN registry (same `hostPath === projectRoot()` methodology-home rule
the board route uses). Home registered ⇒ `--conventions-dir <home>` (real-station behavior
unchanged, now explicit). Home NOT registered (every scratch/foreign-world server) ⇒
`--no-arch --conventions-dir <dataDir>/consolidation` — the pass cannot touch a repo the server
was never configured with; any relocation append lands inside the server's own dataDir. The WA
half was already env-scoped (METHODOLOGY_DIR) and is unchanged.

**Env opt-out actually covers the arch half now.** Pre-fix, `CLAUDE_STATION_NO_WA_CONSOLIDATE=1`
only gated the server's spawn: a direct/capture-triggered `wa-consolidate --apply` still ran the
arch ride-along, and `wa-capture.mjs`'s post-capture mini-pass ignored the env entirely. Now
`wa-consolidate.mjs` suppresses the implicit arch ride-along under the env (logged honestly;
explicit `--check-arch` stays explicit) and `wa-capture.mjs` suppresses the whole mini-pass under
it — one switch, every automatic pass. This also narrows the severity-evidence window: a harness
or a human mid-edit can flip one env and no automatic pass executes the working tree.

**Verification** (`scripts/verify-bug-040-boot-isolation.mjs`, npm `verify:bug-040-boot-isolation`;
all servers scratch on free ports, scratch dataDirs/stores/methodology, stopped by PID):
- PRE-FIX (committed code restored via stash): **6/11 — 5 FAILs**: a scratch-world boot CREATED
  this repo's `docs/bugs/.arch/findings.json` (sha e9432ae6…, previously absent); the copied-root
  section's "read-only here" check failed for the same reason; env-suppression checks failed
  (arch findings persisted despite the env, no suppression log).
- POST-FIX: **11/11 PASS**: scratch-world boot completes its consolidation pass (non-vacuous — the
  "WA consolidation pass ok" line is asserted) with this repo's findings.json unchanged in
  existence+bytes+mtime and no mention of this repo's board in the pass output; a server whose
  registry contains its own root (seeded registry.json, booted from a COPY of the repo so the
  assertion is read-only for this checkout) runs the arch pass against exactly that root; the env
  suppresses the ride-along with an honest log line, and the identical invocation without the env
  persists findings (non-vacuity).
- Suites: verify:wa-selfmaintain **43/43**, verify:arch-watch **37/37** (its scratch server boots
  no longer perturb this repo — the systemic half of BUG-039's order-dependence), verify:boot-aware
  **12/12**, `npm run typecheck` clean, leak-gate PASS.

**Residual (documented, out of boot scope):** a DIRECT CLI run of `wa-consolidate` with no
`--conventions-dir`/`--board-dir` still defaults to the script's own repo — that is the documented
hand-run contract ("Default: this repo") and is how `verify:wa-selfmaintain`'s bare propose-mode
invocation regenerates this repo's findings.json (idempotent, gitignored derived state). If that
suite-side perturbation ever bites, the env switch above now covers it in one line.
