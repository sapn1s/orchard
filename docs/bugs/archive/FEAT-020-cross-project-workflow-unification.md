# FEAT-020 — Cross-project workflow unification: mine existing project setups into shared rules + station features

- **Status:** SYNTHESIS DONE (WA rules applied+synced; features filed FEAT-021..024; container tier found already-built per §B)
- **Severity:** high (this is claude-station's north star — stop re-building the same orchestration per project)
- **Area:** methodology + claude-station platform
- **Reported:** 2026-08-04 by user
- **Related:** FEAT-017 (durable system), FEAT-019 (living-doc maintenance)

## Goal
The user runs ~3 projects at once and keeps re-creating the same orchestration/
agentic scaffolding. Read the orchestration setups already living in their repos,
extract what GENERALIZES → (a) shared Working Agreement rules, (b) claude-station
features — and leave the rest project-local. Excluded by user: Example-App.
Per §L, WA additions are PROPOSED for approval, not silently added.

## Scout findings (append-only, one block per project)

### external-project-G — container-based multi-agent research (scout returned)
- **Model:** two-layer containers. A GPU/CUDA exec image (ephemeral one-shot jobs
  via `./lab run`), and a PERSISTENT idling `claude-session` container (tini +
  keep-alive) running Claude/Codex CLIs unattended, GPU access, **scoped
  credential mount** (only this project's `~/.claude/projects` + creds — NOT whole
  `~/.claude`, NO docker socket, NO ports). Multiple `docker compose exec` +
  **named tmux sessions** attach the same container (close = detach); an in-
  container reaper kills tmux idle >12h by **CPU-delta, not age**.
- **Why containers:** isolation (full unattended power but can't touch host daemon
  or other projects' state), reproducibility (pinned image), GPU passthrough,
  host-safety (runaway agent bounded to container, can't fork sibling containers).
  Parallelism = single container / many tmux+subprocs, NOT many containers.
- **Dispatch inside:** file-based job queue (pending/running/done JSON) with
  **HW-aware admission control** (re-measures free VRAM/RAM, serializes heavy jobs,
  flat cap), **kill-by-process-group** (start_new_session=True). Multi-agent
  "coevo": 3 roster agents each with a `claude -p` headless "brain" proposing next
  configs from mandate+journal+shared blackboard+ledger; a techlead tick harvests
  results and refills queues; lock file prevents overlapping ticks. Verification =
  an automatic metric (capfit.py), plus append-only `ledger.jsonl` with
  numbered/timestamped backups before risky edits.
- **GENERALIZABLE → station features:** (1) a **"full isolation" dispatch tier** —
  persistent idling container + tmux-multiplexed sessions + scoped-credential mount
  — heavier than worktree; fills the gap in our none→worktree→full ladder. (2)
  file-based queue w/ HW-aware admission control. (3) headless `claude -p` as an
  in-script sub-reasoner.
- **GENERALIZABLE → WA rules (propose):** kill-by-**process-group** (not `kill $!`);
  orphan reaper by **CPU-delta not age**; **snapshot-before-mutate** for any shared
  append-only state (generalizes our "no git add -A mid-flight").
- **TENSION (do NOT port wholesale):** its CLAUDE.md bans strategic questions /
  idling and enforces via a Stop-hook — far more aggressive autonomy than our
  opt-in-pause-friendly NEEDS-YOU contract. Context-specific (single-user, resource-
  bound); keep as a *selectable* mode, not a universal rule.
- **Project-specific:** GPU/VRAM/WSL2 tuning, capfit metric, coevo domain, CUDA pins.

### external-project-A — single-session governance + hardened container infra (scout returned)
- **No dev-workflow orchestrator** (no board, no dispatch/verify loop). Governs ONE
  session + the bot's own product-agent runtime (not a dev workflow).
- **Model-tier rubric (STRONG generalizable):** pick model by COST-OF-MISTAKE, not
  price; **default UP not down**. fable=deep/adversarial/security/architecture;
  opus=orchestration+synthesis+judgment; sonnet=contained well-specified impl;
  haiku=mechanical/bulk/high-fan-out. Sharpens our orchestrator model.
- **Adversarial VERIFY pass (generalizable):** a second agent tries to REFUTE the
  first — named as the biggest quality lever on high-stakes changes. Sharpens our
  verify-subagent rule.
- **Hardened container + named-tmux session infra** (claude-session.sh,
  docker-compose.claude.yml): detach-not-kill, auto-teardown on last exit,
  uid/gid-matched mounts. **CONVERGES with external-project-G's identical pattern.**
- Other candidates: docs-sync table (change-type→doc), ADR discipline,
  ask-before-assuming, broken-windows hygiene, `docs/working-with-llms.md`
  de-convergence methodology (candidate shared skill).
- Project-specific: RouterAgent/PluginAgent runtime, 70 ADRs, Redis/Swarm deploy.

### external-project-B — DEAD END (scout returned)
- Plain single-agent project-context file. NO orchestration/board/verification/
  agents apparatus. Nothing to lift (only a "document project invariants tersely"
  doc habit). User's "maybe only external-project-B" overestimated it — confirmed empirically.

### external-project-F — single-agent infinite research loop (scout returned)
- NOT multi-agent dispatch (CLAUDE.md ~5KB, not 27KB — size was wave-log growth).
  One session looping: process finished research → update predictions → spawn next
  wave of 4-6 generic research agents → repeat forever.
- Generalizable: **raw-vs-curated split** (append-only raw dumps dir + separately
  rolled-up per-domain summary files); **index-table-as-router** (root file keeps a
  table pointing to topic files, stays small as knowledge grows); steel-man rule.
- **CONTRADICTS NEEDS-YOU:** explicitly "never pause, continue indefinitely." Same
  anti-idle stance as external-project-G.

## Convergence so far (the real signal)
1. **Container + named-tmux session tier** — in BOTH external-project-A AND external-project-G,
   near-identical (detach-not-kill, hardened, uid/gid mounts, scoped creds). This is
   THE "keep rebuilding it" pattern → strongest claude-station feature candidate.
2. **Autonomous never-pause loop** — in BOTH external-project-F AND external-project-G →
   claude-station should support a SELECTABLE autonomous mode distinct from the
   interactive NEEDS-YOU mode (don't force one on the other).
3. **Append-only raw + curated rollup** memory (external-project-F data/context, gpu ledger, our
   board) — recurring memory architecture.
4. **Model-tier-by-cost-of-mistake** + **adversarial refute-verify** (external-project-A) —
   sharpen our orchestrator + verification rules.

### breadth-sweep (8 repos) — scout returned
- **external-project-Q = richest exemplar** (read deeper later: `agents/orchestrator.ts`,
  `src/agents/domains/*.md`): hardened multi-container Docker + index-table routing to
  domain playbooks + **recursive manager→sub-agent trees** (8 domain managers each spawn
  their own sub-agents — 2-level fan-out) + an **8-step adversarial verify + runtime-proof**
  pipeline + append-only JSONL findings → dashboard rollup.
- **NEW generalizable ideas:**
  1. **Recursive manager→sub-agent trees** (external-project-Q) — parallelize heterogeneous domains
     as a 2-level tree, not a flat agent pool.
  2. **Strict orchestrator/executor separation** (external-project-C): "the orchestrator does NOT
     implement — even trivial 1-line fixes go to an agent." Independently confirms the exact
     discipline the user has been teaching this session; strong candidate to SHARPEN WA §I.
  3. **Pre-flight go/no-go gate** (external-project-Q): a numbered eligibility checklist that must
     fully pass before any work starts (distinct from the later verify pass).
  4. **Runtime-proof as a submission gate** (external-project-Q): "if you can't trigger it live, it's
     not ready" — empirical repro required, not just a second LLM opinion. Strengthens our
     verification-is-the-deliverable ethos.
  5. **LLM-agnostic manual pipeline** (external-project-N): generate prompts for copy/paste into any
     LLM instead of calling own API — vendor-neutral. (Niche.)
- **Confirms convergence breadth:** autonomous loop (b) also in external-project-M,
  external-project-C, external-project-D, external-project-E (DOMINANT in research projects); append-only
  raw+curated / JSONL→dashboard (c/g) also in external-project-C (runs.jsonl), external-project-D,
  external-project-Q; index-table-router (d) also in external-project-Q, external-project-C, external-project-D.
- Plain context files (no orchestration): external-project-N, external-project-K, external-project-L, external-project-M(loop only).

### external-project-O{,-linux} + external-project-P — the canonical container/remote infra (scout returned)
- **external-project-O-linux** = the canonical reusable form of the container+tmux tier that
  external-project-A/gpu/external-project-Q each rebuilt: Ubuntu+Node20+Claude CLI, non-root `claude` user
  (Claude refuses --dangerously-skip-permissions as root), tini keep-alive + CPU-delta idle
  reaper, `claude-tmux` attach-or-create chooser (detach≠kill), uid/gid build-args,
  CapDrop/no-new-privileges/mem+pids limits, **docker socket OFF by default**, and a NARROW
  cred mount (`.credentials.json` + `.claude.json` + THIS project's memory dir only — never
  whole ~/.claude). Naming must match Claude's own `cwd.replace(/[^a-zA-Z0-9]/g,'-')` or
  memory silently won't persist.
- **external-project-P** = a full control-plane precedent for a REMOTE tier: per-project
  containers via dockerode, an in-container "agent" (Express+ws) exposing /health +
  PTY-over-websocket (/ws/terminal), JWT-cookie auth, GPU opt-in via DeviceRequests, stale-
  container recreation. Web UI bound to 127.0.0.1 (needs TLS+auth before remote exposure).
- **Lift directly** for a station container tier: Dockerfile.claude(linux) + compose almost
  verbatim; for a remote tier: docker-manager's ensureProjectContainer/isStale + the
  container-agent PTY design.
- **SECURITY FLAGS (relayed, not acted on):** (1) external-project-P mounts a SHARED
  `claude-auth-data` volume READ-WRITE into every project container — one compromised
  container can rewrite all projects' creds; prefer the linux template's narrow per-project
  bind. (2) A real `.env` (not just .env.example) exists in `external-project-P/` — the
  read-only scout did NOT open it; **user should confirm it isn't committed/leaked.** (3)
  external-project-O's `ports: 3000:3000` collides across concurrent projects (no auto-alloc).

## SYNTHESIS — proposed actions (awaiting user approval per §L)

**Proposed shared-WA additions (universal rules):**
- **Orchestrator never implements** — even trivial 1-line fixes go to an agent
  (external-project-C; independently validates the discipline the user taught this session).
  Sharpen §I.
- **Model selection by cost-of-mistake** — default UP not down; role tiers
  (deep/adversarial → top; contained impl → mid; mechanical/bulk → cheap) (external-project-A).
- **Adversarial refute-verify + runtime-proof bar** — a second agent tries to REFUTE;
  "if you can't trigger it live, it's not done" (external-project-A, external-project-Q). Sharpen §C.
- **Autonomous vs interactive as selectable modes** — NEEDS-YOU is the interactive default;
  a never-pause autonomous loop is a distinct, explicitly-chosen mode (external-project-F/gpu/most
  research repos). Resolves the anti-idle tension; don't force either on the other.
- (Small safety bullets to fold in: kill by **process-group**; **snapshot-before-mutate**
  for shared append-only state.)

**Proposed claude-station FEATURES (candidates; file/build on greenlight):**
- **Container session tier** — lift external-project-O-linux (the #1 convergent pattern).
- **Autonomous mode** — selectable never-pause loop with an explicit stop condition.
- **Remote tier / control plane** — lift external-project-P (bigger; security-gated).
- **Workflow-patterns templates** — recursive manager→sub-agent trees, index-router,
  raw+curated memory, go/no-go pre-flight gate (reusable dispatch templates).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. external-project-G + external-project-A scouted first; external-project-B, external-project-F,
  docker-template meta-infra, and a breadth-sweep dispatched. Synthesis → a
  proposed WA delta + feature tickets once scouts return.
- 2026-08-04 — appended external-project-A / external-project-B / external-project-F scout results; convergence noted. docker-template meta-infra + breadth-sweep dispatched next.
- 2026-08-04 — appended breadth-sweep (8 repos). external-project-Q is the standout exemplar; external-project-C's orchestrator-never-implements rule validates WA §I. Awaiting docker-meta scout, then synthesis.
- 2026-08-04 — all 6 scouts in; docker-meta gives the concrete container/remote spec + security flags. Synthesis drafted; WA delta + feature set proposed to user for approval.
- 2026-08-04 — §B CHECK: claude-station ALREADY has the container tier
  (`src/server/container-manager.ts`, `src/server/container/`, per-project
  containers, docker-socket opt-in, orphan sweep, `verify:container` 13/… ). The
  proposed 'Container session tier' is therefore NOT rebuilt. Remaining container
  delta = the LIGHT `sandbox` (bwrap) tier still returns 501 (unimplemented) —
  fills none→light→full (§E); optional: audit existing hardening vs the
  external-project-O-linux posture (narrow cred mount / socket-off / CapDrop).
- 2026-08-04 — WA additions applied + synced live (9396 bytes). Features filed:
  FEAT-021 (session boots aware / memory), FEAT-022 (autonomous mode), FEAT-023
  (remote tier), FEAT-024 (workflow-pattern templates).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
