# FEAT-050 — independent commit gatekeeper: fresh-context LLM verifier gating auto-push/deploy

- **Status:** VERIFIED
- **Area:** release engineering / methodology tooling (scripts lane)
- **Reported:** 2026-08-06 by user ("if anything needs to be auto deployed by llm, it must go
  through another independent custom made code verifier which gets NEW context for every commit,
  … evaluates using its own subagents whether this does not introduce any problems; optionally
  learn per-project setup … e.g. llm locally made changes not knowing the public server's setup
  fully and pushed — verifier would catch")

## Design
A standalone gate — `scripts/gatekeeper.mjs` — that evaluates a commit/range with FRESH context
per invocation (never the authoring session's context; the whole point is independence):
1. **Input:** a commit range (default: what's about to be pushed / HEAD vs remote), the diff,
   commit messages, and the target project's DEPLOY CONTEXT (below). No conversation state.
2. **Reviewers = its own subagents via the existing `dispatch` runner** (FEAT-043): N fresh
   reviewers, each a one-shot dispatch with only the diff+context; DEFAULT the primary reviewer
   to the OTHER provider than the author (cross-provider decorrelation — routing rule #3;
   `--provider` override). Review classes, each an explicit prompt: correctness/regressions,
   security (incl. secrets/leak re-check via scripts/leak-gate.mjs as a mechanical pre-step),
   deployment-mismatch (does this change assume a local setup that prod/public won't have?),
   breaking-API/consumer impact.
3. **Verdict:** structured PASS/BLOCK with named findings (BUG-031-style honesty: verbatim
   reviewer findings, never a bare "failed"). Exit 0/1 so any pipeline can consume it.
4. **Per-project setup learning (the "easily addable" version):** a `docs/DEPLOY-CONTEXT.md`
   convention per project — what prod/public actually looks like (services, env, ports, what is
   NOT present locally). The gatekeeper injects it into every reviewer so "works locally,
   breaks the real server" mismatches are catchable. Onboard (FEAT-038) gains an optional stub.
5. **Wiring:** (a) opt-in git pre-push hook installer (`gatekeeper.mjs --install-hook`, per
   repo, easily removable); (b) documented as the REQUIRED step for any future auto-deploy flow
   (WA/ROUTING note: an LLM must not auto-push/deploy without a gatekeeper PASS); (c) plain CLI
   for manual runs. Push/deploy itself stays out of scope — the gate only judges.

## Bounds (honest)
- LLM review is probabilistic — the gate REDUCES risk, it cannot guarantee absence of problems;
  say so in its output. Mechanical checks (leak gate, typecheck if available) run first and are
  deterministic.
- Cost: each gate run spends provider tokens (a few dispatches); size-cap the diff per reviewer
  and say when truncated.

## Verification (REQUIRED, §C)
Fixture repo + planted commits: (a) an obvious bug regression, (b) a secret/private-token leak,
(c) a deploy-mismatch (change hardcodes a local path/port that DEPLOY-CONTEXT.md says prod lacks)
→ each BLOCKED with a named finding; (d) a clean commit → PASS. Reviewers must be REAL dispatches
(cheap models ok) at least once live; a `--fake-reviewer` seam for deterministic CI-style tests.
Hook install/uninstall idempotent; a BLOCK actually prevents `git push` through the hook (prove
in a scratch repo with a scratch remote). typecheck; leak-gate integration proven.

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
