```orchard-ticket
{
  "id": "BUG-155",
  "type": "bug",
  "title": "A valid orchard-digest fence renders as JSON when a lead-in precedes it",
  "summary": "The renderer lifts an orchard-digest block into the rail only when the fence is the first non-blank line. When the model writes an intro sentence first, then a well-formed digest fence, it is not lifted: parseResponseBlocks makes it a body block with no presentation row, so its raw JSON renders as prose — a wall of JSON, not the rail.",
  "impact_if_we_wait": "Across all local transcripts: 556 messages carry a digest, 18 (3.2%) fail this exact way, every one a well-formed fence preceded by a lead-in. NOT the quoted/unfenced JSON originally hypothesised (0 found). It looks benign to the author, so it recurs silently across projects.",
  "current_need": "A design call: the contract says the digest must lead. Decide between lifting a well-formed digest fence even behind a short lead-in, and the contract-preserving floor: an un-lifted digest block must never render its raw JSON as prose.",
  "severity": "medium",
  "area": "Transcript renderer / response digest (public/lib/digest.js)",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-09-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A well-formed digest fence behind only a short lead-in is lifted OR rendered readably, never as raw JSON prose",
    "The floor holds structurally: no code path renders orchard-digest JSON as prose, for any fence position",
    "RESPONSE_FORMAT.md is not silently weakened; if the leading rule relaxes, the doc is updated to match",
    "Verified by rendering the 18 real transcript messages through the real renderer in headless brave, both themes, with a must-FAIL baseline",
    "The sibling class is checked: a stray orchard-finding does not similarly dump worse-than-nothing output"
  ],
  "code_refs": [],
  "related": [],
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

# BUG-155 — A valid orchard-digest fence renders as JSON when a lead-in precedes it

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — worker
- **Diagnosed: the real cause is a lead-in before a valid fence, not unfenced/quoted JSON:** Dispatch: ticket=BUG-155 phase=finding+fixing round=1 class=fix. STOPPED before fixing per charter: the measured cause contradicts the dispatch hypothesis and matches its named STOP condition ("the renderer failing on valid fenced input -> STOP and report").

  HYPOTHESIS TESTED (dispatch): the digest reaches the user as raw/quoted JSON because the model emits the JSON WITHOUT a fence, or wrapped in quotes, or with a broken info-string. FALSIFIED against real data.

  METHOD: scanned every local transcript (~/.claude/projects/*/*.jsonl), 1812 files, 14252 assistant text parts. Classified every message carrying digest-shaped JSON ("items"+"importance").

  COUNTS: 556 messages carry a digest. 538 render correctly (well-formed leading fence). 18 FAIL (3.2%). A separate loose scan for the hypothesised shapes — a LEADING JSON object or quoted-string digest not in a good fence, importance not required — found ZERO across all 14252 messages. So the imagined shapes (unfenced JSON / quoted string / broken info-string / too-few backticks) do not occur locally at all.

  FAILURE SHAPE, 18 of 18 (100%): a WELL-FORMED ```orchard-digest fence with valid JSON, preceded by a short lead-in sentence ("Found it.", "Here is the finished state", "Clear recommendation: ...", "Switching modes — this is advice"). The fence is correct; it is just not the FIRST non-blank line.

  WHY IT RENDERS AS A JSON WALL (code trace, confirmed with the REAL modules against the REAL transcript message that IS the user verbatim example — BUG report #18, "Recommendation: make localhost prefer IPv4 ... /etc/gai.conf", from ~/.claude/projects/<a private-project bot workspace>/a1abc3ed-...jsonl):
    1. parseDigest -> sliceDigestFence (public/lib/digest.js:64) skips only blank lines, then requires DIGEST_OPEN_RE on the first non-blank line. The lead-in sentence is there, so it returns null -> NOT lifted. (Verified: parseDigest lifts it? false.)
    2. renderAssistantText falls through to parseResponseBlocks, which returns blocks [orchard-digest, orchard-ask, orchard-finding, orchard-finding, orchard-judgment] — orchard-digest IS in KNOWN_BLOCKS so it parses as a body block. (Verified.)
    3. blocksToNodes (public/lib/digest.js:389): pres = BLOCK_PRESENTATION["orchard-digest"] is UNDEFINED — there is no presentation row for orchard-digest — so it hits the final `else if (b.content.trim()) nodes.push(prose(b.content))` branch and renders the raw JSON body as prose. That is the wall of JSON the user copied (the surrounding quotes in their paste are their own quoting of the rendered code-block text; the backticks around `localhost` were dropped in their paste).

  The users pasted example is EXACTLY transcript failure #18. #17 (IPv6/localhost) is the same conversation.

  WHY I DID NOT BUILD THE HYPOTHESISED FIX: the dispatch fix (content-sniff a leading JSON object with an items[] array, fence or not, quoted or not) targets a shape with 0 real occurrences, and adding it risks false positives on ordinary JSON a reply legitimately shows. The real fix is a POSITION-tolerance question, and it collides with the DOCUMENTED contract ("At most once, at the very top; only whitespace may precede it") which the dispatch said not to weaken. That is a design call for the user, not something to decide inside a fix lane.

  RECOMMENDED FIX DIRECTIONS (for the owner to choose):
    A. FLOOR ONLY, contract-preserving (lowest risk): an un-lifted orchard-digest block must never render its raw JSON as prose. Either give orchard-digest a BLOCK_PRESENTATION row that renders it as a collapsed/structured note, or in blocksToNodes lift a body-position orchard-digest into renderDigest() where its JSON is valid, and degrade a malformed one to a readable line. This kills the worse-than-nothing render without touching the leading rule. Author still "should" lead the fence.
    B. RELAX THE LEADING RULE (higher value, changes the contract): let sliceDigestFence lift a well-formed orchard-digest fence when only a short prose lead-in precedes it (bounded, e.g. before the first fence and under N chars). Requires editing RESPONSE_FORMAT.md so the doc and the renderer agree. This matches 100% of observed failures directly.
    I lean A+B: A guarantees the floor structurally for ANY fence position (the robust invariant the user actually asked for — "raw digest JSON must never be shown as prose"); B additionally recovers the rail for the common lead-in case. But B needs the contract edit and the user sign-off.

  FLOOR GAP CONFIRMED regardless of A/B: BLOCK_PRESENTATION has no orchard-digest row, and blocksToNodes falls back to prose for any body-position digest block. That is the concrete defect to close.

  SIBLING CLASS (dispatch step 4): NOT yet tested — a broken/stray orchard-finding etc. Deferred because I stopped at the finding stage. Whoever fixes should check it; the same prose-fallback branch handles unknown/stray blocks, but orchard-finding IS presented, so the risk profile differs.

  COULD NOT TEST / UNTESTED: (a) I did not drive the real headless-brave renderer end-to-end — the proof above is the parse-level trace with the real pure module (response-blocks.js) plus the exact digest.js regexes, run over the real transcript text; the DOM "JSON wall" is inferred from the code path, not screenshotted. A fixer MUST do the real render + must-FAIL baseline per the charter. (b) Only local transcripts on this machine; the users "across projects / other machines" claim is consistent with this shape but unmeasured off-box. (c) The quoted-string shape the user pasted was NOT found as a stored shape — my read is that it is the users transcription of the rendered code block, not the stored text; a fixer should confirm by looking at the live rendered DOM.

  Scratch (kept): ~/scratch/digest-scan/ (scan.mjs, scan2.mjs, scan3.mjs, prove.mjs).

### 2026-09-05 — worker (fixing, round 1)
- **Built BOTH halves the owner approved (floor + position tolerance); status → in_verification.** Dispatch: ticket=BUG-155 phase=fixing round=1 class=fix. The prior round's cause is confirmed against the real modules; no third path found.

  **CAUSE RE-CONFIRMED (not merely trusted).** `sliceDigestFence` skipped only blank lines then required the fence on the first non-blank line, so a lead-in dropped the lift; `blocksToNodes` had no `orchard-digest` case, so a body-position digest fell through to `else if (b.content.trim()) prose(b.content)` — the raw-JSON wall. Verified by the must-FAIL run below (the pre-change module fails the exact `no raw JSON in prose` assertions).

  **THE FIX (public/lib/digest.js only):**
  1. **Floor (never raw JSON, any position).** `blocksToNodes` now has an explicit `orchard-digest` branch: valid JSON → `renderDigest()` (a real rail, in document order); malformed → a *contained* `<pre>` code block (the same fallback FEAT-083 gives a malformed leading digest). It is NOT a `BLOCK_PRESENTATION` row and NOT `renderFold` — the single hiding branch stays gated on `COLLAPSED_BLOCKS`, so the fold-guard invariant is untouched.
  2. **Position tolerance (lift behind a short lead-in).** `sliceDigestFence` scans a bounded lead-in before the fence and returns it as `before`; `parseDigest` returns `{ items, rest, before }`; `renderAssistantText` renders `before` as prose ABOVE the rail, then the rail, then the body.
  3. **Item parsing refactored** into a shared `digestItemsFromJson()` so the leading lift and the body floor agree on what a usable digest is.

  **THE BOUND, chosen and justified.** A lead-in is lifted only if it is ≤ `LEAD_IN_MAX_LINES` (3) non-blank lines AND ≤ `LEAD_IN_MAX_CHARS` (200) chars, with NO code fence before the digest. Rationale: the longest real lead-in measured ~85 chars on one line; 3 lines / 200 chars clears every observed case with headroom for a two-sentence intro, while refusing a digest deep in a body or after a code block (that is body content, not the message summary). Beyond the bound the fence is NOT lifted — the floor still renders it as a real rail, so "not lifted" never means "raw JSON".

  **MUST-FAIL PROOF (real DOM via happy-dom, real digest.js module).** New suite `scripts/verify-bug-155-digest-leadin.mjs` (registered `npm run verify:bug-155`). Covers: digest at top (control), short lead-in (lifted, lead-in above via `compareDocumentPosition`), the ticket #18 verbatim-style lead-in, a digest beyond the bound (not lifted, floor rail), a digest after a code fence (not lifted, floor rail), malformed leading JSON, malformed body JSON (floor code block), two digests in one message, plain reply, digest-only.
    - Pre-change module: `DIGEST_PATH=public/lib/_digest_orig_bug155.js node scripts/verify-bug-155-digest-leadin.mjs` → **23 passed, 18 FAILED** (incl. `lead-in: NO raw JSON in prose (the bug)`, `ticket#18: no raw JSON wall`, `malformed-body: NOT raw JSON in prose`, `two-digests: BOTH render as rails`).
    - Fixed module: `node scripts/verify-bug-155-digest-leadin.mjs` → **41 passed, 0 failed.**

  **VERIFIED AGAINST THE USER'S REALITY (not just fixtures).** Ran the fixed renderer over every real local transcript (`~/.claude/projects/*/*.jsonl`): 968 messages carry a digest, **58** have this exact fail shape (grown from 18 at filing). After the fix: **36 lifted (short lead-in → rail above), 22 floor-rendered as a rail (beyond bound / after code), 0 still a raw-JSON wall, 0 failing to produce a rail.** Every real failing message now renders as a real digest. (Harvest script: `~/scratch/digest-scan/verify-real-155.mjs`.)

  **CONTRACT UPDATED (docs/prompts/RESPONSE_FORMAT.md).** NOT a mirror — it is absent from `scripts/sync-methodology.mjs`'s manifest (only the WORKING_AGREEMENT files + ROUTING.md are mirrored), so it is hand-editable. The injected core (between the inject markers) was left untouched — the authoring rule "lead with the digest" is still correct guidance and the size budget is unchanged (`verify:feat-084` 37/37). The renderer's leniency + the floor are documented in the human sections ("Repetition and ordering", "Malformed input").

  **GRAMMAR UNCHANGED.** `orchard-digest` was already in `KNOWN_BLOCKS`; the fix is entirely in the renderer (`digest.js`). `scripts/verify-feat-091-response-blocks.mjs` needed no edit and passes 277/277.

  **REGRESSIONS RUN:** `npm run verify:feat-091` 277/0; `npm run verify:feat-084` 37/0; `npm run gate` PASS (leak-gate + check-nul + typecheck, exit 0). Browser-driven suites (`verify:feat-082/083`) were not run — this environment has no browser; the happy-dom suite + the real-transcript harvest cover the render path at the DOM level instead.

  **SIBLING CLASS (dispatch step 4 / success criterion 5) checked:** a stray `orchard-finding` (or any non-digest known block) still routes through `renderVisible`/`renderFold` and never dumped raw JSON — only `orchard-digest` lacked a presentation path, which is now the explicit floor branch. An unknown `orchard-*` name still renders its content as fallback prose (that content is prose, not structured JSON, so it is not the worse-than-nothing shape).

  **INDEPENDENT VERIFY WARRANTED (bucket: regression-prone / data-integrity).** The change touches the digest render path and asserts a "never raw JSON" invariant; a clean-room pass (`scripts/independent-verify.mjs`, or a second fresh-context agent excluding this ticket's diff) should re-attack the bound (a 4-line / 201-char lead-in must NOT lift), the malformed-body floor, and the two-digest ordering. Self-verified only; not VERIFIED.

  Files left unstaged: public/lib/digest.js, docs/prompts/RESPONSE_FORMAT.md, package.json, scripts/verify-bug-155-digest-leadin.mjs, docs/bugs/BUG-155-*.md.
