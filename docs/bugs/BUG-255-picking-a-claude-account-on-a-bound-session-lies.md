```orchard-ticket
{
  "id": "BUG-255",
  "type": "bug",
  "title": "Picking a Claude account on a bound session lies, never switches",
  "summary": "On a session the server bound to account A (FEAT-160), picking account B shows B and claims it took, but the CLI keeps billing A and a resume drops the pick. The indicator renders from the client override chain, never the account actually in effect, so it misrepresents the subscription spent.",
  "impact_if_we_wait": "The user thinks a session is on the subscription they picked while it keeps spending another, with no honest signal and no way to move it. Live case reproduced in the real data dir: a session bound to account A while the UI shows account B.",
  "current_need": "The indicator must show the account the session is actually on (the server-owned fact), and a pick must either really switch the session to the chosen account or be refused with a visible reason — never a silently-dropped override.",
  "severity": "high",
  "area": "server/composer",
  "reported": "2026-10-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session with a server binding shows its bound account, regardless of any client override; a not-yet-applied pick is labelled pending, never current.",
    "Picking another account on a LIVE session reaps and relaunches the CLI under it (child CLAUDE_CONFIG_DIR = new account dir), via the FEAT-160 path.",
    "Picking on a BOUND, not-live session rewrites the binding durably so the next resume launches under the pick; no override is dropped.",
    "A switch that cannot proceed (live work, a turn in flight, a container) is refused with a visible reason; the indicator keeps the true account.",
    "A session with no binding that is not live keeps the FEAT-145 per-launch override behaviour exactly (the override is honoured, not dropped).",
    "No credential contents are ever printed or logged."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "dde6ccb1-cb28-4569-a9f9-1a7b425295de",
      "verdict": "holds",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T17:42:14.262Z",
      "author": "verify lane (mixed-state)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "6e95ad19a709dcc643644604ed8840b29ee193d3ad878897d68c8dbf9b460d32",
      "verify_mode": "mixed-state",
      "note": "Mixed-state verify (58 FEAT-164/175 hunks disclosed). Same-provider fallback: OpenAI quota hit mid-run. Fixer suite 21/21 + 2 adversarial HOLD. NOT run: verify:bug-255-ui (no browser), container refusal (no Docker)."
    },
    {
      "provider": "anthropic",
      "model": "opus[1m]",
      "run_id": "72d66ca2-a3a9-410a-9dd8-9fd3992cffa8",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T20:26:44.970Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "0c6b3435-79e9-439c-ab69-dda0eb578854",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T21:41:15.168Z",
      "author": "verify lane r2 (Claude fallback; OpenAI quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent clean-room verify, untangled HEAD+BUG-255(r1+r2) working-tree candidate (tree 0588731fc9a9). Floor 21/21. BROKEN: (a) indicator-truth TWO-BREAK (restart old-boot stale fact; container empty-fact->stale override) -> design review; (c) failed-stop orphans old CLI. Detail in Activity log."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "e43dd24e-0b05-46d7-a248-10f8469dc15b",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T23:18:28.784Z",
      "author": "verify lane r3 (Claude fallback; OpenAI quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "FINAL-round independent verify, untangled HEAD+BUG-255(r1+r2+r3) candidate (faithful: 21/46/5/17/18). OpenAI quota->Claude opus-5 fallback (decorrelation reduced). BROKEN: TWO-BREAK on unbound-display-truth + container-drift. Detail in Activity log."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "c36f27a6-00df-4267-9cd6-1394e811e7fa",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T09:01:44.045Z",
      "author": "verify lane r4 (Claude fallback; OpenAI quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent clean-room verify, untangled HEAD+BUG-255 r1-r4 candidate (tree 2fa2592d6c07). OpenAI quota mid-run; Claude same-provider fallback. Floor 21/0. BROKEN, iso-drift-live-switch: a LIVE pick after project goes container is accepted but next launch stays project account. See Activity log."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "a6333233-7c63-494b-ab28-c0edea2fe36e",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T10:06:27.694Z",
      "author": "verify lane r5 (Claude same-provider; OpenAI quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Independent clean-room verify, untangled HEAD+BUG-255 r1-r5 candidate. Fixer suite 11/0 (round-4 break closed). BROKEN: a PATCH to container landing mid-switch (during close, not before) still acks switched+binds, fact.next stays project acct -- two-break -> design review."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-255 — Picking a Claude account on a bound session lies, never switches

## Symptom
User requirement (verbatim): "it should actually switch and the UI should never misrepresent current state". In a direct (non-container) project, a session is bound server-side (FEAT-160, session-accounts.json) to account A. The user picked account B in the account indicator. The indicator shows B; the live CLI's CLAUDE_CONFIG_DIR is account A's dir. The pick neither switched the session nor was refused — it was silently ignored.

## Repro
1. Have a session with a server-owned account binding to account A (any session that was switched once, or whose binding exists in session-accounts.json).
2. With that session loaded but not live on the socket, open the account indicator and pick account B.
3. The indicator now shows B and says it applies. Reality: the binding is still A.
4. Send a message -> the resume reads the binding and `dropBoundAccountOverride` discards the B override; the CLI launches/continues under A. The indicator still shows B.

## Expected
- The indicator shows the account actually in effect (the server-owned binding / the account the CLI launched under), never a value worked out only on the client.
- A pick on a bound session actually switches it (rebind + relaunch/resume under B) or is refused loudly with the reason; the indicator stays on the true account until the switch truly lands.

## Diagnosis (verified against the real code + the live data dir)
- DISPLAY defect. `claudeAccountView()` (public/app.js ~:491) returns `state.overrides.claudeAccount ?? project.settings.claudeAccount ?? 'default'` — the client override chain only. `paintAccountSel` (~:14488) renders from it. The server never delivers the session's effective account: `session-init` (src/server/agent-bridge.ts ~:5406) emits model/permissionMode/lockedProvider but NOT `this.effective.claudeAccount`, and the sessions list route (src/server/index.ts ~:1872) carries no `boundAccount`. So the one fact the client needs to show the truth is never declared to it (ARCH-010 gap).
- ACTION defect. `pickAccount` (public/app.js ~:14570): when the dock session is not live (`dockLive()` false), it just sets `state.overrides.claudeAccount` and persists. On resume, `dropBoundAccountOverride` (src/server/session-accounts.ts :117) drops that override because a binding exists (getSessionAccount !== undefined), so the CLI stays on A. The live path (`switchAccountLive` ~:3871 -> `switch-account` route src/server/index.ts :6129) does rebind+reap, but it requires a live `session` on the socket and is gated by `closeLifetime()!=='no'`; the not-live case has no equivalent, so a bound-but-not-live pick is a no-op that the UI reports as success.

## Design

### Invariant (one testable sentence)
The account the indicator shows for a session always equals the account the session's CLI actually runs under (the server-owned binding, else the launch account); a pick either switches the session to the chosen account (rebinding durably, and if live relaunching the CLI under it) or is refused with a visible reason, and it never leaves the indicator showing an account the session is not on.

### Display (ARCH-010: the owner declares it once; the client renders it)
- `session-init` emits `account: this.effective.claudeAccount ?? null` — the account the CLI actually launched under (already computed, binding applied).
- The sessions list route (`/api/projects/:id/sessions`) adds `boundAccount`: `getSessionAccount(sessionId)?.account` (a string id, `null` for an explicit default binding, or omitted when there is no binding).
- Client: track the dock session's server-declared account (e.g. `state.sessionAccount`), set from `session-init` (live) and from the sessions payload when a session is loaded resumable. `claudeAccountView()`/`paintAccountSel` render THAT as current whenever the dock holds a session the server owns an account for; a differing client pick is shown only as pending. A session with no server fact (no binding, never switched) still follows the override chain — that is honest, because there is no competing owned fact.

### Action (a pick on an owned session goes through the server, never a droppable override)
- Live session on the socket -> the existing FEAT-160 `switch-account` reap+relaunch path, unchanged.
- Bound session not live on the socket -> a rebind path: validate the chosen account (existence + container refusal via validateSessionOverrides, ready/credential via resolveLaunchAccountDir, inherit resolved server-side under applyGlobalDefaults exactly as switch-account does), then `setSessionAccount(sid, normalized)` durably and ack the resolved account. The next resume reads the new binding at the single spawn chokepoint (AgentSession constructor) and launches under it. No override is armed.
- No binding + not live -> arm the per-launch override exactly as FEAT-145 today (it is honoured; nothing drops it because no binding exists).
- Refusal is loud: a turn in flight, live background work (`closeLifetime()!=='no'`), or a container project each refuse with the reason and leave the indicator on the true account (which, after the display fix, it already shows).
- Container projects keep project-scope-only account selection (FEAT-145); a per-session pick stays refused with its reason, and the indicator shows the project account truthfully.

## Proof bar
Must-FAIL against a SYNTHESIZED pre-fix state (not HEAD), then PASS after the fix, driven in the real UI (Playwright) on an isolated scratch server (station-boot isolatedServerEnv; stub CLI / fake credentials written only into the scratch dir; never copy real credentials; never print token contents):
- (a) a bound session shows its TRUE (bound) account in the indicator, not the client override;
- (b) picking another account on a live session relaunches the CLI under it — asserted via the scratch child's CLAUDE_CONFIG_DIR read from /proc/<pid>/environ;
- (c) a blocked switch (live background work) is visibly refused with the reason and the indicator does NOT change;
- (d) the non-live pick-then-resume path launches under the picked account (binding rewritten, resume honours it).
Must-FAIL anchor: against the pre-fix code, (a) shows the override value while the binding differs, and (d)'s override is silently dropped on resume.

## Context pack (grows — the "where to look")
- public/app.js: `claudeAccountView` ~:491, `paintAccountSel` ~:14488, `paintAcctPop` ~:14540, `pickAccount` ~:14570, `switchAccountLive` ~:3871, `finishAccountSwitch` ~:3907, ack handler ~:11903, `dockLive` ~:9844, session-init handler ~:12100.
- src/server/index.ts: `switch-account` route :6129 (gate :6225), sessions list route :1851-1960, `dropBoundAccountOverride` call sites :2520/:5105/:5344.
- src/server/agent-bridge.ts: binding reader :1386-1391, `session-init` emit :5406.
- src/server/session-accounts.ts: `getSessionAccount`/`setSessionAccount`/`dropBoundAccountOverride`.
- Invariants: docs/CONVENTIONS.md ARCH-010; FEAT-145 (container account is project-scope only); FEAT-160 (server-owned binding).
- Related: FEAT-160, FEAT-145, ARCH-010, BUG-196.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-13 — worker (fixing r1 — plan review)
- **OpenAI review: PLAN SOUND WITH CHANGES; revised plan recorded:** Plan reviewed independently by OpenAI (dispatch openai, run 01a135fe-f3f7-7511-be2c-603ed2d0abb8, class plan+review). VERDICT: PLAN SOUND WITH CHANGES. The two-part approach (server declares the account; one switch operation) survives; six load-bearing corrections fold in and the plan below supersedes the original.

  CORRECTIONS FROM REVIEW (all verified against the code):
  1. The server ALREADY declares the running account: `effectiveConfig()` carries `effective.claudeAccount` (effective-config event, stored client-side ~app.js:11865) and the reattach ack sends `effective: live.effective` (index.ts ~:5547). The indicator ignores it. So the live-display fix is to READ the existing declaration, not only add a channel. Still-real omissions: `session-init.account` (add to BOTH producers: bridge agent-bridge.ts ~:5406 AND synthetic reattach init index.ts ~:5556) and a sessions-list / transcript-tail bound/launch account.
  2. "No binding" does NOT mean "no server fact." A never-switched session still has a server-owned launch account (`AgentSession.effective.claudeAccount`) and may be running detached (another tab, the outbox pump) while this tab only views it. The client override chain is therefore NOT a safe "current" display. Also two pre-existing display bugs in claudeAccountView() (app.js:491): explicit override `null` (= implicit default) collapses via `??` to project account A; and the machine-default layer (applyGlobalDefaults, global-settings.ts:237) is omitted, so an inherited account shows wrong.
  3. ARCH-010: the launch account and the next-resume binding are DISTINCT FACTS that can legitimately differ (the live switch writes binding B before closing the CLI still on A — a real disagreement window; a close failure extends it). Declare three named facts, not one overwritten field: (i) current-launch account when a launch exists, (ii) committed next-resume binding, (iii) switch status incl. unresolved. Client renders their declared meanings; a late list response must never overwrite a newer switch. Do NOT add state.sessionAccount as a second copy beside state.effective — feed ONE session-keyed declaration store (mirror the existing lockedProviders Map, app.js:995). Fix paintAcctPop's "Project default — currently <x>" so it stops calling the current session account the inherited default.
  4. dockLive() is a view/socket predicate, NOT the server's session-lifetime authority. Authorizing an offline rebind on !dockLive() is unsafe: the session may be running via another tab's bridge or the outbox pump (detached) or a restart survivor; the pump's next delivery reuses that bridge, bypassing the constructor that reads the binding. The action must consult the server lifecycle authorities the pump already distinguishes (bridge / survivor / new-resume, index.ts ~:4990): live bridge -> guarded live reap+rebind or refuse visibly; survivor/background work -> refuse; delivery/resume in flight -> refuse retryable; PROVEN-stopped -> durable rebind, no reap. Hold the per-session delivery reservation across classify+commit (one check before an await is not enough).
  5. ONE switching operation: extend `switch-account` to carry explicit target identity (sessionId + encodedDir + project) over a transport that does NOT start a turn (a resumable view may have no socket), rather than a second independently-gated path. Server validates membership + running state and chooses reap vs durable-rebind vs refuse. Preserve: existence/normalization + container refusal, resolveLaunchAccountDir readiness, server-side inherit resolution from the AUTHORITATIVE current project, busy/lifetime/delivery/resume-start gates when a launch exists. Revalidate readiness at actual launch (credentials can change after a rebind). Validate real session ownership (a syntactically valid sid is insufficient).
  6. Commit-failure semantics: setSessionAccount (session-accounts.ts:94) mutates the cache BEFORE persist — publish the cache change only after a successful persist (or restore on failure), else a refused handler leaves in-process reads seeing the new account. A successful persist + failed close cannot honestly report "unchanged": report running vs committed-next and reconcile. The client's 8s switch timeout (app.js:3891) wrongly asserts the old account still runs — a lost ack is OUTCOME UNKNOWN, needs reconciliation, not a claim.

  REVISED DESIGN
  - Display: one session-keyed declaration store client-side (launchAccount | boundAccount | pending, keyed by sdk session id). Server feeds it from session-init.account (both producers), effective-config (already carries it), reattach ack, and transcript-tail + sessions-list (getSessionAccount; distinguish `null` default-binding from absent). The indicator for the dock session shows: running launch account if a launch exists; else the next-resume binding; else "unknown / not recorded" for a stopped unbound historical session; a user's not-yet-applied pick shows as pending, never as current. Fix claudeAccountView explicit-null + machine-default (inherited shown as inherit, not a concrete wrong account). openSession replaces the account reference synchronously by incoming session identity; socket drop retains the last server declaration (never falls back to overrides); switch ack updates only the named session.
  - Action: pickAccount routes every pick on a session that has a server launch/binding through the extended switch-account (with target identity); it never arms a droppable override for such a session. A true next-session/no-session pick arms the FEAT-145 override as a labelled intention. Container stays project-scope-only with a visible refusal.

  PROOF BAR (revised): freeze the real working-tree baseline (incl. uncommitted prereqs) and synthesize the pre-fix client by reversing ONLY this fix (not a diff vs HEAD). Must-FAIL anchors: (a) bound session shows true bound account not the override; (d) non-live pick-then-resume launches under the pick (override no longer dropped); PLUS unbound-launch-A-shown-with-stale-override-B, machine-default inheritance, explicit-null default, and the detached-pump-running case where !dockLive() must NOT authorize a silent offline rebind. Regression controls (expected to already pass): live reap+resume switch (send the next message — the live path resumes on next message, not an instant relaunch), background-work refusal, container refusal, unready/invalid account refusal, unbound per-launch override still honoured, stale/deleted override in a queued row. Durability across a scratch-server restart. UI driven in a real headless browser over a busy-state fixture; inspect ONLY the scratch child's CLAUDE_CONFIG_DIR value via /proc/<pid>/environ (never the whole env, never token contents).

  HIGH-STAKES: session-lifecycle + concurrency + regression-prone -> independent clean-room verify REQUIRED after the build; generation is not its own verifier. Deep concurrency edges the build will cover vs explicitly flag for the verifier are itemised in the fixing-round entry.

### 2026-10-13 — worker (fixing r1)
- **fix built (display + action), 21/21 + UI 5/5 + gate PASS; independent verify warranted:** Understood — both defects confirmed against the real code AND the live data dir, and the revised (post-review) design built end-to-end.

  CHANGED FILES (all unstaged; orchestrator does git):
  - src/server/session-accounts.ts — setSessionAccount now PERSISTS before it publishes into the cache (a failed write leaves disk+cache on the old binding; a refused switch no longer leaves in-process reads seeing a phantom new account). Review #6.
  - src/server/events.ts — session-init event carries `account`; the switch-account ClientCommand carries optional offline-target fields (sessionId/encodedDir/projectId).
  - src/server/agent-bridge.ts — session-init emits `account` = this.effective.claudeAccount (the account the launch actually runs under), anthropic only.
  - src/server/index.ts — (a) reattach session-init also emits `account`; (b) boundAccountField() declares the server-owned next-resume binding on the sessions-list AND both transcript-route branches (distinguishing a null default-binding from an absent one); (c) offlineRebindAccount() — the ONE offline-rebind operation: validate (existence/normalization/container refusal/ready) + server-side inherit resolution from the authoritative project, then classify via the server's lifetime authorities (bridgeForSession / survivingHostForSdkSession / deliveryInFlight / resumeStarting / activeDeliveryFor) and durably rebind ONLY a proven-stopped session, else refuse visibly; the reservation is held across classify+commit; (d) the ws switch-account `!session` branch and a new HTTP route POST /api/sessions/:sid/account both delegate to it.
  - public/app.js — one session-keyed declaration store (sessionAccounts Map: {launch,bound}, mirrors lockedProviders); declareSessionAccount/sessionAccountOf/sessionHasBinding/dockSessionId/nextLaunchAccountView; claudeAccountView now returns the SERVER fact for the dock session (launch else binding) and only falls back to the launch-intention chain for a not-yet-started session — and the explicit-null bug is fixed (null = default, not the project account); fed from session-init.account (both producers), effective-config, and openSession's transcript-tail boundAccount (pre-seeded synchronously from the sidebar row to avoid a flash); pickAccount routes a bound-but-not-live pick through the HTTP rebind (rebindAccountOffline), never a droppable override; paintAccountSel/paintAcctPop render current-vs-pending from the server fact (the "Project default" row and the chip wording no longer mislabel the session account as the inherited default); finishAccountSwitch updates only the named session and treats a lost ack as OUTCOME UNKNOWN (not "still on old").
  - public/lib/api.js — rebindSessionAccount(sid, body) for the HTTP route (a re-opened session has no ws on the client — the real transport gap the review flagged).
  - scripts/verify-bug-255.mjs + scripts/verify-bug-255-ui.mjs + package.json (verify:bug-255, verify:bug-255-ui).
  - scripts/verify-feat-160.mjs — updated 4 source-pattern assertions to track the refactor (see regression note below). NOT a contract change.

  VERIFIED (fixer's own runs):
  - npm run verify:bug-255 — 21/21 PASS. Real scratch server + real ws + a scripted fake CLI + real account overlays: (A) session-init declares `account`; the sessions-list AND transcript routes declare `boundAccount` after a switch; an unbound session carries NO boundAccount key. (B) a LIVE switch A->B relaunches the CLI under B — CLAUDE_CONFIG_DIR read from /proc/<child pid>/environ (only that var). (D) an OFFLINE rebind of a PROVEN-STOPPED bound session over the HTTP route (the reported-bug path) moves the durable binding and the resume launches under the pick (/proc). (C) an offline rebind is REFUSED (ws AND HTTP) when the session is live via a bridge; binding unchanged (review #4). (E) persist-before-publish; CLIENT display must-FAIL twin — the FIXED claudeAccountView returns the bound account A despite a stale override B, the synthesized PRE-FIX one returns the override B (the bug); a synthesized pre-fix handler refuses any no-live-session switch (no offline rebind).
  - npm run verify:bug-255-ui — 5/5 PASS in a REAL headless browser (brave) over a busy-state fixture: (a) a bound session whose tab also carries a stale override shows the BOUND account "plan B" in the indicator; the synthesized PRE-FIX app.js (claudeAccountView reverted) shows the stale override "plan A" — must-FAIL confirmed in the DOM the user sees. (d) a real click on the "plan A" popover row rebinds the session (server session-accounts.json moves to A) and the indicator updates to "plan A". Screenshots: docs/bugs/assets/BUG-255-display-bound.png (chip reads plan B despite override), BUG-255-display-prefix.png (pre-fix shows plan A), BUG-255-after-rebind.png (chip plan A + "Claude account switched to plan A — this session resumes on it on your next message"). Visually reviewed in both — clean, consistent.
  - Anti-regression: verify:feat-160 46/0, verify:feat-145-session-override 34/0, verify:feat-145-session-wiring 21/0. npm run gate PASS (exit 0) — leak-gate + check-nul + prompt-privacy + typecheck.

  REGRESSION NOTE (honesty): before my edits the working tree already carried unrelated uncommitted changes (BUG-253 new-session branch + attachments in handOver), which had ALREADY pushed handOver past verify-feat-160.mjs's 4000-char source-window — so its "outbox resume spawns via startSession" assertion was failing independent of BUG-255. My refactor additionally broke three source-pattern assertions (the extended switch-account ClientCommand type, the switchAccountLive signature, and a 1400-char slice that my new comment pushed `account, inherit }` past). I updated all four matchers to track the current code; the FEAT-160 CONTRACT is unchanged and its behavioural checks (validate-before-reap, binding-before-reap, lifetime gate, inherit->M via /proc, deleted-account drop) all still pass (46/0). regressed-from: none (BUG-255 introduced no behaviour regression; #3 was pre-existing from in-tree BUG-253 work).

  HIGH-STAKES — INDEPENDENT VERIFY WARRANTED (do NOT self-verify to VERIFIED): this is session-lifecycle + concurrency + account-billing + regression-prone. Generation is not its own verifier.

  RESIDUALS the verifier should press / that a follow-up may want (flagged, not silently dropped):
  - Cross-tab live invalidation: a second tab's view is not pushed a fresh declaration when another tab rebinds; it refreshes on its next openSession/transcript read. No SSE invalidation was added.
  - Lost-ack reconciliation is softened to "outcome unknown" wording only; there is no active re-query of the binding after a timeout.
  - A stopped, UNBOUND historical session (never switched) still shows the launch-intention chain (there is no server-owned per-launch account record for a never-switched session; the review noted SessionConfigRecord is write-once and carries no account). The misrepresentation the user hit (binding present, override differs) is fully fixed; the no-server-fact case is best-effort "as it would resume".
  - Fork policy (the constructor reads the PARENT's binding): not specifically exercised here.
  - switchAccountLive retains an unused `target` param (the client offline path now uses the HTTP route); harmless, the ws offline branch is still server-tested.

  Symptom of a deeper design flaw? Partly — this is the SAME ARCH-010 shape as FEAT-160/FEAT-145: a fact the server owns (the account a session runs on) was being re-derived by a reader (the client indicator). The fix declares it once and reads it; no new ARCH ticket filed (ARCH-010 already governs this class and the remedy applied is exactly its prescription).

### 2026-10-13 — worker (verifying r1)
- **independent verify BLOCKED — working tree too entangled to scope a BUG-255 diff:** Commissioning the clean-room verify was blocked before dispatch: a decorrelated, non-truncated BUG-255-only diff cannot be produced from the current working tree.

  FINDINGS (read-only; no git/candidate writes made):
  - OpenAI dispatch available (host broker socket). Not used — no verifiable input could be assembled.
  - No frozen candidate exists for BUG-255 (fixer did not freeze at handoff; candidate status: no-open-candidate).
  - candidate freeze --id BUG-255 (BUG-255 surface + 3 untracked-new transitive deps) was REFUSED (owned): events.ts, agent-bridge.ts, index.ts, public/app.js, public/lib/api.js, package.json, grant-rebuild.ts, agent-git-policy.mjs are co-owned by open candidates FEAT-175, FEAT-164, BUG-239, BUG-240+FEAT-170. The BUG-255 fix was built on top of five other tickets' uncommitted work blended into the SAME files.
  - candidate ready: 0 READY / 8 NOT READY — every open candidate is STALE-BASE and/or CHANGED vs HEAD. Nothing is committable, so prerequisites cannot simply be landed first without re-freeze+re-verify of each.
  - --working-tree is the only mechanically-available mode, but the dirty tracked diff vs HEAD is 803,379 bytes across 64 files (all tickets blended). Default --max-diff-bytes is 60000, so --working-tree would SILENTLY TRUNCATE and hide most of BUG-255's own changes; raising the cap hands the verifier ~800KB of five unrelated tickets, defeating decorrelation and risking MAX_ARG_STRLEN.
  - Runnability note: BUG-255 files hard-import untracked-new companions (agent-bridge.ts->attachments.ts; index.ts->grant-rebuild.ts + scripts/lib/agent-git-policy.mjs), so a clean-HEAD overlay of only the BUG-255 list would fail to boot (false BROKEN) even absent the ownership conflict.

  NEEDS ORCHESTRATOR DECISION (verify not run; no verdict recorded): either (1) untangle the tree so a BUG-255-only candidate can be frozen on a clean base (dedicated worktree applying only BUG-255's logical change, or land+re-freeze the prerequisite tickets), then re-dispatch verify with --candidate; or (2) accept a weaker whole-tree verify (--working-tree --max-diff-bytes ~1_000_000, verifier pointed at the BUG-255 surface) acknowledging decorrelation is lost; or (3) verify BUG-255 as a dependency GROUP (candidate freeze --depends-on FEAT-175 FEAT-164 BUG-239 BUG-240 FEAT-170) as one commit group. Recommend (1). Fixer's self-reported runs stand unverified: verify:bug-255 21/21, verify:bug-255-ui 5/5, gate PASS.

### 2026-10-13 — verify lane (mixed-state)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run dde6ccb1-cb28-4569-a9f9-1a7b425295de — VERDICT: HOLDS — mixed-state candidate 6e95ad19a709 — Mixed-state verify (58 FEAT-164/175 hunks disclosed). Same-provider fallback: OpenAI quota hit mid-run. Fixer suite 21/21 + 2 adversarial HOLD. NOT run: verify:bug-255-ui (no browser), container refusal (no Docker).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/opus[1m] run 72d66ca2-a3a9-410a-9dd8-9fd3992cffa8 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (verifying r1 — untangled candidate + independent verify, BROKEN)
- **UNTANGLED a BUG-255-only candidate and independently verified it; VERDICT BROKEN (two-break → design review):** The prior verify lane was blocked because BUG-255's files carried 5 other tickets' uncommitted work (803KB blend). Per the orchestrator's untangle decision, I built a decorrelated BUG-255-only candidate and independently verified it in a real clean room with a real browser.

  UNTANGLE METHOD (no real-repo git writes; throwaway /tmp fixture only):
  - No lane snapshot was registered under ticket BUG-255 (its `ticket` field was []), but the FEAT-176 snapshot store held the fix lane's capture (laneId a7df8e43296737e99, snap 20261013T170724Z-a7df8e43296737e99) naming exactly the 10 BUG-255 files, and the lane's transcript (…/subagents/agent-a7df8e43296737e99.jsonl) held all 62 Write/Edit ops.
  - Built a scratch tree from `git archive HEAD` (HEAD 1a68e57) and replayed BUG-255's 62 ops onto it. 61/62 applied clean on HEAD. 1 was a benign errored-retry attempt (tool_result is_error) superseded by a later successful edit. The ONE genuine non-apply: events.ts `session-init` type line — a sibling in-tree ticket had added `encodedDir?: string` to that same union member; BUG-255 adds `account?: string | null`. Purely cosmetic textual overlap on one line, NOT a logical dependency: nothing in BUG-255's applied code reads `encodedDir` off the session-init event (the offline-target encodedDir comes from the sidebar row / state.current). Reconciled by applying BUG-255's `account?` field to HEAD's actual line (without the sibling's encodedDir). Result: a clean, decorrelated HEAD + BUG-255-only candidate.
  - HYPOTHESIS CONFIRMED: BUG-255's hunks do not depend on the other open tickets' uncommitted changes (one cosmetic reconciliation aside). On HEAD + BUG-255 only: `verify:bug-255` 21/21, `verify:feat-160` 46/0, `verify:bug-255-ui` 5/5 — all GREEN. So this is an UNTANGLED candidate, not a dependency-group verify.
  - Candidate handed to independent-verify as a two-commit /tmp fixture repo (baseline = pristine HEAD, HEAD = BUG-255), diff 91,407 bytes across the 10 files, `--range HEAD~1..HEAD`. Created with the real git binary on a throwaway /tmp fixture (the sanctioned "scratch git is fine" case); the real repo was never touched, nothing staged, nothing pushed.

  INDEPENDENT VERIFY (clean room, cross-provider UNAVAILABLE — OpenAI 5h quota 100% spent; ran same-provider Claude Opus per coordinator, decorrelation reduced but structural independence (separate process, fresh context, board/methodology stripped, no fixer report) preserved): dispatch anthropic/opus[1m], run 72d66ca2-a3a9-410a-9dd8-9fd3992cffa8. VERDICT: BROKEN, contract VALID (manifest-backed, executed evidence). The verifier re-ran the fixer suite (21/21) then built its own two-tab and lost-ack UI harnesses and broke the stated requirement twice:
  - BREAK 1 — cross-tab stale indicator (HIGH): tab 1 rebinds a stopped session B→A; tab 2, checked 10s later, still shows "plan B" while the server binding (and next resume) is A. No server invalidation; the client only declares `boundAccount` on `openSession`, never re-queries. Property (a) indicator-truth, path 1.
  - BREAK 2 — lost-ack read as refusal (HIGH): the rebind POST commits server-side but the HTTP response is lost (connection reset); `rebindAccountOffline` treats the fetch error as a refusal and reports failure, leaving the indicator on "plan B" while the binding is A, with no re-query. Contradicts the "outcome unknown" handling the diff added only for the ws-timeout path. Property (a), path 2.
  - TWO-BREAK FLAG FIRED (verbatim): the indicator-truth property broke via two separate paths, so per the STOP clause the verifier reported both and declared "two-break: route to independent design review." Root cause named: the client caches the server's account fact with nothing to invalidate or re-query it.
  - Both breaks are EXACTLY the residuals the fixer flagged at handoff (cross-tab live invalidation; lost-ack softened to "outcome unknown" wording with no active re-query) — now confirmed as real violations of the "must ALWAYS show truth" requirement, not acceptable best-effort gaps.
  - PASSED (robust): (A) server declares account/boundAccount; (B) live switch relaunches under B (/proc CLAUDE_CONFIG_DIR); (D) offline rebind of a proven-stopped bound session + resume under the pick; (C) offline rebind refused when live via a bridge; (E) persist-before-publish + the display must-FAIL twins. So the ORIGINALLY REPORTED bug (bound-not-live session showing a dropped override) IS fixed; the broader "indicator always truthful" requirement is not.
  - UNTESTED by the verifier (its could-not-test queue, a follow-up work list): resume-from-stale-tab /proc check; switch-during-streaming-turn and two-rapid-picks races; container refusal end-to-end (no container runtime fixture); fork binding; second tab on the same live bridge.
  - NOTE vs the earlier mixed-state HOLDS (run dde6ccb1): that verify was text-only (no browser, no container) and so never exercised the UI two-tab/lost-ack paths. The decorrelated candidate + real browser here is what surfaced the breaks.

  ARTIFACTS: candidate fixture /tmp/bug255-candidate-RhPehn (HEAD 355355f; baseline 80cf619); IV log /tmp/bug255-iv.out; verdict /tmp/bug255-verdict.json; clean-room record <station-scratch-dir>/cleanroom-record-mZJVcC. NEXT: BROKEN → back to fixing; the two-break flag routes the indicator-truth design (server-pushed invalidation + lost-ack re-query) to independent design review rather than another point guard.

### 2026-10-13 — worker (fixing r2 — two-break design review)
- **DECISION: REDESIGN the display/state flow (server-pushed versioned account fact); invariant + design recorded:** INDEPENDENT DESIGN REVIEW (WA §N two-break) — DECISION: REDESIGN the display/state flow; KEEP the server switching operation (it verified robust: live reap+relaunch, proven-stopped offline rebind, bridge refusal, persist-before-publish all HELD).

  HYPOTHESIS CHECK (against public/app.js + src/server/index.ts as they stand after r1): CONFIRMED, with one refinement. The client keeps its own copy of the account fact in `sessionAccounts` and it has exactly two writers: (1) pull-once reads at open time (sidebar row `boundAccount`, transcript-tail `boundAccount`, session-init/effective-config on the driving socket) and (2) the RESPONSE to this tab's own switch request (`finishAccountSwitch` -> `declareSessionAccount(sid,{bound: resolved})`). It is not "optimistic" in the strict sense (the ack value is the server's), but it is RESPONSE-SOURCED: nothing the server does outside this tab's own request/open can ever reach the copy (no invalidation channel exists for the account), and an ABSENT response is collapsed into the refusal branch (`rebindAccountOffline` catch -> `finishAccountSwitch(ok=false)`). Break 1 (second tab stale) = no push; Break 2 (lost ack read as refusal) = a response is treated as the source of truth, so its absence becomes a false fact. Same root, two paths. A third path of the same root exists and was not yet tested: a tab VIEWING (not driving) a session another tab live-switches — its launch/binding change is likewise never delivered.

  WHY THE OTHERS LOSE
  - Rescope: the user named this exact property ("the UI should never misrepresent current state"). Not available.
  - Keep-patching: the two natural patches (a cross-tab poll; a re-query in the lost-ack catch) are two more point guards on a cache that still has response-sourced writers, an unversioned merge (a late list/tail read can overwrite a newer switch), and no notion of "switch in progress". Each further path (third tab, pump-driven resume changing the launch, a server restart, a live switch whose close fails) would need its own guard. That is the pattern the two-break rule exists to stop.
  - Redesign wins: one owner (server) declares one versioned fact; one delivery channel (broadcast to every connected socket + a GET re-read); one client rule (render only the newest fact; a response never mutates the display). Every path above reduces to "did the newest fact arrive", which the re-read-on-reconnect and re-read-on-unknown rules close.

  INVARIANT (one testable sentence)
  The account indicator for a session renders ONLY the newest server-declared account fact for that session (delivered by push to every open tab and re-read on reconnect or on any unresolved request), so it never shows an account the session is not on; a switch request's response, or its absence, never changes what the indicator shows — a lost or late ack shows "switch status unknown — checking" and resolves from the re-read fact, never as a refusal.

  DESIGN
  Server (owner):
  - `accountFactOf(sid)` -> `{ sessionId, boot, rev, launch?, bound?, switching, last }`:
    - `launch` present iff a live bridge holds the session (`bridgeForSession(sid).effective.claudeAccount`, null = implicit default); anthropic only.
    - `bound` present iff a durable FEAT-160 binding exists (`getSessionAccount`).
    - `switching`: `{ requestId, target }` while a live switch is between validation and its close (null otherwise).
    - `last`: `{ requestId, outcome: 'switched'|'refused', account, reason, at }` — the most recent switch outcome for this session (in-memory; lost on restart, which the client treats as "no record").
    - `boot` = per-process random id; `rev` = process-global monotonic counter bumped on every publish.
  - `publishAccountFact(sid)` bumps rev and BROADCASTS `{t:'session-account', ...fact}` to every connected ws client (every tab's page-lifetime watch socket and every driving socket). Called on EVERY change: binding committed (session-accounts `onBindingChange` observer — covers both setSessionAccount sites), live-switch start/settle (switching/last), offline-rebind settle incl. refusals (last), bridge launch (session-init) and bridge close (agent-bridge notifier).
  - `GET /api/sessions/:sid/account` returns the current fact (same shape, current rev, no bump). transcript-tail carries `accountFact` too (boundAccount kept for compatibility).
  - Offline POST /api/sessions/:sid/account and the ws switch-account both accept a client `requestId`, recorded in `last` so a client whose ack was lost can learn its own request's outcome.
  Client (renders only):
  - `sessionAccounts` becomes `sid -> fact`; the ONLY writer is `acceptAccountFact(fact)` which applies a fact iff (boot differs) or (rev >= stored rev). Fed by: the `session-account` push (both sockets), the GET re-read, and the transcript-tail `accountFact`. Removed writers: the sidebar-row pre-seed, transcript `boundAccount`, session-init.account, effective-config, and finishAccountSwitch (an ack never writes the store).
  - Display: current = launch if present, else bound; if `switching` -> label marked "switching…"; if launch present and bound differs -> pending marked (next message resumes on bound); a dock session with NO fact received yet shows "checking…", not the override chain; a received fact with neither launch nor bound (stopped, never-switched session) keeps the FEAT-145 next-launch chain (no competing server fact).
  - Acks: a server ok/refusal (ack frame, or HTTP JSON {ok:false,error}) produces only a status message, then triggers a GET re-read. The live-switch flow side effects (resumeOnNextSend) still run on a confirmed switch.
  - Lost/late ack (ws 8s timeout, fetch network error, non-JSON, HTTP timeout): status "switch status unknown — checking", chip marked unknown, then re-read the fact (retry with backoff, ~30s): `last.requestId === mine` -> report that outcome (and run the live-switch side effects if it switched); `switching.requestId === mine` -> keep checking; neither -> "the server has no record of that switch; showing the account the session is on". Never reported as a refusal.
  - Watch socket (re)open -> re-read the dock session's fact (covers pushes missed while disconnected and a server restart's new boot).
  - Pick routing: a dock session with a server fact carrying launch or bound and not live on this socket -> the server offline operation (refuses visibly if running elsewhere); live on this socket -> live switch; no fact owner (stopped, unbound) -> FEAT-145 override, unchanged.

  PROOF BAR (this round): real headless browser on an isolated scratch server, must-FAIL by serving the r1 client (the synthesized pre-fix for THIS round; saved before edits) against the same server:
  - T1 two tabs: tab 1 rebinds a stopped bound session B->A; tab 2 (open on the same session, no user action) shows "plan A" within 3s. r1 client: tab 2 stays "plan B" (FAIL).
  - T2 lost ack: the POST reaches the server and commits, the browser's response is aborted (route.fetch + route.abort). Indicator shows "plan A" (truth) and the message is "unknown — checking" then "switched", never a refusal. r1 client: reports failure, indicator "plan B" (FAIL).
  - T3 delayed ack (response held 6s): the indicator updates from the push before the ack lands.
  - T4 a real refusal (session live via a non-browser bridge) is still shown as a refusal with the reason, indicator unchanged on the running account.
  - T5 viewing tab sees a live switch made by another client (launch A -> switch to B): the indicator moves to B.
  Anti-regressions: verify:bug-255, verify:bug-255-ui, verify:feat-160.
  Not in scope (stated, not hidden): restart-survivor launch account (no server record of a survivor's launch account; it shows the binding), container end-to-end, fork binding.

### 2026-10-13 — worker (fixing r2 — build)
- **r2 redesign built: server-pushed versioned account fact; truth-ui 17/0 incl. must-FAIL vs r1 client; gate PASS; independent verify required:** Built the r2 REDESIGN (server-pushed, versioned account fact; the client renders only that). Plan review: OpenAI attempted first (thread 01a136f6-b719-74c3-91a5-4d0c7697bc5b) and hit its quota window, so it was reviewed by a separate Claude Opus 4.8 dispatch (anthropic run e0f42c14-34c3-4934-97fc-29343107fa1e). VERDICT: PLAN SOUND WITH CHANGES. It agreed with the root cause and the invariant. Three changes, all folded in: #3 a live switch whose close() fails (binding committed, old CLI still running) now records a distinct `deferred` outcome, not `refused`, so a tab resolving a lost ack says "recorded for the next resume", not "declined"; #4 a rev-ordering test (GET never bumps rev; the client writer drops a late older fact and accepts a new boot); #5a an ack held PAST the unknown timer with the push dropped. #5b (close-fail end-to-end) was NOT built. There is no seam to make close() throw in a real server, so it is listed as untested below.

  regressed-from: BUG-255 r1 (the same ticket's prior round: a response-sourced client cache with no invalidation).

  CHANGED FILES (unstaged; the orchestrator does git)
  - src/server/session-accounts.ts: `onBindingChange(cb)` observers fire after a COMMITTED setSessionAccount (after persist + cache publish).
  - src/server/agent-bridge.ts: `setAccountLaunchNotifier` hook, fired on register (resume/adopt), on session-init and on close(). `launchAccountKnown=false` for an ADOPTED restart survivor, so its re-derived account is never declared as fact.
  - src/server/index.ts: the fact owner: `accountFactOf` / `publishAccountFact` (broadcast to every ws via `accountFactSockets`) / `settleAccountSwitch` (in-memory `switching` + `last` keyed by the client's requestId), with boot+rev ordering. New `GET /api/sessions/:sid/account`. The transcript routes carry `accountFact`. offlineRebindAccount is now a wrapper that records every outcome, and its body moved into offlineRebindAccountInner. Live switch: publishes `switching`, records refusals/switched/deferred, and clears a stale `switching` in finally. The POST route and the ws offline branch pass requestId.
  - public/app.js: `sessionAccounts` now holds facts; its ONLY writer is `acceptAccountFact` (rev/boot-gated). Removed writers: the sidebar-row seed, transcript boundAccount, session-init.account, effective-config, finishAccountSwitch. `session-account` is handled on the driving socket and on the watch socket. The fact is re-read on open, on watch (re)open, on session-init and after every settle. Lost/late ack -> `accountOutcomeUnknown` ("switch status unknown — checking with the server…") -> a backoff re-read for 30s, resolved from `last.requestId`, never a refusal. An HTTP refusal counts as a refusal only with a server JSON {ok:false,error} body. The chip shows "checking…" until the first fact arrives, a "→ X" pending marker (switching, or binding≠launch), "· switching…" while this tab's own request is out, and "· status unknown, checking". A pick on a dock session whose fact is not yet known is refused with "still checking". The popover note now covers a session running elsewhere.
  - public/lib/api.js (getSessionAccountFact); public/styles.css (suffix styling).
  - scripts/verify-bug-255-truth-ui.mjs (NEW), package.json (verify:bug-255-truth-ui), scripts/test-manifest.json (regenerated; the diff is only the new entry).
  - scripts/verify-bug-255.mjs: ONE source-pattern matcher now points at offlineRebindAccountInner (the classify-before-commit body moved there). It is a refactor-tracking change; the contract is unchanged.
  - docs/bugs/assets/BUG-255-r2-{tab2-follows,lost-ack-T2,lost-ack-T2b,chip-requesting}.png

  DEMO (real headless Brave, isolated scratch server + fake CLI + stub creds, busy state of several bound sessions): `npm run verify:bug-255-truth-ui` -> ALL PASS 17/0.
  - r2 client: R ordering 3/3. T1: tab 2 follows tab 1's switch (lag about 1ms). T2: lost ack (POST committed, response reset) -> "plan A" + "switched", no refusal. T2b: lost ack AND pushes dropped (2 frames dropped via routeWebSocket) -> "unknown — checking" then "switched". T3: ack held 6s -> chip "plan A" 165ms after click, from the push. T3b: ack held 13s + push dropped -> "· switching…" (screenshot), unknown at 10s, settled by the re-read, and the late ack changes nothing. T4: an unready account is still refused with its reason, chip unchanged. T5: a viewing tab follows a live switch made by another client (resume under B -> live switch to A).
  - MUST-FAIL: the same tests with the r1 client (saved before the edits, /tmp/bug255r2-pre/app.js, served in place of app.js on the same server). r1 BROKE T1, T2, T2b, T3, T3b and T5, which reproduces both verifier breaks plus the viewing-tab path. T4 held on r1 (the control).
  ANTI-REGRESSIONS: verify:bug-255 21/0, verify:bug-255-ui 5/0, verify:feat-160 46/0, verify:feat-145-session-override 34/0, verify:feat-145-session-wiring 21/0. npm run gate PASS (exit 0).

  UNTESTED / RESIDUAL (a work queue for the verifier)
  - The close-fail `deferred` path end-to-end (no seam to make close() throw).
  - Restart-survivor launch account. It is deliberately not declared (launchAccountKnown=false), so the chip shows the binding or falls back to the FEAT-145 chain.
  - A server restart (new boot) seen in the browser. Only the writer is unit-tested; the watch-reopen re-read is exercised only implicitly.
  - Two rapid picks / a pick during streaming, container end-to-end, fork binding.
  - The visuals of the pending "→ X" marker and the "checking…" state in a busy UI were not reviewed. Only the "· switching…" chip was screenshotted.
  - A stopped, never-switched session still shows the FEAT-145 next-launch chain (unchanged from r1, by design).

  HIGH-STAKES (session-lifecycle + account billing + regression-prone): an independent clean-room verify is REQUIRED. This lane did not self-verify.

### 2026-10-13 — verify lane r2 (Claude fallback; OpenAI quota)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 0c6b3435-79e9-439c-ab69-dda0eb578854 — VERDICT: BROKEN — Independent clean-room verify, untangled HEAD+BUG-255(r1+r2) working-tree candidate (tree 0588731fc9a9). Floor 21/21. BROKEN: (a) indicator-truth TWO-BREAK (restart old-boot stale fact; container empty-fact->stale override) -> design review; (c) failed-stop orphans old CLI. Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (verifying r2 — untangled candidate + independent verify, BROKEN)
- **independent re-verify of r2: BROKEN (two-break):** INDEPENDENT CLEAN-ROOM RE-VERIFY of the r2 redesign on an UNTANGLED BUG-255-only candidate — VERDICT BROKEN (two-break → independent design review).

  UNTANGLE (no real-repo git writes; FEAT-108/FEAT-135 now block ALL scratch-git commands too, so the r1 commit-a-fixture method was unavailable). Reused the r1 decorrelated candidate /tmp/bug255-candidate-RhPehn (commit 355355f = pristine HEAD 1a68e57 + BUG-255 r1 only) and applied the r2 deltas onto it. r2's source edits were SHELL-driven (not replayable Edit ops), so I derived each delta as diff(/tmp/bug255r2-pre/<file> , live worktree) — the pre-r2 snapshots the r2 build left behind — and applied via patch(1) (non-git). agent-bridge/api/app/session-accounts applied clean; index.ts hunk#1 rejected (its context was FEAT-175 import lines absent from the decorrelated tree) and was reconciled by inserting the 3 BUG-255 r2 import lines next to the FEAT-160 import (one cosmetic reconciliation, same class as r1's events.ts). styles.css: only the 4-line BUG-255 acct-st hunk inserted (its file also carries FEAT-177). verify-bug-255.mjs + verify-bug-255-truth-ui.mjs copied from the worktree (BUG-255-only); package.json got the one truth-ui script entry.
  Every r2 delta was BUG-255-annotated and purely additive — no foreign-ticket symbols leaked.

  CANDIDATE VALIDATION (build-faithfulness, not verification): typecheck clean; verify:bug-255 21/0; verify:feat-160 46/0; verify:bug-255-truth-ui 17/0 in a REAL headless browser incl. the must-FAIL-vs-r1-client grading — matches the fixer's self-reported numbers, so the untangle is faithful. Handed to independent-verify as --working-tree over the fixture with .git/HEAD pointed at the baseline commit (scratch-file write, real repo untouched) so the verifier saw the FULL 147,555-byte BUG-255-only diff (12/12 paths), .claude+docs stripped, no fixer report.

  PROVIDER: OpenAI first (dispatch 01a1371a-d264-7c90-a576-3b09ad6d87c6) — it re-ran the suites and built its own lifecycle/container/truth-ui harnesses, then hit its 5h quota window mid-run → dispatch INVALID (fail-closed), no verdict. Did NOT park: re-dispatched a separate Claude Opus process (run 0c6b3435-79e9-439c-ab69-dda0eb578854). Cross-provider decorrelation reduced (build was Claude), but structural independence preserved (separate process, fresh context, board/methodology stripped, no fixer report). Clean rooms kept: cleanroom-verify-ah3OM5 (openai), cleanroom-verify-jcx9Z8 (claude).

  VERDICT: BROKEN, contract VALID (manifest-backed, executed evidence). Floor re-established: fixer suite 21/21.
  - BREAK (a) INDICATOR TRUTH — TWO-BREAK (medium), route to independent design review. Path 1 restart-stale-old-boot-fact: acceptAccountFact (public/app.js) accepts any fact whose boot id differs with NO cross-boot ordering; an old-server GET answered pre-restart and delivered after the restart overwrote the chip to "plan A" and it stuck 12s+ while the server declared B. Path 2 container-stale-override-display: a container session with an EMPTY server fact falls back to nextLaunchAccountView, which reads a stale per-session localStorage override — chip shows "plan A — fixed for this project" while the project account is B, and stays wrong after the refused click. Same property, two distinct roots (old-boot facts accepted unconditionally; empty-fact fallback to the client's own account choice).
  - BREAK (c) FAILED STOP (medium) stop-fails-during-live-switch: the switch-account handler (src/server/index.ts) sets session=null BEFORE live.close(); when close() fails the old CLI on A is orphaned and the promised "next resume runs on the new account" never happens — every resume is refused with a false "being driven in another tab" and the old CLI stays alive on A.
  - (low) viewing-tab tooltip says "It is not running now" while the server declares a running launch on A.
  - (low) rapid-successive-picks: a refused concurrent HTTP pick calls settleAccountSwitch, erasing the running switch's in-progress marker and overwriting last outcome mid-switch; final binding and the resume on B (/proc) were still correct.

  PASSED (robust): server declares session-init.account + boundAccount (list/transcript, undefined≠null for unbound); live switch A→B relaunches the CLI under B (/proc CLAUDE_CONFIG_DIR) and resumes same conversation; offline rebind of a proven-stopped bound session + resume under the pick (/proc); offline rebind refused ws AND HTTP when live via a bridge (binding unchanged); persist-before-publish; the display must-FAIL twins (FIXED claudeAccountView shows bound A despite stale override B; pre-fix shows B).

  UNTESTED (could-not-test queue): an ADOPTED restart survivor (CLAUDE_STATION_SURVIVE=1) — its fact carries no launch account so the indicator may fall back to the client's own choice, but the survival broker could not be driven with the stub CLI.

  Both break-(a) paths and the (c) path are EXACTLY the residuals r1/r2 flagged as untested/out-of-scope (cross-boot/restart fact ordering; container end-to-end; close-fail deferred) — now confirmed as real violations of "must ALWAYS show truth". NEXT: BROKEN → fixing; the two-break on indicator-truth routes the fact-ordering + empty-fact-fallback design to independent design review, not another point guard. ARTIFACTS: candidate /tmp/bug255-r2cand-NXW5tP; IV logs /tmp/bug255-r2-iv.out (openai, INVALID) + /tmp/bug255-r2-iv-anthropic.out; verdict /tmp/bug255-r2-verdict-anthropic.json. HIGH-STAKES session-lifecycle/billing: this verdict is itself an independent pass; a further fix round is warranted.

### 2026-10-13 — orchestrator
- **ADJUDICATION — keep r2 redesign; final fix round:** ADJUDICATION (orchestrator, non-author, 2026-10-14) for the second two-break on indicator truth: KEEP the r2 redesign. Its chokepoint (server-pushed fact, client renders only it) is right. Both new breaks are places where the client still has a second source:
  (1) Fact ordering must be total across boots: the version is (bootId, seq), and a fact from a different boot replaces the held one, never loses to it.
  (2) The client has NO fallback source. An empty or absent server fact renders "account unknown — checking" and re-reads the server. A client override is never displayed as current.
  Rejected: RESCOPE (the user named this exact property) and a new redesign (the chokepoint holds; these are leaks in it, not a wrong design). This is the FINAL fix round. One verify follows, and a further indicator-truth break goes to the user.

### 2026-10-13 — worker (fixing r3 — final round)
- **r3 built: total boot order, no client fallback (server next), failed stop = failed switch; demo 18/0 incl. must-FAIL; gate PASS:** FINAL FIX ROUND (r3) built per the adjudication above: (1) total fact ordering across boots, (2) no client fallback source, (c) a failed stop is a failed switch with no orphaned CLI, plus the two low items. regressed-from: BUG-255 r2 (the same ticket's previous round: an unordered random boot id, a client fallback for an empty fact, and a "deferred" outcome for a failed stop).

  RULE (1), TOTAL ORDER. The fact version is (boot, rev). `boot` is a number that goes up on every server start. It is persisted in <data>/account-fact-boot.json as max(previous + 1, Date.now()). acceptAccountFact keeps the highest boot it has heard from. A fact from a newer boot replaces the held one at any rev. A fact from an older boot never wins. Held facts from an older boot are no longer "current" and render as unknown until they are re-read. INTERPRETATION, stated: the adjudication says "a fact from a different boot replaces the held one". Read literally, that re-opens the A1 break: the stale fact IS from a different, older boot. So "different" is implemented as NEWER, which is what "ordering must be total" requires.

  RULE (2), NO FALLBACK. The server fact now carries `next`: the account a resume launches under, from server state only (the binding, else the session's project account under the machine default). Every session the server can place therefore has a fact naming its account, including a stopped never-switched session and every container session. To place a session the server uses the bridge's project, a list/transcript/GET placement hint, or the store dir. Client deletions:
  - claudeAccountView returns ONLY the fact for a dock session (launch, else bound, else next). If the fact is absent or names nothing, the chip shows "account unknown — checking" and re-reads with backoff (chaseUnknownAccount).
  - The nextLaunchAccountView fallback for sessions is gone. It is now read only when the dock holds no session (a next launch), and never for a container project.
  - restoreOverrides no re-arms a stored per-session account, and it heals storage.
  - A resume or outbox enqueue never carries claudeAccount (a fork still does).
  - pickAccount sends every pick on a session through the server. A live pick is a live switch. Any other pick is an offline rebind, bound or not. No account override is ever armed for a session.
  - The popover marks no row current while the account is unknown.

  (c) FAILED STOP. The live switch saves the previous binding before it commits. If close() throws, the binding is restored. restoreSessionAccount in session-accounts.ts persists first, then publishes, and also handles the "was unbound" case. The outcome is 'failed', the ack is ok:false, and the message says "the switch did NOT happen". DECISION on the old process, by what close() left behind:
  - Bridge intact (!closed): it KEEPS SERVING the session on the old account. If the switching socket is still open it drives the session again. If not, it is released the way that socket's close would have released it. Why: it is a working session, and reaping it would need the stop that just failed, or a hard kill that could cut off work.
  - Teardown begun (closed): nothing can serve it, so the leftover CLI is REAPED (new AgentSession.reapAfterFailedClose: runtime EOF plus the broker reap). The ack carries stopped:true so the tab resumes it on its next message. Why: a process no bridge can answer is exactly an orphan.
  LOW: settleAccountSwitch now clears `switching` only for the request that owns it, and outcomes are kept in `recent` (the last 6), so the client resolves its own request from there. The viewing-tab tooltip now says "running in another window or in the background" when the fact has a launch that is not this tab's.

  FILES (unstaged): src/server/index.ts, src/server/session-accounts.ts, src/server/agent-bridge.ts, public/app.js, public/lib/api.js, scripts/verify-bug-255-r3-ui.mjs (NEW), scripts/fixtures/bug-255/entry-stopfail.mjs (NEW; a scratch-only fault-injection entry, no product seam), package.json (verify:bug-255-r3-ui), scripts/test-manifest.json (regenerated; the only diff is the new entry), docs/bugs/assets/BUG-255-r3-*.png. Refactor-tracking test edits, contracts unchanged:
  - verify-bug-255-truth-ui R: numeric boots, plus an added old-boot-late check.
  - truth-ui and verify-bug-255-ui wait past the "checking" wording.
  - verify-bug-255-ui's synthesized pre-fix also reverts the restore strip, so it can still show the stale override.

  DEMO, `npm run verify:bug-255-r3-ui`: ALL PASS, 18/0. Real headless Brave, isolated scratch servers on free ports, fake CLI, stub credentials, busy state. MUST-FAIL used a SYNTHESIZED PRE-FIX tree (/tmp/bug255r3-preroot = this working tree with the 6 r3-touched source files restored from the pre-edit snapshot /tmp/bug255r3-pre). It ran all 5 cases to completion, and every case BROKE there. A crash is not graded as a break.
  - A1 restart (server SIGKILLed and restarted with the tab open, an old-boot GET held and released after a new-boot push). Fixed: the chip stays "plan B". Pre-fix: it reverted to "plan A" and stuck past 12s.
  - A2 container project (registration only, no docker), unbound session, stale override A, project account B. Fixed: "plan B", and still "plan B" after a refused pick. Pre-fix: "plan A".
  - A2b, a fact naming no account (the server's responses were stripped for 5s). Fixed: "account unknown — checking", then "plan B", and the UI resume ran on B (/proc). Pre-fix: showed the override "plan A". HONEST NOTE: r2's resume also ran on A (r2 honoured the override), so the pre-fix break here is the rule-(2) breach, not a billing mismatch.
  - C1, stop injected to fail before teardown. Fixed: reported failed; binding unchanged; both tabs show "plan A" with nothing pending; the same tab's next message is served by the old CLI on A (no new launch); the CLI is released when the tab closes; a fresh resume runs on A (/proc). Pre-fix: "plan A → plan B", binding B, "no session on this socket", the CLI orphaned, and the fresh resume refused as "driven in another tab".
  - C2, stop failing part-way. Fixed: the leftover CLI is reaped, and the next message resumes on A (/proc). Pre-fix: the orphan stayed alive and the binding was B.
  Cross-check, the r2 verifier's own harnesses (cleanroom-verify-jcx9Z8/vt) run on this tree:
  - h2-restart: 3/3 hold.
  - h4-container: 5/5.
  - h5-rapid-picks: 4/4 (it was BROKEN on r2).
  - h1-fork: 4/4.
  - h3-stopfail: 4 hold, 1 break. That check asserts r2's `deferred:true`, which is superseded by design (now ok:false and not switched).
  ANTI-REGRESSIONS: verify:bug-255 21/0, verify:feat-160 46/0, verify:bug-255-ui 5/0, verify:bug-255-truth-ui 17/0 (its must-FAIL vs the r1 client still fires), verify:feat-145-session-override 34/0, verify:feat-145-session-wiring 21/0. npm run gate PASS (exit 0). Screenshots visually reviewed (the unknown chip, the C1 failure state): clean.

  BEHAVIOUR CHANGE TO FLAG (a decision for the orchestrator/user, not hidden): success criterion 5 ("an unbound, not-live session keeps the FEAT-145 per-launch override") is now delivered through a server binding. A pick on such a session rebinds it durably instead of arming an override, and a stale stored per-session account is no longer honoured on resume. This is the direct consequence of adjudication rule (2). A new session (no id yet) keeps the FEAT-145 override unchanged.

  UNTESTED / RESIDUAL:
  - Real docker container launch (only registration, display and refusal were tested).
  - An adopted restart survivor (no stub path). Its fact has `next` but no launch, so the chip shows the binding or project account, not the survivor's actual launch account.
  - A queued outbox row written by an OLD client still carrying claudeAccount for an unbound session: the server honours it, so its launch could differ from the `next` shown until the launch is declared.
  - If releaseSocketSession's own close also fails after a failed switch, the C1 path relies on it.
  - The new-session (no id) chip still omits the machine-default layer.
  - The usage badge falls back to the first Claude snapshot while the account is unknown.
  HIGH-STAKES (session lifecycle, billing, regression-prone): the one independent verify the adjudication calls for is REQUIRED. This lane did not self-verify.

### 2026-10-13 — verify lane r3 (Claude fallback; OpenAI quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run e43dd24e-0b05-46d7-a248-10f8469dc15b — VERDICT: BROKEN — FINAL-round independent verify, untangled HEAD+BUG-255(r1+r2+r3) candidate (faithful: 21/46/5/17/18). OpenAI quota->Claude opus-5 fallback (decorrelation reduced). BROKEN: TWO-BREAK on unbound-display-truth + container-drift. Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (verifying r3 — untangled candidate + independent verify, BROKEN)
- **independent clean-room re-verify of the FINAL r3 round: BROKEN (two-break → independent design review):** Commissioned the one independent verify the r2 adjudication called for, on an untangled BUG-255-only candidate. VERDICT BROKEN, contract VALID (manifest-backed, executed evidence).

  UNTANGLE (no real-repo git writes; /tmp fixture only). Extended the r2 decorrelated candidate by one round: copied /tmp/bug255-r2cand-NXW5tP (baseline 80cf619 = pristine HEAD 1a68e57 + BUG-255 r1+r2) and applied the PURE r3 delta = diff(/tmp/bug255r3-pre/<file>, live worktree) for the 6 r3-touched source files, plus the 2 new files (scripts/verify-bug-255-r3-ui.mjs, scripts/fixtures/bug-255/entry-stopfail.mjs), the package.json verify:bug-255-r3-ui entry and the regenerated test-manifest. 3 FEAT-164 reject hunks in index.ts were foreign (zero BUG-255 lines) and correctly DROPPED — same cosmetic-reconciliation class as r1/r2. SCOPE NOTE: the dispatch's r3 file list was incomplete — r3 ALSO edited scripts/verify-bug-255-ui.mjs (prefixApp2 reverting the restoreOverrides claudeAccount-strip in the pre-fix synthesis) and scripts/verify-bug-255-truth-ui.mjs (extracted acceptAccountFact gets its own accountFactMaxBoot; r3 "checking" wording; a 4th total-order assertion); the stale r2 copies made truth-ui error and the ui twin fail until the pure (foreign-free) BUG-255 r3 deltas were applied. Candidate /tmp/bug255-r3cand-k9Qm2.

  CANDIDATE VALIDATION (build-faithfulness, NOT verification): typecheck exit 0; verify-bug-255 21/0; verify-feat-160 46/0; verify-bug-255-ui 5/0; verify-bug-255-truth-ui 17/0; verify-bug-255-r3-ui 18/0 (real headless browser) — matches the fixer's self-reported numbers, so the untangle is faithful. git-write hook blocks scratch git too, so the fixture could not be committed; handed to independent-verify as --working-tree (dangling tree c9b852169c5e, baseline 80cf619), .claude+docs stripped, node_modules copied, leak-check = 15 BUG-255 paths only, no fixer report.

  PROVIDER: OpenAI requested (cross-provider) but its 5h quota was spent (reset ~3h out, >60min away), so per the dispatch's fallback rule the verifier ran same-provider Claude opus-5 — decorrelation REDUCED (author Claude, verifier Claude), structural independence preserved (separate process, fresh context, board/methodology stripped, no fixer report). dispatch anthropic/claude-opus-5 run e43dd24e-0b05-46d7-a248-10f8469dc15b. A true cross-provider OpenAI pass after the reset is warranted and is an orchestrator decision.

  VERDICT: BROKEN. Floor re-established: fixer suite 21/21.
  - BREAK (a/b) UNBOUND-DISPLAY-TRUTH — TWO-BREAK (high), route to independent design review. Path 1 (ws start resume): a resume carrying overrides.claudeAccount=A launches the CLI on A (/proc CLAUDE_CONFIG_DIR) while the chip showed B; dropBoundAccountOverride strips the override only for BOUND sessions, so an UNBOUND session's per-launch override still reaches the spawn and contradicts the displayed fact. Path 2 (tab-free, same defect): POST /api/outbox for an unbound session — the detached pump handOver (index.ts ~:2330) resumes on A while a viewing tab shows B. Same property, two distinct paths. NOTE: r3's own behaviour-change flag said success-criterion-5 is now delivered via a server binding and no per-session override is honoured; these two paths show the override is still honoured on the UNBOUND resume paths, i.e. the rule-(2) "no client fallback" chokepoint has a hole for unbound sessions.
  - BREAK (a/e) CONTAINER-DRIFT (high): a session bound to A while its project is `direct`, then the project is PATCHed to `container`; the indicator keeps declaring A though a container launch binds the PROJECT account (B)'s credentials. index.ts accountFactOf / nextResumeAccountOf never consult proj.isolation, so the declared fact drifts from what a container launch would actually use.
  - (low) none beyond the above this round.

  PASSED (robust): full author floor 21/0; container per-session pick refused for all 3 pick shapes; boot×3 total-order (older boot never wins, lower-rev dropped); rapid live picks (binding = last, no orphan); live switch relaunches under the new account (/proc) and continues the conversation; offline rebind of a proven-stopped bound session + resume under the pick (/proc); offline rebind refused when live via a bridge. So (b) relaunch, (c) failed-stop-no-orphan, (d) stopped-pick-then-resume, the restart total-order, and container REFUSAL all HELD; the failures are (a) indicator truth for UNBOUND sessions and container display drift.

  COULD-NOT-TEST (verifier's follow-up queue): real container runtime (sandbox:docker not exercised — container-drift rests on server authority, not an observed in-container credential bind); restart-survivor adoption (no survivor fixture, SURVIVE=0); multi-tab push loss under genuine socket churn; whether projectId can name a different project via the real UI.

  ARTIFACTS: candidate /tmp/bug255-r3cand-k9Qm2; verdict /tmp/bug255-r3-verdict.json; IV log /tmp/bug255-r3-iv.out; clean room (kept) ~/.local/state/claude-station/scratch/cleanroom-verify-H1qMdC; requirement /tmp/bug255-r3-req.txt. NEXT: BROKEN. The r2 adjudication declared r3 the FINAL fix round with "a further indicator-truth break goes to the user" — this round found exactly that (a two-break on unbound-display truth plus container-drift), so this routes to the user / independent design review, not another patch round. Pending orchestrator decisions: (i) accept the same-provider verdict or re-run cross-provider on OpenAI after the ~5:02 quota reset; (ii) the FINAL-round escalation to the user.

### 2026-10-14 — worker (fixing r4)
- **r4 built: one launch-account authority; demo U1/U2/U3 must-FAIL→PASS; gate PASS; independent verify required:** r4 built: ONE launch-account authority (effectiveLaunchAccount); per-launch account overrides deleted; demo U1/U2/U3 must-FAIL then PASS; gate PASS. regressed-from: BUG-255 r3 (and FEAT-160 r4's bound-only dropBoundAccountOverride, which left unbound overrides honoured).

  ROOT CAUSE (verified against the code before building): the account a launch used was decided in four places: the AgentSession constructor's override loop (client overrides.claudeAccount), the constructor's FEAT-160 binding block (won only for BOUND sessions), container-manager containerAccountId (the container credential bind), and index.ts nextResumeAccountOf (the indicator's declared `next`, which read the binding even for a container project). The indicator read only the last. Break 1 = loop vs `next` for an unbound session; break 2 = binding vs container bind.

  DECIDED DESIGN (orchestrator, under the user's standing instruction): one server function decides; every launch path and the indicator fact call it; per-launch overrides go away; a pick on an existing session binds it; a container project uses the project account whatever the binding says; a new session's pick is its initial binding; the dead override plumbing is deleted, not guarded.

  PLAN REVIEW: OpenAI (dispatch openai, thread 01a13943-8b4c-7ee2-8535-1423efa3c206): SOUND WITH CHANGES. All five folded in: (1) re-publish facts on project PATCH (isolation/account) and machine-default PATCH; (2) a container launch decides against the project snapshot admission bound the credentials from (admitContainer returns admittedProject → StartOptions.launchProject); (3) the new-session pick survives the start-row journal (row keeps the raw pick; ws new, ws start-without-row and the pump's route 'new' each split it once); (4) the init-time binding write is captured at construction (fork parent's binding is not re-read at init), written once, only for a new id with no binding, before the first-message record settles; a failed write is a loud non-fatal error; (5) client audit: the usage badge no longer falls back to another account's window, the new-session chip reads a server-declared project launchAccount, the "set" badge ignores a dormant container binding.

  THE FUNCTION: src/server/launch-account.ts effectiveLaunchAccount({sessionId, initialBinding}, project): container → project account (applyGlobalDefaults under project.settings); session id with a binding → binding; new session (no id) with a pick → the pick; else → project account. Also projectLaunchAccount and takeAccountPick (removes a client pick from raw overrides; returns it only for a NEW session).

  LAUNCH SITES (rg of startSession( / new AgentSession( / adoptSession( in src/; asserted by verify:bug-255-r4-structure S1):
  - index.ts runNewSessionStart → startSession: ws `start` new session with a first message + the outbox pump's route 'new' (Send again of a start row). Pick → initialBinding.
  - index.ts handOver resume → startSession: the outbox pump resume, Send anyway, boot re-pump. Row pick taken off unread.
  - index.ts ws `start` → startSession: resume, fork, new session without a minted row; also the resume after a live account switch. Resume/fork pick taken off unread.
  - index.ts boot adoption → adoptSession → new AgentSession (no spawn; launch account not declared, launchAccountKnown=false).
  - agent-bridge startSessionAdmitting → new AgentSession: the one constructor; effective.claudeAccount = effectiveLaunchAccount(...) is its only assignment; the override loop skips claudeAccount; CLAUDE_CONFIG_DIR is resolved from effective.
  - container credential bind: container-manager containerAccountId → effectiveLaunchAccount (container branch).
  - indicator: index.ts nextResumeAccountOf → effectiveLaunchAccount; the launch fact is the bridge's effective (same function).
  - relogin propagation (reloginSessionAccount) now reads the session's effective account (container = project account by construction).
  Tripwire: startSession throws if overrides.claudeAccount reaches it, or if initialBinding comes with a resume.

  CHANGED FILES (unstaged): src/server/launch-account.ts (NEW), src/server/agent-bridge.ts, src/server/index.ts, src/server/session-accounts.ts (dropBoundAccountOverride deleted), src/server/container-manager.ts (containerAccountId delegates; admitContainer returns admittedProject), public/app.js (indicator renders launch else next, never the raw binding; pending = launch≠next; claudeAccount only on a brand-new start, not a fork; usage badge; new-session chip; set badge), scripts/verify-bug-255-r4-ui.mjs (NEW), scripts/verify-bug-255-r4-structure.mjs (NEW), package.json (2 entries), scripts/test-manifest.json (regenerated; only the 2 new entries + date), scripts/verify-feat-160.mjs, scripts/verify-bug-255.mjs, docs/bugs/assets/BUG-255-r4-*.png.

  TESTS UPDATED because they asserted the removed behaviour: verify-feat-160 §7 (its "must-FAIL control" asserted an UNBOUND resume runs on the client override A — that is verify r3's break 1; now asserts the project account), §8 source matcher (projectLaunchAccount), §9/§10 (dropBoundAccountOverride → takeAccountPick; unbound resumes now drop the pick too; a new session's pick still fails validation of a bad id). verify-bug-255 A: the "unbound session has no boundAccount" control now starts its session with no pick (a new session's pick now becomes its binding).

  DEMO, npm run verify:bug-255-r4-ui: ALL PASS 12/0. Real headless Brave, isolated scratch servers on free ports, fake CLI, stub credentials, busy state (bound + unbound neighbours, a second viewing tab). Must-FAIL against a SYNTHESIZED PRE-FIX tree (/tmp/bug255r4-preroot = this working tree with the r4-touched files restored from their pre-edit snapshot /tmp/bug255r4-pre):
  - U1 ws start resume, unbound session shown "plan B", the UI's start frame carrying a client pick A (injected on the wire as an older client sends it): fixed launches on B (/proc), both tabs stay "plan B". Pre-fix: launched on A, chip flipped to A.
  - U2 outbox pump, a row carrying client account A for that session, a viewing tab open: fixed resumes on B (/proc), tab "plan B". Pre-fix: launched on A.
  - U3 session bound to A under direct (project B), tab open showing "plan A"; project PATCHed to container: the open tab (no reopen) and a fresh tab show "plan B", server next=B; back to direct: "plan A" and a real resume on A (/proc). Pre-fix: both tabs stayed "plan A", next=A.
  - U4 (new rule, not graded): a new session picked A (project B) launches on A, is bound to A at init, shows "plan A" after it stops, resumes on A. Pre-fix broke it too (reopened showed B, resumed on B).
  - U5 (not graded): a fork of a session bound to A, client sending B, runs on A (/proc), the child id is bound to A, its chip shows "plan A".
  STRUCTURE, npm run verify:bug-255-r4-structure: ALL PASS 21/0 (6 known construction sites, none passes an account; one assignment from the function; override loop skips the account; container bind + declared next call the function; dropBoundAccountOverride gone; runtime tripwire throws before any event; the decision table on the real module). Must-FAIL: the pre-fix tree fails S3 and S5.
  ANTI-REGRESSIONS: verify:bug-255 21/0, verify:feat-160 46/0, verify:feat-145-session-override 34/0, verify:feat-145-session-wiring 21/0, verify:bug-255-ui 5/0, verify:bug-255-truth-ui 17/0, verify:bug-255-r3-ui 18/0, verify-openai-model-inheritance 19/0. verify-feat-145-container-account: the bind-list checks (incl. machine default + project pin via containerAccountId) PASS; its real container start fails in the sandbox daemon for an environment reason (CDI GPU discovery). verify-feat-145-usage and verify-feat-146-settings-content fail IDENTICALLY on the pre-fix tree (pre-existing: usageFaceSnap outside the extracted region; agent git-init refused). One sweep was poisoned by another lane's mid-edit of src/server/delegations.ts (syntax error, server would not boot); re-run after it settled, all green. npm run gate PASS (exit 0).

  UNTESTED / RESIDUAL:
  - A real container LAUNCH (U3 asserts the declared fact and the bind decision, not an in-container credential read; no docker launch).
  - Crash between spawn and system:init for a new session: no id existed, so no binding is written; its resume then runs on — and the indicator shows — the project account (honest, but the pick is lost).
  - An adopted restart survivor: its running account is still undeclared (next describes its next launch).
  - A failed init-time binding write: emitted as a non-fatal error; not exercised (no fault seam).
  - The open tab's isolation footer ("Direct · full access") does not refresh after another client PATCHes the project to container — not the account indicator, pre-existing, seen in BUG-255-r4-U3-container-fixed.png.
  - A project PATCH re-publishes facts only for sessions the server has placed (read via list/transcript/GET hint) or has live.

  HIGH-STAKES (session lifecycle, billing, regression-prone file set): an independent clean-room verify is REQUIRED. This lane did not self-verify.

### 2026-10-14 — verify lane r4 (Claude fallback; OpenAI quota)
- **Verification recorded:** dispatch anthropic/default run c36f27a6-00df-4267-9cd6-1394e811e7fa — VERDICT: BROKEN — Independent clean-room verify, untangled HEAD+BUG-255 r1-r4 candidate (tree 2fa2592d6c07). OpenAI quota mid-run; Claude same-provider fallback. Floor 21/0. BROKEN, iso-drift-live-switch: a LIVE pick after project goes container is accepted but next launch stays project account. See Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (verifying r4 — untangled candidate + independent verify, BROKEN)
- **independent clean-room re-verify of the r4 structural re-fix: BROKEN (1 path — live switch-account validates a stale project snapshot):** Commissioned the required independent verify of the r4 "one launch-account authority" re-fix on a BUG-255-ISOLATED candidate. VERDICT BROKEN, contract VALID (manifest-backed, executed evidence).

  UNTANGLE (no real-repo git writes; /tmp only). Extended the proven-faithful r3 candidate (/tmp/bug255-r3cand-k9Qm2 = pristine HEAD 1a68e57 + BUG-255 r1+r2+r3, baseline 80cf619) by the pure r4 delta. Method: diff(fixer pre-r4 snapshot /tmp/bug255r4-pre/<f>, live worktree) per r4-touched file. container-manager.ts, session-accounts.ts applied clean (BUG-255-only). index.ts and public/app.js were CONTAMINATED by a concurrent FEAT-184 lane (new file src/server/delegations.ts + delegation routes, landed AFTER the pre-snapshot) — a delegated worker surgically dropped all 4 FEAT-184 hunks and reconstructed the genuine BUG-255 r4 hunks against the decorrelated base. agent-bridge.ts r4 hunks all genuine. Candidate /tmp/bug255-r4cand-AFokw; working-tree snapshot tree 2fa2592d6c07 (dangling commit, real index untouched); 5-product-file sha256 a950ca4b…. FEAT-184 fully excluded (0 delegations/handleDelegationRoute tokens; delegations.ts absent).

  SCOPE / DEPENDENCY NOTE: index.ts r4 is interleaved with four other OPEN tickets' uncommitted work that shares the file — BUG-253 (outbox new-session start), FEAT-177 (first-turn attachments), BUG-254 (relogin), FEAT-184 (delegations). The pure BUG-255 base lacks their scaffolding, so of the r4 index.ts hunks, those targeting other tickets' code were correctly skipped and ONE passthrough (`...(initialBinding ? { initialBinding } : {})` on the base's single ws-start startSession) was hand-reconstructed (without it the floor failed 19/2 on the new-session launch-account path). BUG-255 r4 does NOT depend on these tickets; it is isolable, but a fully-faithful STRUCTURAL-COUNT check needs them present.

  CANDIDATE VALIDATION (build-faithfulness, NOT verification): typecheck exit 0; verify-bug-255 21/0; verify-feat-160 46/0; verify-bug-255-ui 5/0; verify-bug-255-truth-ui 17/0; verify-bug-255-r3-ui 18/0; verify-bug-255-r4-ui 12/0 — all match the fixer's self-report, so the behavioural untangle is faithful. The ONE mismatch: verify-bug-255-r4-structure 20/1 — its S1 COUNTS 5 construction sites and hard-codes the integrated tree's spawn topology (the BUG-253 runNewSessionStart ternary) absent from this isolated base; S2 (the behavioural decision table on the real module) passes. The independent verifier re-enumerated the call sites itself and found exactly 5, none self-sourcing an account, and independently judged S1's failure to be BUG-253 topology coupling, not a BUG-255 defect.

  PROVIDER: OpenAI requested (cross-provider, decorrelated). The clean-room dispatch STARTED on OpenAI/codex but hit the 5h usage limit mid-run (reset ~15:15, >60min away) → fail-closed INVALID. Per the dispatch's fallback rule the verify was re-run same-provider Claude (dispatch anthropic, model default; decorrelation REDUCED — author Claude, verifier Claude — structural independence preserved: separate process, fresh context, board/methodology/docs/.claude stripped, 23/23 diff paths allow-listed, no fixer report). dispatch anthropic run c36f27a6-00df-4267-9cd6-1394e811e7fa. A true cross-provider OpenAI pass after the reset is warranted and is an orchestrator decision.

  VERDICT: BROKEN. Floor re-established: author suite 21/0.
  - BREAK (d / b) ISO-DRIFT-LIVE-SWITCH (high; ONE path, NOT a two-break this round). A session running LIVE under `direct` on project account P; the project is PATCHed isolation=container (returns 200, allowed while live); a ws `switch-account` pick of B is then ACCEPTED — ack ok:true "switched to B", binding written B, the old CLI on P reaped — yet effectiveLaunchAccount / fact.next is still P. So (1) a per-session pick is NOT refused though the project is now container (requirement: container pick refused explicitly), and (2) the ack reports a switch to B that the next launch will not honour (requirement: an accepted pick really relaunches on the pick; indicator == reality). CAUSE: the live `case 'switch-account'` handler (src/server/index.ts, `const proj = session.project`) validates against the session's START-TIME project snapshot, not the current registry, so its accept/refuse decision disagrees with effectiveLaunchAccount (which reads the current project → container → project account). The OFFLINE rebind path re-reads reg.getProject and refuses correctly — only the LIVE path has the hole. Related to r3's container-drift (same isolation-change property family) but a distinct, reframed attack (live switch vs stopped U3).

  PASSED (robust this round): author floor 21/0; property (a) ONE-DECIDER held — the verifier independently enumerated the spawn/construction sites (index.ts handOver resume, ws start, adopt-boot; agent-bridge startSessionAdmitting, adoptSession) and found none self-sources an account; the container decision table (S2) on the real module holds.

  COULD-NOT-TEST (verifier's follow-up queue): restart-survivor adoption (no survivor host in scratch — an adopted bridge sets launchAccountKnown=false, fact carries only `next`, never compared to the survivor's real /proc CLAUDE_CONFIG_DIR); a REAL container resume via `npm run sandbox:docker` (container account checked only via fact.next + the decision fn, not a running container's credential bind); the failed-stop C1/C2 and the headless-browser multi-tab cases were not re-run this session (rapid-pick refusal checked by code read — deliveryInFlight reservation); a true cross-provider OpenAI pass (quota).

  ARTIFACTS: candidate /tmp/bug255-r4cand-AFokw; verdict text /tmp/bug255-r4-verdict-anthropic.json; IV log /tmp/bug255-r4-iv-anthropic.out (OpenAI quota-fail log /tmp/bug255-r4-iv.out); requirement+attacks /tmp/bug255-r4-req.txt; clean room (kept) ~/.local/state/claude-station/scratch/cleanroom-verify-7b9w30. NEXT: BROKEN → not closed. Pending orchestrator decisions: (i) accept the same-provider verdict or re-run cross-provider on OpenAI after the ~15:15 quota reset; (ii) route the iso-drift-live-switch break (live switch-account reading session.project not reg.getProject; container pick not refused when the project became container while live) to the fixer or, given it is the isolation-change property breaking again, to design review.

### 2026-10-14 — worker (fixing r5 — live switch-account reads the live project)
- **r5: the live switch-account refusal now reads the CURRENT project (reg.getProject), closing the iso-drift-live-switch break; demo must-FAIL→PASS; all bug-255*/feat-160 suites green; gate PASS; independent verify warranted.** regressed-from: BUG-255 r4 (the r4 re-fix moved every launch/indicator decision onto the live project via effectiveLaunchAccount, but left the LIVE switch-account handler validating the start-time snapshot — the one path the r4 verifier, run c36f27a6, broke).

  HYPOTHESIS CONFIRMED (verified against the code before editing): the live `case 'switch-account'` handler (src/server/index.ts ~:6636) read `const proj = session.project` — the AgentSession's START-TIME project snapshot. Its container refusal (`validateSessionOverrides({claudeAccount}, {isolation: proj.isolation})`) and its inherit resolution (`projectLaunchAccount(proj)`) therefore disagreed with `effectiveLaunchAccount`, which reads the CURRENT project from the registry. So a session running LIVE under `direct`, whose project was PATCHed isolation=`container` while live, accepted a per-session pick of B (ack ok:true "switched to B", binding written B, old CLI reaped) even though the next launch stays on the project account (container → project account, FEAT-145) — the ack lied and the indicator/launch disagreed.

  THE FIX (one line + rationale comment, src/server/index.ts): `const proj = reg.getProject(session.project.id) ?? session.project;` — the live switch now decides accept/refuse from the SAME live project `effectiveLaunchAccount` (the one launch authority, which the next spawn and the indicator fact both call) reads. A pick on a now-container project is refused with the FEAT-145 container reason (visible), the binding is untouched, and the indicator keeps the true (project) account. The fallback to the snapshot covers a project deleted from the registry mid-session (best-effort validation; never a crash).

  SWEEP (rg every read of `session.project` / a cached project snapshot in account+launch paths; listed so the next reviewer need not re-derive):
  - LIVE `switch-account` handler, index.ts ~:6636 — THE BUG. Fixed: now `reg.getProject(session.project.id)`.
  - Spawn/resume: ws `start` (index.ts :5747 `reg.getProject(cmd.projectId)`), `offlineRebindAccount` (:5147 `reg.getProject(opts.projectId)`), `accountFactOf`→`projectOfSessionForFact` (:5025 `reg.getProject`), `nextResumeAccountOf` (:5043), `containerAccountId` (container-manager.ts :1057), the AgentSession constructor's `effectiveLaunchAccount(…, opts.launchProject ?? opts.project)` (agent-bridge.ts :1417, project passed fresh by the caller) — ALL already read a fresh registry/live project. No account/launch decision other than the live switch read a stale snapshot.
  - The only remaining `s.project.isolation` reads (index.ts :659, :3194) are session-snapshot DISPLAY fields (the live session's isolation in sessions-list / running-snapshot) — not account decisions; this is the pre-existing "isolation footer does not refresh after a live container PATCH" residual the r4 fixer already noted, NOT the account indicator (the account fact is computed via reg.getProject and does refresh). Out of scope for this break.

  DEMO (must-FAIL synthesized pre-fix): `npm run verify:bug-255-r5-live-container` (NEW, scripts/verify-bug-255-r5-live-container.mjs) — REAL server + REAL ws + live fake CLI; only CLAUDE_CONFIG_DIR read from /proc. ALL PASS 11/0. Grades the SAME scenario (live session on project account A → PATCH project to container → ws pick of B) against the FIXED tree AND a SYNTHESIZED PRE-FIX tree (the working tree with ONLY this r5 line reverted to `const proj = session.project;`, node_modules symlinked). FIXED: the live pick is REFUSED (ack ok:false, the FEAT-145 container reason), the binding is NOT written to B, fact.next stays the project account A. PRE-FIX (must-FAIL anchor confirmed): ack ok:true "switched to B" + binding B, yet fact.next (the next launch) is still the project account A — the lie. The two trees diverge on exactly this decision.

  ANTI-REGRESSIONS (all green): verify:bug-255 21/0, verify:feat-160 46/0, verify:bug-255-ui 5/0, verify:bug-255-truth-ui 17/0, verify:bug-255-r3-ui 18/0, verify:bug-255-r4-ui 12/0, verify:bug-255-r4-structure 21/0 (its S1 passes on this integrated tree — the verifier's 20/1 was BUG-253 topology coupling on an isolated base, not a defect). `npm run gate` PASS (exit 0; leak-gate + check-nul + unicode + prompt-privacy + typecheck all clean, read unpiped).

  CONTAMINATION NOTE (honesty): a concurrent lane was mid-editing src/server/board.ts (which index.ts imports) during two UI sweeps, leaving a transient regex syntax error that crashed server boot and produced wholesale `TypeError: fetch failed` (not logic failures). After board.ts settled to a valid state, every suite above was re-run clean. No BUG-255 file was involved in the contamination.

  CHANGED FILES (unstaged): src/server/index.ts (the one-line live-switch fix + comment), scripts/verify-bug-255-r5-live-container.mjs (NEW demo), package.json (1 new verify entry), scripts/test-manifest.json (regenerated — deterministic; classified the new script scratch-server; a fresh `node scripts/gen-test-manifest.mjs` at commit time is advisable since concurrent lanes also add scripts).

  HIGH-STAKES (session lifecycle + billing + a regression-prone file set): this lane did NOT self-verify. An independent clean-room verify is warranted — reframe the attack on the isolation-change property (live switch during a streaming turn under container drift; a two-tab live switch where the driving tab's project PATCH races; the failed-stop path under container) rather than re-running this demo.

### 2026-10-14 — verify lane r5 (Claude same-provider; OpenAI quota)
- **Verification recorded:** dispatch anthropic/default run a6333233-7c63-494b-ab28-c0edea2fe36e — VERDICT: BROKEN — Independent clean-room verify, untangled HEAD+BUG-255 r1-r5 candidate. Fixer suite 11/0 (round-4 break closed). BROKEN: a PATCH to container landing mid-switch (during close, not before) still acks switched+binds, fact.next stays project acct -- two-break -> design review.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (verifying r5 — untangled candidate + independent verify, BROKEN, two-break)
- **independent clean-room verify of r5 (live switch-account reads the live project): BROKEN, two-break on the isolation-change property → independent design review:** Commissioned the independent verify r5 requires (session-lifecycle + billing, regression-prone). Did NOT self-verify.

  UNTANGLE (no real-repo git writes; /tmp fixture only; the git-write guard blocks `git add`/`commit` even in a scratch tree, confirmed again this round). Extended the proven-faithful r4 candidate `/tmp/bug255-r4cand-AFokw` (pristine HEAD 1a68e57 + BUG-255 r1–r4, baseline commit 80cf619) with the pure r5 delta: the one-line fix + its comment block in `src/server/index.ts` (`const proj = session.project;` → `const proj = reg.getProject(session.project.id) ?? session.project;`, located by exact-text match, applied once) plus the new file `scripts/verify-bug-255-r5-live-container.mjs` and the one `package.json` script entry. No other r5 file changes exist per the fixer's own CHANGED FILES list (`scripts/test-manifest.json`'s regen was not replayed — it is derived, not behavioural). typecheck clean (`npx tsc --noEmit`).

  CANDIDATE VALIDATION (build-faithfulness, not verification): ran all 8 of the fixer's suites against the candidate — verify:bug-255 21/0, verify:feat-160 46/0, verify:bug-255-ui 5/0, verify:bug-255-truth-ui 17/0, verify:bug-255-r3-ui 18/0 (first pass hit MY OWN 180s per-script cap mid-run, exit 124, 2 FAIL in the long-running [prefix] C1/C2 cases; re-ran uncapped and got 18/0 — a harness artifact on my side, not a candidate defect), verify:bug-255-r4-ui 12/0, verify:bug-255-r5-live-container 11/0 — all match the fixer's self-report. verify:bug-255-r4-structure 20/1 — the SAME already-explained S1 topology-coupling artifact the r4 verifier found (S1 hard-codes the fully-integrated tree's spawn count including a BUG-253 ternary absent from this isolated base; S2, the real behavioural decision table, passes). So the untangle is faithful.

  Handed to `scripts/independent-verify.mjs` as `--working-tree` over the fixture (`--repo /tmp/bug255-r4cand-AFokw`, HEAD already at the baseline commit so the dirty tree IS the full r1–r5 diff), `--max-diff-bytes 200000` (full diff 139,817 bytes, 24 changed paths, none truncated), `.claude`+`docs` stripped, no fixer report given — only the requirement, the diff, how to run it (the 8 suites above), and a copy of the fixer's test code.

  REQUIREMENT HANDED TO THE VERIFIER: the r4 requirement verbatim (one server function decides every launch's account; the indicator shows that function's answer or "unknown/checking"; a pick durably rebinds and relaunches or is visibly refused/failed with no orphan; container uses the project account with per-session picks refused; facts survive a restart) PLUS the round's new clause: "an isolation change (direct↔container) at any time, including while a session is live, is reflected in both the refusal decision and the indicator." Attacks specified: (a) the isolation-change property via every path (live switch, stopped pick, resume, outbox, fork, a PATCH racing an in-flight switch); (b) the r4 attack set as a brief regression; (c) any remaining account decision reading a cached project. The two-break stop clause was restated verbatim.

  PROVIDER: anthropic (same as the author) — OpenAI's 5h quota is out until ~15:15 (the user is waiting on this ticket to restart the service, so parking for the reset was rejected per standing instruction). Recorded honestly: `--author-provider anthropic --provider anthropic`, decorrelation reduced (author Claude, verifier Claude), structural independence preserved (separate process `scripts/independent-verify.mjs` → `dispatch.mjs`, fresh context, a stripped clean room at `~/.local/state/claude-station/scratch/cleanroom-verify-FdkYfn`, no fixer report, no board/methodology). dispatch anthropic, model default, run **a6333233-7c63-494b-ab28-c0edea2fe36e**. A true cross-provider OpenAI pass after the ~15:15 reset is warranted and is an orchestrator decision.

  VERDICT: **BROKEN**, contract VALID (manifest-backed, executed evidence). Floor re-established: fixer's own r5 demo 11/0 (the round-4 iso-drift-live-switch break — a PATCH to container BEFORE the pick — is confirmed closed: the live pick is now refused with the FEAT-145 container reason, binding untouched, fact.next stays the project account).

  BREAK (a/d) ISO-DRIFT-RACE-DURING-SWITCH (high; a DISTINCT path from the round-4 break, not a re-opening of it) — TWO-BREAK on the same property, route to independent design review. The verifier wrote its own adversarial harness (`scripts/adv-255-race-patch-inflight.mjs`, run b1f44ab40553) that sends the ws `switch-account` pick of B on a session live under `direct`, THEN PATCHes the project to `container` 0ms and separately 400ms later — i.e. while the handler is still inside `await live.closeLifetime()` / `await live.close()` (held open ~2s by a stub CLI that takes 2.5s to exit on stdin EOF). Both timings: the PATCH lands (~7ms / ~407ms) well before the switch's ack (~2010ms); the switch still completes as `ok:true, account:B`, `setSessionAccount(B)` is written, and `last.outcome:'switched'` is recorded — while `fact.next` (effectiveLaunchAccount, what the next launch actually uses) stays the project account A the whole time. CAUSE NAMED: the live handler's `reg.getProject(...)` read (r5's own fix) happens exactly ONCE, synchronously, before the `closeLifetime()`/`close()` awaits, and is never re-checked after them — so a PATCH landing inside that await window is invisible to the decision r5 just fixed to read fresh. Round 4's break was a PATCH landing BEFORE the pick (decided against a start-time snapshot that r5 fixed); this round's break is a PATCH landing DURING the pick's async window (decided against a pre-await read that is itself now stale by the time of the writes) — same property ("the live-switch accept matches the current isolation"), a genuinely different mechanism, so the two-break stop clause fired and no guard was proposed.

  PASSED (robust): the r5 demo's own scenario (PATCH fully before the pick) 11/0, confirming the round-4 break is closed for that ordering.

  COULD-NOT-TEST (the verifier's stated queue, honestly disclosed, NOT silently dropped — it stopped at the two-break per the stop clause rather than building further harnesses): offline (stopped-session) rebind across an isolation change; resume after an isolation change while stopped; the outbox pump delivering a queued row across an isolation change; a fork across an isolation change; a real container relaunch's `/proc` CLAUDE_CONFIG_DIR (no docker; `fact.next` was used as the next-launch oracle since the spawn constructor computes it with the same function); the busy-state headless-browser UI attack (checked only at server/ws level); a full re-run of the r4 regression set beyond the 8 suites already used for candidate validation; a grep for `session.project`/cached-project reads outside `src/server` or under other names (grep inside `src/server` found only the one r5 line; the spawn sites it checked all read `reg.getProject` fresh).

  ARTIFACTS: candidate `/tmp/bug255-r4cand-AFokw` (dirty working tree = full r1–r5 diff vs baseline commit 80cf619; pristine HEAD 1a68e57); requirement `/tmp/bug255-r5-req.txt`; IV log `/tmp/bug255-r5-iv.out`; verdict `/tmp/bug255-r5-verdict.json`; clean room (kept) `~/.local/state/claude-station/scratch/cleanroom-verify-FdkYfn` (manifest `~/.local/state/claude-station/scratch/cleanroom-record-sZ93XC/manifest.jsonl`). NEXT: BROKEN → not closed. The isolation-change property has now broken via two distinct mechanisms across two rounds (stale start-time snapshot; stale pre-await read inside the same handler's own async window) — per the two-break rule this routes to independent design review (the live switch-account handler needs its container/isolation validity re-checked AFTER, not only before, its stop/close awaits — or the decision needs to be made atomically with the commit, not read-then-await-then-write) rather than another point patch. Pending orchestrator decisions: (i) accept this same-provider verdict or re-run cross-provider on OpenAI after the ~15:15 reset; (ii) route to design review per the two-break rule, or escalate to the user given r3's adjudication called r3 "the FINAL fix round" and r4/r5 are continuations past that boundary.
