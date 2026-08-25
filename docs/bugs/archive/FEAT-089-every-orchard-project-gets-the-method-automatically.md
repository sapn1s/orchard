# FEAT-089 — every project added to Orchard gets the full method automatically

- **Status:** VERIFIED
- **Area:** the add-project path (src/server/index.ts, registry.ts) + scripts/onboard.mjs + wiring.ts + the response-format injection (FEAT-084) + the stop hook install
- **Reported:** 2026-08-15 by user

## In plain terms

Right now, adding a project to Orchard gives you the runtime — the browser tools, the session handling —
but none of the working method. You get the ticket board only if you run a command by hand, the working
agreement only if you click a button, and the reply formatting and readability checks not at all, because
those live in this one repo's local settings.

The user's instruction is direct: any session opened or created in Orchard must have this already applied.
Not opt-in, not per-project setup.

**Why it matters:** A project added to Orchard today silently gets the tool without the method. That is
exactly the failure the wiring panel was built to expose — and the user should not have to read a panel to
discover that nothing was applied.

**What I need from you:** Nothing — the instruction is given. One thing to confirm when it lands: adding a
project will now write files into that repository (a ticket board, a conventions stub, a hook config). It is
idempotent and never overwrites, but it is a real side effect on your code, so it will report exactly what it
created.

**If you do nothing:** Every new project keeps starting bare.

## What is missing today (verified)

`scripts/onboard.mjs` scaffolds `docs/bugs/`, copies the drift-guard and wires its npm scripts. It does
**not**: attach the working agreement, install the stop hook, or install the gate wrapper. And onboarding
itself only runs when invoked by hand.

| Piece | Travels to a new project today? |
|---|---|
| Ticket board + drift guard | Only if `npm run onboard` is run manually |
| Working Agreement | No — requires a separate click in the wiring panel |
| Provider routing | Yes — injected universally already |
| Local conventions | Only the stub, and only via onboard |
| Response format (the reply digest) | No — the document exists but nothing injects it (FEAT-084) |
| Readability enforcement | No — the hook config lives in this repo's ignored local settings |
| The sanctioned gate wrapper | No |

**This is a general capability, not an Orchard-specific one.** The stop hook is a standard Claude Code
mechanism available to any project; the format instruction is ordinary injected context. Nothing about
either is tied to this repo. They simply are not installed anywhere else.

## Wanted

**Adding a project to Orchard applies the method automatically:**
1. Run the existing idempotent onboarding (board, drift guard, conventions stub).
2. Attach the Working Agreement — the coherent base-plus-extension pair, via the fixed attach path (BUG-099).
3. Enable the response format for that project, and inject the instruction (this depends on FEAT-084, which
   is the piece that makes the agent aware of the format at all).
4. Install the readability/format hook into the project's own settings, and the sanctioned gate wrapper.
5. **Report what was created**, and leave every existing file untouched — onboarding is already idempotent
   and must stay so.
6. **Opt-out** available, both at add time and afterwards. The wiring panel already reports the resulting
   state per project and remains the place to see and repair it.

### Resolves an earlier objection, deliberately
An earlier analysis argued the Working Agreement should stay opt-in, because roughly 15% of it assumes
machinery a bare repository lacks — a dispatch CLI, a ticket board, a provider fleet. That objection is
answered by this change rather than ignored: if adding a project *installs* that machinery, the assumption
holds. The WA is only wrong for a project that has the method's rules without its tools, and after this
there is no such project.

## Risks to handle
- **Writing into a user's repository on add.** Real side effect. Must never overwrite, must report, must be
  undoable, must be declinable. Do not make it silent.
- A project added purely to browse history may not want scaffolding — the opt-out must be reachable at the
  moment of adding, not only afterwards.
- Do not regress the confirm gate the wiring panel already has for its manual apply.

## How we'll know it works
- Add a fresh fixture project → without any manual step, the board exists, the WA is attached and present in
  the composed prompt, the format is enabled and injected, the hook and gate are installed. Must-FAIL: today
  none of that happens.
- Re-adding, or adding a project that already has some pieces, changes nothing and reports "already present"
  — idempotence proven, not assumed.
- Opting out leaves the repository untouched.
- The wiring panel reports every check satisfied for the new project.
- Existing projects are unaffected until explicitly repaired.

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
