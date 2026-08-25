# BUG-040 — booting a server (even a scratch one) mutates THIS repo's real arch-findings

- **Status:** VERIFIED (2026-08-11) — boot pass targets the server's OWN registered world (explicit args, never the module-relative default); env opt-out now suppresses the arch ride-along and the post-capture mini-pass too; 11/11 (pre-fix 6/11, 5 FAILs incl. the real findings.json being created by a scratch boot).
- **Area:** server boot side effects vs test isolation (verification integrity family)
- **Reported:** 2026-08-09 (found by BUG-039's fix agent while auditing sibling suites)

## Finding
Server boot unconditionally runs `wa-consolidate.mjs --apply`, whose arch-watch pass targets its
own on-disk `REPO_ROOT` — NOT cwd, NOT `METHODOLOGY_DIR`. So booting ANY server, including a
scratch one on a scratch dataDir during a verify run, writes this repo's real
`docs/bugs/.arch/findings.json`. That is why BUG-039's suite was order-dependent: an unrelated
test run could change the state a later assertion counted.

## Why it matters
Test isolation is a property of the SYSTEM, not of each suite: every harness that boots a real
server inherits this side effect, so any suite can be perturbed by any other. BUG-039 was patched
at the suite level (snapshot/restore + id-scoped assertions); this ticket is the systemic half.
`verify-arch-watch.mjs` has the same side effect (its own assertions are scratch-scoped so it
doesn't fail, but it still perturbs repo state).

## Fix direction
Boot-time maintenance passes must respect the server's own configuration: pass `--no-arch` (or a
`--board-dir`/root pointing at the server's configured project root) when the server is not
running against its own repo — i.e. the pass should act on the SERVER'S world, never on a
hardcoded module-relative path. Also consider an explicit opt-out env for harnesses
(`CLAUDE_STATION_NO_WA_CONSOLIDATE=1` exists — verify it actually suppresses the arch half too).

## Verification
Boot a scratch server with a scratch dataDir/project root and assert this repo's
`docs/bugs/.arch/findings.json` md5 is UNCHANGED afterwards (must FAIL pre-fix). Boot the real
server and assert the pass still runs for the real repo. verify:wa-selfmaintain + verify:arch-watch
stay green.

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
