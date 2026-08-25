```orchard-ticket
{
  "id": "FEAT-092",
  "type": "feature",
  "title": "Running sessions keep following outdated project instructions",
  "summary": "When a governing instruction document is edited, sessions already running keep behaving by the old version until their process is replaced. The edit reaches nobody currently working. The longest-lived session has had the most time to drift, so the session people rely on most is the most out of date.",
  "impact_if_we_wait": "The session you talk to all day can quietly follow superseded rules, and it cannot tell that it is doing so. Bounded: this affects instruction freshness, not user data, and cycling the session or handing it the changed document remains a cheap workaround.",
  "current_need": "Decide Option A (record the workaround) or Option B (per-turn amendment channel). The prerequisite is no longer open: a resumed session is now OBSERVED to apply freshly composed instructions, so the cycle-the-session workaround is proven to work.",
  "severity": "medium",
  "area": "Session instruction freshness",
  "reported": "2026-08-18",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-22",
  "decision": {
    "mode": "single",
    "question": "Should we accept the cycle-the-session workaround, or build a per-turn amendment channel?",
    "options": [
      {
        "key": "A",
        "label": "Write down the workaround",
        "what_changes": "Nothing is built. Cycling a session, or handing it the changed document mid-conversation, becomes the recorded practice.",
        "benefit": "No build cost, and the remedy already works today for anyone who remembers it.",
        "cost": "The lag stays, and it stays worst on the session that runs all day.",
        "why_not_obvious": "A remedy that depends on someone noticing staleness fails exactly when nobody notices, and a running session cannot notice for itself."
      },
      {
        "key": "B",
        "label": "Build a per-turn amendment channel",
        "what_changes": "Each turn checks whether a governing document changed on disk and prepends a dated notice carrying only the changed part.",
        "benefit": "An edit reaches sessions that are already running, without re-sending the whole instruction stack.",
        "cost": "Costs nothing on an unchanged turn and roughly 750 tokens once per edit, plus new wording and rate-limiting work.",
        "why_not_obvious": "A mid-conversation notice can contradict what the session was told at launch, and it can be dropped when the conversation is compacted."
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish whether a resumed session actually applies freshly composed instructions. The whole cycle-the-session workaround rests on that, and it is currently inferred rather than proven."
  },
  "decision_history": [],
  "success_criteria": [
    "Editing a governing document between two turns makes the next turn carry a dated notice for exactly the changed section",
    "An unchanged turn adds no notice and no token cost",
    "Repeated edits in quick succession do not emit a notice every turn",
    "Whether a resumed session applies freshly composed instructions is established by observation, not inference"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "AgentSession",
      "note": "constructor ~628 composes the system prompt once at spawn; nothing recomputes it for the life of the process"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "#withBriefing",
      "note": "~1043, runs on every send() and already prepends bounded exactly-once content — the seam Option B would reuse; send() ~955/1059"
    },
    {
      "path": "src/server/templates.ts",
      "symbol": "composeInstructions",
      "note": "~497, folds working agreement, local conventions, routing and response format into one prompt (~41,000 characters)"
    },
    {
      "path": "docs/CONVENTIONS.md",
      "symbol": null,
      "note": "the deploy-lag rule — same shape one level down: a stale build rather than a stale prompt"
    },
    {
      "path": "docs/prompts/RESPONSE_FORMAT.md",
      "symbol": null,
      "note": "the late edit whose layer-2 block spec exposed the lag"
    }
  ],
  "related": [
    {
      "id": "FEAT-091",
      "relation": "see_also"
    },
    {
      "id": "BUG-104",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-039",
      "relation": "see_also"
    },
    {
      "id": "FEAT-041",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-092-running-sessions-never-see-edited-methodology.md",
    "sha256": "d70ee3b8300cfe8a20190833740fbdfe50544c20705765fc8bcd5eeb008328f9",
    "bytes": 12379,
    "original_title": "a running session never sees an edited instruction doc, so the longest-lived session is the most stale",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original section by section: both options with their costs, the timestamp evidence, the undetermined resume fact, the four risks and the three-step sketch are present.",
    "dropped": [
      "the repeated \"why this is not an alarm\" framing, now carried by the impact bound",
      "the note that this is not a response-format bug, kept as a see_also relation instead"
    ]
  }
}
```

# FEAT-092 — Running sessions keep following outdated project instructions

## Diagnosis

### Composition happens once

`AgentSession`'s constructor calls `composeInstructions`, folding the working agreement, local conventions, provider routing and the response-format spec into a single system prompt. That prompt is handed to the CLI at spawn and never recomputed for the life of the process. Editing any source document therefore changes nothing for a process already running.

### Three facts that are easy to get wrong

Restarting the service does not recompose a running session — survivable sessions hand off into their own systemd scopes and keep their original prompt. Recomposition happens only when a later message takes the resume-from-disk path, which constructs a new `AgentSession`.

Reattaching to a live session never recomposes. Delivery into a still-draining survivor writes a bare user frame with no composed prompt at all, so a message sent at the wrong moment silently rides the old instructions.

The orchestrator session is not special. It follows the identical path; it is merely long-lived, which is the only reason the lag shows there first.

### What was not determined

There is no direct proof that the CLI applies a freshly composed prompt on resume. The transcript store keeps no system-prompt record, so this is inference — from the SDK sending the prompt at every spawn, and the CLI having nothing else to restore it from. If the channel is built, pin this down first: the cycle-the-session workaround depends entirely on it.

## Evidence

Confirmed live, not reasoned from the code alone. The orchestrator session composed its instructions at 18:57:04; `docs/prompts/RESPONSE_FORMAT.md` gained its layer-2 block spec three hours later at 22:12:53. That session's later turns emit `orchard-digest: 1` with `orchard-answer: 0` and `orchard-notes: 0` in `~/.local/share/claude-station/logs/response-format-metrics.jsonl` — silently non-compliant with a spec written after it launched, while the metrics file dutifully recorded the non-compliance. Verify both timestamps against your own environment before quoting them onward.

The stale session cannot know it is stale; only an outside observer comparing timestamps can see it.

The decision record's own structure was exercised by `verify:decision-shape`, 25/25 passing, and `board:check` stayed clean. Neither touches the instruction-freshness behaviour — this ticket builds nothing.

## Implementation notes

Only if the channel is approved:

1. At launch, store a hash of each injectable section.
2. Per turn, recompute each section's hash from disk.
3. When a hash differs, prepend a bounded, once-per-change notice carrying only the changed section.

Zero tokens on an unchanged turn, roughly 750 tokens once per edit. Re-injecting the whole stack would be wrong — it is ~41,000 characters, and paying that every turn is exactly the always-on cost the response-format work was careful to avoid.

## Verification plan

No repro test exists yet. Add `npm run verify:feat-092` only if the channel is approved; it would edit an injectable document between two `send()` calls and assert that the second turn's prompt carries a dated supersede notice for exactly the changed section and nothing else.

## Risks

An amendment can contradict the launch prompt. A document edited mid-transcript may say the opposite of what the agent was told at spawn, so the notice must be worded as a dated supersede ("as of <time>, section X now says…") rather than a silent swap. The agent needs to know it is being corrected, not handed a fresh consistent world.

Editing a document in a tight loop would emit a notice on every turn. This wants a floor — debounce or coalesce — or it becomes noise.

A briefing rides the user message channel, so it carries less authority than the system prompt and can be lost to compaction. It is an amendment, not a replacement for launch injection, and cannot be the only place a rule lives.

Any new channel that injects document text must respect the same clean-room strip BUG-104 covers, so a supersede notice cannot leak stripped content into an exported tree.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (filing lane)

- **Understood:** injected methodology is composed once at `AgentSession` construction and never re-read, so
  a running session silently keeps old instructions after any doc edit; confirmed live via the orchestrator's
  18:57 composition vs the 22:12 RESPONSE_FORMAT edit and the metrics log's recorded non-compliance. Verified
  the code references (`agent-bridge.ts` 628/1043, `templates.ts` 497) and the deploy-lag rule in
  `docs/CONVENTIONS.md` before filing.
- **Changed:** this ticket only. No product code touched.
- **Verified:** grep-confirmed the four cited line references and the deploy-lag section exist as described.
  The two live timestamps and the metrics-log content are reused from the source investigation, not
  independently re-derived — a future agent acting on this should re-confirm them in the running environment.
- **Still open / handoff:** the decision (Option A workaround vs Option B per-turn amendment channel). If B:
  first pin down whether the CLI truly re-applies a freshly composed prompt on resume (undetermined above),
  then build against `#withBriefing` with a dated-supersede wording, a per-change floor, and the BUG-104
  clean-room strip.
- **Symptom of a deeper design flaw?** Not closing, so not final. Provisional: leaning yes — "instructions
  are injected once and never reconciled with their source" is a structural property, not a one-off. If
  Option B is declined AND this recurs, that is the ARCH ticket to file.

### 2026-08-18 — ticket-format enforcement lane (worker)

- **Understood:** the Status header said "NEEDS DECISION" and the body named Option A and Option B in a prose
  paragraph ("What we need from you"), which `ticketDecision()` does not parse — no Decide card, so the
  "should we build it at all" call sat in front of nobody. Found by the new decision-shape guard.
- **Changed:** FORMATTING plus a faithful restatement. The "What we need from you" paragraph became
  `## Decision — accept the cheap workaround, or build the per-turn amendment channel?` with two bold-lead
  bullets, A and B, whose text is assembled from wording already in the ticket (the workaround described in
  "In plain terms", the `#withBriefing` proposal and its zero-tokens/~750-tokens pricing from "The shape of a
  fix", and the recorded risks). Nothing new was decided or claimed; an INDEX.md Open row was added with
  Owner 👤 (the ticket had no row).
- **Verified:** `ticketDecision()` now yields 2 options; `board:check` clean for FEAT-092;
  `npm run verify:decision-shape` 25/25 PASS.
- **Still open / handoff:** unchanged — A or B. If B, the undetermined resume-reinjection question in "What
  was NOT determined" must be pinned down first, as that section already says.

### 2026-08-22 — worker (FEAT-102 pickup investigation)
- **prerequisite discharged by observation:** - **Understood:** dispatched to answer a user question that turned out to be an instance of this ticket —
    an existing long-lived session on a private containerised project wanted to pick up the OpenAI dispatch capability
    that FEAT-102 (`ae46280`) added, without abandoning its history. Same class as this ticket: a live session
    cannot pick up a decision made at launch. Filed here rather than as a second ticket.
  - **Changed:** nothing in product code. This log entry and `current_need` only.
  - **Verified — THE PREREQUISITE THIS TICKET ASKED FOR, now observation rather than inference.** This ticket
    recorded, under "What was not determined", that there is no direct proof the CLI applies a freshly composed
    prompt on resume, because the transcript store keeps no system-prompt record. The way around that is to stop
    looking for the record and ask the session itself. Harness: `<scratch>/feat102-proof/probe3.mjs`,
    own server on a free port with an isolated `CLAUDE_STATION_DATA`, 9/9 PASS. A governing template carrying
    the line `FEAT092-MARKER: the governing rule in force is ALPHA-ONE.` was attached to a project; the session
    was asked to quote that line back verbatim.
      - turn 1, at launch: `FEAT092-MARKER: the governing rule in force is ALPHA-ONE.`
      - the document was then edited to `BRAVO-TWO` under the live session; `GET /api/compose/<project>`
        confirmed the newly composed prompt carried BRAVO-TWO.
      - turn 2, same live process, next `send()`: `FEAT092-MARKER: the governing rule in force is ALPHA-ONE.`
        — **this ticket's symptom reproduced on demand for the first time.**
      - turn 3, after a proper close and a resume of the SAME session id from disk:
        `FEAT092-MARKER: the governing rule in force is BRAVO-TWO.`, with `ack.reattached` unset (a fresh
        process, not a re-attach) and `fork: null` (same session, same transcript, not a fork).
    So the cycle-the-session workaround is proven, not assumed, and Option A is now a decision on known
    ground. Honesty note: the first run of this probe recorded a FAIL on turn 3 because the assertion graded
    the whole reply and the model had added a parenthetical mentioning the old value; the assertion was
    corrected to grade the quoted marker line and the probe re-run clean. Both runs quoted BRAVO-TWO.
  - **Verified — the FEAT-102 instance end to end, on a real container project.**
    `<scratch>/feat102-proof/proof.mjs` (17 checks) and `probe2.mjs` (5/5). With the toggle off, the
    container carries no dispatch binds, the live CLI's environment reads `ORCHARD_DISPATCH_ENTITLED=0`, the
    client is genuinely absent from the container, and the session — asked to quote it — reports its system
    prompt says `OpenAI dispatch is NOT enabled for this project. Enable Settings › Tools › OpenAI dispatch
    (settings.tools.openaiDispatch) and launch a new session.` After enabling the toggle and resuming the same
    session id from disk: the container is recreated with both binds
    (`.../dispatch/<project>:/run/orchard-dispatch:ro` and `.../dispatch-client.mjs:/opt/orchard-dispatch/dispatch-client.mjs:ro`),
    the new CLI process carries `ORCHARD_DISPATCH_ENTITLED=1`, `ORCHARD_DISPATCH_SOCK`, `ORCHARD_DISPATCH_CMD`,
    and `--check` inside the container prints `openai dispatch: available` with exit code 0. Same sdk session
    id before and after, one transcript file holding both halves, no second transcript.
  - **Verified — the three ways a live process gets in the way.** This is what makes "cycle the session"
    precise rather than folklore:
      - tab still attached, a second client resumes: refused outright, `t: error, fatal: true`, *"this session
        is live in another tab — close it there first, or watch it here read-only"*. Loud, not silent.
      - tab looked away while the session was **idle**: the session is closed, so coming back spawns a fresh
        process and the capability is picked up with no deliberate action at all (`ENTITLED=1`, `--check` exit 0).
      - tab looked away while the session was **busy**: BUG-018's detach applies, and coming back re-attaches
        to the SAME process (`ack.reattached: true`) — still `ENTITLED=0` with the toggle on. This is the only
        case where the user must close the session explicitly, and it is the case they are most likely to be in,
        because a session you leave running is usually running something.
  - **Still open / handoff:** the A-vs-B decision, unchanged and now better informed. Two observations for
    whoever takes it. (1) The workaround is narrower than "cycle the session": an idle session self-cycles, a
    busy one must be closed by hand, and there is no signal in the UI telling you which you are looking at.
    (2) Unrelated to this ticket but observed while proving it — the dispatch CLIENT crosses into the container
    as a single-FILE bind (`src/server/dispatch-client.mjs:/opt/orchard-dispatch/dispatch-client.mjs:ro`),
    pinned to an inode. FEAT-102 was careful to bind the socket's DIRECTORY to avoid exactly that class, and
    ARCH-012 tracks it for the browser socket; a `git pull` that replaces that file leaves running containers
    on the old inode. Worth a look by someone who owns FEAT-102, not fixed here.
  - **Symptom of a deeper design flaw?** Not closing, so not final. The prior entry's provisional "leaning yes"
    now has evidence behind it: the same root property produced a second, independent instance (a capability
    decided at launch, not an instruction document) within four days, in a completely different subsystem. That
    is the recurrence the prior entry said would justify the ARCH ticket if Option B is declined.
