# BUG-184 — The git-write ledger records a commit as permitted/gate=pass when the commit never happened

- **Status:** FIXED (pending independent verification)
- **Severity:** medium
- **Area:** server (git-write enforcement / grant ledger)
- **Reported:** 2026-09-23 by BUG-173 residual-fix lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
`node scripts/git-grant.mjs <project> --status` (and the dashboard git panel it
mirrors) shows recent agent git writes such as `git commit  gate=pass`, implying
the commit succeeded. The commit did NOT happen — HEAD is unchanged. The
after-the-fact audit that exists to tell the user "what did agents write to git"
asserts a write that was refused.

## Repro
1. Mint a valid grant for a project (`node scripts/git-grant.mjs <project> --minutes 30`).
2. From an agent session, run `git commit …` via the shim path (the normal path —
   the shim is on the session PATH).
3. The shim consult to `/api/git-shim/decide` for a publishing subcommand takes
   longer than the shim's client budget and aborts, so the commit is refused and
   HEAD does not move (this is the BUG-173 residual; the timeout itself is fixed
   there).
4. Run `node scripts/git-grant.mjs <project> --status`. The ledger shows the
   commit as `gate=pass` — recorded as permitted, though it never ran.

## Expected
The ledger records what actually HAPPENED, not what the host authorized. A write
the caller never executed (aborted consult, shim refusal, non-zero git exit, exec
failure) must not appear as a successful/permitted write — or must be marked with
its real outcome, so the audit cannot claim a commit that HEAD contradicts.

## The design that produces the class
`evaluateGitWrite` (`scripts/lib/git-grant.mjs`) calls `recordGitWrite` at the
moment it DECIDES to permit — before, and independent of, whether the caller then
runs git successfully. Over the loopback shim path the decision and the execution
live in two different processes: the host decides ALLOW and records it, then
returns; the shim client may already have aborted (BUG-173's timeout), or the
subsequent real-git exec may fail — the host never learns. So the record is a
record of the DECISION, mislabeled as a record of the WRITE. The `gatePassed`
field compounds it: `gate=pass` reads as "this commit passed the gate and landed",
when it only means "the gate was clean at decide time". This is a false-proof: a
durable artifact asserts an operation succeeded when it was refused.

## Proof bar (what must be true to call it fixed)
1. A commit whose shim consult aborts (or whose git exec fails / exits non-zero)
   does NOT appear in the ledger as a permitted/succeeded write — or appears with
   an explicit non-success outcome that a reader cannot mistake for a landed commit.
2. A commit that actually lands still records as before (no regression to the
   genuine-success case).
3. `--status` / the dashboard panel render the outcome truthfully; `gate=pass` is
   not shown for a write that never executed.

## What would falsify the fix
- The ledger still shows `gate=pass` for a commit HEAD does not contain.
- A genuinely successful commit stops being recorded (over-correction).

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `scripts/lib/git-grant.mjs` `evaluateGitWrite` — calls `recordGitWrite` on the
    allow path, decoupled from actual execution.
  - `scripts/lib/git-grant-store.mjs` `recordGitWrite` / `listGitWrites` — the
    ledger and its `gatePassed` field.
  - `src/server/index.ts` `POST /api/git-shim/decide` (~:2442) — the two-process
    split where the host decides+records but the shim client executes (or aborts).
  - `scripts/lib/git-shim.mjs` `runGitShim` — the client that actually execs real
    git AFTER the host has already recorded; the only place the true outcome is known.
- Related tickets: BUG-173 (the grant-aware shim + the timeout residual that made
  this visible), FEAT-108 (the grant ledger), ARCH-010 (one owner per fact — the
  ledger currently owns "decided", not "happened").
- Repro test: extend `scripts/verify-bug-173-grant-aware-shim.mjs` or add a new
  verify that asserts an aborted/failed shim commit leaves no permitted record.
- Known dependencies / blockers: the true outcome is known only in the shim
  process after exec; a truthful ledger needs the shim to report the executed
  outcome back, or the record to be deferred/confirmed rather than written at
  decide time.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-23 — filing lane (found while fixing the BUG-173 timeout residual)
- **Understood:** `recordGitWrite` is called at decide time in `evaluateGitWrite`,
  so the ledger records the host's DECISION, not the caller's WRITE. Over the shim
  path the two are in different processes and can disagree: with BUG-173's 2000ms
  timeout, the host decided ALLOW and recorded `git commit gate=pass` while the
  shim had already aborted and refused — HEAD never moved, yet the audit shows a
  passed commit.
- **Changed:** nothing (ticket only; no fix implemented — filed per charter to
  keep the false-proof class from hiding inside the BUG-173 timeout fix).
- **Verified:** observed live — `node scripts/git-grant.mjs claude-station --status`
  listed `git commit  gate=pass` entries at 13:07 while HEAD stayed at dc1f4ea and
  the shim had refused those commits.
- **Still open / handoff:** decide where the true outcome is recorded — defer the
  ledger write until the shim reports the executed result, or record a pending
  entry the shim confirms/cancels. Must not regress the genuine-success case.

### 2026-09-23 — fixing lane (round 1, class=fix)
- **Hypothesis CONFIRMED against real code:** `evaluateGitWrite`
  (`scripts/lib/git-grant.mjs`) called `recordGitWrite` at DECIDE time in the HOST
  process with `gatePassed:true`, decoupled from whether the caller then ran git.
  Reproduced directly: mint grant → `evaluateGitWrite({argv:['commit',...]})` with a
  passing gate but NO execution → `listGitWrites` row is `{gatePassed:true}` and
  renders `gate=pass` for a commit that never ran; the record had no field capable
  of expressing execution state.
- **Fix (ARCH-010 — owner declares the fact):**
  - `git-grant-store.mjs`: records now carry a stable `id` and an `outcome`
    lifecycle (`permitted`|`executed`|`failed`|`blocked-gate`) + `exitStatus`/
    `executedAt`. New `confirmGitWrite(id,{exitStatus})` — the EXECUTOR moves a
    `permitted` record to `executed` (status 0) / `failed`. One-way: a terminal or
    unknown-id confirm is a no-op, so a late/duplicate callback cannot fabricate or
    flip an outcome.
  - `git-grant.mjs`: decide-time record is `permitted` (allow) / `blocked-gate`
    (gate refused), NEVER a false `executed`.
  - `git-shim.mjs`: `runGitShim` reports the REAL git exit via new
    `confirmHostExec` → `POST /api/git-shim/confirm` after `spawnSync`; decide now
    returns `recordId`. Best-effort: a failed confirm never changes the git exit
    the user sees, it just leaves the record `permitted` (honest: unknown).
  - `src/server/index.ts`: `/decide` returns `recordId`; new `/api/git-shim/confirm`
    route (same shim-secret gate) calls `confirmGitWrite`. `.d.mts` updated.
  - `scripts/git-grant.mjs` `--status`: renders `outcome` first (EXECUTED / FAILED /
    permitted(not confirmed run) / BLOCKED(gate)); old records w/o the field show
    `outcome=unknown(pre-BUG-184)`.
- **Verified:** `node scripts/verify-bug-184-ledger-truthful-outcome.mjs` →
  17 passed, 0 failed. Legs: must-FAIL vs the PRE-FIX modules (via `git show HEAD:`)
  proves the false `gate=pass`; post-fix state machine; the ticket's aborted case
  (never-confirmed permit stays `permitted`); a REAL `git commit` through the
  installed shim + a REAL host process (decide+confirm) → landed commit records
  `executed`/exit 0/HEAD moved, non-zero git records `failed`/HEAD unmoved.
  Anti-regression: verify-feat-108-git-grant 40/0, verify-feat-135-git-shim 31/0.
  `npm run gate` → PASS (exit 0). NOTE: verify-bug-173 shows 1 pre-existing failure
  UNRELATED to this change — its `[must-FAIL]` leg reads `git show HEAD:git-shim.mjs`
  and asserts the pre-fix module lacks `resolveGitShim`, but BUG-173 already landed
  in ca672b9 so HEAD's shim has it; it reads committed content, not this lane's
  uncommitted tree (27/1 vs the leg's own stale assumption).
- **Historical entries:** in-memory ledger + durable audit-sink log. Pre-fix rows
  have NO `outcome` field and are therefore DISTINGUISHABLE from post-fix rows; the
  `--status` renderer flags them `outcome=unknown(pre-BUG-184)`, so their `gate=pass`
  cannot be trusted to mean "landed". The in-memory ledger is memory-only and clears
  on server restart. NOT migrated/rewritten (per charter). No migration needed — old
  rows self-identify by the missing field.
- **Still open / handoff:** high-stakes (false-proof / audit integrity) — flagged for
  an independent clean-room verify pass. The FEAT-108 Bash-hook path (command-string
  decide) has no executor callback, so its records stay `permitted` (truthful: the
  host never observes that exec); only the shim path can reach `executed`. Not a
  regression — the hook path never had execution truth to begin with.

### 2026-09-23 — independent verify (round 2, class=verify)
Re-ran the fixer's suite EXACTLY once: `node scripts/verify-bug-184-ledger-truthful-outcome.mjs`
→ 17 passed, 0 failed (real output). Dispatch (openai) available; prioritised
direct EXECUTED adversarial attacks over a cross-provider pass because they yield
ground-truth breaks — cross-provider clean-room still recommended below.

VERDICT: **PASS on the filed/honest scenario; FAIL of the requirement's absolute
form via an under-authenticated confirm channel.** The honest decouple the ticket
reported IS fixed and unregressed: a decide-time record is `permitted` (renders
`permitted(not confirmed run)`, never mistakable for a pass); an aborted/never-
confirmed permit stays `permitted`; the real executor moves it to `executed`(0)/
`failed`(non-zero); `blocked-gate` for a gate refusal; `confirm(status=null)` →
`failed` (not a false pass). E2E over a real shim+host confirms landed→executed,
non-zero→failed.

Attacks the fixture does NOT cover (all EXECUTED, /tmp/bug184-attacks.mjs, real output):
- **A1 forged/guessable recordId → FALSE-PROOF.** ids are sequential `w1,w2,…`;
  `/api/git-shim/confirm` is gated ONLY by the host-wide shim secret, which
  git-shim-secret.mjs itself documents any same-uid agent can read from the 0755
  shim file. A peer confirms `w1` status=0 BEFORE the true executor reports failure;
  first-confirm-wins locks the record `executed`/exit=0 and the executor's truthful
  `confirm(status=1)` is a no-op. Ledger now reads a LANDED commit for a git that
  FAILED — the exact false-proof the ticket set out to remove, reintroduced under a
  same-uid agent's control. `confirmGitWrite` has NO binding of recordId→owner.
- **A2 cross-project confirm → executed.** Project B's session marks project A's
  pending record `executed`; confirm never checks the record's project.
- **A3 id reuse across restart.** ledger is memory-only and `ledgerSeq` resets to 0
  on restart; a stale pre-restart confirm for `w1` lands on a DIFFERENT new `w1`
  write and marks it executed. Store-level flaw is real (no restart-epoch in ids);
  reachability via the real HTTP path is LOW — the shim targets a baked host
  URL/port and sends confirm synchronously seconds after decide, so crossing a
  restart is timing-narrow. Reported as a latent design smell, not a live break.

Weighing: A1/A2 require the same-uid adversarial lane that FEAT-135/BUG-173
EXPLICITLY bracket as out-of-scope and "fundamentally unclosable between two
processes of the same uid." BUT the prior residual's justification ("possessing the
secret only lets it call decide, which re-runs evaluateGitWrite — it cannot mint a
grant") does NOT extend to confirm: confirm re-validates nothing, it writes the
caller's claimed status straight into the audit. So the fix makes the "what
happened" field self-reported by the very (untrusted) party the audit exists to
report ON. Cheap hardening exists and is NOT done: bind recordId→grantKey/session
and reject cross-owner confirms; use unguessable random ids; add a restart epoch.

COULD-NOT-TEST: a full loopback exercise of the live /confirm route against the
real running host (used the store-level API + the suite's mini-host, which mirror
the route body); the real durable audit-sink log file on disk; a genuine
concurrent restart race (A3 reachability argued, not staged); cross-PROVIDER
clean-room (dispatch available, not run — still recommended for this false-proof/
audit-integrity change).

Verified-by: independent-verifier (Opus 4.8), 2026-09-23, executed. Recommend a
follow-up ticket for the confirm-channel forgery/owner-binding gap and an
independent clean-room pass before VERIFIED.

### 2026-09-23 — fixing lane (round 3, class=fix) — closes the same-uid forgery holes
- **Reproduced (independent-verify fixture `/tmp/bug184-attacks.mjs`, PRE round-3):**
  3 false-proofs. A1: sequential `w1` ids are guessable + no capability + first-
  confirm-wins → a same-uid peer forges `executed`/exit 0 for a write whose real git
  FAILED, and the true executor's honest failure is then a no-op. A2: a foreign
  project confirms another project's record (no owner binding). A3: `ledgerSeq`
  resets on restart so a stale pre-restart `w1` confirm lands on a different reused
  id. Same-uid is IN SCOPE (the ledger audits same-uid agent processes).
- **Fix (ARCH-010 — the owner declares the binding once; callers only present it):**
  - `git-grant-store.mjs`: every record now carries an unguessable per-record
    capability (`randomBytes(32)`) held in a side map `confirmCaps` (id → {token,
    projectKey}), NEVER copied onto the stored record (so `listGitWrites`/`--status`
    can't leak it); `recordGitWrite` returns the token ONLY to its immediate caller.
    ids are `w<seq>-<bootNonce>` (per-process nonce → no cross-restart reuse, A3).
    `confirmGitWrite(id,{token,projectKey,exitStatus})` requires a constant-time
    token match AND owner-project match; a wrong/absent token, foreign owner,
    unknown id, or a REPLAY (capability is single-use, deleted on first confirm) is
    REJECTED and recorded as `confirmAnomalies++` on the row — never silently
    ignored. Returns `{ok,reason,record}`.
  - `git-shim.mjs`: decide response carries `confirmToken`; `confirmHostExec` sends
    token + owner projectKey and is a no-op without the token.
  - `src/server/index.ts`: `/decide` returns `confirmToken` (only on a granted
    allow); `/confirm` takes token+projectKey, warns on `unauthorized-confirm`.
  - `scripts/git-grant.mjs` `--status`: surfaces `!TAMPER-ATTEMPTS=N` when a row has
    rejected confirm attempts. `.d.mts` updated (RecordedGitWrite, GitWriteConfirmResult).
- **Verified:** `node scripts/verify-bug-184-ledger-truthful-outcome.mjs` → 28/0
  (adds A1/A2/A3 attack legs, single-use replay→anomaly, token-not-leaked, blocked
  record can't be revived). Coordinator fixture `/tmp/bug184-attacks.mjs` → 0 false-
  proofs (A1/A2/A3 all rejected → stay `permitted`). Anti-regression:
  verify-feat-108-git-grant 40/0, verify-feat-135-git-shim 31/0. `npm run gate` PASS
  (exit 0). verify-bug-173 27/1 — the SAME pre-existing failure (its `[must-FAIL]`
  leg reads `git show HEAD` which already has BUG-173 landed; unrelated to this tree).
- **Attribution rule:** anything not attributable reads as NOT a pass — a permit that
  is never (or wrongly) confirmed stays `permitted` (never `executed`); only a valid
  single-use capability from the record's owner yields `executed`.
- **No migration:** old rows self-identify by the missing `outcome`/`confirmAnomalies`
  fields; nothing rewritten.
- **Still open:** independent clean-room re-verify still warranted (false-proof /
  audit-integrity class). FEAT-108 Bash-hook path still has no executor callback →
  its records stay `permitted` (truthful; the host never observes that exec).

### 2026-09-23 — independent verify (round 4, class=verify) — of the round-3 fix
VERDICT: **PASS. STOP** — the round-3 fix closes A1/A2/A3 by construction; the only
residual is a non-false-proof noise vector, converted below to a standing property.

Ran ONCE each (real output): fixer suite `verify-bug-184` → **28 passed, 0 failed**
(now includes explicit A1/A2/A3 legs + capability/replay/anomaly legs). My old
attack fixture `/tmp/bug184-attacks.mjs` → **0 false-proofs** (A1 guessed id no
longer resolves + wrong/no token rejected → stays permitted; A2 foreign owner
rejected; A3 stale `w1` rejected). Anti-regression: verify-feat-108 40/0,
verify-feat-135 31/0. `npm run gate` → PASS (exit 0).

A1/A2/A3 are closed BY CONSTRUCTION, not a skippable check: the record id is still
guessable (my N4 proved a peer learns the 6-byte boot nonce from its OWN record id
and enumerates the monotonic seq to reconstruct a victim's full id EXACTLY), yet
every forge is rejected because the AUTHORITY is the per-record `randomBytes(32)`
capability token — held in a side-map, never on the stored row, never in the audit
sink — plus the owner `projectKey`. Guessing the id buys nothing.

New-shape attacks (named first; `/tmp/bug184-r3-attacks.mjs`, all EXECUTED, 0
false-proofs):
- **N1 token leak** — capability is NOT in `listGitWrites` output and NOT passed to
  the audit sink (`auditSink(rec)` gets the tokenless `rec`; the token is only on
  recordGitWrite's return). Console.warn on rejection logs recordId+projectKey, not
  the token. No env/argv exposure (threaded as fn args). CLOSED.
- **N4/N5 forged/coerced confirm** — wrong token, or attacker's own valid token
  under the victim's projectKey, or own token+own project on a foreign id → all
  `unauthorized-confirm`; victim stays `permitted`. status coercion needs a valid
  token you don't hold. CLOSED.
- **N2 concurrent/replay double-confirm** — first valid confirm is one-way + single
  use (cap deleted, synchronous, no event-loop yield between check and delete); the
  replay with the REAL token → `unauthorized-confirm`; `failed` never flips to
  `executed`. CLOSED.
- **N6 side-map lifetime** — an evicted record (ring overflow deletes its cap) →
  `unknown-record`, never resurrected; an unconfirmable/never-confirmed permit stays
  `permitted` = "not confirmed run" (never a pass). Across a restart the memory-only
  ledger+caps are empty and the boot nonce changes, so a stale id → `unknown-record`.
  CLOSED.
- **N3 anomaly channel — MINOR RESIDUAL (not a false-proof).** A same-uid peer that
  has done ≥1 decide knows the boot nonce and can enumerate ids to send unauthorized
  confirms at another record, INCREMENTING its `confirmAnomalies` counter. This
  can NEVER flip an outcome and can never decrement/forge-down (verified: spam left
  a `permitted` row `permitted`, counter 3→8). It is the INVERSE of the harm class —
  it can only cast DOUBT on a row (make a genuine `executed` show `!TAMPER-ATTEMPTS`)
  or add noise, never manufacture a false pass. Requires the same-uid adversary
  FEAT-135 already brackets as out-of-scope/unclosable. Non-blocking.

Inverse check (a real success the ledger fails to record): none — a landed commit
records `executed`/exit 0 (suite e2e); a dropped/timed-out confirm leaves the record
present as `permitted` (honest, not dropped, not a pass); the FEAT-108 hook path
stays `permitted` (documented; truthful — the host never observes that exec).

Self-report of one's OWN record (a tampered shim reporting status=0 for a failed
git) remains possible but is bounded to the caller's own project and is the
pre-existing unclosable same-uid residual (such an agent could bypass the shim and
run git directly); NOT introduced or widened by this fix — owner binding stops it
reaching ANOTHER project's record.

COULD-NOT-TEST: a live loopback exercise of the real `/api/git-shim/confirm` route
against the running host (used the store API + the suite's mini-host, which mirror
the route body incl. the shim-secret gate); a genuine multi-process concurrent
confirm race (argued from Node single-thread + synchronous confirmGitWrite, not
staged); cross-PROVIDER clean-room (dispatch available, not run — the executed
break/close evidence here is ground truth).

STOPPING RULE: this round yielded only the N3 noise residual (non-false-proof), so
I say STOP rather than spawn round 5. Recommended standing property to add to
verify-bug-184 (lock it, don't re-round): "anomaly-spam on a foreign/guessed id
never flips or decrements an outcome — a spammed `permitted`/`executed` row keeps
its outcome; only the counter rises." The false-proof bar is met.

Verified-by: independent-verifier (Opus 4.8), 2026-09-23, executed.
