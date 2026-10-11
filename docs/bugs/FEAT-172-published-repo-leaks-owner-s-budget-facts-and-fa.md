```orchard-ticket
{
  "id": "FEAT-172",
  "type": "feature",
  "title": "Published repo leaks owner's budget facts and fails for outsiders",
  "summary": "The public mirrors Orchard injects into sessions carry the owner's plan/budget (ChatGPT Plus, rolling 5-hour windows, Anthropic Max, which provider is scarce) and that the owner dual-boots Linux and Windows. Setup pointers are stale or Orchard-only, outsiders never get the worker agent, and the systemd unit names the old repo. Outsiders see private facts and a broken setup.",
  "impact_if_we_wait": "Nothing leaks while the repo stays private; this is exposure-on-publish, not a live disclosure. But the budget fact is load-bearing (the orchestrator routes providers by it), so a scrub not paired with a local overlay would silently change this machine's routing.",
  "current_need": "Build the scrub plus a gitignored local overlay so this machine keeps the injected budget fact while public files carry only a generic principle; fix stale pointers, ship a portable worker agent, correct the deploy unit.",
  "severity": "medium",
  "area": "Public release readiness / session injection",
  "reported": "2026-10-09",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-09",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The owner's plan/budget strings and the dual-boot personal assertion are gone from docs/prompts/* (the injected mirrors)",
    "This machine's injected routing section still contains the budget fact via a gitignored local overlay, rendered through templates.ts the way the server does",
    "The routing injection degrades cleanly (generic core, no personal strings) when the overlay file is absent",
    "WA version pointers read v4; WA/ROUTING cite Orchard tooling with if-your-harness-provides-it framing; the ROUTING staleness banner is prominent",
    "An outsider receives a portable, leak-free worker agent definition",
    "The deploy unit points at the orchard repo path portably",
    "npm run verify:methodology-sync passes and npm run gate passes"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-049",
      "relation": "see_also"
    },
    {
      "id": "FEAT-041",
      "relation": "see_also"
    },
    {
      "id": "FEAT-043",
      "relation": "see_also"
    },
    {
      "id": "FEAT-039",
      "relation": "see_also"
    },
    {
      "id": "FEAT-117",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "911b54e2-6795-4ad5-af7b-ac0c5943d9fd",
      "verdict": "broken",
      "verdict_on": "2026-10-09",
      "recorded_at": "2026-10-09T17:58:16.914Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "dfde14a1-7099-4968-aadf-f14f170a7b44",
      "verdict": "broken",
      "verdict_on": "2026-10-09",
      "recorded_at": "2026-10-09T18:19:26.828Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ff31f61a-c44f-4d80-91c0-4796638c5efc",
      "verdict": "broken",
      "verdict_on": "2026-10-09",
      "recorded_at": "2026-10-09T18:42:59.821Z",
      "author": "dispatch anthropic clean-room + live adjudication",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "TWO-BREAK: design review, do NOT patch. New-path FALSE-POSITIVE: dated-stamp derived marker over-matches shared dates (overlay 'as of 2026-08-05' hits real ROUTING.md banner; verifier run b7b91e2c9765 exit1 vs 0). Props 0-4 HOLD on real artifacts; real tree PASSES. See Activity log 2026-10-09."
    }
  ],
  "verification_class": "plan+review",
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

# FEAT-172 — Published repo leaks owner's budget facts and fails for outsiders

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-09 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-09 — agent (plan+review+build, Opus 4.8)
- **Understood:** The injected mirrors `docs/prompts/ROUTING.md` + `WORKING_AGREEMENT.v{2,4}.md`
  carry the operator's plan/budget ($20 ChatGPT Plus, rolling 5-hour windows, Anthropic Max,
  which side is abundant/scarce) and the dual-boot assertion. The budget fact is LOAD-BEARING:
  `templates.ts routingSection()` injects the condensed ROUTING core into every session and the
  orchestrator routes by it. Baseline captured: pre-change `routingSection()` injected `$20 ChatGPT`
  / `rolling 5-hour` / `ABUNDANT` (len 2469); leak strings present in 3 mirror files + the
  integrations guide.
- **Plan reviewed cross-provider (OpenAI):** `npm run dispatch -- --provider openai`, run id
  `01a12194-de6f-7041-aa2e-1a8474f3836f` (transcript under the Orchard OpenAI transcripts dir).
  Verdict NO-GO as first drafted; 11 ranked attacks. ADOPTED: unify budget + dual-boot into ONE
  gitignored operator-local overlay injected as its own section (pts 3,4); de-personalise ROUTING
  for single-provider outsiders with an explicit fallback (pt 5); fix the live `docs/guide/integrations.md`
  leak (pt 1, non-history); REPLACE the `.claude/` ignore rather than add a child negation (pt 7);
  add a scoped regression guard asserting personal ASSERTIONS not generic vocab, over tracked
  publication docs only (pts 6,11); fix `routingSection()`'s own stale `claude-station`/unframed
  dispatch wrapper (pt 10); deliver the overlay WHOLE so the capacity fact is never the truncated
  part (pt 2). REJECTED (recorded): rewriting append-only tickets / git history — append-only is a
  board invariant and history is FEAT-049's fresh-history publish job (reported, not claimed fixed);
  migrating already-onboarded OTHER repos' CLAUDE.md pointers — separate user-owned repos, out of
  this repo's publish scope; heavy staleness-banner redesign — reviewer said largely unnecessary,
  did a light prominence bump since the user explicitly asked.
- **Changed (all unstaged; user commits):**
  - canonical `~/projects/methodology/ROUTING.md`, `WORKING_AGREEMENT.v4.md`, `WORKING_AGREEMENT.v2.md`
    (de-personalise + framing + prominent staleness banner), then `npm run sync:methodology` →
    mirrors `docs/prompts/ROUTING.md`, `WORKING_AGREEMENT.v4.md`, `WORKING_AGREEMENT.v2.md`.
  - `src/server/templates.ts` — new `operatorLocalSection()` + `OPERATOR_LOCAL_RELPATH`, `operatorLocal`
    fold in `composeInstructions`, routingSection header fix, v2→v4 comment.
  - `src/server/agent-bridge.ts` — pass `operatorLocal: true` at launch.
  - `docs/prompts/OPERATOR.local.md` (gitignored, real holdings) + `docs/prompts/OPERATOR.local.md.example` (tracked template).
  - `.gitignore` — `/docs/prompts/*.local.md`; replaced `.claude/` with selective `worker.md` negation.
  - `.claude/agents/worker.md` — now tracked (negation) + portability-framing preamble.
  - `scripts/onboard.mjs` — waPointerPath v3→v4 (both forms) + v2→v4 comment.
  - `scripts/check-prompt-privacy.mjs` + `.orchard/check-prompt-privacy.mjs` (new guard); `scripts/gate.mjs`
    + `.orchard/gate.mjs` (optional prompt-privacy sub-gate, kept byte-identical); `package.json`
    (`check:prompt-privacy`).
  - `docs/guide/integrations.md` — de-personalise the budget-reality section.
  - `deploy/claude-station.service` — `%h/projects/claude-station` → `%h/projects/orchard`.
  - machine-local (not orchard-tracked): `/home/<user>/projects/orchard/CLAUDE.md`, `/home/<user>/CLAUDE.md` v2→v4.
- **Verified:**
  - Injection render through templates.ts (server path): overlay PRESENT → budget fact ($20 +
    rolling 5-hour + SCARCE) still injected, operator-local source status `applied`; overlay ABSENT
    (path to nonexistent file) → ZERO personal strings, routing core still injected, operator-local
    not applied. Public `routingSection()` core has no `$20`/`ABUNDANT here`/`for this user`.
  - `git grep` over tracked `docs/prompts/*` + `docs/guide/*`: all leak strings GONE. Remaining
    tracked occurrences: 2 (append-only `FEAT-060` + its archive) — reported, out of scope.
  - `npm run verify:methodology-sync` → OK, 5 files in-sync (listed).
  - Regression guard: PASS live; MUST-FAIL proven — a synthetic `this user runs Linux … $20 ChatGPT
    Plus plan` line appended to a mirror → exit 1 with 3 named hits; tracked-`*.local.md` branch input
    shown empty on clean tree (same FAIL-exit path).
  - `npm run gate` → PASS (exit 0): leak-gate, check-nul, prompt-privacy, typecheck all PASS.
  - Anti-regression: verify:routing-inject 18/18, verify:local-conventions 18/18, verify:wa-injected
    10/10, verify:onboard 57/0, verify:feat-089 35/0 — all rc=0.
- **Still open / handoff:** (1) `verify:routing` (headless-Chromium URL/scroll nav test over the live
  `~/.claude` store) timed out in-browser — unrelated to this diff (no UI/routing-URL code touched);
  re-run on a clean HEAD recommended. (2) `verify:feat-097` fails in its OWN `setup()` git calls,
  blocked by the agent git-write guard — environmental, not this change. (3) An independent clean-room
  verify pass is warranted (this touches session injection + privacy): generation must not be its own
  only verifier. (4) OUT OF SCOPE / reported: append-only tickets (`FEAT-060`, `FEAT-037`, etc.) and
  prior git history still contain the budget/plan prose; that is FEAT-049's fresh-history publish job,
  not an injection-time fix. (5) Operator on a FRESH clone must re-create `docs/prompts/OPERATOR.local.md`
  from the committed `.example` — the overlay is gitignored by design.
- **Symptom of a deeper design flaw?** Partial yes — "a personal fact can ride in a product-agnostic
  published doc, and nothing but a human eye catches it" is the class. Mitigated structurally by the
  `prompt-privacy` gate (publication-bound docs) + the overlay seam, not escalated to ARCH (the
  invariant is now enforced mechanically for the injected docs).

### 2026-10-09 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 911b54e2-6795-4ad5-af7b-ac0c5943d9fd — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-09 — agent (fixing round 2, Opus 4.8) — addresses BROKEN run 911b54e2
- **Both breaks confirmed, root-caused, fixed structurally in `scripts/check-prompt-privacy.mjs`
  (+ byte-identical `.orchard/check-prompt-privacy.mjs`).** Break 1: round-1 matched LINE-BY-LINE,
  but the pre-scrub paragraph wraps a newline ("…a $20 ChatGPT\nPlus plan on rolling 5-hour
  windows"), so `$N ChatGPT Plus plan` could not match and nothing matched "Claude-abundant,
  GPT-scarce". Break 2: a 6-file allow-list left README, the worker template, the `.example`
  overlay and the rest of `docs/guide/*` unscanned.
- **Design chosen (hypothesis in charter confirmed — enumerated patterns lose; went structural per
  WA §N):**
  (a) *Scan scope* — ENUMERATE from the repo (`git ls-files` tracked **+** `--others
  --exclude-standard` untracked-not-ignored, so the still-untracked `worker.md` is covered) and
  DENY-list only non-prose surfaces, each justified in the script header: `src/ public/ scripts/
  .orchard/ .githooks/ deploy/` + root config (product code legitimately carries the vocabulary —
  `fork.ts` "This user dual-boots…", `app.js` "5-hour window" — scrubbing those is FEAT-049's
  publish job); `docs/bugs/` (append-only history, FEAT-049); `docs/analysis/` + `docs/PROVIDERS.md`
  (dated internal analysis / public ChatGPT-Plus PRICING reference — legit `$20/mo`, `5-hour`); the
  guard itself; `*.local.md` (the gitignored overlay — a committed one is caught by assertion 1).
  Result: **28 publication-bound files** scanned, auto-growing. *Whole-tree sweep was REJECTED with
  evidence* — `5-hour`/`dual-boot` are core product vocab and flood false positives (the charter's
  "too many false positives" escape; a `24-hour window` example in `TICKET-WRITING.md` tripped an
  early draft and was fixed by anchoring on `rolling N-hour`).
  (b) *Patterns* — matched over NORMALIZED (markdown + whitespace incl. newlines) sliding 1–3 line
  windows (fixes break 1), from two sources: a GENERIC fallback of PERSONAL-ASSERTION patterns only
  (never bare "abundant"/"scarce"/model `$N`/"dual-boot …setup" conditional, all of which appear
  legitimately in the de-personalised docs — verified clean on the 28), and OVERLAY-DERIVED
  marker-anchored n-grams: when `OPERATOR.local.md` exists it IS the fact list, so signatures are
  promoted only when anchored on a concrete datum (currency, `N-hour`, `dual-boots`, dated stamp),
  so the overlay's deliberately-shared generic routing prose ("plan review, adversarial review of
  finished work") is NEVER promoted and never false-fires on ROUTING.md. 11 signatures derived here.
- **Verified with real commands (edit → run → restore; tree left as inherited):**
  - CLEAN tree → `PROMPT-PRIVACY: PASS — scanned 28 … 11 overlay-derived signature(s) …` exit 0.
  - MUST-FAIL A (real pre-scrub prose back into `docs/guide/integrations.md`) → exit 1, 17 hits
    incl. "Capacity here is", "Claude-abundant", "GPT-scarce", "$N ChatGPT", "rolling N-hour", and
    derived "rolling 5-hour windows".
  - MUST-FAIL B (personal assertion into `README.md`) → exit 1 ("abundant here", "for this user").
  - MUST-FAIL C (personal assertion into the untracked `.claude/agents/worker.md`) → exit 1 ("this
    machine dual-boots", "dual-boots Linux + Windows", derived "machine dual-boots linux") — proves
    the untracked-not-ignored enumeration.
  - `npm run gate` → **PASS exit 0** (leak-gate, check-nul, prompt-privacy, typecheck).
- **Residual / honesty:** reworded leaks that preserve no generic pattern and no overlay marker-gram
  still escape (inherent to pattern guards; the derived set auto-grows as the operator writes new
  overlay facts). `docs/analysis/` + `docs/PROVIDERS.md` carry real `$`/`5-hour` prose by design and
  are excluded — residual publish-scrub surface for FEAT-049, same bucket as the ticket history.
  regressed-from: FEAT-172 round-1 (this fixes the two breaks that round-1's enumerated guard left).
- **High-stakes:** privacy + regression-prone (round-1 broke) → an independent clean-room verify
  pass is warranted before close; generation is not its own only verifier.
- **Changed (all unstaged; user commits):** `scripts/check-prompt-privacy.mjs`,
  `.orchard/check-prompt-privacy.mjs` (byte-identical). No other files modified by this lane.

### 2026-10-09 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run dfde14a1-7099-4968-aadf-f14f170a7b44 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-09 — agent (fixing round 3, Opus 4.8) — addresses BROKEN run dfde14a1
- **Break A (vacuity) FIXED — fail closed.** `listCandidates()` used to `continue` on a
  failed `git ls-files`, so a non-repo tree (or git error) scanned 0 files and exited 0. It now
  returns `{ok,reason,files}`; the caller exits 1 with a clear message when enumeration fails OR
  yields 0 candidates. MUST-FAIL proof (scratch non-repo dir, real pre-scrub prose present):
  reconstructed pre-fix guard → `PASS — scanned 0 … EXIT 0` (the vacuity); fixed guard, same dir →
  `FAIL (fail-closed) — git file enumeration failed … EXIT 1`. Clean real tree still passes
  (`scanned 28/29 … EXIT 0`). The 0-candidate branch shares the proven exit path (verified by
  inspection; a live empty-repo test needs `git init`, blocked by the git-write guard).
- **Break B (evasion) — RESCOPED per WA §N two-break design review; NO new rephrasing patterns
  added.** CONTRACT now written into the guard header AND here: THREAT MODEL is an ACCIDENTAL
  reintroduction of KNOWN personal text (re-sync an old canonical, copy from the overlay, paste old
  guide prose). The guard catches (0) fail-closed, (1) normalized sentences / marker-anchored
  n-grams DERIVED from `OPERATOR.local.md` (line-wrapped included), (2) the specific known pre-scrub
  texts, (3) a small generic personal-ASSERTION fallback. OUT OF SCOPE by design: deliberately
  reworded personal prose preserving no generic pattern and no overlay marker-gram — author's
  responsibility under WA §P. Next verifier: attack THE STATED CONTRACT, not an imagined one.
- **Rescope reviewed by a non-author (step 3).** `npm run dispatch -- --provider anthropic`
  (read-only), session `0e762186-c2a4-4d86-9275-fe7c185c2389`, given the threat model + gate code +
  both break reports, NOT my rationale. VERDICT `RESCOPE-MISSES-PATH`: it named ONE realistic
  ACCIDENTAL path — `.orchard/CONVENTIONS.md` is git-TRACKED, PUBLISHED and INJECTED into every
  session (via `resolveConventionsFile()`, preferred over legacy `docs/CONVENTIONS.md`), yet the
  blanket `.orchard/` deny-prefix excluded it, so overlay prose copied into it would publish unseen.
  Its "lesser notes" were explicitly flagged NOT the break. Verified the claim (tracked + injected).
- **Fixed that path.** `denied()` now scans `.orchard/*.md` PROSE (the injected conventions doc)
  while still denying `.orchard/` code/config (`.mjs/.json/hooks/lib`) and `.orchard/bugs/`
  append-only history; header updated to match. Scan set 28 → 29. MUST-FAIL: pasted the reviewer's
  verbatim overlay prose into `.orchard/CONVENTIONS.md` → `FAIL … 18 leak(s) … EXIT 1` (generic +
  derived hits); restored byte-identical to HEAD, clean tree → `EXIT 0`. Reviewer found only ONE
  break, so per charter I fixed it and did not stop.
- **`npm run gate` → PASS exit 0** (leak-gate, check-nul, prompt-privacy, typecheck).
- **High-stakes:** privacy + regression-prone (broke rounds 1 & 2) → an independent clean-room verify
  pass against the STATED CONTRACT is warranted before close; generation is not its own only verifier.
  regressed-from: FEAT-172 round-2 (round-2's enumeration `continue` was the vacuity hole; its
  blanket `.orchard/` deny hid the injected conventions doc).
- **Changed (all unstaged; user commits):** `scripts/check-prompt-privacy.mjs`,
  `.orchard/check-prompt-privacy.mjs` (byte-identical). No other files modified by this lane.

### 2026-10-09 — dispatch anthropic clean-room + live adjudication
- **Verification recorded:** dispatch anthropic run ff31f61a-c44f-4d80-91c0-4796638c5efc — VERDICT: BROKEN — TWO-BREAK: design review, do NOT patch. New-path FALSE-POSITIVE: dated-stamp derived marker over-matches shared dates (overlay 'as of 2026-08-05' hits real ROUTING.md banner; verifier run b7b91e2c9765 exit1 vs 0). Props 0-4 HOLD on real artifacts; real tree PASSES. See Activity log 2026-10-09.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-09 — verify (round 3, independent clean-room re-attack) — VERDICT: BROKEN (two-break: design review)
- **Commissioned** scripts/independent-verify.mjs (separate process), `--working-tree` (the guard
  files scripts/check-prompt-privacy.mjs + .orchard/check-prompt-privacy.mjs are UNTRACKED, so only
  a working-tree snapshot carries the fix). Provider **anthropic** (session
  `ff31f61a-c44f-4d80-91c0-4796638c5efc`): OpenAI was tried first and FAILED a real tiny call —
  `dispatch failed [quota-window]` (retry 9:56 PM) — so cross-provider decorrelation was
  unavailable this round; same-provider noted.
- **Structural note:** the clean room strips all of `docs/` (PROSE_ROOTS=['docs']) and the overlay
  is gitignored, so the gate's own scanned prose AND the overlay it derives signatures from are
  BOTH absent in-room; with no `.git` the gate fail-closes. The verifier therefore built a scratch
  git repo + SYNTHETIC fixtures (it reported them synthetic). Because a clean room cannot test this
  gate against real artifacts, I ran the real-artifact, git-dependent checks on the LIVE tree myself
  (labeled mine) for properties (0)-(4).
- **Properties (0)-(4) HOLD on the REAL artifacts (my live-tree checks):**
  - (0) fail-closed: gate copied into a non-git scratch dir → `FAIL (fail-closed) … not a git
    repository` EXIT 1 (empty-set branch shares the same `if(!scan.ok) exit 1` path).
  - (1)+(3) line-wrap + known pre-scrub: real pre-scrub paragraph pasted LINE-WRAPPED mid-sentence
    into real docs/guide/integrations.md → EXIT 1; "Capacity here is" matched across a 161→162 line
    break and derived "rolling 5-hour windows" across a 164→165 break (newline folding works); all
    known texts (Claude-abundant, GPT-scarce, $N ChatGPT, rolling N-hour, dual-boots Linux+Windows,
    Anthropic Max) caught.
  - (2) .orchard/*.md scanned: real overlay content pasted into real .orchard/CONVENTIONS.md → EXIT
    1 with 11 overlay-derived + 15 generic hits on that file (confirms the round-3 fix).
  - (4) clean real tree → `PASS — scanned 29 … 11 overlay-derived signature(s)` EXIT 0. Both
    injected files restored byte-identical; post-restore gate PASS.
- **BREAK found by the independent process — NEW PATH (over-match / false-positive):** verifier run
  `b7b91e2c9765` (case `clean-with-overlay`): a SYNTHETIC overlay headed `## Provider capacity (as
  of 2026-08-05)` with NO leak pasted anywhere made the gate EXIT 1 (expected 0). The overlay-derived
  "dated stamp" marker (`/^20\d\d(-\d\d){0,2}$/`) promoted the bare-date n-gram `as of 2026-08-05`,
  which then matched the REAL docs/prompts/ROUTING.md staleness banners (lines 4 and 64, "as of
  2026-08-05") — a genuinely-clean published doc flagged as leaking overlay prose. Dates are shared
  vocabulary between the overlay and published docs, so this is a realistic property-(2)-vs-(4)
  conflict, NOT contrived.
- **Why this is BROKEN but the real tree still PASSES:** the REAL overlay dates its section as
  `— dated 2026-08-XX` (derived grams "dated 2026-08-XX"/"scarce dated 2026-08-XX"), while ROUTING.md
  uses "as of"/"researched" — different surrounding words, so no collision TODAY. The pass is
  phrasing-dependent, not date-dependent: a natural overlay phrasing ("as of <date>") that any scanned
  doc also uses trips a false positive and blocks a legitimately-clean publish.
- **Direction is NEW vs rounds 1-3** (line-wrap miss, allow-list gap, vacuity fail-open, blanket
  .orchard deny — all UNDER-match/fail-open). This is OVER-match/false-positive → per WA §N / the
  two-break stop: **report "two-break: design review", do NOT propose a fix.** Design question for
  the next pass: should a bare date be a promotion anchor at all? Options to weigh — require a
  co-located personal datum, drop dated-stamp anchoring, or exclude generic date-framing tokens
  ("as of", "researched", "dated"). Not fixed here by design.
- **Harness verdict caveat:** the dispatch's own composed verdict was INVALID — I supplied no
  `--test-file`, so the verifier's FIXER-TEST citation slot (which must cite a harness-supplied
  fixer-test command) could not be satisfied; its substantive adversarial runs were recorded and
  are the evidence above. Typed verdict recorded as `broken` (keeps the ticket open for design
  review); work_state left in_progress.
- **High-stakes (privacy, regression-prone, now a NEW break direction):** an independent clean-room
  pass against the real artifacts is structurally limited here (room strips the gate's inputs), so
  the live-tree real-artifact checks above are the load-bearing evidence and are MINE, not an
  independent provider's. A second fresh-context reviewer of the dated-stamp design decision is
  warranted before any round-4 fix.
- **No files changed by this lane** (verification only; the two injected-then-restored files are
  byte-identical to their pre-test state). Scratch artifacts under ~/.local/state/.../scratch (kept
  clean room `cleanroom-verify-miziUv`, record `cleanroom-record-jerL5i`) and /tmp/pp-* are
  disposable.
