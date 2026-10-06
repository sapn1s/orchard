# BUG-196 — switching a session to Claude keeps sending its turns to OpenAI

- **Status:** VERIFIED (round-8 verify 2026-09-29: contract-VALID HOLDS — the independent clean-room verdict is now well-formed AND passes. Verifier anthropic/claude-sonnet-5 run 8f1cfcb0-1b98-4ffd-87c7-5b36adeb9b9e [clean-room cleanroom-verify-nDn2qi, record cleanroom-record-y42Knh, isolated BUG-196-only tree bug196-r6-verify/iso-only, full 203114-byte diff untruncated, docs stripped] ran the ONE canonical FIXER-TEST verify-bug-196-provider-lock.mjs 60/60 [run fe8317835e33 exit0] PLUS a NEW adversarial attack beyond round-7's reopen-after-failed-read — invalid-model-pick-equals-project-default [scratch-adv-equal-pick.mjs run 82bb5b496caa exit0]: a raw start frame carrying overrides.model=claude-opus-4-1 [the project's own default, invalid for the openai-transcript-pinned session] was ANNOUNCED+ignored via status + effective-config.ignoredOverrides, the turn ran on openai, and the claude model never leaked into effective.model — the exact round-4 silent-drop shape, now correctly announced [req-3]. VERDICT: HOLDS, contract VALID [independent-verify exit 0], manifest-backed [6 runs], no corrective re-prompt needed. The round-7 contract-INVALID [3 FIXER-TEST lines] is RESOLVED by the charter fix: the verifier was handed exactly ONE canonical FIXER-TEST and the matrix legs relabelled as ADVERSARIAL/supporting; it emitted exactly one FIXER-TEST line. DECORRELATION: same provider [anthropic] as the fixers, different model [sonnet-5 vs the Opus 4.8/5 fixers]; cross-provider [openai] not used this round. UNTESTED [not breaks]: the bounded matrix legs unit/wire/order/fresh [turn budget]; true two-tab concurrency; reattach after a REAL server-process restart; the real headless-browser CLIENT/ORDER legs [host docker-churn net::ERR_NETWORK_CHANGED limit]. Full detail in the round-8 Activity-log entry below. — round-7 verify 2026-09-29: NOT VERIFIED STANDS — the independent verdict is contract-INVALID again [independent-verify exit 3], but for a NEW reason and with STRONG positive substance, and per charter the lane did NOT loop. Verifier anthropic/claude-sonnet-5 run 32340bd0-5e4c-4b96-a36e-0981e2bebe39 [clean-room cleanroom-verify-ZThoHd, record cleanroom-record-cSOplS, isolated BUG-196-only tree, full 203114-byte diff untruncated] ran the BUG-211-BOUNDED evidence set EXACTLY as instructed — verify-bug-196-provider-lock.mjs 60/60 [run 14be09fc048b exit0]; verify-bug-196-matrix.mjs --leg=unit,wire,order,fresh [runs 115cef2664a7/b371030496dd/5648b94f28a0 exit0]; ONE small client sample --leg=client --engine=openai --pick=alias [run ed661993ed97 exit0] — plus a NEW adversarial attack it built, reopen-after-failed-read [scratch-adversarial-reopen.mjs run c09b5d3fdcfc exit0, PASSED: after a first transcript read FAILS then a second SUCCEEDS, the composer button/popover/drawer repaint from unknown/locked to the real declared engine and do not stick], and reached VERDICT: HOLDS with an honest UNTESTED list [multi-process server restart mid-session; concurrent double-resume race on one never-imported native rollout — inspected, judged safe, not run; true two-OS-process tab concurrency; the 234 remaining client cells]. BUG-211's 'verifier never writes a verdict' symptom is GONE — it finished and wrote a full citation block; the bounded-runs mitigation worked. INVALID SOLELY because it emitted 3 `FIXER-TEST:` lines [contract allows exactly ONE], a direct side-effect of the bounded instructions handing it 3 fixer-test commands to run+cite; the one sanctioned corrective re-prompt did not collapse them. So no contract-VALID verdict exists and NOT VERIFIED stands, but the ONLY substantive signal this round is HOLDS with a passing new adversarial attack. HARNESS follow-up for BUG-211: the 'exactly one FIXER-TEST' rule collides with the bounded MULTI-run fixer evidence that BUG-211 itself requires — the harness should accept multiple FIXER-TEST citations, or the requirement must name exactly one canonical fixer test [provider-lock] and label the matrix legs as ADVERSARIAL/extra. — Round-7 FIX (harness only) 2026-09-29: the round-6 verify's one ungraded signal [matrix CLIENT 119/120, `pick=alias·openai·read=ok`] is SETTLED — an environment abort of the transcript read [Chromium net::ERR_NETWORK_CHANGED from host docker veth churn], NOT a client paint race; harness wait fixed, no product change; a contract-valid independent verdict is still required, so NOT VERIFIED stands. Round-6 fix built 2026-09-29 — NOT VERIFIED; matrix suite verify-bug-196-matrix.mjs 240 client cells + 134 wire frames + 20 fresh + 37 unit all green, must-FAIL red on a frozen round-5 copy; independent clean-room re-verify STILL REQUIRED — attempted round-6 verify TWICE on 2026-09-29 [dispatch anthropic/fable run 778cc092, then anthropic/claude-sonnet-5 run a06ef03c-b5a9-4b7f-bb34-e4324569b5d2], and BOTH returned contract-INVALID (independent-verify exit 3): each verifier ran real recorded adversarial + fixer runs and found NO substantive break [Sonnet: provider-lock 60/60 twice, matrix unit 390/390 + wire 134/134 exit 0, adversarial restart clean, adversarial race clean on the real run; Fable: its own adv suite 13/13], but NEITHER emitted a well-formed VERDICT/CLAIM/FIXER-TEST/ADVERSARIAL/UNTESTED citation block even after the one sanctioned corrective re-prompt, so no VALID verdict exists and NOT VERIFIED STANDS. The matrix CLIENT (browser) leg FATAL'd on a cleanroom page-boot timeout in BOTH runs [`page.waitForFunction` at boot — cleanroom infra, not the fix; unit+wire legs passed]. Isolation was CLEAN [0 foreign-ticket markers in added lines, tsc --noEmit 0, iso-tree provider-lock 60/60 pre-dispatch, full 185583-byte diff reached the verifier untruncated]. ONE UNGRADED IN-SCOPE SIGNAL: when the matrix CLIENT leg DID boot, exactly 1 cell failed per run (119/120), a DIFFERENT cell each run but ALWAYS the `pick=alias · openai · read=ok` signature — client shows providerView=null / #provBtn data-provider=unknown / no lock explanation while the SERVER is fully correct; reads as browser-timing flake (pin not painted when the assert fired) but the consistent alias-pick association is a weak hint alias cells settle slower — NOT cleanly graded, in-scope BUG-196 (not 205/206/208/209). NEXT STEPS handed to the orchestrator in the verify handoff (the fix-scope A/B was already resolved to option A in round 1 — this is a verify-process step, NOT a user-facing Decide card): (a) re-dispatch for a contract-valid verdict, telling the verifier the matrix client leg's browser-boot timeout is a known cleanroom-infra limit to cite as UNTESTED; (b) have a lane reproduce the matrix `pick=alias·openai·read=ok` cell OUTSIDE the cleanroom with a generous browser timeout to settle flake-vs-real before closing; (c) the repeated contract-INVALID from BOTH Fable and Sonnet may warrant a verifier-prompt/harness fix.) (Prior: round-5 verify BROKEN 2026-09-29, run e0c09c1c — a round-6 fix is required, NOT VERIFIED. The round-5 fix genuinely closes round-4's breaks [fixer suite 60/60 in the clean room], but the verifier found five NEW/adjacent breaks the suite never built: (1) an invalid model pick that EQUALS the project default model is dropped SILENTLY [no status, empty ignoredOverrides] because the override merge discards a pick equal to base before the announce block — both engine directions [IN SCOPE, req-3]; (2) the UI's built-in Claude aliases opus/sonnet/haiku aren't recognised as Claude models when no catalog exists, so an invalid alias pick is handed to Codex with no fallback [modelProviderOf matches only /^claude/]; (3) that alias defect is reachable through the real model popover after a failed transcript read; (4) a resume carrying provider "gemini"/null/"OpenAI" is still FATAL ["start.overrides rejected"] because validateSessionOverrides runs before the resume branch drops the provider [req-2 says whatever the client sends is never fatal — lower severity, current client never sends these]; (5) after a FAILED transcript read #provBtn is neither locked nor explained and shows the wrong engine [paintProvBtn keys on lockedSessionProvider() not providerSwitchRefusal()] while its own popover+drawer are correctly disabled. None are the out-of-scope BUG-205/206. Full diff 123247 bytes reached the verifier untruncated.) (Prior: round-5 fix built; round-4 verify BROKEN, run 43181ca6; round-4 fix built; rounds 1-3 verify BROKEN.)
- **Severity:** high
- **Area:** bridge / server (resume provider resolution) + UI (per-session provider indicator)
- **Reported:** 2026-09-29 by the user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED
  (session-lifecycle + provider routing — high-stakes; a clean-room dispatch pass is warranted).

> Redaction note: the real project name equals the user's account name equals the home-dir leaf,
> and the leak gate flags all three. Throughout this ticket the project is written `<proj>` and the
> encoded working dir `-home-<user>`; the real values are on the live registry/session store.

## Symptom
Verbatim (project name and home dir redacted to `<proj>` / `-home-<user>`):
"http://127.0.0.1:4317/#/project/<proj>/session/01a0e9d9-d340-7773-8a7f-ebb1b7061d73?dir=-home-<user>
eg this, it had openai as provider set, but then i changed to claude, yet i still keep
getting hit with limit out, its trying to still use openai, i tried reloading page, didnt help"

A session created on OpenAI (Codex) was switched to Claude in the UI. The UI reflects the switch,
but every turn the user sends still runs on OpenAI and hits the OpenAI rate limit. A page reload
does not help.

## Repro
Real session `01a0e9d9-d340-7773-8a7f-ebb1b7061d73`, project `<proj>`, dir `-home-<user>`.

1. Session was first launched on OpenAI, so its transcript lives at
   `<dataDir>/transcripts/openai/-home-<user>/01a0e9d9-….jsonl` (a Codex thread).
2. User switches the provider to Claude. This sets the project-level provider (registry `<proj>`
   `settings.provider = "anthropic"`, confirmed on disk) and/or the per-session client override
   (`localStorage['cs-overrides']`).
3. User sends a turn. The server builds a fresh bridge for the resume:
   `provider = s.provider ?? 'anthropic'` = **anthropic** (the user's choice), then the
   resume-from-transcript branch (`src/server/agent-bridge.ts:1273-1306`, FEAT-037 P2b) reads the
   transcript's provider directory, gets **openai**, and **overrides the user's choice back to
   openai** (`if (wanted !== provider) { provider = wanted; … }`). The turn runs on Codex/OpenAI
   and hits the OpenAI limit.
4. The override is announced only as a transient `status` event; nothing survives a reload, and the
   per-session provider indicator in the UI still shows Claude. From the user's seat the switch
   silently did nothing.

Proven from the real artifacts (no fixture):
- `resolveOrchardSessionFile('-home-<user>', '01a0e9d9-…')` → `{ provider: 'openai' }`.
- registry project `<proj>` `settings.provider` → `"anthropic"`.
- The two owners disagree; P2b resolves toward the transcript (openai) every resume.

## Root cause
A session's real, dispatchable provider is **owned by its transcript** — a Codex thread id can only
be continued by the Codex engine, and a Claude session file only by the Claude CLI. That ownership
fact is read in exactly ONE place, at the last moment inside the bridge (agent-bridge P2b), and is
applied **silently**. Every other surface — the project provider setting, the per-session provider
selector/indicator, the reload-persistent UI — is free to show and arm a provider the thread can
never honor. Two places hold a different answer for "which engine will this session's next turn run
on" (ARCH-010 violation): the UI/registry say Claude, the transcript says OpenAI, and dispatch
silently follows the transcript.

## The hard structural fact (why the naive fix is impossible)
This specific conversation **cannot be moved to Claude while keeping its history.** Resuming the
Codex thread requires the Codex engine; forking a Codex transcript is explicitly refused
(`agent-bridge.ts:5442-5448`, "forking a Codex session … is refused"). So there is no code change
that makes the user's existing turns go to Claude *for this thread*. The silent P2b override is not
itself wrong — it is what lets old OpenAI threads keep working after a project's default flips to
Claude. The defect is that it is **silent and contradicted by every UI surface**.

To actually run this work on Claude the user must **start a NEW session** (a fresh Claude thread);
carrying the OpenAI conversation's context into that new Claude session is exactly FEAT-120
("Hitting a provider limit strands the conversation on that engine").

## Expected
The system must never show or offer a provider a session's thread cannot honor, and must never
silently run a different engine than the one the user believes is selected. For a thread-locked
session the UI should show its real engine (OpenAI Codex here) and explain that switching to Claude
requires a new session — mirroring the refusal the provider selector already gives for a *live*
session (`public/app.js:3469`: "the engine is fixed for a running session — start a new session to
switch"), extended to a resumable-from-disk session whose transcript pins the engine.

## Decision — how far to fix, given the switch cannot move THIS thread

- **A — honesty fix only (no context carry).** Make the transcript-owned provider the one fact every
  surface reads (ARCH-010): the per-session provider indicator shows the session's REAL engine, and
  the provider selector is disabled + explained ("this conversation runs on OpenAI Codex — start a
  new session to use Claude") for any session that already has a provider-locked transcript, exactly
  like the existing live-session refusal. Server keeps continuing old threads on their own engine
  (unchanged behavior) but the UI can no longer imply the switch took effect. Cheap, no product
  build. Does NOT get the user's work onto Claude — they still must start a new session by hand and
  re-establish context themselves. Touches `public/app.js` (already dirty in-tree) + likely a small
  server field exposing the session's transcript-owned provider to the client.
- **B — honesty fix PLUS context carry (do A, then FEAT-120).** In addition to A, offer "continue
  this on Claude" that opens a NEW Claude session seeded with the OpenAI conversation's context
  (FEAT-120's whole domain). Delivers what the user actually wants — the work moves to Claude — but
  it is a feature build, not a bug fix, and should be scoped under FEAT-120 rather than here.

## Context pack
- Files/functions in play:
  - `src/server/agent-bridge.ts:1250` (`provider = s.provider ?? 'anthropic'`), `:1273-1306`
    (FEAT-037 P2b resume-from-transcript override — the silent clobber), `:1390` (provider→binary),
    `:5442-5448` (Codex fork refusal).
  - `src/server/orchard-transcripts.ts` `resolveOrchardSessionFile` (transcript→provider, the
    ownership authority) — returns `openai` for this session.
  - `src/server/registry.ts:43-45` `providerOf` / `ProjectSettings.provider` (project default =
    `anthropic`).
  - `public/app.js:3469` `pickProvider` (already refuses on a LIVE session; the model to extend),
    `:56` `SESSION_OVERRIDABLE` (provider is a per-session override), `:2997-2999` (how the UI picks
    the displayed provider — reads project/override, NOT the transcript).
  - `src/server/session-config.ts` — write-once advisory record; shows `provider:"openai"` for this
    session (display only, not read at dispatch).
- Related tickets: FEAT-120 (context carry across engines — the real want), FEAT-037 (P2b override
  origin), FEAT-045 (provider as per-session override), FEAT-139 (moved provider selector into
  Settings).
- Repro: real-artifact check above; a `verify:bug-196` script should assert the invariant
  (transcript-owned provider is what the UI shows AND what dispatch uses, with no silent divergence).
- Known dependencies: fix contends on `public/app.js`, which already has uncommitted changes
  (BUG-194/BUG-195) — serialize.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — finding/diagnosis lane (Opus 4.8)
- **Understood:** Confirmed the hypothesis, then found the naive fix is structurally impossible.
  The provider switch DOES reach the dispatch path's initial `provider` value, but the FEAT-037 P2b
  resume-from-transcript branch (`agent-bridge.ts:1273-1306`) silently overrides it back to the
  transcript's engine on every resume. The user's session `01a0e9d9-…` is a Codex/OpenAI thread
  (`transcripts/openai/-home-<user>/…`), so every turn is forced onto OpenAI regardless of the
  Claude selection, hitting the OpenAI limit. The override is announced only as a transient status
  event, so a reload shows no trace and the per-session provider indicator keeps showing Claude.
- **Verified (must-FAIL / current broken state, real artifacts, no fixture):**
  - `resolveOrchardSessionFile('-home-<user>','01a0e9d9-…')` → `{ provider: 'openai' }` (PASS: the
    transcript pins OpenAI).
  - registry project `<proj>` `settings.provider` → `"anthropic"` (PASS: the user's choice is stored).
  - Therefore P2b (`wanted='openai' !== provider='anthropic'` → `provider='openai'`) forces every
    resume onto OpenAI while the UI/registry say Claude — the divergence reproduced.
  - Continuing this thread on Claude is impossible: resume needs the Codex engine; Codex fork is
    refused at `agent-bridge.ts:5442-5448`.
- **Not changed:** No code changed. No live data changed (read-only on the live session). The
  charter's implied demonstration ("switch to claude, send a turn, assert the turn went to Claude
  for THIS session") is structurally impossible, so per the charter I stopped before building and
  filed the direction fork above (A vs B).
- **User action required:** The user's existing session `01a0e9d9-…` cannot be moved to Claude with
  its history — it is a Codex thread. To run this work on Claude they must **start a new session**
  (project `<proj>` now defaults to Claude, so a new session will correctly be Claude). Carrying the
  OpenAI conversation's context into that new session is FEAT-120.
- **Still open / handoff:** Needs the A/B decision. On A: extend the live-session provider refusal
  (`app.js:3469`) to any transcript-locked session, and make the per-session provider indicator read
  the transcript-owned provider (add a server field) so no surface can imply a switch that dispatch
  won't honor. On B: A plus FEAT-120's seed-into-new-session. Fixer must serialize on `public/app.js`
  (BUG-194/195 uncommitted there). A must-FAIL/PASS `verify:bug-196` should assert: the provider the
  UI SHOWS for a session equals the transcript-owned provider, and equals the provider dispatch will
  use — no silent divergence.
- **Symptom of a deeper design flaw?** Likely yes — the transcript-ownership fact is declared in one
  place but read only at the last dispatch moment and applied silently, while every UI surface
  re-derives a provider from the project/override (ARCH-010: a second place holds a different
  answer). If the fixer confirms, file an ARCH ticket. (Not filed now — left to the fix lane's close.)

### 2026-09-29 — fixing lane, round 1 (option A, Opus 4.8)
- **Hypothesis re-confirmed against live code (before any change):** `agent-bridge.ts` still forced the
  transcript's provider on resume — the P2b loop over `resolveOrchardSessionFile` (was ~:1280-1293)
  set `wanted='openai' !== provider='anthropic'` → `provider='openai'`, silently, on every resume;
  and the UI's `providerView()` (public/app.js) read `dockEffective()?.provider ?? state.overrides
  .provider ?? project.settings.provider` — never the transcript. The two owners disagreed exactly as
  filed. Proceeded with option A per the orchestrator's decision (B / FEAT-120 explicitly out of scope).
- **Built (ARCH-010: one owner declares the fact, every reader reads it):**
  - `src/server/orchard-transcripts.ts` — new `resumeProviderOf(dirCandidates, sessionId)`: the SINGLE
    owner of "which engine does this session's next turn resume on" — a transcript names its engine by
    its provider directory; no Orchard-owned transcript ⟹ Claude store ⟹ `'anthropic'`.
  - `src/server/agent-bridge.ts` — P2b now CALLS `resumeProviderOf` instead of re-deriving the loop
    inline (behaviour identical; the derivation is no longer duplicated).
  - `src/server/index.ts` — the transcript route (tail AND page branches) now returns
    `lockedProvider: resumeProviderOf([encodedDir], sessionId)`, so the client reads the SAME answer
    dispatch will use rather than re-deriving one the resume ignores.
  - `public/app.js` — `openSession` records the server-declared `state.current.lockedProvider`; new
    `lockedSessionProvider()` (null for pending-new / foreign dock) + `lockedProviderExplain()`;
    `providerView()` reads the locked engine before project/override; `pickProvider()` REFUSES a switch
    for a locked session (mirroring the live-session refusal); `paintProvBtn`/`paintProvPop` show the
    real engine, disable the options, and carry the explanation; `paintIntegrations` reads the locked
    engine so a resumable Codex session shows "MCP off". Edited AROUND the uncommitted BUG-194/195 work.
  - `public/lib/drawer.js` — the Settings ▸ Model & spend ▸ Provider control (session scope) reads the
    same `ctx.lockedProvider()`, disables the segment, and shows the same explanation.
- **Verified — must-FAIL-before / PASS-after, REAL headless browser (Brave) + REAL server on a free
  port + isolated stores + a REAL on-disk OpenAI transcript under a project whose default is Claude:**
  `node scripts/verify-bug-196-provider-lock.mjs` → **10/10**. Covers: server declares
  `lockedProvider=openai` for the artifact; MUST-FAIL (synthesized pre-fix, `lockedProvider` forced
  null) → session reads as anthropic with a switchable selector (the silent divergence); FIXED →
  `providerView()==='openai'`, popover options DISABLED, explanation present ("start a new session to
  use Claude"), `pickProvider('anthropic')` refused (view unchanged, no override armed); CONTROL → a
  fresh (pending-new) session is not locked, defaults to Claude, and `pickProvider('openai')` still
  arms the override. `npx tsc --noEmit` clean.
- **Scope note:** This is the HONESTY fix only. The user's existing Codex thread STILL cannot run on
  Claude with its history — to move the work they must start a new session (FEAT-120 = context carry).
- **High-stakes:** session-lifecycle + provider-routing change; suite written by the building lane.
  Independent clean-room verify is WARRANTED before VERIFIED.
- **ARCH follow-up:** the deeper-flaw suspicion is CONFIRMED and this fix is its concrete remedy for
  the provider fact (one owner `resumeProviderOf`, read by dispatch + every UI surface). A general ARCH
  ticket for the class was NOT filed here (this instance is settled); left to the board owner.
- **Not done (no authority):** no git writes — all files left unstaged for the user; `board:gen` was
  run after the ticket/INDEX edits.

### 2026-09-29 — independent clean-room verify lane, round 1 (verify class, Opus 4.8)
- **Verified-by:** dispatch anthropic run b5d4823a-6955-4625-b85d-aa005445b6a9 (clean-room
  `cleanroom-verify-IshUmF`, `scripts/independent-verify.mjs`, isolated BUG-196-ONLY diff on a
  file-copy scratch tree, SAME-PROVIDER — decorrelation reduced; OpenAI 5h window was EXHAUSTED
  at dispatch time so cross-provider was impossible, `npm run usage` confirmed 100% used / resets
  ~2.1h) — **VERDICT: BROKEN** (contract VALID, manifest-backed).
- **Isolation (charter: verifier sees ONLY BUG-196 hunks).** Built a scratch tree = HEAD + BUG-196
  hunks only. The 3 server files (`orchard-transcripts.ts` `resumeProviderOf`, `agent-bridge.ts`
  P2b, `index.ts` `lockedProvider`) are entirely BUG-196 and were taken whole; `public/app.js` and
  `public/lib/drawer.js` were hunk-filtered to keep only the BUG-196 hunks and drop FEAT-154
  (isSessionRunning/`working`), BUG-194 (projectHitRow→startNew), BUG-195 (session-init refetch) and
  FEAT-155 (GPU/MEM_CYCLE). Confirmed the scratch UI files differ from the live tree ONLY by those
  excluded hunks. The fixer's test `verify-bug-196-provider-lock.mjs` was placed in the room.
- **Fixer test re-run:** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0, **10/10**
  (manifest 25586e664fc8). The reported flow (reopen an existing OpenAI session; reload onto the
  session URL) is genuinely fixed: verifier confirmed reload-on-URL locks to openai and refuses.
- **BROKEN — the adversarial case the fixture never builds (manifest 72542763a9a9, exit 1):** a
  session begun as NEW in the tab that then runs its first turn. session-init gives it a real id and
  an OpenAI transcript; the server correctly returns `lockedProvider=openai`, but the UI shows
  **anthropic** and `pickProvider('anthropic')` is **accepted** — the exact silent divergence this
  ticket exists to kill, reached by a different entry path than the reported one.
- **Corroborated STATICALLY by this lane (so the same-provider caveat does not weaken it):**
  `lockedSessionProvider()` (`public/app.js:12821`) does `if (state.pendingNew) return null;`;
  `state.pendingNew` is set only by `startNew` (`:8158`) and cleared only by `openSession` (`:5566`);
  `state.current.lockedProvider` is populated only by `openSession`'s transcript-tail fetch
  (`:5632`). The `session-init` onEvent handler (`:~10992`) sets `state.current.sessionId` but
  neither clears `pendingNew` nor fetches the transcript — so a new-session-that-ran-a-turn keeps
  `pendingNew` set AND `lockedProvider` null, and `lockedSessionProvider()` returns null → every
  BUG-196 surface (`providerView`, `paintProvBtn/Pop`, `pickProvider`, `paintIntegrations`, drawer)
  falls back to project/override. Fix's own claim "every UI surface reads the transcript-owned
  provider" is therefore NOT met for this surface. Present in the LIVE tree too (which carries BUG-195).
- **Verifier's own could-not-test (honest):** no real Codex/Claude turn (no engine/creds in the
  sandbox — session-init was simulated by setting id/encodedDir as `app.js` does); did not run the
  server-side P2b resume (only showed the transcript route returns the same resolver's answer); did
  not exercise a transcript that exists only in a SECONDARY dir candidate (route resolves with
  `[encodedDir]` only while the bridge checks all candidates — a latent divergence worth a round-2
  probe); did not render the drawer session-scope group; paged/refresh transcript fetches do not
  update `lockedProvider`.
- **BUG-106 attribution check (charter part 4, done by THIS lane on file-copy scratch trees, not
  dispatched): the fixer's claim that `verify-bug-106-crossproject-strip` fails due to uncommitted
  BUG-194 work (not BUG-196) is REFUTED.** `node scripts/verify-bug-106-crossproject-strip.mjs`
  fails IDENTICALLY ("timed out waiting for both project headers after 20000ms" → TypeError at
  `:181`) on ALL FOUR trees: live dirty tree; live MINUS BUG-196 hunks; live MINUS BUG-194 hunk; and
  **clean HEAD with no uncommitted work at all**. Because it fails at HEAD, it is a PRE-EXISTING
  failure (broken test / environment — neighbor-project header does not render in this happy-dom
  environment) and is attributable to NEITHER BUG-194 NOR BUG-196.
- **Decision for the orchestrator:** (A) the fix ships the reported-flow honesty correctly but is
  INCOMPLETE per its own ARCH-010 claim — round 2 should route the new-session-becomes-real path
  through the same locked-provider fact (clear `pendingNew` and/or fetch+set `lockedProvider` when
  session-init makes a pending-new session real, and stop gating `lockedSessionProvider()` on
  `pendingNew` once a real transcript exists); OR (B) split the new-session-after-turn surface into a
  follow-up if it is judged out of scope for the reported bug. Fix left UNTOUCHED per charter.
- **High-stakes flag:** session-lifecycle + provider-routing; this verdict is BROKEN (fix incomplete),
  so no clean-clean-room re-verify is needed until a round-2 fix exists — but the round-2 verify should
  be run CROSS-PROVIDER (openai) once its 5h window resets, since this pass was same-provider.
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` run
  after the edit. Scratch artifacts (kept clean room + variant trees) under
  `~/.local/state/claude-station/scratch/` for audit.

### 2026-09-29 — fixing lane, round 2 (option A completion; entry paths beyond reopen; Opus 4.8)
- **Refutation re-confirmed against live code before any change:** round 1 wired `lockedProvider`
  only through `openSession`'s transcript-tail fetch. The `session-init` onEvent handler
  (`public/app.js`) set `state.current.sessionId` but never cleared `state.pendingNew` and never
  recorded `lockedProvider` — so a session made real by its FIRST TURN (new-session-first-turn), and
  a reattach, both kept `pendingNew` set + `lockedProvider` null. `lockedSessionProvider()` returned
  null (it gates on `pendingNew`), and every provider surface (`providerView`, `paintProvBtn/Pop`,
  `pickProvider`, drawer) fell back to project/override and ACCEPTED a switch the resume ignores —
  the exact silent divergence, reached by a different entry path than the reported reopen.
- **Root-design choice (ARCH-010, justified):** the reported flow learned the locked engine from a
  transcript READ; that is one reader among several. Rather than add a second reader (fetch the
  transcript again at session-init), the OWNER now declares the fact on the event that makes a
  session real. The bridge KNOWS the engine it dispatched on (`this.effective.provider`, set from
  project ∘ override ∘ any resume flip), so it now declares it once on `session-init.lockedProvider`.
  Every "session becomes real/current" path — openSession (transcript tail), first-turn session-init,
  reattach session-init — carries the SAME answer `resumeProviderOf` returns on the next reopen. No
  new per-surface patch; the surfaces already read `lockedSessionProvider()`.
- **Built (BUG-196 hunks; edited around the uncommitted BUG-194/195/FEAT-154/155 hunks):**
  - `src/server/events.ts` — `session-init` event type gains `lockedProvider?: string`.
  - `src/server/agent-bridge.ts` — after the P2b resume block, declare the final resolved engine once
    on `this.effective.provider`; emit `lockedProvider: this.effective.provider ?? 'anthropic'` on the
    `session-init` frame.
  - `src/server/index.ts` — the reattach `session-init` frame emits
    `lockedProvider: String(live.effective?.provider ?? 'anthropic')`.
  - `public/app.js` — the `session-init` handler records `state.current.lockedProvider` from the event
    and clears `state.pendingNew` (a running session is no longer a switchable pending-new view;
    `pendingNewFor` already treats an id-carrying session as real), then repaints prov surfaces. `onEvent`
    exposed on `window.__station` for the browser suite to drive the real live-event path.
- **Verified — must-FAIL-before / PASS-after, REAL headless Brave + REAL server on a free port +
  isolated stores + a REAL on-disk OpenAI transcript (case a/reopen) and a REAL Claude-store
  transcript under an OpenAI-default project (case d):** `node scripts/verify-bug-196-provider-lock.mjs`
  → **17/17** (was 10/10). New cases: (a) new session → `onEvent(session-init, lockedProvider=openai)`
  → `providerView`/`lockedSessionProvider`='openai', `pendingNew` cleared, `pickProvider('anthropic')`
  refused; (b) the round-1 reopen/reload cases stay green; (c) fresh unstarted session stays
  switchable; (d) an anthropic thread under an openai-default project locks to 'anthropic', shows
  Claude, and refuses the switch to OpenAI (the reverse — guards against merely inverting the bug).
  Non-vacuity proven: neutering the two client session-init lines reddens both FIXED(a) checks
  (15/17) and leaves the rest green. `npx tsc --noEmit` clean; `npm run gate` exit 0.
- **Scope note:** still the HONESTY fix (option A). The user's existing Codex thread STILL cannot run
  on Claude with its history — moving the work is FEAT-120 (context carry).
- **High-stakes:** session-lifecycle + provider-routing; suite written by this building lane.
  Independent clean-room re-verify WARRANTED before VERIFIED, and should be run CROSS-PROVIDER
  (openai) once its 5h window resets — round 1 was same-provider by necessity.
- **Filed:** BUG-197 for the pre-existing `verify-bug-106-crossproject-strip` failure at clean HEAD
  (neighbor-project header never renders in happy-dom) — confirmed still failing on the current tree;
  not fixed (out of scope). INDEX row authorised by the charter.
- **Not done (no authority):** no git writes — all files left unstaged for the user; `board:gen` run
  after the ticket/INDEX edits.

### 2026-09-29 — independent clean-room verify lane, round 2 (verify class, Opus 5)
- **Verified-by:** dispatch anthropic/claude-opus-5 run 6b0b428c-3937-4326-b253-1dca2ec29bcf
  (clean-room `cleanroom-verify-S0tZLo`, `scripts/independent-verify.mjs --working-tree` over an
  isolated BUG-196-ONLY tree; contract VALID, manifest-backed, 8 recorded runs) — **VERDICT: BROKEN.**
  DECORRELATION: same PROVIDER but DIFFERENT MODEL from the fixer (verifier Opus 5 vs fixer Opus 4.8) —
  cross-provider (openai) was impossible at dispatch time: `npm run usage` showed the OpenAI 5h window
  100% used (EXHAUSTED, resets ~1.6h), so per the charter fallback the verifier ran anthropic on a
  different model. Reason recorded here so the same-provider caveat is explicit.
- **Isolation (verifier saw ONLY BUG-196 hunks).** Built a scratch tree = HEAD + BUG-196 hunks only:
  the 6 touched files were rebuilt from HEAD by reverse-applying every NON-BUG-196 hunk (signature
  filter: a hunk is BUG-196 iff it mentions `BUG-196|resumeProviderOf|lockedProvider|lockedSessionProvider|lockedProviderExplain`),
  dropping FEAT-154 (isSessionRunning `working`), BUG-194 (projectHitRow→startNew), BUG-195
  (session-init `refreshCurrentProjectSessions`) and FEAT-155 (containerStoreDirName/storeEncodedDir/
  workspaceRoot/gpuRow/wsRootRow/MEM_CYCLE/declaredContainerStore). The one MIXED hunk
  (agent-bridge dirCandidates) had its FEAT-155 line reverted to HEAD (`encodeCwd(containerWorkdir(opts.project.id))`)
  by hand, keeping the BUG-196 `resumeProviderOf` call. Confirmed the isolated diff carries 109
  BUG-196 added lines and ZERO excluded-ticket markers; `npx tsc --noEmit` clean on the isolated tree.
  Verified independently by grep + by independent-verify's own 47 KB diff (BUG-196 only). CLAUDE.md/
  AGENTS.md/.claude untracked (absent from the room); docs/prompts + docs/bugs stripped.
- **Fixer test re-run:** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0, **17/17**
  (manifest 3b8bfb63977b). The reported flow and every entry path the round-2 fix targeted (reopen,
  reload-on-URL, new-session-first-turn via a synthetic session-init frame, reattach frame, and the
  reverse anthropic-under-openai case) are genuinely fixed.
- **BROKEN — the adversarial case the suite never builds (foreign-project selection while a lock is open):**
  with the transcript-locked OpenAI session STILL open in the dock, a single click on ANOTHER project's
  row in the sidebar makes `dockIsForeign()` true, so `lockedSessionProvider()` (public/app.js:~12812)
  returns null and the lock evaporates:
  - run a618685212ce (exit 1, 4/7): `providerView()` falls back to `anthropic` (indicator now shows
    Claude for a session whose transcript pins OpenAI); the popover repaints with ENABLED options and
    an EMPTY explanation while `#provBtn[data-locked]` is left stale `true` (button and popover
    contradict — paintProvBtn/paintProvPop are not re-run consistently on a project switch);
    `pickProvider()` is no longer refused.
  - run fe3a39b464a8 (exit 1, 4/7): worse — with the OTHER project defaulting to OpenAI, picking
    "Claude" on that path ARMS `state.overrides.provider='anthropic'` AND `persistOverrides()` writes
    it under the LOCKED session's OWN key `"<encodedDirA> <openai-session-id>"`, so the Codex session
    now carries a persisted Claude override that `restoreOverrides()` re-arms on every reopen — the
    exact silent divergence this ticket exists to kill, made durable across reloads, reached by the
    project-switch entry path the round-2 fix did not cover.
- **Verifier's own could-not-test (honest):** no REAL first-turn / reattach against a live engine
  (would spend the user's real Claude/Codex quota in a cleanroom — not done), so `this.effective.provider`
  reaching `session-init` from an actual bridge start was never observed end-to-end (only via a synthetic
  onEvent frame); reattach-after-server-restart (ws `reattach` frame, index.ts:~4236) sits behind that
  live dispatch; the SECONDARY-dir-candidate asymmetry (route resolves `resumeProviderOf([encodedDir])`
  with ONE dir while agent-bridge resolves over three — resume/host/container) was not exercised on a
  real container project; fork/clone of a locked session was not exercised.
- **Decision for the orchestrator:** round 3 must route the foreign-project-selection path through the
  same locked-provider fact. The lock currently dies because `lockedSessionProvider()` gates on
  `dockIsForeign()` — but a session's transcript-owned engine does not change just because the sidebar
  selection moved. Options for the fixer to weigh: read the lock from the OPEN session's own identity
  (state.current) independent of `dockIsForeign`, and/or re-run paintProvBtn+paintProvPop consistently
  on a project switch so the button/popover never contradict, and/or refuse pickProvider whenever the
  OPEN dock session is transcript-locked regardless of sidebar selection. Fix left UNTOUCHED per charter.
- **High-stakes flag:** session-lifecycle + provider-routing + data-persistence (a wrong override
  persisted to disk). This verdict is BROKEN (fix incomplete), so no clean-clean-room re-verify is
  needed until a round-3 fix exists — but the round-3 verify should be run CROSS-PROVIDER (openai) once
  its 5h window resets, since rounds 1 and 2 were both same-provider (round 2 mitigated with a different
  model).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen`/
  `board:check` run after the edit. Kept clean room + record dir under
  `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-S0tZLo /
  cleanroom-record-qEwGSZ), plus the isolated tree at `bug196-iso-BSGRGR`.

### 2026-09-29 — fixing lane, round 3 (design change: the lock is keyed by SESSION ID; Opus 5)
- **Hypothesis verified FIRST (before any edit), against live code — CONFIRMED.** The lock lived on
  transient view state (`state.current.lockedProvider`) and its one reader `lockedSessionProvider()`
  returned null on two VIEW predicates (`state.pendingNew`, `dockIsForeign()`). But the session every
  provider surface ACTS ON does not change with the view: with a foreign dock, `submit()` still resumes
  `state.current.sessionId` (A's session — `startTurn({resumeSessionId})`), `persistOverrides()` still
  writes under `"<A encodedDir> <A id>"`, and the drawer's session scope still edits `state.overrides`
  for that same id. So "the dock is foreign" never made the session unlocked — it only made the lock
  unreadable. Also found: `selectProject()` → `paintCrown()` repainted `paintProvSel` but never
  `paintProvBtn`, and `paintProvBtn` returned before writing `data-locked` when hidden — the stale
  attribute the round-2 verifier saw.
- **Design (ARCH-010 — declared by the owner, read by id; no fourth view guard).**
  - Client: one store `lockedProviders` (Map sessionId → engine). WRITTEN ONLY by
    `declareLockedProvider(id, provider)` from the two server declarations; READ ONLY through
    `lockedProviderOf(id)`. `lockedSessionProvider()` is now just `lockedProviderOf(state.current.sessionId)`
    — the pendingNew and dockIsForeign gates are gone (a pending-new view has no id, so it is unlocked
    by construction). The tail's declaration is recorded BEFORE the BUG-087 scope guard, since a fact
    about an id stays true whatever is on screen when it lands.
  - Persistence cannot hold a wrong answer: `persistOverrides()` (the one `cs-overrides` writer) strips
    `provider` for a pinned id; `restoreOverrides()` drops it; `sessionOverrides()` never sends it; and
    `declareLockedProvider()` HEALS any `provider` already persisted under that id (other armed fields
    kept) and clears it from memory.
  - Server: new `resumeDirCandidates(project, resumeEncodedDir)` (agent-bridge.ts) is the ONE dir list;
    P2b now calls it, and a new door check in the ws `start` handler (index.ts, right after
    `validateSessionOverrides`) REFUSES (`start.overrides rejected: … runs on <engine> …`, fatal) any
    `overrides.provider` that contradicts `resumeProviderOf(resumeDirCandidates(...), id)`. Judged only
    when a transcript for the id exists in one of those dirs (an unimported native-Codex id / unknown id
    is left to the resume's own vetting); an override EQUAL to the pin is accepted.
  - Repaint: `paintProvSurfaces()` repaints `#provBtn`, the header twin and the OPEN popover together;
    called from `paintCrown()` (every selection change) and `declareLockedProvider()`. `data-locked` is
    written before the hidden early-return.
- **Reader / writer inventory (every one now resolves by session id from the one declared source).**
  - *Owner (server):* `resumeProviderOf(dirCandidates, id)` (orchard-transcripts.ts) over
    `resumeDirCandidates` (agent-bridge.ts). Declarations to the client: transcript route tail + page
    branches `lockedProvider` (index.ts); `session-init.lockedProvider` = bridge `this.effective.provider`
    after P2b (agent-bridge.ts); reattach `session-init` = `live.effective.provider` (index.ts).
  - *Server readers:* agent-bridge P2b (resume engine); index.ts start-frame door check (NEW, refuses a
    contradicting override). `PATCH /api/sessions/:id` cannot carry `provider` at all
    (`validateSessionPatch` → 400 unknown field — asserted). Not per-session facts, untouched: registry
    `settings.provider` (project DEFAULT for future sessions, `PATCH /api/projects`); `session-config.ts`
    `provider` (write-once advisory display, not read at dispatch).
  - *Client pin writers:* `declareLockedProvider` ← openSession transcript tail; ← `session-init` handler.
  - *Client pin readers (by id):* `lockedSessionProvider()` → `providerView()`, `paintIntegrations()`,
    `sessionOverrides()`, `paintProvBtn()`, `paintProvPop()`, `pickProvider()` (refuses), drawer
    `ctx.lockedProvider` → `providerGroup()` (disables session scope); `persistOverrides()` /
    `restoreOverrides()` read `lockedProviderOf(<their own key id>)`. Via `providerView()`:
    `paintProvSel`, `paintModelChip`, `activeModelOpts`, `paintAccountSel`, the Codex model fetches,
    the lane-engine line and the model-pop hint.
  - *Per-session provider OVERRIDE writers:* `pickProvider` (refuses when pinned); drawer
    `providerGroup` put/delete (disabled when pinned; its in-memory write can no longer persist or be
    sent); `restoreOverrides` (drops when pinned); `selectProject`/`startNew` (clear all);
    `declareLockedProvider` (deletes + heals storage). Persisted by `persistOverrides` only; sent by
    `sessionOverrides` only.
- **Verified — must-FAIL-before / PASS-after, REAL headless Brave + REAL server on a free port +
  isolated stores + REAL on-disk transcripts:** `node scripts/verify-bug-196-provider-lock.mjs` →
  **33/33** (was 17/17). Against the ROUND-2 code (before any round-3 edit) the new cases ran
  **23/31, exit 1** — the 8 failures were exactly the verifier's break: after a real sidebar click on
  project B `#provBtn[data-locked]=false`, popover options ENABLED with no explanation, a Claude click
  ACCEPTED and PERSISTED `{"provider":"anthropic"}` under the locked key, every B leg of the A↔B
  shuttle unlocked + persisting, a seeded wrong override NOT healed on reopen, and both server
  start-frame probes answered `nothing-to-reattach` (accepted). New cases: (e) the round-2 break —
  open the OpenAI-pinned session, real click on another project (default OpenAI, the worst case),
  then indicator, popover (opened by a real click), button/popover agreement, and a Claude pick
  graded against the persisted `cs-overrides` entry; plus an in-suite SYNTHESIZED must-FAIL (pin
  removed from the store under the foreign view → the pick is accepted and persisted) and its heal
  on re-declaration; (f) A↔B clicked five times, every leg locked with button and popover agreeing
  and nothing persisted; (g) a wrong override seeded exactly as the round-2 path wrote it
  (`{provider, permissionMode}`) is healed on reopen — provider gone, permissionMode kept; (h) server
  refuses `start{resumeSessionId, overrides.provider}` contradicting the pin (both directions), accepts
  a matching one (control → `nothing-to-reattach`), and `PATCH /api/sessions/:id {provider}` → 400.
  Prior-case probes that read the retired `state.current.lockedProvider` now read `lockedProviderOf(id)`
  (same assertions; the round-1 synthesized must-FAIL now removes the id's entry from the store).
  `npx tsc --noEmit` exit 0; `npm run gate` exit 0 (unpiped).
- **Real user data (item 3) — backed up, inspected, NOT mutated.** The per-session override store is
  the browser's `localStorage['cs-overrides']`. Copied both Brave profiles' Local Storage leveldb to
  `~/.local/state/claude-station/scratch/bug196-r3-lsbackup-20260929T014229/` and read the copy in a
  headless Brave (all requests routed to a blank page, so the live app never ran): Default profile
  **64 entries, 0 carry `provider`**; the user's session `01a0e9d9-…` holds only
  `{"permissionMode":"bypassPermissions"}`; Profile 1 has 0 entries. So the round-2 bug path never
  persisted a wrong override on the user's real data — nothing to clean. Should one exist in any other
  browser, the shipped heal removes it the next time that session is opened (case g). The live
  browser profile was not written.
- **Anti-regressions run (honest):** `verify-bug-195-new-session-nav` 6/6. Three suites were already red
  for reasons outside the resume path this round touches: `verify-orchard-transcripts` (a fresh start —
  no `resumeSessionId` — dies with `codex app-server spoke a non-JSON frame: "OCI runtim…"`; new
  scratch projects register as container-isolated on this machine, so the fake Codex binary is exec'd
  inside a container); `verify-provider-picker` 14/16 (the fresh-start real-turn check, plus
  `runtime check pending` on the launch-fails-fast check); `verify-feat-145-session-override` 33/34
  (docker container set changed because another lane created `claude-station-f155live-beed` mid-run).
  None of them reaches the door check (which needs `resumeSessionId`) or `resumeDirCandidates` (resume
  only). That attribution is BY CODE PATH — I did not re-run them on a pre-round-3 tree.
  Containers my runs left behind (`claude-station-orchard`, `-codex-real`, `-codex-fake`, a probe) were
  confirmed by their `/tmp` scratch mounts and removed; the other lane's containers were not touched.
- **Could not test / left open:** no real engine turn (the start-frame probes are promptless, so
  nothing spawns); the transcript ROUTE still resolves over `[encodedDir]` alone (it has no project in
  its URL), while the bridge and the door check use `resumeDirCandidates` — the same latent asymmetry
  both verifiers named, unexercised on a real container project. The fork-refusal dir list in
  `startSession` (a FEAT-155-dirty hunk) is a second copy of `resumeDirCandidates` I left alone so I
  would not entangle that hunk — worth folding in when FEAT-155 lands.
- **Adjacent defect found, NOT fixed (out of scope, other override fields):** `selectProject()` clears
  ALL of `state.overrides` while the dock's subject session stays A. Any later `persistOverrides()` from
  the foreign view then writes that empty map under A's key and erases A's armed non-provider overrides
  (e.g. `permissionMode`). The provider can no longer be hit (it is pinned), but the same
  view-vs-session confusion applies to the other fields. Worth its own ticket.
- **regressed-from / rework:** rounds 1 and 2 of this ticket (the view-state design); no other ticket.
- **High-stakes:** session lifecycle + provider routing + persisted data, in a file with a regression
  history. An INDEPENDENT clean-room re-verify is WARRANTED before VERIFIED, cross-provider (openai)
  when its window allows. Suggested attacks: any view state that changes `state.current.sessionId`
  without a declaration (fork staging, `resumeOnNextSend`, subagent views); a second tab.
- **Hunks (all marked `BUG-196 round 3`; edited around the BUG-194/195 and FEAT-154/155 hunks):**
  `public/app.js` (pin store + declare/heal, persist/restore guards, openSession tail, session-init,
  lockedSessionProvider, paintProvSurfaces + paintProvBtn data-locked, sessionOverrides, paintCrown
  call, `__station` exports); `src/server/agent-bridge.ts` (`resumeDirCandidates` + P2b call);
  `src/server/index.ts` (import + start-frame door check); `scripts/verify-bug-196-provider-lock.mjs`
  (cases e–h + in-suite synthesized must-FAIL; probe reads moved to the id-keyed store).
  `public/lib/drawer.js` is unchanged — it already reads `ctx.lockedProvider()`, which is now keyed by id.
- **Not done (no authority):** no git writes; `board:gen` run after this entry.

### 2026-09-29 — independent clean-room verify lane, round 3 (verify class, Opus 4.8 orchestrating; verifier Opus 5)
- **Verified-by:** dispatch anthropic/claude-opus-5 run 900d9e94-adc5-4f81-9847-6bda9be240fd
  (clean-room `cleanroom-verify-HIRIAX`, record `cleanroom-record-f3kRny`, `scripts/independent-verify.mjs
  --working-tree` over an isolated BUG-196-ONLY tree; contract VALID, manifest-backed, 3 recorded runs) —
  **VERDICT: BROKEN.** DECORRELATION LIMITATION: SAME provider AND same model as the round-3 fixer
  (both anthropic/claude-opus-5) — cross-provider (openai) was impossible: `npm run usage` at dispatch
  showed the OpenAI 5h window 100% used / EXHAUSTED (resets ~1h), so per the charter fallback the verifier
  ran anthropic/claude-opus-5. The verifier still found two NEW breaks, so the correlation did not blind it.
- **Isolation (verifier saw ONLY BUG-196 hunks).** Built HEAD + BUG-196-only tree by restoring all 25
  (then 93, as concurrent lanes grew the dirty set) dirty tracked files to HEAD via `git show` and applying
  ONLY the signature-matched BUG-196 hunks with `patch` (git writes are blocked for agents, so no
  checkout/apply). Signature: `BUG-196|resumeProviderOf|lockedProvider|lockedSessionProvider|lockedProviderExplain|lockedProviders|declareLockedProvider|lockedProviderOf|resumeDirCandidates|paintProvSurfaces`.
  Zero MIXED hunks; the one FEAT-155 symbol entanglement (`containerStoreDirName(project)` inside BUG-196's
  new `resumeDirCandidates`) was reverted to the HEAD form `encodeCwd(containerWorkdir(project.id))` by hand.
  Verified: 311 BUG-196 added lines across the 6 files, ZERO excluded-ticket markers in any added line
  (BUG-194/195/FEAT-154/155/156, containerStoreDirName/declaredContainerStore/workspaceRoot/etc), `tsc
  --noEmit` exit 0 on the isolated tree. independent-verify stripped CLAUDE.md/AGENTS.md/.claude/docs/bugs/
  docs/prompts (confirmed in its cleanroom report). 6 files: public/app.js, public/lib/drawer.js,
  agent-bridge.ts, index.ts, events.ts, orchard-transcripts.ts + untracked verify-bug-196-provider-lock.mjs.
- **Fixer test re-run:** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0, **33/33** (manifest
  829d31c6d1d5). Every path the round-3 fix targeted is genuinely fixed in the clean room: reopen/reload,
  new-session-first-turn, foreign-dock lock (indicator + popover + drawer all locked and explained),
  A↔B shuttle persists nothing, persisted-wrong-override healed on reopen keeping other fields, server
  start-frame door REFUSES both directions and ACCEPTS a matching override, `PATCH /api/sessions/:id`
  provider → 400.
- **BROKEN — break 1 (adv-196-native-codex-door, manifest 08f9a14685a8, exit 1, 4/5):** the server
  start-frame provider door (`src/server/index.ts:4116-4119`) gates on a transcript FILE existing in the
  Claude store OR the Orchard store. A NATIVE Codex rollout (in `$CODEX_HOME/sessions`) that the server
  itself LISTS to the user as `provider:'openai'` but has NOT been imported has `pinned===null`, so a
  `start` frame carrying `overrides.provider:'anthropic'` for it is ACCEPTED (`nothing-to-reattach`). The
  identical frame is correctly REFUSED after a single transcript GET imports the id — so the refusal
  depends entirely on whether the session happened to be opened first.
- **BROKEN — break 2 (adv-196-drawer-and-race, manifest f8658d1abd7c, exit 1, 7/8):** a pre-pin send race.
  `restoreOverrides` (`public/app.js:931-934`) re-arms a stale persisted provider override at openSession
  ENTRY, while `declareLockedProvider` only lands AFTER the awaited transcript fetch (`public/app.js:5653`).
  A send issued in that window builds `sessionOverrides()` with `locked===null` and emits a `start` frame
  with `overrides.provider:'anthropic'` for an OpenAI-pinned session; the server then FATALLY rejects it
  ("start.overrides rejected"), i.e. a session the user never switched refuses to resume. Window scales
  with transcript size. (The drawer surfaces A1/A2 all PASSED — drawer is correctly locked own- and
  foreign-view.)
- **Verifier's UNTESTED (honest):** container-isolation secondary-dir-candidate divergence (no container
  runtime in sandbox — `resumeDirCandidates` adds a second dir the transcript route does not); fork/clone
  staging of a locked id (staged id is server-internal, never reaches a client); reattach after a REAL
  server restart (in-memory `live.effective.provider` cannot survive a restart); subagent/dock views
  (needs a real engine turn); two live tabs under a genuinely running turn (frames were captured/dropped,
  not spawned). No real engine turn was run (deliberate — would spend real quota).
- **Three-suite attribution (done by THIS lane on frozen file-copy scratch trees; NOT dispatched):** the
  round-3 fixer attributed `verify-orchard-transcripts`, `verify-provider-picker` and
  `verify-feat-145-session-override` red/degraded to container-isolation / fresh-start, NOT BUG-196, but
  did not re-run on a pre-fix tree. Ran each on a frozen `minus` copy (current tree MINUS BUG-196 hunks,
  reverse-`patch`) and a frozen `withfix` copy (current tree). RESULT — identical both ways:
  `verify-orchard-transcripts` exit 1, 13 FAIL/1 PASS both (FATAL ENOENT — the fake Codex app-server runs
  inside a container on this machine); `verify-provider-picker` exit 1, 14 passed/2 failed both (fresh-start
  real-turn seam + runtime-check-pending); `verify-feat-145-session-override` exit 0, **34/34 both** (the
  fixer's 33/34 was concurrency noise from another lane's mid-run container, not BUG-196). So the fixer's
  attribution is CONFIRMED: none of the three is caused by BUG-196.
- **Decision for the orchestrator:** round 4 must (a) make the server start-frame door resolve a session's
  pinned engine WITHOUT requiring the transcript already be imported into one of the two stores — consult
  the same authority that lists the row as `provider:'openai'` (native `$CODEX_HOME` rollouts), or import
  on first list; and (b) close the pre-pin window — do not send (or do not re-arm) a provider override for a
  session whose lock is not yet known, e.g. gate the send until `declareLockedProvider` has run for the id,
  or drop a persisted provider override in `sessionOverrides()`/at restore time keyed by id before the
  fetch resolves. Fix left UNTOUCHED per charter.
- **High-stakes flag:** session-lifecycle + provider-routing + persisted data. Verdict BROKEN (fix
  incomplete), so no clean-clean-room re-verify is needed until a round-4 fix exists; the round-4 verify
  should be run CROSS-PROVIDER (openai) once the 5h window resets (rounds 1-3 were all same-provider;
  round 3 additionally same-model, forced by an exhausted OpenAI window).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` +
  `board:check` run after the edit. Kept clean room + record dir under
  `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-HIRIAX / cleanroom-record-f3kRny),
  plus the isolated tree at `bug196-r3/iso-only`, verdict at `bug196-r3/verdict.json`, and the frozen
  minus/withfix suite trees + logs at `bug196-r3/`.

### 2026-09-29 — fixing lane, round 4 (design change: the server alone decides a resumed session's engine; Opus 5.5)
- **Hypothesis verified FIRST, against live code — CONFIRMED, and cheaper than feared.** A native Codex
  rollout CAN be found before start: `findRolloutBySessionId` matches the id in the filename (no parse), and
  the ws `start` handler ALREADY backfilled it into the Orchard store (FEAT-078) before `startSession` — the
  round-3 door simply ran BEFORE that backfill, so it judged an id whose only store it never read. And the
  client's `overrides.provider` was never honoured on a resume anyway: agent-bridge P2b always forces
  `resumeProviderOf(resumeDirCandidates(...))`. So round 3's door rejection added nothing but a way to KILL a
  resume (break b) and an order-dependent verdict (break a). Nothing needed a new resolver.
- **Design (ARCH-010 — one owner, every reader reads it).** On any `start` with a `resumeSessionId`:
  (1) the FEAT-078 native-Codex backfill moves UP to the door, so every store the resume can read (Claude
  store, Orchard transcripts, native `$CODEX_HOME` rollouts) is in the stores the resolver reads before
  anything judges the id; (2) the engine is resolved by the SAME resolver over the SAME dir list P2b uses
  (`resumeProviderOf` ∘ `resumeDirCandidates`); (3) the client's `provider` is DROPPED for that start — a
  contradicting value is announced as a `status` ("ignored a stale provider choice…"), never fatal; (4) the
  engine actually run is declared back on `session-init.lockedProvider` (unchanged from round 2). A provider
  override is a FRESH-session concept only. Client: `restoreOverrides` never re-arms a provider and
  `persistOverrides` never writes one for ANY session id (not only once pinned); `sessionOverrides` gets the
  start's own `resuming` flag and never sends a provider on a resume, and — before the pin lands — no longer
  judges (and deletes from storage) a model pick against a guessed engine; `pickProvider` refuses on an
  existing id whose pin has not landed yet ("still loading").
- **Verified — must-FAIL-before / PASS-after.** `node scripts/verify-bug-196-provider-lock.mjs`:
  **against the round-3 code 37/45, exit 1** — the 8 failures are exactly the two breaks: (h) both stale
  frames fatally rejected; (i) the identical frame for a native rollout REJECTED once one GET imported it (the
  never-imported leg already passed on round 3 via P2b — the break was the order-dependence); (k) the mirror
  rejected; (j) the stale override re-armed in the window, sent as `overrides.provider:"anthropic"`, fatally
  rejected ("start.overrides rejected … runs on OpenAI Codex"), and the user's model pick DELETED from storage
  (`saved:null`). **After the fix 46/46, exit 0.** New cases, all REAL starts through the real ws handler and
  real bridge on DIRECT projects, openai = the scripted fake app-server pinned per run to accept a
  `thread/resume` of ONLY the id being resumed (so a session-init proves the same Codex thread continued):
  (i) a NATIVE never-imported rollout (synthetic, real on-disk shape) + `provider:anthropic` under a
  Claude-default project → ack `effective.provider=openai`, `session-init.lockedProvider=openai`, one Codex
  launch; same for a second rollout imported by a GET first; (k) MIRROR — a Claude-store transcript under an
  OpenAI-default project + `provider:openai` → ack `anthropic`, zero Codex launches (the Claude CLI then fails
  harmlessly: scratch `CLAUDE_CONFIG_DIR` + dead `ANTHROPIC_BASE_URL`, no quota); (j) the pre-pin race through
  the real UI — stale `{provider:'anthropic', model:'gpt-5-codex'}` persisted, the transcript route HELD by
  Playwright, a real `submit()` inside the window → no provider in the start frame, resumes on openai with
  no fatal, afterwards storage holds `{model}` only and the view shows openai. Synthesized must-FAIL: the one
  grader is fed the constructed round-3 rejection, a run on the client's stale engine, and its mirror, and
  fails all three. (e)'s synthesized must-FAIL was re-anchored: removing the pin no longer reproduces the
  round-2 writer (round 4 refuses unpinned ids too), so its persisted state is constructed directly, plus a
  new check that an unpinned pick is refused and persists nothing. (h) now asserts stale frames are IGNORED
  (reach `nothing-to-reattach`) instead of rejected.
- **Partial/truncated reads (another process writes the rollout).** Took the newest REAL rollout, truncated it
  at 6 points in a scratch `$CODEX_HOME`, and ran backfill + `resumeProviderOf`: mid-`session_meta` → not
  imported, resolver says `anthropic`, and the resume is then refused honestly by `explainUnresumable` (no
  wrong-engine run); after `session_meta`, mid-line-2, after line 3, half, full → `openai`. Scratch copy deleted.
  Pre-existing (FEAT-078, not changed here): a backfill taken from a still-growing rollout is a PREFIX and is
  never refreshed (idempotent `alreadyPresent`) — history, not engine, is affected.
- **Anti-regressions (honest):** `verify-feat-078-native-codex` 36/36; `verify-bug-195-new-session-nav` 6/6;
  `verify-feat-145-session-wiring` 21/21; `verify-feat-145-session-override` 34/34; `verify-provider-picker`
  14/16 and `verify-orchard-transcripts` FATAL ENOENT — both IDENTICAL (same failing checks / same fatal) to the
  round-3 verifier's frozen `withfix` and `minus` logs in `bug196-r3/`, i.e. pre-existing container/fresh-start
  failures, not this change. The containers those two suites left (`claude-station-orchard`, `-codex-real`,
  `-codex-fake`, confirmed mine by their `/tmp/cs-p2b-*` / `/tmp/cs-pp-*` mounts) were removed; nothing else
  touched. `npx tsc --noEmit` exit 0; `npm run gate` exit 0 (unpiped).
- **Could not test / left open:** no real Claude or Codex engine turn (fake app-server; Claude CLI denied the
  API on purpose); container projects (the backfill still uses `resumeEncodedDir ?? host dir` only, so a native
  rollout whose cwd is the CONTAINER dir is not backfilled — pre-existing, unchanged); the transcript ROUTE
  still resolves over `[encodedDir]` alone (no project in its URL) — the asymmetry every verifier named; the
  fork-refusal dir list in `startSession` (FEAT-155-dirty hunk) is still a second copy of `resumeDirCandidates`.
  During the pre-pin window the indicator shows the project default until the pin lands (display only — no
  send, persist or pick can act on it).
- **regressed-from:** BUG-196 round 3 (the door-rejection design; break b was introduced by it).
- **High-stakes:** session lifecycle + provider routing + persisted data. Independent clean-room re-verify
  WARRANTED before VERIFIED, cross-provider (openai) when its window allows. Suggested attacks: a native
  rollout under a container project; a frame with `fork:true` + provider; a second tab restoring a stale entry.
- **Hunks (all marked `BUG-196 round 4`; edited around the BUG-194/195 and FEAT-154/155 hunks; BUG-198 not
  touched):** `src/server/index.ts` — the round-3 door check replaced (backfill moved up + resolve + drop +
  status), the old FEAT-078 block reduced to a pointer; `public/app.js` — `persistOverrides`, `restoreOverrides`,
  `sessionOverrides` (+ its one caller in `startTurn`), `pickProvider`, one round-3 comment corrected;
  `scripts/verify-bug-196-provider-lock.mjs` — scratch env (fake Codex wrapper, `$CODEX_HOME`, Claude safety),
  native rollouts, (h) rewritten, (e) re-anchored, cases (i)/(j)/(k), a pid-by-environ reaper for its own
  engine children. `agent-bridge.ts`, `orchard-transcripts.ts`, `events.ts`, `drawer.js` unchanged.
- **Not done (no authority):** no git writes; `board:gen` run after this entry.

### 2026-09-29 — independent clean-room verify lane, round 4 (verify class, Opus 4.8 orchestrating; verifier anthropic/fable)
- **Verified-by:** dispatch anthropic/fable run 43181ca6-7bf5-4f1d-8c70-20f446dac770
  (clean-room `cleanroom-verify-25CZGu`, record `cleanroom-record-ttGnCk`, `scripts/independent-verify.mjs
  --working-tree` over an isolated BUG-196-ONLY tree; contract VALID, manifest-backed, 9 recorded runs) —
  **VERDICT: BROKEN.**
- **DECORRELATION — cross-MODEL, same provider; and WHY OpenAI was impossible (proven, not assumed).**
  Fixer = anthropic/Opus 5.5; verifier = anthropic/**claude-fable-5** (premium, different family — the
  maximally-decorrelated Anthropic option; FEAT-124 gate opened for the run via `ORCHARD_ALLOW_FABLE=1`).
  Cross-provider OpenAI was the charter's strong preference, but this lane PROVED it cannot verify this
  fix: the fixer's suite binds a REAL loopback HTTP+WebSocket server, and codex's `workspace-write`
  sandbox (the mode `dispatch.mjs`/`independent-verify.mjs` use for the openai path) blocks even `bind()`
  on 127.0.0.1 — `codex sandbox -c sandbox_mode=workspace-write -- node <probe>` returned `BIND_FAIL
  EPERM` (zero-API probe, same wrapper as `codex-sandbox-preflight.mjs`). So a codex verifier could only
  do a static review of a server-driven test → INVALID. Per the charter fallback, ran anthropic on the
  model least like the fixer's. (Rounds 1–3 were all same-provider because the OpenAI 5h window was
  exhausted; this is the first round where the window had headroom AND the reason OpenAI still can't be
  used was established — a standing fact for future rounds of any server-driven verify.)
- **Isolation (verifier saw ONLY BUG-196 hunks).** Built HEAD + BUG-196-only tree from the round-3
  `iso-only` scaffold (git repo at HEAD a977e76 + reflinked node_modules): reset the 6 touched files to
  HEAD via `git show` (read-only; git writes are blocked for agents), applied ONLY signature-matched
  BUG-196 hunks with `patch` (signature `BUG-196|resumeProviderOf|lockedProvider|lockedSessionProvider|
  lockedProviderExplain|lockedProviders|declareLockedProvider|lockedProviderOf|resumeDirCandidates|
  paintProvSurfaces`). classify: 0 MIXED hunks; every NEUTRAL hunk inspected and confirmed FEAT-154/155
  (containerStoreDirName/gpuRow/wsRootRow/MEM_CYCLE/env group/declaredContainerStore/stale-stoppable),
  none BUG-196 — dropped correctly in `only` mode. The one FEAT-155 symbol entanglement inside BUG-196's
  `resumeDirCandidates` (`containerStoreDirName(project)`) was reverted by hand to the HEAD form
  `encodeCwd(containerWorkdir(project.id))`, keeping the BUG-196 logic. Verified: 357 BUG-196 added lines,
  ZERO excluded-ticket markers in any added line, `npx tsc --noEmit` exit 0 on the isolated tree, and the
  fixer suite 46/46 on it BEFORE dispatch (fix intact after isolation). independent-verify stripped
  CLAUDE.md/AGENTS.md/.claude/docs/bugs/docs/prompts (confirmed in its report). Artifacts under
  `~/.local/state/claude-station/scratch/bug196-r4/` (iso-only tree, req-r4.txt, verify.log, verdict.json).
- **Fixer test re-run:** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0, **46/46** (manifest
  0dbec3b5a271). Every path the round-4 fix targeted is genuinely fixed in the clean room.
- **BROKEN — break 1 (model-pick-dropped-on-resume, manifest d3c0e6c209cf, exit 1, 3/7; IN SCOPE):** a
  legitimate model pick is SILENTLY DROPPED on resume when the project default provider differs from the
  pinned engine. `{model:"gpt-5-codex"}` (with or without a stale provider) on an OpenAI-pinned session
  under a Claude-DEFAULT project → ack `effective.model=null`, session-init model "codex default",
  `overridden` still lists "model", and the fake Codex engine asserts `ASSERT_MODEL: got model=undefined,
  want gpt-5-codex`. The IDENTICAL frame under an OpenAI-default project keeps the model (control PASS).
  Mirror: a Claude-pinned session under an OpenAI-default project loses its Claude model pick too — so the
  project default DOES affect an existing session's run (a requirement this ticket set out to kill).
  Cause (verifier): `agent-bridge.ts` resolves the model against the CONFIGURED provider before the
  transcript flips the engine in P2b.
- **BROKEN — break 2 (drawer-session-scope-before-pin, manifest 2af0de9fbb36, exit 1; req-5 gap):** the
  Settings drawer's session-scope provider control accepts a provider switch for an EXISTING session id
  (a) in the pre-pin window (transcript fetch held) and (b) whenever the transcript fetch FAILS (HTTP 500).
  Clicking "Claude" on an OpenAI thread arms `state.overrides.provider="anthropic"`, and `providerView`,
  `#provBtn` (`data-provider=anthropic`, `data-locked=false`) and the drawer ("Overridden for this session
  only") all show Claude. Nothing is persisted and it heals once a pin lands — but after a FAILED fetch it
  stays until the next server declaration. Round 4 guarded `pickProvider` for this window; `drawer.js`
  `providerGroup`/`put()` were NOT — so the fix's own "every UI surface reads the lock" claim is unmet.
- **Two more findings the verifier could NOT ATTRIBUTE (diff truncated 60 KB of 97 KB — treat as
  needs-confirmation, possibly pre-existing):** (3) same-id-in-claude-and-openai-stores — a CONSTRUCTED
  dual-store id resumes on openai before any open but is declared/run as anthropic after one transcript GET
  writes the Claude mirror; `resumeProviderOf` takes the first provider dir with the file in readdir order,
  so opening it FIRST changes the engine decision (violates req-1 "same answer whether opened first"). Not
  observed arising naturally. (4) native-rollout-cwd-trailing-separator (manifest c52c33430fc0, 0/1) — a
  native rollout whose `session_meta` cwd has a trailing separator is LISTED in the sidebar as openai but
  the transcript GET 404s and the resume is FATALLY refused ("cannot resume … no transcript"); the refusal
  is independent of the client provider (violates req-3 "never fatally reject"). Cause (verifier):
  `listNativeCodexSessions` normalises the cwd, `importNativeCodexSession`'s expectedEncodedDir check does
  not. The verifier flagged it cannot confirm these two involve code the change under test introduced,
  because ~37 KB of the diff was truncated from its prompt.
- **Verifier's UNTESTED (honest):** container-isolation projects (no container runtime — every real start
  ran on a DIRECT project, so the `resumeDirCandidates` container candidate was unexercised); no real Codex
  binary / real Claude CLI turn (fake app-server; Claude CLI pointed at a dead API — Claude cases graded on
  the start ack only, no Claude-side session-init lockedProvider observed); reattach-to-a-live-bridge
  session-init branch; the survivor-broker delivery path (`CLAUDE_STATION_SURVIVE=0` throughout); older
  Codex rollouts with only `id`/no `session_id`; sub-agent transcript views; model chip/popover contents
  for a locked session; and the 37 KB of truncated diff. Cases it RAN that SURVIVED (exit 0, uncited):
  head/tail/garbage-truncated rollouts (fail safe then resume on openai once complete), forks of
  Claude/OpenAI/native sessions, a fresh session honouring the client provider, a resume with no
  resumeEncodedDir, two starts racing on one never-imported id, a real boot onto the session URL with a
  stale stored override, and a real first turn + reload + foreign-project click.
- **Decision for the orchestrator:** round 5 must (a) resolve the resume MODEL from the SAME engine the
  transcript pins (after the P2b flip), not from the configured provider, and never let the project default
  drop a legitimate model pick for an existing session; (b) guard the drawer's session-scope provider
  control (`drawer.js` `providerGroup`/`put()`) in the pre-pin/fetch-failed window exactly as `pickProvider`
  is — refuse a switch for any id that already has a transcript, before/without a landed pin. Findings (3)
  and (4) should be confirmed against the FULL diff (re-run with `--max-diff-bytes` ≥ 100000) or a direct
  code read before deciding whether they are BUG-196 regressions or pre-existing; if pre-existing, file
  separately. Fix left UNTOUCHED per charter.
- **High-stakes flag:** session-lifecycle + provider-routing + persisted data + MODEL routing. Verdict
  BROKEN (fix incomplete), so no clean-clean-room re-verify is needed until a round-5 fix exists. The
  round-5 verify should again run anthropic cross-MODEL (OpenAI is ruled out for any server-driven verify by
  the codex `bind()` block proven above) and should pass the FULL diff (raise `--max-diff-bytes`) so
  findings (3)/(4) are attributable.
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` +
  `board:check` run after the edit. Kept clean room + record dir under
  `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-25CZGu / cleanroom-record-ttGnCk),
  plus the isolated tree + logs + verdict at `bug196-r4/`. No containers created (direct projects only).

### 2026-09-29 — fixing lane, round 5 (engine first, then model; one guarded provider writer; Opus 5.5)
- **Hypothesis checked first, against live code. CONFIRMED for both in-scope breaks.**
  (1) `agent-bridge.ts` resolved `effective.model` with `resolveModelForProvider(model, <configured provider>)`
  BEFORE P2b flipped the engine to the transcript's, so a `gpt-5-codex` pick under a Claude-default
  project became null before the flip, and the flip then re-resolved null. The server was deciding the
  model before it knew the engine. (2) `drawer.js` `providerGroup` wrote `ctx.overrides.provider` itself
  (`put()` in session scope, and an inline `delete`), bypassing the one guarded function `pickProvider`.
  The lock-only check `ctx.lockedProvider()` is null before the pin lands and after a failed fetch.
  **regressed-from:** BUG-188 round 2. That round added the pre-flip model resolve, and break 1
  reproduces at clean HEAD: the verifier's `adv-server.mjs model` gives 2/7 at HEAD and 3/7 on round 4.
  Break 2 is a gap in BUG-196 round 4.
- **Built (hunks marked `BUG-196 round 5`):**
  - `src/server/agent-bridge.ts` (constructor): P2b moved ABOVE the model resolve, so `provider` is final
    first. The model is then resolved once against that engine, from the right source: the user's explicit
    session pick if there is one, otherwise the project's own `settings.model` re-resolved for the real
    engine. An explicit pick the engine cannot run is NOT dropped silently. It emits
    `status: "ignored your model pick (<id>): not a <engine> model — …"`, adds an `ignoredOverrides`
    entry (the drawer already renders these as "accepted but could not honour") and removes `model`
    from `overridden`.
  - `public/app.js`: new `providerSwitchRefusal()` is THE guard: pinned → the lock explanation; an existing
    id with no pin (loading, or the read failed) → refused, with that reason; a live session in view →
    refused. `pickProvider(next)` is now the ONE writer of `state.overrides.provider`. It asks the guard,
    `null` means project default, and it returns true/false. `paintProvPop` disables its options on the
    same guard. `restoreOverrides` strips `provider` BEFORE the assign, so it is not even a transient
    writer. `sessionOverrides` no longer judges or deletes a model on a resume: the server owns that and
    now announces it. On a fresh start the stale cross-engine drop is said aloud (`say`). `createDrawer`
    gets `pickSessionProvider: pickProvider` and `providerSwitchRefusal`, the same pattern as
    `pickSessionAccount: pickAccount`. `providerSwitchRefusal` is exported on `__station`.
  - `public/lib/drawer.js`: `put('provider')` and `resetField('provider')` in session scope hand off to
    `ctx.pickSessionProvider`. `providerGroup` disables on `ctx.providerSwitchRefusal()` (not only on a
    landed pin), shows the refusal text, and its click goes through `put`. The inline
    `delete ctx.overrides.provider` is gone.
- **Client provider-writer inventory (req 2: grep and find no other writer):**
  `rg -n "overrides(\.provider|\[['\"]provider['\"]\])\s*=[^=]|delete (state|ctx)\.overrides\.provider|overrides\[field\]\s*=[^=]|delete (state|ctx)\.overrides\[|Object\.assign\((state|ctx)\.overrides" public/app.js public/lib/drawer.js`
  - *Arms or clears a session provider:* `pickProvider` (app.js). This is the ONLY
    `state.overrides.provider =` in the client, and it is guarded by `providerSwitchRefusal`. Its callers
    are the composer-tray popover (`paintProvPop`) and the drawer via `ctx.pickSessionProvider` (from
    providerGroup's click → `put`, and from `resetField`).
  - *Generic field writers that can no longer touch provider:* drawer `put()` (session scope: provider
    diverted above the `ctx.overrides[field]` write), drawer `resetField()` (provider diverted above its
    `delete ctx.overrides[field]`), and app.js model/effort popover `fill()` (`state.overrides[field]`,
    fields `model`/`effort` only).
  - *Only remove, never set:* `declareLockedProvider` (heals memory and storage when a pin lands);
    `restoreOverrides` (clear-all, then assign minus provider); `selectProject`/`startNew` (clear all).
  - *Persist / send:* `persistOverrides` never stores provider for any id. `sessionOverrides` is the only
    builder of `start.overrides`: no provider when resuming or pinned. The promptless reattach `start`
    carries no overrides. `api.js` has no provider writer.
  - *Not per-session:* drawer project-scope `put('provider')` → `api.patchProject` sets the project
    DEFAULT for future sessions. It is unaffected, by design.
- **Breaks 3 and 4: attributed on a clean-HEAD FILE COPY (`git archive HEAD`, no checkout) using the
  verifier's own probes.** Both reproduce at HEAD `a977e76`, so both predate BUG-196. Per the charter
  they are filed as their own tickets and NOT fixed here.
  - (4) trailing-separator rollout: `adv-server.mjs slash` gives 0/1 at HEAD, with the same fatal "cannot
    resume … no transcript". Filed **BUG-205**. Cause: the listing normalises the cwd and
    `importNativeCodexSession`'s check does not.
  - (3) dual-store id: `adv-server.mjs both` at HEAD gives 2/5, with unopened=openai and opened=anthropic.
    The dispatch engine itself flips at HEAD (readdir order in `providerRoots` plus the FEAT-144 mirror
    written by the first GET). On the round-4 tree it gives 4/5: BUG-196 made the declared engine equal
    the engine run, and the flip itself was already there. Filed **BUG-206**, which needs a precedence
    rule.
  - Logs: `~/.local/state/claude-station/scratch/bug196-r5/head/{both,slash,model}-head.log` and
    `live-pre/{both,model}-live.log`.
- **Verified: must-FAIL before, PASS after.** `node scripts/verify-bug-196-provider-lock.mjs` → **60/60,
  exit 0** (it was 46). Against a FROZEN copy of the round-4 tree (`scratch/bug196-r5/live-pre`) the same
  suite gives **52/60, exit 1**. The 8 failures are exactly the two breaks: l1–l5 (pick dropped in both
  directions; invalid pick dropped with no status) and m1/m2 (the drawer armed `openai` for an existing
  id with the fetch held and with an HTTP 500; `pickProvider` did not report the refusal). The new cases
  all use REAL starts through the real ws handler and bridge on DIRECT projects, plus real Brave
  drawer clicks:
  - **(l1)** An OpenAI-pinned thread under a Claude-default project with `{model:gpt-5-codex}`: the ack
    keeps the model, and the fake Codex engine RECEIVES it. `ASSERT_MODEL` would exit 1, and the fake's
    input log proves the turn reached it.
  - **(l2)** The same, with a stale provider on the frame.
  - **(l3)** The mirror: a Claude-pinned thread under an OpenAI-default project keeps `claude-opus-4-1`.
  - **(l4)/(l5)** An invalid pick falls back to the engine default WITH the status and is no longer listed
    as overridden, in both directions.
  - **(l6)** Control: no pick, no leak, no noise.
  - **(m1)** Pre-pin, with the fetch held: the drawer control is disabled, nothing is armed, nothing is
    persisted, and the refusal is shown. It is still locked and explained once the pin lands.
  - **(m2)** Failed fetch (500): the drawer is disabled, and `pickProvider` returns false with nothing
    armed.
  - **(m3)** Control: a new session is armed through the drawer by the one writer, and picking the
    project default clears it.
  - Synthesized must-FAIL graders for (l) and (m) are fed the constructed round-4 observations and fail
    them. Earlier cases a–k are unchanged and green.
- **Anti-regressions (honest):**
  - All pass: `verify-openai-model-inheritance` 19/19, `verify-new-session-overrides` 5/5,
    `verify-feat-078-native-codex` 36/36, `verify-bug-195-new-session-nav` 6/6,
    `verify-feat-145-session-wiring` 21/21, `verify-feat-145-session-override` 34/34,
    `verify-feat-146-settings-polish` 81/81, `verify-feat-146-settings-rows` 59/59.
  - Red on BOTH trees, with the same failing checks: `verify-feat-146-settings-content` 137/139 and
    `verify-feat-146-settings-shell` 108/115. The round-4 frozen copy fails identically (the services-group
    mutation precondition, and category order and breakpoint layout), so neither is caused by this change.
  - `verify-provider-picker` 14/16: the same two pre-existing checks recorded in rounds 3/4.
  - The two containers that suite left (`claude-station-codex-fake`, `-codex-real`) were confirmed mine by
    their `/tmp/cs-pp-*` mounts and creation time, and removed. Nothing else was touched.
  - `npx tsc --noEmit` exit 0. `npm run gate` exit 0 (unpiped).
- **BUG-198 not made worse:** this change adds no override clearing on selection. `selectProject`'s
  clear-all is untouched.
- **Could not test / left open:**
  - No real Codex or Claude engine turn. The fake app-server is used, and the Claude cases are graded
    on the start ack.
  - The drawer's provenance-chip reset for provider was not clicked in a browser. It is routed through
    the writer, by grep.
  - During the pre-pin window the indicator still SHOWS the project default. This is display only: every
    write is refused.
  - The transcript-route and `resumeDirCandidates` asymmetry named in earlier rounds is unchanged.
- **High-stakes:** session lifecycle, provider and MODEL routing, persisted data. An independent clean-room
  re-verify is WARRANTED before VERIFIED: anthropic cross-MODEL (OpenAI cannot bind loopback), passing the
  FULL diff. Suggested attacks: a project whose own `settings.model` belongs to the other engine; a pick
  equal to the project model; the drawer reset chip; two tabs.
- **Not done (no authority):** no git writes. `board:gen` + `board:check` run after this entry. Scratch is
  at `~/.local/state/claude-station/scratch/bug196-r5/`.

### 2026-09-29 — independent clean-room verify lane, round 5 (verify class, Opus 4.8 orchestrating; verifier anthropic/fable)
- **Verified-by:** dispatch anthropic/fable run e0c09c1c-ddac-47b5-a5a9-e51c5247da8a
  (clean-room `cleanroom-verify-UuZKby`, record `cleanroom-record-rJShvb`, `scripts/independent-verify.mjs
  --working-tree` over an isolated BUG-196-ONLY tree; contract VALID, manifest-backed, 10 recorded runs) —
  **VERDICT: BROKEN.**
- **DECORRELATION — cross-MODEL, same provider.** Fixer = anthropic/Opus 5.5; verifier = anthropic/
  **claude-fable-5** (FEAT-124 gate opened for the run via `ORCHARD_ALLOW_FABLE=1`). Cross-provider OpenAI
  remains impossible for this fix: the fixer suite binds a REAL loopback HTTP+WebSocket server and codex's
  `workspace-write` sandbox blocks `bind()` on 127.0.0.1 (proven in round 4, run 43181ca6). Per the charter
  fallback, ran anthropic on the model least like the fixer's.
- **Isolation (verifier saw ONLY BUG-196 hunks).** Built HEAD + BUG-196-only tree by resetting the 6 touched
  files (`public/app.js`, `public/lib/drawer.js`, `src/server/agent-bridge.ts`, `src/server/index.ts`,
  `src/server/events.ts`, `src/server/orchard-transcripts.ts`) to HEAD via `git show` (read-only; git writes
  blocked for agents) and applying ONLY the BUG-196 hunks with `patch`. Because round-5's own hunks include
  TWO that carry no BUG-196 signature keyword (the agent-bridge removal of the old pre-flip model resolve, and
  `pickProvider`'s `return true`), classification was EXCLUDE-based: keep a hunk unless it matches
  BUG-194/195/FEAT-154/155/156's signatures, plus an explicit keep-list for those two NEITHER hunks. The one
  MIXED hunk (BUG-196's `resumeDirCandidates` using FEAT-155's `containerStoreDirName(project)`) was hand-reverted
  to the HEAD form `encodeCwd(containerWorkdir(project.id))`. Confirmed BEFORE dispatch: 466 BUG-196 added lines,
  ZERO excluded-ticket markers in any added line, `npx tsc --noEmit` exit 0 on the isolated tree, and the fixer
  suite `verify-bug-196-provider-lock.mjs` **60/60** on it (fix intact after isolation). independent-verify
  stripped CLAUDE.md/AGENTS.md/.claude/docs/bugs/docs/prompts (confirmed in its report). **Full diff 123247
  bytes reached the verifier UNTRUNCATED** (`--max-diff-bytes 300000`), closing round 4's attribution gap.
  Artifacts under `~/.local/state/claude-station/scratch/bug196-r5/` (iso-only tree, build-r5.mjs, req-r5.txt,
  verify.log, verdict.json).
- **Fixer test re-run:** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0, **60/60** (manifest
  726c7788015a). Every path the round-5 fix targeted is genuinely fixed in the clean room, including round-4's
  two breaks (model resolved after the engine is final; the guarded drawer writer).
- **BROKEN — five findings the suite never builds (all IN or ADJACENT to scope; NONE are BUG-205/206):**
  - **(1) invalid model pick == project default model → SILENT drop** (manifest ca7845b913dd, adv-196-server S1,
    IN SCOPE, req-3). Resuming an OpenAI-pinned session with `overrides.model=claude-opus-4-1` under a
    Claude-default project whose `settings.model` is ALSO `claude-opus-4-1` → `effective.model=null` with NO
    "ignored your model pick" status and an EMPTY `ignoredOverrides`. The mirror (gpt-5-codex on a Claude-pinned
    session under an OpenAI-default project with model gpt-5-codex) is equally silent. Cause: agent-bridge.ts
    discards an override equal to `base[field]` BEFORE the round-5 announce block, so `explicit` is null and the
    announcement never fires. The control (project model unset) announces correctly — so the fix's "falls back
    visibly, never silently" holds everywhere EXCEPT when the pick coincides with the project default.
  - **(2) UI Claude aliases opus/sonnet/haiku not recognised as Claude models** (manifest via adv-196-server S2).
    Resuming an OpenAI-pinned session with `overrides.model="opus"` is acked provider=openai, model="opus",
    overridden=["model"], NO status — an invalid-for-the-engine pick is handed to Codex instead of falling back
    visibly. Cause: `modelProviderOf` (global-settings.ts) and `modelProviderOfClient` (app.js) match only
    `/^claude/` when no model catalog exists. Verifier caveat: with a populated Claude catalog (`models.json`)
    "opus" MAY classify — untested on such a machine.
  - **(3) alias defect reachable through the REAL UI** (manifest via adv-196-ui U1). After a failed transcript
    read for an OpenAI-pinned session under a Claude-default project, the model popover offers Project default /
    Opus / Sonnet / Haiku; clicking Opus and sending puts `{model:"opus"}` on the start frame and the server runs
    Codex with model "opus", no status.
  - **(4) a client provider value on resume can still be FATAL** (manifest a8e12fc6b611, adv-196-server S6, req-2
    violation). Resuming an OpenAI-pinned session with `overrides.provider` "gemini", null or "OpenAI" → fatal
    "start.overrides rejected: provider must be one of anthropic, openai"; the session does not resume, because
    `validateSessionOverrides` (index.ts) runs BEFORE the resume branch that drops the provider. Lower severity —
    the current client never sends these — but req-2 says whatever the client sends is never fatal.
  - **(5) failed transcript read → #provBtn neither locked nor explained, shows wrong engine** (manifest
    9e67091130ed, adv-196-ui U3, req-4). For an OpenAI-pinned session under a Claude-default project after a
    failed read, `#provBtn` has `data-locked="false"`, `data-provider="anthropic"` and title "Provider: Claude
    (project default) …", while its popover AND the drawer are correctly disabled with Claude/anthropic pressed —
    the button invites a switch its own popover refuses. Cause: `paintProvBtn` keys on `lockedSessionProvider()`
    rather than `providerSwitchRefusal()`.
- **Verifier's UNTESTED (honest):** container-isolation projects (no container runtime — every project was
  direct, so the `resumeDirCandidates` container candidate was unexercised); reattach to a survivor/adopted
  bridge after restart (all runs `CLAUDE_STATION_SURVIVE=0`; only cold-restart-then-resume-from-disk exercised);
  real Codex/Claude engines (fake app-server + dead Claude API — Claude runs graded to the start ack only, and
  the actual Codex rejection of model "opus" was not observed); the alias finding with a POPULATED Claude catalog
  (scratch data dir had none); the fork flow (`armFork` + `fork:true`) and Windows-origin sessions; the pre-pin
  window with the fetch HELD rather than failed for the model-pick/engine-shown cases. Cases RUN that SURVIVED
  (uncited): valid picks kept under same-engine and changed project defaults; project default model not leaking
  with no pick; resume after a cold restart; project-scope drawer provider flips under an open locked session
  then a real send; keyboard driving of the locked popover; a failed first turn on a fresh OpenAI-armed session.
- **Decision for the orchestrator:** round 6 must (1) announce the drop for an invalid pick even when it equals
  the project default (do not discard a pick equal to `base[field]` before the model block judges it against the
  FINAL engine); (2) classify the UI's built-in Claude aliases (opus/sonnet/haiku) as Claude models in
  `modelProviderOf`/`modelProviderOfClient` regardless of catalog presence, so an alias invalid for the locked
  engine falls back visibly rather than reaching Codex; (3) stop `validateSessionOverrides` from FATALLY
  rejecting an unknown/contradicting `provider` on a resume — the resume branch already drops it, so vet the
  provider only for a FRESH start; (4) make `paintProvBtn` (and its title/`data-locked`) key on
  `providerSwitchRefusal()` like the popover and drawer, so the composer button never invites a switch its
  popover refuses, including after a failed read. Fix left UNTOUCHED per charter.
- **High-stakes flag:** session-lifecycle + provider-routing + persisted data + MODEL routing. Verdict BROKEN
  (fix incomplete), so no clean-clean-room re-verify is needed until a round-6 fix exists. The round-6 verify
  should again run anthropic cross-MODEL (OpenAI ruled out for any server-driven verify by the codex `bind()`
  block) and pass the FULL diff (`--max-diff-bytes` ≥ diff size).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` +
  `board:check` run after the edit. Kept clean room + record dir under
  `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-UuZKby / cleanroom-record-rJShvb),
  plus the isolated tree + build script + req + logs + verdict at `bug196-r5/`. No containers created (direct
  projects only); no leftover processes.

### 2026-09-29 — fixing lane, round 6 (one classifier, drop-before-validate, one engine state; matrix proof; Opus 5.5)
- **Hypothesis verified FIRST, against live code — CONFIRMED, with one refinement.** (a) TWO model→engine
  classifiers: server `global-settings.modelProviderOf` and client `modelProviderOfClient`; both matched only
  `/^claude/`, so the aliases were unclassified on both sides (break 2/3). (b) Validation ran BEFORE the resume
  drop: index.ts called `validateSessionOverrides(cmd.overrides)` and only afterwards stripped `provider`
  (break 4). (c) THREE lock derivations: `providerView` (engine shown), `providerSwitchRefusal` (may it change),
  `paintProvBtn` (keyed on the pin alone) — after a failed read the first returned the project default, the
  second refused, the third painted unlocked (break 5). Refinement: break 1 is a FOURTH duplicate — "did the
  user pick a model" was derived from `overridden` (value ≠ `base.model`, where `base` was resolved against the
  CONFIGURED engine) instead of from the pick itself. Not wrong enough to stop; fixed in the same shape.
- **Built (hunks marked `BUG-196 round 6`; edited around other lanes' hunks; BUG-198/205/206 untouched):**
  - `src/server/global-settings.ts` — `modelProviderOf` (THE classifier) now knows the Claude CLI aliases
    (`default|fable|opus|sonnet|haiku|opusplan`, on the base id so `opus[1m]` too) with or without a catalog.
  - `public/app.js` — `modelProviderOfClient` DELETED; `sessionOverrides` judges no model on any start. The
    client forgets a pick only when the server DECLARES it ignored (`effective-config.ignoredOverrides` →
    delete + persist). One engine state `sessionEngine()` → `{engine, refusal, source}`; an existing id with
    no declared engine is `engine: null` (UNKNOWN). `providerView`/`providerSwitchRefusal` are reads of it;
    `paintProvBtn`, `paintProvPop`, the drawer (via `ctx.sessionEngine`) and `paintIntegrations` paint from
    it; `paintProvSurfaces` now repaints the drawer too. Unknown engine ⇒ `#provBtn data-provider="unknown"`,
    locked, title "Engine: not known yet — …"; no option pressed; the model popover offers no catalog (only
    "Project default" + a note; free text still works, the server judges it). `restoreOverrides` also heals a
    stale provider out of STORAGE (written under its own key — `persistOverrides` would have used the
    outgoing session's key). `ctx.sessionModelCycle` feeds the drawer's session-scope Model row.
  - `public/lib/drawer.js` — providerGroup reads `ctx.sessionEngine()` (its own copy of the lock sentence is
    gone); session-scope Model row cycles the session engine's catalog (it offered Opus/Sonnet/Haiku on an
    OpenAI-pinned session — found by the matrix's self-attack, not in the round-5 list).
  - `src/server/index.ts` — on ANY start with `resumeSessionId` (fork included) the raw `provider` is taken off
    the frame BEFORE `validateSessionOverrides`; announced after the backfill if it ≠ the pin. A fresh start is
    unchanged (garbage provider still refused loudly — asserted as a boundary).
  - `src/server/agent-bridge.ts` — the model block reads the pick from `opts.overrides` (presence), judges it
    once against the final engine with `modelProviderOf`, treats an ignored pick EXACTLY as no pick (project
    model if it belongs to the engine, else engine default — the matrix caught my first draft falling straight
    to the engine default), announces it (status + `ignoredOverrides`), and announces an unclassifiable pick
    that is passed through ("not a recognised … model — passing it to the engine as-is").
- **Why "unknown" for a failed read:** the resume ignores the project default and any override, so showing
  either is a guess the next turn will contradict — exactly the round-5 surface that then offered Claude
  aliases to a Codex thread. Unknown + refused + explained is the only state that is true; it resolves the
  moment the server declares (tail read or session-init).
- **Proof — MATRIX, `scripts/verify-bug-196-matrix.mjs` (new).** Engine {openai, anthropic} × pick {none,
  valid, other-engine, alias, garbage} × project {same, other, equal-to-pick} × read {ok, failed} × client
  provider {absent, matching, contradicting, garbage} = **240 client cells**, each: persisted pick+provider,
  real Brave open (read ok / HTTP 500), lock surfaces read from the DOM through real clicks (button, popover,
  drawer provider + model rows, model popover), real `submit()`, the frame actually sent, the server's answer,
  storage after. **WIRE 120 distinct frames + 14 named garbage provider values** (null, "OpenAI", "gemini",
  42, {}, "", ["openai"]) with the provider ON THE WIRE; the model is proven to REACH the engine (Codex:
  `ASSERT_MODEL` fatal; Claude: a stub CLI recording its argv `--model`). **FRESH 20** (engine × via project /
  armed × pick). **UNIT 37** (classifier, no catalog + a copy of the real catalog files). Named boundary cells:
  fork+garbage provider (not fatal), fresh+garbage provider (refused loudly).
  - AFTER: unit+wire+fresh **200/200**, client openai **126/126**, client anthropic **126/126** — all exit 0.
  - MUST-FAIL, same suite on a FROZEN rsync copy of the round-5 tree (`BUG196_TREE=…/bug196-r6/tree-pre`):
    unit+wire+fresh **96/200**, client openai **6/126 (0/120 cells)**, client anthropic **42/126 (36/120)** —
    all five round-5 breaks reproduce (equal-to-pick silent drop; `opus` handed to Codex; Opus/Sonnet/Haiku
    offered after a failed read; `start.overrides rejected: provider must be one of …` for "gemini"/null/
    "OpenAI"; `#provBtn data-locked=false data-provider=anthropic`) plus the drawer model row.
  - Synthesized must-FAIL graders (fixed constructed round-5 observations, one per break) all graded FAIL.
  - Honest note: the matrix ALSO found a residue my first draft left — a stale provider stayed in storage
    whenever the pin never landed (failed read + a turn that dies before session-init) → fixed (restore heals).
- **Prior case suite:** `verify-bug-196-provider-lock.mjs` **60/60**. Three of its synthesized baselines removed
  the pin from CURRENT code and asserted "reads as anthropic" — a moving baseline that round 6 moved (it now
  reads unknown). Re-anchored to the property the fixed checks need (without the pin the view cannot name the
  real engine); marked `BUG-196 round 6`.
- **Anti-regressions:** green — `verify-openai-model-inheritance` 19/19, `verify-new-session-overrides` 5/5,
  `verify-bug-195-new-session-nav` 6/6, `verify-feat-145-session-wiring` 21/21, `verify-feat-145-session-override`
  34/34, `verify-feat-078-native-codex` 36/36, `verify-feat-146-settings-polish` 81/81. Red, not mine:
  `settings-content` 137/139 and `settings-shell` 108/115 (the same checks as round 5's pre-existing reds);
  `settings-rows` 58/59 — "FOREIGN PROSE BEHIND AN ICON: isolation … A Dockerfile in this project's own repo",
  a `container.dockerfile` description another lane added to drawer.js after my freeze (59/59 before it);
  `verify-provider-picker` 14/16 (same two pre-existing checks). The playwright specs FEAT-042/045/051/BUG-026
  do not load at all (identical on the frozen copy) → filed **BUG-209**. My picker run's two containers
  (`claude-station-codex-real`/`-fake`, its `/tmp/cs-pp-*` mounts, created 17:20) removed; nothing else touched.
  `npx tsc --noEmit` exit 0; `npm run gate` exit 0 (unpiped).
- **Self-attack — paths the matrix does not cover, named:** (1) drawer session-scope Model row — found, FIXED,
  added to every client cell; (2) fresh starts — the client classifier's deletion moved their judging to the
  server — ADDED as the FRESH leg; (3) fork frames — ADDED (x1); (4) pre-pin HELD read — same engine state as a
  failed read until the pin lands, covered by the prior suite's (j)/(m1), not re-enumerated; (5) live session in
  view / foreign dock with an unknown engine — same id-keyed code path, covered by prior (e)/(f) for pinned, not
  enumerated for unknown; (6) DECLINED + FILED **BUG-208**: the drawer's PROJECT-scope Model row still cycles
  the Claude catalog for an OpenAI project (a stored Claude default is then dropped silently for every Codex
  session — a project default, not a pick), and the model chip/button name the project default model for a
  session whose engine cannot run it; also recorded there: `scripts/lib/cost-model.mjs providerOf`, a pricing
  prefix table deliberately NOT folded into `modelProviderOf` (tooling, prices resolved wire ids, never aliases).
- **Could not test:** no real Codex/Claude engine (fake app-server; Claude stub records argv and exits);
  container-isolation projects (all direct); survivor/adopted reattach; two live tabs.
- **regressed-from:** BUG-196 round 5 (the lock-derivation split and the post-validation drop) and BUG-188
  round 2 (the client classifier copy, deleted here).
- **High-stakes:** session lifecycle + provider/model routing + persisted data. Independent clean-room
  re-verify REQUIRED before VERIFIED (anthropic cross-model; pass the full diff). Suggested attacks: the two
  "enumerated elsewhere" cells above (unknown engine × live/foreign), a populated Claude catalog with a
  non-alias Claude value, and a project whose `settings.model` is garbage.
- **Not done (no authority):** no git writes; `board:gen` run after this entry. Scratch (frozen tree, logs):
  `~/.local/state/claude-station/scratch/bug196-r6/`.

### 2026-09-29 — independent clean-room verify lane, round 6 (verify class, Opus 4.8 orchestrating; verifiers anthropic/fable then anthropic/claude-sonnet-5)
- **Outcome: NO VALID VERDICT — two dispatches both contract-INVALID (independent-verify exit 3). NOT VERIFIED stands.** Neither
  attempt found a substantive break, but neither emitted a well-formed citation block, so per the EXECUTED-EVIDENCE contract the
  answer counts as neither pass nor fail. A contract-valid independent verdict is still required before VERIFIED. There is ONE
  ungraded in-scope UI signal (below) to settle before closing.
- **Isolation (verifier saw ONLY BUG-196 hunks) — CLEAN, reusing the round-5 procedure (build script `build-r6.mjs`).** Built HEAD +
  BUG-196-only over 7 touched files (`public/app.js`, `public/lib/drawer.js`, `src/server/agent-bridge.ts`, `src/server/index.ts`,
  `src/server/events.ts`, `src/server/orchard-transcripts.ts`, and — new in round 6 — `src/server/global-settings.ts`): reflink-copied
  the round-5 `iso-only` scaffold (git repo at HEAD a977e76 + node_modules), restored the touched files to HEAD, then applied ONLY the
  BUG-196 hunks with `patch` (INCLUDE signature regex extended for round 6: added `sessionEngine|sessionModelCycle|modelProviderOf|
  modelProviderOfClient|ignoredOverrides|providerGroup|pickProvider|paintProvBtn|paintProvPop` etc., plus a keep-list for the
  signature-less BUG-196 hunks and a hand-revert of the one FEAT-155 symbol entanglement `containerStoreDirName(project)` to the HEAD
  form `encodeCwd(containerWorkdir(project.id))`); the other lane's drawer Dockerfile-description change was stripped. Confirmed BEFORE
  dispatch: **0 foreign-ticket markers** (BUG-194/195/198, FEAT-154/155/156, BUG-205/206/208) in any added line, 73 BUG-196 added
  lines, `npx tsc --noEmit` exit 0 on the iso tree, and the fixer suite `verify-bug-196-provider-lock.mjs` **60/60** on it (fix intact
  after isolation). independent-verify stripped docs (board/methodology excluded byte-exact, BUG-186). **Full diff 185583 bytes reached
  each verifier UNTRUNCATED** (`--max-diff-bytes 300000`; both logs report 185583 diff bytes, no truncation warning).
- **Attempt 1 — anthropic/fable run 778cc092-1eff-4bc9-a975-bdc9d452c72c (cleanroom-verify-15cyn5 / record-NCjFuj): INVALID (exit 3).**
  DECORRELATION: cross-MODEL (Fable vs the Opus-5.5 fixer), same provider — OpenAI cannot bind loopback for a server-driven test
  (proven rounds 4/5). Substantively found NO break: `verify-bug-196-provider-lock.mjs` re-run twice (both exit 0) and Fable's OWN
  adversarial suite `adv-bug196-verifier.mjs` **13/13 exit 0** (probing server-restart resume with garbage provider `42` + alias model
  pick, a post-release catalog-only model id `sol-2-turbo`, and live-detached reattach with a contradicting provider). But Fable never
  emitted the VERDICT/CLAIM/FIXER-TEST/ADVERSARIAL/UNTESTED sections even after the one corrective re-prompt, and left the fixer MATRIX
  test orphaned (2 hung server pairs in its cleanroom, reaped) — so the harness rejected the answer mechanically. No `Verified-by:`
  line is emitted for an INVALID verdict.
- **Attempt 2 — anthropic/claude-sonnet-5 run a06ef03c-b5a9-4b7f-bb34-e4324569b5d2 (cleanroom-verify-nCe8z9 / record-Gtfw0G): INVALID
  (exit 3).** Re-dispatched on Sonnet 5 (more contract-compliant) against the SAME validated iso tree, to grade both fixer tests and
  produce a well-formed verdict. It recorded 12 runs and again found NO deterministic break, but AGAIN did not emit a well-formed
  citation block even after the one corrective re-prompt (INVALID: no VERDICT line, missing CLAIM, no FIXER-TEST/ADVERSARIAL citation,
  empty UNTESTED). Recorded runs (from `record-Gtfw0G/manifest.jsonl`, harvested by this lane for the record only — NOT a substitute
  for a valid verdict):
  - `verify-bug-196-provider-lock.mjs` **60/60** twice (runs 62d5a72d7633, 0cba81164118; exit 0).
  - `verify-bug-196-matrix.mjs` UNIT leg (classifier) exit 0 and WIRE leg **134/134 frames** (e1939ffc4d9d, 38d6d8a8851f; exit 0).
  - Sonnet's OWN adversarial suites PASSED: concurrent resume of a never-imported native Codex rollout 5/5 (adversarial-bug196-race,
    real run 3e29d8a22ac5 — both resumes reached session-init and agreed engine=openai, backfill JSONL intact; its one exit=1
    203e7f7540f9 was a `runtime check pending` warmup, not a break); resume across server crash/restart 6/6 (adversarial-bug196-restart
    069f1f..., exit 0).
- **THE ONE UNGRADED IN-SCOPE SIGNAL — matrix CLIENT (real-Brave) leg.** Failed exit 1 in every attempt (514cb252a710, f7048292bbfe,
  5d4770038b5c, 0b6f02b905df) from TWO causes: (1) headless-Brave `page.waitForFunction: Timeout 30000ms at boot` (matrix.mjs:462) —
  ENVIRONMENTAL cleanroom browser-boot load, all pre-fatal checks passed (390/390, 64/64); and (2) when it DID boot, exactly 1 cell
  failed per run (119/120), a DIFFERENT cell each run but ALWAYS the `pick=alias · openai · read=ok` signature — the client shows
  `providerView=null` / `#provBtn data-provider="unknown"` / no lock explanation while the SERVER side is fully correct (provider
  openai, the alias pick properly ignored + announced). Single-different-cell-per-run + boot timeouts reads as browser-timing FLAKE
  (the pin not yet painted when the assertion fired), but the consistent alias-pick association is a weak hint that alias cells settle
  slower. This is in-scope BUG-196 UI-lock territory (NOT out-of-scope 205/206/208/209) and was NOT cleanly graded either way.
- **Verifier's UNTESTED / could-not-test:** not captured — the missing UNTESTED section is itself part of why both answers were
  INVALID. Known-untested by construction: the matrix real-browser CLIENT leg (cleanroom page-boot timeout); real Codex/Claude engine
  turns (fake app-server / stub); container-isolation projects (direct only); two genuinely-live tabs.
- **regressed-from:** n/a (verify lane; no code changed).
- **High-stakes flag:** session-lifecycle + provider/model routing + persisted data. Verdict is INVALID (not BROKEN, not HOLDS): the
  round-6 fix is NOT confirmed broken by any recorded deterministic test, but it is also NOT independently VERIFIED. **Decision for the
  orchestrator:** (a) re-dispatch a third verifier for a contract-valid verdict, telling it up front that the matrix CLIENT leg's
  browser-boot timeout is a known cleanroom-infra limitation to cite as UNTESTED (not a break) and to grade unit+wire+provider-lock as
  the fixer-test evidence — the ambiguous exit=1 matrix CLIENT runs are the most likely cause of both verifiers hedging into
  non-compliant prose; (b) have a lane reproduce the matrix `pick=alias·openai·read=ok` cell OUTSIDE the constrained cleanroom (generous
  browser timeout) to settle flake-vs-real before closing — recommended, this is regression-prone UI+session-lifecycle territory; and
  (c) the repeated contract-INVALID from BOTH decorrelated models may warrant a verifier-prompt/harness fix (two models, two
  format-INVALIDs — the harness is not extracting a verdict from either).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` + `board:check` run after the edit.
  Kept clean rooms + record dirs under `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-15cyn5/record-NCjFuj and
  cleanroom-verify-nCe8z9/record-Gtfw0G), plus the iso tree + build script + req + logs + verdicts at
  `~/.local/state/claude-station/scratch/bug196-r6-verify/` (verdict-sonnet.json, verify-sonnet.log; the Fable pass at verdict.json,
  verify.log). No leftover processes; own cleanroom servers reaped, other lanes' rooms untouched.

### 2026-09-29 — fixing lane, round 7 (settle the matrix CLIENT 1-cell signal: race or flake; Opus 5.5)
- **Verdict: HARNESS/ENVIRONMENT, not a client race.** The hypothesis (alias resolution / the classifier paints before the
  declared lock lands and never repaints) is REFUTED by forced ordering; the "always alias" association was coincidence.
- **The real event order (instrumented: every `/api/transcript/` request/response/failure per cell, wall-clocked).**
  Reproduced outside the clean room on the real tree, free port, full `--leg=client --engine=openai`: run 1 **119/120**, the
  failing cell `openai · pick=garbage · project=equal · read=ok · clientProvider=garbage` (not alias), same five-item
  signature (`providerView null`, `#provBtn data-provider=unknown`, title not explaining, popover/drawer pressed []). Trace:
  `+116 ms req …/<id>?limit=400&tail=200` → `+202 ms FAILED net::ERR_NETWORK_CHANGED`. The browser aborted the read; no
  response ever reached `openSession`, so `declareLockedProvider` never ran and the catch path painted "could not read this
  session" — the round-6 designed FAILED-read state (engine unknown, locked, explained). The old harness waited on the pin
  with `.catch(() => {})` (15 s swallowed) and then graded the cell as `read=ok`, a precondition it never had.
  Source of ERR_NETWORK_CHANGED: Chromium aborts in-flight requests when a host interface appears/vanishes; `ip -ts monitor`
  logged ~1k docker0 veth link events in a minute during runs (bursty; 0 in a 45 s idle window, 0 over a 75 s boot-only of the
  server under test), attributed to other host workloads (BuildKit `runc … buildkit/executor` RUN step at 19:18:50, short-lived
  container shims; none started by this suite — its projects are `direct`). Runs 2 and 3: 120/120 each (run 2 saw 10
  ERR_NETWORK_CHANGED on non-transcript requests, run 3 none). A later full run hit it NATURALLY on an alias cell again
  (`alias · project=other · clientProvider=absent`, 16:15:26Z) — retried, passed. The same class explains the clean room's
  boot FATAL (`waitForFunction` 30 s at boot: the page's own `/api/projects` fetch aborted).
- **User reality (stated, not hidden):** a real user CAN have a transcript read fail this way (docker churn on the same host);
  they then see "could not read this session" and the designed unknown/locked/explained engine state, which converges on the
  next send (session-init declares) — proven below. That is the round-6 failed-read contract, not a divergence. Whether the
  CLIENT should auto-retry a transcript read aborted at network level is a separate product question, not BUG-196 scope; not filed.
- **Forced-ordering proof (new ORDER leg, `--leg=order`, 24 cells: engine × pick {alias,none,valid} × {same/absent,
  other/garbage} × mode):** (late) the read is HELD 2500 ms; the button is read, the provider popover and the Settings drawer
  are OPENED and left open while unknown; the before-snapshot is asserted UNKNOWN (ordering really forced — the check fails if
  the pin landed first); the pin then lands with no user action and the SAME open surfaces must show the pinned engine,
  locked, explained. (netfail) the read is aborted by the browser (`internetdisconnected`): the surfaces must reproduce the
  clean-room signature (grades FAIL as read=ok, PASS as the designed failed-read state), then a real `submit()` must converge
  them (openai: session-init `lockedProvider=openai` → pin + view openai; anthropic: view via effective-config — the Claude
  stub exits before session-init, so pin-by-session-init is proven on openai only). **Real tree 24/24.**
  - MUST-FAIL (deterministic, real code with one line removed): a copy of the tree with `paintProvSurfaces()` deleted from
    `declareLockedProvider` (the exact "paints before the declaration, never repaints" bug) → ORDER late cells **FAIL 2/2**
    (after: `#provBtn data-provider=unknown`, open popover/drawer pressed []). Patch at `bug196-r7/tree-norepaint.patch.txt`
    (copy removed). Plus a synthesized "never repainted" snapshot graded FAIL.
  - MUST-FAIL of the clean-room symptom (deterministic): `--leg=client --engine=openai --read=ok --pick=alias --no-env-retry
    --inject-netfail` → **12/12 FAIL** with the IDENTICAL five-item why-list the clean room recorded.
- **Harness fix (hunks `BUG-196 round 7`, `scripts/verify-bug-196-matrix.mjs` only; no product file touched):** the client
  cell now waits on the read's OUTCOME (pinned, or the failure path painted) instead of a swallowed timeout; a `read=ok` cell
  whose transcript read the BROWSER failed (`net::ERR_*`, not ERR_ABORTED; never an HTTP status, so an app error is graded, not
  retried) is re-seeded and re-run, ≤3 attempts, every retry printed with its error + time; boot() retries likewise only when a
  browser-level failure was seen. Added: per-cell transcript trace on failure, a browser-level-failure summary,
  `--pick/--project/--cprov/--repeat`, `--inject-netfail`, `--no-env-retry`, and the ORDER leg (in the default legs).
- **Failure rates.** Before (old wait, natural): alias·openai·read=ok 0/36 (×3 repeat) + 0/12 ×3 in full runs; any read=ok
  cell 1/360 across 3 full openai runs (environment-driven, bursty — hence the deterministic injection). Injected: **12/12 FAIL**
  without retry. After: alias·openai·read=ok **36/36** (×3, natural, 0 env events) and **36/36** with a forced abort on EVERY
  cell (36 retries); full client openai **120/120** (1 natural ERR_NETWORK_CHANGED retried), client anthropic **120/120**,
  unit+wire **179/179 checks (134/134 frames)**, order+fresh **51/51 (24/24 + 20/20)**. Retry does not mask a real break: the
  frozen round-5 tree (`BUG196_TREE=…/bug196-r6/tree-pre`) still **0/120** client openai cells (6/126 checks), as in round 6.
- **Anti-regressions:** `verify-bug-196-provider-lock.mjs` **60/60**; `npx tsc --noEmit` exit 0; `npm run gate` exit 0 (unpiped).
- **regressed-from:** n/a for the product. The harness defect (swallowed pin-wait timeout grading an environment-failed read as
  `read=ok`) is from BUG-196 round 6's own matrix script.
- **Risk bucket:** test-harness only; no product behaviour changed. The round-6 product fix still needs its contract-valid
  independent verdict; that verifier can now cite the matrix CLIENT leg as gradable (env retries are printed, not hidden).
- Logs: `~/.local/state/claude-station/scratch/bug196-r7/` (full-openai-1..3, ipmon-*, ps-wire2, mustfail-*, after-*, final-*,
  order-*, provider-lock). No git writes; no containers created; own scratch servers/browsers exited with each run.

### 2026-09-29 — independent clean-room verify lane, round 7 (verify class, Opus 4.8 orchestrating; verifier anthropic/claude-sonnet-5)
- **Verified-by:** dispatch anthropic/claude-sonnet-5 run 32340bd0-5e4c-4b96-a36e-0981e2bebe39
  (clean-room `cleanroom-verify-ZThoHd`, record `cleanroom-record-cSOplS`, `scripts/independent-verify.mjs
  --working-tree` over an isolated BUG-196-ONLY tree; **VERDICT-CONTRACT: INVALID, independent-verify exit 3**)
  — **NO CONTRACT-VALID VERDICT; NOT VERIFIED STANDS.** But this round is materially different from round 6:
  the verifier FINISHED, ran the bounded evidence set exactly, and wrote a full citation block whose only
  substantive signal is **HOLDS** (no break found). Per the charter, the lane did NOT loop on the INVALID.
- **Provider/model choice (charter, BUG-211):** anthropic/claude-sonnet-5. Fable was the model the safety
  classifier truncated in round 6 (BUG-211), so per the charter's preference the more contract-compliant
  Sonnet 5 was used. SAME provider, cross-MODEL from the Opus-5.5 fixer; cross-provider OpenAI remains
  impossible for this server-driven fix (codex `workspace-write` blocks loopback `bind()`, proven rounds 4/5).
- **Isolation (verifier saw ONLY BUG-196 hunks) — CLEAN, reusing the validated round-6 iso tree.** Round 7's
  only product-relevant change was a HARNESS fix to `scripts/verify-bug-196-matrix.mjs` (no product file), so
  the BUG-196 PRODUCT diff is identical to round 6. Reused the round-6 `bug196-r6-verify/iso-only` tree (HEAD
  a977e76 + BUG-196-only hunks over the 7 touched files, already validated in round 6) and REFRESHED the two
  fixer-test scripts to the round-7 working-tree versions (matrix now carries the round-7 bounded legs +
  subset flags `--leg=unit,wire,client,order,fresh --pick= --project= --cprov= --repeat= --inject-netfail
  --no-env-retry`). Re-validated BEFORE dispatch (round-6 parity): `npx tsc --noEmit` exit 0 on the iso tree;
  **0 foreign-ticket markers** in any added product line (grep for BUG-194/195/198/205/206/208/209,
  FEAT-154/155/156, containerStoreDirName/declaredContainerStore/workspaceRoot/MEM_CYCLE/gpuRow/dockerfile —
  none); `verify-bug-196-provider-lock.mjs` **60/60 exit 0** on the iso tree (fix intact after isolation).
  independent-verify stripped docs + the ambient set (CLAUDE.md/AGENTS.md/.claude/.codex, docs/bugs,
  docs/prompts) unconditionally with a post-strip assertion; the **full 203114-byte diff reached the verifier
  UNTRUNCATED** (`--max-diff-bytes 300000`); diff allow-list 9/9 paths (7 product + the 2 refreshed test scripts).
- **BUG-211 mitigation applied to the verifier prompt (req-r7.txt), and it WORKED.** The requirement told the
  verifier up front to keep runs BOUNDED, to write the VERDICT/CLAIM/FIXER-TEST/ADVERSARIAL/UNTESTED block
  before any job >~5 min and never end on a status line, to run the FIXED bounded set (provider-lock once;
  matrix `--leg=unit,wire,order,fresh`; ONE small client sample; NOT the full 240-cell matrix), to spend the
  rest on NEW attacks, and to cite docker-churn `net::ERR_NETWORK_CHANGED`/browser-boot timeouts as UNTESTED
  not breaks. Only `verify-bug-196-provider-lock.mjs` was passed as a `--test-file` (safe to re-run wholesale);
  the matrix was left to the requirement's bounded flags so composePrompt's generic "re-run it" could not
  reintroduce the full-matrix trap. Result: the round-6 symptom ("verifier never wrote a verdict, burned the
  turn on the 240-cell matrix") is GONE.
- **Recorded runs (manifest `cleanroom-record-cSOplS/manifest.jsonl`, 7 runs, ALL exit 0):**
  `verify-bug-196-provider-lock.mjs` **60/60** (14be09fc048b); `verify-bug-196-matrix.mjs
  --leg=unit,wire,order,fresh` (115cef2664a7, b371030496dd, 5648b94f28a0 — ran 3×, all exit 0);
  `verify-bug-196-matrix.mjs --leg=client --engine=openai --pick=alias` (ed661993ed97 exit 0 — the bounded
  client sample, no env-churn abort); and the NEW adversarial `scratch-adversarial-reopen.mjs`
  (c09b5d3fdcfc exit 0). Warmup `echo hello` (947944b9707c).
- **Verifier's substantive answer (harvested from its session transcript — the harness does not echo an
  INVALID reply):** VERDICT **HOLDS**. Its one NEW adversarial attack — **reopen-after-failed-read** — PASSED:
  it closes and reopens the identical session after a first transcript read FAILS and a second SUCCEEDS, and
  the composer button + provider popover + Settings drawer all REPAINT from unknown/locked to the real
  declared engine rather than sticking (it noted the shipped suite's (m1) only delays a read within one open
  and (m2) only tests a permanently-failed read — neither exercises the close/reopen recovery path). UNTESTED
  (honest): a genuine multi-process server RESTART mid-session (judged low-risk — `resumeProviderOf` is
  file-based, no server-side cache — but not run); a concurrent double-resume race on ONE never-imported
  native Codex rollout (`importNativeCodexSession` read-then-rename inspected in source, judged not a
  correctness break since both writers derive the same engine, but not run live); true two-OS-process tab
  concurrency (only serial Playwright pages, not two concurrent drivers); the 234 remaining client-leg cells
  outside the bounded openai/alias sample.
- **WHY IT IS INVALID (the ONLY reason):** the verifier emitted **3 `FIXER-TEST:` lines** (provider-lock +
  two matrix legs) where the citation contract allows **exactly one**; the single sanctioned corrective
  re-prompt did not collapse them. This is a direct side-effect of the BUG-211-bounded instructions, which by
  necessity hand the verifier MULTIPLE fixer-test commands to run and cite. No `VERDICT`/`CLAIM`/`ADVERSARIAL`/
  `UNTESTED` violation — those were all well-formed. So the substance is a clean HOLDS with a passing new
  adversarial attack, but the answer is not contract-valid, so NOT VERIFIED stands.
- **HARNESS follow-up (belongs to BUG-211).** BUG-211's fix (bounded runs) succeeded at getting a real verdict,
  but exposed a second harness/contract collision one layer up: the "exactly one `FIXER-TEST`" rule
  (`scripts/lib/verdict-contract.mjs`) is incompatible with the bounded MULTI-run fixer evidence BUG-211
  itself requires. Remedy options for that ticket's owner: (a) accept ≥1 `FIXER-TEST` citation; or (b) have
  the verify requirement name exactly ONE canonical fixer test (provider-lock) and instruct the verifier to
  cite the matrix legs under `ADVERSARIAL`/an extra label. Recorded here so a round-8 verify does not repeat it.
- **Independent-skeptic note (high-stakes).** This is session-lifecycle + provider/model-routing + persisted
  data in a regression-heavy file; a clean-room independent verify was exactly the right instrument and it
  returned HOLDS on substance. The verdict is nonetheless not contract-valid, so VERIFIED is NOT claimed —
  the decision on whether the strong-but-INVALID HOLDS plus the harness collision warrants (i) a round-8
  re-dispatch after BUG-211's contract is loosened, or (ii) accepting the substance, belongs to the orchestrator.
- **Cleanup / no orphans:** the verifier reaped its own scratch servers/browsers; a scan found NO live process
  or container referencing clean room `ZThoHd`. Two unrelated older clean-room servers (`cleanroom-verify-PREwf2`
  ~28 h old, `cleanroom-verify-Jy6IZS` ~2.6 h old) and hours-old `cs-diagp-*` brave procs belong to other/older
  lanes and were NOT touched (kill only what this lane spawned). Kept clean room + record dir under
  `~/.local/state/claude-station/scratch/` for audit (cleanroom-verify-ZThoHd / cleanroom-record-cSOplS), plus
  the iso tree, requirement (`bug196-r7-verify/req-r7.txt`), log and verdict (`bug196-r7-verify/verify.log`,
  `verdict.json`).
- **regressed-from:** n/a (verify lane; no code changed).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` +
  `board:check` run after the edit.

### 2026-09-29 — independent clean-room verify lane, round 8 (verify class, Opus 4.8 orchestrating; verifier Sonnet)
- **Verified-by:** dispatch anthropic/claude-sonnet-5 run 8f1cfcb0-1b98-4ffd-87c7-5b36adeb9b9e (clean-room
  `cleanroom-verify-nDn2qi`, record `cleanroom-record-y42Knh`, `scripts/independent-verify.mjs --working-tree`
  over the isolated BUG-196-ONLY tree `bug196-r6-verify/iso-only`; contract VALID, manifest-backed [6 recorded
  runs], independent-verify exit 0) — **VERDICT: HOLDS.** This is the first contract-VALID verdict for this
  ticket that also PASSES; **status → VERIFIED.**
- **Why round 7 was INVALID and how this round fixed it (charter correction, harness/procedure only — no code
  changed).** Round 7 returned a substantively-correct HOLDS that the contract rejected for exactly ONE reason:
  the verifier emitted **3 `FIXER-TEST:` lines** where the contract (`scripts/lib/verdict-contract.mjs`) allows
  exactly one. Root cause was the charter, not the fix: the round-7 requirement handed the verifier THREE
  fixer-test commands (provider-lock + two matrix invocations) and told it to "cite the run id for each". Round
  8 rewrote the requirement (`bug196-r8-verify/req-r8.txt`) so there is exactly ONE canonical FIXER-TEST —
  `node scripts/verify-bug-196-provider-lock.mjs`, the only `--run` passed — with the matrix legs + one small
  client sample relabelled as SUPPORTING/ADVERSARIAL runs (never a `FIXER-TEST:` line), and quoted the
  harness's own "exactly one is allowed" rule verbatim near the top with the exact block format. The verifier
  emitted exactly one FIXER-TEST line; no corrective re-prompt was needed.
- **Reused round 7's construction EXACTLY** (per charter): same isolated BUG-196-only tree
  `bug196-r6-verify/iso-only` (working-tree snapshot HEAD a977e76 → tree 40642261fc07), same 9-path allow-list,
  docs stripped, same model anthropic/claude-sonnet-5, `--keep-cleanroom`. One necessary flag re-added to match
  round 7's evidence: `--max-diff-bytes 300000` so the full **203114-byte diff reached the verifier
  untruncated** (the default 60000 would have truncated it). Pre-flight on the iso tree: `tsc --noEmit` exit 0,
  BUG-196 fix markers intact (`resumeProviderOf` owner + 14 client `lockedProvider*` sites).
- **FIXER-TEST (the ONE canonical test, re-run once):** `node scripts/verify-bug-196-provider-lock.mjs` → exit 0,
  **60/60** (manifest fe8317835e33). Every path the fix targets is green in the clean room: server declares
  `lockedProvider` from the transcript (both engine directions), reopen/reload/new-session-first-turn,
  foreign-dock lock across a real project switch, drawer session-scope control (pre-pin held, failed fetch,
  after-pin, and control), pickProvider refusal + no override armed, and the pre-fix synthesized must-FAIL
  reddening without `lockedProvider`.
- **ADVERSARIAL — a NEW case beyond round-7's reopen-after-failed-read (invalid-model-pick-equals-project-default,
  manifest 82bb5b496caa, exit 0, HOLDS):** the canonical fixer test never sets `project.settings.model`, so it
  cannot construct the round-4 regression shape — an explicit model pick that is invalid for the pinned engine
  AND textually equal to the project's own default model (the equality the pre-round-6 "drop an override equal to
  base" merge used to swallow SILENTLY). The verifier set a project default of `claude-opus-4-1` (anthropic),
  pinned the resumed session to openai via a real on-disk transcript, and sent a raw `start` frame with
  `overrides.model='claude-opus-4-1'` directly over the wire (bypassing the client). The server ANNOUNCED it
  ("ignored your model pick (claude-opus-4-1): not a OpenAI Codex model…"), listed it in
  `effective-config.ignoredOverrides`, dropped it from `overridden`, ran on `provider=openai`, and never let the
  claude model leak into `effective.model`. req-3 satisfied in the openai direction.
- **DECORRELATION (honest limitation).** SAME provider (anthropic) as every fixer, DIFFERENT model (sonnet-5 vs
  the Opus 4.8 / Opus 5 fixers). Cross-provider (openai) was not used this round (charter pinned the model to
  anthropic/claude-sonnet-5 to isolate the round-7 contract fix). The prior rounds' cross-provider caveat still
  applies as a residual limitation — but this round's job was to obtain a contract-VALID verdict with the
  corrected FIXER-TEST framing, which it did.
- **UNTESTED (verifier's own honest list; none is a break):** the bounded supporting matrix legs
  (unit/wire/order/fresh) were not run under turn budget, so the full pick×project×client cross product is not
  directly re-verified here (the round-6 fixer suite ran the full 240-cell matrix green, and round 7 ran the
  bounded legs green); true concurrent two-tab access to one locked session; reattach after a REAL server-process
  restart (vs. the in-process `nothing-to-reattach` checks); the real headless-browser CLIENT/ORDER DOM legs
  under forced read-timing races (host docker-churn `net::ERR_NETWORK_CHANGED` limit — environment, not code).
- **Out of scope, not counted as breaks (per charter):** BUG-205 (trailing-sep native rollout 404), BUG-206
  (dual-store id engine ambiguity), BUG-208 (drawer PROJECT-scope model row / cost-model pricing prefix),
  BUG-209 (playwright QA specs fail to load). Network churn is UNTESTED, not a break.
- **Independent-skeptic note (high-stakes).** Session-lifecycle + provider/model-routing + persisted data in a
  regression-heavy file — a clean-room independent dispatch (not an in-process subagent) was the right
  instrument and returned a contract-VALID HOLDS with a passing NEW adversarial case. The residual decorrelation
  gap (same provider, no cross-provider openai run this round) is the one caveat on this VERIFIED; a future
  cross-provider (openai) re-verify when its window allows would fully close it, but is not required to hold the
  verdict.
- **Cleanup / no orphans:** the two partial clean rooms from a first launch aborted for diff truncation
  (`cleanroom-verify-hBGXcC` / `cleanroom-record-qcitT1`) were left in place after the command-guard paused their
  removal — they are inert and harmless. The verifier reaped its own scratch servers/browsers; only pids this
  lane spawned were signalled (no `pkill`, port 4317 untouched). Kept clean room + record dir for audit
  (`cleanroom-verify-nDn2qi` / `cleanroom-record-y42Knh`), plus the round-8 requirement, log and verdict under
  `~/.local/state/claude-station/scratch/bug196-r8-verify/` (`req-r8.txt`, `verify.log`, `verdict.json`).
- **regressed-from:** n/a (verify lane; no code changed; the fix was left untouched).
- **Not done (no authority):** no git writes; ticket status header + this entry only; `board:gen` +
  `board:check` run after the edit.
