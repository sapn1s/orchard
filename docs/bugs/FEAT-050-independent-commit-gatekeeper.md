```orchard-ticket
{
  "id": "FEAT-050",
  "type": "feature",
  "title": "Automated pushes could ship changes nobody independently reviewed",
  "summary": "An automated push can now be gated by a standalone commit reviewer that starts with no memory of the session that wrote the code. It reads only the diff, the commit messages and a per-project description of what the real deployment looks like, then returns a pass or block with named findings. An opt-in pre-push hook enforces the block.",
  "impact_if_we_wait": "Without the gate, a change that works on a developer machine can reach a public server that lacks the assumed setup. Bounded: the gate only judges, it never pushes or deploys, and its review is probabilistic rather than a guarantee.",
  "current_need": "Nothing is outstanding. Planted bug, leak and deployment-mismatch commits were blocked with named findings, a clean commit passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Release gatekeeping",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A planted regression commit is blocked with a named finding, not a bare failure",
    "A planted secret leak is blocked by the mechanical pre-step before any reviewer runs",
    "A commit hardcoding a local path or port absent from the deployment description is blocked",
    "A clean commit passes and exits zero so any pipeline can consume the result",
    "Reviewers run as real one-shot dispatches at least once, with a deterministic fake-reviewer seam for repeatable tests",
    "Installing and uninstalling the pre-push hook is idempotent, and a block actually stops a push in a scratch repository"
  ],
  "code_refs": [
    {
      "path": "scripts/gatekeeper.mjs",
      "symbol": null,
      "note": "the gate itself; takes a commit range, defaults to what is about to be pushed, and exits 0 or 1"
    },
    {
      "path": "scripts/leak-gate.mjs",
      "symbol": null,
      "note": "deterministic secret scan run as a pre-step before any reviewer dispatch"
    },
    {
      "path": "docs/DEPLOY-CONTEXT.md",
      "symbol": null,
      "note": "per-project description of the real deployment, injected into every reviewer; the onboarding scaffolder from FEAT-038 gains an optional stub"
    }
  ],
  "related": [
    {
      "id": "FEAT-038",
      "relation": "see_also"
    },
    {
      "id": "FEAT-043",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-061",
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
    "Verification plan": false,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-050-independent-commit-gatekeeper.md",
    "sha256": "c2d7cc87de90f87884d26cfb69c31a0ee7a1a1d7693ecee6f7dd6554d0e7d33a",
    "bytes": 7570,
    "original_title": "independent commit gatekeeper: fresh-context LLM verifier gating auto-push/deploy",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the fresh-context design, the four review classes, the deployment-context convention, the three wiring paths, both stated bounds and the full fixture bar are all present.",
    "dropped": [
      "the verbatim quotation of the original request, whose substance is carried by the summary and the deployment-mismatch review class"
    ]
  }
}
```

# FEAT-050 — Automated pushes could ship changes nobody independently reviewed

## Diagnosis

### Why an independent reviewer

A session that writes a change is the worst judge of it: it carries every assumption it made while writing. The gate therefore takes fresh context on every invocation and never inherits conversation state. Its inputs are the commit range, the diff, the commit messages, and the target project's deployment description.

The primary reviewer defaults to a different provider than the author, so two reviews are less likely to fail the same way. A provider override is available.

## Evidence

### What the reviewers look for

Each review class is its own explicit prompt: correctness and regressions, security, deployment mismatch, and breaking changes for consumers. The deployment-mismatch class is the one the original request named — code written locally that assumes a setup the public server does not have.

A verdict is structured pass or block with the reviewers' findings quoted verbatim, never a bare "failed". Exit status is 0 or 1.

### What ran

A fixture repository with planted commits: an obvious regression, a leaked private token, and a change hardcoding a local path and port that the deployment description says production lacks. Each was blocked with a named finding. A clean commit passed. Reviewers ran as real dispatches at least once rather than only through the deterministic seam. Hook install and uninstall were idempotent, and a block stopped a real push in a scratch repository against a scratch remote. Typecheck and the leak gate stayed clean. A dedicated gatekeeper suite is named in the ticket without a recorded run.

## Implementation notes

### Wiring

Three entry points, all opt-in. A pre-push hook installer, per repository and easily removed. A plain command line for manual runs. And a written rule that an automated push or deploy must not proceed without a pass — recorded in the working agreement and routing docs. Performing the push or the deploy stays out of scope; the gate only judges.

A fake-reviewer seam makes the whole path testable without spending provider tokens.

## Migration and rollback

The hook is installed per repository and removed the same way, so a project can opt out without touching the gate itself.

## Risks

### Stated bounds

Model review is probabilistic. The gate reduces risk and cannot prove the absence of problems, and its own output says so. The deterministic checks — the leak scan and typecheck where available — run first precisely because they are the part that can be relied on.

Every run spends provider tokens across several dispatches. The diff is size-capped per reviewer, and the output says when it was truncated.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed from user request; builds on dispatch (FEAT-043), leak-gate (FEAT-049), cross-provider
  review rule. Dispatched.

### 2026-08-06 — builder subagent (build + verification)
- **Understood:** standalone fresh-context gate over a commit range; reviewers are one-shot
  `scripts/dispatch.mjs` runs (read-only sandbox, BUG-031 taxonomy surfaced verbatim); mechanical
  leak-gate + typecheck-if-present run FIRST and short-circuit the LLM spend on failure;
  cross-provider default (reviewer = the OTHER provider than `--author-provider`, default
  anthropic→openai, both overridable); fail-closed (reviewer dispatch error or missing VERDICT
  line = BLOCK with the failure named — an unreviewable commit is not a passed commit).
- **Changed:**
  - `scripts/gatekeeper.mjs` (new): range resolution (`A..B`, single-rev = `--not --remotes`
    with empty-tree base for root commits, empty range = trivial PASS); mechanical pre-steps;
    4 review classes (correctness, security, deploy vs `docs/DEPLOY-CONTEXT.md`, consumer) with
    class-specific prompts + a strict `VERDICT:/FINDING:` response contract; diff size-cap
    (`--max-diff-bytes`, default 60000) with an honest truncation note in the verdict;
    probabilistic-bounds disclaimer printed in EVERY verdict; exit 0 PASS / 1 BLOCK / 2 usage;
    `--install-hook`/`--uninstall-hook` per-repo pre-push hook (marker-guarded: idempotent
    re-install, refuses to clobber or remove a foreign hook; honors `$GATEKEEPER_ARGS`;
    new-branch pushes reviewed as the single-rev range); `--fake-reviewer <script>` seam
    (class as argv, prompt on stdin, stdout parsed like a real reviewer).
  - `scripts/verify-gatekeeper.mjs` (new): the §C suite below.
  - `scripts/onboard.mjs` + `scripts/onboard.d.mts`: opt-in `--deploy-context` →
    `docs/DEPLOY-CONTEXT.md` stub (same never-clobber idempotency contract).
  - Canonical `~/projects/methodology/ROUTING.md`: new "Auto-push / auto-deploy rule" section
    (LLM must not auto-push/deploy without a gatekeeper PASS) — committed there (8e46246) and
    mirrored via `npm run sync:methodology` (`docs/prompts/ROUTING.md`).
  - package.json NOT edited per dispatch constraint — orchestrator should add:
    `"gatekeeper": "node scripts/gatekeeper.mjs"`,
    `"verify:gatekeeper": "node scripts/verify-gatekeeper.mjs"`.
- **Verified:** `node scripts/verify-gatekeeper.mjs` → **31 PASS, 0 FAIL** (scratch mkdtemp
  repos + scratch bare remote only): planted regression / planted split-token leak (mechanical
  leak-gate hit `notes.md:1: [home path]`, reviewers skipped) / deploy-mismatch against a seeded
  DEPLOY-CONTEXT.md (fake fires only if the context text was truly injected into the prompt) →
  each BLOCKED with named findings; clean commit → PASS + disclaimer; truncation note
  (`TRUNCATED to 500 of 66122 bytes`); failing `npm run typecheck` BLOCKs, absent one is
  honestly SKIPPED; reviewer crash + no-VERDICT output → fail-closed BLOCK; hook: install
  idempotent, BLOCK genuinely refused `git push` (exit 1, remote ref unchanged), PASS pushed
  through (remote advanced), uninstall idempotent, foreign hook refused both ways; onboard
  `--deploy-context` created/idempotent/opt-in. MUST-FAIL proven: an always-exit-0 stub gate
  let the planted-leak commit through → the leak check fails against the stub.
  LIVE (real, modest — 3 haiku dispatches total): `GATEKEEPER_LIVE=1` run → **33 PASS, 0 FAIL**
  (real anthropic/haiku reviewer PASSed the clean commit); separate live run on a planted
  auth-bypass (`checkPassword` → `return true`) with correctness+security haiku reviewers →
  `GATEKEEPER: BLOCK`, both findings named the full authentication bypass verbatim, exit 1.
  `npm run typecheck` clean; `node scripts/leak-gate.mjs` PASS (0 hits / 231 files);
  `sync-methodology --check` in sync.
- **Still open / handoff:** package.json entries above need the orchestrator's one-line add;
  hook is per-repo opt-in by design; push/deploy execution itself stays out of scope.
