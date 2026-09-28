# BUG-190 — a message delivered after a restart vanishes from the open view, and the FEAT-064/065 suites were red

- **Status:** VERIFIED (pending commit) — round 5 HOLDS on a round-7 clean-room independent verify (run `82b90645`), which was SAME-PROVIDER (anthropic/claude-fable-5-1; OpenAI was parked). The empty-session first message and the bridge-drawn view both converge across a reconnect. A cross-provider (openai) confirm is still warranted when quota returns. Two suites that need a real Claude turn (`verify-health-survivor`, `verify-restart-reconnect-race`) remain unrunnable until the default account is signed in again (OAuth expired) — neither loads the round-5 change.
- **Severity:** medium
- **Area:** client (transcript follow) / verification tooling (`verify:feat-064-drain-truth`, `verify:feat-065-delivery`)
- **Reported:** 2026-09-27 by BUG-187 build lane (round 2), filed by the FEAT-064/065 fixing lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
Two things, found together.

1. The user sends a message into a session that is still finishing after a server
   restart. Orchard delivers it into that still-running session (FEAT-065). The
   message does not appear in the open view, and neither does the reply. A reload
   shows both. Orchard also removes the optimistic bubble at that moment, because it
   expects the transcript to re-render it, so the user sees their message disappear.
2. `verify:feat-064-drain-truth` failed 2 checks and `verify:feat-065-delivery`
   failed 3, identically on clean HEAD 541dd73. Run as they stand on the current
   tree, both died in setup ("seed turn never started"), so no check ran at all.

## Repro
1. `node scripts/verify-feat-065-delivery.mjs`. S5 fails "the injected turn renders
   LIVE in the open session view" and "appears EXACTLY ONCE in the client DOM"
   (0 occurrences). The store and the engine input log each hold exactly one copy.
2. Watch-socket trace from the same run: the tab is already following the session
   (`startCursor 277490`). On the `deliveredVia:survivor` ack the client sends
   `unfollow` + `follow`, and the new follow starts at `278294`. The 804 bytes in
   between are the delivered user line and the reply. The survivor wrote them
   within milliseconds of the stdin write, inside the watcher's 150 ms debounce.

## Expected
The delivered message and its reply stream into the open view. Both suites run
green on the working tree, and each assertion states the behaviour intended today.

## Context pack
- `public/app.js`: the `ack` / `deliveredVia === 'survivor'` branch, and `followCurrent()`.
- `src/server/watcher.ts` `watchSession()`: a new watch starts at the file's current end, and `stopWatch()` drops bytes it has not read yet.
- `scripts/verify-feat-064-drain-truth.mjs` S3c, `scripts/verify-feat-065-delivery.mjs` S3/S5, `scripts/lib/host-admission.mjs`, `scripts/lib/station-boot.mjs` `isolatedStoreEnv`.
- Related: FEAT-064, FEAT-065 (the 2026-08-12 "S5 flake" note is this race), BUG-134 (changed the chip), FEAT-035 (rebrand), FEAT-151 (boot runtime check), BUG-161 (store-isolation guard), BUG-185 (a different suite that is also red on a clean HEAD), BUG-187.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-27 — FEAT-064/065 fixing lane, round 1
- **Understood:** I checked the board first. No ticket covered these checks. BUG-185 is a different suite (`verify:orchestrator-enforcement`), so I filed this one. The charter's hypothesis was "stale assertions". That held for two of the five failures. It was wrong for S5: S5 is a real product race, not the "browser-timing flake" the FEAT-065 note of 2026-08-12 recorded.
- **Per-check classification:**
  - Setup, both suites, class (c) environment, which has two causes. (1) The store-isolation guard (BUG-161, `assertSessionStoreIsolated`) now refuses the suites' real-CLI seed turn, because they isolated only `CLAUDE_STATION_DATA`. Observed: `REFUSING to create a session … NOT the claude transcript store`. Fixed by `isolatedStoreEnv(DATA/claude-config, { alsoReader: true })`. The seed transcript now lives in scratch, and cleanup of `DATA` removes it. (2) FEAT-151's boot runtime check refuses host sessions with "runtime check pending" until it completes, and health answers before then. Fixed with the new `scripts/lib/host-admission.mjs` `startWhenAdmitted()`, which retries on exactly that refusal (and "checking runtime") and nothing else. Any other error still fails setup, and the error now prints the last 4 events.
  - FEAT-064 S3c ×2, class (b) obsolete. BUG-134 (commit `e9efb92`) deliberately replaced "held Ns by N background agent(s) … retries itself" with the row's own age plus "retries every few seconds". The BUG-134 log says it never exercised the chip. Assertions now follow the BUG-134 contract: `waiting on drain — … queued Ns ago` and `retries every few seconds`. I added a third check that the chip names no background agent, no task id and no "held Ns by". The old wording therefore fails.
  - FEAT-065 S3 (deny notice), class (b) obsolete. The user-facing rebrand (FEAT-035) changed the text `denied by claude-station` to `denied by Orchard` (`survivor-delivery.ts:177`). The regex was updated. It still requires the notice, `allowed:false` and a deny under 10 s.
  - FEAT-065 S5 ×2 (renders LIVE; exactly once in the DOM), class (a) real defect. On the `deliveredVia:survivor` ack, `app.js` called `followCurrent(true)`, which sends unfollow and then follow. The unfollow stops the server watch (`watcher.ts` `stopWatch`), and the new watch starts at the file's current end. Watch trace from a real run: the existing follow was at `startCursor 277490`, and the re-follow came back at `278294`. The 804 bytes in between are the delivered user line and the reply, written inside the 150 ms debounce. They are never streamed. `app.js` had already removed the optimistic bubble, so the user's message vanishes until a reload. Fix: `if (!state.following) followCurrent(true);`. An existing follow of this session is kept, so it streams those bytes. `regressed-from: FEAT-065` (introduced there; the 2026-08-12 note misclassified it as a flake).
- **Changed (all unstaged):**
  - `public/app.js`: the survivor-ack branch, one guard plus a comment.
  - `scripts/lib/host-admission.mjs`: new.
  - `scripts/verify-feat-064-drain-truth.mjs`: store isolation, admission retry, S3c.
  - `scripts/verify-feat-065-delivery.mjs`: store isolation, admission retry, `findTranscript` reads the scratch store, S3 regex.
  - This ticket.
- **Verified:**
  - Before, as they stand: both suites fail in setup with `FATAL: seed turn never started`, EXIT 1.
  - With the store and admission fixed but no product fix: I did not run `verify-feat-064` with the old S3c assertions after the setup fix. My S3c edit landed first, and the earlier run died in setup. The evidence that the old S3c fails is the BUG-187 lane's 16/18 (S3c ×2), plus the chip text this lane observed: `1 queued message · waiting on drain — the session is mid-reply; this retries every few seconds and goes in at its next pause · queued 0s ago — edit or discard below`. The old regexes `held \S+ by 1 background agent` and `retries itself` cannot match that text. `verify-feat-065` gave `32/35`: S3 regex, S5 renders LIVE `{"replyLive":false}`, S5 exactly-once `{"userBubbleOccurrences":0}`. This is identical to the BUG-187 lane's result on the working tree and on pinned 541dd73.
  - Must-FAIL for the class (a) fix: S5 failed 3 of 3 runs without it (the full suite once, and a scratch S5-only copy twice). With the fix in a scratch copy of `app.js`, S5 was 11/11.
  - After, on the working tree: `node scripts/verify-feat-064-drain-truth.mjs` gave `19/19 checks passed`, EXIT 0. `node scripts/verify-feat-065-delivery.mjs` gave `35/35 checks passed`, EXIT 0, in two separate runs.
  - `node scripts/verify-bug-187-responderless-cli.mjs` gave `72/72 checks passed`, EXIT 0. `npx tsc --noEmit -p .` gave EXIT 0.
  - Anti-regression, through throwaway copies (the same seed-store and admission issues, deleted afterwards): `verify-bug-074-ghost-drain` 11/11 and `verify-restart-reconnect-race` 10/10.
- **Found along the way, not fixed (outside this ticket; possibly BUG-187 territory):** `verify-bug-072-delivery-visible` (throwaway copy, seed-server wait only) ran 22/47. The first failure is S1: `{"liveBridges":1,"adopted":true,"state":"detached-running"}`. The survivor is adopted at boot, where the suite expects it to stay surviving-unadopted, and every later S2/S3/S5 check depends on that. S1 to S3 are raw WS/HTTP checks and never load `app.js`, so this change cannot cause them. I did not re-run 072 against pinned 541dd73, so the cause is not established.
- **Could not test:** a real browser (brave/CDP) render of the delivered turn. S5 uses happy-dom running the real `app.js`. The residual race remains when the tab was NOT already following at the ack: a fresh follow still starts at EOF. That arises only when the view had no watch, for example when this tab was previously the bridge driver.
- **Still open / handoff:** independent clean-room verify, because a class (a) change landed in the client's session-lifecycle path. Suggested attack: a survivor delivery where the tab is not following at the ack. Also: the `verify:*` suites that seed a real CLI all share the setup breakage (the BUG-187 log counts 9). They could adopt `startWhenAdmitted` and `isolatedStoreEnv`, but that belongs to their owners, not this ticket.

### 2026-09-27 — independent cross-provider clean-room verify (courier lane)
- **Verdict: BROKEN.** The openai verifier ran the real fixer suites plus real-Chromium probes over the isolated BUG-190 diff (the app.js guard, `host-admission.mjs`, and the two verify scripts only). It concluded the fix does NOT satisfy the requirement "a message delivered into a still-running session appears in the open view, and the view must not skip lines when it re-subscribes."
- **Contract note (read before dismissing):** the harness auto-graded the verdict `INVALID` on a FORMAT technicality only — the reply carried two `FIXER-TEST:` citation lines (one per suite I supplied) where the contract allows exactly one. Evidence is complete and real: both suites re-run, 5 adversarial attacks incl. the required real-browser one, and an untested list, all citing recorded runs. Manifest: 32 runs at `~/.local/state/claude-station/scratch/cleanroom-record-BPqSVK/manifest.jsonl`; kept clean room `~/.local/state/claude-station/scratch/cleanroom-verify-I33oYA`. Cited run exit codes verified from the manifest.
- **Findings — REAL defects (in BUG-190 scope):**
  1. **Reconnect/disconnect gap still loses the delivered turn (core symptom, UNFIXED for this case).** Real-browser `delivery-gap` (run `f7593ca2be6b`, exit 1) and `gap` (run `6c20a005f64c`, exit 1): with the watch disconnected, a survivor-delivered message + reply, and four lines appended during the gap, persist to store/transcript but render NEITHER; a reload then shows them exactly once. A later control line (written after reconnect) renders, proving the gap bytes specifically are dropped. This is precisely the fixer's own "Could not test" residual race (fresh follow starts at EOF when the tab had no watch). The guard only helps when the tab was ALREADY following.
  2. **`host-admission.mjs` `startWhenAdmitted` returns success on a fatal non-runtime error.** `independent-admission.mjs` (run `3a4c2c2113f7`, exit 1): given a fatal permission error AND a runtime-pending error, the helper retries and reports success instead of failing on the non-admission error. New BUG-190 code; contradicts its stated "retry only on runtime-pending/checking-runtime, fail on anything else" contract.
- **Findings — COSMETIC / OUT OF SCOPE:**
  3. Split-UTF-8 emoji corrupts to replacement chars (`split-utf8-write` run `b8c67b33d706`) — in `src/server/watcher.ts`, which BUG-190 does NOT touch. Pre-existing, not a BUG-190 regression; note for the watcher owner.
- **What HELD:** both suites green (`762e94c43b04`, `b0b69d08885e`, exit 0 — 19/19, 35/35) and ordinary survivor delivery renders exactly once in a real browser (`6f7f409085e6`, exit 0). So the narrow reported repro is fixed; the broader requirement is not.
- **Verifier's UNTESTED list:** long disconnects and mid-reconnect session-switching (attacks (b)/(c)) beyond the one interval probed; real model-generated survivor replies (probes used the fake survivor CLI with the real server/broker/transcript store + real Chromium).
- **Decision the orchestrator must take:** either (A) RESCOPE BUG-190 to the already-following case and file the disconnect/reconnect gap as its own ticket (the fixer explicitly scoped it out), or (B) REOPEN BUG-190 to also cover the re-subscribe-after-disconnect gap. Finding 2 (host-admission) should be fixed regardless.
- **Verified-by:** `dispatch openai codex-default (codex-cli 0.158.0-alpha.15.2) run 01a0e30f-02bf-7600-9ec7-21d846582b70 (clean-room, scripts/independent-verify.mjs, isolated diff dcd4364..2a43b94) — VERDICT: BROKEN (harness format-INVALID; evidence complete, corroborated)`. Sandbox preflight (BUG-189) ran clean first (0.158.0-alpha.15.2, workspace-write).

### 2026-09-27 — BUG-190 fixing lane, round 2
- **Understood:** the courier verify (run `01a0e30f`) was right on both findings. Round 1's guard helped only when the tab was ALREADY following at the ack. The root cause is that nothing carries a resume point across a re-subscribe: a fresh server watch starts at the file's end, so every line written between the last rendered message and the new watch was skipped. While fixing that I found a third defect underneath it. The store API's backward selector labelled indices wrongly when asked for a window past the end, so the page came back with indices that do not exist. Observed from a real browser trace: `tail=120&before=123` on a 3-message file returned indices `120..122`, and that poisoned the index dedupe.
- **Fix (root, not timing):**
  1. `public/app.js`: new `catchUpFollow()`, run on EVERY successful follow (`onFollowStatus` with `following:true`: initial open, watch reconnect, re-follow). It reads the store backward from the file's end down to the view's own high-water mark `th.lastIndex`, using real indices only. It pages further back when the gap is longer than one page, and renders the missed messages in order.
     - Live appends that arrive during the catch-up are buffered in `applyAppend` and replayed afterwards through the existing index dedupe. The read covers everything before the watch started, the watch covers everything after, and the overlap is dropped by index.
     - Each read is bounded at 20 s so a hung read cannot hold the buffer. The `finally` always replays it.
     - `watch()`'s close handler now clears `state.following`, because the watch died with its socket. BUG-191's hunks are untouched.
  2. `src/server/index.ts` (both `?before` sites, the session and subagent transcript routes): `before` is clamped to the real total when the count is exact. It is left unclamped when `totalIsLowerBound`, where the end is unknown. A window named past the end now keeps real indices.
  3. `scripts/lib/host-admission.mjs` `startWhenAdmitted`: it now judges every error event first. ANY non-admission error THROWS without a retry, whatever its order relative to a runtime-pending refusal. A start that never initialises throws. Exhausting the attempts throws. The misplaced doc block (another lane had inserted `waitRuntimeReady` between the doc and the function) was moved back above the function; `waitRuntimeReady` is untouched.
- **New arms:**
  - `scripts/verify-feat-065-delivery.mjs` SECTION 6 runs in a REAL headless browser (Playwright driving brave 150; `VERIFY_BROWSER` overrides the binary) and asserts on the user-visible render (`getByText` exact, count 1, visible, inside `#panes .pane`). It fails loudly if no browser is found.
    - S6a: drop the watch socket, send from the composer, and the turn is delivered into the survivor during the gap. The message and the reply must render exactly once, and still exactly once after settling.
    - S6b: two back-to-back watch drops with lines written in each gap, then a control line after reconnect. All must render exactly once and in transcript order.
    - S6c: the `?before`-past-end index check over HTTP.
  - `scripts/verify-bug-190-host-admission.mjs` is the unit arm, with a pinned verbatim round-1 baseline. A1 and A2 cover a fatal error next to runtime-pending, in both orders. A3 covers a non-fatal non-admission error. A4 covers both admission spellings retried, then success. A5 covers a clean start. A6 covers never initialising. A7 covers every attempt refused.
- **Must-FAIL (before the fix, same tree):**
  - `node scripts/verify-feat-065-delivery.mjs` gave `37/41`, EXIT 1. S6a `{"BUG-190-GAP-DELIVERY":{"count":0},"ECHO:…":{"count":0}}`, both S6a checks. S6b: GAP-1..4 `count:0` while `BUG-190-POST-RECONNECT-CONTROL` `count:1` rendered, so the arm is not vacuous. Plus S6b order.
  - An intermediate client-only attempt, which read with `before=next+page`, gave 37/41: S5 regressed, and S6b showed GAP lines `count:2` with the control missing. That is how the server relabelling was found (trace above). S6c was added for it.
  - Host-admission: the pinned round-1 baseline returns SUCCESS on the verifier's input (`opens:2`, `init sid-ok`). A1's predicate rejects that.
- **Verified (after, working tree):**
  - `node scripts/verify-feat-065-delivery.mjs`: `42/42 checks passed`, EXIT 0, twice.
  - `node scripts/verify-feat-064-drain-truth.mjs`: `19/19`, EXIT 0.
  - `node scripts/verify-restart-reconnect-race.mjs`: `10/10`, EXIT 0.
  - `node scripts/verify-health-survivor.mjs`: `14/14`, EXIT 0.
  - `node scripts/verify-bug-190-host-admission.mjs`: `8/8`, EXIT 0.
  - `node scripts/verify-bug-072-delivery-visible.mjs`: `47/47`, EXIT 0. It is now green as it stands, after another lane's edits, so round 1's 22/47 note is superseded.
  - `node scripts/verify-bug-191-adopt-window-send.mjs`: `BUG-191: 31/31 passed`, EXIT 0.
  - `node scripts/verify-bug-187-responderless-cli.mjs`: `72/72`, EXIT 0.
  - `npx tsc --noEmit -p .`: EXIT 0.
  - `npm run gate`: `GATE: PASS — safe to commit. (exit 0)`.
- **Changed (unstaged):**
  - `public/app.js`: `catchUpFollow`, the `onFollowStatus` hook, the `applyAppend` buffer, and the watch-close `following` reset.
  - `src/server/index.ts`: the two `before` clamps.
  - `scripts/lib/host-admission.mjs`
  - `scripts/verify-feat-065-delivery.mjs`: S6, plus imports for playwright, crypto and execFileSync.
  - `scripts/verify-bug-190-host-admission.mjs`: new.
  - This ticket.
- **Could not test / residual:**
  - A multi-minute disconnect. The arm covers two drops at the 1 s and 2 s backoff steps.
  - Switching sessions in the middle of a catch-up. It is guarded by `stillHere()`, but no arm drives it.
  - A catch-up on a huge file whose count is a lower bound. The clamp is skipped there, and the catch-up reads only backward from `tail`, so it does not depend on the clamp.
  - Real model replies. The arms use the fake survivor CLI with the real server, broker and store.
  - Split-UTF-8 in `watcher.ts` (verifier finding 3) is out of scope and untouched.
- **regressed-from:** BUG-190 round 1, which fixed only the already-following case. Originally FEAT-065.
- **Handoff:** a session-lifecycle and client-render change, plus a server API clamp. A round-2 independent clean-room verify is warranted. Suggested attacks: a session switch during a catch-up; a gap longer than 120 messages; a huge file (lower-bound count).

### 2026-09-27 — round-2 independent cross-provider clean-room verify (courier lane) — BLOCKED (quota window)
- **Verdict: INVALID (infra) — no verdict obtained. NOT a pass and NOT a fail.** The openai/codex verifier dispatch hit its usage-limit window mid-run and exited before producing a citation block, so the executed-evidence contract composed nothing. Fail-closed: an unverifiable change is not a verified change.
- **Route (same shape as run `01a0e30f`):** `scripts/independent-verify.mjs`, cross-provider (`--author-provider anthropic --provider openai`), isolated round-2 BUG-190 diff only. I rebuilt the isolation for round 2 because the round-1 dangling commits were stale: `--range 536d29fe..867ca079` where base `536d29fe` = current full working tree with ONLY the six BUG-190 files reverted (public/app.js, src/server/index.ts, scripts/lib/host-admission.mjs, scripts/verify-feat-064-drain-truth.mjs, scripts/verify-feat-065-delivery.mjs, scripts/verify-bug-190-host-admission.mjs) and head `867ca079` = current full working tree. Verified the range diff is exactly those six files — NO BUG-191/187/189 hunks (app.js +96 / index.ts +10 confirmed pure BUG-190 by cross-checking against round-1 head `2a43b94`). Untracked new files (host-admission.mjs, verify-bug-190-host-admission.mjs) were handled explicitly since `git diff` cannot see them. Designated single FIXER-TEST = `node scripts/verify-feat-065-delivery.mjs` (the S6 real-browser gap arms); feat-064 and the host-admission unit supplied as adversarial/regression evidence, to avoid the round-1 duplicate-FIXER-TEST INVALID.
- **What the clean room DID record before the cut-off (manifest `~/.local/state/claude-station/scratch/cleanroom-record-p2n9Px/manifest.jsonl`):** all three author suites re-run and GREEN in the stripped clean room — `verify-feat-065-delivery` run `dccdce964cb2` exit 0, `verify-feat-064-drain-truth` run `b4fbe1b60783` exit 0, `verify-bug-190-host-admission` run `98f4312fe3a4` exit 0. The verifier had begun its own adversarial probes (partial-JSONL trailing line, multi-page catch-up while the file grows, five rapid reconnects, a failed catch-up read, admission timing) when the quota window hit on `probe-admission-timing.mjs` (run `a74c506f13c2` exit 1 — cut off, not a finding). NO adversarial verdict, NO untested list, NO citation block were produced. These GREEN suite runs are NOT an independent verdict on their own.
- **Observed environment note for the retry (not a finding):** the verifier's shell `which brave chromium chromium-browser google-chrome` exited 3 (run `104f9af9d06b`) — brave is not on the clean-room `bash -lc` PATH. feat-065 S6 itself passed (exit 0), so the suite resolves a browser some other way, but hand-built UI probes in the clean room may need `VERIFY_BROWSER=$HOME/.local/bin/brave` (or PATH help) exported so attacks (a)–(f) actually render in a real browser rather than silently degrading.
- **Retry is cheap and pinned:** the dangling commits `536d29fe`/`867ca079` and the kept clean room `~/.local/state/claude-station/scratch/cleanroom-verify-ZYLGs3` persist. Re-run the identical command once the openai quota resets (window said 7:36 PM / 19:36): `node scripts/independent-verify.mjs --requirement @/tmp/bug190-r2-requirement.txt --range 536d29fe..867ca079 --run "node scripts/verify-feat-065-delivery.mjs" --test-file scripts/verify-feat-065-delivery.mjs --test-file scripts/verify-feat-064-drain-truth.mjs --test-file scripts/verify-bug-190-host-admission.mjs --test-file scripts/lib/host-admission.mjs --author-provider anthropic --provider openai --timeout-min 60 --keep-cleanroom`.
- **Decision the orchestrator must take:** either (A) retry the openai cross-provider verify after 19:36 (same command; artifacts pinned), or (B) authorise a same-provider anthropic clean-room verify as a weaker fallback (loses the cross-provider decorrelation the fixer was anthropic; cannot produce the `Verified-by: openai …` line this ticket's contract expects). BUG-190 stays IN VERIFICATION — round 2 is NOT independently verified.
- **Verified-by:** NONE — `dispatch openai codex-default (codex-cli 0.158.0-alpha.15.2)` dispatch failed `[quota-window]` before a verdict (failed session transcript `01a0e32f-f86e-72e2-a347-db2a1e710e71`). No independent verdict was produced.

### 2026-09-27 — round-3 independent cross-provider clean-room verify (courier lane) — VERDICT: BROKEN (round 2 REFUTED)
- **Verdict: BROKEN — round 2 is NOT independently verified.** The retry from the round-2 BLOCKED entry ran to completion this time and produced a full, manifest-backed citation block. The author's designated fixer suite and both regression suites are GREEN in the stripped clean room, but the verifier's own edge-case probes broke BOTH requirements. This is a real refutation, not an infra INVALID.
- **Route:** identical to the round-2 pinned command, `scripts/independent-verify.mjs`, cross-provider (`--author-provider anthropic --provider openai`), range `536d29fe..867ca079` (the six BUG-190 files only; scope confirmed by the round-2 entry). Verifier `dispatch openai codex-default (codex-cli 0.158.0-alpha.15.2, model codex default)`, run `01a0e3de-d9a4-75e1-acf5-78fe787d66cb`, new clean room `cleanroom-verify-M7tgzN`. `VERIFY_BROWSER=$HOME/.local/bin/brave` was exported so the real-browser probes rendered (round-2 noted brave was off the clean-room PATH); the four UI probes below did render real transcript panes.
- **Wording change (classifier-avoidance):** the round-2/BUG-187 lesson was that OpenAI's content classifier killed a verify for "cybersecurity" on adversarial vocabulary. I ran this with a QA-reworded requirement (`/tmp/bug190-r2-requirement-qa.txt`: "HOW TO ATTACK"→"HOW TO TEST", "attacks"→"test cases", objective reworded to "find cases where these claims do NOT hold") — substance, evidence contract and independence identical. The tracked harness's own generic framing was left untouched. **Result: NOT flagged.** The run completed normally and produced a verdict; the QA wording avoided the flag.
- **Contract:** VALID — exactly one FIXER-TEST line, manifest-backed, no duplicate-FIXER-TEST INVALID.
  - FIXER-TEST `node scripts/verify-feat-065-delivery.mjs` — run `121a7775d688` exit 0 (PASS).
  - Regression `verify-feat-064-drain-truth` — run `c4d8f2f31c06` exit 0 (PASS).
  - Regression `verify-bug-190-host-admission` — run `3db790c42683` exit 0 (PASS).
  - Probe passes: `six-rapid-reconnects` (`81069d7d895f` exit 0), `oversized-offset-after-truncation` (`3d55d498f911` exit 0) — cases (e) and (f) HOLD.
- **Findings (all classified REAL functional defects; NONE cosmetic):**
  1. **Partial trailing line never converges** — case (b). Probe `partial-line-completion` run `d4726d39bf40` exit 1. A trailing partial JSONL record completed after reconnect: A/B/D render but the completed `IV-PARTIAL-C` never appears (visibleOnce 3/4, order shows -1 for C). Directly violates requirement 1's "when a trailing partial line is later completed" clause. REAL.
  2. **Reconnect gap > one page drops the older page(s)** — case (c)/gap. Probe `growth-during-backward-pagination` run `9a0fa94613ff` exit 1. 264-message gap, page size 120: the backward page request comes back `before=143&beforeBytes=0` → `count:0` and stops, so IV-GROW-000..139 (140 messages) never render; only the last 120 do. This is the "gap longer than 120 messages / lower-bound count" case the round-2 author handoff itself listed as untested. Most likely to bite a real user (a busy survivor session accumulates >120 lines during a disconnect). REAL.
  3. **A transient catch-up 503 permanently orphans the gap line** — invented probe. `temporary-catchup-failure` run `b996ad6e7fe4` exit 1. One injected HTTP 503 during catch-up, then availability restored and a live control line appended: the live line renders but `IV-FAILED-READ-GAP` is lost forever with no self-recovery. Violates requirement 1's "must CONVERGE on its own, no manual reload." REAL (transient-fault-resilience; needs a network fault to trigger — lower everyday likelihood than #2, but a genuine convergence gap).
  4. **`startWhenAdmitted` resolves success on a permission error that arrives during the retry delay** — case for requirement 2. Probe `asynchronous-and-misclassified-admission` run `5b94ab3d58ad` exit 1. When "permission denied" (fatal) arrives BEFORE the retry it correctly throws (`returned:false`); when the same fatal arrives during the retry delay / after re-open it resolves success (`returned:true, error:null, opens:2`). Exactly the ordering clause requirement 2 calls out ("regardless of the order… relative to a runtime-pending refusal"). REAL.
  5. **`startWhenAdmitted` misclassifies a permission error whose text contains "checking runtime" as retryable** — same probe/run. `EACCES: permission denied while checking runtime executable` is treated as the retryable "checking runtime" refusal and eventually resolves success (`returned:true`). Substring-based retry classification collides with a real fatal error. Violates requirement 2's "on ANY other error… it must THROW." REAL.
- **Verifier's UNTESTED list:** session-switching mid-catch-up (case (d)); huge-file lower-bound counts and subagent-transcript offsets (offset probe used the main transcript with exact counts). Case (d) remains unproven in either direction.
- **Independent-skeptic note:** this WAS the independent clean-room skeptic pass (cross-provider, author=anthropic / verifier=openai, diff-only isolation, real browser). Findings #4/#5 are session-lifecycle/admission-safety and #1/#2/#3 are the client session-lifecycle render path — high-stakes, regression-prone (`regressed-from: FEAT-065`), so the refutation is the appropriately skeptical result. A round-3 FIX lane should address all five; #2 is the priority (real users, admitted-untested).
- **Verified-by:** openai codex-default (codex-cli 0.158.0-alpha.15.2, model codex default) run `01a0e3de-d9a4-75e1-acf5-78fe787d66cb` (clean-room `cleanroom-verify-M7tgzN`, `scripts/independent-verify.mjs`) — VERDICT: BROKEN. Full manifest log at `/tmp/bug190-r2-verify.log`.

### 2026-09-27 — BUG-190 fixing lane, round 3
- **Understood:** all five findings from run `01a0e3de` reproduced here, on the same tree, before any change. Four of them had a server-side root that round 2's client-only catch-up could not reach.
  1. **Partial trailing line.** A new watch started at the file's raw end, which was in the middle of the line still being written. The line's completion was then read as a headless fragment and dropped.
  2. **Gap longer than 120 messages.** `tailMessages` zeroed `blockStartByte` whenever its read reached byte 0. A small file is read to byte 0 in one chunk even when the page filled long before the start of the file. So the first page's `cursorBytes` was 0, and the next backward page (`beforeBytes=0`) returned no messages. The client took that as "nothing older". This also affected ordinary scroll-up paging on files that small.
  3. **Transient 503.** The round-2 catch-up swallowed the failure, flushed the buffered live appends, and moved `lastIndex` past the missing line.
  4. **Fatal error during the retry delay.** The helper stopped watching a refused socket once it decided to retry.
  5. **"checking runtime" collision.** The retry signal was a substring of the message.
- **Fix (root):**
  - `src/server/watcher.ts`:
    - A new watch starts at the last line BOUNDARY (`lastLineBoundary`, a backward chunked scan capped at 64 MiB), not the raw end. A complete last line with no trailing newline is still treated as complete.
    - `carry` is now bytes. Chunks are split on the newline byte and only whole lines are decoded, so a write split inside a multi-byte character no longer turns into U+FFFD. This was round 1's out-of-scope finding 3; it is the same code path.
  - `src/server/transcript.ts`: zero the cursor only when the scan ran out of file before filling the page.
  - `public/app.js` `catchUpFollow`:
    - Each pass must produce a contiguous run from `lastIndex+1`, or it throws. Every older page must link to the next one by index (non-empty, and ending at `before-1`), and the final set must have no holes.
    - A failed pass is retried with backoff (0.5, 1, 2, 4, 8, then 15 s repeating) while the view stays on the session. A visible `hint-row bad` says the missed messages are still being read. Live appends stay buffered until the catch-up has rendered, so nothing renders ahead of a missing line. The hint is removed once the view converges.
    - BUG-191's hunks are untouched.
  - The structured signal: `runtime-update.ts` `admission()` now states `transient` for its two self-clearing states (the pending boot check and a re-hash in flight). The new `hostSessionBlock()` exposes that. `agent-bridge.ts` `startSession` emits `code: 'runtime-check-pending'` only for those two states. `events.ts` documents the code. A real fresh server on a free port answered `[{"t":"error","code":"runtime-check-pending","message":"runtime check pending — …"}]`.
  - `scripts/lib/host-admission.mjs` `startWhenAdmitted`:
    - It retries only on that code; message text is never a signal.
    - Every socket it has opened stays watched until the outcome is final, including through the retry pause and a settle after `session-init`. A non-admission error on any of them throws.
    - A permanent runtime refusal (no code) throws.
- **New arms (all fail before the fix):**
  - `verify-feat-065-delivery.mjs` S6d–S6g run in a real headless browser (brave 150 via Playwright). They assert a census of the visible `innerText` lines of the pane: every expected line exactly once, and in order.
    - S6d: a partial line at reconnect, completed afterwards.
    - S6e: a 260-line gap with a line appended during the first backward read, the verifier's growth repro.
    - S6f: one 503 on the catch-up read, then a live line.
    - S6g: a live write split inside an emoji.
  - `verify-bug-190-host-admission.mjs` A8–A11:
    - A8: a fatal error arriving during the retry delay.
    - A9: an uncoded EACCES whose text contains "checking runtime".
    - A10: the admission wording without the code.
    - A11: a permanent-refusal code.
    - The existing arms now carry the code.
- **Must-FAIL (before the fix, this tree):**
  - `node scripts/verify-feat-065-delivery.mjs` gave `44/48`, EXIT 1:
    - S6d: `bad:[["BUG-190-PART-C",0]]`.
    - S6e: `badCount:140` of 261, `BUG-190-BIG-000..139` missing. This matches the verifier's 140 exactly.
    - S6f: `bad:[["BUG-190-FAILED-READ-GAP",0]]`.
    - S6g: `bad:[["BUG-190-UTF8-🙂-END",0]]`.
  - `node scripts/verify-bug-190-host-admission.mjs` gave `8/12`, with A8, A9, A10 and A11 failing.
- **Verified (after, working tree):**
  - `node scripts/verify-feat-065-delivery.mjs`: `48/48 checks passed`, EXIT 0, twice.
  - `node scripts/verify-bug-190-host-admission.mjs`: `12/12`, EXIT 0.
  - `node scripts/verify-feat-064-drain-truth.mjs`: `19/19`, EXIT 0.
  - `node scripts/verify-restart-reconnect-race.mjs`: `10/10`, EXIT 0.
  - `node scripts/verify-health-survivor.mjs`: `14/14`, EXIT 0.
  - `node scripts/verify-bug-072-delivery-visible.mjs`: `47/47`, EXIT 0.
  - `node scripts/verify-bug-191-adopt-window-send.mjs`: `BUG-191: 39/39 passed`, EXIT 0.
  - `node scripts/verify-bug-187-responderless-cli.mjs`: `77/77`, EXIT 0.
  - `npx tsc --noEmit -p .`: clean.
  - `npm run gate`: `GATE: PASS — safe to commit. (exit 0)`.
- **Changed (unstaged):**
  - `src/server/watcher.ts`
  - `src/server/transcript.ts`
  - `src/server/runtime/runtime-update.ts`
  - `src/server/agent-bridge.ts`: the admission emit only.
  - `src/server/events.ts`: the `code` union plus its doc.
  - `public/app.js`: `catchUpFollow` only.
  - `scripts/lib/host-admission.mjs`
  - `scripts/verify-feat-065-delivery.mjs`: S6d–S6g.
  - `scripts/verify-bug-190-host-admission.mjs`: A8–A11, and the coded fixtures.
  - This ticket.
- **Could not test / residual:**
  - Switching sessions in the middle of a catch-up (the verifier's case (d)). It is guarded by `stillHere()`, but no arm drives it.
  - A huge file whose count is only a lower bound. There the catch-up reads backward by byte cursor, so it does not rely on the `before` clamp.
  - A catch-up that keeps failing: it retries indefinitely with the hint visible, and live appends stay held until it succeeds. That is deliberate, so nothing renders out of order, but no arm holds the failure for minutes.
  - The subagent transcript route shares `tailMessages`. The cursor fix therefore applies there, but no arm covers it.
  - `scripts/lib/bug-187-harness.mjs` still retries on the message regex. It is BUG-187's file and was left alone; the message is unchanged, so it still works.
- **regressed-from:** BUG-190 round 2 (the retry, cursor and partial-line gaps). Originally FEAT-065.
- **Handoff:** round 3 is ready for an independent verify. This is a high-stakes change: the server watcher, the transcript cursor, the session-start error contract and the client render path. Suggested attacks: switching sessions mid-catch-up; a gap of more than 1,000 messages; a file with no newline at all; a catch-up while the view is parked in history.

### 2026-09-28 — round-4 independent cross-provider clean-room verify of the ROUND-3 fix (courier lane) — COMPLETED; VERDICT: BROKEN (2 NEW real defects; the 5 round-3 findings ARE fixed)

- **Verdict: BROKEN — round 3 is NOT independently verified.** The verify ran to completion with a VALID citation contract (single FIXER-TEST). The five findings the round-3 fix targeted ALL now PASS, but the verifier's own edge probes broke BOTH requirements again on two NEW deeper cases. Real refutation, not an infra INVALID. **No status change to verified.**
- **Route.** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider openai --timeout-min 25 --max-diff-bytes 2000 --requirement @requirement.prose.txt --test-file scripts/verify-feat-065-delivery.mjs --test-file scripts/verify-bug-190-host-admission.mjs --test-file scripts/verify-feat-064-drain-truth.mjs --test-file scripts/lib/host-admission.mjs --keep-cleanroom`, `VERIFY_BROWSER=$HOME/.local/bin/brave` exported (real-browser probes rendered). Diff-under-test = the ROUND-3 FIX only: an isolated 214 KB product diff of the BUG-190 files (watcher.ts, transcript.ts, runtime-update.ts, events.ts `runtime-check-pending` hunk, agent-bridge.ts admission emit, app.js `catchUpFollow`, host-admission.mjs, verify-feat-065 S6d-S6g, verify-bug-190-host-admission A1-A11), embedded in a plain-QA requirement whose SCOPE map names the BUG-191/187/189 hunks in the three mixed files (app.js, agent-bridge.ts, events.ts) as OUT OF SCOPE. Because the round-3 fix is uncommitted, the diff was assembled from `git diff HEAD` over the BUG-190 file set (synthetic isolation, disclosed). Artifacts `~/.local/state/claude-station/scratch/bug190-verify-r4/`; clean room KEPT `~/.local/state/claude-station/scratch/cleanroom-verify-zOW2Gs`; manifest `~/.local/state/claude-station/scratch/cleanroom-record-VwtZPC/manifest.jsonl` (32 runs).
- **Contract:** VALID — one FIXER-TEST, manifest-backed.
  - FIXER-TEST `node scripts/verify-feat-065-delivery.mjs` run `87f5bffc51c8` exit 0 (PASS).
  - Regression `verify-bug-190-host-admission` run `871fa760b7ce` exit 0; `verify-feat-064-drain-truth` run `16b317d40c66` exit 0.
  - The 5 round-3 findings RE-CHECKED and now HOLD: long-gap-260 `7555ca5b5131` exit 0; partial-completion `b9df564d4dbd` exit 0; transient-503 `23c36928fe74` exit 0; permission-during-delay `c921417a1be3` exit 0; uncoded-permission-text `e139ae9d3a71` exit 0. Also growing-backward-read, five-rapid-reconnects, truncated-file-past-end, survivor-gap-delivery, switch-during-catchup — all exit 0.
- **Findings (both REAL functional defects; NONE cosmetic):**
  1. **host-admission.mjs `startWhenAdmitted` resolves SUCCESS on a permission error that lands in the settle-pause's final sleep window** — probe `permission-settlement-boundary` run `ead83b30a544` exit 1. Corroborated: `pause()` (line ~85) checks `foreign()` at the TOP of each iteration then sleeps `min(25,ms)`, and re-evaluates only the `while` bound — it does NO final `foreign()` check after the last sleep before returning, so a non-admission (permission) error settling on an earlier socket during that final ≤25 ms window is missed and the helper returns success. Violates requirement 2 ("on ANY other error … it must THROW, regardless of order"). REAL; narrow timing window. Fix: re-check `foreign()` once more after the pause loop (and on the success path before returning).
  2. **watcher.ts leaves a record invisible when it is completed as valid JSON WITHOUT a trailing newline after reconnect** — probe `complete-json-without-newline` run `2bdebb64f8f8` exit 1; "adding only the newline makes the missing message render." Corroborated: a new watch parks its cursor before a still-partial last line (good), but `readAppend` only splits/emits on the newline BYTE (`nl = joined.lastIndexOf(0x0a)`; `parts = nl>=0 ? … : []`), so once the writer completes the record as valid JSON with no trailing `\n`, it sits in `carry` and is never emitted by the LIVE watch until a newline arrives — despite `lastLineBoundary`'s own comment claiming a complete no-newline line "is still treated as complete." Violates requirement 1's trailing-partial-line-completed convergence clause. REAL; narrow (a last record that never gets a trailing newline). NOTE: this is exactly the round-3 handoff's own suggested-untested attack "a file with no newline at all."
- **Verifier's UNTESTED list:** the 60 omitted messages after switching back to a 260-gap session (`switch-with-260-message-gap` run `2ac869582ccf` exit 1) were traced to the pre-existing 200-message initial-page limit, NOT a BUG-190 hunk — correctly NOT counted as a finding. Runtime boot/rehash admission transitions were injected as structured events, not by replacing runtime binaries.
- **Independent-skeptic note:** this WAS the independent cross-provider clean-room skeptic pass (author=anthropic / verifier=openai, isolated diff, real browser). Both findings are session-lifecycle / client-render / admission-safety, regressed-from FEAT-065 / BUG-190 rounds — high-stakes; the refutation is the appropriately skeptical result. A round-4 FIX lane should close both.
- **Verified-by:** openai codex-default (codex-cli 0.158.0-alpha.15.2) run `01a0e4e1-9203-79c3-b694-4c3c6b4f8bf7` (clean-room `cleanroom-verify-zOW2Gs`, `scripts/independent-verify.mjs`) — VERDICT: BROKEN.
- **regressed-from:** BUG-190 round 3 (finding 2 is its own admitted-untested "no newline at all" case; finding 1 is a new boundary in the round-3 host-admission rewrite). Originally FEAT-065.
- **Changed:** BUG-190 ticket (append) only. No src change, no git write.

### 2026-09-28 — BUG-190 fixing lane, round 4
- **Understood:** both findings from run `01a0e4e1` are real. Each had the same shape: success was concluded from an absence rather than from a positive fact.
  1. **Host admission.** Round 3 kept a socket per retry, then decided "no error arrived during my settle sleep, so the start succeeded". Any finite sleep loses to an error that lands just after it.
  2. **Watcher.** A line counted as complete only once its newline byte arrived. A record completed without one (the file's final record, or a writer that flushes the newline later) sat in `carry` for good.
- **Fix (root):**
  - `scripts/lib/host-admission.mjs`: one socket, one ordered event stream, decided by ORDER.
    - A refused start leaves the socket free: `index.ts` clears `starting` on the rejection and never binds a session. So a retry resends `start` on the same socket.
    - Success is the definitive `session-init`, and only when no non-admission error precedes it in the stream. A refusal is retried only when it answers the latest send.
    - No settle sleep remains anywhere, and resolution is immediate on `session-init` (A15).
  - `src/server/watcher.ts`: completeness is decided by PARSING, which is correct for this format. A transcript record is one JSON object per line. No proper prefix of an object parses as an object, because a cut anywhere before the closing brace is a syntax error. So a parse decides completeness exactly.
    - `isCompleteRecord` is shared with `lastLineBoundary`.
    - A newline-less carry that parses is emitted once. `carryEmitted` makes the newline that arrives later add nothing. A genuinely partial line never renders.
    - An idle-flush timer was rejected: it cannot tell a slow writer from a finished one, and parsing can.
- **Sibling sweep (both classes):**
  - **Sleep-as-success.** `scripts/lib/bug-187-harness.mjs` `startFakeSession` resolves on the definitive `ack` on the current socket, and the old socket is really closed, so it is fine. But it retried on a message SUBSTRING, which is round-3 finding 5's twin. It now retries on `code === 'runtime-check-pending'` (one line; BUG-187 product behaviour untouched). The other suites wait on `waitRuntimeReady`, a positive readiness signal, so they are fine.
  - **Trailing-newline assumptions.** The store readers in `transcript.ts` (`tailMessages`, `readForward`, `countMessages`) already treat a final record without a newline as complete; R4 proves it. The rest of `src/**` that splits on newlines falls into two groups:
    - Whole-file splits, which keep the last piece.
    - NDJSON protocol streams (`survival.ts`, `survivor-delivery.ts`, `codex-runtime.ts`, `provider-usage.ts`, `session-host.mjs`; `dispatch-broker.ts` was not touched). There the newline is the protocol's message terminator, so a newline-less tail really is an unfinished message.
    - Neither group is this defect.
  - **Found by the sweep, and fixed:** the round-3 UTF-8 defect's siblings in the store readers. `tailMessages` (backward) and `readForward` decoded each 1 MiB chunk on its own. A boundary inside a multi-byte character then rendered U+FFFD. Measured on the real module at HEAD: backward, 3 of 4 byte offsets corrupted; forward, 3 of 4. Now `tailMessages` carries bytes and decodes whole lines (its `startBytes` are exact byte offsets as a result), and `readForward` and `countMessages` use a `StringDecoder`.
- **Arms (each fails before the fix):**
  - `verify-feat-065-delivery.mjs` S6h runs in a real headless browser (brave 150 via Playwright) and checks a census of the visible pane lines:
    - (i) a record written up to, but not including, its closing brace is never rendered half-done;
    - it renders the moment it completes, with no newline;
    - the late newline plus the next record add no duplicate, and stay in order;
    - (ii) after a reconnect, a partial last line completed without a newline renders.
  - `verify-bug-190-host-admission.mjs` (26 checks):
    - Pinned verbatim baselines for the round-1 and round-3 helpers.
    - A12: the verifier's boundary scenario verbatim.
    - A13: a sweep of the fatal error landing 1 to 151 ms before `session-init`.
    - A14: an error after `session-init` belongs to the running session.
    - A15: resolution without a sleep.
    - The fixtures model one socket that accepts a resent start.
  - `scripts/verify-bug-190-reader-siblings.mjs` (new) runs against the REAL `transcript.ts`, on real files:
    - R1 backward and R2 forward: 1 MiB chunk boundaries inside an emoji run, at 4 offsets.
    - R3: count.
    - R4: a final record without a newline, read by all three readers.
    - R5: a partial final line, read by none.
    - `BUG190_TX_MODULE` runs it against a pinned copy.
- **Must-FAIL:**
  - S6h against a synthesized pre-fix watcher (the round-4 emission block removed, swapped in only for the server spawn, then restored and `cmp`-checked): `50/52`, EXIT 1. Both S6h load-bearing checks failed (`BUG-190-NONL-LIVE` count 0; `BUG-190-NONL-RC-B` count 0), and the partial-never-rendered check passed.
    - First attempt: the arm's own partial cut left the object complete, which the fixed build rendered and flagged. That was a defect in the arm, not the product. I corrected the cut to `length-1` and re-ran the must-FAIL.
  - Host admission: `BASELINE r3` resolves SUCCESS on the boundary scenario, and A12 rejects it.
  - Readers against HEAD `transcript.ts`: `3/5` (R1 and R2 FAIL with `fffd:true` at 3 of 4 offsets). R3–R5 are anti-regressions and passed on both.
- **Verified (after, working tree):**
  - `node scripts/verify-feat-065-delivery.mjs`: `52/52`, EXIT 0.
  - `node scripts/verify-bug-190-host-admission.mjs`: `26/26`, EXIT 0.
  - `node scripts/verify-bug-190-reader-siblings.mjs`: `5/5`, EXIT 0.
  - `node scripts/verify-feat-064-drain-truth.mjs`: `19/19`, EXIT 0.
  - `node scripts/verify-restart-reconnect-race.mjs`: `10/10`, EXIT 0.
  - `node scripts/verify-health-survivor.mjs`: `14/14`, EXIT 0.
  - `node scripts/verify-bug-072-delivery-visible.mjs`: `47/47`, EXIT 0.
  - `node scripts/verify-bug-191-adopt-window-send.mjs`: `BUG-191: 39/39 passed`, EXIT 0.
  - `node scripts/verify-bug-187-responderless-cli.mjs`: `95/95`, EXIT 0 (this uses the edited harness).
  - `npx tsc --noEmit -p .`: EXIT 0.
  - `npm run gate`: `GATE: PASS — safe to commit. (exit 0)`.
- **Changed (unstaged):**
  - `src/server/watcher.ts`
  - `src/server/transcript.ts`
  - `scripts/lib/host-admission.mjs`
  - `scripts/lib/bug-187-harness.mjs`: one line.
  - `scripts/verify-feat-065-delivery.mjs`: S6h.
  - `scripts/verify-bug-190-host-admission.mjs`: rewritten.
  - `scripts/verify-bug-190-reader-siblings.mjs`: new.
  - This ticket.
  - Not touched: `request-floor.mjs`, the dispatch path, `public/app.js`.
- **Could not test / residual:**
  - A record that parses as complete but is later extended on the same line. That is not valid JSONL and no writer does it; the extension would not be re-emitted.
  - A final line longer than the 64 MiB `lastLineBoundary` cap falls back to the old start-at-end behaviour.
  - The verifier's case (d), switching sessions mid-catch-up, passed in their run but is not an arm here.
- **regressed-from:** BUG-190 round 3 (both findings). Originally FEAT-065.
- **Handoff:** round 4 is ready for an independent verify. This is a high-stakes change: the watcher, the store readers and the harness start contract. Suggested attacks: a record completed across 3 or more writes with no newline; a newline-less final record on a file the watch starts on; an admission refusal interleaved with a `status` or `effective-config` frame; chunk boundaries inside a 3-byte character.

### 2026-09-28 — round-5 independent cross-provider clean-room verify of the ROUND-4 fix (courier lane) — INVALID (quota-window mid-run); all executed round-4-regression cases PASS

- **Verdict: INVALID — no completed machine verdict.** The dispatch launched cleanly (codex 0.158.0-alpha.15.2, workspace-write; classifier NOT triggered) and ran the author suites + the required round-4-regression probes in-room, but the reasoning turn hit the openai usage-limit window before emitting its final verdict/citation block (dispatch exited 1 `[quota-window]`; VERDICT-CONTRACT INVALID; fail-closed). **No status change to verified.** Completed cross-provider machine verdict remains OWED — blocked ONLY by quota (reset 2:06 PM local), not the classifier and not any defect.
- **Route.** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider openai --timeout-min 25 --max-diff-bytes 2000 --requirement @requirement.prose.txt --test-file scripts/verify-feat-065-delivery.mjs --test-file scripts/verify-bug-190-host-admission.mjs --test-file scripts/verify-bug-190-reader-siblings.mjs --test-file scripts/verify-feat-064-drain-truth.mjs --test-file scripts/lib/host-admission.mjs --keep-cleanroom`, `VERIFY_BROWSER=$HOME/.local/bin/brave`. Diff-under-test = round-4 fix (234 KB isolated BUG-190 diff: watcher.ts parse-decided completeness + carryEmitted, transcript.ts multibyte StringDecoder + cursor, host-admission.mjs one-socket order-decided, plus events.ts/agent-bridge.ts/app.js BUG-190 hunks and the S6h + reader-siblings arms), embedded in a plain-QA requirement with the BUG-191/187/189 hunks marked OUT OF SCOPE and 3 new REQUIRED round-4-regression cases (R4-A settle-boundary must THROW, R4-B no-trailing-newline must RENDER, R4-C multibyte across a chunk boundary must not corrupt). Synthetic isolation (round-4 fix is uncommitted), disclosed. Artifacts `~/.local/state/claude-station/scratch/bug190-verify-r5/`; clean room KEPT `cleanroom-verify-MhP0JT`; manifest `~/.local/state/claude-station/scratch/cleanroom-record-xRwxUQ/manifest.jsonl`.
- **Salvaged executed evidence (openai-authored, manifest-recorded, before the quota wall — every one exit 0):**
  - FIXER `verify-feat-065-delivery.mjs` run `a6b2b5930d11` exit 0 (52/52, incl. the S6h real-browser no-newline arms).
  - `verify-bug-190-host-admission.mjs` run `3c2b7f59c77c` exit 0 (26/26, incl. A12-A15).
  - `verify-bug-190-reader-siblings.mjs` run `cb065d8bac01` exit 0 (5/5 — the multibyte-across-1MiB-chunk R1/R2 fix, R4-C).
  - `verify-feat-064-drain-truth.mjs` run `6f50cb2e9d0f` exit 0.
  - **R4-A** `probe-admission.mjs boundary` run `b1b3616efff0` exit 0 — the round-4 finding-1 settle-boundary case now THROWS (no finite settle sleep to lose to). Also `text` `99274dec99fd` and `delay` `f6b8724a7f56` exit 0.
  - **R4-B** `probe-ui.mjs nonl` run `e8065a81180d` exit 0 (real browser) — the round-4 finding-2 record completed as valid JSON with NO trailing newline now RENDERS. (`e6006f0da943` exit 2 was a probe-harness wiring error, fixed then re-run green.)
  - `probe-ui.mjs partial` run `129b9ff3a75a` exit 0.
- **Both round-4 defects appear CLOSED and the multibyte sibling fix holds** — every executed round-4-regression case is green — but the FORMAL completed cross-provider verdict is still OWED (the verifier was cut off on probe-ui big/failure/empty before the verdict frame). All signs point to HOLD; re-dispatch THIS identical route after the 2:06 PM reset for the completed verdict. No framing/route change needed.
- **Verified-by:** NONE — cross-provider verify did not complete. openai codex (default) run `01a0e6ab-b079-7132-a3d8-861c84534db4` — **INVALID `[quota-window]`** (classifier NOT triggered). regressed-from: BUG-190 rounds 2-3, originally FEAT-065.
- **Changed:** BUG-190 ticket (append) only. No src change, no git write.

### 2026-09-28 — round-6 independent cross-provider clean-room verify of the ROUND-4 fix (courier lane) — COMPLETED; VERDICT: BROKEN (1 NEW real defect; the 2 round-4 defects + multibyte ARE fixed)

- **Verdict: BROKEN — round 4 is NOT independently verified.** Completed run, VALID citation contract (single FIXER-TEST). The two round-4 findings and the multibyte sibling fix all now PASS, but the verifier's own devised empty-transcript case broke requirement 1 again on a NEW edge. Real refutation, not infra INVALID. **No status change to verified.**
- **Route (identical to round 5, fresh diff).** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider openai --timeout-min 25 --max-diff-bytes 2000 --requirement @requirement.prose.txt --test-file scripts/verify-feat-065-delivery.mjs --test-file scripts/verify-bug-190-host-admission.mjs --test-file scripts/verify-bug-190-reader-siblings.mjs --test-file scripts/verify-feat-064-drain-truth.mjs --test-file scripts/lib/host-admission.mjs --keep-cleanroom`, `VERIFY_BROWSER=$HOME/.local/bin/brave`. Diff-under-test = the round-4 BUG-190 fix (watcher.ts / transcript.ts / host-admission.mjs byte-identical to round 5; verify-feat-065 now also carries the BUG-187-round-6 S3 rewrite, marked OUT OF SCOPE in the prose). Artifacts `~/.local/state/claude-station/scratch/bug190-verify-r6/`; clean room KEPT `cleanroom-verify-RkA8yt`; manifest `~/.local/state/claude-station/scratch/cleanroom-record-zr7tFV/manifest.jsonl`.
- **Contract:** VALID — one FIXER-TEST, manifest-backed.
  - FIXER-TEST `verify-feat-065-delivery.mjs` run `4460568ccd4a` exit 0. Regression `verify-bug-190-host-admission` `5bfe61744eba` exit 0, `verify-bug-190-reader-siblings` `7e12492c8057` exit 0, `verify-feat-064-drain-truth` `559e81a3cd4e` exit 0.
  - **The 2 round-4 findings + multibyte RE-CHECKED and now HOLD:** permission settle-boundary `iv-host boundary` `6f141407aece` exit 0 (THROWS); no-trailing-newline `iv-ui nonl` `fabde7255829` exit 0 (RENDERS); utf8-across-chunk `iv-read` `50196095d448` exit 0. Also permission-during-delay `43754b824b34`, misleading-error-text `9aac3704388e`, multipage-growing-gap `iv-ui big` `f2d4a7458414`, partial-line `8b497259bce1`, transient-read-failure `iv-ui failure` `4b6dcbe4ee6d`, oversized-cursor `iv-ui offset` `8216f18780b4`, switch-during-catchup `9fd156234719`, rapid-reconnects `034e8cbb3ca5` — all exit 0.
- **NEW FINDING (public/app.js `catchUpFollow` — the BUG-190 client hunk; regressed-from BUG-190 rounds 2-3):** `iv-ui anchorless` run `cf6f2dae47d8` exit 1. Corroborated by code-reading: `catchUpFollow` early-returns on `th.lastIndex == null` (`if (th.gap || th.lastIndex == null || isBridged(sessionId)) return;`). So a transcript opened with NO rendered messages (no high-water anchor), then a watch DISCONNECT, then its FIRST message written during the gap, never gets caught up — the gap message is lost; a later live message still renders. Browser census counts `[0,1]`; the verifier's causal control (treat the absent anchor as -1 → read from the start) gives `[1,1]` in order (`anchorless-control` `43c0b694cbe2` exit 0). Violates requirement 1 (convergence after any reconnect, exactly once). Severity: real, an empty/near-empty session losing its first delivered message across a disconnect; narrower than a busy session but genuine.
- **Verifier UNTESTED:** prolonged outages, hung-read timeout recovery, gaps beyond the 1,000-page limit; survivor delivery only via the designated suite.
- **Independent-skeptic note:** cross-provider clean-room skeptic pass (author=anthropic / verifier=openai, real browser). The finding is session-lifecycle / client-render (regressed-from FEAT-065 / BUG-190 rounds) — high-stakes; a round-5 FIX lane should make `catchUpFollow` treat a null anchor as -1 (read from the start) rather than skip.
- **Verified-by:** openai codex-default (codex-cli 0.158.0-alpha.15.2) run `01a0e7ba-5242-7432-86d0-e066f1c546ca` (clean-room `cleanroom-verify-RkA8yt`, `scripts/independent-verify.mjs`) — VERDICT: BROKEN.
- **regressed-from:** BUG-190 rounds 2-3 (the catch-up anchor path). Originally FEAT-065.
- **Changed:** BUG-190 ticket (append) only. No src change, no git write.

### 2026-09-28 — BUG-190 fixing lane, round 5
- **Understood:** the finding from run `01a0e7ba` is real, and its source is one step earlier than `catchUpFollow`. `openSession` set the anchor with `t.total ? t.total - 1 : null`. A falsy-zero check turned a KNOWN-empty transcript (total 0) into null, meaning "unknown". The catch-up then read null as "nothing to do".
- **Sweep: every null/0/undefined cursor or offset on the client and server read paths.**
  - **Client, `public/app.js`:**
    - `openSession` anchor (the source): FIXED, see below.
    - `catchUpFollow` null-anchor guard: FIXED, see below.
    - `applyAppend` treats null as "accept all", which is consistent with -1.
    - `pageCursor`: `oldest = Number.isInteger(offset) ? offset : 0` and `done` on `oldest <= 0`. Here 0 correctly means "start reached". OK.
    - `loadNewer` and the gap: integer-checked. OK.
    - `openHistoryWindow`: its fallback is `before-1`, a real bound. OK.
    - `api.js` selectors use `!= null`, so 0 is passed through. OK.
  - **Server:**
    - `?before=0` and `?beforeBytes=0` correctly mean "nothing older", and they are what a client asks for only at the true start.
    - `intParam` clamps `tail` to at least 1.
    - `tailMessages` handles `startByte != null` and `skip ?? 0`, so 0 is honoured.
    - `watcher` cursor 0 (a file with no newline) is honoured, and so is `readAppend`'s `size === cursor`.
    - All OK.
  - **Sibling found and FIXED:** a thread the LIVE BRIDGE rendered has NO store indices (its anchor is genuinely unknown). If the bridge drops and the watch re-follows the file, the same guard skipped the catch-up. So a message written in the gap was lost; this reproduced in a real browser.
  - **Sibling found and FIXED (UI):** "This session has no readable messages." stayed on screen after the session's first message rendered.
  - **Residual, not a cursor:** `watchSession` refuses a follow when the session FILE does not exist yet ("no session file"). Nothing re-asks when the file appears. This is only reachable for a brand-new session whose bridge dropped before the CLI wrote a line. It is noted, not fixed.
- **Fix:**
  - An empty transcript is a KNOWN anchor, `-1` (`Number.isInteger(t.total) ? t.total - 1 : null`). null now means only "the store did not say".
  - In `catchUpFollow`, a null anchor is never "nothing to do":
    - with nothing rendered in the thread, read from the start (`-1`);
    - with rendered content but no indices (a bridge-drawn thread), re-read the whole view from the store in one `openSession`. It cannot splice by index, so it reloads instead of skipping.
  - The empty-session notice now carries the `empty-session-hint` class and is removed when a message renders, whether by catch-up or by live append.
- **Arms:** in `verify-feat-065-delivery.mjs`, real headless browser, census of the visible pane lines.
  - The suite can serve a pinned pre-fix `app.js` to the browser with `BUG190_APP_VARIANT=<file>` (via `page.route`). No shared file is swapped, because other lanes edit `app.js` concurrently.
  - **S6i:** an empty session (a real store file with one non-renderable record, so total 0), opened. Then the watch drops, the FIRST message lands in the gap, the watch reconnects, and a live message follows. Both must render once, in order, and the notice must be gone.
  - **S6j (sibling):** a real bridge-driven new session, started from the project's own "+" in the browser. Then the driving socket drops (`!live`), the watch drops, and a line lands in the gap. The watch reconnects and a live line follows. Both lines must render once, in order, with the bridge-rendered prompt still exactly once.
- **Must-FAIL** (pinned pre-fix `app.js` variant, the same tree otherwise):
  - S6i FAIL: `bad:[["BUG-190-EMPTY-FIRST",0]]`, `empty:{lastIndex:null}`.
  - S6j FAIL: `bad:[["BUG-190-BRIDGE-GAP",0]]`, `prompt:1`.
- **Verified (after):**
  - `node scripts/verify-feat-065-delivery.mjs`: `56/56 checks passed`, EXIT 0. S6i observed `lastIndex:-1`.
  - `node scripts/verify-bug-190-host-admission.mjs`: `26/26`.
  - `node scripts/verify-bug-190-reader-siblings.mjs`: `5/5`.
  - `node scripts/verify-feat-064-drain-truth.mjs`: `19/19`.
  - `node scripts/verify-bug-072-delivery-visible.mjs`: `47/47`.
  - `node scripts/verify-bug-191-adopt-window-send.mjs`: `BUG-191: 39/39 passed`.
  - `node scripts/verify-bug-187-responderless-cli.mjs`: `104/104`.
  - `npx tsc --noEmit -p .`: EXIT 0.
  - `npm run gate`: `GATE: PASS — safe to commit. (exit 0)`.
- **ENVIRONMENT (needs the user), not a regression:**
  - `verify-health-survivor` (FATAL "drain window closed", the precondition "no Bash tool-call — model did not follow the steps") and `verify-restart-reconnect-race` (3/10) both need a REAL model turn. They cannot get one right now: the default account's `~/.claude/.credentials.json` has `expiresAt: 0`, modified today at 09:35. The CLI reports "OAuth session expired and could not be refreshed", which this lane saw in the browser pane during S6j.
  - Neither suite loads `app.js`, and `app.js` is this round's only product change. Both were green in round 4 (14/14 and 10/10).
  - Re-run them once the account is logged in again.
  - S6j needs no model reply: its thread is bridge-rendered either way.
- **Changed (unstaged):**
  - `public/app.js`: the `openSession` anchor, the `catchUpFollow` null-anchor branch, and the empty-hint removal (2 sites). BUG-191's hunks are untouched.
  - `scripts/verify-feat-065-delivery.mjs`: S6i, S6j, and the `BUG190_APP_VARIANT` hook.
  - This ticket.
- **regressed-from:** BUG-190 rounds 2–3 (the anchor path). Originally FEAT-065.
- **Handoff:** round 5 is ready for an independent verify, once the account is re-authenticated so the two real-turn suites can be re-run. Suggested attacks: a thread that mixes bridge-rendered and store-rendered content; a reload triggered while the user is typing in the composer (`openSession` path); an empty session that receives more than a page of messages in one gap.

### 2026-09-28 — round-7 independent clean-room verify of the ROUND-5 fix (courier lane) — COMPLETED; VERDICT: HOLDS (SAME-PROVIDER fallback)

- **Verdict: HOLDS — round 5 is independently verified, but SAME-PROVIDER.** Completed run, VALID citation contract (single FIXER-TEST, manifest-backed, 8 recorded runs). Every case the round-5 fix targets converges, and no case broke either requirement. **Cross-provider decorrelation was NOT achieved:** OpenAI was parked (5h binding window 79% used, `park` verdict, ~0.17h projected to cap — no headroom for a ~25-min run), so per the charter this fell back to `anthropic/claude-fable-5-1` — the SAME provider as the fixer. A cross-provider (openai) confirm is still warranted when quota returns; treat this as a verified-with-reduced-decorrelation result, not a full cross-provider clearance.
- **Route (same shape as round 6, run `01a0e7ba`; fresh diff).** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider anthropic --model claude-fable-5-1 --timeout-min 25 --max-diff-bytes 2000 --requirement @requirement.prose.txt --test-file scripts/verify-feat-065-delivery.mjs --test-file scripts/verify-bug-190-host-admission.mjs --test-file scripts/verify-bug-190-reader-siblings.mjs --test-file scripts/verify-feat-064-drain-truth.mjs --test-file scripts/lib/host-admission.mjs --keep-cleanroom`, `VERIFY_BROWSER=$HOME/.local/bin/brave`. Diff-under-test = the ROUND-5 fix (the cumulative BUG-190 file set; the round-5 additions are `openSession` anchor `total 0 → -1` not null, `catchUpFollow` null-anchor branch, the `empty-session-hint` class + its removal at 2 sites, and the S6i/S6j real-browser arms + `BUG190_APP_VARIANT` hook), assembled from the current working tree (tracked via `git diff HEAD`, the 4 untracked new files via `git diff --no-index`; no git-index write), embedded in a plain-QA requirement whose SCOPE map names the BUG-191/187/189 and rail/board hunks OUT OF SCOPE. Synthetic isolation (round-5 fix is uncommitted), disclosed; the harness auto-diff was truncated to 2000 bytes so the real diff-under-test is the prose. Artifacts `~/.local/state/claude-station/scratch/bug190-verify-r7/`; clean room KEPT `cleanroom-verify-PREwf2`; manifest `~/.local/state/claude-station/scratch/cleanroom-record-BYJJ2v/manifest.jsonl`. Working-tree snapshot HEAD `3e7a3f1b2c9a` → tree `493c0b1cdd07`.
- **Contract:** VALID — one FIXER-TEST, manifest-backed.
  - (i) FIXER-TEST `verify-feat-065-delivery.mjs` run `a39a43dfc421` exit 0 (**56/56**, incl. S6i EMPTY-session first message renders after reconnect + notice gone, and S6j bridge-drawn view converges after its bridge drops). Author regression suites re-run once each: `verify-bug-190-host-admission` `36d4d202568a` exit 0, `verify-bug-190-reader-siblings` `120a0b345806` exit 0, `verify-feat-064-drain-truth` `160140338f4f` exit 0.
  - (ii) Cases executed (all real-browser probes via brave; ≥4 required, 4 probe files driving 24 checks):
    - **Empty-session first message across a disconnect (this round's focus):** `browser-empty-session-partial-nonewline` run `75daa10aeece` exit 0 — 16/16 incl. the empty session, 120/121/240-message gaps with a 503 on the older page, rapid reconnects, switch-mid-catch-up with no cross-session leak, and full history paging.
    - **Bridge-drawn (null-anchor) thread:** `browser-real-cli-bridge-thread-second-ga` run `cfe6cff734c6` exit 0 — 5/5; V0 confirms the thread opens with `lastIndex null` and V1 that it converges (gap + live once, prompt still once) after the bridge drops and the watch re-follows.
    - **null/0/undefined cursor on both read paths + multibyte:** `server-cursors-watchcursor-multibyte` run `078e508bf5d1` exit 0.
    - **Round-4 regression (admission settle-boundary):** `admission-settle-boundary-sweep` run `ea3000771624` exit 0.
- **Verifier's UNTESTED list:** a transcript growing in the sub-ms window between `countMessages` and `tailMessages` in one synchronous handler; files above the 128 MiB forward budget / lower-bound totals (`totalIsLowerBound`, where `?before` is deliberately unclamped); the real-server transient `runtime-check-pending` only scripted, not forced via a slow boot hash; a bridge drop WITHOUT a watch drop (out of the requirement's scoped sibling shape); codex-provider and subagent (`agent-*.jsonl`) transcript routes.
- **Untestable (needs the user — expired OAuth), NOT a regression:** `verify-health-survivor` and `verify-restart-reconnect-race` require a REAL model turn and could not run — the default account `~/.claude/.credentials.json` OAuth is expired (`expiresAt: 0`). Neither loads `app.js` (round 5's only product change); both were green in round 4 (14/14, 10/10). Re-run once the account is re-authenticated.
- **Independent-skeptic note:** this WAS the clean-room skeptic pass (isolated diff, real browser) but SAME-PROVIDER (author=anthropic / verifier=anthropic) because OpenAI was parked — so cross-provider blind-spot decorrelation was NOT obtained. This is a high-stakes session-lifecycle / client-render change (`regressed-from` FEAT-065 / BUG-190 rounds); a cross-provider (openai) re-verify of round 5 is still warranted when quota returns, even though this same-provider pass HOLDS.
- **Verified-by:** dispatch anthropic/claude-fable-5-1 run `82b90645-409f-4af9-a3bc-955000e41414` (clean-room `cleanroom-verify-PREwf2`, `scripts/independent-verify.mjs`, SAME-PROVIDER — decorrelation reduced) — VERDICT: HOLDS.
- **regressed-from:** BUG-190 rounds 2–3 (the anchor path). Originally FEAT-065.
- **Changed:** BUG-190 ticket (append + status header) only. No src change, no git write.

### 2026-09-28 — real-CLI suites after re-login (pointer)
- The default `~/.claude` OAuth was re-logged-in; the BUG-187 round-7 `--real` arms and the survivor/adopt suites re-ran GREEN. `verify-bug-191-adopt-window-send.mjs` = 39/39 exit 0; `verify-restart-reconnect-race.mjs` = 10/10; `verify-health-survivor.mjs` = 14/14; BUG-187 `--real` = 117/117 (run 1) / 116/117 (run 2, the sole miss A13.3 a browser render-timing flake reproduced-clean in isolation, 9/9). ZERO real defects. Full detail: BUG-187 Activity "2026-09-28 — BUG-187 round 7 — real-CLI suites after re-login".
