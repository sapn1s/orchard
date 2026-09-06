# FEAT-129 — Parallel sessions on one project can silently overwrite each other's unsaved edits

- **Status:** OPEN — NEEDS A HUMAN DECISION (3 options). Recommended: A
- **Severity:** medium
- **Area:** server (agent-bridge cwd) / runtime / orchestration discipline
- **Reported:** 2026-09-06 by finding lane (dispatched, read-only investigation)
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The user wants to run several sessions on ONE project at the same time, each on a
different feature, sometimes editing the SAME files. They ask whether Orchard does
this safely, cite that the Claude Code CLI "was just saying file is locked while one
agent tries to edit," and ask whether parallel orchestrators are "out of sync of what
else I have developed."

There is no structural protection. Every session and every lane for a project runs in
the SAME working tree (`agent-bridge.ts` line 949: `this.cwd = opts.project.hostPath`;
container isolation bind-mounts the one repo). No file lock, no atomic-write layer, no
"file busy" signal exists anywhere in the tree (`grep -rniE 'flock|lockfile|O_EXCL'`
over `src/` finds nothing; every "advisory" hit is a stall/provenance notice, not a
write lock). The only defenses are (1) the harness Edit tool's staleness guard, (2)
opt-in `isolation: worktree` per dispatched lane, and (3) orchestrator discipline
(serialize same-file lanes) codified in WA §I/§J and `docs/bugs/README.md`.

## Repro (measured, from this project's own transcripts — same-tree lanes)
Two concurrent-lane clobbers actually occurred; both were WHOLE-FILE / git operations,
not Edit-vs-Edit races:

- **agent-ad026a349210180ac (2026-08-26):** "My package.json edit survived, but
  claude-runtime.ts now has a *different* lane's change (+17/-5) and my edits are gone
  … Another lane owns FEAT-107 … is actively mutating tracked files — it reverted my
  claude-runtime.ts edit while keeping its own." A concurrent lane's whole-tree git
  revert/checkout wiped this lane's uncommitted hunk. (Same run also shows a ticket-id
  collision: two lanes both grabbed FEAT-107.)
- **agent-af0292b979a87a510 (2026-08-27):** "The orphaned-but-alive verifier agent just
  overwrote my container script on disk with its own real-CLI version." A whole-file
  Write from a still-alive orphan overwrote a live lane's file.

By contrast, the harness Edit tool did NOT silently clobber: the same incident logged
`<tool_use_error> File has been modified` — the read-modify-write staleness guard
failed loud rather than overwriting. And agent-a89cf54509a1d9f95 (2026-09-02) shows the
safe path: "styles.css is being actively edited by another lane … My edit applied to
current disk content so other hunks are intact." So **the Edit tool is safe; the hazard
is whole-file operations** — `Write`, and Bash-driven `git checkout -- file` / `git
reset --hard` / `git stash` / `git show HEAD:file > file` / a verify script that
regenerates a file — none of which carry a staleness check.

## Expected
A parallel same-file workflow should either (a) refuse/serialize a colliding writer with
a visible "file busy" signal (the CLI behaviour the user saw), or (b) give each session
its own tree so writes cannot collide, or (c) at minimum guarantee that whole-file/git
operations cannot silently drop another lane's uncommitted work.

## The two questions, answered
1. **Concurrent editors safe?** No structural safety. WITHIN one orchestrator, discipline
   (serialize same-file lanes) mostly holds but demonstrably failed twice above. ACROSS
   two separate live sessions the risk is worse: each session's orchestrator serializes
   only ITS OWN lanes — neither coordinates the other, and nothing locks the shared tree.
2. **Out of sync?** Partly real, mostly a design characterization (NOT separately measured
   for two top-level sessions). What IS shared: the git working tree (both see each
   other's on-disk committed AND uncommitted changes — there is no private buffer; edits
   write straight to disk) and the board (`docs/bugs/`, injected as a per-turn system-prompt
   snapshot — see BUG-165). What is NOT shared: in-flight intent — neither session knows
   what the other is mid-editing or about to do, because the board snapshot is only
   re-read at each session's own turn boundary. So "out of sync about what the other is
   about to change" is true by construction; "can't see what the other already wrote" is
   false (same tree).

## Decision — how do we make parallel same-file work safe?

- **A — advisory "file busy" lock (matches what the user saw in the CLI).** A lightweight
  per-path advisory lock (lockfile / O_EXCL) a writer takes before Write/Edit and Bash git
  ops, surfacing "file busy, owned by lane X" instead of a silent overwrite. Buys: the
  exact fail-loud behaviour the user expects, works across sessions, small. Costs: only
  covers writers that consult it — a raw Bash `git checkout` still bypasses it unless git
  ops are wrapped; needs a stale-lock reaper (see BUG-033 zombie pattern).
- **B — worktree-per-session by default.** Make each concurrent session (not just opt-in
  per-lane) run in its own `git worktree`, merging back explicitly. Buys: true structural
  isolation, no lock needed, collisions become merges. Costs: larger; the merge/PR step is
  new UX; `isolation: worktree` exists today only per dispatched lane, not per session.
- **C — keep discipline-only, document the limit.** Accept that discipline + opt-in
  worktrees is the model; make the "run same-file lanes serially / give them worktrees"
  rule louder and add nothing structural. Buys: zero build. Costs: the user is about to
  rely on cross-session parallel editing where no single orchestrator serializes, and the
  two measured clobbers show discipline alone already leaks.

## Context pack
- Files/functions in play: `src/server/agent-bridge.ts` (`this.cwd = opts.project.hostPath`,
  ~949; board snapshot inject ~1351); `src/server/tools.ts` (MCP surface — no write lock);
  the Read/Edit/Write tools are the Claude Agent SDK's built-ins forwarded to the CLI, not
  Orchard code, so the staleness guard is the SDK's, not ours.
- Related tickets: ARCH-011 (in-progress — "measured-staleness retry rule: hash a lane's
  touched set at its end, route the retry on whether those bytes still match"; a detection/
  retry mechanism, adjacent but not a lock); FEAT-005 (durable ticket/worktree pattern);
  BUG-033 (zombie-busy no reaper — stale-lock reaper precedent); BUG-165 (live board
  snapshot per turn); WA §I/§J and `docs/bugs/README.md` §"Concurrency rules".
- Evidence: the orchestrator session's transcript store under the Claude projects dir
  (`<claude-home>/projects/<encoded-project-dir>/<session-id>/subagents/`), files
  agent-ad026a349210180ac.jsonl, agent-af0292b979a87a510.jsonl, agent-a89cf54509a1d9f95.jsonl.
- Repro test: none yet — add one that spawns two writers on one path (one Edit, one Bash
  `git checkout`) and asserts the uncommitted hunk survives or a busy signal is raised.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — finding lane (dispatched, read-only)
- **Understood:** All lanes/sessions of a project share one working tree; no lock/atomic/
  busy-signal exists. The harness Edit tool has a fail-loud staleness guard (safe). The real
  hazard is whole-file/Bash-git operations, which have no guard and silently clobber a
  concurrent lane's uncommitted work.
- **Changed:** none (investigation only; filed this ticket).
- **Verified:** grep for lock primitives over `src/` — none. Confirmed `this.cwd =
  hostPath`. Reconstructed two real clobbers (ad026, af0292) from transcripts and confirmed
  both were whole-file/git operations; confirmed the Edit guard fired protectively in the
  same and a later run.
- **Still open / handoff:** needs the human decision above. If A, wrap Bash git-mutation
  commands too, or the lock is bypassable (that bypass is exactly what caused ad026). If B,
  extend the existing per-lane `isolation: worktree` to a per-session default and design the
  merge-back UX. Cross-session desync is characterized, not yet measured — a two-session
  repro would quantify it.
