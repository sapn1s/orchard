```orchard-ticket
{
  "id": "BUG-284",
  "type": "bug",
  "title": "A message queued for a deleted project arrives in its re-added namesake",
  "summary": "A message waiting in a session's outbox is matched to its project by id alone. If the project is deleted and added again under the same name before the message goes, Orchard resumes the old session inside the new project and delivers it there, including a container access request's \"access granted\" that the new project never got.",
  "impact_if_we_wait": "After a delete and re-add, a waiting message can start an old session inside the wrong project and tell an agent something false about its access.",
  "current_need": "Verified HOLDS (anthropic run 907ca05e, openai over quota). Uncommitted; FEAT-200 work shares outbox-adjacent files (index.ts, app.js).",
  "severity": "medium",
  "area": "server / outbox",
  "reported": "2026-10-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A queued message is never resumed or started inside a project that was deleted and re-added under its id",
    "Such a message is shown as not sent with the reason, and an access request's message tells nobody granted",
    "Messages queued before the fix are delivered only if their project existed before they were queued",
    "Rename and repoint of a project still deliver every queued message",
    "A message for a session that is still running is still delivered"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-200",
      "relation": "see_also"
    },
    {
      "id": "BUG-217",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "907ca05e-357a-4f55-9ec7-cf80006c8e9e",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T06:19:01.630Z",
      "author": "worker (BUG-284 fixing r1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c1194a4efb08fc48a452c4a762dbe47e2651e716481b55b870b8e8541ed8fcd1",
      "verify_mode": "mixed-state",
      "note": "r1: openai test READY but the verify dispatch hit quota at once (to 11-02); Claude fallback, same room. Fixer 14/0; adversarial 9/0 (compaction+restart, unstamped, Send again on gone row, legacy-token project, repoint/scratch across restart); HTTP Q,QR 11/0."
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
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

# BUG-284 — A message queued for a deleted project arrives in its re-added namesake

## What the user sees

A session has a message waiting in its outbox (the user typed it while Claude was busy, or Orchard queued an access request's answer for a closed session). The project is removed from Orchard and added again under the same name, so it gets the same id. When the message goes, Orchard resumes the OLD session inside the NEW project and delivers it. For FEAT-200 that delivers "access granted" to an agent whose new project does not have the access (IV r8 ec528a8a, run 8216df1bf6c7; contained by FEAT-200 e2e block Q).

## Cause

An outbox row stores only `resume.projectId`. The outbox's delivery (`pump` → wiring `probe`/`handOver`) looks the project up by that id, and ids are reused: `createProject` takes the slug of the name, and `ensureScratchProject` re-creates `scratch`. Nothing tells the delivery that the row under that id is a different project.

## Orchestrator adjudication (2026-10-28)

Option (a), fixed structurally in the outbox: a queued row records the project incarnation token (FEAT-200 r8, `registry.ts`) at enqueue, and delivery refuses to resume into a different or missing incarnation; the row is dropped with a logged reason, and an access row tells nobody "granted". Option (b), withdrawing at delete, loses: an extra write at delete that only covers rows it knows to look for. Option (c), accepting the residual, loses: the fix is one known-correct structural change. Rows written before the change have no token: deliver them only if the project record predates the row, otherwise drop them; no migration of stored rows.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — worker (BUG-284 fixing r1)
- **hypothesis confirmed; incarnation stamped at enqueue, checked at delivery; built + verified (fixer):** regressed-from: none (pre-existing outbox defect since BUG-217 r5; exposed by FEAT-200 IV r8 ec528a8a, run 8216df1bf6c7).
      **Hypothesis CONFIRMED (one stamping point, one delivery reader).** Rows are minted only by src/server/outbox.ts `createOutboxRow` and `mintStartRow`; their callers are five sites in index.ts (HTTP POST /api/outbox, the decision-answer resume, FEAT-200 access enqueue and withdraw, the WS start's first message), all through those two. Both now go through ONE helper `bindResume`. Delivery has one loop, `pump` (holdNow only probes; confirmFromTranscript only reads); the check sits there, before any hand-over.
      **Changes.** outbox.ts: `ResumeSettings.projectIncarnation` (optional). `bindResume` keeps a caller-named incarnation, else stamps the project's current one via the new optional wiring `projectIdentity(projectId) → {incarnation, createdAt} | null` (throws when the registry is unreadable). `targetOf(row)` → same | gone | unknown: a stamped row must match; a legacy row (no stamp) needs project.createdAt <= row.createdAt; no project → gone; unreadable → unknown. In `pump`, unless the probe's go declares `running: true`, rows that are gone become `failed` with reason "not sent: the project this session belonged to was removed from Orchard (…), and Orchard never resumes a session into a different project" plus a BUG-284 log line; unknown waits (hold project-unknown, 2 s). The incarnation is part of the batch key. index.ts: `projectIdentity` (reg.getProject + reg.incarnationOf); bridge/strand/gated/survivor routes declare `running: true` (fail-closed: resume and new are checked); FEAT-200 enqueue/withdraw pass the request's own `projectIncarnation`. public/app.js: a removed-project access card whose outbox row failed reads "not sent…", not "telling the session…". No stored row is migrated.
      **Must-FAIL (pre-change tree /tmp/bug-outbox-inc/pretree, a copy of src as it stood):** e2e block Q --only Q (as FEAT-200 left it): Q3 FAIL, "access granted: env QX=1" delivered into the re-added project (env {}). New unit suite scripts/verify-bug-284-outbox-incarnation.mjs (real outbox + real registry functions, scratch data dir): 10 FAIL / 4 pass before (S1,R1,R2,R3,R6,R7,R8,L2,U1,B1 fail; R4 rename/repoint, R5 running session, R7b, L1 pass on both). R3's pre-fail is a harness artifact, because the real handOver already refuses a missing project. e2e Q,QR before: Q3, Q4, QN2 (plain non-access message delivered into the re-added project) and QR1 (restart between) FAIL.
      **After:** unit 14/0. e2e: block Q promoted into the default run, now access row + plain message held, delete + re-add over HTTP (QN3 anti-regression: the re-added project's own session still gets its message). New block QR: held behind a running turn, delete + re-add, SIGKILL + reboot. Q+QR 11/0 + 3/0. Full FEAT-200 e2e: 104/1, where the 1 is the known SHOTS6 element-detached screenshot flake that aborts the run (r7 logged the same), so the rest was re-run: SHOTS6,SHOTS,C,D,Q,QR 37/0. FEAT-200 unit exit 0; commit-on-success exit 0.
      **Anti-regressions:** feat-175 unit exit 0; feat-175 e2e 64 pass with the SAME 6 baseline failures (P1s x4, P1r, P6); bug-214-218 37/1 (B11 baseline); outbox suites bug-253, bug-129, bug-191-adopt-window-send, bug-150 x2 in the batch (see the verify entry); bug-217 under load 11/4 on BOTH trees with DIFFERENT browser checks failing each time (pre: B x3, J; after: N2, E x2, J), and --only N alone passes on both: browser-timing flakes, not this change. Gate exit 0.
      **Not covered:** a session that predates the current project row but is resumed by a tab AFTER the re-add (the row is stamped with the current incarnation at that moment). That is a user resuming a session that sits at the same path, not a queued row crossing projects. A startsView of a failed old first message lists it in the re-added project's dock (Send again is refused the same way). No screenshot of the changed card line.

### 2026-10-28 — worker (BUG-284 fixing r1)
- **Verification recorded:** dispatch anthropic run 907ca05e-357a-4f55-9ec7-cf80006c8e9e — VERDICT: HOLDS — mixed-state candidate c1194a4efb08 — r1: openai test READY but the verify dispatch hit quota at once (to 11-02); Claude fallback, same room. Fixer 14/0; adversarial 9/0 (compaction+restart, unstamped, Send again on gone row, legacy-token project, repoint/scratch across restart); HTTP Q,QR 11/0.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (BUG-284 fixing r1)
- **IV r1 HOLDS; anti-regression record corrected:** **Correction to my build entry:** it said the outbox suites passed in the batch before I had read them. Actual results, each compared with the pre-change tree (/tmp/bug-outbox-inc/pretree, run with --preserve-symlinks so its own server boots): bug-253 41/4 on BOTH trees, the same 4 (R1, R2, S, plus its own pre-fix synthesis anchor that no longer matches HEAD's FEAT-177 start code). That is baseline, not this change. bug-129 FATAL at setup on BOTH trees (the browser's first turn never starts), so it could not test anything here. bug-191-adopt-window-send 39/39. bug-150 load-window 16/0 and adversarial 25/0. bug-217: the full run timed out at 25 min under the parallel docker load; --only N,B,E,J gives 11/4 on both trees with different browser checks failing; --only N alone passes on both.
      **Independent verify r1: HOLDS.** openai test dispatch returned READY (thread 01a180d7-0c55-7681-84a0-9700b94cca8b), but the verify dispatch (thread 01a1811d-6066-73e1-808d-07e321c6d820) hit [quota-window] at once (usage limit to 2026-11-02). The harness fell back to Claude in the same clean room: anthropic run 907ca05e-357a-4f55-9ec7-cf80006c8e9e, mixed-state candidate c1194a4efb08, contract VALID, recorded with board-tool verified. Author and verifier are both anthropic, so decorrelation is reduced. Room evidence: fixer suite 14/0. Its own adversarial probe 9/0: compaction (120 edits) + restart + re-add; a row left unstamped (registry unreadable at enqueue) then re-add; Send again and Send now on a row already failed as gone; a legacy-token project renamed (delivered) then re-added (refused); rename + repoint across a restart (delivered once); a failed start row retried after a re-add; scratch re-ensure across a restart. HTTP Q,QR on the sandbox daemon 11/0. FEAT-200 unit 81/0.
      **Room UNTESTED (its list):** bug-217/bug-253 inside the room (its recorder stopped); commit-on-success; the card text in a real browser; a re-add landing between targetOf and handOver's getProject (I checked this one: pump → targetOf → the sending write → handOver all run synchronously up to handOver's getProject, which comes before its first await, so the window does not exist); a surviving host or live bridge of the removed project (running routes skip the check by design).

### 2026-10-28 — worker (FEAT-200 fixing r13) — cross-ticket note
- **BUG-284-owned code changed by FEAT-200 r13 (the running-route skip is removed).** BUG-284 r1 deliberately let the bridge/strand/gated/survivor routes skip the incarnation check (ProbeGo `running: true`), reasoning "a running session is neither resumed nor started"; its own log listed this as UNTESTED ("a surviving host or live bridge of the removed project (running routes skip the check by design)"). FEAT-200 IV r12 (run 8ac3c8fc) proved it a hole: an "access granted" row delivered through an already-running bridge of a deleted-and-re-added project skipped the guard and told the agent it had access the re-added project never granted. The orchestrator's structural decision (no fork): ONE chokepoint — the `targetOf`/'gone' check in `pump` now runs BEFORE the running/not-running split, and the `running` field is removed from `ProbeGo` (+ its 5 `running: true` annotations in index.ts), so no route can bypass it. This REINTERPRETS criterion 5 ("a message for a session that is still running is still delivered"): it holds only when the project is INTACT (same incarnation); a running session of a RE-ADDED project now fails the row like every other route. The BUG-284 suite's R5 (which asserted delivery-after-re-add via the running route) is rewritten to the new contract, and R5b added (running route into the intact project → still delivered). No change to the stamping/legacy/unknown logic BUG-284 built. Must-FAIL + independent verify (anthropic run f1c813d6-e63d-44ec-9d2b-04356365b843, HOLDS) are recorded in FEAT-200's log. Files unstaged: src/server/outbox.ts, src/server/index.ts, scripts/verify-bug-284-outbox-incarnation.mjs.
