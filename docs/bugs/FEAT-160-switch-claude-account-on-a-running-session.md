# FEAT-160 — switch the Claude account on a running session (direct projects)

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** server (agent-bridge / ws commands) + drawer/account-picker (public/app.js)
- **Reported:** 2026-10-01 by the user
- **Verification-class:** plan+review  ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
In the session UI, the Claude account switcher refuses with "the Claude account is fixed
for a running session — start a new session to switch". User (verbatim):

> "its not letting me switch claude accounts. i dont think there is any reason why it needs
> new session? new account can reuse same session file no?"

The session in question is on project `facebook-marketplace`, which is `isolation: direct`.

## Repro
1. Open a live (direct-project) session in the dock.
2. Open the Claude account switcher. It is disabled/refuses while the session is live.

## Expected
For a DIRECT project, picking a different Claude account on a live (idle) session continues
the SAME session id and transcript under the new subscription — turns from then on bill the
new account. Container projects keep the refusal (the credential is a container bind), but
the message states the reason.

## Context pack (grows — the "where to look", so no agent cold-starts)
- **Why it is feasible (verified).** A Claude "account" is a `CLAUDE_CONFIG_DIR` overlay
  that differs from `~/.claude` in exactly one file, `.credentials.json`; `projects/` (the
  transcript store) and `settings.json` are symlinks into the ONE shared real store
  (`src/server/claude-accounts.ts` header + `materialiseAccountDir`). So every account sees
  the same session JSONL; resume reads `projects/<cwd>/<id>.jsonl` regardless of which
  account dir is `CLAUDE_CONFIG_DIR`. `.claude.json` (identity + per-cwd trust) is NOT
  shared, but `-p`/print sessions hit no trust/onboarding wall on a fresh config dir
  (verified vs CLI 2.1.273 — FEAT-145 / docs/CONVENTIONS).
- **Why "fixed for a running session" existed.** The account is a SPAWN-TIME env var. The
  CLI is spawned once inside a survivable broker (`src/server/survival.ts` `spawnSurvivable`
  → `src/server/session-host.mjs`, one top-level `spawn`); there is no in-place env change
  (unlike `setModel`/`setPermissionMode`, which are SDK control-requests). So changing the
  account REQUIRES reaping the old CLI and re-resuming on a fresh CLI with the new
  `CLAUDE_CONFIG_DIR` + `--resume <sessionId>`.
- **The safe re-resume already exists.** `src/server/index.ts` `start{resumeSessionId,
  overrides:{claudeAccount}}` runs the full guarded resume path, including the BUG-022
  double-resume guard (`survivingHostForSdkSession` → refuse while the old broker still
  drains, drop it once dead). `AgentSession.close()` (agent-bridge.ts:3308) reaps the
  broker+CLI gracefully (stdin-EOF drain) and removes the bridge. So the feature = "stop the
  live CLI under the old account, then let the next resume run under the new account" — no
  new lifecycle machinery.
- Files/functions in play: `src/server/index.ts` (ws command dispatch ~4564-5408, `start`
  case 4589-5181), `src/server/agent-bridge.ts` (`close()` 3308, `liveSessions`/
  `bridgeForSession` 5774-5791, account env 1717-1745), `src/server/validate.ts`
  (`validateSessionOverrides` 642 — container refusal 661), `src/server/claude-accounts.ts`
  (`resolveLaunchAccountDir` 603 — loud ready+credential gate), `public/app.js`
  (`paintAccountSel` ~13247, `pickAccount` ~13318, `accountLockedReason` ~13237).
- Related tickets: FEAT-145 (the account model + per-session override at launch), BUG-196
  (engine fixed by transcript — stays refused; engine ≠ account), BUG-022 (double-resume
  corruption guard), BUG-191 (reap-old-host then re-resume precedent).
- Repro test: `npm run verify:feat-160` (added).
- Known dependencies / blockers: cross-provider plan review (openai) is quota-blocked until
  2026-10-05 — see Activity log; must be run before VERIFIED, alongside independent verify.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — fixing lane (plan+review, round 1)
- **Understood:** the refusal is purely because the account is bound at CLI spawn. The
  transcript store is shared across accounts, so the same session id/JSONL resumes under any
  account. facebook-marketplace is `isolation: direct` (registry) → in scope.
- **Design (built):** a new WebSocket command `switch-account { account }` operating on the
  socket's current live session:
  1. no live session on the socket → honest ack error.
  2. project is `container` → fatal error naming the reason (credential is a container bind;
     switching per-session recreates the container under every other session; pin on the
     project), session untouched. (Mirrors `validateSessionOverrides` container refusal.)
  3. validate the account: `validateSessionOverrides({claudeAccount: account},
     {isolation})` (existence + normalization + container refusal) then
     `resolveLaunchAccountDir(normalized)` (loud ready + credential-present gate). On EITHER
     throw → fatal error, NO close, OLD session keeps running (the "new account logged out →
     keep old session, loud error" requirement).
  4. session BUSY (turn in flight / pending card ⇒ busy) → refuse "finish or interrupt the
     current turn first". v1 does not auto-interrupt.
  5. `await session.close('account switch')` — reaps the old CLI, removes the bridge.
  6. detach the socket; ack `{of:'switch-account', ok:true, account, sessionId, encodedDir}`.
  The CLIENT then re-resumes via the EXISTING `start{resumeSessionId, overrides:{claudeAccount}}`
  path — which carries the BUG-022 survivor guard, so the reap→resume race is already handled
  (it refuses retryably until the old broker is fully drained, then resumes clean).
  - What happens to: in-flight turn → switch refused until it ends (step 4); queued/outbox
    messages → survive the reap (server outbox is keyed by session id) and deliver on the
    new CLI; pending permission card → the session reads BUSY, so step 4 refuses the switch;
    logged-out new account → step 3 throws before any close, old session untouched.
  - UI: the account picker is enabled for a live IDLE direct session; picking sends
    `switch-account`; on ack the client arms `state.overrides.claudeAccount` and the session
    resumes under the new account on the next message. Busy → disabled with a "finish the
    current turn first" tooltip. Container → the locked message states the reason.
- **Self-review (cross-provider review BLOCKED — see below):** worked the 6 review questions.
  Key outcomes: (Q1 double-resume) handled by reusing the existing `survivingHostForSdkSession`
  guard rather than a hand-rolled "confirmed dead" check. (Q3 shape) chose a server command
  that reaps authoritatively + validates server-side, then reuses the guarded client resume —
  no duplicated start-handler, no client-side reap race for the dangerous part. (Q4 atomicity)
  validation happens BEFORE the close, so a logged-out/invalid account never costs the old
  session; the only residual is a credential deleted in the sub-ms window between validate and
  the next resume — the transcript is intact on disk and the session re-opens normally.
- **Changed:** (files listed in the handoff; left UNSTAGED per project rules.)
- **Verified:** `npm run verify:feat-160` (added) + `npm run gate` — see handoff for counts.
- **Verified-by:** PENDING. Cross-provider plan review via `dispatch-client.mjs --provider
  openai` returned `[quota-window] … try again at Oct 5th` — the only entitled cross-provider
  reviewer is exhausted until 2026-10-05, so the plan-review leg could not run this round. This
  is a high-stakes change (session lifecycle + double-resume data-loss class), so BEFORE
  VERIFIED it needs BOTH: (a) the cross-provider review of the real diff, and (b) an
  independent clean-room verify (`scripts/independent-verify.mjs`) exercising a case the
  fixer's fixture does not cover (e.g. switch while a survivor broker is still draining;
  switch to a logged-out account; container refusal over the live ws route).
- **Still open / handoff:** run the two deferred verification legs above once openai quota
  resets (or via an alternative cross-provider reviewer). Optional follow-up: auto-respawn the
  CLI immediately after a switch (currently it resumes on the next message); needs a promptless
  resume path (today `start` with no prompt is refused as "nothing-to-reattach").

### 2026-10-01 — independent clean-room verify (verifying, round 1) — BLOCKED, no verdict

- **Goal:** run two same-provider (anthropic; openai quota-blocked to 2026-10-05) clean-room
  verify dispatches — one for FEAT-160, one for BUG-226 — via `scripts/independent-verify.mjs`.
- **Prep done + validated:** scoped each ticket to a `base..head` range so the room is the FULL
  coherent working tree (head = working-tree snapshot) but the verifier's diff is limited to the
  ticket's files only (base = working tree with the ticket files reverted to HEAD), built with
  node-spawned `read-tree`/`add`/`write-tree`/`commit-tree` over a throwaway index (real index
  untouched). FEAT-160 scope = package.json, public/app.js, scripts/verify-feat-145-session-override.mjs,
  scripts/verify-feat-160.mjs, src/server/events.ts, src/server/index.ts (6 files — matches charter).
  Requirement texts + per-property attack plans written; both machine accounts confirmed logged in
  (`claude auth status --json` reported `loggedIn:true` for both account dirs; emails redacted).
- **BLOCKER (hard):** `independent-verify.mjs` cannot run under the agent git-write guard. Its
  round-7 hardened diff path runs `git -c core.quotePath=false -c diff.submodule=short diff …`
  (GIT_CFG, ~line 1098). The git-write guard's `offendingConfigKey`/`CONFIG_KEY_ALLOWED`
  (scripts/lib/git-write-policy.mjs:186-189) allowlists ONLY `core.quotepath`, `color.*`,
  `advice.*`, so `diff.submodule` is classified as a WRITE and refused at the invocation layer
  ("`git -c diff.submodule` was blocked"). Probed precisely: `rev-parse`, `git archive`, plain
  `git diff`, and `-c core.quotePath=false diff` all PASS; ONLY the `-c diff.submodule=short`
  call is blocked. Both sides are uncommitted working-tree changes that conflict — this blocks
  ALL clean-room verification from any guarded agent session, not just this ticket.
- **Did NOT:** lift the guard (`ORCHARD_ALLOW_GIT_WRITE=1`) — forbidden; guard is user-only.
  Did not modify either tool (both are other lanes' in-flight files). No verdict recorded.
- **Unblock (pick one), then re-dispatch this leg:** (a) user grants a git-write WINDOW for
  this project (`node scripts/git-grant.mjs orchard --minutes 20`; `--once` is insufficient —
  the tool makes several blocked diff calls per run); or (b) the git-write-policy lane adds
  `diff.submodule` to `CONFIG_KEY_ALLOWED` (its values short/log/diff are inert DISPLAY
  settings, non-command-executing — same safety class as the already-allowed `core.quotepath`);
  or (c) the independent-verify lane makes `-c diff.submodule=short` conditional on the repo
  actually having submodules (this repo has none, so the flag is a no-op here). Root-cause
  belongs with ARCH-021 (git-write enforcement is a shell-text parser).

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 03b6751b-3552-44ec-9094-d9975ef8483b — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 1) — VERDICT: BROKEN

- **Unblocked by BUG-228** (git-write guard now allows `-c diff.submodule=short`), so the
  clean-room dispatch ran. Same-provider (anthropic; openai quota-blocked to 2026-10-05 —
  decorrelation reduced). Scoped base..head: diff = the 6 FEAT-160 files only; room = full
  working tree.
- **Verdict:** dispatch anthropic run `03b6751b-3552-44ec-9094-d9975ef8483b` — **BROKEN**
  (recorded typed in verification-ledger.json via board-tool). Valid verdict: fixer test
  re-run (17/17), TWO manifest-backed adversarial cases, could-not-test list present.
- **Property that BROKE (b / billing-correctness, survivor-drain):** the `switch-account`
  handler (src/server/index.ts, case 'switch-account', ~5376-5390) gates only on
  `session.busy` (main-turn only). If the main turn is idle but a background lane is still
  live, the switch acks ok (~200ms) while the OLD CLI keeps draining under account A. The
  client's next `start{resumeSessionId, overrides:{claudeAccount:C}}` is acked
  `deliveredVia:"survivor"` (FEAT-065) and the prompt goes to the OLD account-A CLI — so the
  turn bills the old account while the UI says switched to C. The BUG-022 double-resume guard
  does not refuse. Adversarial runs: `survivor-drain-switch-bills-old-account` (33a48d636150),
  `live-ws-bad-switches-double-switch-concu` (b20846a9f02b); both 16 pass / 1 fail on this
  defect.
- **Could not test (verifier's honest list):** real-CLI end-to-end switch between two logged-in
  subscriptions (no 2nd real subscription in the room; fake CLI writes no real transcript) —
  only `--resume=<id>` + CLAUDE_CONFIG_DIR checked; the headless Playwright arm (property d);
  container-project refusal over live ws; and the BUSY (turn-in-flight / pending-card) refusal
  over live ws.
- **Handoff to the fixer:** the busy-gate must also refuse (or correctly drain) when a
  background lane is still live under the old account, so no post-switch turn bills the old
  subscription. Billing/session-lifecycle, regression-prone — an independent re-verify is
  warranted after the fix. First break (two-break STOP not reached).

### 2026-10-01 — fixing lane (fix, round 2) — the busy-only gate WAS the break; gate on closeLifetime()
- **Understood / confirmed hypothesis:** round-1 gated `switch-account` on `session.busy` ALONE,
  which is TURN-scoped (ARCH-002). A background lane/subagent/Bash or a surviving broker still
  draining under account A leaves `busy=false`, so the switch reaped and the next resume billed
  the old account (independent-verify run 03b6751b, BROKEN). The server already owns ONE authority
  for "does work outlive this turn": `AgentSession.closeLifetime()` — the broker's own answer for a
  survivable DIRECT session, the bridge's `workLifetime()` otherwise. It is the EXACT gate
  `releaseSocketSession()` and `closeAllSessions()` consult. `regressed-from:` FEAT-160 round 1.
- **Fix (src/server/index.ts, case 'switch-account'):** after the busy check, `await
  live.closeLifetime()`; REFUSE unless `lifetime === 'no'`, naming the still-running work
  (`cl.source`). Re-checks `live.closed`/`live.busy` after the await; a lifetime-query error also
  refuses (biased to NOT reaping live work). Detach + reap only on a settled `no`. No second
  derivation added (ARCH-010) — the handler READS the one authority. Also covers a CLI-owned
  background Bash/monitor (a level `'tool'` lane → `closeLifetime` non-`no` → refused, since a
  reap would SIGTERM it). Queued/outbox messages are keyed by session id and are untouched by the
  switch — they deliver on the next CLI (correct: a not-yet-sent message is a future turn that
  should bill the NEW account). A pending permission card keeps `busy=true` → refused by the busy
  check (unchanged from round 1). UI: no client change — `public/app.js` already routes an
  `ok:false` ack through `finishAccountSwitch(..., e.ok===true, e.error, ...)`, surfacing the
  refusal and NOT arming the new account.
- **Changed (UNSTAGED):** `src/server/index.ts`; `scripts/verify-feat-160.mjs` (+§2b: the handler
  gates on `closeLifetime()` before `.close()`, with a synthesized round-1 busy-only must-FAIL
  twin); `scripts/verify-feat-160-survivor-drain.mjs` (NEW — behavioral reproduction);
  `package.json` (+`verify:feat-160-survivor-drain` alias).
- **Verified:**
  - `verify-feat-160.mjs` — 19/19 (incl. §2b source gate + its round-1 must-FAIL twin).
  - `verify-feat-160-survivor-drain.mjs` — 8/8. REAL reproduction: isolated server, real
    AgentSession + real DIRECT survival broker (systemd-run), scripted fake CLI (BUG-187 harness).
    `drain`: a live background lane (broker lifetime `yes`, source "the broker's own answer (seq
    N)") → switch REFUSED `ok:false` naming background work, old session + CLI left ALIVE. `idle`
    (non-vacuity): no work → switch `ok:true` + CLI reaped.
  - MUST-FAIL vs round-1 (real reproduction, not source-only): temporarily reverting the handler to
    busy-only reddened EXACTLY the two drain discriminators (switch acked `ok:true` instead of
    refused) — 6/8; fix restored, re-ran 8/8.
  - `verify-feat-145-session-override.mjs` — 34/34 (anti-regression). `npm run gate` — PASS (exit 0).
- **Still open / handoff:** HIGH-STAKES (billing + session-lifecycle, regression-prone) — an
  INDEPENDENT clean-room re-verify is warranted before VERIFIED, exercising a case my fixtures do
  not: the live-ws double-switch concurrency case (`live-ws-bad-switches-double-switch-concu`,
  b20846a9f02b) and a real two-subscription end-to-end switch. Cross-provider openai quota resets
  2026-10-05. Two-break STOP NOT reached: the property broke through exactly the background-work
  path the hypothesis named, fixed via the single authority.
- **Symptom of a deeper design flaw?** no — this is the ARCH-002/ARCH-010 pattern applied correctly
  (one lifetime authority, read not re-derived); round-1 simply failed to read it.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run f8e462a0-b0f9-4326-b60d-abb6e4773cf6 — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 2) — VERDICT: BROKEN
- **Run:** dispatch anthropic/`claude-opus-5` run `f8e462a0-b0f9-4326-b60d-abb6e4773cf6` (session
  f8e462a0-b0f9-4326-b60d-abb6e4773cf6), via `scripts/independent-verify.mjs`. Recorded typed in
  verification-ledger.json via board-tool. Verdict-contract: **VALID** (fixer tests re-run 19/19 +
  8/8 + 34/34 equivalent; TWO manifest-backed adversarial cases; could-not-test list present).
- **Scoped base..head:** `e4476959913cd168bfa8cbd9fb9de888d3ece05e..05e9bd9be34cc2e6212acb5ef1c25952d476b240`.
  Diff validated = EXACTLY the 7 round-2 FEAT-160 files (package.json, public/app.js,
  src/server/events.ts, src/server/index.ts, scripts/verify-feat-145-session-override.mjs,
  scripts/verify-feat-160.mjs, scripts/verify-feat-160-survivor-drain.mjs); room = full working tree.
  Clean room kept at `~/.local/state/claude-station/scratch/cleanroom-verify-Ju3rnV`
  (manifest `~/.local/state/claude-station/scratch/cleanroom-record-Ys8kDX/manifest.jsonl`).
- **Same-provider note:** anthropic author + anthropic verifier (openai quota-blocked to 2026-10-05);
  decorrelation reduced — recorded as a limitation.
- **HELD:** the round-2 fix itself holds — `closeLifetime()` background-work gate PASSES incl. its
  round-1 busy-only must-FAIL twin (§2b); validate-before-reap ordering; container refusal;
  logged-out/credential-less/bogus/truncated-registry refusals; resume carries account-B overlay
  dir; property (c) at-most-one CLI per session id held in both adversarial runs. Fixer suite 19/19.
- **BROKE (property b — "messages queued/outboxed" sub-property) via a NEW path:** the
  `switch-account` handler (src/server/index.ts:5340–5418) gates on validation, `session.busy` and
  `closeLifetime()` only — it **never consults the session's server outbox**
  (`outboxBlocks`/`outboxHasPending`, which the `start`/`send` paths at index.ts:4716 and 5221 do).
  On an IDLE session carrying a `queued` outbox row the switch acks `ok:true` and reaps the CLI
  (adversarial `outbox-queued-row-switch-acks-ok-and-rea`, run 15dfcddf9e53 — row `queued`/hold
  `disk`, busy false, CLI pid dead). The outbox then resumes the SAME session id from the row's saved
  `resume.overrides`, so the queued user message runs under the OLD account: ack said account B but
  the spawned CLI's `CLAUDE_CONFIG_DIR` is account A's overlay dir (adversarial
  `queued-turn-resumes-on-old-account-after`, run 3103d940fb21) — the exact mis-bill the refusal was
  meant to prevent; with no resumable transcript the reap strands the row `failed`.
- **TWO-BREAK STOP REACHED — enumerated property, route to single-authority redesign.** Round-1
  break = busy-only gate missed background work / survivor-drain billing (fixed via `closeLifetime()`).
  This round-2 break is a DIFFERENT path to the SAME property (b): the fixer's own round-2 note
  explicitly claimed "Queued/outbox messages are keyed by session id and are untouched by the switch
  — they deliver on the next CLI (correct)"; the verifier DISPROVED that — the untouched queued row
  resumes under the old account (mis-bill) or is stranded. Two switch-blocking conditions have now
  each been missed by a separate ad-hoc gate. Recommend a single "does anything owed to this session
  outlive the turn?" authority the handler reads (busy + closeLifetime + outbox-pending), rather than
  adding a third hand-rolled check — see ARCH-002/ARCH-010.
- **Could-not-test (verifier's honest list):** real billing against two genuine logged-in
  subscriptions (accounts minted ready with stub `.credentials.json`; plan proven only as resolved
  `CLAUDE_CONFIG_DIR`, not an invoice); property (d) post-switch UI (new-account chip + prior
  history) — `finishAccountSwitch` read, not executed in a browser/DOM run; live-route container
  refusal and logged-out/unknown refusal on a RUNNING session (only in-process
  `validateSessionOverrides`/`resolveLaunchAccountDir` + the no-session ack covered them); the natural
  ~500ms post-turn-end delivery window and a concurrent double-switch / pending-permission-card race
  (queued row was held deterministically by making its outbox journal unwritable instead of racing
  the 500ms pump; no two-switch-at-once run was made).
- **Handoff to fixer:** gate the switch on outbox-pending too (or drain/re-key the row to the new
  account before reaping), and prefer a single outlives-the-turn authority over a third gate.
  HIGH-STAKES (billing + session-lifecycle, regression-prone); this entry IS an independent pass —
  a further clean-room re-verify is warranted after the next fix, and should additionally cover the
  still-untested double-switch race and property (d).

### 2026-10-01 — fixing lane (plan+review, round 3) — single-authority redesign (WA §N two-break STOP)

**Property (restated).** "A live account switch never strands or mis-bills work owed to the
session." It has broken through two doors: round 1 = background work that outlives the turn
(busy is turn-scoped); round 2 = a queued outbox row that resumes under the OLD saved account.
Two ad-hoc gates, two misses — WA §N forbids a third. This round designs ONE authority the
switch reads.

#### 1. Inventory — every kind of work OWED to a session (with code pointers)

A reap-then-resume under a new account mis-bills or strands iff something is owed to the
session that would run/bill under the OLD account after the switch. Three kinds exist:

- **(turn) a turn in flight, incl. a pending permission/question/plan card.** Owner:
  `AgentSession.busy` (agent-bridge.ts:657; set at turn start 1957/3285/3610, cleared at
  result/turn-end 1811/3350/4215). A pending `can_use_tool`/question/plan holds the SDK turn
  open, so `busy` stays true. Already read by the switch handler (index.ts:5376, 5397).
- **(lifetime) work outliving the turn** — background lanes/subagents, a background Bash
  (`tool` level), a surviving/draining broker. Owner: `AgentSession.closeLifetime()`
  (agent-bridge.ts:3060) = `brokerLifetimeForClose(#survivalHandle)` for a survivable session,
  else `workLifetime()` (3447). This is the SAME gate `releaseSocketSession` (index.ts:4209)
  and `closeAllSessions` (agent-bridge.ts:5851) consult. Already read by the handler
  (index.ts:5395–5405). Fixed round 2.
- **(outbox) a message owed to the session's CLI** — NOT read by the handler today. Signals,
  all in index.ts: `outboxHasPending(sid)` (outbox.ts:610 — a `queued`/`sending` row, in memory
  or on disk), `outboxReserved.has(sid)` (index.ts:4270 — the pump holds the reservation),
  `deliveryInFlight.has(sid)` (4258 — a gated send/outbox delivery is mid-flight), and
  `resumeStarting.has(sid)` (4260 — a prompt-bearing resume is spawning a CLI now). The pump's
  resume route (`handOver`, index.ts:4393+) resumes using the row's SAVED `resume.overrides`
  (outbox.ts:77/807) → the OLD account. `outboxBlocks(sid)` (4273) already composes the first
  two; the start/send paths read it at index.ts:4716 and 5221.

Considered and ruled OUT as owed-work kinds: a survivor broker for a prior session id (handled
by the resume path's BUG-022 `survivingHostForSdkSession` guard, and visible via closeLifetime
when `live` adopted it); `uncertain`/`failed` outbox rows (never auto-send — `outboxHasPending`
excludes them — so they bill nothing); zombie/dead bridges (not owed work).

#### 2. Are the close/release paths wrong about the outbox too? — NO (examined)

`releaseSocketSession` and `closeAllSessions` ask a DIFFERENT question: "can I reap the CLI
without destroying in-flight work?" For THAT question a pending outbox row is SAFE, because the
outbox is the forward-carry: a reaped session's queued row re-delivers by resuming from disk
under the row's OWN saved account. On a socket close the pump redelivers; on shutdown the row
persists and `startOutbox` (outbox.ts:957, called at boot index.ts:5603) reloads every journal
and `kick`s it, so the next boot delivers it — under the SAME account, never lost. So
reaping-with-outbox is correct for close/shutdown and WRONG only for a SWITCH (old account).
Folding outbox-pending into `closeLifetime` would REGRESS the close paths: `releaseSocketSession`
would detach-forever an idle CLI that merely has a queued message (a leak — the detached-close
fuse also reads `closeLifetime`, so nothing would ever close it), and `closeAllSessions` would
keep brokers alive on shutdown. Therefore outbox-pending is a DIFFERENT fact with its own single
owner (outbox.ts), not a second copy of the lifetime answer, and the close paths do NOT read the
new oracle.

#### 3. Plan review REFUTED the owed-work-oracle plan — the account itself has no owner

Independent cross-model plan review (dispatch anthropic/`claude-fable-5-1`, run
`f8b1b178-b98d-4f93-bbc4-2558281354c9`, 2026-10-01) found a decisive miss that invalidates
refuse-at-switch-time: **which account a session is on is NOT a server-owned fact at all.** It
lives ONLY in each tab's client `state.overrides`, copied into every `start` and FROZEN into each
outbox row at enqueue (public/app.js ~11808, index.ts ~2131); the server records nothing. So any
switch-time gate (`switchOwedWork`/refuse) is a point-in-time check on a fact with no owner, and
old-account settings can still enter AFTER it through four paths the review enumerated:
  - **(a) enqueue during the reap** — `POST /api/outbox` ignores `deliveryInFlight`; a row queued
    while `await live.close()` runs carries the old account and the pump resumes it on the old
    account once the reservation releases (the round-2 bug, moved to AFTER the gate);
  - **(b) reattach ignores overrides** — the switching tab's next `start{resumeSessionId}` finds
    the (old-account) bridge path (a) spawned and `reattach`es it without comparing accounts;
  - **(c) a second tab** holds the old override in memory/localStorage and resumes on the old
    account at any time; tab A then reattaches as in (b);
  - **(d) uncertain/failed rows** resume on their saved old overrides when the user presses
    "Send anyway".
This is exactly ARCH-010: the account is re-derived at every resume route from a client-carried
value — "a second place able to hold a different answer." The single authority is therefore NOT
an owed-work oracle; it is a **server-owned session→account binding**.

#### 4. The redesign — a server-owned session→account binding (the single authority), additive

- **New authority** `src/server/session-accounts.ts`: a durable `sid → accountId|null` map
  (in-memory Map + a JSON file under `CLAUDE_STATION_DATA`, loaded at boot). `setSessionAccount(sid,
  account)` / `getSessionAccount(sid): { account } | undefined` (`undefined` = no binding). This is
  the ONE owner of "which account is this session on."
- **Writer (one place):** the `switch-account` handler calls `setSessionAccount(sid, normalized)`
  DURABLY *before* it reaps the old CLI. (A fresh session never writes a binding, so its account
  stays the per-launch override exactly as FEAT-145 defines — this is purely additive.)
- **Reader (one place — the single spawn chokepoint):** the `AgentSession` constructor
  (agent-bridge.ts ~1213-1264), right where `effective.claudeAccount` is computed and before it is
  consumed at ~1732. For a RESUME (`opts.resumeSessionId` present) with a binding, force
  `effective.claudeAccount = getSessionAccount(resumeSessionId).account`. EVERY resume spawn — the
  outbox pump's `resume` route (`handOver` → `startSession`), the ws `start` resume, a "Send
  anyway" on an uncertain/failed row, a boot re-pump — flows through this one constructor, so the
  bound account wins over any stale client override uniformly. Paths (a)-(d) all close at this one
  reader. (`reattach` never spawns, so it needs no change: the live CLI it attaches to was spawned
  by a route that already read the binding.) Fork (a new sid) reads the PARENT sid's binding via
  `opts.resumeSessionId` — a fork of a switched session continues on the switched account.
- **Why this makes CARRY correct (and chosen over REFUSE).** With the account server-owned, a
  queued outbox row that resumes after the switch runs under the session's DECLARED account (the
  new one) — "switch and continue", the behaviour the user expects — and it is NOT "silently
  moved" (the account is a visible session fact, not a per-tab guess). So the switch does NOT
  refuse on a merely-queued row; it rebinds and the row carries correctly. The charter offered
  exactly this ("carry pending outbox rows so they run under the NEW account"); the binding is what
  makes it correct rather than a silent per-tab move.

#### 5. The switch handler's gate shrinks to "don't reap LIVE work" (correctness now lives in the binding)

Billing-correctness is no longer the gate's job (the binding owns it). The gate's only remaining
job is not to TRUNCATE in-flight work by reaping it:
  - `session.busy` (turn/ pending card in flight) → refuse;
  - `await session.closeLifetime() !== 'no'` (background lane/subagent/Bash, draining broker), or a
    lifetime-query throw → refuse (unchanged round-2 gate, the same authority the close paths read);
  - an ACTIVE delivery — `deliveryInFlight.has(sid)` (covers `outboxReserved`) or
    `resumeStarting.has(sid)` → refuse RETRYABLE (transient; reaping mid-delivery truncates).
A merely-queued row is NOT a reason to refuse (it carries under the binding). Order: write the
binding, acquire the session's `deliveryInFlight` reservation (the existing map the pump/send
respect — prevents a pump delivery or a second switch interleaving the reap), re-check the gate
under it, reap, release in `finally`, ack. The binding is written BEFORE the reap and is durable,
so a restart mid-switch still resumes on the new account.

Note the §2 close-paths argument ("reaping-with-a-queued-row is safe because the row re-delivers
under its own account") now rests on the binding being the account owner: after this change the
row's EFFECTIVE account is the binding, so close/shutdown re-delivery is correct for a switched
session too. Stated here as the review asked.

#### 6. UI

No client change required for correctness: an `ok:false` ack already routes through
`finishAccountSwitch` (public/app.js) which surfaces a refusal and does NOT arm the new account.
A successful switch acks ok and the client re-resumes; the binding makes the account stick
regardless of the client's stale override. (Optional later: the picker could reflect busy/active
as a disabled state with a tooltip, as busy already is.)

#### 7. Test plan — one reddening case per path, vs synthesized pre-fix states

- **(binding reader — THE core, covers review paths a/b/c/d) NEW:** resume through the real
  spawn chokepoint with a binding = account B but client override = account A → the resolved
  `CLAUDE_CONFIG_DIR` is B's overlay dir. must-FAIL vs no-reader: resolves A. In-process against
  the real `AgentSession`/`resolveLaunchAccountDir` + env formula.
- **(binding durability) NEW:** write a binding, reload the store → it persists; must-FAIL vs an
  in-memory-only store.
- **(switch writes the binding before reap) NEW:** handler source + behavioral — `setSessionAccount`
  is called before `.close()`; must-FAIL twin without it.
- **(outbox CARRY — the round-2 case, end-to-end) NEW:** real isolated server, a real queued
  outbox row on an IDLE session, `switch-account` to B → reap → the pump resumes the row and the
  spawned CLI runs under B (not A). must-FAIL vs no-binding: spawns under A (the exact mis-bill).
  Plus a truncated/partial outbox-journal read (another process writes it) per CONVENTIONS.
- **(gate — turn/lifetime) kept:** verify-feat-160 §2b + verify-feat-160-survivor-drain `drain`
  (+ its round-1 busy-only must-FAIL twin) + `idle` non-vacuity.
- **(gate — active delivery) NEW:** a switch while `deliveryInFlight`/`resumeStarting` is held →
  retryable refuse; must-FAIL vs a handler that ignores it.
- Re-run: verify-feat-160, verify-feat-160-survivor-drain, verify-feat-145-session-override,
  `npm run gate`.

**Plan-review:** dispatch anthropic/`claude-fable-5-1` run `f8b1b178-b98d-4f93-bbc4-2558281354c9`
(a different top-tier model from the fixer's opus-4.8; openai quota-blocked to 2026-10-05) — it
refuted the owed-work-oracle plan and drove the redesign in §3-§5. **Symptom of a deeper design
flaw?** No new ARCH ticket: this IS the ARCH-010 remedy — the previously-unowned session→account
fact is given one owner, written once, read at the single spawn chokepoint. HIGH-STAKES (billing +
session-lifecycle + the FEAT-145 account model), regression-prone → an independent clean-room
re-verify is REQUIRED before VERIFIED (double-switch race and property (d) still want coverage).

#### 8. BUILT (round 3)

- **New authority** `src/server/session-accounts.ts` — the server-owned `sid → account` binding:
  `getSessionAccount` (`undefined` = unbound → override fallback; `{account:null}` = a real bind to
  the default), `setSessionAccount` (durable JSON in `CLAUDE_STATION_DATA`, cache keyed by resolved
  path so in-process harnesses re-pointing the data dir never read stale), `_resetSessionAccountsCache`
  (test seam). A truncated/garbled file degrades to "no binding" (override fallback), never throws.
  Path helper `sessionAccountsFile()` added to `src/lib/paths.ts`.
- **Writer:** `src/server/index.ts` `case 'switch-account'` — gate shrunk to "don't reap LIVE work"
  (busy; `closeLifetime() !== 'no'`; an ACTIVE delivery `deliveryInFlight`/`resumeStarting` →
  retryable refuse). It no longer refuses on a merely-queued row (carried). On a settled proceed it
  acquires the session's `deliveryInFlight` reservation (so no pump delivery/second switch interleaves
  the reap), writes `setSessionAccount(sid, normalized)` DURABLY before `close()`, reaps, releases the
  reservation in `finally`, acks. Validate-before-reap ordering unchanged.
- **Reader (one place):** `src/server/agent-bridge.ts` `AgentSession` constructor — for a resume
  (`opts.resumeSessionId`) with a binding, `effective.claudeAccount = getSessionAccount(...).account`.
  Every resume spawn flows through here (ws start, outbox pump's `resume` route via `startSession`,
  "Send anyway", boot re-pump, fork), so a switched session can never run on the old account whatever
  override a tab/row carries — closing review paths (a)-(d) at one chokepoint.
- **Changed (UNSTAGED):** `src/lib/paths.ts`, `src/server/session-accounts.ts` (NEW),
  `src/server/agent-bridge.ts`, `src/server/index.ts`, `scripts/verify-feat-160.mjs`, this ticket.
- **Verified:**
  - `verify-feat-160.mjs` — **33/33**. New: §2c (handler writes the binding before reap + does NOT
    gate on outbox; round-2 must-FAIL twin), §6 (the owner: set/get, `undefined` vs `{account:null}`,
    durability across a cache drop with an in-memory-only must-FAIL twin, truncated-file degrade),
    §7 (/proc: a resume carrying a STALE override A runs the child on the BOUND account B, with a
    no-binding must-FAIL control showing A — the binding is causal; + the outbox pump's resume route
    spawns via `startSession`, so the round-2 case rides the one reader).
  - `verify-feat-160-survivor-drain.mjs` — **8/8** (REAL server+broker): the rewritten handler still
    REFUSES a switch while a background lane drains (old CLI left alive) and SUCCEEDS + reaps on idle
    (ack carries the sid the binding was written for). Gate unchanged by the redesign.
  - `verify-feat-145-session-override.mjs` — **34/34** (anti-regression; §6 call-site invariant holds
    — the switch handler still passes `{isolation}` to `validateSessionOverrides`).
  - `npm run gate` — **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Could NOT test here (for the mandatory independent clean-room re-verify):** the real
  outbox-PUMP resume end-to-end against two genuine logged-in subscriptions reading a REAL transcript
  (the fake CLI writes no real transcript / spends no plan — §7 proves the binding→env chain with the
  real module + real env formula + the real constructor source, and the pump→`startSession` wiring by
  source); a concurrent double-switch race and a pending-permission-card switch over the live ws;
  property (d) post-switch UI in a real browser.
- **Still open / handoff:** HIGH-STAKES (billing + session-lifecycle + the FEAT-145 account model),
  regression-prone (`regressed-from:` FEAT-160 r1 busy-only gate, r2 outbox miss) → an INDEPENDENT
  clean-room re-verify is REQUIRED before VERIFIED, exercising the could-not-test list above. The
  plan review (f8b1b178) counts as the plan-level skeptic; the DIFF still needs a clean-room pass.
- **Symptom of a deeper design flaw?** no — the fix gives the previously-unowned session→account fact
  one durable owner read at the single spawn chokepoint (ARCH-010); no new ARCH ticket.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 160ce8f5-1530-493a-8670-02aebce1d347 — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 3) — VERDICT: BROKEN

- **Run:** dispatch anthropic/`claude-opus-5` run `160ce8f5-1530-493a-8670-02aebce1d347`, via
  `scripts/independent-verify.mjs`. Recorded typed in verification-ledger.json via board-tool.
  Verdict-contract: **VALID** (fixer suite re-run EXIT 0; THREE manifest-backed adversarial cases;
  could-not-test list present). Same-provider (anthropic author + anthropic verifier; OpenAI
  quota-blocked to 2026-10-05 — **decorrelation reduced**, a cross-provider re-verify is due after).
- **Scoped base..head:** `68c50d22b580..6802f321453b` (164819 diff bytes). Diff = the FEAT-160
  round-3 surface only (session-accounts.ts NEW, paths.ts, agent-bridge.ts, index.ts, events.ts, the
  3 verify scripts, package.json); public/app.js excluded from the diff (round-3 made no client
  change, 185KB of concurrent-lane noise) but PRESENT in the room and pointed to. Room = full working
  tree (all lanes' concurrent work), docs stripped. Kept at
  `~/.local/state/claude-station/scratch/cleanroom-verify-njfKfT`
  (manifest `~/.local/state/claude-station/scratch/cleanroom-record-rnSNH8/manifest.jsonl`).
- **HELD — the round-3 single-authority binding, end-to-end on a REAL server (adversarial
  `live-switch-e2e-resume-env`, run 3bd83ea6922d, 12/12):** a real switch between two ready accounts
  on a real AgentSession + real DIRECT broker — the OLD CLI reaped, the binding written to disk naming
  B, the stale-tab resume ACCEPTED (not stranded), and the CLI that resume spawned runs on the BOUND
  account B (read from /proc), NOT the stale override A; SAME session id, SAME JSONL appended across
  the switch, prior history intact. Fixer suite `verify:feat-160` 33/33 (incl. §2c binding-before-reap
  + its round-2 must-FAIL twin, §7 /proc the-one-reader with a no-binding must-FAIL control).
- **BROKE — two NEW edge paths (TWO-BREAK STOP reached):**
  - **(mis-bill on an "inherit" pick — adversarial `inherit-pick-binds-default-not-machine-a`, run
    2738cc40171a, 8/9):** `public/app.js switchAccountLive` resolves an "inherit / Project default"
    pick as `project.settings.claudeAccount ?? null`, OMITTING the machine default. On a live session
    that was billing the machine-default account M, picking "Project default" binds `{account:null}`,
    so every later turn runs on `~/.claude` instead of M — and because the binding is now authoritative
    it wins even over a later explicit override naming M, so the mis-bind cannot be corrected by
    re-picking M. (Writer: index.ts `case 'switch-account'` → `setSessionAccount`; the client resolves
    the wrong account before the frame is sent.)
  - **(stale tab stranded when the old account was removed — adversarial
    `stale-tab-resume-dies-on-removed-overrid`, run 3c757fd59001, 4/5):** on a resume of a bound
    session, `src/server/index.ts` validates the client's `overrides.claudeAccount` against the account
    registry BEFORE the binding reader runs. A tab still carrying an account that has since been
    DELETED gets a fatal `start.overrides rejected: claudeAccount must be null or the id of an existing
    account` and cannot resume at all — although the server already OWNS the account for that session
    (the identical frame with NO override resumes and runs on the bound account). The raw frame already
    drops a stale `provider` for exactly this reason; `claudeAccount` is not dropped. Requirement (b)
    ("another tab carrying the old override" must still continue on the new account) fails for the
    remove-old-account follow-up.
- **Could-not-test (verifier's honest list):** the REAL `claude` CLI keeping the same SDK session
  id/JSONL and genuinely billing a second subscription (scripted fake CLI pins the id, stub
  credentials — needs two real logged-in subscriptions and spends them); the CONTAINER leg of (c)
  beyond the switch-time refusal — a binding written while `direct` then read on a resume/fork after
  the project became `container` (reader has no isolation guard; needs docker + a built image the room
  has no sanctioned daemon for); property (e) in a real browser (app.js asserted by source match only,
  no DOM/headless render of paintAccountSel/paintAcctPop or the history pane); a genuine concurrent
  double-switch from two sockets and a switch while a permission card is pending (one socket per session
  + the one-server-per-data-dir lock blocked constructing the real race); a truncated binding store
  produced by a real concurrent writer (store uses writeAtomic — could only hand-truncate), and whether
  a read that degraded to "no bindings" then PERSISTS over other sessions' bindings on the next write.
- **Handoff to fixer:** (1) `switchAccountLive`'s inherit resolution must bind the account inheritance
  actually names (the machine default when the project stores null), or the switch must refuse an
  inherit pick rather than silently binding `{account:null}`; (2) on a resume of a session the server
  already has a binding for, the client-supplied `claudeAccount` override must not be able to FATAL the
  resume — drop/ignore the stale override the way `provider` is dropped, so the server-owned account
  decides. Both are the ordering/ownership seam the single-authority redesign introduced. HIGH-STAKES
  (billing + session-lifecycle + the FEAT-145 account model); the round-1/round-2/round-3 BROKEN
  verdicts stand until a fresh HOLDS supersedes them. A cross-provider (OpenAI) re-verify is due after
  2026-10-05, and the could-not-test list (real two-subscription billing, container-leg, browser (e),
  real double-switch race) still wants coverage.

### 2026-10-01 — fixing lane (fix, round 4) — finish the single authority (close both round-3 client reads)

- **Understood / confirmed hypothesis:** both round-3 breaks are places where a CLIENT-carried account
  value still decided a BOUND session's account. Fixed by FINISHING the single authority, not by adding
  guards: for a session the server owns a binding for, the server neither READS nor VALIDATES a
  client-carried `claudeAccount`. `regressed-from:` FEAT-160 round 3 (the ordering/ownership seam the
  single-authority redesign introduced). Two-break STOP NOT reached — neither break needed a new gate;
  both were closed by removing a client read.
- **Break 1 (mis-bill on an "inherit" pick) — the client was resolving a server-owned chain.** A fresh
  session resolves its account `override → project.settings.claudeAccount → MACHINE default
  (applyGlobalDefaults, global-settings.ts) → ~/.claude`. `public/app.js switchAccountLive` resolved an
  "inherit / Project default" pick as `project.settings.claudeAccount ?? null`, OMITTING the
  machine-default layer (which lives only on the server), so on a session billing the machine default M
  it bound `{account:null}` (~/.claude). **Fix:** the client sends the RAW choice (`inherit:true`, new
  field on the `switch-account` ClientCommand) and the SERVER resolves it with the SAME resolver a fresh
  session uses — `applyGlobalDefaults({claudeAccount: proj.settings.claudeAccount})` — so the binding gets
  the concrete account a new session would get. **Chosen storage:** resolve-now-to-a-concrete-account and
  pin it (not a "follow project" sentinel): a switched session's account is pinned by design, and an
  inherit pick MUST still write a binding (writing none would let another tab's stale override win — the
  whole FEAT-160 property). This matches fresh-session semantics at switch time (what the picker tooltip
  showed, "Inherit — currently <name>").
- **Break 2 (stale tab stranded when its old account was DELETED) — plus two sibling paths.** On a resume
  of a bound session, index.ts validated the client's `overrides.claudeAccount` against the registry
  BEFORE the binding reader ran, so a tab carrying a since-deleted account got a fatal "claudeAccount must
  be null or the id of an existing account." **Fix:** drop the client `claudeAccount` for a bound session
  before validation, exactly as a resume already drops `provider` (BUG-196) — new helper
  `dropBoundAccountOverride(sid, overrides)` in session-accounts.ts (reads the one owner; unbound sessions
  untouched, so the FEAT-145 refusal of a bad LAUNCH account is preserved). The charter's "close every
  client read in the same pass": the SAME class existed in two more index.ts paths and both are now
  guarded — the outbox pump's `handOver` resume (validated a FROZEN row's account → `failed`) and the
  `POST /api/outbox` enqueue (400'd a stale account). The binding reader (agent-bridge constructor)
  remains the ONE place that decides the account.
- **Inventory (rg every `claudeAccount` read in src/server + public/app.js):** the only sites that let a
  client/row value reach a bound session's account are the 3 resume/enqueue `validateSessionOverrides`
  calls — all now gated by `dropBoundAccountOverride`. Others are: validate.ts (the validator/owner),
  agent-bridge constructor (the reader/authority) + its downstream effective-config resolve,
  container-manager (switch refused for containers), registry (project settings). `public/app.js
  claudeAccountView()` is DISPLAY-only (picker labels / usage chip) and decides no account; it does share
  the pre-existing FEAT-145 habit of omitting the machine default from its DISPLAY string, but that is not
  a billing decision and is out of this ticket's scope.
- **Changed (UNSTAGED):** `src/server/events.ts` (+`inherit?` on the command), `src/server/session-accounts.ts`
  (+`dropBoundAccountOverride`), `src/server/index.ts` (switch handler resolves inherit; 3 resume/enqueue
  paths drop the bound account), `public/app.js` (`switchAccountLive` sends the raw choice), this ticket;
  `scripts/verify-feat-160.mjs` (+§8 inherit/machine-default, §9 bound-drop-before-validate, §10 inventory).
- **Verified:**
  - `verify-feat-160.mjs` — **46/46** (new §8/§9/§10 with synthesized round-3 must-FAIL twins: the old
    client inherit resolution binds ~/.claude not M; the raw validator FATALS on the deleted account; both
    non-vacuity controls present — unbound session keeps the override + still refuses a bad launch account).
  - `verify-feat-160-survivor-drain.mjs` — **8/8** (gate unchanged — refuses while a background lane drains,
    reaps on idle). `verify-feat-145-session-override.mjs` — **34/34** (anti-regression; §6 call-site
    invariant now covers all 4 validate sites, each passing `{ isolation }`).
  - `npm run gate` — **PASS (exit 0)**.
- **Still open / handoff:** HIGH-STAKES (billing + session-lifecycle + FEAT-145 account model),
  regression-prone (`regressed-from:` FEAT-160 r3) → an INDEPENDENT clean-room re-verify is REQUIRED before
  VERIFIED, exercising the still-untested list: real two-subscription billing, the live-ws inherit pick +
  deleted-account resume end-to-end, property (e) in a real browser, a real double-switch race, and a
  truncated binding store from a concurrent writer. Round-1/2/3 BROKEN verdicts stand until a fresh HOLDS.
  Cross-provider (OpenAI) re-verify due after 2026-10-05.
- **Symptom of a deeper design flaw?** no — this COMPLETES the ARCH-010 single-authority: the server owns
  "which account is this session on," and after this pass no client value reads OR validates it for a bound
  session. No new ARCH ticket.
