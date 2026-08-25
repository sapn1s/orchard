```orchard-ticket
{
  "id": "BUG-090",
  "type": "bug",
  "title": "Older sessions showed internal errors after enabling containers",
  "summary": "Older sessions can now be resumed through a one-click fork after container isolation changes their storage location. The original session remains untouched, and the prompt explains the branch. The corrected server and interface behavior passed targeted and standing checks.",
  "impact_if_we_wait": "Without the fix, people cannot resume affected sessions without interpreting internal parameters and manually forking. Bounded: this affects session access after isolation changes, not transcript integrity or other sessions; original session files remain intact.",
  "current_need": "Treat the ticket as closed: the failing case and corrected behavior were exercised, all targeted suites passed, and standing checks stayed clean.",
  "severity": "high",
  "area": "Session resume and fork",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-13",
      "question": "Should an encoded-location mismatch prompt for a fork or fork silently?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": null,
      "chosen_by": null,
      "note": "A one-click confirmation was chosen because forking creates a new session identifier and should not surprise the user."
    }
  ],
  "success_criteria": [
    "A location mismatch produces an actionable fork prompt instead of exposing internal parameters.",
    "Confirming the prompt creates a self-contained fork while leaving the original session unchanged.",
    "The fork prompt uses container-specific or cross-platform wording according to its cause.",
    "Existing cross-platform forks and unrelated session starts continue working."
  ],
  "code_refs": [
    {
      "path": "src/server/fork.ts",
      "symbol": "preflightResume",
      "note": "Detects transcripts stored under a different encoded working directory."
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "Carries the structured start failure and accepts the existing fork parameters."
    },
    {
      "path": "public/index.html",
      "symbol": "forkBtn",
      "note": "Existing fork control whose label becomes context-aware."
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "Renders the fork prompt and sends the source encoded directory."
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/BUG-090-resume-after-isolation-change-throws-raw-fork-error.md",
    "sha256": "92319ddc82c7a4545217bb8b77dbc6075305f2efa99250689fc41020156384c2",
    "bytes": 9249,
    "original_title": "resuming a pre-container session throws a raw \"fork:true / resumeEncodedDir\" error instead of offering a one-click fork",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the supplied ticket; the symptom, cause, chosen confirmation flow, preservation guarantee, implementation surfaces, risks, and executed checks remain present.",
    "dropped": []
  }
}
```

# BUG-090 — Older sessions showed internal errors after enabling containers

## Diagnosis

Claude Code stores transcripts beneath an encoded working-directory name. Enabling a container changes the project working directory from its host path to `/workspace/<project>`, so older transcripts remain under the host encoding. `preflightResume` detected that mismatch but returned prose exposing `fork:true` and `resumeEncodedDir`. The existing fork path could safely branch the transcript into the new location, but the interface only exposed it for cross-platform migrations.

## Evidence

The fixer's runs completed `verify:sessions` with 52/52 passing, `verify:ui` with 7/7 passing, and `verify:bug-090-needs-fork` with 17/17 passing. Typecheck and leak-gate were clean. The targeted coverage exercised the mismatch signal, successful fork, preserved original, contextual prompt, and submitted fork parameters.

## Implementation notes

Represent the encoded-directory mismatch as a structured `needs-fork` start failure carrying the source directory and cause, while retaining readable fallback text. Route that signal into the existing fork flow. Ask for confirmation because a fork creates a new session identifier. Adapt the control text for container and cross-platform cases.

## Verification plan

Use a scratch server and data directory on a free port. Record a session under one encoded directory, resolve the project under another, and confirm plain resume returns the structured signal. Start with the returned source directory and confirm both transcript files exist with the original bytes unchanged. Render the real interface, inspect contextual copy, click Fork, and assert the submitted parameters. Run session, interface, targeted regression, type, and leak checks.

## Migration and rollback

No transcript migration or raw copying is required. The fork creates a self-contained branch in the current encoded directory and preserves the original. The structured handling and contextual interface can be reverted without modifying stored transcripts.

## Risks

Resume and fork behavior is session-lifecycle code. An incorrect source directory could branch the wrong transcript, while silent branching could conceal the creation of a new session. Preserving the original and requiring confirmation bound those risks.

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
