# BUG-090 — resuming a pre-container session throws a raw "fork:true / resumeEncodedDir" error instead of offering a one-click fork

- **Status:** FIXED
- **Area:** src/server/fork.ts (`preflightResume`) + src/server/index.ts (start error path) + the fork UI (public/index.html `#forkBtn`, public/lib/drawer.js rowmenu fork sub-view)
- **Reported:** 2026-08-13 by user

## Symptom (user report)
Enabling the container on an existing project, then trying to resume a session recorded BEFORE the
container was on, fails with (paths/names generalized):
> "cannot resume <session-id> in project "<proj>": the CLI only looks in -workspace-<proj>, but that
> session was recorded under <host-path-encoding>. Fork it instead (start with fork:true and
> resumeEncodedDir), which branches it into this project without touching the original."

## Root cause (traced)
Claude Code files each transcript under an encoded-cwd dir. Pre-container the project ran at its host
path → transcripts under the host-path encoding (`-<host-path>-<proj>`). Enabling the container
changed the working dir to `/workspace/<proj>` → the CLI now looks under `-workspace-<proj>`, where
the old session was never recorded. `preflightResume` (fork.ts:200-233) detects the session lives
under a DIFFERENT encoded dir and throws the message above.

Fork IS the correct primitive (NOT a raw copy): it stages a self-contained branch under the new
encoded dir and leaves the host original intact — so disabling the container later still resumes the
original, and there's no double-detection / stale-cwd hazard a blind copy would create. The mechanism
is already built and works.

**The bug is purely UX:** the failure leaks internal API params (`fork:true`, `resumeEncodedDir`) into
a user-facing string instead of offering the action. And a fork affordance ALREADY EXISTS
(`public/index.html:313` `#forkBtn` "Fork to a Linux session" + a rowmenu fork sub-view) — but it was
scoped to the cross-OS (Windows→Linux) case from fork.ts's original purpose; the container
encoded-dir mismatch never routes into it, and the "Linux session" label is wrong for the container
case anyway.

## Wanted
When a plain resume fails ONLY because the session lives under a different (pre-isolation) encoded
dir:
1. **Server:** turn `preflightResume`'s throw into a STRUCTURED signal the client can act on — e.g. a
   typed error / start-event payload carrying `{ reason: 'needs-fork', resumeEncodedDir: <source dir>,
   cause: 'isolation-changed' | 'cross-os' }` — instead of only a prose string. (Keep a readable
   message as fallback.) The client already sends `fork:true` + `resumeEncodedDir` on start
   (index.ts:3092), so no new fork plumbing is needed.
2. **UI:** on that signal, surface a **one-click context-aware Fork** with plain language — for the
   container case: *"This session was recorded before you enabled the container. Fork it into the
   container? (the original stays on the host.)"* Wire it to the existing fork start path with the
   `resumeEncodedDir` the server handed back. Make the existing `#forkBtn` label context-aware
   (container vs cross-OS) rather than hard-coded "Fork to a Linux session".
3. Prefer **one-click confirm, not silent auto-fork** — forking mints a new session id; branching
   without telling the user would surprise them.

## Verification (§C)
- Reproduce the mismatch against a REAL scratch server (free port, scratch dataDir; never :4317): a
  session recorded under one encoded dir, project now resolving to a different encoded dir (simulate
  the container workdir change) → a plain resume yields the STRUCTURED needs-fork signal (must FAIL
  pre-fix: today it's an unstructured throw with no machine-readable resumeEncodedDir). Then a start
  with `fork:true` + the signalled `resumeEncodedDir` succeeds and the forked file is self-contained
  with the original untouched (assert both files exist, original bytes unchanged).
- UI: drive the real render (happy-dom / headless) — on the needs-fork signal the one-click Fork
  control appears with the container-appropriate copy; clicking sends `fork:true` + `resumeEncodedDir`.
- Anti-regressions: the existing cross-OS fork path still works (its verify, if any); verify:sessions,
  verify:ui, typecheck, leak-gate.
- **Risk bucket:** session-lifecycle (resume/fork) — HIGH-STAKES per §N. Flag an independent
  clean-room verify pass for the fork/resume path (generation must not be its own only verifier).

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Root cause traced: container workdir change → different encoded-cwd
  transcript dir → `preflightResume` (fork.ts) rejects the plain resume. Fork is the right primitive
  and already implemented; a fork UI (`#forkBtn`) exists but is scoped to cross-OS and the container
  mismatch doesn't route into it. Single lane (fork.ts + index.ts + fork UI), serialize.

### 2026-08-14 — worker (BUG-090 fix)
Hypothesis CONFIRMED before building. The prose-throw is `explainUnresumable` in `src/server/fork.ts`
(the ticket's `preflightResume`), called from the plain-resume preflight in `startSession`
(`src/server/agent-bridge.ts` ~line 2744) — NOT index.ts's start path directly; index.ts:3092 only
forwards `fork`/`resumeEncodedDir` on start. It emitted `{t:'error', message:<leaky prose>, fatal:true}`
and the client dead-ended on it. The client fork machinery lives in `public/app.js` (not drawer.js);
`#forkBtn` label was hard-coded in `public/index.html`.

Fix map (UX/wiring only — fork STAGING logic untouched, confirmed self-contained + original-preserving):
- `src/server/fork.ts` — `explainUnresumable` now returns a structured `UnresumableReason`
  (`{ message, fork?: { resumeEncodedDir, cause: 'isolation-changed'|'cross-os' } }`). `fork` is present
  only when the id exists under another store dir; `resumeEncodedDir` is picked with the SAME
  deterministic tie-break planFork's scan uses, so a follow-up fork stages from exactly that dir. `cause`
  is `isolation-changed` when the container encoding is on either side, else `cross-os`. Prose message
  kept as the readable fallback.
- `src/server/events.ts` — `error` event gained optional
  `needsFork: { resumeSessionId, resumeEncodedDir, cause }`.
- `src/server/agent-bridge.ts` — the preflight emits `needsFork` alongside the fallback message.
- `public/app.js` — new `armNeedsFork` (rolls back the optimistic start, arms `state.pendingFork`,
  does NOT auto-fork) + `paintFrozenBar` (context-aware copy) + `paintComposerFor` shows the fork bar on
  `pendingFork`; `#forkBtn` handler + `submit`/`startTurn` thread the server-supplied `resumeEncodedDir`.
  One-click confirm, never silent.
- `public/index.html` — UNCHANGED. `#forkBtn`'s hard-coded "Fork to a Linux session" stays only as the
  initial value; `paintFrozenBar` (app.js) now overwrites the label at render time (container vs cross-OS
  vs the Windows default), so the hard-coded text is no longer what the user sees in the isolation case.

Verification (`node scripts/verify-bug-090-needs-fork.mjs`): POST-fix 17/17. MUST-FAIL pre-fix (source
stash, test kept): 3/17 — only the untouched-original assertion + two listing/anti-regression checks
passed; every structured-signal and fork-UI check FAILED (pre-fix `explainUnresumable` returned a bare
string with no machine-readable `resumeEncodedDir`, and the client dead-ended with no fork bar).
Realistic-state coverage: Part B drives the REAL app.js in happy-dom against a REAL scratch server (free
ephemeral port, scratch dataDir + scratch CLAUDE_PROJECTS_DIR) with a session listed under the container
store dir — clicking the row, plain-resuming, getting the real needs-fork event, rendering the fork bar,
clicking Fork, and asserting the outgoing `start` frame carries `fork:true` + the signalled
`resumeEncodedDir`. Part A unit-drives fork.ts over a scratch store for both container-enable and cross-OS
directions and proves the staged copy is byte-identical while the ORIGINAL is untouched.
Anti-regressions: verify:sessions 52/52 (real store byte-identical, untouched), verify:ui 7/7 (real turn),
typecheck clean, leak-gate PASS. Cross-OS fork path still produces its structured signal (Part A A2) and
the Windows-origin `#forkBtn` default copy is preserved (paintFrozenBar `ctx=null` branch).

HIGH-STAKES (§N): session-lifecycle / fork-resume. My suite is NOT the last word — an independent
clean-room verify pass on the fork/resume path is warranted (`scripts/independent-verify.mjs` or a
fresh-context agent), especially to exercise the ACTUAL container-enable direction end-to-end (my UI test
uses the container→direct direction to stay docker-free; both hit the same structured signal + cause +
copy, but a real container run would close the loop).

Deploy note: server + client both changed. A client reload alone is NOT enough — the server bundle
(fork.ts/agent-bridge.ts/events.ts) must be restarted for the `needsFork` signal to be emitted. NOT
restarting :4317 or the service here per charter; orchestrator to schedule the restart.
regressed-from: none (original fork.ts UX gap, present since the cross-OS fork feature; not a prior-fix
regression).
