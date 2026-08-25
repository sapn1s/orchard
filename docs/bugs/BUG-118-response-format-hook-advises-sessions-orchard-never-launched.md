```orchard-ticket
{
  "id": "BUG-118",
  "type": "bug",
  "title": "A reply-format advisory appeared in unrelated projects",
  "summary": "A hand-started session in an unrelated project was told its reply broke this project's reply-format rules. The advisory now speaks only when the launcher stamped the session's own identity on the process, and stays silent otherwise. Ordinary onboarding and the fleet sweep re-sync the hook into projects that already hold the noisy copy.",
  "impact_if_we_wait": "Every project onboarded so far can interrupt someone's unrelated work with wrong advice, in places nobody thinks to look. Bounded: the message is advisory noise, not data loss, and no file or session content is altered.",
  "current_need": "None. The fix is committed and both directions are confirmed by the live machine's own records.",
  "severity": "high",
  "area": "Session launch provenance",
  "reported": "2026-08-19",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session started by hand in an onboarded project receives no reply-format advisory",
    "A session launched by the app still receives the advisory as before",
    "A hand-started session inside a launched session's terminal stays silent despite inheriting the marker",
    "An already-onboarded project picks up the corrected hook without losing its own files",
    "A containerised session reaches the same verdict as an equivalent host session"
  ],
  "code_refs": [
    {
      "path": "scripts/hooks/response-format-gate.mjs",
      "symbol": null,
      "note": "launcher gate: allows silently unless the marker names this payload's session_id"
    },
    {
      "path": "src/server/runtime/claude-runtime.ts",
      "symbol": "claimLaunchedSession",
      "note": "declares the session id, stamps ORCHARD_SESSION on the spawn env; the ...process.env spread preserves the boot-augmented PATH that BUG-091 delivers"
    },
    {
      "path": "src/server/container-manager.ts",
      "symbol": "ENV_PASSTHROUGH",
      "note": "carries the marker across the docker exec boundary"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "runEnv",
      "note": "survivor path spreads the SDK env, so a drain turn keeps the marker"
    },
    {
      "path": "scripts/onboard.mjs",
      "symbol": "RESYNCABLE_HOOK",
      "note": "--force-hook re-syncs only the hook file, which no target repo could own"
    },
    {
      "path": "scripts/fleet-sync.mjs",
      "symbol": "SYNCED_TOOLS",
      "note": "the hook joins the sweep so copies stop rotting"
    },
    {
      "path": "scripts/verify-bug-118-orchard-only-stop-hook.mjs",
      "symbol": null,
      "note": "repro suite; extracts the pre-fix hook from git as its own must-FAIL"
    }
  ],
  "related": [
    {
      "id": "FEAT-085",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-089",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-091",
      "relation": "see_also"
    },
    {
      "id": "BUG-091",
      "relation": "depends_on"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a019e5-b4b7-7461-b6da-33a9c35be47b",
      "verdict": "broken",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01a02-709b-7240-8ece-246f54e85532",
      "verdict": "broken",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01a13-0692-7b22-8ebe-31396d6743dd",
      "verdict": "broken",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01a17-381a-7c10-b32b-41ceccdcf7a5",
      "verdict": "broken",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-118-response-format-hook-advises-sessions-orchard-never-launched.md",
    "sha256": "f8d0024df56b680cddf165649b0878c5cef54953b74af409e53d41aa2160a6d8",
    "bytes": 44116,
    "original_title": "the response-format Stop hook advises sessions Orchard never launched",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original section by section: the mechanism, the inheritance defect, the four start paths, the rejected alternatives, the uncovered case and the fleet-reach gap all survive.",
    "dropped": [
      "the verbatim advisory text quoted twice",
      "the file-by-file fix table's layout, whose content moved into code_refs and implementation notes"
    ]
  }
}
```

# BUG-118 — A reply-format advisory appeared in unrelated projects

## Diagnosis

### How a stranger's turn got graded

Onboarding installs the Stop hook into the target project's own `.claude/settings.json`, which is what makes the method travel to every onboarded repo (FEAT-089). Claude Code runs a project's Stop hooks for any session whose working directory is that project, including a bare `claude` a user starts by hand. The hook could not tell the two apart, so it graded both.

Nothing in the Stop payload identifies who launched the session. A live capture carries session id, transcript path, cwd, prompt id, permission mode, effort, event name, `stop_hook_active`, last assistant message, background tasks and crons — a hand-started session and a launched one are identical on that wire.

The only channel that reaches the hook is the environment its CLI was spawned with, since hook commands are children of the CLI. A bare flag was not enough: round 1 stamped `ORCHARD_SESSION=1`, and an independent verification broke it by opening a terminal inside a launched session, where the child inherited the flag and got advised. The marker therefore carries the declared session id, and the hook speaks only when it equals the `session_id` in its own payload. A child inherits the value but gets its own identity, so it can never match.

The gate fails closed toward silence: no marker means no advisory even under a globally enabled enforce mode. A false advisory in someone else's work is worse than a missed one here, because the format only matters for replies this app renders.

### Deliberately not covered

A session the app merely follows and renders but did not spawn. An environment variable cannot be placed into a process we did not start, and such a session never received the response-format instruction, so grading it would be advice about a rule it never got.

## Evidence

Reproduction: scaffold an empty project outside this repo, run `node scripts/onboard.mjs <dir>`, then run a plain `claude -p` there. A probe hook installed alongside the real one recorded the payload and environment of every turn, confirming the project's Stop hooks fire. Feeding that captured payload to the hook emits the advisory verbatim.

Two fidelity notes. The live headless runs went quiet on their own, which is not the hook behaving — it is the FEAT-085 read-during-write race, where the final assistant line is not yet flushed when Stop fires, so the hook grades nothing and fails open. Replaying the same real transcript a second later produces the advisory every time; the user's own evidence came from an interactive session. Because of that, the sharp before/after evidence is real captured payloads replayed through the shipping hook file, with provenance the only variable.

The fixer's own runs: the onboarding suite passed 36/36 and the fleet-sweep suite 23/23. The grader suites that drive the hook, and therefore had to declare themselves launched sessions, passed — 58/58, 32/32, 276/276 and 60/60 across the stop-hook, readability, adversarial and independent sets, with the response-blocks set at 276/276 and the renderer set at 201/201. The path-augment suite that guards the environment invariant passed 21/21, and the method-auto suite passed 35/35 unchanged. Typecheck stayed clean.

## Implementation notes

The gate allows before anything is read when `ORCHARD_SESSION` is absent, and allows silently ahead of every grading step unless the marker names this payload's `session_id`, directly or via a launcher-recorded rename claim.

The runtime declares the session id — `Options.sessionId` becomes the CLI's `--session-id=<uuid>` for a fresh launch and for a fork, and the resumed id otherwise — and stamps it on the spawn env. The `...process.env` spread is load-bearing because the SDK's `env` replaces rather than merges the child environment. The runtime also watches its own stream for an id that drifts from the declaration and claims it.

Three alternatives were rejected. The payload carries no provenance. The session store is host-only, invisible to a hook running inside a container, which is why identity travels on the environment. A per-project marker file is the opt-in-per-project shape the fix was told not to take and cannot separate two sessions in one directory.

All four ways a launched session starts were checked: a fresh launch carries the marker on the spawn env; a resume is the same spawn path; a survivor after a service restart is the same process still holding its spawn environment, with the continuation an ordinary resume; a container gets it forwarded explicitly.

Neighbouring installed artifacts were checked. The Stop hook is the only thing onboarding installs that fires by itself — the gate wrapper, the leak and NUL guards and the board tooling are invocation-only scripts. The project-instructions pointer onboarding writes also reaches a hand-started session, but it is the ordinary instructions mechanism and the point of onboarding, so it was left alone.

## Verification plan

The change is a silencing gate on a hook that runs in every onboarded repo, so both failure directions matter and both must be attacked: too loud, meaning strangers are advised again, and too quiet, meaning nobody is ever advised and the loss goes unnoticed for weeks. The dedicated repro suite carries its own must-FAIL by extracting the pre-fix hook from git and showing it advising the identical payload. A fourth independent verification of the round-4 change is what remains.

## Migration and rollback

Onboarding never clobbers by design, so projects onboarded before this change keep the noisy hook until `onboard <dir> --force-hook` or a `fleet-sync --apply` sweep reaches them. Re-syncing is scoped to the hook file alone: the rest of the installed closure has names a target repo can plausibly own, and overwriting those would destroy the target's own code.

## Risks

An over-tight gate silences every session and the silence is not self-announcing, which is why the round-4 change repairs the hook at launch or announces the failure. The environment override in the runtime sits on the same path as the boot-augmented PATH delivery, so a regression there breaks tool resolution rather than the advisory.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — fix lane

- **Understood:** the hook is installed into each onboarded project's own `.claude/settings.json`, so Claude Code runs it for every session rooted there, Orchard's or not. The reported hypothesis held. Verified there is no provenance in the Stop payload by capturing a real one from a hand-started session, and verified that hook commands inherit the CLI's environment in the same capture — which is what makes an env marker the only workable signal.
- **Changed:** the gate in `scripts/hooks/response-format-gate.mjs`; the marker in `src/server/runtime/claude-runtime.ts` and `src/server/container-manager.ts`; delivery via `--force-hook` in `scripts/onboard.mjs` (+ `scripts/onboard.d.mts`) and `SYNCED_TOOLS` in `scripts/fleet-sync.mjs`; new suite `scripts/verify-bug-118-orchard-only-stop-hook.mjs`; marker added to the six suites that drive the hook; `scripts/verify-bug-091-host-spawn.mjs` check C rewritten to assert the property it actually needs (an `env` override must spread `process.env`) rather than the absence of any override.
- **Verified (fixer's own run — necessary, never sufficient):**
  - `node scripts/verify-bug-118-orchard-only-stop-hook.mjs` → **24 passed, 0 failed, exit 0**, including the must-FAIL pair: the pre-fix hook from git advises the captured bare payload; the fixed hook is silent on the identical input.
  - Real captured payloads from two live hand-started turns, replayed through the copy installed in the onboarded target: unmarked → 0 bytes out, exit 0; `ORCHARD_SESSION=1` → 703 bytes of advisory, exit 0.
  - Live: a bare turn's hook saw `ORCHARD_SESSION=null`, a marked turn's saw `"1"` — the marker really does reach the hook through a real CLI.
  - Spawn side through the REAL `ClaudeRuntime` with a fake CLI: fresh launch and resume both record `ORCHARD_SESSION=1` in the child, with PATH intact; a `spawnProcess` override (the survival and container seam) receives it; the real `execArgv()` emits `--env ORCHARD_SESSION=1` and invents nothing when it is absent.
  - Anti-regression, all exit 0: `verify-feat-085-stop-hook` 58/58 · `verify-feat-085-readability` 32/32 · `verify-feat-085-adversarial` contract HOLDS · `verify-feat-085-independent` 60/60 · `verify-feat-089-method-auto` 35/35 · `verify-feat-091-response-blocks` 249/249 · `verify-onboard` 36/36 · `verify-fleet-sync` 23/23 · `verify-bug-091-host-spawn` 8/8 · `verify-bug-091-path-augment` 21/21 · `verify-feat-082-digest` 52/52 · `verify-feat-083-response-digest` 22/22 · `verify-feat-084-response-format-inject` 37/37 · `verify-decide-readability` 58/58.
- **Commit:** `5a23f86` (17 files; the sha recorded pre-amend was superseded when this line was folded in). Note for the record: the tree-wide `npm run gate` reported `check-nul PASS`, `typecheck PASS` and `leak-gate FAIL` — the leak hit is in `scripts/verify-arch-004-broken-state-visible.mjs`, an untracked file belonging to a concurrently running ARCH-004 lane, which this lane must not touch. A leak scan scoped to exactly the 17 files committed here passed with 0 hits across 17 files. The ARCH-004 lane owns that leak.
- **Still open:** independent clean-room verification. The attack worth mounting is the too-quiet direction: prove the hook still fires for a genuinely Orchard-launched session in a project onboarded *before* this change and re-synced, and probe the survivor path against a real broker rather than the source-level assertion used here.
- **Handoff:** the survivor case is asserted structurally (survival.ts spreads the SDK env) plus functionally through the shared `spawnProcess` seam; a verifier with a real systemd scope should confirm end-to-end. Existing onboarded repos stay noisy until `--force-hook` or a fleet sweep reaches them.

### 2026-08-19 — independent clean-room verification (round 1)

- **Verified-by:** dispatch openai run 01a019e5-b4b7-7461-b6da-33a9c35be47b (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Range:** `07499ba..d94eb7a` (synthetic base = `608064f` tree with `docs/` overlaid at `d94eb7a`, so the reviewed diff is the 15 non-docs files only). Clean room kept at `<scratch>/orchard-verify/cleanroom-verify-myv4BY`; records at `<scratch>/orchard-verify/cleanroom-record-9vKfr8`.
- **Finding — WRONGLY NOISY:** adversarial case `nested-hand-started-session-inherits-marker` (run `c967d27eab38`, exit 1). A hand-started nested session that inherits `ORCHARD_SESSION=1` from an Orchard-owned parent shell receives the advisory. The verifier ruled out the known read-during-write race explicitly: the transcript was fully written before the hook ran.
- **Fixer suite re-run in the clean room:** run `4c0b1a1bb0fc`, exit 0, 24/24 PASS — but note the room has no `.git`, so leg A degraded to the SYNTHESISED pre-fix hook (`fatal: not a git repository`) rather than the git-extracted one.
- **Could not test (verifier's own statement):** a real service restart / survivor re-adoption (systemd was out of bounds), and a real Docker-isolated or real-API Claude session. The too-quiet direction therefore remains unproven end-to-end.

### 2026-08-19 — round-2 fix lane (the marker becomes an IDENTITY)

- **regressed-from:** this ticket's own round-1 fix (`5a23f86`). The gate it added was a PRESENCE flag, and a presence flag is inherited: every descendant of an Orchard CLI — including a `claude` the user starts by hand in a terminal opened from a session — satisfied it. The user's original complaint survived the fix.
- **Reproduced first, as a must-FAIL.** The clean room's own probe, exit 1, `wronglyNoisy:true`, `transcriptFullyWrittenBeforeHook:true` (so not the flush race). Then a stronger one: the same probe with the payload a REAL nested session produces — its own session id, the parent's marker.
- **Ground truth, measured on a real `claude` 2.1.235 before designing anything:**
  - a CLI started with `--session-id <uuid>` reports exactly that id in its Stop payload;
  - a `--resume <uuid>` run reports the same id again;
  - a nested hand-started run in the same directory, with the marker inherited, reports a NEW id (`bfd9235f-…` parent vs `fd999564-…` nested). Identity is the one thing inheritance does not copy.
- **The mechanism now:** `ORCHARD_SESSION` carries the session id Orchard DECLARES for that CLI, and the hook speaks only when it equals its own payload's `session_id`. `claude-runtime.ts` chooses the id (`Options.sessionId` → the CLI's `--session-id=<uuid>`, proven on the fake CLI's argv) for a fresh launch and for a fork, and reuses the resumed id otherwise.
- **The two directions, deliberately:**
  - **TOO LOUD is now unrepresentable by value:** speaking requires the payload's own session id, which only the launcher can have named. A nested session would have to be handed its parent's uuid to match.
  - **TOO QUIET is guarded, not assumed** (it is the direction nobody notices): the runtime watches its own message stream and, if the CLI ever reports an id other than the declared one, warns and writes a `declared -> observed` claim into `dataDir()/launch-claims.json`, which the hook honours (scoped to that declaration, expiring after 7 days, corrupt file → silence). No drift was observed in any live run, so the file stays absent in practice. **Honest gap:** the claim file is host-side, so inside a container the declaration is the only path; a container-side rename would go quiet.
  - Two smaller silences chosen on purpose: a payload with no `session_id` is un-attributable → silent; and an onboarded copy that has not been re-synced now sees a uuid where it expects `1`, so it goes INERT rather than noisy — stale copies fail toward silence until `--force-hook` / `fleet-sync` reaches them.
- **The dangerous half, closed by live observation (not structure).** Scratch service only — its own transient `--user` unit, its own free port and data dir; `:4317` and the real unit untouched.
  - **Survivor after a real restart:** real session, real broker, real control-group `systemctl --user stop`. The CLI survived (pid alive), its in-flight turn drained to completion with no server alive, and the drain turn's Stop hook saw `ORCHARD_SESSION == session_id == 39aa00c8-…`. That drain turn produced no metrics line — the KNOWN flush race, not the gate: replaying its own captured payload through the same installed hook once the transcript was complete produced the advisory and a metrics line.
  - **Resume after re-adoption:** the restarted server reaped the broker and ran a resume-from-disk turn; that turn was graded LIVE (metrics + advisory written at 12:16:13) with the marker naming the resumed session.
  - **Container:** a real container project, a real `docker exec`-ed CLI, the onboarded hook running INSIDE the container (`hostname f37866e761ee`, `HOME=/home/claude`, `cwd=/workspace/bug118ctr`) — marker equal to the payload's session id. Live grading again lost the flush race; the in-container replay of the same payload advised, and the same in-container hook was silent for a foreign session id.
  - **Nested, for real, twice:** a hand-started `claude` on the host and another inside the container, both inheriting the live marker, both getting their own ids, both ignored — no metrics line, no advisory.
- **Changed:** `scripts/hooks/response-format-gate.mjs` (identity gate + claim honouring), `src/server/runtime/claude-runtime.ts` (declares the id, passes it to the CLI, watches for drift, `claimLaunchedSession`), `src/server/container-manager.ts` (comment only — the passthrough already forwards the value), `scripts/verify-bug-118-orchard-only-stop-hook.mjs` (rewritten for the new contract), and the six suites that drive the GRADER, which now declare ownership of the payload they send instead of setting a bare flag.
- **Verified (fixer's own run — necessary, never sufficient), exit codes read directly:**
  - `verify-bug-118-orchard-only-stop-hook` → **43 passed, 0 failed, exit 0**, carrying BOTH must-FAILs from git: round-0 (`608064f`) advises a hand-started session, round-1 (`5a23f86`) advises the NESTED one, and the fixed hook is silent on both identical inputs.
  - Live probes: survivor/resume/nested harness 13/14 (the one FAIL is the flush-race ambiguity above, closed by replay); container harness 6/7 (same, same).
  - Anti-regression, all exit 0: `verify-feat-085-stop-hook` 58/58 · `verify-feat-085-readability` 32/32 · `verify-feat-085-independent` 60/60 · `verify-feat-085-adversarial` contract HOLDS · `verify-feat-091-renderer` 178/178 · `verify-feat-091-response-blocks` 249/249 · `verify-onboard` 36/36 · `verify-fleet-sync` 23/23 · `verify-feat-089-method-auto` 35/35 · `verify-bug-091-host-spawn` 8/8 · `verify-bug-091-path-augment` 21/21 · `verify-feat-082-digest` 52/52 · `verify-feat-083-response-digest` 22/22 · `verify-feat-084-response-format-inject` 37/37 · `verify-decide-readability` 58/58.
  - `npm run gate` → typecheck PASS, check-nul PASS, leak-gate FAIL — the two hits are in `docs/prompts/RESPONSE_FORMAT.md`, a file this lane never touched, belonging to the concurrently running FEAT-091 lane. A leak scan over exactly this lane's files passed: 0 hits across 10 files.
  - Attribution check, so no failure is quietly inherited or disowned: `verify-feat-091-response-blocks` fails 8 checks in the shared working tree; in a pristine `HEAD` worktree carrying ONLY this lane's changes it is 249/249, so those 8 belong to the FEAT-091 lane's in-flight edits.
- **Lane hazard, stated so it cannot be lost:** `scripts/verify-feat-091-response-blocks.mjs` needed the same one-line ownership change, but that file already carried the FEAT-091 lane's uncommitted work, so this lane did NOT stage it — committing another lane's WIP would be worse. The change is live in the shared working tree and must ride out with FEAT-091's commit; if that lane checks the file out instead, re-apply the `ownPayload`/`ownMarker` pair or the suite will fail on the launcher gate.
- **Still open:** an independent clean-room pass on THIS round. It is the high-stakes bucket — session lifecycle, a file with a regression history, and a gate whose quiet direction is invisible. Worth attacking: whether any real path can rename a session mid-life (compaction, `/clear`, an SDK upgrade that drops `--session-id`), and the container-side drift gap named above.
- **Verified-by:** dispatch openai run 01a01a02-709b-7240-8ece-246f54e85532 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 2026-08-19 — round-3 fix lane (the second escape hatch is DELETED, not bounded)

- **regressed-from:** this ticket's own round-2 fix (`e7ba00d`). The identity gate was right; the launch-claim fallback added beside it was not, and it re-opened the exact round-1 escape it was meant to protect against.
- **Reproduced first, as a must-FAIL.** The clean room's own probe (`adversarial-future-claim.mjs`, preserved at `<scratch>/orchard-verify/cleanroom-verify-0ROoNk`) against HEAD: `{"silent":false,"exit":0,"advised":true}`, **exit 1**. Write `{declared, observed: <foreign uuid>, ts: now + 365d}` into `launch-claims.json`, present a Stop payload whose session id is that foreign id with only an INHERITED marker, and the hook advises a stranger. The age test was `now - c.ts <= CLAIM_MAX_AGE_MS` with no lower bound, so a forged future timestamp stayed valid for a year past its own forgery.
- **The design question, answered: DELETE.** Bounding the timestamp at both ends closes the instance and leaves the class untouched. `launch-claims.json` is an ordinary file in the user's data dir, so **who can write it** is *every process running as this user* — including the hand-started `claude` sessions this gate exists to exclude, and every agent, hook and tool in every onboarded project. The hook cannot distinguish a claim written by the Orchard server from one written by anything else, so **what they can cause** is "the hook vouches for any session id I name" — an unauthenticated grant, obtainable just as easily with an honest `ts: Date.now()` as with a forged one. No validation *inside* the hook can make that file trustworthy; only its absence can. It was covering a drift that has **never been observed in any live run**, and the cost of not having it is that the hook goes quiet for such a session — the direction this gate already declares is the correct bias.
- **Failure classes, precisely:**
  - **UNREPRESENTABLE now** — advising a session whose id is not the one the launcher named. `launchedByOrchard` has a single path to `true` (env marker === payload `session_id`): no file, no clock, no parse, no staleness window, no concurrent writer, nothing an attacker can author. Round 1's escape and round 2's escape are both closed by construction rather than by validation.
  - **GUARDED, not eliminated** — a genuine Orchard session whose CLI renames itself now goes silently ungraded. It is *watched*: `#noteSessionId` still compares every frame's session id against the declaration and warns once with both ids, saying the hook will stop grading that session; and the session stops appearing in the format metrics, which is the denominator that makes the silence visible.
  - **Still unrepresentable by design** — a foreign session Orchard follows but never spawned is never graded.
  - **Residual trust, stated honestly** — the `ORCHARD_SESSION` env var itself. Anything that can set it on a CLI's own environment can have that CLI graded. That is strictly smaller authority than the claims file: it reaches exactly ONE session, the one whose id it names, and only for a process being launched — not any session, from a file on the side.
- **Changed:** `scripts/hooks/response-format-gate.mjs` (removed `CLAIM_MAX_AGE_MS` and `launchClaims()`; `launchedByOrchard` is now a single equality), `src/server/runtime/claude-runtime.ts` (removed `claimLaunchedSession` and `launchClaimsFile` and their now-dead `fs`/`path`/`dataDir` imports; the drift watch reports and no longer repairs), `scripts/verify-bug-118-orchard-only-stop-hook.mjs`. **Supersedes** the round-2 rows above that describe the hook honouring a rename claim (the `The fix` table's `claude-runtime.ts` row, and the round-2 "TOO QUIET is guarded" bullet).
- **Evidence quality made visible (a clean-room caveat the last round hid).** The suite fetches historical must-FAIL specimens with `git show <sha>`, and a clean room has no `.git`, so round 2 silently degraded to a synthesised reconstruction — a control that looks identical in the output but is only a re-creation of what the author believes the old code did. Each specimen now announces GENUINE vs `*** RECONSTRUCTED — DEGRADED CONTROL ***`, every affected check name carries a `[DEGRADED]` tag, and the summary line states the split. Proven both ways: with git, `3 genuine, 0 RECONSTRUCTED`; with `git` stubbed to fail on PATH, `0 genuine, 3 RECONSTRUCTED` with the banner, and the reconstructions still reproduce all four defects.
- **Verified (fixer's own run — necessary, never sufficient), exit codes read directly:**
  - `verify-bug-118-orchard-only-stop-hook` → **73 passed, 0 failed, exit 0** (was 43). New: A3/A4 must-FAILs against the round-2 specimen from git `e7ba00d` (forged future claim AND honest current claim both advise a stranger; the fixed hook is silent on both identical inputs — which is why the fix is removal, not a clock bound); B8's 24-shape sweep of the file the hook no longer reads (well-formed, future, epoch, missing/non-numeric/NaN/Infinity ts, object fields, null entry, wrong-shape JSON, bare array/string/null, empty, whitespace, truncated, 1MB junk, mode-000 unreadable, a directory at the path) all silent at exit 0; 12 runs against a concurrent truncate/rewrite loop, silent 12/12; and the marker-named session still graded with all that on disk.
  - Section E — **identity drift driven through the REAL `ClaudeRuntime`** and a real child CLI that renames its session: warned exactly once with both ids, nothing written to repair it, the drifted session silently ungraded, and graded again the moment the marker names the id the CLI reports. That observable is what compaction, `/clear`, a branch, a replay and an SDK upgrade that drops `--session-id` all reduce to; the suite says so and names them as not driven live.
  - The clean room's own probe against the fix: `{"silent":true,"exit":0,"advised":false}`, **exit 0**.
  - **LIVE, re-run against this change** (scratch server as its own transient `--user` unit, own free port, own data dir; `:4317` and the real unit untouched): survivor/resume/nested harness **13 passed, 1 failed** and container harness **6 passed, 1 failed** — in both cases the single FAIL is the known FEAT-085 flush race (the live drain turn's transcript is not complete when Stop fires), not the gate. Closed by replay in each: the SAME installed hook, fed the same turn's payload once the transcript was complete, graded it (host: 385 bytes of advisory + a metrics line for `dc6e21db…`; container: advisory inside `3c74b7f78cbc`), and was silent for a foreign session id through that same hook. Real observations: survivor drain `ORCHARD_SESSION == session_id == dc6e21db…` with the CLI alive across a control-group stop; resume after re-adoption graded live; nested real `claude` on the host (`94e91223…`) and inside the container (`0c9838b8…`) both inherited the marker, both ignored.
  - Anti-regression, all exit 0: `verify-feat-085-stop-hook` 58/58 · `verify-feat-085-readability` 32/32 · `verify-feat-085-independent` 60/60 · `verify-feat-085-adversarial` contract HOLDS · `verify-feat-091-response-blocks` 276/276 · `verify-feat-091-renderer` 201/201 · `verify-onboard` 36/36 · `verify-fleet-sync` 23/23 · `verify-feat-089-method-auto` 35/35 · `verify-bug-091-host-spawn` 8/8 · `verify-bug-091-path-augment` 21/21 · `verify-feat-082-digest` 52/52 · `verify-feat-083-response-digest` 22/22 · `verify-feat-084-response-format-inject` 37/37 · `verify-decide-readability` 58/58 · `npm run typecheck` clean.
- **Still open / could not test:** history compaction, a cleared or branched conversation, a replayed transcript, and a real SDK upgrade that stops honouring `--session-id` were not driven against a real CLI — each would make the hook silently stop grading a genuine session, and each is now at least *reported* by the drift watch. The container-side gap is unchanged in shape but smaller in consequence: there is no longer a host-only repair path to be missing inside a container, because there is no repair path at all.
- **Independent verification warranted:** yes — session lifecycle, a file with a two-round regression history, and a silencing gate whose failure direction is invisible. This is not a routine tweak.
- **Verified-by:** dispatch openai run 01a01a13-0692-7b22-8ebe-31396d6743dd (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Verified-by:** dispatch openai run 01a01a17-381a-7c10-b32b-41ceccdcf7a5 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 2026-08-19 — round-4 fix lane (DELIVERY: a copy cannot fix, or even notice, itself)

- **regressed-from:** this ticket's own round-1 fix (`5a23f86`), compounded by round 3 (`c8f64cc`). Round 1 put a hook into every onboarded project that accepts only `1|true|yes` as the marker. Round 3 changed the launcher to send a session id. Neither round delivered the new hook to the projects already holding the old one, and onboarding's never-clobber rule left them exactly as they were.
- **Reproduced first, as a must-FAIL**, from the third cross-provider clean room's own probe (`adversarial-round1-delivery.mjs`), re-pointed at the live repo: onboard a project, leave it holding the round-1 predicate, re-run ordinary onboarding, then hand the hook a payload whose `session_id` **is** the declared marker — a perfectly genuine current launch. Against HEAD: `{"plainResyncStatus":"exists (diverged — left untouched)","advised":false}`, **exit 1**. Every genuine launched session in an already-onboarded project was silently ungraded, and the repair was a flag nobody knew to run.
- **Why this survived three rounds, stated plainly:** a stale hook's way of failing is to go quiet, and quiet is indistinguishable from a project full of compliant replies. Property (1) — Orchard's own sessions get graded — was failing *through* property (3) — delivery — and nothing anywhere said so.
- **The decision: the hook is not a file the never-clobber rule protects.** That rule is right for files a target repo may own (`scripts/gate.mjs`, `public/lib/dom.js`); overwriting those destroys the user's code. Nothing but this project ships `scripts/hooks/response-format-gate.mjs`, so the only thing an overwrite can destroy is our own earlier copy — and the target is a git repo, so the replacement shows up in its diff and is recoverable. Three deliveries now, in order of how little they depend on anyone remembering:
  1. **The launcher, every start** (`ensureCurrentStopHook` in `claude-runtime.ts`) — compares the installed copy against this repo byte-for-byte and rewrites it if it differs. This is the load-bearing one: the launcher is the side that is always current, and a stale copy is by definition old code that knows nothing about the new contract.
  2. **Ordinary onboarding** — re-syncs the hook with no flag, reported `re-synced (stale hook replaced)`. `--force-hook` survives as a no-op alias.
  3. **`fleet-sync --apply`** — unchanged, still sweeps the fleet.
- **Rejected: a transitional marker both predicates accept.** One value cannot be both a uuid and `1|true|yes`, and a second presence-flag env var would re-arm round 1's defect in every stale copy — every hand-started nested `claude` advised again. That trades the quiet failure back for the loud one this ticket exists to kill.
- **A stale hook must never fail silently — what says so, and where:**
  - The launcher **announces** every repair (`replaced a STALE response-format Stop hook in <project> (3d8fac56 → d40f5079)`), and announces far more loudly when it *cannot* repair one: `… is STALE … and could not be replaced: EACCES … Sessions here are probably NOT being graded. Fix with: node scripts/onboard.mjs <project>`. Once per project per server process, so a repeat launch is not noise.
  - A hook that is installed but **not wired** into the target's `.claude/settings.json` is announced too: Claude Code never runs it, which is disabled just as thoroughly and just as quietly.
  - A project that was **never onboarded** is left completely alone. The launcher does not scaffold a repo behind the user's back, and that case is not the silent-failure class: the hook was never running there.
  - The hook itself now writes an **`ungraded` record** to `dataDir()/logs/stop-hook-advisory.log` for every turn it declines to grade, with both ids and the reason. Deliberately log-only — not `systemMessage`, not stdout, not even stderr — because the hook cannot tell a genuinely drifted Orchard session from a nested `claude` that merely inherited the marker, and anything on the process's own channels lands in the stranger's face, which is round 1's complaint. The loud, user-facing half belongs to the launcher, which is the only party that knows the id it declared.
- **Failure classes, precisely:**
  - **UNREPRESENTABLE now** — "a project that ran onboarding still holds a hook older than this repo's". Ordinary onboarding cannot leave a diverged hook in place; there is no flag that turns the re-sync off, so there is no state where somebody forgot to pass it.
  - **UNREPRESENTABLE now** — "a session is launched into a project whose hook is stale, and nothing is said". Either it is repaired (and announced), or the failure to repair is announced.
  - **GUARDED, not eliminated** — a stale hook in a project **nobody ever launches a session into and nobody re-onboards**. Nothing runs there, so nothing can notice; `fleet-sync --apply` remains the sweep for it.
  - **GUARDED, not eliminated** — a *current* hook sitting on a **stale dependency closure** (`readability.mjs`, `digest.js`, `response-blocks.js`, `format-metrics.mjs`). Those have names a target can own, so they are never clobbered, and they used to fail *inside* the hook straight to a silent `allow()`. They still allow the turn, but every one of those paths now writes a `deps-*` ungraded record instead of vanishing. **This is the remaining delivery hole and it is real**: a future fix that lives in `readability.mjs` or `digest.js` still cannot reach an onboarded project.
  - **Unchanged** — a foreign session Orchard follows but never spawned is never graded.
- **The round-3 reduction claim, driven instead of restated.** Round 3 asserted that compaction, a cleared or branched conversation, a replayed transcript, and an upgrade that stops passing `--session-id` all reduce to one observable. Section G now *runs* all four as payload shapes against the real installed hook: each produces a silent turn plus exactly one `ungraded` record — `other-id` for the first three, `no-id` for the fourth (**G7/G8, 4/4**). What is proven is that the four reduce to one observable *in our code*. What is **not** proven, and is now said in the suite's own output rather than buried: that a real CLI actually produces those payload shapes in those situations. Compaction cannot be forced offline at all.
- **Verified (fixer's own run — necessary, never sufficient), exit codes read directly:**
  - The clean room's probe against the fix: `{"plainResyncStatus":"exists (identical)","advised":true}`, **exit 0** (was exit 1 against HEAD).
  - `verify-bug-118-orchard-only-stop-hook` → **100 passed, 0 failed, exit 0** (was 73). New: section D inverted (an ordinary re-run re-syncs, a second run is a no-op, nothing else is touched); section F — launch-time delivery driven against real onboarded trees, including an unwritable stale hook (`chmod 555`), an unwired settings.json, a never-onboarded project, and **F10/F11 through a real `ClaudeRuntime.start()`**, where a project holding the round-1 hook is repaired before the CLI runs and then grades a current launch; section G — the ungraded record, the reduction sweep, and a real onboarded project given a genuinely broken `public/lib/digest.js` (**G9–G11**: turn still allowed, `deps-digest-incompatible` / `deps-digest-unloadable` recorded).
  - Must-FAIL controls still genuine: `3 genuine (from git history), 0 RECONSTRUCTED`. The clean-room fallback was re-proven by stubbing `git` to fail on PATH: `0 genuine, 3 RECONSTRUCTED`, banner shown, **97/0 at that time**. The reconstruction regexes were rewritten for the new source shape and now **throw** rather than quietly matching nothing — a reconstruction that keeps the guard it is meant to remove is a must-FAIL control that cannot fail.
  - **LIVE, re-run against this change** (scratch server as its own transient `--user` unit, own free port, own data dir; `:4317` and the real unit untouched): survivor/resume/nested harness **14 passed, 0 failed** — the drain turn after a real control-group stop was graded live this time (marker `05996b6c…` == payload session id, metrics line written), resume graded live, and the real nested `claude` (`d3872e8a…`) was ignored. Container harness **6 passed, 1 failed**; the single FAIL is the known flush race, disambiguated by the established method — replaying that turn's own captured payload through the same in-container hook produced the advisory (C2b PASS), and the same hook was silent for a foreign id (C2c PASS).
  - **Live evidence for the new record**, from that same run: the real nested host `claude` left exactly one line — `{"mode":"ungraded","verdict":"other-id","declared":"05996b6c…","observed":"d3872e8a…"}`. The observable is not a fixture.
  - Anti-regression, all exit 0: `verify-feat-085-stop-hook` 58/58 · `verify-feat-085-readability` 32/32 · `verify-decide-readability` 58/58 · `verify-feat-084-response-format-inject` 37/37 · `verify-onboard` 36/36 · `verify-fleet-sync` 23/23 · `npm run typecheck` clean.
- **Reported, not fixed (other method files this project installs):**
  - **The board tooling** (`board.mjs`, `arch-watch.mjs`, `lib/verdict-contract.mjs`, `lib/ticket-schema.mjs`) is copied and re-synced only by `--force-board-tool` / a fleet sweep, so it *can* drift. It was left on that path because its staleness is **loud**: a human runs the tool and reads its output. `ticket-schema.mjs` is the weakest of the four — it defines "done", so a stale copy grades tickets by an old schema and prints a green board. Worth a follow-up; not clear-cut enough to change under a live lane.
  - **The gate wrapper** (`gate.mjs`, `leak-gate.mjs`, `check-nul.mjs`) is copied ONCE and never swept by anything. A gate that gains a new check on our side (BUG-103 added `check-nul.mjs` exactly this way) leaves every onboarded copy passing green without it — a silent disable, and the worst of the set. It cannot take the hook's treatment: `scripts/gate.mjs` is a name a target can plausibly own.
  - **The hook's own closure** — see the GUARDED class above. This is the same hole with the hook's name on it.
- **Independent verification warranted:** yes. Session lifecycle, a file with a three-round regression history, and a change that now WRITES INTO USER REPOSITORIES AT LAUNCH — that last one is new authority and deserves an adversary. Worth attacking: whether `ensureCurrentStopHook` can ever write outside a project that already contains our hook; whether a launch into a project a user deliberately hands-off gets clobbered; whether the announcement can be starved (the once-per-process cache) into hiding a genuine stale project; and whether a real CLI produces the payload shapes section G assumes for compaction, `/clear` and replay.
- **Commit provenance, recorded because it is confusing otherwise:** the round-4 code landed inside commit `c1463cc`, whose message is ARCH-004's. Two lanes were mutating the same working tree, and the ARCH-004 lane ran `git commit` while this lane's files were staged, so its commit carries this lane's six files (and, because this lane had just unstaged the ARCH-004 files it did not own, none of its own). Nothing is lost and nothing is wrong in the tree — `git show --stat c1463cc` lists exactly this lane's files — but a reader tracing BUG-118 by commit message will not find it. History was NOT rewritten: another lane was live in the same tree.
- **Correction to the note above (same day, minutes later):** the race resolved itself. The ARCH-004 lane re-made its commit, so the history now reads correctly: `9163d21` carries this lane's six files under its own BUG-118 message, and `132f65e` carries ARCH-004's four. The provenance note above is kept rather than deleted because this board is append-only, but `c1463cc` no longer exists.

### 2026-08-20 — closing check (the fifth verification round is cancelled; the live machine answered instead)

This ticket was open on one thing: another independent clean-room round. Those are no longer bought,
so the question became the direct one — is round 4 actually committed, and is the gate actually
behaving? Both answered against the user's own live machine rather than a fixture, which is the best
artifact available here and better than any of the four clean rooms had.

- **Committed, not "landed in the working tree".** `9163d21` — *"BUG-118 round 4: a copy of the hook
  cannot fix, or even notice, itself"* — carries all six files: `scripts/hooks/response-format-gate.mjs`,
  `src/server/runtime/claude-runtime.ts`, `scripts/onboard.mjs`, `scripts/fleet-sync.mjs`, the suite,
  and this ticket. `git status` over the hook, the runtime, `onboard.mjs` and `fleet-sync.mjs` is
  empty: nothing of the fix is sitting uncommitted.
- **The gate at HEAD is the identity equality, with no escape hatch.** In the committed hook,
  `launchedByOrchard` compares `process.env.ORCHARD_SESSION` against the payload's own `session_id`;
  there is no `launchClaims`, no `CLAIM_MAX_AGE_MS`, no file read — the round-3 deletion held.
- **The running build contains it.** Service `ActiveEnterTimestamp` 2026-08-20 10:31 EEST, commit
  2026-08-19 16:16 — no deploy lag between the two.
- **BOTH directions confirmed on live records, not assertions** (under the station data dir's `logs/`):
  - **Too loud — closed.** `stop-hook-advisory.log` holds **155** `mode:"ungraded"` records, every one
    `verdict:"other-id"`, each naming the launcher's declared id and a different observed id. That is
    the inherited-marker case — the user's original complaint — being declined, repeatedly, in real
    use, and leaving a trace instead of an advisory.
  - **Too quiet — NOT happening.** `response-format-metrics.jsonl` was still being appended for the
    launcher-declared session **one minute before this check** (08:29:54Z), with further lines at
    08:06 and 08:26 — all after the 07:31Z service restart. Genuine launched turns are being graded
    right now. This is the direction four rounds warned is invisible, and the metrics denominator is
    exactly the instrument the round-3/4 entries said would make it visible; it is non-empty.
  - Across the advisory log, 408 records are `advisory` and 155 `ungraded` — a hook that is neither
    silent nor indiscriminate.

**Conclusion: done.** `work_state` `in_progress` → `done`, `human_action` `review` → `none`. Stated
plainly for the record: this is `done`, not `verified` — the four `verification[]` entries are BROKEN
verdicts against rounds 1–3, all superseded, and round 4 has no independent verdict and now will not
get one. The proof standing behind this closure is the fixer's 100/0 suite plus the live-machine
evidence above, not an outside pass.

**Carried forward, unfixed and still true** (recorded so closing this ticket does not bury them —
each is a separate concern, not a reason to hold BUG-118 open):
1. The hook's **dependency closure** (`readability.mjs`, `digest.js`, `response-blocks.js`,
   `format-metrics.mjs`) is never re-synced into onboarded projects; a future fix living there cannot
   reach them. It now records a `deps-*` ungraded line instead of vanishing, but the delivery hole is
   real.
2. The **gate wrapper** (`gate.mjs`, `leak-gate.mjs`, `check-nul.mjs`) is copied once and swept by
   nothing — a new gate check silently does not exist in onboarded copies.
3. **`ticket-schema.mjs`** in the board tooling drifts on `--force-board-tool` only, and it defines
   "done".
4. A project **never launched into and never re-onboarded** keeps a stale hook; `fleet-sync --apply`
   is the only sweep.
These deserve their own ticket if the fleet grows; they are dormant while this is the only repo in use.

Scope of this pass: read-only checks plus this ticket's own text. No code touched, no server started,
`:4317` and the service untouched.
