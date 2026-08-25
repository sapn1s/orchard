```orchard-ticket
{
  "id": "FEAT-089",
  "type": "feature",
  "title": "Projects added to Orchard started without the working method",
  "summary": "Adding a project used to give the runtime but none of the working method: the ticket board only after a manual command, the working agreement only after a click, and the reply format and readability checks not at all. Adding a project now applies all of it, reports what it created, and can be declined.",
  "impact_if_we_wait": "Each newly added project would keep starting bare, so its sessions run without the board, the agreement or the reply checks. Bounded: existing projects are untouched, files are never overwritten, and the wiring panel still shows and repairs any missing piece.",
  "current_need": "Nothing is outstanding. Adding a fixture project produced the board, the attached agreement, the injected format and the installed hook, with re-adds reporting the pieces already present and typechecks clean.",
  "severity": "medium",
  "area": "Adding a project",
  "reported": "2026-08-15",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-18",
  "decision": null,
  "decision_history": [
    {
      "asked_on": null,
      "question": "Should the working agreement stay opt-in for projects that lack the tools it assumes?",
      "mode": "single",
      "options_keys": null,
      "chosen": "Make it automatic, and install the missing machinery at the same time",
      "chosen_on": null,
      "chosen_by": "user",
      "note": "An earlier analysis argued for opt-in because part of the agreement assumes a ticket board, a dispatch command and a provider fleet. Installing those on add removes the case it was arguing about."
    }
  ],
  "success_criteria": [
    "Adding a fresh project creates the board with no manual step",
    "The working agreement is attached and present in the composed prompt",
    "The reply format is enabled for the project and injected into its sessions",
    "The readability hook and the sanctioned gate wrapper are installed in the project's own settings",
    "Re-adding, or adding a project that already has pieces, changes nothing and reports them as already present",
    "Declining at add time leaves the repository untouched",
    "The wiring panel reports every check satisfied for the newly added project",
    "Projects added before this change are unaffected until explicitly repaired"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "the add-project path this work hangs off"
    },
    {
      "path": "src/server/registry.ts",
      "symbol": null,
      "note": "project registration"
    },
    {
      "path": "scripts/onboard.mjs",
      "symbol": null,
      "note": "already idempotent; scaffolded the board and drift guard but not the agreement, hook or gate wrapper"
    },
    {
      "path": "wiring.ts",
      "symbol": null,
      "note": "per-project state reporting and manual repair, including the existing confirm gate"
    }
  ],
  "related": [
    {
      "id": "BUG-099",
      "relation": "depends_on"
    },
    {
      "id": "BUG-104",
      "relation": "see_also"
    },
    {
      "id": "BUG-118",
      "relation": "blocks"
    },
    {
      "id": "FEAT-084",
      "relation": "depends_on"
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
    "archived_path": "docs/bugs/archive/FEAT-089-every-orchard-project-gets-the-method-automatically.md",
    "sha256": "313a7b2bd718a325cc9fc9dae6639d5a798a2e2df93ad5a759c35bff5aeec315",
    "bytes": 15920,
    "original_title": "every project added to Orchard gets the full method automatically",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the per-piece gap table, the six wanted behaviours, the opt-in objection and its answer, and all four risks are present.",
    "dropped": [
      "the parenthetical restating that onboarding is idempotent, which the risks and criteria already carry"
    ]
  }
}
```

# FEAT-089 — Projects added to Orchard started without the working method

## Diagnosis

`scripts/onboard.mjs` scaffolded `docs/bugs/`, copied the drift guard and wired its npm scripts, and ran only when invoked by hand. It never attached the Working Agreement, installed the stop hook or installed the gate wrapper. Provider routing was the one piece that already travelled, because it is injected universally. Response-format injection did not exist as a mechanism until FEAT-084, and the readability hook config lived only in this repo's git-ignored local settings.

Neither missing piece is Orchard-specific: the stop hook is a standard Claude Code mechanism available to any project, and the format instruction is ordinary injected context. They were simply not installed anywhere else.

## Evidence

Per-piece audit of what travelled to a new project before the change: board and drift guard only via a manual `npm run onboard`; Working Agreement only via a separate click in the wiring panel; provider routing already universal; local conventions stub only via onboard; response format, readability enforcement and the sanctioned gate wrapper not at all.

After the change the fixer ran a clean-room pass over the add-project path and the surrounding suites: `verify:feat-089` 35/35, `verify:bug-099-attach-wa-coherent` 35/35, `verify:onboard` 36/36, `verify:feat076` 36/36, `verify:wa-injected` 15/15, `verify:feat-084` 37/37, `verify:local-conventions` 5/5, `verify:routing-inject` 18/18, `verify:bug-099` 21/21, `verify:conventions-live` 5/5, `verify:new-session-overrides` 5/5, `verify:overrides` 5/5, `verify:feat-083-response-digest` 22/22, `verify:feat-074-add-project-surface` 7/7, `verify:addproject` 7/7, `verify:scratch` 17/17. Typecheck clean.

## Implementation notes

Adding a project runs the existing idempotent onboarding first (board, drift guard, conventions stub), then attaches the Working Agreement as the coherent base-plus-extension pair over the attach path fixed in BUG-099, then enables and injects the response format (FEAT-084 supplies the injection), then installs the readability hook and the sanctioned gate wrapper into the project's own settings.

Two properties are load-bearing rather than incidental: every existing file is left untouched, and the run reports exactly what it created. Opt-out is reachable both at add time and afterwards; the wiring panel remains the place to see and repair the per-project state.

## Verification plan

Add a fresh fixture project with no manual step and assert the board exists, the agreement is attached and present in the composed prompt, the format is enabled and injected, and the hook and gate are installed. The must-FAIL case is the same assertion before the change, where none of it happens. Re-add, and add a project that already carries some pieces, asserting nothing changes and each is reported as already present. Decline at add time and assert the repository is byte-identical. Check the wiring panel reports every check satisfied. Confirm a previously added project is unchanged until explicitly repaired.

## Migration and rollback

Projects added before this change are deliberately left alone; they are brought up to date through the wiring panel's existing repair path rather than by a sweep. Because onboarding never overwrites, an added project can be returned to its prior state by removing only the files the add reported as created.

## Risks

Adding a project writes into a user's own repository — a ticket board, a conventions stub, a hook config. That is a real side effect and must never be silent: never overwrite, always report, always undoable, always declinable.

A project added purely to browse history may want none of it, so the opt-out has to be reachable at the moment of adding rather than only afterwards. The confirm gate the wiring panel already has for its manual apply must not regress.

## Activity log (APPEND-ONLY)
### 2026-08-15 — orchestrator
- Filed on the user's instruction: "any session opened/created in orchard must be" automatic. Confirmed by
  inspection that onboarding installs neither the WA, the hook, nor the gate, and that onboarding is manual.
  Confirmed the hook and format are general Claude Code capabilities, not Orchard-specific — they are simply
  never installed elsewhere. Depends on FEAT-084 (format injection) landing.

### 2026-08-18 — worker (Opus 4.8)
- **Understood:** adding a project gave the runtime but not the method — onboard installed neither the WA,
  the format hook, nor the gate, and onboard was manual-only. FEAT-084 (commit 2533bea) made the format
  injectable per project; the response format is now ON BY DEFAULT for new projects (defaultResponseDigestSettings
  → enabled:true), so step 3 was already satisfied by construction — the gaps were the WA attach + the hook +
  the gate + doing it all automatically on add.

- **What a freshly added project now gets (automatically, no manual step):**
  1. The idempotent file scaffold via `onboard()` — board (docs/bugs/*), drift-guard (scripts/board.mjs +
     board:check/gen + arch:watch), conventions stub (docs/CONVENTIONS.md).
  2. The COHERENT Working Agreement attached — v1 base FIRST, then v2 — through the SAME validated PATCH path
     the wiring panel uses (extracted into `wiring.coherentWaStack()`, now reused by both the wiring "Apply"
     route and the add-project auto-apply; no hand-rolled registry write).
  3. The response format enabled (default) → its `orchard-digest` section injected into the composed launch
     prompt (FEAT-084, gated on the same `responseDigest.enabled` flag).
  4. The readability/format Stop hook installed into the project's OWN `.claude/settings.json`
     (created, or MERGED into an existing settings file — never clobbered), plus the hook's full dependency
     closure copied verbatim (scripts/hooks/response-format-gate.mjs, scripts/lib/readability.mjs +
     structure.mjs, public/lib/digest.js + dom.js + route.js) so it actually runs in the target.
  5. The sanctioned gate wrapper — scripts/gate.mjs + scripts/leak-gate.mjs copied, `gate` npm script wired.

- **What installs WHERE:** files → `onboard()` in scripts/onboard.mjs (new METHOD_FILES copy list +
  installClaudeHook() merger + `gate` added to the wired npm scripts). Registry mutations (WA attach) →
  src/server/index.ts POST /api/projects, after createProject, via reg.updateProject(validateProjectPatch(...)).
  So the file side effect and the registry side effect are cleanly separated: onboard never touches the
  registry, the route never hand-writes files.

- **How to DECLINE (opt-out, reachable AT ADD TIME):** the picker has a checked-by-default checkbox
  "Apply the Orchard method …" (public/index.html + app.js + styles.css). Unchecking sends
  `applyMethod:false`; the server then registers the project and does NOTHING else — verified BYTE-FOR-BYTE
  untouched (same file set + stats before/after) with an empty instruction stack. `applyMethod` is a
  request-level directive stripped in validateCreateProject so it never reaches the settings validator.
  The wiring panel remains the place to see/repair afterwards (unchanged).

- **NEVER-CLOBBER proof:** every file write is existence-gated (`ensureFile` / `copyMethodFile` skip an
  existing file and report `exists`); `.claude/settings.json` is CREATED only when absent, else MERGED
  (our Stop entry appended, all existing keys + the repo's own pre-existing hook preserved) — proven on a
  REALISTIC fixture that ships its own package.json (scripts intact), its own CLAUDE.md (untouched), and
  its own `.claude/settings.json` with an unrelated `echo my-own-hook` Stop hook (preserved alongside ours).
  Idempotence proven not-assumed: re-onboard emits zero CREATED/MERGED lines and leaves every watched file
  byte-identical AND mtime-unchanged.

- **MUST-FAIL proof (pre-fix path):** (a) ran the PRE-FIX onboard extracted from `git show HEAD:scripts/onboard.mjs`
  against a fixture → it installs NEITHER `.claude/settings.json`, NOR scripts/gate.mjs, NOR the `gate`
  script (all asserted absent). (b) adding with `applyMethod:false` (the pre-fix reality: nothing
  auto-applied) leaves the repo untouched and the WA v1 marker + response-format section ABSENT from the
  composed prompt (must-fail controls). The composed-prompt assertion targets a v1-ONLY marker
  ('build it to production confidence', present in WORKING_AGREEMENT.md, absent from v2) — exactly the part
  a v2-only attach (BUG-099) would drop — so a half-applied stack cannot pass it.

- **Changed:** scripts/onboard.mjs (METHOD_FILES + installClaudeHook + gate script + verdict-contract.mjs
  added to COPIED_TOOLS — see regression note), src/server/wiring.ts (coherentWaStack helper),
  src/server/index.ts (POST /api/projects auto-apply; wiring route reuses the helper),
  src/server/validate.ts (strip applyMethod), public/{index.html,app.js,lib/api.js,styles.css} (opt-out
  checkbox + report surfacing), package.json (verify:feat-089), scripts/verify-feat-089-method-auto.mjs (new).
  Fixture-only edits (opt-out to preserve their bare/repair preconditions): verify-feat-076-wiring.mjs,
  verify-bug-099-attach-wa-coherent.mjs.

- **Verified:** verify:feat-089 35/35 PASS (real scratch server, free ephemeral port, throwaway dataDir —
  NEVER :4317). Anti-regress: verify:onboard 36/36, verify:feat076 36/36, verify:wa-injected 15/15,
  verify:feat-084 37/37, verify:local-conventions 5/5, verify:routing-inject 18/18, verify-bug-099 21/21,
  verify-conventions-live 5/5, verify-new-session-overrides 5/5, verify-overrides 5/5,
  verify-feat-083-response-digest 22/22, verify-feat-074-add-project-surface 7/7 (drives the real picker),
  verify-addproject 7/7, verify-scratch 17/17, typecheck clean, `npm run gate` EXIT 0 (read directly, not
  piped). UI: screenshot of the open picker confirms the opt-out control renders intentionally (separator +
  checked default + wrapped label), consistent with the panel.

- **regressed-from:** onboard's board.mjs copy was already BROKEN at HEAD — board.mjs gained a
  `./lib/verdict-contract.mjs` import (present at HEAD) that COPIED_TOOLS never carried, so the copied
  drift-guard failed to load (verify:onboard (b)/(d) fail on HEAD). Fixed here by adding
  `lib/verdict-contract.mjs` to COPIED_TOOLS — squarely "step 1 genuinely runs." Also: my global change to
  the POST /api/projects default (auto-apply) required opt-out fixture edits in verify-feat-076 and
  verify-bug-099, which explicitly test the not-yet-applied / attach-repair states.

- **Independent-verify recommendation:** this is session-lifecycle + writes-into-the-user's-repo +
  regression-prone (touches onboard.mjs, index.ts add path, the WA attach path with BUG-099 history). Per
  the high-stakes rule, an independent clean-room verify pass (scripts/independent-verify.mjs or a
  fresh-context agent re-running verify:feat-089 + the anti-regress list) is warranted before DONE —
  generation should not be its own only verifier here.

- **Restart requirement:** the live station on :4317 runs the committed pre-change server. This change is
  NOT live until the service is restarted by the user (I did not restart/deploy). The stray untracked
  `CLAUDE.md` at repo root (an onboard-template artifact carrying a /home absolute path — a leak the gate
  correctly caught) was removed; it is not in git and is regenerable.

- **Still open / handoff:** none blocking. Two pre-existing, NOT-mine env failures observed during the sweep
  and left untouched: verify-routing (browser) FATALs on a post-reload `__station.state` read unrelated to
  the add path (its earlier same-run checks read `__station` fine, proving app boots with my changes);
  verify-mcp-attach D1–D3 need a live Serena MCP session. Neither asserts bare add-state.

- **Symptom of a deeper design flaw?** no — this is the intended convergence: auto-installing the machinery
  the WA assumes is exactly what makes the WA's ~15% "assumes a board/CLI/fleet" content true, resolving the
  earlier opt-in objection by construction rather than ignoring it.

### 2026-08-18 — worker (onboard CLAUDE.md leak-vector fix)

- **Understood:** the CLAUDE.md `onboard.mjs` writes into every onboarded project embedded an ABSOLUTE home
  path to the WA (`/home/<user>/projects/orchard/docs/prompts/WORKING_AGREEMENT.v2.md`). A prior worker
  gitignored this repo's own machine-local copy (`/CLAUDE.md` in `.gitignore`) — a defensible disposition for
  THIS repo, but NOT a fix: FEAT-089 now runs onboarding automatically on every project added, so every
  onboarded repo got a CLAUDE.md carrying the operator's home path. Any public onboarded repo would leak it —
  exactly the leak-gate class (`/home/<user>`, bare-word username).
- **Changed:** `scripts/onboard.mjs` — added `os` import + a new `waPointerPath()` helper used by BOTH
  file-writing paths (`claudeMd()` and the `--wa-pointer` `waPointerSection()`). It expresses the WA location
  leak-safely but still operator-resolvable: `~`-relative when the Orchard checkout is under `$HOME` (the
  normal case — `~/projects/orchard/docs/prompts/WORKING_AGREEMENT.v2.md`, no home path, no username, and a
  bare `claude` session can `cat` it), with a `$ORCHARD_HOME/...` env-var fallback if the checkout is NOT
  under `$HOME`. Chosen over a project-root-relative path because the WA lives in the Orchard checkout, not in
  the onboarded target, so a relative path would climb out into an operator-specific absolute location anyway.
  Surrounding prose in both templates re-worded to explain `~`/`$ORCHARD_HOME`.
- **Verified (must-FAIL first, then clean):** generated a fresh CLAUDE.md into a scratch dir via the fixed
  generator → contains `~/projects/orchard/...`, no `/home/...`, no username. `node scripts/leak-gate.mjs
  <scratch>` (TREE mode) → `PASS — 0 hits`. Also drove the `--wa-pointer` append path against a pre-existing
  CLAUDE.md → appended section is token-clean. The pointer still does its job: it names the WA path and how to
  resolve it. Regenerated this repo's own gitignored `/CLAUDE.md` through the fixed generator (trivially safe
  now) so the local copy is clean too; it remains gitignored (`git check-ignore CLAUDE.md` → CLAUDE.md).
- **Anti-regress:** `npm run gate` read directly for its exit status (not piped) before commit.
- **Risk bucket:** SECURITY (leak vector) + it writes into users' repos. An independent clean-room verify pass
  (re-generate + re-run the leak gate against a scratch onboard tree) is WARRANTED — generation should not be
  its own only verifier for a leak fix.
- **Still open / handoff:** none. The fix is at the generator, not a per-repo scrub, so all future auto-onboards
  are clean by construction.
