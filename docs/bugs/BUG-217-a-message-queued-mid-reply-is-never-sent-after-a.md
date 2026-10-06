```orchard-ticket
{
  "id": "BUG-217",
  "type": "bug",
  "title": "A message queued mid-reply is never sent after a reload",
  "summary": "The user typed a message while Claude was working, so it waited in the queue. The tab then reloaded or switched away, the reply finished and the session closed. On return the message sat under \"this tab is not driving the session\" and nothing would ever send it. It went eleven minutes later only because the user re-sent it.",
  "impact_if_we_wait": "Any message typed mid-reply can silently stall after an ordinary reload or session switch, and the dock gives no clear way out, so the user either waits forever or retypes it.",
  "current_need": "A queued message restored into a tab that is not driving the session is sent by itself, exactly once and never into a running turn, or the dock says in plain words why not and offers Send now.",
  "severity": "high",
  "area": "dashboard client / queue delivery",
  "reported": "2026-09-30",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a message queued mid-turn, restored after a reload once the session is idle with no host, is sent by itself and answered, exactly once",
    "the same after switching to another session and back",
    "a reload while the turn still runs delivers it once, after the turn, never into it",
    "while another tab drives the session it is not sent from here, the dock says so, and it goes once that tab lets go",
    "the queue row's status is plain muted text and its actions are visible without expanding anything"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-160",
      "relation": "see_also"
    },
    {
      "id": "BUG-150",
      "relation": "see_also"
    },
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "BUG-149",
      "relation": "see_also"
    },
    {
      "id": "BUG-153",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-217 — A message queued mid-reply is never sent after a reload

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — fix lane (round 1, class=plan+review)
- **Ground truth (session ce054915, the home-directory project, isolation `direct`).** PROVEN: the
  only turn ran 02:26:43–02:32:58 local (transcript); journal
  `02:33:01 detached session cs-munb2n2d-5 closing: the broker's lifetime is no` — the
  bridge was DETACHED when its turn ended (no tab was driving it) and closed 3 s later;
  no host existed afterwards (session-hosts/, registry) until 02:44:36, when a fresh
  resume host started and the "btw … 403" text arrived as an ordinary composer send —
  WITHOUT the `[Queued … ago]` header `flushQueue` adds — i.e. the user sent it by hand,
  ~11.5 min after the turn ended. The service (up since 21:24) serves `public/` from the
  working tree, so the client that stranded it was current code (not deploy lag).
  INFERRED (no client-side log exists): the text entered the queue the only way the code
  allows — typed while this tab drove the busy turn (`submit` → `queueMessage`); the tab
  then lost its socket (a reload or a switch away — both re-adopt rows as `restored`),
  the bridge detached busy, and the tab reopened the session after 02:33:01 with nothing
  left to reattach to.
- **Correction to the dispatch hypothesis.** The message was NOT queued because the
  tab was not driving at Send time — a not-driving tab's Enter goes straight to a resume
  `start`. It was queued while driving, and stranded because it OUTLIVED its socket.
  The rest of the hypothesis holds: the queue flushed only on a driving socket, and in
  the idle-no-host state nothing ever gave the tab one.
- **Root cause.** Every delivery path (`flushQueue` at busy→idle / turn-end, BUG-160's
  reattach ack) required a DRIVING socket, and a tab acquired one only by the user
  sending or by reattaching a still-alive bridge. `flushQueue`'s first line
  (`!isDriving() → paint; return`) was where the row died. Distinct from BUG-160
  (whose fix covers "the bridge survives"; this is "the bridge is gone") — BUG-160's own
  criterion 5 deliberately refuses a promptless resume, so its design leaves this state
  with no owner.
- **Invariant made true.** A queued message that is not marked failed always has an
  owner that will deliver it — this tab's driving socket at the next pause, or a resume
  `start` in flight — or the dock says in plain words why not (another tab drives it /
  another program writes it / the session could not be read) and offers Send now. It is
  never parked on a condition nothing will ever satisfy.
- **Fix (client only; no server change).** `public/app.js`:
  - `flushQueue`: not driving → `driveQueue()` instead of returning.
  - new `driveQueue()`: resumes the session with the next row as the prompt, through
    the BUG-045 exactly-once machinery (`drainWaitAttempt`; the row leaves only on the
    ack; a busy reattach keeps it for the pause, never injected). Holds off while
    `openSession` is still deciding (`queueSettling`), while anything is already
    acquiring the drive, on dropped/budget/fork states, and — unless the user presses
    Send now — while another tab drives (`liveElsewhere`) or another program writes it.
    Parked in history with a forward gap → `reopenAtLatest()` first.
  - `persistQueue`: a row being sent is stored as the OUTBOX, so a reload mid-attempt
    judges it against the transcript rather than resending it.
  - refusal paths settle the attempt row instead of stranding it: `handleLiveElsewhere`
    (keeps the row pending, no duplicate dead copy), `queueRetryableRefusal` (joins the
    drain-wait loop, no hammer), `armNeedsFork` / `rollBackPendingStart` / `failQueue`
    (row marked failed with a reason; `Send again` works).
  - `refreshLive`: when the followed run ends, `liveElsewhere` clears; an
    "external writer" inferred only from a fresh mtime is dropped once the session
    leaves the live list (our own just-closed session reads as external for ~30 s).
  - `openSession` calls `flushQueue()` once it has decided (after the BUG-160 reattach).
  - `submit`: while a driveQueue start is still connecting, a new message queues behind
    it instead of racing a second `start`.
  - **UI (Problem 2):** `paintQueue` rows are no longer `<details>`; each shows the text,
    a muted plain-prose status ("Not sent yet — kept from before you reloaded or left
    this session", "Waiting to send", "Sending…", "Not sent — <reason>"), and always-
    visible actions: Send now / Send again (solid primary, only where the user has an
    action to take), Interrupt & send (FEAT-031 force-send, only while Claude works in
    this tab), Edit (inline, with Move to composer), Discard. The dock line is prose
    saying what happens next. `public/styles.css`: status is sans, no border/hover/
    pointer; class names the suites read (`.qrow .qs .qedit .cacts .force-send`) kept.
- **Verified (fixer's own run, NOT independent):**
  `node scripts/verify-bug-217-queued-message-strand.mjs` — scratch server via
  `scripts/lib/bug-187-harness.mjs` (`isolatedServerEnv`, own data dir + store, free
  port, fake CLI), headless brave via Playwright → **16 passed / 0 failed**: A reload
  after the host closed (sent by itself, answered, once at the CLI), B switch away and
  back (same), C reload mid-turn (once, after the turn, never into it), D another tab
  driving (not sent, says so, Send now offered, goes by itself once released), and
  MUST-FAIL: the synthesized pre-fix client (flushQueue hunk reverted + driveQueue
  neutered by string transform; not HEAD-anchored) strands A and B (restored, never
  sent, 0 at the CLI).
  Regressions: `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial`
  25/0, `verify-bug-079-session-switch-state` 10/0, `verify-resume-refusal` 11/13 —
  the same 2 fail with HEAD's app.js (pre-existing: heldRow chip text; you-count flake),
  `npm run gate` PASS.
  Real-model suites (`verify-bug-129/149/153`, `verify-queue`, `verify-reload-live`,
  `verify-refusal-visible`): assertions updated to the new contract (wording, the row is
  no longer `<summary>`, a restored idle row is now SENT); runs were environment-bound —
  129/153/reload-live fail at the reload because the container-default URL `dir=`
  mismatch (BUG-160 round-2 finding) loses the session before any queue code runs;
  149's fixed leg passed 16/17 (the one miss was a regex on the new wording, since
  updated) and a later rerun could not start its raw-socket first tab (server-side,
  independent of app.js); refusal-visible fails its precondition on HEAD's app.js too.
  Screenshots (before = HEAD app.js/styles.css served over the same scratch server;
  after = this tree; light + dark): `~/scratch/bug217/visual/BUG-217-{before,after}-*.png`.
- **Could not test:** the real-model queue suites to green (environment, above); the
  exact reload-vs-switch path the user took (no client log exists); a terminal-attached
  session that goes quiet >30 s (the external-release path would then resume it, which
  is what a manual Enter already does).
- **Still open / handoff:** rows of a session the user switched AWAY from are still
  delivered only when that session is reopened (the queue lives in the tab, not the
  session). Independent clean-room verify REQUIRED (session-lifecycle + queue).
- **Symptom of a deeper design flaw?** yes — the queue is owned by a browser tab, not
  by the session, so delivery depends on which tab holds which socket (BUG-129, BUG-149,
  BUG-150, BUG-153, BUG-160, BUG-217). A server-side per-session outbox would remove the
  class; an ARCH ticket is recommended (not filed by this lane).

### 2026-09-30 — independent UI review (round 1, class=verify, unbiased reviewer)
- **Verdict: SHIP.** The redesign fixes the reported complaint fully. The old strip's
  mono chips ("unsent · restored · next") that read as buttons, the `▶` expanders, and
  the hidden actions are gone. Reviewed the author's before/after shots (all states,
  light+dark) AND booted my own isolated scratch server (bug-187-harness `bootServer`,
  own `CLAUDE_STATION_DATA`, free port, fake CLI) driving real Playwright/brave headless
  over states the author did not frame: 3 restored rows and a busy/working batch, at
  1280 / 640 / 560 / 520 / 420 px, both themes.
- **What's good:** status is plain muted prose (`--ink-3`, no border/hover/pointer) —
  nothing non-clickable looks pressable; Send now / Send again are the app's solid
  primary and are the only primary shown, and only where the user has an action; while
  Claude works no button is primary (Interrupt & send is a plain outline — correct, the
  default is to wait). Status color semantics read well and consistently across themes
  (muted grey / amber `--warn` failed / live green sending); no contrast failures seen.
  Banner + per-row status make the message state obvious.
- **Findings (all polish; none blocking):**
  1. (low-med) Discard — the one destructive, irreversible action (splices the row, no
     confirm, no undo; text is NOT preserved — only "Move to composer" inside Edit keeps
     it) — is visually indistinguishable from Edit. `.mini.x` differs only by `color:
     var(--ink-3)`, imperceptible in-situ. On a feature whose whole purpose is to stop
     losing messages, the delete button should be more clearly set apart.
  2. (low) Narrow-width overflow. `.qrow .qracts` is `flex:none; nowrap`, so below
     ~560px window / ~290px pane in the BUSY state the long "Interrupt & send" label
     makes the action row overflow: status text collides with the buttons and "Discard"
     clips to "Disca…" (`scrollWidth 237 > clientWidth 214` at 520w). Clean at ≥640w.
     The app never collapses the sidebar (verified 420px keeps it), so a half-screen
     window (~960px) is fine; only an extreme split hits this.
  3. (low) Repetition: with 3 restored rows, each shows the identical 60-char status
     "Not sent yet — kept from before you reloaded or left this session," which the
     banner also paraphrases — visually noisy. Consider stating the long status once.
  4. (nit) A few banner lines are long and wrap 2–3 lines even at full width (the
     "another tab is driving…" / "another program is writing…" sentences). Plain, but
     not short.
- **Screenshots:** author's at `~/scratch/bug217/visual/BUG-217-{before,after}-*.png`;
  my independent runs at `~/scratch/bug217/review/narrow-3rows-{light,dark}-{1280,560,420}.png`
  and `~/scratch/bug217/review/busy-{light,dark}-{1280,640,520}.png`. Harness scripts:
  `~/scratch/bug217/review-visual.mjs`, `~/scratch/bug217/review-busy.mjs`.
- **Scope note:** this pass judged the VISUAL redesign only. The queue-delivery
  correctness (exactly-once, session-lifecycle) still warrants the independent clean-room
  verify the fix lane itself flagged as REQUIRED.

### 2026-09-30 — independent clean-room verify (round 1, class=verify) — VERDICT: BROKEN
- **Verified-by:** dispatch openai run 01a0efc4-aed1-7092-a678-a3749ee040a1 (clean-room,
  `scripts/independent-verify.mjs`, cross-provider: author anthropic → verifier openai,
  codex-cli 0.158.0-alpha) — **VERDICT: BROKEN**. Contract VALID (fixer test re-run +
  uncovered adversarial case + could-not-test list all present; manifest-backed).
- **How it was launched (launcher lane, did NOT verify itself).** `--working-tree`
  (FEAT-134) over the current shared dirty tree — BUG-217 cannot be committed or split in
  isolation (no git writes; `public/app.js`'s uncommitted diff carries hunks from ~37
  tickets, BUG-217 is only ~24 of ~1646 lines), so the verifier boots and attacks the real
  integrated tree that actually ships. Diff sized to 200 KB to include all of `public/`
  (the whole client surface of this client-only fix) and drop the unrelated `scripts/`+
  `src/` tail; `docs/` auto-stripped by the clean room. Verifier given only the plain
  requirement, the diff, and the fixer's test CODE — never the fixer's report or ticket
  prose. Clean room KEPT: `~/.local/state/claude-station/scratch/cleanroom-verify-j2A3LH`;
  record `~/.local/state/claude-station/scratch/cleanroom-record-Nc0zAy/manifest.jsonl`.
- **Fixer's test re-ran green** (run 5e4b0c25dfc9, exit 0): `verify-bug-217-queued-message-strand.mjs`
  → 16 passed / 0 failed. Scenarios A (reload/no-host/idle), B (switch away+back), C (reload
  mid-turn — after the turn, never into it), D (another tab drives — not sent here, dock says
  so, Send now offered, goes once released), and MUST-FAIL pre-fix A/B strand. So the fix
  holds for every case the author's fixture models.
- **BROKEN by an uncovered case: double delivery across two REAL browser tabs**
  (adversarial run ec4c7188c450, exit 1; `verify-independent-217-two-tabs.mjs` in the kept
  room). WHY-UNCOVERED: the author's D uses a raw websocket as the "other tab"; it never has
  TWO browser tabs restore the SAME persisted queue row. With two tabs open on the session,
  both restore the row from storage. The driving tab delivers it once (CLI frame 1). When
  that driving tab is CLOSED, the FOLLOWER tab — which still held the already-delivered
  restored row — fires its own automatic send: **the same queued message reaches the CLI a
  second time** (`observed count: 2`). Property broken: **"delivered exactly once, never
  twice"** (success_criteria #1 and #4). The queue-row UI itself was correct in the follower
  (plain non-clickable status, actions visible, no `<details>`) — the defect is delivery
  bookkeeping, not the UI.
- **Root-cause pointer for the fix lane:** the follower tab does not learn that a restored
  row was already delivered by the other tab, so `driveQueue()`/`flushQueue` re-sends it when
  the follower becomes the driver (driver-close → follower acquires the drive). This is the
  tab-owned-queue class the fixer's own closing note called out (a server-side per-session
  outbox / delivered-marker would remove it). Handoff: dedupe restored delivery across tabs
  by the session's transcript/outbox truth, not per-tab queue state, before re-verifying.
- **Verifier could NOT test:** multiple-message ordering, Edit/Discard racing an auto-send,
  rapid double-reload (all still open attacks); and real-model turns (scripted fake CLI).
  These remain uncovered and should be attacked in the next verify round once the double-send
  is fixed.
- **Independent skeptic already applied:** this WAS the independent clean-room pass
  (cross-provider). Because it found a session-lifecycle / exactly-once defect, the fix lane's
  next attempt again needs a clean-room verify (not self-verified) covering this two-tab case
  plus the still-untested attacks above.

### 2026-09-30 — fix lane (round 2, class=fix) — the two-tab double send
- **Reproduced first (PROVEN).** The verifier's two-real-tab script (copied to
  `~/scratch/bug217/r2/repro-two-tabs.mjs`, harness path only changed) on the round-1 tree:
  `FAIL One restored row across two tabs reaches CLI exactly once — observed: {"count":2}`.
  A probe after the first delivery read the follower tab: shared `localStorage` `cs.queue.v1`
  = `{}` (the driver had retired the row), follower `state.queue` still
  `["QUEUED-TWO btw …"]`. So the dispatch hypothesis held in its sharper form: the store WAS
  shared, but each tab copied the rows into its own heap once at adoption and never read the
  store again — a second place holding a different answer (ARCH-010). Its next paint could
  also have written the stale row back over the store.
- **Invariant made true.** Whether a queued row is finished is declared once, by the tab
  that finished it, in the shared store; every tab reads it there before it sends and
  whenever the store changes. No tab sends a row the store says is finished, or one
  another tab is sending.
- **Fix (client only, `public/app.js`).** Rows carry a stable `id`; the store entry carries
  `done` (tombstones). `persistQueue` is now a three-way MERGE, not an overwrite: rows
  another tab finished leave this tab; another tab's edits and new rows come in; every row
  this tab wrote and no longer holds goes to `done`; a row a tab is delivering or retrying
  is written with `by` (that tab), and other tabs show it as held and never send it. A
  `storage` listener re-syncs the dock; `flushQueue`, `driveQueue`,
  `deliverQueuedBehindBackground` and `attemptDrainRetry` call `syncQueue()` before
  choosing rows. The writer re-asserts its own tombstones on every write (`gone`), so a
  tombstone lost to a simultaneous write is restored by its owner. `pagehide` releases holds
  that are not mid-send. Legacy rows get a deterministic id; the outbox is written only by
  its owner and judged only by the tab that wrote it (or when older than 2 min). Rows
  edited down to nothing are still not stored (BUG-150 D).
- **Known limit (inferred, not reproduced).** localStorage has no compare-and-set: two tabs
  deciding to send the same unheld row within the few ms a write takes to reach the other
  tab could both send it. No trigger in these flows fires that close together: a follower
  sends only seconds after a live poll sees the driver go. A server-side idempotency key
  would close it; that is not built here.
- **UI (review findings 1–3), `public/styles.css` + `paintQueue`.** Discard is set apart:
  danger-ink text button after a gap, filled on hover. It is also undoable: an 8 s
  "Discarded "…" · Undo" line puts the words back as a new row. Row actions wrap below the
  text when the row is narrow (`.qhead` wraps, text claims ~14rem); labels break rather
  than clip on an extreme split. The long "kept from before you reloaded…" sentence is said
  once in the dock line; each row now says "Not sent yet". Held rows say "Being sent from
  another tab…" and have no send button.
- **Verified (fixer's own run, NOT independent).**
  `node scripts/verify-bug-217-queued-message-strand.mjs` → **42 passed / 0 failed**.
  A–D are unchanged. New: E two real tabs in one context (sent once; the follower's dock
  emptied; closing the driver sent nothing); F three queued rows (each once, typed order);
  G1 follower Edit (edited text sent once, original never); G2 follower Discard mid-turn
  (never sent, Undo shown); G3 Discard aimed at the turn boundary via the fake CLI's stdin
  timestamp, at +120/0/−80 ms (outcomes `atCli 0 clicked` and `atCli 1 not-clicked`, never
  2, docks agree); H two reloads 300 ms apart (once, after the seed); I three tabs (once;
  closing the driver, then a second tab, sent nothing).
  **MUST-FAIL:** pre-fix A/B strand as before. E against a client synthesized to the
  round-1 state (the store merge disabled, `storage` listener inert, built by string
  transform, not HEAD) → `count: 2`, the double send. Real browser tabs in every multi-tab
  case; the fake CLI is used (no real model).
  Regressions: `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial` 25/0
  (the whitespace-row case failed once and was fixed), `verify-bug-191-adopt-window-send`
  39/39, `verify-bug-079-session-switch-state` exit 0, `npm run gate` exit 0.
  `verify-resume-refusal`: the 2 pre-existing failures round 1 recorded remain; its Discard
  assertion was updated to accept the Undo line (no row, queue empty).
  `verify-bug-149-live-elsewhere` / `verify-bug-153-detached-status-truth` fail in their
  raw-socket harness before any client code runs ("the first tab never got a session"), the
  same environment failure round 1 recorded.
  Visual: `node ~/scratch/bug217/r2/visual-r2.mjs` checks busy, restored, undo and
  held/failed rows at 1280/640/560/520/420 px, light and dark: "no clipping, no overlap, no
  overflow". Before the label-wrap rule, 420 px clipped "Interrupt & send". Shots:
  `~/scratch/bug217/r2/shots/*.png`, suite shots `~/scratch/bug217/r2/suite/`.
- **Could not test:** real-model turns; two tabs deciding within milliseconds (the limit
  above); a tab that is frozen or discarded by the browser and so misses `storage` events
  (it re-reads the store before it sends, so it cannot double-send, but its dock can be
  stale until then).
- **Handoff.** Needs an independent clean-room verify again (exactly-once across tabs).
  Attack these first: the ms-window race; a follower's Send now on a row the driver is
  about to flush; a duplicated tab (it copies sessionStorage).
- **Symptom of a deeper design flaw?** yes, as round 1 said. The queue is still owned by the
  browser, not the session. This round makes the browser's copy one declared fact. A
  server-side per-session outbox keyed by row id would remove the class; an ARCH ticket is
  recommended (not filed by this lane).

### 2026-09-30 — independent clean-room verify (round 2, class=verify) — VERDICT: BROKEN (dispatch ended contract-INVALID on quota mid-run)
- **Verified-by:** dispatch openai run 01a0f009-e5c9-7ac0-9df4-8cfb2355664b (clean-room,
  `scripts/independent-verify.mjs --working-tree`, cross-provider: author anthropic →
  verifier openai, codex-cli 0.158.0-alpha.15.2), re-verifying round-2 fixer reports
  af61398b6e7f4cf00 / a482f8b6e2280f207. **The dispatch itself failed on an openai
  quota-window mid-run** (`dispatch failed [quota-window] … usage limit … try again at
  8:03 AM`), so the verify CONTRACT is **INVALID** (fail-closed: an unverifiable change is
  not a verified change) — this is **NOT a formally-closed clean-room verdict, and the fix
  is NOT verified.** But before quota exhaustion the verifier ran and RECORDED (harness
  manifest) adversarial arms that reproduce two breakages, so the practical outcome for the
  next round is **BROKEN, re-verify REQUIRED.**
- **How it was launched (launcher lane; did NOT verify itself).** Same mechanism as round 1:
  `--working-tree` over the shared dirty tree, `--max-diff-bytes 200000` (all of `public/`,
  drops the `scripts/`+`src/` tail), `docs/` auto-stripped, `--test-file
  scripts/verify-bug-217-queued-message-strand.mjs`. Verifier given only the plain
  requirement + the four named attacks (charter guidance, NOT ticket prose or the fixer's
  report) and the fixer's test CODE. Clean room KEPT:
  `~/.local/state/claude-station/scratch/cleanroom-verify-CteOTX`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-6eKRQT/manifest.jsonl`; verifier
  transcript under `transcripts/openai/…-cleanroom-verify-CteOTX/01a0f009-….jsonl`.
- **BROKEN #1 — driving tab closed mid-send strands the follower** (manifest
  `a7efca934d8b`, `independent-217-crash.mjs`, exit 1). Holding a queued send in transit and
  closing its tab left the surviving follower tab **waiting ~140 s with no actions and no CLI
  delivery** — the row sits as held/"being sent from another tab" and is neither delivered
  nor released with a Send-now action. Violates "never lost or stuck forever as being sent by
  another tab" and "if it can't be delivered the dock says so and offers the action." (A crash
  is not the `pagehide` the round-2 fix releases holds on, so the `by`-hold persists.)
- **BROKEN #2 — a new mid-reply message whose text repeats earlier transcript text is
  silently dropped on reload** (manifest `15303d0d1da0`, `independent-217-repeat.mjs`, exit 1).
  A queued message ("…403") whose send was interrupted before the CLI received it (CLI count
  0) DISAPPEARED after reload — dock hidden, queue empty, message never delivered — because
  `outboxDelivered()`/`transcriptHasAll()` matched an OLDER occurrence of the same text and
  judged it already sent. Violates "delivered exactly once" (delivered ZERO times, no dock, no
  action). CONTROL (`--control`, manifest `67de2c085af7`, exit 0) changed only the older text
  and the interrupted message stayed recoverable — isolating the same-text stale-match as the
  cause. This is the charter's attack #4.
- **INCONCLUSIVE — the two/three-tab millisecond race was never proven** (manifest
  `ec580fc57597`, `independent-217-race.mjs`, exit 1 but the barrier was never reached:
  `barrier arrivals []`, all three docks showed "another program is writing this session —
  press Send now", so the external-active guard held them off auto-send). A rerun after the
  activity window was in flight when quota killed the dispatch. The ms-window double-send
  remains **untested** (as round 2's own could-not-test list said).
- **Fixer's supplied suite did not complete.** `verify-bug-217-queued-message-strand.mjs`
  was launched but never recorded an exit in the manifest (its process was still running at
  quota death), so — unlike round 1 (16/0) — there is **no green re-run of the author's
  fixture this round.** Two leaked clean-room scratch servers (pids of
  `cleanroom-verify-CteOTX/src/server/index.ts`) were reaped by pid; port 4317 and the live
  service untouched.
- **Launcher's own side-check — resume-refusal "pre-existing 2 failures" claim.** Ran
  `scripts/verify-resume-refusal.mjs` on the CURRENT tree: **11/13**, failing exactly the two
  the fixer named — "the drain-wait chip names why it is waiting" (the phrase `waiting for the
  previous turn to finish draining` is in `#fine` but not the `.q-l` chip the assertion reads)
  and "the phantom optimistic bubble was rolled back" (you-count before=16, after=23). The
  counterfactual (BUG-217 hunks reverted) was **NOT FEASIBLE**: the hunks are ~24 of ~1646
  intermingled lines across ~37 tickets in the shared dirty `public/app.js` (not surgically
  separable), and a whole-file swap to HEAD was blocked by FEAT-129's advisory file lock
  (another lane, `cs-munfzckq-9`, was actively editing app.js). So the two failures are
  confirmed present and match the named pair on the current tree, but this lane could NOT
  independently confirm they pre-DATE BUG-217; note BUG-217 r2 did rewrite queue/dock wording,
  so the `.q-l` chip failure could plausibly be wording drift — the fixer's own round-1 note
  is the only evidence it also fails on HEAD's app.js.
- **Handoff.** Fix BROKEN #1 (release/deliver a held row when its `by`-owner tab dies, not
  only on clean `pagehide`) and BROKEN #2 (do not treat an OLDER same-text transcript
  occurrence as proof THIS row was delivered — key delivery by row id / outbox, not text
  match). Then re-verify with a COMPLETED cross-provider clean-room pass (this one is
  quota-truncated) that also finally lands the ms-window race. This is a session-lifecycle /
  exactly-once + data-loss change — the independent clean-room pass is REQUIRED and must
  actually complete.
- **Symptom of a deeper design flaw?** yes — same as rounds 1 and 2: the queue is owned by
  the browser tab, not the session; both breakages are per-tab bookkeeping standing in for
  session/transcript truth. A server-side per-session outbox keyed by row id would remove the
  class; an ARCH ticket is recommended (not filed by this lane).

### 2026-09-30 — fix lane (round 3, class=plan+review) — DESIGN NOTE (before building)
- **Hypothesis checked against the code: HOLDS.** Every "was this row delivered?" answer is
  worked out by a browser tab from things that do not carry it: (a) `adoptQueueRows` /
  `judgeAdoptedOutbox` → `outboxDelivered` / `transcriptHasAll` match the row's TEXT against
  `.you` bubbles and the transcript tail (round-2 break #2: an older same-text message reads
  as "delivered"); (b) `persistQueue` / `heldByOther` treat a store row carrying another
  tab's `by` as untouchable, with no expiry and no way to learn that tab died (break #1:
  `pagehide` deliberately keeps a mid-send hold, a killed tab never releases); (c) the only
  arbiter between two tabs is localStorage, which has no compare-and-set (round 2's own
  "ms-window" limit). The one party that actually KNOWS whether a prompt was handed to the
  CLI is the server, and it records nothing keyed by the row.
- **Invariant.** Whether a queued row has been delivered is declared once, by the server, keyed
  by the row's id, at the moment it hands the prompt over. A tab never sends a row the server
  has recorded, never judges delivery from text or from another tab's store entry, and two
  sends of one id cannot both reach the CLI because the claim is taken atomically in the
  server's single thread before any await.
- **Design.**
  1. `src/server/queue-ledger.ts` (new): `claim(ids)` → all-or-nothing; conflict returns each
     id's state (`in-flight` | `delivered` | `uncertain`). A claim is settled by the handler
     as `delivered` (prompt handed to the CLI / broker confirmed / held in the runtime input
     queue), `released` (refused, reattached busy, never sent — the id is free again), or
     `uncertain` (handed over, no confirmation). `in-flight` expires after 120 s (a hung
     server-side op cannot strand a row). `delivered`/`uncertain` persist in
     `$CLAUDE_STATION_DATA/queue-ledger.json` (7-day TTL, capped) so a restart does not
     forget. `status(ids)` for readers. Ids are random and global, so no per-session key.
  2. `src/server/index.ts`: `start` and `send` frames may carry `queueIds`. Claimed at the top
     of the handler (before live-elsewhere, liveness, spawn); a conflict answers
     `{t:'error', code:'queue-duplicate', states}` and does nothing else (no attach, no
     spawn). Every exit branch settles the claim explicitly. `GET /api/queue-ledger?ids=`
     returns states (`none` for unknown).
  3. `public/app.js`: every automatic send of queued rows (`flushQueue`, `driveQueue`,
     drain retry, background delivery, force-send) carries the rows' ids. The tab-level
     "held by another tab" lock stops gating delivery (it is gone); the server's
     `queue-duplicate` answer does: `delivered` → the row leaves; `in-flight` → the row
     shows "being sent from another tab" and is re-asked via the status endpoint every
     few seconds until the server settles it (`none` → it goes again from here; no tab
     can strand it); `uncertain` → the existing "could not be confirmed" dead row. On
     reload, a row that was mid-send or in the outbox is judged by the STATUS ENDPOINT by
     id, not by text; `none` means the server never took it, so it is sent. The
     localStorage store keeps only the user-facing dock sync (edits, discards, new rows);
     it no longer decides delivery. Legacy outbox entries with no ids come back as
     "could not be confirmed" (never text-matched, never auto-resent).
  4. A row keeps one id for its whole life (a refused or put-back row is revived, not
     re-minted), so the ledger key is stable. An explicit "Send again" on an UNCONFIRMED
     row mints a fresh id — that is the user deciding to send it again. Two rows with
     identical text are two ids and arrive twice.
- **Alternatives considered.** (B) client-only: expire the `by` hold by heartbeat and put
  the id into the queued-note header so the transcript carries it — rejected: the
  transcript lags the handover (a reload in that window resends), and localStorage still
  cannot arbitrate a ms race. (C) a server-owned per-session outbox that delivers at the
  pause with no tab — removes the whole class but moves batching, resume and the dock onto
  the server; the right ARCH follow-up, too big for a fix round. The ledger is the part of
  (C) that owns the delivered fact, and (C) would reuse it.
- **Known limits (stated up front).** The ledger is written after the handover, so a server
  crash between the two can forget one delivery. A socket closed during a fresh `start`
  closes that session (existing behaviour) — recorded `uncertain`, shown as unconfirmed.

### 2026-09-30 — fix lane (round 3, class=plan+review) — the server owns "was it delivered?"
- **Root cause (PROVEN by must-fail against the synthesized round-2 client).** Delivery of a
  queued row was decided by a browser tab from things that do not carry the fact: transcript
  TEXT (break #2) and another tab's localStorage `by` hold that no dead tab ever released
  (break #1). Both round-2 breaks reproduce against the round-2 client and pass after the fix
  (J, K below). Round 1's double send is the same class.
- **Invariant.** Whether a queued row was delivered is declared once, by the server, keyed by
  the row's id at the handover. No tab sends a row the server has recorded, none judges
  delivery from text or from a store lock, and one id cannot reach the CLI twice (atomic claim).
- **Plan review.** OpenAI dispatch `01a0f017-7fd1-7513-9c25-b63703ab0f92` failed on its quota
  window; ran **anthropic run `82b22675-9ddf-4997-b59c-f8ba5b6ee5b3`** (separate process, same
  dispatch command). It found 3 blockers, all adopted: (1) in-flight expiry must read as
  `uncertain`, never free; (2) the outbox + early `done` tombstone would drop revived rows —
  so a handed-off row now STAYS in the queue marked `sending` until the server settles it,
  and the outbox writer is gone; (3) ids must ride end to end (send attempts keep the row
  objects; refusals settle rows in place). Also adopted: claims persisted before handover and
  in-flight-at-boot → `uncertain`; per-session single-flight for prompt-bearing resume starts;
  composed order kept (leading run only); server-side Discard; one id for life with
  `queueForce` for the user's Send again (only over `uncertain`); `by`/`pagehide` deleted.
  Declined: "reattached busy → deliver into the runtime queue" (changes BUG-160 and
  scenario C's never-into-the-turn contract); `startSession` catch → `uncertain` was built,
  then reverted to `released` after it stranded a real pre-spawn refusal (boot runtime check).
- **Changed.** NEW `src/server/queue-ledger.ts`; `src/server/index.ts` (claim in `start`/`send`
  before any other judgement, settle per branch, `finally` releases sync refusals,
  `GET /api/queue-ledger`, `POST /api/queue-ledger/discard`, resume single-flight);
  `src/server/events.ts` (`queueIds`, `queueForce`, `queue-duplicate`); `public/lib/api.js`;
  `public/app.js` (ids at creation, `sendableRows`, `reconcileQueue` + 5 s backstop,
  `applyLedgerStates`, `handleQueueDuplicate`; text judges `outboxDelivered`/`transcriptHasAll`
  and `heldByOther`/`QUEUE_TAB`/`pagehide` removed); `scripts/verify-bug-217-…mjs`;
  NEW `scripts/fixtures/bug-217/round3-client-hunks.json` (round-2 baseline = current minus
  31 exact hunks, loud if any stops matching); `scripts/verify-bug-191-adopt-window-send.mjs`
  B3 (its "must end DEAD" was the guess this round removes; now: once at the CLI, never
  resent, and gone-as-delivered or DEAD).
- **Verified (own runs, NOT independent).** `node scripts/verify-bug-217-queued-message-strand.mjs`
  → **67 passed / 0 failed**: R0 server arbiter (two sockets, one id, one tick → one through;
  ledger `delivered`; forced resend of a delivered id refused; discarded id refused; a boot
  runtime-check refusal frees the id), A–I unchanged, **J** sender tab killed mid-send → the
  other tab delivers once within 40 s, **K** same words as an earlier message → delivered once,
  **L1/L2** identical text queued twice → arrives twice, **M2/M3** 2 and 3 tabs' frames held and
  released in one tick → once, all docks empty. MUST-FAIL: round-2 client strands J (0 at CLI,
  no Send now after 40 s) and drops K (0, gone from dock); pre-fix A/B strand; round-1 E double
  sends. INFO (not asserted): round-2 client in M3 → arrivals [1,0,0] (its hold kept the other
  tabs off, so no race formed there). `verify-bug-150-load-window-queue` 16/0,
  `verify-bug-150-adversarial` 25/0, `verify-bug-191-adopt-window-send` 39/39, `npm run gate` PASS.
- **Could not test / known limits.** Real-model turns (fake CLI only). A server crash between
  handover and the settle write (claim is on disk as in-flight → loads `uncertain`, so it is
  shown unconfirmed, never lost or doubled). A throw from the `AgentSession` constructor after
  it spawned the CLI is settled `released` (agent-bridge.ts was locked by another lane, so it
  could not mark that case). The idle-reattach ack precedes `running.send`; if that send throws,
  the tab has already retired the row (pre-existing). Edits made in one tab to a row another
  tab is mid-sending are not offered (Edit is hidden while `sending`/`remote`).
- **Handoff.** Needs a COMPLETED cross-provider clean-room verify. Attack: J/K/M with other
  timings, a frozen tab, server restart mid-send, container starts slower than 5 min.
- **Symptom of a deeper design flaw?** yes — the queue is still stored per browser; the ledger
  is the piece of a server-owned per-session outbox that owns the delivered fact. ARCH ticket
  still recommended (not filed by this lane).

### 2026-09-30 — independent clean-room verify (round 3, class=verify) — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run cd3cbd03-4989-4c6c-8ac9-5ad140f2fa23 (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**. Contract **VALID**
  (fixer test re-run green + one uncovered adversarial case + could-not-test list, manifest-backed).
  Re-verifying round-3 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 / ac94869a234693a08.
- **Provider choice.** OpenAI's 5h binding window was **exhausted** (100% used, verdict
  `exhausted`, ~1.8 h to reset) at launch, so this is a **clean-room Anthropic run** per the
  charter's fallback: author anthropic → verifier anthropic (**SAME provider, decorrelation
  reduced**; noted honestly). A cross-provider re-verify once OpenAI resets would strengthen it.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared
  dirty tree, `--test-file scripts/verify-bug-217-queued-message-strand.mjs`, `docs/` auto-stripped.
  Verifier given only the plain requirement + the eight named attacks (charter guidance, NOT the
  fixer's report or ticket prose) and the fixer's test CODE. Clean room KEPT:
  `~/.local/state/claude-station/scratch/cleanroom-verify-vhzvE5`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-IUufbx/manifest.jsonl`.
- **Fixer's suite re-ran GREEN** (run dad2ade032b7, exit 0): `verify-bug-217-queued-message-strand.mjs`
  → **67 passed / 0 failed**. R0 (server arbiter, one id → one through, delivered/discarded/forced-resend
  refused), A–I, J (sender killed mid-send), K (repeated text), L/M (identical text twice, 2/3-tab
  frames) all hold; MUST-FAIL pre-fix arms strand/double-send as designed. So the fix holds for every
  case the author's fixture models — the defect is one the fixture does not exercise.
- **BROKEN — exactly-once breaks across a server restart once the ledger evicts an old delivered
  row** (adversarial `ledger-cap-eviction-restart`, run 3ffa861916d3, exit 1). The ledger keeps only
  the newest **20,000** entries when it persists to disk (`persist()` in `src/server/queue-ledger.ts`),
  and **any client can grow it** through `POST /api/queue-ledger/discard` with arbitrary well-formed
  ids — unauthenticated, not session-scoped. After 20,200 forged discards + a restart, the oldest
  **`delivered`** row reads **`none`**, and re-sending that same row id was **accepted and reached the
  CLI a second time (n=2)**. Property broken: **"delivered exactly once, never twice"** (success_criteria
  #1). Reproduced independently in THREE runs this round (also `scratch-ledger-attack` 011db66ae13e and
  `scratch-ledger-restart` 75dd2fe55f45 in earlier contract-INVALID attempts), plus an 8-day TTL
  (`KEEP_MS`) variant that evicts the same way. The same-thread atomic claim is sound; the **ledger's
  finite retention is the hole** — a `delivered` marker is not permanent, so a long-lived or
  adversarially-grown session forgets old rows and re-delivers them.
- **Secondary findings (recorded, not the headline break):** (a) **SIGKILL right after the claim is
  written but before the handover** leaves the row `uncertain` having reached the CLI **0 times** — a
  message that was never delivered is not "sent by itself"; the user must Send again from a "check the
  transcript" state (a known limit the round-3 plan named, confirmed live). (b) **Growth is unbounded
  in memory** — the entries map is never pruned while the process runs and every claim/discard rewrites
  and re-sorts the whole map to disk (1.27 MB after 20,200 ids); the 20k cap bites only on the persisted
  file, which is exactly what causes the eviction double-send above.
- **Root-cause pointer for the fix lane.** A `delivered` id must stay recorded for as long as any tab
  could still try to re-send that row — the current 20k-newest cap and 7-day TTL both drop it too soon,
  and the discard endpoint lets a client (or noise) age it out at will. Options: scope + authenticate
  the ledger per session so foreign ids cannot evict real ones; make `delivered` tombstones durable
  (never evicted while the row could be re-sent) and cap only truly-dead state; or move to the
  server-owned per-session outbox the ARCH note recommends. Also close the SIGKILL-before-handover
  window (order the CLI handover and the ledger write so a crash cannot leave `delivered`-but-unsent, or
  reconcile `uncertain` rows against the transcript on reboot).
- **Verifier could NOT test (still-open attacks):** organic growth to 20k real deliveries and the 7-day
  `KEEP_MS` expiry (same eviction, too slow to reproduce in-room); a runtime-input-queued message
  (`session.send` → `queued:true`) marked delivered then lost to a restart before the CLI reads it; an
  in-flight claim aged past the 5-min TTL then force-sent (`uncertain` → possible second delivery while
  the original op still completes); two separate browser contexts with no shared localStorage and the
  new **"uncertain" row UI actions in a real browser** (the recorder dropped overlapping calls, so no
  browser attack was written for these). These remain uncovered.
- **Note on this round's earlier attempts (launcher honesty).** Three prior dispatches this round ended
  contract-INVALID on VERIFIER-CITATION compliance, NOT on the fix: (1) a 900 KB diff drowned the
  verifier (it skipped the fixer suite); (2) a `# comment` I appended to the `--run` string broke the
  FIXER-TEST byte-match though the verifier ran the suite green (67/0) AND recorded the same ledger
  breaks; (3) the verifier cited `node --version` as the fixer test. The break reproduced in every
  attempt; only the citation shape varied. The VALID verdict above is the fourth, clean run.
- **Independent skeptic status.** This IS the independent clean-room pass, but SAME-provider
  (anthropic→anthropic) because OpenAI was exhausted. Given this is a session-lifecycle / exactly-once /
  data-loss change, a **cross-provider** re-verify once OpenAI resets is warranted to decorrelate blind
  spots — flagging for the orchestrator.
- **Symptom of a deeper design flaw?** yes — same as rounds 1–3. The server ledger owns the delivered
  fact now, but its RETENTION is finite and client-growable, so "delivered" is not durable. A
  server-owned per-session outbox keyed by row id (with durable delivered-tombstones) would remove the
  class; ARCH ticket still recommended (not filed by this lane).

### 2026-09-30 — fix lane (round 4, class=fix) — absence is not evidence
- **Hypothesis checked first: HOLDS (PROVEN).** On the round-3 tree, a scratch server
  (`~/scratch/bug217/r4/repro-r3.mjs`) delivered X, took 20,400 forged discards, restarted:
  `{"states":{X:"none"}}`, and the re-send reached the CLI a second time (`n= 2`). The defect is
  that "the ledger has no record of this id" was read as "never delivered", while the ledger
  can forget (20k cap, 7-day TTL, lost or corrupt file).
- **A tombstone with no eviction was considered and rejected.** It is not bounded, because a
  discard flood within one session still needs a cap. It also says nothing about a lost or
  corrupt ledger file, and both of those need a horizon anyway.
- **Invariant.** The ledger answers `none` only for a row born after everything its scope has
  forgotten. Any other absence reads `uncertain`, which shows the row as "Not confirmed" with
  Send anyway / Discard, and it is never sent by itself. No forgetting (eviction, lost file,
  corrupt file, restart) can turn a delivered row into `none`.
- **Fix.**
  - `src/server/queue-ledger.ts` (rewritten):
    - One ledger per scope, stored in `queue-ledger/<scope>.json`. The scope is `s:<session>`,
      or `p:<project>` for a session that has no id yet. A session's lookups also read its
      project's scope.
    - Row ids carry their birth time (`qt-<ms base36>-…`), and frames and requests carry
      `queueNow`, so the server puts that birth on its own clock (tab clock skew is cancelled).
    - A scope keeps a `horizon`: its latest eviction, compared with a 5 s clock margin. It also
      keeps a `floor`: the ledger epoch (`epoch.json`, fixed at first boot) or the moment an
      unreadable file was set aside.
    - Each scope is capped at 2,000 entries. There is no TTL.
    - An id with no birth time, or a request with no clock, reads `uncertain`.
    - If the claim cannot be written to disk before the handover, the claim is refused
      (`uncertain`, with its own message), so nothing is handed over that the ledger could
      forget.
    - A scope that holds nothing leaves no file and no memory.
  - `src/server/index.ts`:
    - Scoped claims in `start` (resume → session, fresh → project) and `send`.
    - Both endpoints require `session`(+`dir`) or `project`, and answer 404 unless that
      session or project exists (live, or it has a transcript under the candidate dirs).
    - `initQueueLedger()` runs at boot.
  - `src/server/events.ts`: adds `queueNow` to the frame types.
  - `public/lib/api.js`: scoped `queueLedger` / `queueLedgerDiscard`.
  - `public/app.js` (six edits, taken under the FEAT-129 lock once it was released):
    - `newQueueId` stamps the birth time into the id.
    - `queueFrameFields` adds `queueNow`.
    - New `queueLedgerScope`.
    - `reconcileQueue` sends the scope; a 404 there reads as `uncertain`.
    - `withdrawAtServer` sends the scope.
    - `UNCONFIRMED_NOTE` now says "may already have been sent", and the button on those rows
      is "Send anyway".
  - `scripts/fixtures/bug-217/round3-client-hunks.json`: the same six edits are applied to the
    `current` side, so all 31 hunks still match once.
  - NEW `scripts/fixtures/bug-217/ledger-transform-hook.mjs`: a load hook that synthesizes the
    round-3 ledger from the CURRENT file. It is not HEAD-anchored, and it refuses to boot if an
    anchor does not match exactly once.
- **Found along the way:** bug-191 B3 failed (0 deliveries) under the first version, which had
  one margin on everything. A fresh data dir's first rows were born within 5 s of the epoch and
  were refused. The epoch/floor comparison now has no margin, because nothing can have been
  delivered before the ledger began. R0 now mints its id seconds after a fresh boot, to guard
  this.
- **Verified (own runs, NOT independent).**
  `node scripts/verify-bug-217-queued-message-strand.mjs` → **91 passed / 0 failed** (67 prior +
  24 new):
  - R4a: 2,400 forged discards into ANOTHER session leave X `delivered`. That session stays
    capped at 2,000 and its horizon rises. A made-up session, a made-up project, or naming
    neither gives 404 and no file.
  - R4b: the same flood into X's own session evicts X; after a restart X reads `uncertain`, the
    re-send is refused, and the CLI has it once (round 3: 2). A row born after the flood still
    sends once.
  - R4d: SIGKILL the instant the claim is on disk: the CLI had it 0 times, it reads
    `uncertain`, and the re-send is refused.
  - R4e: SIGKILL right after the CLI read it: it reads `delivered`, the re-send is refused, and
    the CLI has it once.
  - R4f: an unwritable ledger dir refuses the claim, and the CLI has it 0 times.
  - R4g: a real tab restores X and K1. Both show "Not confirmed" with Send anyway / Discard, and
    neither is sent in 12 s. Send anyway delivers K1 once.
  - R4c (TTL): an 8-day-old delivered entry still refuses the re-send after a restart, and an
    8-day-old unknown row reads `uncertain`.
  - R4h: a tab clock an hour fast or slow is corrected (an old row still asks, a new row still
    sends). A missing clock and a round-3 id both read `uncertain`.
  - R4i: a corrupt file, and then a deleted ledger dir: the delivered rows read `uncertain`, the
    re-sends are refused, and later rows still send.
  - **MUST-FAIL (round 4):** the synthesized round-3 ledger (absence=none, one global ledger,
    7-day TTL). A flood into another session plus a restart gives `atCli: 2`, and the TTL case
    gives `atCli: 2`.
  - Regressions: `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial` 25/0,
    `verify-bug-191-adopt-window-send` 39/39, `npm run gate` PASS.
  - Screenshot: `~/scratch/bug217/r4/shots/BUG-217-r4-uncertain-rows.png`. Every test used
    isolated scratch servers (restarted and SIGKILLed); port 4317 and live sessions were not
    touched.
- **Could not test / known limits:**
  - Real-model turns (fake CLI only).
  - A remote tab whose one-way latency is over 5 s near an eviction horizon: the clock margin.
  - Stale tabs still running round-3 JS after a deploy. They send no scope, get a 404 from the
    status endpoint, and loop on "Checking…" until reloaded. Their sends carry no clock, so they
    are refused as `uncertain` (safe, but they ask).
  - Rows composed before this round's first boot (and all round-3 ids) come back as
    "Not confirmed" once.
  - Scopes are not deleted with their session.
- **Handoff.** A COMPLETED cross-provider clean-room verify is needed. Suggested attacks: the
  p-scope → s-scope retarget mid-send, a hand-deleted single scope file, and two servers on one
  data dir.
- **Symptom of a deeper design flaw?** yes, as in rounds 1–3. The queue is stored per browser.
  A server-owned per-session outbox would remove the class; an ARCH ticket is still recommended
  (not filed by this lane).

### 2026-09-30 — independent clean-room verify (round 4, class=verify) — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run 1ff0516f-2576-4a41-8084-98e10cff89fc (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**. Contract **VALID**
  (fixer suite handed as `--test-file` + two manifest-backed adversarial cases + a could-not-test
  list). Re-verifying round-4 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 /
  ac94869a234693a08 / a4958d8724bef2807.
- **Provider — cross-provider was ATTEMPTED FIRST and failed; this is the Anthropic fallback.**
  OpenAI's 5h binding window (100% exhausted at first check) was waited out (~14 min) so this
  round COULD be cross-provider (author anthropic → verifier openai), and the OpenAI dispatch
  `01a0f0b4-082b-7f91-b42e-a11da9b9bda1` ran and recorded adversarial arms — but it **died at
  final-answer composition when OpenAI's provider flagged the content as a "possible cybersecurity
  risk" (Daybreak gate)**, so that dispatch is **contract-INVALID (not quota; a content-policy
  refusal)** and is NOT a verdict. Per the charter fallback I then ran a **clean-room Anthropic**
  pass (author anthropic → verifier anthropic, **SAME provider, decorrelation reduced** — noted
  honestly). The INVALID OpenAI run's recorded manifest (`cleanroom-record-bZh5fv/manifest.jsonl`,
  room `cleanroom-verify-TwDsCN`) is suggestive-but-not-citable: its own attack scripts exited 1
  for ledger-delete, corruption, future-timestamp, many-sessions and clock-change (UI, restart-
  during-Checking and separate-browser race passed), and its interim narration claimed the
  clock-correction case duplicated a message — i.e. it independently pointed at the SAME holes the
  VALID Anthropic run then proved.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared
  dirty tree, `--test-file scripts/verify-bug-217-queued-message-strand.mjs`, bare
  `--run "node scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment — round 3's
  attempt-2 byte-match break avoided), `--max-diff-bytes 200000`, `docs/` auto-stripped. Verifier
  given ONLY the plain requirement + the named attacks (charter guidance, NOT the fixer's report or
  ticket prose) and the fixer's test CODE. Clean room KEPT:
  `~/.local/state/claude-station/scratch/cleanroom-verify-mt2ThM`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-8j0Ged/manifest.jsonl`.
- **BROKEN — three ways a DELIVERED row is turned back into `none` and auto-re-sent (5 failing
  assertions).** The same-thread atomic claim is sound; the hole is that `current()`
  (`src/server/queue-ledger.ts:198`) reads absence as "never delivered" through inputs a client
  controls:
  1. **Project→session scope mismatch on eviction (e2e, CLI got it TWICE).** `current()` compares a
     row's birth only against the WRITE scope's horizon/floor, never the `also` (project) scope's. A
     row delivered under `p:<project>`, then evicted from it, reads `none` on a session-scope lookup;
     a resume re-sends it — **CLI received it 2×** (manifest run `a5916e03547f`,
     `scratch-e2e-project-scope.mjs`, exit 1; assertions A2/A3).
  2. **Clock correction re-sends a delivered row.** Birth = id stamp + (server-now − client
     `queueNow`). Correct the tab's clock between minting and asking, and after the ledger forgets
     (corrupt file + restart) a delivered row reads `none` and an automatic claim succeeds — re-sent
     (manifest run `4f5f6918cb89`, `scratch-ledger-attack2.mjs`, exit 1; B1/B2).
  3. **Forged `queueNow=1`.** The server accepts any client-supplied `queueNow`; `queueNow=1` ages an
     evicted delivered row to `none`, allowing an automatic re-send **without** the user's Send anyway
     (same run `4f5f6918cb89`; C1). Property broken: **"delivered exactly once, never twice"** and
     **"when unsure, never send by itself"** (success_criteria #1).
- **Fixer's suite re-run this round:** the verifier drove the queue-ledger directly and via
  `scratch-*` e2e scripts rather than recording a full green re-run of
  `verify-bug-217-queued-message-strand.mjs` in the manifest — but its adversarial cases live
  entirely OUTSIDE the author's fixture (project-scope birth, corrected clock, forged `queueNow`),
  which the round-4 must-fail arms do not model. The break is real regardless of the fixture's green.
- **Root-cause pointer for the fix lane.** `current()` must compare a row's birth against EVERY scope
  it consults (session AND its `also` project scope), or deliveries must be recorded under a single
  scope the lookup cannot miss; and the birth clock must not be steerable by a client-supplied
  `queueNow`/id timestamp — derive the horizon comparison from a source the client cannot forge
  (server-stamped receipt time), or treat any client-future/forged stamp as `uncertain`, never `none`.
- **Verifier could NOT test (still-open attacks):** the clock-correction and forged-`queueNow` cases
  END-TO-END through a real browser tab (only direct `queue-ledger.ts` calls were driven); the
  uncertain-row UI beyond R4g (Discard on an uncertain row; two tabs pressing Send anyway at once);
  many sessions at once; a restart during the "Checking…" state; and delete-session-then-restore. The
  200 KB diff truncation meant the client merge logic and most `index.ts` hunks were not reviewed.
- **Independent skeptic status.** This IS the independent clean-room pass but SAME-provider
  (anthropic→anthropic), because the cross-provider OpenAI attempt was refused by OpenAI's content
  gate (above). Given this is a session-lifecycle / exactly-once / data-loss change, a **cross-provider**
  re-verify once OpenAI's Daybreak/content gate can be cleared (or via a differently-worded prompt)
  remains warranted to decorrelate blind spots — flagging for the orchestrator.
- **Symptom of a deeper design flaw?** yes — same as rounds 1–4. The ledger now owns the delivered
  fact, but its absence-answer is derived from client-forgeable inputs (scope choice, tab clock,
  `queueNow`), so "never delivered" is not trustworthy. A server-owned per-session outbox keyed by
  row id, with a server-stamped delivered record, would remove the class; ARCH ticket still
  recommended (not filed by this lane).

### 2026-09-30 — fix lane (round 5, class=plan+review) — DESIGN NOTE (before building): a server-owned outbox
- **Hypothesis checked against the code: HOLDS.** Four rounds, one shape: every "was this row
  delivered, and may it go now?" answer was worked out by a reader from something that can lie or
  forget — per-tab heap (r1), localStorage locks + transcript text (r2), an evicting ledger (r3),
  client clocks/scope/`queueNow` (r4, `queue-ledger.ts:198 current()`). The ledger only ever owned
  ONE half of the fact (delivered?); the row itself — its text, order, and whether it is still
  waiting — stayed in the browser, so the server had to answer "never heard of it" questions, and
  every answer to those is an inference. Nothing in the server today prevents it from owning the
  row: `startSession` (agent-bridge) already resumes a session with a prompt and no socket, a
  detached bridge already runs a turn with no tab and closes at its boundary (the 02:33 journal line),
  `AgentSession.send`/`sendGated` and `deliverIntoSurvivor` are callable without a socket.
- **Migration: none of durable records.** Round-3/4 ledger files are no longer read (left on disk,
  harmless). Rows still held in a browser's `cs.queue.v1` are exactly the design's one client edge
  (text the server never acknowledged): the new client POSTs them once with a deterministic nonce
  (`legacy:<row id>`, so two tabs importing the same row dedupe) and initial state `uncertain` —
  shown with Send anyway / Discard, never sent by itself. Nothing is rewritten in place.
- **Invariant.** A queued message exists once, as a row the SERVER minted and persisted before it
  answered the POST; only the server moves it (queued → sending → delivered | uncertain | failed,
  or discarded by the user), each move is on disk before it takes effect, and the server hands a
  row to the CLI only from `queued`, after writing `sending`. No absence, timestamp, scope or text
  from a client is ever read as delivery evidence. A row never leaves by eviction.
- **Design.**
  1. `src/server/outbox.ts` (NEW; `queue-ledger.ts` DELETED). Per session: an append-only JSONL
     journal `$DATA/outbox/<sessionId>.jsonl`, one full row snapshot per line, fsync'd before the
     caller proceeds. Row: `{id (server-minted), nonce (client), seq (server order), text, state,
     reason, hold, createdAt/updatedAt (server clock), forced, deliveredVia}`. Load: last line per id
     wins; `sending` → `uncertain` ("the server stopped while sending it"). ANY unparsable line
     (truncated tail or corruption) → loud `console.error`, every non-terminal row → `uncertain`, the
     file is copied aside (`.corrupt-<ts>`) and a clean journal rewritten with a persisted
     `damaged` marker the dock states in words. Compaction rewrites atomically (tmp+fsync+rename);
     nothing is ever dropped — delivered/discarded rows keep id+nonce forever (per-session, sized by
     what the user typed).
  2. Endpoints (Host/Origin-checked like the rest of /api): `GET /api/outbox?session&dir` → rows +
     damaged; `POST /api/outbox {session, dir, project, nonce, text, initial?, resume:{overrides,
     templateIds}}` → mints or returns the existing row for that nonce (idempotent; the session must
     exist — live or transcript); `initial` may only be `queued` (default), `uncertain` or
     `failed:<reason>` (a client can make a row MORE cautious, never deliverable-by-evidence);
     `PATCH …/:id {text}` / `POST …/:id/discard` only from queued|uncertain|failed (409 with state
     otherwise — the race with delivery is decided by the server's single thread);
     `POST …/:id/send {anyway?, interrupt?}` — uncertain|failed → queued ONCE (a second press finds it
     queued/sending/delivered: 409), `interrupt` = FEAT-031 force: row to the front, flagged, the
     bridge interrupted, delivered alone at the boundary.
  3. The DELIVERY ENGINE (in outbox.ts, wired from index.ts, which owns the bridge/survivor
     primitives). Kicked on every POST/transition and on a 500 ms tick for sessions that hold a
     queued row (none → no timer work). For session S it takes the leading run of `queued` rows (a
     forced row alone, first), composes the same per-row `[Queued … ago]` headers flushQueue used
     (from the server's createdAt), writes them `sending`, THEN hands over, THEN writes the outcome:
     - a live in-process bridge: `busy` → wait (hold `busy`); strand (busy but the running-set says the
       main turn is not running, BUG-159) → `send` (held by the runtime); adopt-gated → `sendGated`
       (refused → back to queued + hold, uncertain → uncertain); else `send` → delivered, and an
       `outbox-turn` event goes down the bridge's sink so a driving tab paints the bubble and goes busy;
       dead bridge → reaped (BUG-033 rules; frameless → wait);
     - no bridge: a resume/delivery already in flight (`resumeStarting`/`deliveryInFlight`) → wait; a
       live survivor → FEAT-065 `deliverIntoSurvivor` when its existing predicate (moved to ONE function
       both the socket handler and the engine call) says deliverable, else wait with the drain payload;
       another program writing the transcript (fresh mtime not explained by this server's own
       just-closed bridge) → wait (hold `external`; Send now overrides); otherwise `startSession`
       (resume, the row's stored overrides/templates) with a null sink, then `detach()` — the bridge's
       own fuse closes it after the turn, exactly as a tab-less turn does today. A pre-spawn refusal
       (runtime check, needs-fork, missing project) → back to queued with backoff, or `failed` with the
       server's own message when it is not transient.
     So a message queued with no tab open is delivered at the turn's end by the server.
  4. Client (`public/app.js`, `public/lib/api.js`): `state.queue` becomes a RENDER of the server's rows
     plus not-yet-acknowledged local rows. The client's only storage is `cs.outbox-pending.v1`: `{nonce,
     text, session}` entries written before the POST and removed on its ack; every load/tick re-POSTs
     them (idempotent by nonce). Mid-turn Enter, a retryable refusal of a typed send (BUG-045/191), an
     unconfirmed typed send (→ `uncertain`), a live-elsewhere refusal (→ `failed: another tab is driving`)
     all become POSTs. A tab polls `GET /api/outbox` every 2 s while a session is open (and after each
     mutation); when a row it shows goes `sending/delivered` via a resume and it is not driving, it
     re-takes the drive with the existing promptless reattach (BUG-160). DELETED: `persistQueue` merge +
     tombstones, `syncQueue`, the `storage` listener, `reconcileQueue`/`applyLedgerStates`/
     `handleQueueDuplicate`, `queueFrameFields`/`sendableRows`/`markRowsSending`, `driveQueue`, flushQueue's
     delivery body, `deliverQueuedBehindBackground`, the drain-wait retry loop
     (`attemptDrainRetry`/`drainWaitAttempt`/`settleDrainWaitDelivery`/…), `forceSend`/`deliverForced`,
     `newQueueId`/`derivedQueueId`, `judgeAdoptedOutbox`; server: `queue-ledger.ts`, `claimRows`, the
     `queueIds/queueNow/queueForce` frame fields and `queue-duplicate` code, `/api/queue-ledger*`. A
     stale round-3/4 tab that still sends `queueIds` is answered with a non-retryable error telling it
     to reload (never delivered, never silently).
  5. UI: unchanged contract from rounds 1–2 — plain muted status text per row from the server's state +
     hold ("Waiting — sends when Claude pauses", "Sending…", "Not confirmed — it may already have been
     sent", "Not sent — <server reason>"), visible Send now / Send anyway / Interrupt & send / Edit,
     Discard set apart (danger text, gap) with Undo (a new POST of the same words), wrapping, no clip.
- **Proof bar (to be added to `verify-bug-217-…mjs`).** Prior-round baselines are PINNED snapshots of
  the round-4 tree's `app.js`, `index.ts`, `queue-ledger.ts`, `events.ts`, `api.js` (sha256-listed, gz,
  `scripts/fixtures/bug-217/round4/`) booted from a scratch copy of the repo; round-3/2/1 clients are the
  existing transforms applied to that pinned app.js — never HEAD. Attacks: r4 scope-after-eviction,
  corrected/skewed clock, forged `queueNow`; r3 flood + restart; r2 sender crash, identical text; r1 two
  tabs; plus: no tab open → delivered at turn end; SIGKILL after each transition (created, sending,
  handed-over, delivered, edit, discard) via a test-only crash point; truncated + corrupted journal →
  loud + uncertain, none dropped; order; Edit/Discard racing delivery; uncertain row Send anyway
  exactly once / Discard; the r1/r2 visual requirements; bug-150, bug-191, gate.
- **Known limits (up front).** Delivery into a live bridge is `send()`; its handover is synchronous, so
  the window between "sending on disk" and "delivered on disk" is one fsync — a crash inside it reads
  `uncertain` (never resent, the user decides). A server resume uses the overrides/templates the tab
  last POSTed with the row (the tab owns those settings today). Two ORCHARD servers on one data dir are
  out of scope (one server owns a data dir already — instance-owner.ts).

### 2026-09-30 — fix lane (round 5) — plan review and what it changed
- **Reviewer:** `npm run dispatch -- --provider openai` (cross-provider; codex-cli 0.158.0-alpha.15.2,
  read-only), thread `01a0f0d7-a23d-7421-be71-aa336842dbfd` — OpenAI answered (no quota/refusal
  fallback needed). **Verdict: UNSOUND** as written. Every blocker is adopted below; the plan is amended,
  not replaced.
- **B1 "delivered on disk" can precede consumption** (`claude-runtime.ts:1336` `send()` only pushes an
  in-memory queue). Adopted: every prompt the outbox hands over carries the row's server-minted id in
  its header (`ref q-…`), so the CLI's own transcript is the receiver's record. `delivered` rows start
  unconfirmed; the engine confirms them from the transcript tail. On load, `sending` rows and
  unconfirmed `delivered` rows are checked: id in the transcript → delivered; absent → `uncertain`
  (never auto-resent; re-checked for 10 min, so a late write still resolves it). The check can only
  move a row toward delivered; it never authorises a send.
- **B2 pending replay dropped `initial`/settings.** Adopted: the client stores the COMPLETE request
  before the POST and replays it verbatim; the server refuses a known nonce with a different payload (409).
- **B3 session-wide serialization.** Adopted: the engine holds the existing BUG-191 `deliveryInFlight`
  reservation from row selection to settlement on every route; the socket `start`/`send` paths refuse a
  prompt retryably while it is held OR while the session has queued outbox rows (`outbox-pending`), and
  the tab enqueues instead — so order is declared by the server, not guessed by the tab.
- **B4 order behind an unresolved row.** Adopted, explicit rule: `uncertain`/`failed` rows are set aside
  and never block later rows; Send anyway re-queues at the row's original position. A batch's transition
  is ONE journal line (atomic).
- **B5 interrupt.** Adopted: Interrupt & send works on a `queued` row; the engine waits for the interrupt
  to settle before delivering the forced row alone.
- **R2 inference.** External writer (fresh mtime, not this server's own just-closed bridge) is labelled a
  heuristic that can only DELAY; Send now overrides it explicitly. Strand / adopt / survivor admission are
  read from their owners (`bridge.sendGate()`, the bridge's own running snapshot, and the FEAT-065 predicate
  moved into `survivor-delivery.ts` for both callers); adopt-gated is decided before the strand shortcut.
- **R3 durability.** Adopted: fsync the directory on create; a failed write changes nothing and the caller
  gets the error; startup loads every journal and schedules delivery with no tab; a DAMAGED session makes
  every new nonce arrive `uncertain` until the user dismisses the damage notice (a lost line could have held
  that nonce).
- **R4 regressions — decisions.** BUG-149: a live-elsewhere refusal becomes a `failed` row ("another tab is
  driving this session") — not sent by itself, Send now queues it for that session's next pause. Resume
  settings (overrides/templates) are stored per row, validated by `validateSessionOverrides`, provider
  dropped (BUG-196), and a batch only joins rows with equal settings. A throw from the AgentSession
  constructor (may have spawned) is tagged in `startSession` and settles `uncertain`; every other rejection
  re-queues with backoff, or `failed` with the server's message when it is not transient. Accepted, stated
  limits: an engine-injected survivor turn denies approvals quickly (the existing FEAT-065 posture when the
  tab has gone); an approval in an engine-resumed turn waits for a tab (FEAT-154 shows it), and later rows
  wait behind it.
- **R5 migration.** Adopted: the one-time import of browser rows reads the round-4 ledger file read-only —
  a row it records as delivered/discarded is not imported; anything else arrives `uncertain`. Rows typed
  before a new session has an id stay in the client's pending store until `session-init`, then POST.
- **Declined:** a CLI-side dedup protocol (needs a CLI change); the transcript `ref` is the receiver's
  evidence, and anything it cannot settle is asked, never resent.

### 2026-09-30 — fix lane (round 5, class=plan+review) — the server owns the queue (built)
- **Verdict (own runs, NOT independent):** the structural fix is built; every prior round's
  failure reproduces against a pinned prior-round state and passes on this tree.
- **Invariant.** A queued message exists once, as a row the SERVER minted and wrote to disk before
  answering; only the server moves it (queued → sending → delivered | uncertain | failed, or
  discarded), each move is fsync'd before it takes effect, and a row is handed to the CLI only from
  `queued`, after `sending` is on disk. No absence, clock, scope or text from a client is read as
  delivery evidence; the one outside evidence is the receiver's own transcript (`ref q…` in every
  prompt header), and it can only move a row toward delivered. Nothing is ever evicted.
- **Plan review:** OpenAI thread `01a0f0d7-a23d-7421-be71-aa336842dbfd` (UNSOUND → every blocker
  adopted; see the entry above). Changed: transcript `ref` confirmation (a "delivered" record is not
  trusted over the receiver), complete-request replay + 409 on nonce/payload conflict, the outbox
  holds BUG-191's `deliveryInFlight` reservation and sockets refuse typed prompts with `outbox-pending`
  while rows wait, uncertain/failed rows never block later rows, one interrupt per forced row,
  directory fsync + damaged-mode (unknown nonces arrive `uncertain`), legacy import reads the old
  ledger read-only.
- **Changed.** NEW `src/server/outbox.ts` (journal, lifecycle, delivery engine, recovery);
  `src/server/index.ts` (`/api/outbox*`, the engine's wiring: bridge / gated / strand / survivor /
  resume routes, `outbox-pending` + `client-outdated` refusals, `bridgeForSession`, stop at shutdown;
  lease/claim code removed); `src/server/agent-bridge.ts` (`announce`, `resumeOf` +
  `bridgeForSession` — a resume whose CLI had not reported its id was invisible, and the engine
  spawned a second CLI onto one transcript in testing; ctor throw tagged `mayHaveSpawned`);
  `src/server/survivor-delivery.ts` (`survivorAdmits`, one predicate for both callers);
  `src/server/events.ts`; `public/lib/api.js`; `public/app.js` (dock = view of server rows + the tab's
  unacknowledged requests `cs.outbox-pending.v1`; queue/drain-wait/force-send delivery code deleted).
  **DELETED:** `src/server/queue-ledger.ts`, `/api/queue-ledger*`, `queueIds/queueNow/queueForce`,
  `persistQueue`/`syncQueue`/tombstones/`storage` merge, `reconcileQueue`, `applyLedgerStates`,
  `handleQueueDuplicate`, `driveQueue`, flushQueue delivery, `deliverQueuedBehindBackground`, the
  BUG-045 tab retry loop (`attemptDrainRetry`/`drainWaitAttempt`/…), `forceSend`/`deliverForced`.
  Tests: `scripts/verify-bug-217-…mjs` (rewritten), NEW `scripts/fixtures/bug-217/round4/` (pinned
  round-4 files, gz + SHA256SUMS), `scripts/fixtures/bug-187/fake-cli.mjs` (opt-in
  `FAKE_TRANSCRIPT_DIR`), and the round-5 contract in `verify-bug-191` (B2 precondition),
  `verify-bug-150-adversarial` (seed shape), `verify-resume-refusal`, `verify-bug-079`.
- **Verified.** `node scripts/verify-bug-217-queued-message-strand.mjs` → **89 passed / 0 failed**
  (N no tab open, A/B incident, C, D, E r1 two tabs, F order incl. restart, G edit/discard at the
  boundary −150…+600 ms, I interrupt, J r2 sender dies mid-POST ×2, K r2 same words, L, M 3-way
  replay + 3-way Send anyway, R3 flood+restart, R4 forged queueNow / skewed clock / other scope /
  damaged journal / round-4 frame, S SIGKILL at created/sending/handed-over/delivered/edited/
  discarded/requeued + transcript recovery both ways, X truncated/garbled/torn, U uncertain UI + no
  clipping 1280/640/520/420 light/dark, LG legacy import, Z). MUST-FAIL on pinned baselines: P4a scope,
  P4b corrected clock, P4c queueNow=1, P3 flood+restart → CLI ×2 each; PJ stranded, PK dropped, PE ×2,
  PA stranded. `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial` 25/0,
  `verify-bug-191-adopt-window-send` 39/39, `verify-bug-079` 9/9, `verify-bug-166` 10/0,
  `npm run gate` PASS. `verify-resume-refusal` 11/13 — the same two that failed on HEAD's app.js in
  rounds 1–4 (chip wording read in happy-dom, you-count). Shots: `~/scratch/bug217/r5/shots*/`.
- **Not tested.** Real-model turns (fake CLI only); `verify-queue`, `verify-bug-129/149/153`,
  `verify-feat-065/064`, `verify-refusal-visible` (real-model / neighbour-project suites — they
  assert the old tab-side queue and need updating); container projects; two servers on one data dir;
  an approval raised by an engine-resumed turn with no tab (waits for a tab; later rows wait behind it).
- **Known limits.** A kill between `send()` and the CLI reading stdin leaves the row `uncertain` (the
  user decides) — never resent. The narrow 420 px dock truncates long reasons (visible on scroll).
- **Handoff.** Needs a COMPLETED cross-provider clean-room verify. Attack: container resume, approvals
  in a tab-less turn, a slow `startSession` racing a tab's reattach, the stale-suite list above.
- **Symptom of a deeper design flaw?** yes — and this round is the structural answer to it: the queue
  was owned by the browser, so every reader inferred delivery. It is now owned and declared by the
  server (ARCH-010). No new ARCH ticket needed; the residue is the suites still asserting the old
  tab-side queue.

### 2026-09-30 — independent clean-room verify (round 5, class=verify) — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run 8d561915-89ae-4448-ba6b-1f96a4b29354 (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**. Contract **VALID**
  (fixer suite re-run as `--test-file` + a manifest-backed adversarial case OUTSIDE the fixture +
  an untested list). Re-verifying round-5 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 /
  ac94869a234693a08 / a4958d8724bef2807 / a981330d36bbdd675 (the server-owned outbox,
  `src/server/outbox.ts`).
- **Provider — cross-provider (OpenAI) was ATTEMPTED FIRST and died on QUOTA; this is the Anthropic
  fallback (same-provider, decorrelation reduced — noted honestly).** OpenAI dispatch
  `01a0f12b-0509-7f83-bcc9-ab016010501d` (codex-cli 0.158.0-alpha.15.2, author anthropic → verifier
  openai) ran real adversarial probes (short-write, transcript-confirmation) but the dispatch
  **failed [quota-window]: "You've hit your usage limit … try again at 1:05 PM"** mid-run — this is a
  **usage-limit exhaustion, NOT the content/Daybreak gate of round 4** (OpenAI's weekly window was 81%
  used / verdict `park` at launch). Contract-INVALID (a run that dies partway is not a verdict); its
  interim narration that the short-write test broke durability is **suggestive but NOT citable**. Room
  KEPT `~/.local/state/claude-station/scratch/cleanroom-verify-Z9jNaP`; record
  `cleanroom-record-qyh8Cs/manifest.jsonl`. Per the charter fallback the launcher then ran a **clean-room
  Anthropic** pass (author anthropic → verifier anthropic). A COMPLETED cross-provider re-verify once
  OpenAI's weekly quota resets remains warranted (session-lifecycle / exactly-once / data-loss class).
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared dirty
  tree (HEAD a977e76baf6a → snapshot tree 9919b1d059ae), `--test-file
  scripts/verify-bug-217-queued-message-strand.mjs`, bare `--run "node
  scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment), `--max-diff-bytes 200000`,
  `docs/` auto-stripped. Verifier given ONLY the plain requirement + the named attacks (charter guidance,
  NOT the fixer's report or ticket prose) and the fixer's test CODE. Clean room KEPT
  `~/.local/state/claude-station/scratch/cleanroom-verify-ngGB5e`; record
  `cleanroom-record-F2hrtm/manifest.jsonl`.
- **BROKEN — ENOSPC on the outbox `.head` rename double-delivers one message across a restart**
  (adversarial `scripts/adv217-enospc-head.mjs`, manifest run 2d17b0d81e8c sha256 123d7a5bf6c3fa3e,
  exit 1; CASE OUTSIDE the fixture — the author's suite never fails a disk write partway). Sequence:
  `append()`/`writeLine()` fsyncs the journal line, then `writeAtomic(head)` throws (ENOSPC on the
  rename); append throws **before the row reaches memory**. The POST returns 500 but the row is already
  on disk as `queued`. The tab replays the same nonce; the server does not recognise it, mints a
  **second** row with a new id, and delivers it (CLI ×1). After a restart, `load()` finds BOTH rows
  under the one nonce, reports `damaged=null` (no damage), and delivers the first too → **CLI ×2**.
  Second finding: `load()` does not detect two rows sharing a nonce — `byNonce` silently keeps the last
  and both stay deliverable, so the idempotency guard **does not survive a restart**. Property broken:
  **"delivered exactly once, never twice"** (success_criteria #1).
- **Root-cause pointer for the fix lane.** The write ordering must make the head durable-or-nothing with
  the journal (a torn head-rename must NOT leave a queued row the tab then re-mints under a fresh id),
  and `load()` must treat two rows under one nonce as a conflict (dedupe to one / mark damaged), so a
  restart cannot resurrect a duplicate. Nonce idempotency has to hold across the crash boundary, not
  only in-memory.
- **Fixer suite re-run this round:** `verify-bug-217-queued-message-strand.mjs` (manifest 56cc09aa77e0,
  exit 1) reported **14 passed / 1 failed**, but the single failure was a **FATAL
  `browserContext.newPage: Target page … has been closed`** — an infra flake the verifier attributes to
  a DUPLICATE copy of the suite running concurrently in its room (it killed one partway; the two runs
  may have interfered), NOT a fix defect it isolated. The BROKEN verdict stands independently on the
  ENOSPC adversarial case, which lives entirely outside the author's fixture.
- **Verifier could NOT test (still-open attacks):** a REAL full filesystem (tmpfs quota needs root — the
  fault was a `NODE_OPTIONS` hook on `fs.renameSync`, so a truly torn journal append under ENOSPC was
  not exercised); container-backed sessions (no Docker runtime in the scratch worlds); deleting/archiving
  a session with rows still queued (code read only: three failed resumes → row `failed`, not run); the
  no-tab tool-approval case (a scratch run showed `awaitingUser=true`, the approval card replayed on
  reattach, delivery once — but it did not go through the recorder, so it is not cited); the fixer
  suite's per-scenario failure breakdown (not inspected; concurrent duplicate run suspected).
- **Independent skeptic status.** This IS the independent clean-room pass but **SAME-provider
  (anthropic→anthropic)** because the cross-provider OpenAI attempt died on its weekly quota. A COMPLETED
  cross-provider re-verify once OpenAI's quota resets is warranted (data-loss / exactly-once class) —
  flagging for the orchestrator.
- **Symptom of a deeper design flaw?** partial — the server-owned outbox is the right structure and
  every prior round's client-inference hole is closed, but durability is still not atomic across the
  journal+head write pair, so a torn write at the wrong instant lets the tab re-mint and a restart
  resurrect a duplicate. This is a write-ordering/recovery bug within the new design, not a return to
  client-owned delivery. No new ARCH ticket needed.

### 2026-09-30 — fix lane (round 6, class=fix) — the commit point is one step; one row per nonce survives a restart
- **Verdict (own runs, NOT independent): FIXED in my runs.** The round-5 break reproduces against the
  PINNED round-5 `outbox.ts` (CLI ×2, both in-process and on a scratch server) and is fixed on this tree
  (×1). Needs a completed cross-provider clean-room verify.
- **Hypothesis checked FIRST, against the pinned round-5 module: HOLDS, and it was wider (proven).** A new
  fault harness fails each outbox write op in turn (1,079 runs on round 5, 620 broke: 130 DUP, 37 two live
  rows, 80 auto-sent possibly-delivered copies, 2 LOST, 540 raw fs errors).
  (a) Every step after the journal fsync threw back as "not saved", not just the `.head` rename: the dir
  fsync's `close`, the head's mkdir/open/write/fsync/close/rename. Each re-minted the row on replay (DUP).
  (b) `load()` kept both rows of a nonce and delivered both (the synthesized round-5 journal → ×2).
  Two more defects in the same class:
  (c) `fsyncDir`'s `close` in `finally` was unguarded, so it threw after the commit.
  (d) `writeSync`'s return value was ignored. A short write left a torn line under an acknowledged row, and
  the next line glued onto it, so both were LOST.
  Every other path (edit, discard, send, delivery outcomes, compaction, load rewrites, recover, confirm)
  shares `writeLine`/`writeAtomic`, so all of them had the gap.
- **Invariant.** A journal line is the truth the moment its fsync returns. That is ONE step. Before it, a
  failure is rolled back (ftruncate + fsync), so a thrown error means nothing changed. If the rollback also
  fails, the line number is burned and the session goes into damaged mode, so a replay arrives "not
  confirmed". After it, memory and the nonce index update at once. The head (a lower bound only: it may lag,
  never lead), compaction and dir fsync are best-effort and never throw. One row per (session, nonce) holds
  in the durable state: `load()` keeps the first row, marks later ones `duplicateOf` (never delivered, never
  shown) and sets a damage notice. If any copy may have gone, or the user acted on one, the kept row is
  `uncertain`. The fix does not mark every row in the session uncertain; an unrelated row still goes.
- **Changed.** `src/server/outbox.ts` (only product file):
  - `commitLine`: 'a+', a lead newline after a torn tail, a `writeAll` loop, rollback, and an unsure → damaged path.
  - `writeHead`: best-effort, cleans up its tmp file.
  - `append`: commit, then memory, then the head. It carries `unsaved` rows and a pending damage notice.
  - `compact`: one snapshot line whose sequence number keeps rising (its only step is the rename). Never throws.
  - `load`: dedupe; snapshot start; a missing head is no longer damage; persistence is best-effort.
  - `recover`/pump outcome failures are held in memory and saved with the next line.
  - `fsyncDir`: the `close` is guarded. `view()` hides duplicates. Disk errors come back in Orchard's own words.
  Tests:
  - `scripts/verify-bug-217-…mjs`: W / DN / WE / P5 / P5E, plus stubs for exports missing from the round-4
    baseline (see below).
  - NEW `scripts/fixtures/bug-217/fs-fault.mjs`: the fs fault injector, which also works as a server preload.
  - NEW `scripts/fixtures/bug-217/outbox-harness.mjs`.
  - NEW `scripts/fixtures/bug-217/round5/`: the pinned `outbox.ts`, as gz + SHA256SUMS.
- **Verified.** `node scripts/verify-bug-217-queued-message-strand.mjs` → **123 passed / 1 failed**. The
  1 was a FATAL boot of the round-4 baseline tree: FEAT-157's concurrent uncommitted edit (11:18) removed
  `provisioning.ts` `claudeCodePin`, which the pinned round-4 `index.ts` imports. Missing imports are now
  stubbed in the scratch copy only (they throw if called). Re-run with `--only MUSTFAIL` → **12/12**
  (P4a/b/c, P3, PJ, PK, PE, PA, P5×2, P5E×2). Together that is 131/131, with all 89 earlier checks green.
  - W: 23 transitions × every write op × 6 modes (ENOSPC once, EIO once, EIO from then on, a short write, a
    short write then a dead disk, an op that took effect and then reported EIO). 1,758 injected faults, all
    fired, 0 violations. Graded for DUP, two live rows, LOST, STUCK, auto-sent, discard or edit ignored, raw
    error, and a false damage notice.
  - W round-5 attack: 201, the replay returns the same row, ×1 before and after the restart.
  - DN: 10 duplicate-nonce journal shapes → at most once, and an all-queued group exactly once. The unrelated
    row goes once. The damage is logged loudly, and the settled journal reloads clean.
  - WE on a scratch server: head ENOSPC → 201, same row, ×1/×1. Journal-fsync EIO → 500 "could not save
    this to disk … nothing was changed", nothing on disk, the replay creates it, ×1/×1. A synthesized
    round-5 outbox → ×0 new, `uncertain`, damaged; a second restart sends nothing.
  - MUST-FAIL on the pinned round 5: P5 in-process ×2, and the synthesized journal ×2 with no damage seen.
    P5E on a server: 500 with 2 rows on disk, ×2; the synthesized journal ×2.
  - Other suites: `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial` 25/0,
    `verify-bug-191-adopt-window-send` 39/39, `verify-bug-079` 9/9, `npm run gate` PASS.
  - The first full run also died once on a transient `index.ts` SyntaxError. That was another lane's
    mid-edit (the file changed at 11:37). The re-run was clean.
- **Not tested.** A real full filesystem: faults are injected at the node:fs layer, because a tmpfs quota
  needs root. Power loss: the directory entry of a brand-new journal is fsynced best-effort, as before.
  Two servers on one data dir. Containers. The dock's rendering of the new error and damage wording in a
  browser (no UI change, no screenshot). The stale real-model suites listed in round 5.
- **Handoff.** An independent clean-room verify, cross-provider if the quota allows. Attack: rename-EIO
  after the rename took effect on a real FS, a torn journal plus an immediate replay under load, and
  duplicate nonces arriving through the legacy import path.
- **Symptom of a deeper design flaw?** no — the commit point is now a declared single step, owned by
  `commitLine`, and every other write reads from it (ARCH-010). No new ARCH ticket.

### 2026-09-30 — independent clean-room verify (round 6, class=verify) — VERDICT: BROKEN (SUBSTANTIVE)
- **Verified-by:** dispatch anthropic run b277112f-af3a-4fdf-ba87-8656c042261d (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**, contract **VALID**
  (fixer suite re-run green as `--test-file` + TWO manifest-backed adversarial cases OUTSIDE the
  fixture + an untested list). Re-verifying round-6 fixer reports af61398b6e7f4cf00 /
  a482f8b6e2280f207 / ac94869a234693a08 / a4958d8724bef2807 / a981330d36bbdd675 /
  a4d5915a92f6a2dbe (the server-owned outbox, `src/server/outbox.ts`, commit-point rework).
- **Provider — clean-room Anthropic (same-provider, decorrelation reduced — noted honestly).** OpenAI
  was NOT eligible: `npm run usage -- --json` at launch showed its 5h binding window **exhausted**
  (100% used, verdict `exhausted`, ~1 h to reset), so it lacked the 5h headroom the charter requires
  for a cross-provider run (weekly was 15% left). Per the charter fallback the launcher ran a
  clean-room **Anthropic** pass (author anthropic → verifier anthropic, SAME provider). A COMPLETED
  cross-provider re-verify once OpenAI's 5h/weekly reset remains warranted (data-loss / exactly-once
  class). NOTE: a first launch on the default 15-min dispatch timeout died mid-run (contract-INVALID,
  not a verdict); relaunched with `--timeout-min 60`, which completed.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared
  dirty tree (HEAD a977e76baf6a → snapshot tree 0bad790a7046), `--test-file
  scripts/verify-bug-217-queued-message-strand.mjs`, bare
  `--run "node scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment),
  `--max-diff-bytes 200000`, `docs/` auto-stripped. Verifier given ONLY the plain requirement + the
  named attacks (charter guidance, NOT the fixer's report or ticket prose) and the fixer's test CODE.
  Clean room KEPT `~/.local/state/claude-station/scratch/cleanroom-verify-327Hsz`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-3Gh9RM/manifest.jsonl` (4 recorded runs).
- **BROKEN — exactly-once fails with two server processes on one data dir (SUBSTANTIVE).**
  `src/server/outbox.ts` takes NO lock on the data dir or a session's journal: each process loads the
  journal once into its own memory (`startOutbox`/`boxOf`) and never re-reads it, so both processes'
  `pump()` see the same row as `queued` and both send it — **CLI received it 2×** in two independent
  cases: `scratch-adv-twoproc.mjs` (two outbox instances, one dir; manifest run f078cdf9ffc7 sha256
  dd7b5ad4bd557f74, exit 1; `atCliA:1, atCliB:1`) and `scratch-adv-twoserver-e2e.mjs` (two REAL
  servers on one `CLAUDE_STATION_DATA`, different ports; manifest run dbbd86452052 sha256
  81c2e3e66d9fdbb5, exit 1; `atCli:2`, both servers report "delivered"). The only boot-time
  single-writer claim, `lanes.claimWriter`, covers the LANE ledger, and on failure `index.ts` only
  logs a warning and keeps booting. Property broken: **"delivered exactly once, never twice"**
  (success_criteria #1). Second SUBSTANTIVE finding (same root): unlocked appends collide on
  server-local line numbers, so the next `load()` reports "line N out of sequence" and marks every
  unfinished row "not confirmed" — AFTER the message had already gone twice.
  - **MINOR (not in a cited run):** a torn last line (crash between the write and fsync of a LATER,
    unrelated create) turns an earlier fully-saved-but-never-sent row into "not confirmed" — no loss,
    no double-send, but that row is no longer delivered by itself.
- **Note on scope.** Round 5's plan called "two ORCHARD servers on one data dir" out of scope
  (instance-owner.ts owns a data dir). The requirement handed to this verifier explicitly names "two
  server processes pointed at one data dir" as an in-scope attack, and the outbox itself takes no lock
  — so the finding is real against the stated requirement. Whether to (a) enforce single-writer at the
  outbox layer or (b) formally rule the two-server case out of scope is an ORCHESTRATOR decision.
- **Fixer suite re-run this round:** `verify-bug-217-queued-message-strand.mjs` ran GREEN (manifest
  3b19da83e567 sha256 d6f8bbf2e13053ab, **exit 0**) — the round-5 ENOSPC/torn-write breaks are fixed
  and all in-fixture attacks pass. The BROKEN verdict rests entirely on the two-process cases, which
  live OUTSIDE the author's single-instance harness.
- **Verifier could NOT test (still-open):** real power loss after the compaction rename but before the
  dir fsync (only a stale temp + lagging head simulated, not cited); real kernel fsync EIO from a
  failing block device (only JS-level `fs-fault.mjs` faults); a journal past V8's max string length
  (~512 MB) in `load()`'s `readFileSync`; a no-tab turn needing a permission approval and a container
  session (fake CLI has no approval flow, no container runtime in the sandbox); separate browsers /
  millisecond race (relied on the author's browser scenarios E/G/M inside the fixer run, wrote no new
  browser test).
- **Independent skeptic status.** This IS the independent clean-room pass but **SAME-provider
  (anthropic→anthropic)** because OpenAI's 5h window was exhausted at launch. Given the data-loss /
  exactly-once / session-lifecycle class, a COMPLETED **cross-provider** re-verify once OpenAI's quota
  resets remains warranted — flagging for the orchestrator.
- **Symptom of a deeper design flaw?** partial — the server-owned outbox and its single-step commit
  point are the right structure and every prior round's client-inference and torn-write hole is now
  closed, but nothing enforces a single writer per data dir/journal, so two processes each treat their
  own in-memory copy as authoritative and double-deliver. A data-dir/journal single-writer lock (or a
  re-read-before-send under an advisory lock), or an explicit out-of-scope ruling, is the residue.

### 2026-09-30 — fix lane (round 7, class=fix) — one server per data dir, held by the kernel
- **Verdict (own runs, NOT independent): FIXED in my runs.** The round-6 break reproduces against a
  synthesized round-6 state (CLI ×2) and is fixed on this tree (the second server refuses, CLI ×1). Needs an
  independent clean-room verify, cross-provider if the quota allows.
- **Hypothesis checked FIRST: HOLDS in scope, differs in mechanism (proven).** The right scope is the whole data
  dir. A single-writer guard already existed: `lanes.claimWriter()`, a Linux abstract unix socket named for
  the data dir. The kernel frees it when the holder dies, `kill -9` included, so it has the flock property the
  hypothesis wanted. It covered only the lane ledger, and `index.ts` just logged a warning when it failed and
  kept booting. So I extended it rather than adding a flock. Checked for legitimate two-server use:
  - Product: none. systemd `restart` stops the old process before starting the new one (Type=simple,
    `Restart=on-failure`). Session hosts are not servers. The outbox is imported only by server modules and
    the in-process test harness.
  - Tests that ran two servers on purpose: `verify-bug-187` A6.3 (a race), `verify-arch-017-rail` (a
    NON-WRITER second server) and the scratch `scratch-a17-r3-warnrow-hold.mjs`. They test a state that is
    now forbidden; they are not a flow the product needs. Restart suites (bug-044, health-survivor,
    adoption-ownership, bug-187 A3/A4/A6.1) stop the old server before booting the new one.
- **Invariant.** One data dir has exactly one Orchard server, arbitrated by the kernel.
  - The server takes the claim at boot, before it loads the outbox or seeds, adopts or listens.
  - If the holder is live, it waits up to `CLAUDE_STATION_DATA_LOCK_WAIT_MS` (default 30 s; that covers a
    restart overlap). If the holder is still there after that, it prints `REFUSING TO START`, names the
    holder's pid and port (the holder answers on the socket), and exits 78.
  - The outbox writes nothing (`commitLine`, head, compaction, the load-time copy and truncation) unless
    `isWriter()`. So a process without the lock never marks a row `sending` and never hands one over.
  - The claim name now uses the data dir's REAL path, so a symlink cannot get a second lock.
- **MINOR fixed.** A cut-off LAST line (no newline) is a write whose fsync never returned, so it never took
  effect. When nothing else is wrong it is truncated off, logged, and not treated as damage, so earlier saved
  rows still go by themselves. A head that is ahead of the last whole line, a bad line in the middle, or a gap
  is still damage (X torn still passes, through the head check).
- **Changed:**
  - `src/server/lanes.ts`: `claimWriter(identity)`, the holder answers with its identity, `claimHolder`,
    `claimDataDir`, and a realpath claim name.
  - `src/server/index.ts`: the boot lock and the exit-78 refusal.
  - `src/server/outbox.ts`: the writer checks and the torn-tail fix.
  - `scripts/verify-bug-217-…mjs`: L1, L2, L3, L4, T, P6, P6T, and `round6Tree()`.
  - `scripts/fixtures/bug-217/outbox-harness.mjs`: each world takes the lock.
  - `scripts/verify-bug-187-responderless-cli.mjs` A6.3: exactly one boots, the other is refused.
- **Verified:**
  - `node scripts/verify-bug-217-queued-message-strand.mjs` → **138 passed / 0 failed**, exit 0. That is the
    131 earlier checks plus 7 new ones:
    - L1: B exit 78 naming A's pid and port, CLI ×1.
    - P6 MUST-FAIL: both boot, CLI ×2.
    - L2: after `kill -9`, the new server boots with no wait, ×1.
    - L3: the new server waits, names the pid, serves nothing, then boots once A is SIGTERMed, ×1.
    - L4: an in-process second outbox is refused the claim, gets 503, leaves the journal byte-identical, and
      sends 0 prompts.
    - T: the saved row stays queued, goes ×1, no damage.
    - P6T MUST-FAIL on the pinned round-5 file: `uncertain`, ×0.
  - Other suites: `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial` 25/0,
    `verify-bug-191-adopt-window-send` 39/39, `verify-bug-079` 9/9, `verify-bug-187-responderless-cli`
    104/104, `verify-lane-ledger` 63/0, `verify-arch-017-drain` 41/0, `verify-feat-102-dispatch-broker`
    25/0, `verify-health-survivor` 14/14, `verify-adoption-ownership` 17/0, `npm run gate` PASS.
  - Pre-existing failures, unrelated: `verify-resume-refusal` 11/13 (the same two as rounds 1–6),
    `verify-bug-129` (a real-model suite, stale since round 5), and `verify-bug-044` section 2 (a real-CLI
    start is never acked, after server 1 booted healthy; inferred unrelated).
- **Broken by design, handoff:** `verify-arch-017-rail` (0/1: "second server never became healthy") and
  `scratch-a17-r3-warnrow-hold.mjs`. Both boot a NON-WRITER second server on one data dir to drive the lanes
  503 / ⚠ row, and that state can no longer be built. The 503 guard is now defence in depth. ARCH-017's lane
  must move A1–A6, B0b, B3b and must-fail legs 1/4/5 to another refusal source, or retire them. Its mutation
  score may show the 503-guard mutants as unreachable.
- **Also addresses BUG-220's `current_need`** (the same lock). That ticket was not edited.
- **Not tested:**
  - Off Linux, where the claim is a socket file that a `kill -9` leaves stale. The server then refuses with
    the existing stale-socket message and does not recover by itself.
  - A holder in another network namespace. Abstract sockets are per netns.
  - Import-time writes by modules loaded before the boot lock (not audited).
  - The systemd loop when a stray server holds the live data dir: exit 78, then `Restart=on-failure` every
    2 s + 30 s.
  - Real power loss.
- **Symptom of a deeper design flaw?** yes, already filed as BUG-220: the whole server assumed one process
  per data dir and nothing enforced it. This round enforces it at one owner (the kernel claim, read by every
  store). No new ARCH ticket.

### 2026-09-30 — independent clean-room verify (round 7, class=verify) — VERDICT: BROKEN (SUBSTANTIVE)
- **Verified-by:** dispatch anthropic run 2cd45fb3-ed22-4319-9cf1-d7834bc2297e (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**, contract **VALID**
  (`VERDICT`/`CLAIM`/`FIXER-TEST`/`ADVERSARIAL` citation block, fixer suite re-run GREEN as
  `--test-file` + SIX manifest-backed adversarial cases OUTSIDE the fixture + an untested list).
  Re-verifying round-7 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 / ac94869a234693a08 /
  a4958d8724bef2807 / a981330d36bbdd675 / a4d5915a92f6a2dbe / a742d4cb96b17014c (the data-dir
  single-writer lock: `src/server/lanes.ts` claim + `index.ts` boot lock + `outbox.ts` writer checks).
- **Provider — clean-room Anthropic (same-provider, decorrelation reduced — noted honestly).** OpenAI
  was NOT eligible: `npm run usage -- --json` at launch showed its binding weekly window at **85% used,
  verdict `park`** (headroom ratio 0.05), so it lacked the cross-provider headroom the charter requires.
  Per the charter fallback the launcher ran a clean-room **Anthropic** pass (author anthropic → verifier
  anthropic, SAME provider). NOTE on account: the default `~/.claude` account returned **HTTP 429 on the
  usage read** and produced **two consecutive contract-INVALID runs** (9fa7ab94… and 27de9786…): the
  verifier ran real lock probes but its final answer was not a well-formed citation block and its
  corrective re-prompt completion was truncated to ~90–570 output tokens (the BUG-211 shape, consistent
  with account throttling). The launcher then routed the dispatch to the fresh **"grey" Anthropic
  account** (`CLAUDE_CONFIG_DIR`, weekly 4% used / verdict ok), which completed a VALID verdict. A
  COMPLETED **cross-provider** re-verify once OpenAI's weekly quota resets remains warranted (data-loss /
  exactly-once / session-lifecycle class) — flagging for the orchestrator.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared dirty
  tree (HEAD a977e76baf6a → snapshot tree 15a5f13856cf), `--test-file
  scripts/verify-bug-217-queued-message-strand.mjs`, bare `--run "node
  scripts/verify-bug-217-queued-message-strand.mjs"`, `--max-diff-bytes 200000`, `--timeout-min 90`,
  `docs/` auto-stripped. Verifier given ONLY the plain requirement + the named attacks (charter guidance,
  NOT the fixer's report or ticket prose) and the fixer's test CODE. Clean room KEPT
  `~/.local/state/claude-station/scratch/cleanroom-verify-F1ejFg` (final VALID run's record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-4VJp8B/manifest.jsonl`, 7 recorded runs).
- **BROKEN — exactly-once fails when a SECOND server reaches the same data dir the lock cannot see
  (SUBSTANTIVE, two independent cases, CLI ×2).** The round-7 claim key is the data dir's REAL path via a
  Linux **abstract unix socket** (`writerClaimName`/`claimWriter`/`claimDataDir`, `src/server/lanes.ts`).
  Two spellings of "the same directory" defeat it, and in both the second server boots healthy (no exit
  78, empty refusal) and the queued row reaches the CLI **twice**:
  - **bind-mount-spelling** (`node scripts/adv-lock.mjs bindmount`; manifest ab322ed4e2c7 sha256
    6bcc19e8a785e3d2, exit 1): the same data dir bind-mounted at another path — exactly a **container
    volume** — has a different `realpathSync`, so a different lock name. `atCli:2`, both servers deliver.
  - **other-network-namespace** (`node scripts/adv-lock.mjs netns`; manifest 8421c393f51c sha256
    e6a28199b73f1c3b, exit 1): the identical path from a separate netns — a **container sharing the
    volume** — cannot see the abstract socket (abstract sockets are per-netns). `atCli:2`, both deliver.
  Property broken: **"delivered exactly once, never twice"** / "only one server may own a data directory"
  (success_criteria #1). Root cause is the SAME class round 6 flagged (two servers, one data dir, double
  delivery): round 7 closed same-path / symlink / relative / dot-dot spellings but the lock's identity
  (realpath + per-netns socket) still does not cover the container mount/namespace spellings the
  requirement's cross-tab/cross-context guarantee implies.
- **MINOR (cosmetic, not a property break):** with the holder **SIGSTOP-frozen** the second server still
  refuses correctly (exit 78, bounded 3.6 s, nothing sent while frozen, row ×1 after SIGCONT — SURVIVED),
  but the refusal reads "a process that did not say who it is" and omits the holder's pid/port, because
  `claimHolder` needs the frozen process to answer on the socket. Substantive guarantee holds; only the
  "names why / names the holder" nicety degrades.
- **SURVIVED (charter attacks that passed, manifest-backed):** symlinked data dir (077dab41a5e5, refuses,
  ×1), relative path with `..` + trailing slash (85ee5b9e1098, refuses, ×1), two DIFFERENT data dirs both
  start (81f9c65c3b9f), SIGSTOP holder refused in bounded time (58e3b8fe1820). Fixer suite re-run GREEN:
  `verify-bug-217-queued-message-strand.mjs` **138 passed / 0 failed**, exit 0 (manifest 53c2e81b6e66
  sha256 db9ba3f9796a53a2) — every in-fixture attack, including the round-5 ENOSPC/torn-write and round-6
  two-instance cases, passes. The BROKEN verdict rests entirely on the bind-mount and netns cases, which
  live OUTSIDE the author's single-host harness.
- **Verifier could NOT test (still-open):** the old server still delivering during the 30 s restart
  overlap (a SIGTERM mid-handover — only the author's L3 covers it); a stale/wrong port in the refusal
  message (not constructed); the non-Linux filesystem-socket lock path and its stale-socket-after-kill
  behaviour (host is Linux); a real 16-hex lock-key hash collision between two dirs (only two ordinary
  distinct dirs tried); the earlier-round regression sweep (disk faults, torn journal, nonce replay, two
  tabs, separate browsers, sender crash, forged fields) was re-run only through the author's own suite,
  no independent variants; a real Docker container sharing the volume (reproduced with unprivileged
  `unshare` namespaces instead); the diff was truncated at 200000 of 2657620 bytes, so most of the
  server change was exercised by running it, not read.
- **Independent skeptic status.** This IS the independent clean-room pass but **SAME-provider
  (anthropic→anthropic)** because OpenAI was parked. Given the data-loss / exactly-once /
  session-lifecycle class, a COMPLETED cross-provider re-verify once OpenAI resets remains warranted —
  flagging for the orchestrator.
- **Symptom of a deeper design flaw?** partial — the server-owned outbox + single-step commit + boot lock
  are the right structure and every prior round's client-inference, torn-write and same-path two-instance
  hole is now closed. The residue is that the single-writer lock's IDENTITY (realpath + per-netns abstract
  socket) does not cover a data dir reached through a bind mount or another network namespace — i.e. the
  container-volume deployment the requirement's cross-context guarantee assumes. Fixing it means keying the
  lock on the directory's device+inode (an on-disk `flock` in the data dir) rather than a path string or a
  netns-scoped socket, OR an ORCHESTRATOR ruling that a shared-volume second server is out of scope. Same
  class as BUG-220; no new ARCH ticket.

### 2026-09-30 — fix lane (round 8, class=fix) — the data dir lock follows the inode, not the name
- **Verdict (own runs, NOT independent): FIXED in my runs.** Both round-7 breaks reproduce against the PINNED
  round-7 `lanes.ts` (CLI ×2) and are fixed on this tree: the second server refuses (exit 78, naming the holder's
  pid and port) and the CLI gets the row once. This needs an independent clean-room verify, cross-provider if the
  quota allows.
- **Hypothesis checked FIRST: HOLDS (proven).** Before building, I ran a standalone prototype. One process held an
  exclusive flock on `d/.lock`. A second open of the file was refused (`flock -n` exit 1) from the same path, from
  `unshare -Urn` (another netns), from `unshare -Urm` + `mount --bind d other` (the file reached as `other/.lock`),
  and from a combined pid+net+mnt namespace. After the holder exited, the lock was free. `kill -9` also freed it. A
  detached child spawned by the holder did NOT keep it alive, because libuv opens with O_CLOEXEC.
- **Root cause (proven):** round 7 keyed the lock on a NAME: an abstract socket derived from the realpath. A bind
  mount gives the same dir a different realpath. Abstract sockets are per network namespace. Neither is a property
  of the directory.
- **Invariant:** one data dir has one server, arbitrated by a kernel flock on the dir's own
  `.orchard-server.lock` inode. Every route to that inode contends for the same lock. The file's existence decides
  nothing; only a held lock does.
- **Mechanism:** Node has no flock(), and I added no native dependency. The server opens the file (O_CLOEXEC,
  O_NOFOLLOW) and runs util-linux `flock -xn 3` with that descriptor as fd 3. The child locks the SHARED open file
  description and exits. The lock stays held because the server keeps the descriptor for its lifetime. This is the
  same kernel flock that `scripts/lib/docker-sandbox.mjs` uses. Its long-lived helper is not needed, because the
  server holds the fd itself.
  - After locking, the server checks the inode is still the one at the path, and retries if not.
  - It then writes `{pid, port, hostname, bootId, pidNs, netNs, dataDir, startedAt}` into the file.
  - A refused server READS the holder from the file, so a SIGSTOPped holder is named too. A holder in another
    host, boot or namespace is labelled as such.
  - The abstract-socket claim is removed, including its `net` import, `diagnoseInUse` and the off-Linux socket
    path. There is one mechanism.
- **What it cannot cover (stated in the code):**
  - Two different KERNELS sharing the dir: hosts over NFS/SMB, or a VM and its host over 9p/virtiofs.
    `claimWriter` refuses a data dir whose statfs magic is nfs/smb/cifs/smb2/ceph/afs/coda/9p/virtiofs, unless
    `CLAUDE_STATION_DATA_ALLOW_NETWORK_FS=1` is set.
  - FUSE is not refused. sshfs cannot be told apart from local FUSE cheaply.
  - Deleting or replacing the lock file while a server holds it lets a new server lock the new inode.
  - Without `flock` on PATH the server refuses to start. macOS is already listed as untested.
- **Changed:**
  - `src/server/lanes.ts`: the flock claim, `claimHolder` reading the file, `describeHolder`, `selfNamespaces`,
    `networkFsOf`, and `ensureDir` before the claim.
  - `src/server/index.ts`: the refusal names the holder and the lock file. A non-`held` failure (network FS, no
    flock) is its own exit-78 refusal.
  - `scripts/verify-bug-217-queued-message-strand.mjs`: `round7Tree()`, `bootWrapped()`, and the tests M1–M7,
    P7B and P7N.
  - `scripts/fixtures/bug-217/round7/`: a new pin, `src__server__lanes.ts.gz` plus SHA256SUMS `b12cb66b…`, taken
    from the round-7 verifier's kept clean room `cleanroom-verify-F1ejFg`.
  - `scripts/verify-lane-ledger.mjs`: W5 and W6 rewritten. They asserted the socket; they now assert the file
    lock, and that a SIGKILLed holder's leftover file wedges nothing, even with the platform faked to darwin.
- **Verified:**
  - `node scripts/verify-bug-217-queued-message-strand.mjs` → **147 passed / 0 failed**, exit 0. That is round
    7's 138 plus these 9:
    - M1, bind mount via `unshare -rm` + `mount --bind`: refused, names pid and port, ×1.
    - M2, netns via `unshare -rn`: refused, names pid and port plus "network namespace net:[…]", ×1.
    - P7B and P7N MUST-FAIL on the pinned round-7 file: the second server boots, ×2.
    - M3, symlink, and M4, relative path with `..` and a trailing slash: refused, ×1.
    - M5, SIGSTOPped holder: refused in about 2 s, names pid and port, ×1 after SIGCONT.
    - M6, two different data dirs: both boot.
    - M7, kill -9 leaves the file and its record, and the next server boots with no wait.
    - L2 (kill -9 frees the lock) and L3 (restart overlap) still pass.
  - Real container, one-off (`/tmp` script, not in the suite): in the standing sandbox (`assertIsolatedDocker`, lock
    taken), `docker run --network none -v <data>:/vol claude-station-base` ran `flock -n /vol/.orchard-server.lock`.
    With a host holder alive: `flock-exit=1`, and the holder record was readable. After SIGKILL of the holder:
    `flock-exit=0`. The container's net, pid and mnt namespaces all differed from the host's.
  - Other suites:
    - `verify-lane-ledger`: 63/0.
    - `verify-bug-150-load-window-queue` 16/0; `verify-bug-150-adversarial` 25/0.
    - `verify-bug-191-adopt-window-send` 39/39; `verify-bug-079` 9/9.
    - `verify-bug-187-responderless-cli` 104/104.
    - `verify-arch-017-drain` 41/0; `verify-feat-102-dispatch-broker` 25/0.
    - `verify-health-survivor` 14/14; `verify-adoption-ownership` 17/0.
    - `npm run gate`: PASS.
- **Not tested:**
  - A real NFS/SMB mount, and the network-FS refusal itself. It could not be mounted unprivileged; the refusal is
    code-read only.
  - Two hosts sharing a dir.
  - A missing `flock` binary.
  - The full server running inside a Docker container. Only the lock primitive was run in one.
  - The pre-existing failures round 7 listed (`verify-resume-refusal`, `verify-bug-129`, `verify-bug-044` §2) were
    not re-run.
  - `verify-arch-017-rail` is still broken by design (round 7's handoff).
- **Import-time audit (round 7's open item):** before the lock, the top-level statements in `index.ts` and in the
  `src/server`/`src/lib` modules only READ the data dir (for example, the slash-commands and models caches in
  agent-bridge). A refused server writes nothing and touches no container before it exits.
- **BUG-220:** resolved by this lock; see its log.
- **Symptom of a deeper design flaw?** No new one. This is the same BUG-220 class, now enforced at one owner (the
  kernel lock on the dir's inode).

### 2026-09-30 — independent clean-room verify (round 8, class=verify) — VERDICT: BROKEN (SUBSTANTIVE)
- **Verified-by:** dispatch anthropic run 996b9433-d92a-4f7e-b2a4-9da28fe15b9a (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**, contract **VALID**
  (`VERDICT`/`CLAIM`/`FIXER-TEST`/`ADVERSARIAL` citation block, fixer suite re-run GREEN as
  `--test-file` + THREE manifest-backed adversarial cases OUTSIDE the fixture + an untested list).
  Re-verifying round-8 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 / ac94869a234693a08 /
  a4958d8724bef2807 / a981330d36bbdd675 / a4d5915a92f6a2dbe / a742d4cb96b17014c / a62f286a75ba45579
  (the kernel flock on `<dataDir>/.orchard-server.lock` — `src/server/lanes.ts` claim + `index.ts`
  boot refusal + `outbox.ts` writer checks).
- **Provider — clean-room Anthropic (same-provider, decorrelation reduced — noted honestly).** OpenAI
  was NOT eligible: `npm run usage -- --json` at launch showed its binding **weekly** window at
  **85% used, verdict `park`** (headroom ratio 0.056; 5h window fresh but non-binding), the SAME
  ineligibility ruling as round 7 — it lacked the cross-provider headroom the charter requires. Per
  the charter fallback the launcher ran a clean-room **Anthropic** pass (author anthropic → verifier
  anthropic, SAME provider). NOTE on account: the default `~/.claude` account returned **HTTP 429 on
  the usage read** (as in round 7), so the launcher pre-routed the dispatch to the healthy **"grey"
  Anthropic account** (`CLAUDE_CONFIG_DIR`, weekly 95% remaining) to avoid the round-7 contract-INVALID
  churn; the run completed VALID first try (`--timeout-min 90`). A COMPLETED **cross-provider** re-verify
  once OpenAI's weekly quota resets remains warranted (data-loss / exactly-once / session-lifecycle
  class) — flagging for the orchestrator.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared
  dirty tree (HEAD a977e76baf6a → snapshot tree 504532028a24, dangling commit 3554d13194ca),
  `--test-file scripts/verify-bug-217-queued-message-strand.mjs`, bare `--run "node
  scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment), `--max-diff-bytes 200000`,
  `--timeout-min 90`, `docs/` auto-stripped. Verifier given ONLY the plain requirement + the named
  attacks (charter guidance, NOT the fixer's report or ticket prose) and the fixer's test CODE. Clean
  room KEPT `~/.local/state/claude-station/scratch/cleanroom-verify-km7UOI`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-YOq7Iw/manifest.jsonl` (6 recorded runs).
- **BROKEN — exactly-once fails when the lock FILE's inode is disturbed while the owner holds it
  (SUBSTANTIVE, three independent cases, CLI ×2).** This is the FIRST named charter attack ("the lock
  file deleted or replaced while it is held (a new inode)"). The round-8 flock keys the claim on the
  file `<dataDir>/.orchard-server.lock` opened `O_CREAT`; `claimWriter` (`src/server/lanes.ts`) checks
  the locked inode equals the path's inode only AT CLAIM TIME, and `isWriter()` only re-tests
  `lockFd !== null` + the claimed path — never that its descriptor's inode is still the file at that
  path. So the holder never notices it lost the lock:
  - **lock-file-unlinked-while-held** (`node scratch-adv/adv.mjs unlink`; manifest 4148747d9972
    sha256 3e9504cd849f203d, exit 1): the lock file deleted under a live holder A; server B starts
    healthy (no exit 78, empty refusal), `O_CREAT`s and flocks a NEW inode, both stay up. `atCli:2`.
  - **lock-file-replaced-by-rename** (`node scratch-adv/adv.mjs replace`; manifest 9e96d9d38b43
    sha256 3e08d8aa854ebfb0, exit 1): a fresh file atomically renamed over the lock; A keeps running on
    the orphaned inode, B locks the new one. `atCli:2`.
  - **data-dir-moved-and-copied-back** (`node scratch-adv/adv.mjs rename-dir`; manifest 1ca69d419864
    sha256 0b8d2d8374e28437, exit 1): the data dir moved and a `cp -a` copy put back at the original
    path; a second server starts there on the same outbox rows while A keeps serving the moved dir, no
    refusal or warning from either. `atCli:2`.
  Property broken: **"delivered exactly once, never twice"** / "only one server may own a data
  directory … a second refuses to start" (success_criteria #1). SUBSTANTIVE, not cosmetic.
- **Fixer suite re-ran GREEN:** `verify-bug-217-queued-message-strand.mjs` **147 passed / 0 failed**,
  exit 0 (manifest 7ea25c5212f5 sha256 304c9150ee55045c). Every in-fixture attack — the round-5
  ENOSPC/torn-write, round-6 two-instance, round-7 same-path/symlink/relative/bind-mount(M1)/netns(M2)
  — passes. The BROKEN verdict rests entirely on the lock-file-inode cases, which live OUTSIDE the
  author's harness (the suite only READS the lock file after a kill, M7; it never disturbs a LIVE
  holder's inode).
- **Verifier could NOT test (still-open):** the full server inside a real Docker/podman container
  against a host-shared dir (only the suite's `unshare` bind-mount/netns M1/M2 ran); a lock file owned
  by a DIFFERENT uid/root (no second user here — a mode-0400 same-user file WAS refused with exit 78 +
  named EACCES); the lock fd leaking into the REAL Claude CLI / container launches (only a session host
  + fake CLI checked — no leak, sub-second restart); real NFS/9p/virtiofs + the
  `CLAUDE_STATION_DATA_ALLOW_NETWORK_FS=1` override; the browser UI (plain status, Send anyway /
  Discard, two tabs / separate browsers) and journal disk-fault cases (author's suite only, no
  adversarial variant); the diff was truncated at 200000 of 2702757 bytes, so `outbox.ts` and most
  server changes were run, not read — only `lanes.ts` (the lock) + the `index.ts` boot call site.
- **Independent skeptic status.** This IS the independent clean-room pass but **SAME-provider
  (anthropic→anthropic)** because OpenAI was parked. Given the data-loss / exactly-once /
  session-lifecycle class, a COMPLETED cross-provider re-verify once OpenAI resets remains warranted —
  flagging for the orchestrator.
- **Root-cause pointer for the fix lane.** The lock's identity must be the OPEN FILE DESCRIPTION's
  inode, re-validated continuously, not the path: a writer that finds its `.orchard-server.lock`
  descriptor is no longer the file at the path (unlinked, replaced, or the dir moved out from under it)
  must stop writing/delivering and refuse to keep owning; and a second server must not be able to
  `O_CREAT` a fresh lock inode beside a live holder. Same BUG-220 single-writer class; the residue is
  that the flock is keyed to a NAME's inode-at-claim-time, not to a lock that survives the file being
  swapped underneath the holder.

### 2026-09-30 — fix lane (round 9, class=fix) — the lock is on the data directory; a holder whose path drifts stops
- **Verdict (own runs, NOT independent): FIXED in my runs.** All three round-8 breaks reproduce against the PINNED
  round-8 `lanes.ts` (CLI ×2 each) and are fixed on this tree. Needs an independent clean-room verify, cross-provider
  if the quota allows.
- **Hypothesis checked FIRST: HOLDS (proven).** A standalone prototype (bash + util-linux `flock`, on tmpfs and on
  the btrfs scratch root) held an exclusive flock on a DIRECTORY fd (`exec 3<d; flock -xn 3`). A second
  `flock -xn` was refused (exit 1) through the same path, a symlink, `$PWD/./d/`, the dir after `mv d moved`, another
  netns (`unshare -Urn`) and a bind mount (`unshare -Urm` + `mount --bind`). A NEW directory created at the old path
  was NOT refused (exit 0). That is the drift case, and it is why part (b) is needed. An empty locked dir can still be
  `rmdir`ed; the data dir is never empty while a server runs.
- **Root cause (proven):** round 8 locked a FILE inside the data dir. Unlinking it, renaming a new file over it, or
  moving the whole dir and copying it back all left the holder locking an inode nobody reached any more. A second
  server then `O_CREAT`ed and locked a fresh one. `isWriter()` never re-checked, so the holder carried on.
- **Invariant:** one data dir has one server, arbitrated by a kernel flock on the directory's OWN inode. A server
  writes and delivers only while the path still names the directory it locked. On the first mismatch it stops for
  good: rows are left "not confirmed" in the dir it holds, and it exits.
- **Mechanism:**
  - `claimWriter` opens the data dir `O_RDONLY|O_DIRECTORY` (libuv adds O_CLOEXEC) and runs `flock -xn 3` on that
    fd. It then checks fstat == stat(path), as before.
  - The holder record moved to a sidecar, `.orchard-server.holder`, written by tmp+rename. It only names the holder.
    Deleting it loses the name in a refusal, nothing else.
  - `isWriter()` compares the locked fd's (dev, ino) with `stat(path)` on every call: two stats, no timer. A
    mismatch or ENOENT calls `loseClaim`, which is sticky. It logs `DATA DIR LOST` and runs the `onWriterLost`
    listeners once, in order:
    - The outbox (`abandonOnLoss`) stops, and marks every `sending` and `queued` row `uncertain` with a plain reason.
      It writes these marks into the HELD dir.
    - `index.ts` logs `EXITING` and exits 75. systemd's `Restart=on-failure` then starts a server for whatever the
      path now names, or that server refuses if another one holds it.
  - The outbox reaches its files through the held fd: `writerDataDir()` = `/proc/self/fd/<n>`, falling back to the
    path when there is no /proc. A save that races a move lands in the dir this process owns, never in the copy.
  - `pump` asks `isWriter()` AGAIN after `sending` is saved and before the handover. After a drift it hands nothing
    over. The copy at the path then holds that row either `queued` (the copy was taken before the save, so one server
    sends it) or `sending` (taken after, so nobody resends it). Either way it is never sent twice.
- **Changed:**
  - `src/server/lanes.ts`: directory flock, `holderFile`, `isWriter` drift check, `loseClaim`, `onWriterLost`,
    `writerLostReason`, `holdsLock`, `writerDataDir`, `releaseWriter` (removes only its own record).
  - `src/server/outbox.ts`: `root()` goes through the held fd, the `mayWrite` gate, the post-save re-check in `pump`,
    and `abandonOnLoss`.
  - `src/server/index.ts`: the exit-75 listener and the refusal wording.
  - `scripts/verify-bug-217-queued-message-strand.mjs`:
    - new: `round8Tree()`, `ROUND9_SHIMS`, `disturbed()`, `driftChild()`, and the tests D1–D4, P8U, P8R, P8D, P8I, F1;
    - updated: the round-6 anchor, the round-7 shims, and M6/M7, which now read the holder record.
  - `scripts/fixtures/bug-217/round8/`: the pinned round-8 `lanes.ts`, sha256 `529b5b67…`, captured before editing.
  - `scripts/fixtures/bug-217/drift-child.mjs`: new.
  - `scripts/fixtures/bug-217/fs-fault.mjs`: resolves `/proc/self/fd/<n>` paths, so W's faults still fire.
  - `scripts/verify-lane-ledger.mjs`: W5 and W6 assert the directory lock.
- **Verified:**
  - `node scripts/verify-bug-217-queued-message-strand.mjs` → **156 passed / 0 failed**, exit 0. That is round 8's
    147 plus these 9:
    - D1 (holder file unlinked) and D2 (replaced by rename): B exits 78, A stays up, ×1. The refusal cannot name the
      holder, because its record was the file deleted.
    - D3 (dir moved, `cp -a` back): B boots on the copy, A logs DATA DIR LOST and exits 75, ×1, and the moved dir's
      row is `uncertain`.
    - D4 (in-process, the move lands while `sending` is being saved): the holder sends ×0, the held dir's row is
      `uncertain`, the copy's row is `queued`, and the copy's server sends it ×1. Once in all.
    - P8U, P8R and P8D MUST-FAIL on the pinned round-8 file: B boots, both stay up, ×2.
    - P8I MUST-FAIL: round 8 writes into the copy and hands the row over.
    - F1: with the session host and CLI alive, the only fd on the dir inode is the server's. After SIGTERM none
      remain, the host and CLI still live, and the restart boots in 259 ms with no wait.
    - The earlier lock cases all still pass: L1–L4, M1 bind mount, M2 netns, M3 symlink, M4 relative, M5 SIGSTOP,
      M6 two dirs, M7 kill -9, P6, P7B, P7N.
  - Other suites: `verify-lane-ledger` 63/0, `verify-bug-150-load-window-queue` 16/0, `verify-bug-150-adversarial`
    25/0, `verify-bug-191-adopt-window-send` 39/39, `verify-bug-079-session-switch-state` 9/9,
    `verify-bug-187-responderless-cli` 104/104, `verify-arch-017-drain` 41/0, `verify-feat-102-dispatch-broker` 25/0,
    `verify-health-survivor` 14/14, `verify-adoption-ownership` 17/0, `npm run gate` PASS.
- **Threat model (what the next verify should hold this to).** IN scope, for any number of Orchard servers on ONE
  kernel:
  - a second server reaching the data dir by any path, mount or namespace;
  - the holder's sidecar deleted or replaced;
  - the data dir renamed (the lock follows the inode);
  - the data dir moved away and a copy or another directory put at its path. The holder stops at its next outbox
    transition. No delivery can happen before that transition, and it exits;
  - kill -9, SIGSTOP and a restart overlap.

  OUT of scope, deliberately:
  1. Tampering with the dir's CONTENTS by any other route while a server runs: hand-editing, truncating or replacing
     the journal, its head or session-host records.
  2. Putting an OLDER copy at the path while the holder runs: a restored backup or snapshot, or a copy taken BEFORE
     the move. The holder still stops at its next transition. But the copy's server believes the stale rows, and a
     row the holder delivered after the copy was taken can go again. That is a journal rollback, the same class as 1.
  3. Two kernels sharing the dir (NFS/SMB/9p/virtiofs are refused by statfs unless overridden; FUSE is not refused).
  4. Writers other than the outbox: the lane ledger is gated by `isWriter` but written by path, and the
     registry/session-host files are not gated by the lock at all. None of them is a delivery path.
  5. No /proc: the outbox falls back to the path and still checks on every write, but a save racing a move could
     land in the copy.
- **Not tested:**
  - the full server in a real Docker container;
  - the lock fd reaching a REAL Claude CLI or a container launch (only the fake CLI and a session host were checked);
  - a restart loop under systemd after exit 75;
  - no-/proc platforms;
  - NFS;
  - the pre-existing failures round 7 listed (`verify-resume-refusal`, `verify-bug-129`, `verify-bug-044` §2), which
    were not re-run;
  - `verify-arch-017-rail`, still broken by design (round 7's handoff).
- **Symptom of a deeper design flaw?** No new one. It is the same BUG-220 class, enforced at one owner: the kernel
  lock on the dir's inode, re-checked at each delivery transition.

### 2026-09-30 — independent clean-room verify (round 9, class=verify) — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run 0da9279f-02f8-4917-9358-e354c5ac0c66 (clean-room,
  `scripts/independent-verify.mjs --working-tree`) — **VERDICT: BROKEN**. Contract **VALID**
  (fixer suite executed + a manifest-backed uncovered adversarial case + a could-not-test list).
  Re-verifying round-8/9 fixer reports af61398b6e7f4cf00 / a482f8b6e2280f207 / ac94869a234693a08 /
  a4958d8724bef2807 / a981330d36bbdd675 / a4d5915a92f6a2dbe / a742d4cb96b17014c / a62f286a75ba45579 /
  ac0f35b679776e1e5.
- **Provider — OpenAI had NO headroom, so this is the clean-room Anthropic fallback (recorded per
  charter).** `npm run usage --json` at launch: OpenAI weekly window is the BINDING one at 92% used
  / 8% remaining, verdict `park` (headroomRatio 0.029), and its 5h window `park` too
  (projectedHoursToCap 0.078 h). Anthropic 5h window `ok` (headroomRatio 2.88). So author anthropic →
  verifier anthropic (**SAME provider, decorrelation reduced** — noted honestly, as rounds 3 and 4's
  Anthropic fallbacks were). A cross-provider re-verify once OpenAI resets would strengthen it.
- **How it was launched (launcher lane; did NOT verify itself).** `--working-tree` over the shared
  dirty tree (snapshot: HEAD a977e76baf6a → tree 754e738c2303, dangling commit 8c74b59e15dd; real
  index untouched), `--test-file scripts/verify-bug-217-queued-message-strand.mjs`, bare
  `--run "node scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment — round 3's
  byte-match break avoided), `--max-diff-bytes 250000`, `docs/` auto-stripped. The verifier was given
  ONLY the plain requirement + the named attacks (TOCTOU-vs-swap, exit-75-under-supervisor,
  inherited-lock-fd, tmpfs-vs-btrfs, bind-mount data dir, regression sweep) plus a neutral pointer to
  read `src/server/{service-manager,index,queue-ledger,survivor-delivery,session-mutations,requests}.ts`
  in the clean-room tree because the server hunks fall past the diff cap — NOT the fixer's report or
  ticket prose — and the fixer's test CODE. The dispatch COMPLETED (printed VERDICT + Verified-by +
  2 recorded runs); it did NOT die mid-run. Clean room KEPT:
  `~/.local/state/claude-station/scratch/cleanroom-verify-1mKvky`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-kCrRDP/manifest.jsonl`.
- **BROKEN — the round-8 design's server-side WIRING is ABSENT from the tree under test (substantive).**
  Fixer suite ran RED (manifest `4b6737505f2c`, exit 1) and the adversarial arm confirmed it (manifest
  `8486e19f1216`, exit 1). Three findings, all confirmed on the real working tree by the launcher:
  1. **`src/server/index.ts` never calls `lanes.claimDataDir` and never refuses a held data dir.** Boot
     only calls `lanes.claimWriter()` (index.ts:5563) in the background and logs a warning on failure. A
     bare second server on the SAME data dir boots **healthy on both btrfs and tmpfs** — no exit 78, no
     "REFUSING TO START" naming the holder (author checks L1, L3, M1, M2, D1, D2 all fail). Note: the
     helper `claimDataDir` exists (lanes.ts:596) but is UNWIRED at boot.
  2. **There is NO `process.exit(75)` path anywhere in `src/`.** After the data dir is moved and a copy
     is put back, the holder logs "DATA DIR LOST", answers 503, and **keeps running** (aExit null)
     instead of exiting loudly (author check D3 fails). `onWriterLost` has only the outbox's
     `abandonOnLoss` listener; nothing exits 75.
  3. **The in-process second-holder refusal also fails** (author L4 red), and the round-7 anchor check
     **P7B matches 0 times** — the boot-lock branch the test and design describe is not in the tree.
  Property broken: "only one server may own a data directory; a second refuses and names the holder; a
  swapped/moved dir stops delivering and exits loudly." Confirmed on the live working tree:
  `rg 'process.exit(75)' src/` → 0 hits; `index.ts` calls `claimWriter()`/exit 78 only, never
  `claimDataDir`.
- **Out-of-scope (correctly excluded by the verifier).** A copy taken BEFORE a delivery and swapped in
  AFTER it (snapshot/journal rollback) would be re-sent by the copy's server — the verifier classified
  this as the out-of-scope threat-model case and did NOT run it. Attack 3 (lock fd inherited by real
  children) was not independently exercised (fd opened O_CLOEXEC via libuv; only author F1 relied on).
- **Could-not-test (verifier's list).** Attack 1's mid-handover TOCTOU (swap between the `isWriter()`
  check and `wiring.handOver`) not injected; attack 2 (supervisor relaunch on exit 75) unexercisable —
  no code exits 75; attack 5 (bind-mount swap) adds nothing while a plain second server is not even
  refused. The fixer suite hit a `FATAL: TypeError fetch failed` after case U so the browser-leg
  regression checks (Send-anyway/Discard/plain-status text, P4A–PA must-fail) never ran — but the
  lock/exit-75 findings (L1,L3,L4,M1,M2,D1–D3,P7B) are independent of that and of timing.
- **Handoff / orchestrator flag.** The working tree does not contain the round-8/9 server wiring the fix
  logs claim green (index.ts calling `claimDataDir` + refusing a held dir + exit-75 on drift). Either
  those `index.ts` hunks were lost (a concurrent-lane clobber of index.ts or a checkpoint restore) or
  never landed in the shared tree — the orchestrator should confirm the fixer's index.ts hunks are
  actually present before re-dispatching. This is a session-lifecycle / data-loss / exactly-once change;
  a COMPLETED **cross-provider** clean-room re-verify (once OpenAI resets) remains warranted to
  decorrelate blind spots.
- **Symptom of a deeper design flaw?** Not a new one — same class the round-8 log names (kernel lock on
  the dir inode, re-checked per delivery transition). The failure here is that the design is described
  but not WIRED in the tree under test.

### 2026-09-30 — fix lane (round 10, class=fix) — the round-9 wiring was clobbered by another lane's strip; restored
- **Finding: CLOBBER, proven from ground truth. Round 9 did wire it.** The round-9 fixer (agent ac0f35b679776e1e5)
  wrote the boot lock, the exit-78 refusal and the exit-75 `onWriterLost` listener into `src/server/index.ts` at
  12:06:48Z (one python replace, visible in its transcript). It appended its log at 12:40:34Z. `index.ts`'s mtime is
  **12:40:38.742Z**. At **12:40:38.689Z** the FEAT-157 strip lane (agent afd45cbe0e3da5d0e) ran
  `for f in $files; do cp "$PRE/$f" "$f"; done` over 22 shared files, index.ts included, with
  `PRE=scratch/feat157/prelane`. Afterwards the live `index.ts` was byte-identical to that pre-lane copy (mtime
  09:51 local, taken at 11:07, before round 7). The strip removed the whole rounds 7–9 boot-lock block and the
  "Already held since boot" line. `lanes.ts`, `outbox.ts` and the suite were not in its list and were intact.
  The FEAT-157 log's "current == WIP → ZERO foreign hunks" proof compared the wrong pair: its WIP copy already
  held BUG-217's hunks. That is a process bug, filed as **BUG-224**, and not fixed here.
- **Restored exactly as round 9 wrote it.** The BUG-217 hunks were taken from the FEAT-157 lane's own WIP copy
  (`scratch/feat157/wip/full/src/server/index.ts`), which matches the round-9 transcript's edit. They were
  re-inserted into the CURRENT `index.ts`: the `claimDataDir` block after `ensureDir(dataDir())`, the exit-75
  `onWriterLost` listener after `startOutbox`, and the comment above the ledger's `claimWriter`. My diff's
  +/- lines are identical to the BUG-217 subset of pre-lane→WIP. No FEAT-157 hunk was re-added, since that lane
  stripped them on purpose. No other lane's change was touched. Pre-edit copy:
  `~/.local/state/claude-station/scratch/bug217-r10/pre/`.
- **Changed:** `src/server/index.ts` only (+48 lines).
- **Verified (own runs, NOT independent):**
  - `node scripts/verify-bug-217-queued-message-strand.mjs` → **156 passed / 0 failed**, exit 0. Every case round 9
    found red passes: L1, L3, L4, M1, M2, D1–D3 and P7B. The browser legs after U also ran and passed, through PA.
  - `node scripts/verify-lane-ledger.mjs` → 63 PASS / 0 FAIL.
  - `npm run gate` → PASS. `tsc --noEmit` clean.
  - End-of-run presence check: `rg -n 'lanes.claimDataDir\(' src/server/index.ts` and `rg -n 'exit\(75\)' src/`
    each hit once.
- **Still needed:** an independent clean-room re-verify of round 9's design. The round-9 verify never exercised it,
  because the tree it was given no longer held the wiring. Cross-provider if OpenAI has headroom. Round 9's
  not-tested list stands.
- **Symptom of a deeper design flaw?** Yes for the process, not for BUG-217: a lane can whole-file-restore a shared
  dirty file and erase another lane's green work (BUG-224).

### 2026-09-30 — independent clean-room verify (round 10, class=verify) — VERDICT: BROKEN
- **Verdict: BROKEN, contract VALID, SUBSTANTIVE and IN SCOPE.** The canonical `Verified-by:` line is
  appended below by `board-tool` (provider anthropic, run `f6129491-8551-4023-85b6-d0acfb81b82b`,
  verdict BROKEN). This is the first clean-room pass that actually exercised the round-9/10 wiring:
  round 9's verify ran against a tree the FEAT-157 strip had clobbered (see round-10 fix above), so the
  design was never independently attacked until now. Precheck before launch confirmed the wiring is on
  disk: `rg 'claimDataDir\(' src/server/index.ts` and `rg 'exit\(75\)' src/` each hit once.
- **Provider choice (recorded per charter).** `npm run usage --json` at launch: OpenAI's BINDING weekly
  window was 92% used / 8% remaining, verdict `park` (headroomRatio 0.029), its 5h window `park` too — no
  cross-provider headroom. Per the charter fallback the launcher ran a **clean-room Anthropic** pass
  (author anthropic → verifier anthropic, SAME-provider — decorrelation reduced), routed to the healthy
  **"grey" Anthropic account** (weekly 9% used) via `CLAUDE_CONFIG_DIR` to avoid the default account's
  throttling churn seen in rounds 7–8. A COMPLETED **cross-provider** re-verify once OpenAI's weekly quota
  resets remains warranted (data-loss / exactly-once / session-lifecycle class) — but the BROKEN verdict
  stands regardless: a break found same-provider is still a real break.
- **How it was launched (launcher lane; did NOT verify itself).** `scripts/independent-verify.mjs
  --working-tree` over the shared dirty tree (HEAD `a977e76baf6a` → snapshot tree `e78f5e51d525`; real
  index untouched), `--test-file scripts/verify-bug-217-queued-message-strand.mjs`, bare `--run "node
  scripts/verify-bug-217-queued-message-strand.mjs"` (no trailing comment — round 3's byte-match break
  avoided), `--max-diff-bytes 250000` (full diff 2471365 bytes, truncated — the verifier reads the full
  clean-room files regardless), `--timeout-min 90`, `docs/` auto-stripped (1 node), allow-list 169/248
  changed paths. The verifier was given ONLY the plain-terms requirement + the named attacks (charter
  guidance, NOT the fixer's report or ticket prose) and the fixer's test CODE. The dispatch COMPLETED
  (printed VERDICT + CLAIM + FIXER-TEST + ADVERSARIAL + UNTESTED + Verified-by; `DISPATCH_DONE exit=1`
  = the wrapper's BROKEN signal, NOT a mid-run death). One compliance re-prompt used (1 of 1). Clean room
  KEPT `~/.local/state/claude-station/scratch/cleanroom-verify-31hjKB`; record manifest
  `~/.local/state/claude-station/scratch/cleanroom-record-CNq8qy/manifest.jsonl`; launcher log
  `~/.local/state/claude-station/scratch/bug217-r10-verify.log`.
- **Fixer suite re-run GREEN as `--test-file`:** `node scripts/verify-bug-217-queued-message-strand.mjs`
  → **156 passed / 0 failed**, exit 0 (manifest `98a77b0acb15`, sha256 `6bf2fa2ea102ab3f`). Every
  earlier round's attack encoded in the fixture (W-series fault injection, L1/L3/L4, M1/M2, D1–D3, the
  P-series browser legs) passes — so the **regression sweep of earlier rounds' attacks does not regress.**
  The two breaks live OUTSIDE the fixture.
- **BREAK 1 — double send (drift check racing a swap / ABA TOCTOU).** `move-copy-then-move-back`, manifest
  `62e3d548bcc9` sha256 `ce7ca4e980d531c3`, exit 1. With a row queued under an "another program is writing"
  hold: move the data dir away, `cp -a` a copy to its path, start a second server B there and press Send now
  (CLI ×1); stop B and move the original dir back. Holder A — never restarted, never logging DATA DIR LOST —
  sends the row again on its next transition → **CLI ×2** (`atCliTotal:2`, `aAlive:true`, `aSaidLost:false`,
  `rowInOriginalDir:["delivered"]`). Directly violates "moved/replaced/swapped at its path → stops delivering
  and exits loudly rather than risk a double send."
- **BREAK 2 — idle holder never re-checks; two servers on one data dir.** `idle-holder-after-replace`,
  manifest `e67db23c91b9` sha256 `b516f2a4dbbb810f`, exit 1. Root cause: the drift / path-identity re-check
  runs ONLY inside outbox delivery transitions (`lanes.ts` `isWriter`, no timer / no inode watch). Replace the
  dir while the holder has nothing to deliver and 20 s later the holder is still alive, answers `/api/health`
  200, has logged nothing, and accepts `POST /api/projects` (201) — writing `registry.json` BY PATH into the
  copy that server B holds the lock on (`wroteIntoDirOwnedByB:["registry.json"]`, `aSaidLost:false`,
  `aExit:null`). Both servers are effectively live on one data directory.
- **Scope ruling.** Both breaks are **IN SCOPE**: the requirement explicitly covers a directory "moved,
  replaced or swapped at its path", and these use `mv`/`cp -a` of the directory, not the out-of-scope
  "hand-editing or corrupting the server's internal data files." SUBSTANTIVE, not cosmetic.
- **Verifier could NOT test (still-open):** tmpfs vs btrfs (only btrfs /tmp was run); the data dir as a
  bind-mount POINT (needs an unshare/mount harness); the exit-75 path under a real supervisor that restarts
  immediately (the holder never reached exit 75 in either run, because the drift check never fired for these
  paths); lock-fd inheritance beyond the author's F1 (code read only, no `/proc` fd probe); a pre-staged copy
  landing between the post-"sending" re-check and the handover (judged out of scope by the verifier); the
  browser UI claims (covered only by the author's suite).
- **Fixers to date (accumulated, this ticket):** af61398b6e7f4cf00, a482f8b6e2280f207, ac94869a234693a08,
  a4958d8724bef2807, a981330d36bbdd675, a4d5915a92f6a2dbe, a742d4cb96b17014c, a62f286a75ba45579,
  ac0f35b679776e1e5, acd484d86ad05cc27.
- **Handoff.** The exit-75-on-drift design has holes because the re-check is GATED on delivery transitions.
  Next fix must make the path/inode-identity re-check fire INDEPENDENTLY of delivery (a timer, or an
  inotify/stat watch on the dir inode) so an idle holder detects a replaced dir, AND must detect that the
  inode identity changed even when the original is later restored at the path (the ABA case), so a moved dir
  makes the holder stop and exit before it can send again. Then re-verify — a COMPLETED cross-provider
  clean-room pass once OpenAI's weekly quota resets.
- **Independent skeptic status.** This IS the independent clean-room pass, but SAME-provider
  (anthropic→anthropic) because OpenAI was parked. A cross-provider re-verify would strengthen a future
  HOLDS; it is not needed to trust THIS verdict, since a break found same-provider is real.
- **Symptom of a deeper design flaw?** Not a new one — the round-8/9 log already names the class (the
  data-dir identity guarantee). The specific gap this round adds: the guarantee is enforced only at delivery
  transitions, so an idle or ABA-swapped holder escapes it.

### 2026-09-30 — dispatch anthropic
- **Verified-by:** dispatch anthropic run f6129491-8551-4023-85b6-d0acfb81b82b (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
