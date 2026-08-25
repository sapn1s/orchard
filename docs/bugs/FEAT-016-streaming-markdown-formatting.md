```orchard-ticket
{
  "id": "FEAT-016",
  "type": "feature",
  "title": "Streaming replies showed raw markup until the turn ended",
  "summary": "Assistant text used to arrive as literal markup while a reply streamed, with bold markers, heading marks, list dashes and fence lines all visible until the turn finished and the text snapped into shape. Replies now format as they arrive, and syntax that has not closed yet stays literal rather than being guessed at.",
  "impact_if_we_wait": "Reading a reply while it arrives was harder than reading it afterwards. Bounded: presentation only, affecting neither the text received nor anything stored, and the finished message always rendered correctly.",
  "current_need": "Nothing is outstanding. A real browser turn showed formatted elements appearing mid-reply, the whole streaming-markdown suite passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Transcript streaming",
  "reported": "2026-08-03",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-03",
      "question": "Should in-progress markup be shown as if it had already closed, or left literal until it does?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-03",
      "chosen_by": "user",
      "note": "A was the optimistic approach other chat products use, where an unclosed bold marker is treated as bold up to the cursor; it hides syntax sooner but asserts a state that has not been reached. B re-reads the accumulated text each frame so closed markup formats and open markup stays literal. Switching to A later is a one-line change."
    }
  ],
  "success_criteria": [
    "Formatted elements appear in the streaming node before the turn ends",
    "Unclosed markup stays literal instead of rendering as if closed",
    "The finished message matches what was shown while streaming",
    "The final message does not render twice over the streamed one",
    "Reparsing is debounced rather than run on every token"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "text-delta handler",
      "note": "built `th.stream = { wrap, p, text, caret }` and assigned `th.stream.p.textContent = th.stream.text`, which is what made the raw markup visible"
    },
    {
      "path": "public/app.js",
      "symbol": "final text handler",
      "note": "`th.stream.wrap.replaceWith(prose(e.text))` — the point where formatting used to first appear"
    },
    {
      "path": "public/lib/dom.js",
      "symbol": "prose",
      "note": "tolerant markdown parser reused for the per-frame reparse"
    },
    {
      "path": "verify/verify-streaming-md.mjs",
      "symbol": null,
      "note": "browser suite added for this ticket"
    }
  ],
  "related": [
    {
      "id": "BUG-109",
      "relation": "see_also"
    },
    {
      "id": "DEPLOY-003",
      "relation": "depends_on"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": "docs/bugs/archive/FEAT-016-streaming-markdown-formatting.md",
    "sha256": "60e9891842d00aacc84cc1652eea23754d76f841910c895ba04710fb0de13891",
    "bytes": 5621,
    "original_title": "Format markdown live while streaming (not a raw blob until the end)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked field by field against the original: the symptom, the two candidate approaches and the chosen one, the reused parser, the debounce, the watch list and the browser proof are all present.",
    "dropped": [
      "the note that this was discussed earlier and never implemented, which the reported date already carries",
      "the observation that the parser is sub-millisecond, which changes nothing a reader decides"
    ]
  }
}
```

# FEAT-016 — Streaming replies showed raw markup until the turn ended

## Diagnosis

During a turn the streaming paragraph was updated with plain text assignment, so every character of markdown syntax was displayed as typed. Formatting only appeared at turn-end, when the whole streamed node was replaced by a parsed render of the final text. The parser needed for live formatting already existed and was only being called once, at the end.

## Evidence

The work became testable only after DEPLOY-003 cleared and the restarted server began token-streaming dashboard-driven sessions. The dedicated streaming-markdown browser suite runs a real cheap turn whose reply contains a bolded word, a list and a short code block, and asserts formatted elements are present before turn-end: 9 of 9 checks pass. Typechecking is clean. The offline interface suite is named in the plan but has no recorded run for this ticket.

## Implementation notes

Each delta rebuilds the streaming node from a parse of the accumulated buffer instead of setting text content, debounced to roughly every 60–100ms so a small message is not reparsed on every token. The caret and scroll-stick behaviour are preserved across the rebuild. Subagent-thread streams take the same path.

The alternative approach — treating an unclosed marker as already closed so syntax disappears immediately — remains a small switch away if the smoother feel is preferred later.

## Verification plan

Drive a real browser through a live turn whose reply contains bold text, a list and a fenced block plus a sentinel. Before the turn ends, assert the streaming node holds real formatted elements rather than literal markers, and that the finished render matches what was streamed. Watch an unclosed fence mid-stream, the caret, and double-rendering at turn-end.

## Risks

An unclosed fence part-way through a reply, caret placement across rebuilds, and rendering the finished message on top of the streamed one were the three failure modes checked for.

## Activity log (APPEND-ONLY)
### 2026-08-03 — orchestrator
- Filed. Discussed with the user earlier; only offered, never implemented — this
  captures it properly. Frontend (app.js) — serialize with other FE tickets.

### 2026-08-04 — implementer (HONEST variant)
**Understood.** The `text-delta` handler dumped the raw accumulated buffer as
`th.stream.p.textContent`, so markdown showed as literal syntax until the final
`text` event replaced the node with `prose(...)`. Fix: reparse the accumulated
buffer through the existing tolerant `prose()` each frame, THROTTLED, so
completed markdown formats live while in-progress syntax stays literal until its
token closes — no asserted-early state. Subagent-thread text arrives whole via
the `text` event (deltas are always main-thread; `parent_tool_use_id` is null),
and that path already renders through `prose()`, so no change was needed there.

**Changed** (working tree, uncommitted):
- `public/app.js`:
  - New `STREAM_RENDER_MS = 70`, `renderStreamNow(th)`, `scheduleStreamRender(th)`.
    `renderStreamNow` rebuilds the node from `prose(th.stream.text)`, moves the
    caret to the end of the last rendered block, `replaceWith`s the old wrap and
    updates `th.stream.wrap`; it `scrollDown()`s (stick-aware) only when viewing
    main.
  - `text-delta` handler: stream node is now a bare `.prose` wrap (dropped the
    single `<p>` + `textContent` write). Leading-edge throttle — render the first
    token immediately (caret shows at once), coalesce bursts, always flush the
    tail via `scheduleStreamRender`. Kept the per-delta stick-aware `scrollDown`.
  - `finishStream` and the final `text` handler now `clearTimeout` any pending
    stream timer before the one final `prose()` replace, so no double-render and
    no late reparse after `th.stream` is nulled (the scheduled closure also
    guards `th.stream === s`). The final-render path is otherwise unchanged.
- `scripts/verify-streaming-md.mjs` + `package.json` `verify:streaming-md`: real
  brave headless over raw CDP, real haiku turn, OS-assigned free port, kill by
  pid, sweeps the CLI's stray real-store transcript dir.

**Verified** (all PASS):
- `npm run verify:streaming-md` — 9/9 passed. Load-bearing: MID-STREAM
  (`th.stream` live, i.e. before turn-end) the streaming node contained
  `<strong>` + `<ul>/<li>` + `<pre>` (formatted live, not literal
  `**`/`- `/```` ``` ````); final render has the sentinel exactly once, no
  duplicated leftover, fully formatted, no literal `**`/```` ``` ```` remaining.
- `npm run verify:ui -- --offline` — 3 passed, 0 failed.
- `npm run typecheck` — clean.
- Screenshot: `docs/bugs/assets/FEAT-016-after.png` — bold "beacon", bullet
  list, `print(42)` code block + caret, captured while status = "Running".

**Open:** none. Not committed (leaving in working tree per the rules).
