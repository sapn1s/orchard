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
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-11",
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
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a129ca-58ed-7130-a30e-bc34606fff08",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T07:10:48.860Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a129d7-55b9-7623-8be1-552f72c552a8",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T07:27:35.416Z",
      "author": "dispatch openai clean-room + live adjudication",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "NEW break (two-break: design review). Round-4 self-suppression FIXED. New contract-(1) gap: derivedSignatures() splits overlay by newline BEFORE norm, so a wrapped overlay marker yields NO signature and a verbatim copy passes SILENTLY. Confirmed on real tree. See Activity log 2026-10-11."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a129e8-0610-7d02-841e-fa2135d9f6f6",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T07:43:41.368Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a129f2-fce9-70f2-b630-a2fdaa354f1f",
      "verdict": "holds",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T07:56:27.214Z",
      "author": "dispatch openai clean-room + live adjudication",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Adjudicated HOLDS. Verifier sole BROKEN finding (NUL-byte .dat scanned, exit 1) is an OVER-match not a silent miss; fails severity bar; residual (header NUL-byte wording vs ext-only code, safe direction). 5 live-tree attacks held."
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

### 2026-10-11 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a129ca-58ed-7130-a30e-bc34606fff08 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — verify (round 4, independent clean-room re-attack)
- **VERDICT: BROKEN (new break path — two-break: design review):** - **Commissioned** scripts/independent-verify.mjs as a separate process, cross-provider
    **OpenAI** (author-provider anthropic to openai), run `01a129ca-58ed-7130-a30e-bc34606fff08`.
    A real tiny OpenAI call was confirmed FIRST (dispatch "PONG", exit 0) — not just `--check`.
    `--range ed92aff` (committed HEAD; chosen over `--working-tree` because a concurrent lane was
    mutating scripts/* in the live tree at 10:03, which --working-tree would have raced and pulled in).
    Gate code (scripts/check-prompt-privacy.mjs) plus a synthetic self-contained contract driver passed
    via `--test-file` (the round-4 fixer left no test file; the driver builds its own throwaway
    version-controlled scratch tree, installs the gate, and asserts all 4 properties — authored by this
    verify lane, declared synthetic). Requirement = the gate header CONTRACT only; no ticket prose or
    fixer reports passed.
  - **BREAK (NEW PATH) — CONFIRMED on the REAL tree with the REAL gate (my live-tree check, labeled
    mine; the in-room run used a read-only enumeration stub since in-room repo initialization was
    unavailable, so the real reproduction is MINE):** an overlay sentence copied VERBATIM into
    docs/prompts/ROUTING.md (or any WORKING_AGREEMENT*.md) is SILENTLY MISSED (exit 0), while the SAME
    sentence in README.md is caught (exit 1). Reproduced: overlay fact "Observatory tier Zephyr runs
    $91 quokka weekly here." pasted into README.md gave EXIT 1 (derived sigs "zephyr runs $91",
    "$91 quokka weekly"); the identical sentence in ROUTING.md gave "PASS … 5 overlay-derived
    signature(s)" EXIT 0. All files restored byte-identical; clean tree re-checked EXIT 0.
  - **Root cause (version-control-independent):** `loadPublicWords()` tokenizes the very files it scans
    (docs/prompts/ROUTING.md plus WORKING_AGREEMENT*.md) into the "shared public vocabulary" set that
    `distinctive()` excludes. Pasting overlay prose INTO one of those files promotes that prose's own
    tokens to "public words", so every derived n-gram over it has no distinctive token and is dropped,
    and the leak passes. This is a SILENT pass of a real leak (not a loud FAIL), which the round-4
    header's own RESIDUAL section says must never happen; it breaks contract property (2) ("a real
    overlay sentence copied into ANY in-scope published file … must be caught") for exactly the files
    loadPublicWords reads. The GENERIC fallback still catches the specific known pre-scrub facts, so
    this bites NEW overlay facts not covered by a hardcoded GENERIC pattern.
  - **regressed-from: FEAT-172 round-4** — the round-4 `distinctive()`/loadPublicWords mechanism, added
    to fix round-3's dated-stamp OVER-match, introduced this self-suppression UNDER-match.
  - **Properties otherwise HOLD on real artifacts (my live-tree checks, before finding the break):**
    (1) fail-closed EXIT 1 in a non-repo dir; (2-overmatch) a bare shared date "as of 2026-08-05" does
    NOT false-fire on the clean ROUTING banners (round-3 fix holds); (2-catch) overlay prose caught in
    docs/CONVENTIONS.md AND a fresh untracked .orchard/CONVENTIONS.md (proves .orchard/*.md scanned);
    (3) known pre-scrub prose caught across a hard line-wrap; (4) clean real tree PASS scanned 29.
  - **Two-break stop honored:** NEW break direction (self-referential publicWords poisoning) vs
    round-3's over-match, so reporting "two-break: design review", NO fix applied this lane. Design
    question for the next pass: loadPublicWords must derive shared vocabulary from a source that CANNOT
    contain leaked overlay prose (a pinned/committed baseline of the public docs, or the overlay's own
    tokens must not be self-excluded) — scanning a file for leaks while trusting that same file to
    define "non-leak vocabulary" is the structural contradiction.
  - **No files changed by this lane** (verification only; overlay/ROUTING/README/CONVENTIONS/
    integrations plus the gate were injected-then-restored byte-identical; the gate's temporary
    working-tree marker for the abandoned --working-tree plan was also restored to HEAD).
  - work_state left in_progress (BROKEN keeps the ticket open for design review).

### 2026-10-11 — agent (fixing round 5, Opus 4.8) — addresses BROKEN run 01a129ca
- **Break confirmed on the real tree, then fixed structurally.** Round-4's `loadPublicWords()`
  tokenized the published ROUTING.md + `WORKING_AGREEMENT*.md` into a "shared vocabulary" that
  `distinctive()` excluded — but those are the exact files the guard scans for leaks (and the files
  most likely to take a leak back on an old-canonical re-sync). Pasting an overlay sentence INTO one
  of them promoted its own tokens to "public", so every n-gram derived over it lost its distinctive
  token and was dropped: a SILENT pass (exit 0), while the identical sentence in README.md was
  caught. MUST-FAIL proof before the fix: synthetic overlay fact `Observatory tier Zephyr runs $91
  quokka weekly here.` added to the overlay, pasted into ROUTING.md → **exit 0 (the break)**; same
  sentence in README.md → exit 1.
- **Design decision: option (a) — no vocabulary may be derived from scanned content.** Removed
  `loadPublicWords()` and the `publicWords.has(tok)` exclusion entirely; `distinctive()` now rests
  ONLY on the fixed marker/date/STOPWORDS predicates. This also keeps round-3's `as of <date>`
  over-match fixed (a window of only framing + a bare date still has no distinctive token). Chose
  (a) over (b) (a pinned/hash-committed word list) because the REAL clean tree with the REAL overlay
  PASSES exit 0 under (a) — no false positive to force (b). Derived-signature count rose 5 → 10
  (shared-vocab tokens are no longer suppressed) with zero false fire on the real tree.
- **Verified with real commands (edit → run → restore byte-identical; tree left as inherited):**
  - (1) synthetic overlay fact pasted into docs/prompts/ROUTING.md → **exit 1** (was exit 0): hits
    `zephyr runs $91`, `runs $91 quokka`, `$91 quokka weekly`.
  - (2) same fact pasted into README.md → **exit 1** (same 3 derived sigs).
  - (3) overlay section headed `## Provider capacity (as of 2026-08-05)` with no leak → real tree
    **PASS exit 0** (round-3 over-match stays fixed; the bare date does not false-fire on the
    ROUTING banners).
  - (4) known pre-scrub paragraph line-wrapped mid-sentence into docs/guide/integrations.md →
    **exit 1** (17 hits incl. `Capacity here is`, `Claude-abundant`, `GPT-scarce`, `$N ChatGPT`,
    `rolling N-hour`, derived `rolling 5-hour windows` across the 162→163 line break).
  - (5) clean real tree → **PASS exit 0** (scanned 29; 10 overlay-derived signatures).
  - (6) gate copied into a non-git scratch dir → **FAIL (fail-closed) exit 1** (round-3 vacuity
    fix holds; empty-set branch shares the same `if(!scan.ok) exit 1` path).
  - (7) `npm run gate` → **PASS exit 0** (leak-gate, check-nul, prompt-privacy, typecheck).
  - All injected-then-restored files (overlay, ROUTING.md, README.md, integrations.md) diffed
    byte-identical to HEAD after each test; only scripts/check-prompt-privacy.mjs is modified.
- **`.orchard/` mirror:** `.orchard/check-prompt-privacy.mjs` does NOT exist in this working tree
  (the flat `.orchard/` layout is the onboarded-target deploy artifact, never committed here — only
  scripts/check-prompt-privacy.mjs is tracked and is what `scripts/gate.mjs` runs). There is no
  mirror copy to keep byte-identical this round; if the deploy mirror is regenerated it should be
  copied from the scripts/ source.
- **regressed-from: FEAT-172 round-4** — round-4's `distinctive()`/`loadPublicWords()` mechanism,
  added to fix round-3's dated-stamp over-match, introduced this self-suppression under-match.
- **High-stakes:** privacy + regression-prone (broke rounds 1-4) → an independent clean-room verify
  pass against the stated contract is warranted before close; generation is not its own only
  verifier. Note the structural limit prior rounds hit: a clean room strips docs/ and the gitignored
  overlay, so the gate's own inputs are absent in-room — the load-bearing checks are the live-tree
  real-artifact runs above.
- **Changed (unstaged; user commits):** `scripts/check-prompt-privacy.mjs`. No other files.

### 2026-10-11 — dispatch openai clean-room + live adjudication
- **Verification recorded:** dispatch openai/default run 01a129d7-55b9-7623-8be1-552f72c552a8 — VERDICT: BROKEN — NEW break (two-break: design review). Round-4 self-suppression FIXED. New contract-(1) gap: derivedSignatures() splits overlay by newline BEFORE norm, so a wrapped overlay marker yields NO signature and a verbatim copy passes SILENTLY. Confirmed on real tree. See Activity log 2026-10-11.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — verify (round 5, independent clean-room re-attack) — VERDICT: BROKEN (new break; two-break: design review)
- **Commissioned** scripts/independent-verify.mjs as a SEPARATE process, cross-provider **OpenAI**
  (author-provider anthropic → openai), run `01a129d7-55b9-7623-8be1-552f72c552a8`. A real tiny
  OpenAI call was confirmed FIRST (dispatch "PONG", exit 0). `--working-tree` (the round-5 fix is an
  unstaged edit to tracked scripts/check-prompt-privacy.mjs). Requirement = the gate-header CONTRACT
  only (extracted lines 2-117; no ticket prose, no fixer reports). `--test-file` = a SYNTHETIC
  self-contained contract driver authored by this verify lane (declared synthetic; builds its own
  throwaway git repos, copies the guard, asserts P0/P2/P3/P4/P5).
- **Round-4 self-suppression break is FIXED (my live-tree checks, labeled mine; real git tree, real
  files, edit→run→restore byte-identical):** the derived-ONLY signature `chatgpt plus $20/mo`
  (no GENERIC pattern matches that token order) is caught IDENTICALLY — 1 hit each, exit 1 — when
  pasted into REAL docs/prompts/ROUTING.md (line 150), REAL docs/prompts/WORKING_AGREEMENT.v4.md
  (line 637), and REAL README.md (line 39). No scanned file suppresses its own signatures;
  distinctiveness rests only on markers/dates/STOPWORDS (loadPublicWords is gone). Critical invariant
  HOLDS.
- **Other contract properties HOLD on real artifacts (my live-tree checks):**
  - (0) fail-closed: guard copied into a non-git scratch dir (real pre-scrub prose present) →
    `FAIL (fail-closed) … not a git repository` EXIT 1.
  - (3) known pre-scrub paragraph LINE-WRAPPED mid-sentence into REAL docs/guide/integrations.md →
    EXIT 1, 25 hits across lines 160-164 incl. "Capacity here is", "Claude-abundant", "GPT-scarce",
    "$N ChatGPT", "rolling N-hour", derived "rolling 5-hour windows" (scan-side newline folding works).
  - round-3 over-match stays fixed: overlay heading "## Provider capacity (as of 2026-08-05)" →
    clean real tree PASS EXIT 0 (no false-fire on the ROUTING "as of 2026-08-05" banners).
  - marker/date/stopword-only windows do NOT anchor: "## as of 2026-08-05 dated 2026-08-10" → [],
    "researched as of 2026-08-05" → [] (a distinctive word like "updated" legitimately still anchors).
  - clean real tree → PASS EXIT 0 (scanned 29; 10 overlay-derived signatures).
- **BREAK — NEW PATH (contract (1) violated; CONFIRMED on the REAL tree, my executed live check):**
  `derivedSignatures()` iterates `overlayText.split('\n')` and runs `norm()` on EACH LINE separately,
  so newline-folding is applied on the SCAN side but NOT on the DERIVATION side. An overlay fact whose
  marker wraps onto its own line therefore yields NO signature, and a verbatim copy of that fact into a
  published file passes SILENTLY. Reproduced on the real tree (overlay + README, byte-exact restore):
    - A: overlay `My Zephyr subscription costs\n$91.` + verbatim one-line README copy → **EXIT 0**
      (no signature derived; leak MISSED).
    - B: identical fact on ONE line in the overlay → signatures "subscription costs $91"/"costs $91"
      derived → **EXIT 1** (caught). The ONLY difference is a single newline in the overlay.
  This is a silent pass (exit 0) of a verbatim overlay fact — exactly the "line-by-line cannot see
  wrapped prose" failure class the guard's OWN header (round-1 break 1) says it fixed by folding
  newlines; the fix was applied to the scan side only, leaving the derivation side line-by-line. It is
  NOT a declared residual (not rephrasing, not a generic-overlay false positive).
- **Independently surfaced by the OpenAI verifier too** (FINDING: "derivedSignatures splits the overlay
  before normalization: 'My Zephyr subscription costs\n$91.' produces zero signatures … removing only
  that newline makes the guard reject it"). The verifier could NOT execute it in-room — the agent
  git-write guard (FEAT-135) blocked the driver's scratch `git init` INSIDE the codex clean room — so
  its finding was code-reasoning; the EXECUTED real-artifact reproduction above is MINE and load-bearing.
- **Harness-composed verdict was INVALID** (the FIXER-TEST citation was a stand-in: no harness-supplied
  fixer test exists, and the driver could not run in-room due to the git block). Typed verdict recorded
  as **BROKEN** on my confirmed executed real-tree repro, keeping the ticket open. work_state in_progress.
- **Two-break stop honored:** NEW break direction (derivation-side newline asymmetry) vs round-4's
  self-suppression → reporting "two-break: design review", NO fix applied this lane. Design question for
  the next pass: the derivation must fold newlines like the scan side (derive over sliding line-windows
  of the normalized overlay, or norm the whole overlay before splitting into token n-grams), so a
  wrapped overlay fact is promoted to a signature symmetrically with how the scan matches it.
- **High-stakes** (privacy; regression-prone — broken rounds 1-5): an independent clean-room pass is
  structurally limited here (the room strips docs/ + the gitignored overlay AND the git-write guard
  blocks in-room scratch git init), so the live-tree real-artifact checks above are the load-bearing
  evidence and are MINE, not an independent provider's executed runs. A second fresh-context review of
  the derivation-side-newline design decision is warranted before any round-6 fix.
- **No files changed by this lane** (verification only; overlay/ROUTING/WA/README/integrations plus the
  guard were injected-then-restored byte-identical — every restore verified with `cmp`). Scratch driver
  + requirement under /tmp/ppv5 (synthetic, disposable); clean room/record under
  ~/.local/state/claude-station/scratch are disposable.

### 2026-10-11 — agent (fixing round 6, Opus 4.8) — addresses BROKEN run 01a129d7
- **Break confirmed on the real tree first (must-FAIL before the fix):** with the round-5 guard,
  appending `My Zephyr subscription costs⏎$91.` (wrapped) to the real overlay and the verbatim
  one-line copy `My Zephyr subscription costs $91.` to README → **PASS exit 0** (leak MISSED). Root
  cause as reported: `derivedSignatures()` did `overlayText.split('\n')` and `norm()`-ed each line
  separately, so the marker `$91` landed alone on its own line and anchored no n-gram — while the
  scan side folded newlines. Third break of the line-structure class (round 1 scan-side, round 5
  derivation-side).
- **Fix: REDESIGN with ONE chokepoint (design-review decision).** New `tokenize(text) -> token[]`
  folds a WHOLE document (markdown + ALL whitespace incl. newlines + sentence punctuation, case-
  folded; `$`/digits/`/`/`+`/plain-hyphen preserved) into a flat token stream. BOTH the overlay
  derivation AND every candidate-file scan AND the known pre-scrub prose now go through it.
  Signatures and matching are n-grams over token streams; `stream()`/padded-containment match on
  token boundaries. **Deleted** the old `norm()`, the `split('\n')` derivation, and the sliding 1–3
  line-window scan — NO line splitting or line window remains in the matching path (`lines` is kept
  ONLY for best-effort human-readable `file:line` reporting, never a match decision). Distinctiveness
  unchanged: markers/dates/STOPWORDS only, nothing derived from scanned content (round-4/5 invariant
  held).
- **regressed-from: FEAT-172 round-5** (same class as round-1 break 1).
- **Verified with real commands (edit → run → restore byte-identical, every restore `cmp`-checked;
  only scripts/check-prompt-privacy.mjs modified):**
  - (1) verifier repro — wrapped overlay marker + verbatim 1-line README → **exit 1** (was exit 0);
    derives `subscription costs $91` / `costs $91`.
  - (2) same fact wrapped on the SCAN side (overlay 1-line, README wrapped mid-fact) → **exit 1**.
  - (3) wrapped overlay fact pasted into docs/prompts/ROUTING.md → **exit 1**.
  - (4) known pre-scrub prose line-wrapped mid-sentence into docs/guide/integrations.md → **exit 1**
    (GENERIC `capacity here is` / `claude-abundant` / `gpt-scarce` / `$N chatgpt` / `rolling N-hour`
    all fire across the folded wraps).
  - (5) overlay headed `## Provider capacity (as of 2026-08-05)` with no leak → clean real tree
    **PASS exit 0** (round-3 over-match stays fixed; bare date never anchors).
  - (6) clean real tree with the real overlay → **PASS exit 0** (scanned 29; derived sigs 10→11, the
    extra one being a formerly-wrapped overlay marker now covered; zero false fire).
  - (7) guard copied into a non-git scratch dir → **FAIL (fail-closed) exit 1** (round-2 vacuity fix
    holds).
  - `npm run gate` → **PASS exit 0** (leak-gate, check-nul, prompt-privacy, typecheck).
- **High-stakes** (privacy; regression-prone — broke rounds 1,5,6 on the same line-structure class):
  an independent clean-room verify pass against the gate-header contract is warranted before close.
  Known structural limit (prior rounds): a clean room strips docs/ + the gitignored overlay AND the
  FEAT-135 git-write guard blocks in-room scratch `git init`, so the load-bearing evidence is the
  live-tree real-artifact runs above (mine). The redesign removes an entire seam rather than patching
  one, so the next re-attack should probe the chokepoint itself (does tokenize() leave ANY stage
  reasoning about lines?) rather than a new wrap position.
- **Changed (unstaged; user commits):** `scripts/check-prompt-privacy.mjs`. No other files.

### 2026-10-11 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a129e8-0610-7d02-841e-fa2135d9f6f6 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — verify (round 6, independent clean-room re-attack) — VERDICT: BROKEN (new break; two-break: design review)
- **Commissioned** `scripts/independent-verify.mjs` as a SEPARATE process, cross-provider **OpenAI**
  (author-provider anthropic → openai), run `01a129e8-0610-7d02-841e-fa2135d9f6f6`, model codex
  default. Real tiny OpenAI call confirmed FIRST (`dispatch --provider openai "…PONG"`, exit 0,
  thread 01a129e3). `--working-tree` (round-6 fix is an unstaged edit to tracked
  scripts/check-prompt-privacy.mjs). Requirement = the gate-header CONTRACT only (header lines
  2–127, leading ` * ` stripped; no ticket prose, no fixer reports). `--test-file` = a SYNTHETIC
  self-contained contract driver authored by THIS verify lane (declared synthetic; /tmp/ppv6-driver.mjs).
  Verdict-contract VALID (manifest-backed), verdict BROKEN. Record already carries the typed entry.
- **The round-6 line-structure REDESIGN HOLDS (my executed live-tree checks, labeled MINE; a scratch
  rsync copy of the real repo incl. the gitignored overlay + .git, real tree NEVER modified; each
  mutate→run→restore `cmp`-checked byte-identical):**
  - (P5) clean real tree + real overlay → PASS exit 0 (scanned 29; 11 overlay-derived sigs).
  - Round-5 repro (overlay marker WRAPPED onto its own line + verbatim 1-line scan copy) → **exit 1**
    (was exit 0 in round 5). Reverse (overlay 1-line, scan copy wrapped mid-fact) → exit 1. The
    tokenize() chokepoint is symmetric: same function on overlay-derivation AND every scanned file.
  - Markdown (`**`/backtick/`[link]()`), unicode (NBSP, smart quotes, em-dash), CRLF around a real
    overlay marker in the scan copy → all **exit 1** (folded identically on both sides).
  - Known pre-scrub prose line-wrapped mid-sentence into docs/guide/integrations.md → exit 1 (GENERIC
    fires across folded wraps). N-gram edge (file == exactly a 3-token sig, no trailing NL) → exit 1.
  - Round-3 over-match stays fixed: bare-date overlay heading `## … (as of 2026-08-05)` → clean PASS
    exit 0 (no false-fire on ROUTING banners). Fail-closed: guard in a non-git dir → exit 1.
  - Residual confirmed, NOT a break: a full-width `＄`-anchored overlay fact derives NO signature
    (isMarker is ASCII-`$` only) — symmetric, not in the real overlay; within the round-5 "fact not
    anchored on a recognized marker" residual envelope.
- **BREAK — NEW PATH (scan SCOPE, a different class than the round-1/5/6 line-structure breaks;
  CONFIRMED on the live tree, my executed repro):** `denied()` skips EVERY `*.local.md` file anywhere
  (regex `/(^|\/)[^/]*\.local\.md$/`), but `.gitignore` ignores ONLY `/docs/prompts/*.local.md` and
  the tracked-overlay assertion (1) globs ONLY `docs/prompts/*.local.md`. So the deny-list's own
  justification ("the gitignored real overlay is never published; a committed one → assertion (1)")
  is FALSE for any `*.local.md` OUTSIDE docs/prompts/: such a file is neither scanned NOR flagged.
  Reproduced on the real-copy tree (untracked, not-gitignored, so it IS in the
  `git ls-files --others --exclude-standard` publication-bound set):
    - `docs/guide/notes.local.md` with `Capacity here is Claude-abundant, GPT-scarce; $20 ChatGPT
      plan, rolling 5-hour windows.` → **PASS exit 0** (silent MISS).
    - Root `README.local.md`, same prose → **PASS exit 0** (silent MISS).
    - CONTROL: the IDENTICAL prose in `docs/guide/notes.md` (no `.local`) → **FAIL exit 1, 6 hits**.
      The only difference is `.local` in the filename.
  Known personal prose verbatim in a published/untracked `*.local.md` outside docs/prompts/ passes
  silently — squarely the "accidental reintroduction of known personal text" threat the guard owns,
  NOT a declared residual (not rephrasing, not framing+date-only).
- **Secondary finding (OpenAI verifier, code-reasoning; I did not reproduce on a real leading-space
  filename but confirmed the code path):** `listCandidates` does `.map((s) => s.trim())` on the
  NUL-split `git ls-files` output, mutating any filename with leading/trailing whitespace; the
  subsequent `readFileSync(ROOT/trimmed)` ENOENT→catch→continue silently skips it. Contrived
  filename, same silent-skip class as the primary break.
- **The OpenAI clean room could NOT execute the git-dependent cases** (checkout lacks .git and the
  FEAT-135 git-write backstop blocked the driver's in-room `git init`); it injected enumeration stubs
  and surfaced both findings by code-reasoning. The LOAD-BEARING evidence is the live-tree
  reproduction above (MINE), consistent with the structural limit prior rounds recorded.
- **Two-break stop honored:** NEW break direction (scan-scope `.local.md` deny vs assertion/gitignore
  scope) → reporting **two-break: design review, NO fix applied this lane.** Design question for the
  next pass: either (a) the `.local.md` deny must be scoped to exactly the gitignored overlay path(s)
  so a `*.local.md` elsewhere is scanned like any prose file, or (b) assertion (1) must flag ANY
  tracked/published `*.local.md` the deny-list excludes; and `listCandidates` must not `.trim()`
  git-reported filenames.
- **No files changed by this lane** (verification only). Scratch repo copy + driver + requirement
  under /tmp/ppv6-* are synthetic/disposable; clean room/record under
  ~/.local/state/claude-station/scratch are disposable.

### 2026-10-11 — agent (fixing round 7, Opus 4.8) — addresses BROKEN run 01a129e8
- **Both findings confirmed on the real tree, then fixed structurally.** PRIMARY (scan scope):
  `denied()` hand-denied EVERY `*.local.md` anywhere, but `.gitignore` ignores ONLY
  `/docs/prompts/*.local.md`. So any OTHER `*.local.md` (docs/guide/notes.local.md, a root
  README.local.md) — un-ignored, hence in `git ls-files --others --exclude-standard` — was skipped
  silently, publishing known personal prose unseen. SECONDARY: `listCandidates` ran `.trim()` on
  NUL-split `git ls-files` names, so a filename with leading/trailing whitespace became a wrong path,
  `readFileSync` ENOENT → catch → silent skip.
- **Design (structural, charter):** the scan set is EXACTLY what git would/could publish —
  `git ls-files -z` + `--others --exclude-standard`, NUL-split with NO `.trim()`. The overlay is
  left to GIT'S OWN ignore rules (it is gitignored, so absent from both lists); the blanket
  `*.local.md` deny is DELETED, so every other `*.local.md` is scanned like any prose file. The
  justified deny-list (src/public/scripts/.githooks/deploy, docs/bugs, docs/analysis, docs/PROVIDERS.md,
  .orchard code/history, binaries, the guard itself) is unchanged and NOT widened. New loud assertion
  (1): if a `/docs/prompts/*.local.md` path EVER shows up in the candidate set (git no longer ignoring
  it → it would be published with real holdings), FAIL LOUDLY — subsumes rounds 2/3's tracked-overlay
  check and also catches an un-ignored-but-untracked overlay.
- **regressed-from: FEAT-172 round-2** (the `*.local.md` blanket deny and the `.trim()` both entered
  with round-2's deny-list enumeration).
- **Verified with real commands (edit → run → restore byte-identical, every restore `cmp`-checked;
  only scripts/check-prompt-privacy.mjs modified):**
  - verifier repro `docs/guide/notes.local.md` with the known prose → **exit 1** (6 hits; was exit 0).
  - a filename with a LEADING SPACE containing the known prose → **exit 1** (6 hits; was silently
    skipped by the `.trim()`).
  - a scratch rsync copy of the REAL tree (incl. .git + the gitignored overlay) with the
    `/docs/prompts/*.local.md` ignore line removed → overlay now in `--others`, guard **FAILS LOUDLY
    exit 1** ("the operator-local overlay is NOT gitignored … would be published"); same scratch with
    the ignore intact → PASS exit 0.
  - clean real tree with the real overlay → **PASS exit 0** (scanned 29; 11 overlay-derived sigs).
  - guard copied into a non-git scratch dir → **FAIL (fail-closed) exit 1**.
  - round-6 proofs still hold: wrapped overlay marker + verbatim 1-line scan copy → exit 1;
    known pre-scrub prose line-wrapped mid-sentence into docs/guide/integrations.md → exit 1 (6 hits);
    round-3 over-match stays fixed — bare-date overlay heading → clean PASS exit 0.
  - `npm run gate` → **PASS exit 0** (leak-gate, check-nul, prompt-privacy, typecheck).
- **Header contract updated** to state: scan set = git ls-files + others, NUL-split, no trim; overlay
  handled by git ignore not a hand-deny; `*.local.md` outside docs/prompts/ is scanned; an overlay path
  appearing as a candidate is a loud FAIL.
- **High-stakes** (privacy; regression-prone — broke rounds 1-6): an independent clean-room verify pass
  against the gate-header contract is warranted before close. Known structural limit (prior rounds): a
  clean room strips docs/ + the gitignored overlay AND the FEAT-135 git-write guard blocks in-room
  scratch `git init`, so the load-bearing evidence is the live-tree real-artifact runs above (mine).
- **Changed (unstaged; user commits):** `scripts/check-prompt-privacy.mjs`. No other files. (There is
  no committed `.orchard/` mirror of this guard in the working tree; nothing to keep byte-identical.)

### 2026-10-11 — dispatch openai clean-room + live adjudication
- **Verification recorded:** dispatch openai run 01a129f2-fce9-70f2-b630-a2fdaa354f1f — VERDICT: HOLDS — Adjudicated HOLDS. Verifier sole BROKEN finding (NUL-byte .dat scanned, exit 1) is an OVER-match not a silent miss; fails severity bar; residual (header NUL-byte wording vs ext-only code, safe direction). 5 live-tree attacks held.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — verify (round 7, independent clean-room + live adjudication) — VERDICT: HOLDS
- **Commissioned** `scripts/independent-verify.mjs` as a SEPARATE process, cross-provider **OpenAI**
  (author-provider anthropic → openai), run `01a129f2-fce9-70f2-b630-a2fdaa354f1f`, model codex
  default. A real tiny OpenAI call was confirmed FIRST (`dispatch --provider openai "…PONG"`, exit 0,
  thread 01a129f1). Verified the ROUND-7 guard (an unstaged edit to tracked
  scripts/check-prompt-privacy.mjs) via `--repo <static rsync copy of the real repo> --working-tree`,
  chosen over `--working-tree` on the live tree because a concurrent lane is mutating scripts/* there.
  Requirement = the gate-header CONTRACT only (header lines 2–144; no ticket prose, no fixer reports).
  `--test-file` = a SYNTHETIC self-contained contract driver authored by THIS verify lane (declared
  synthetic; the round-7 fixer left no test file).
- **The git- and overlay-dependent attacks were run BY ME on the live tree, read-only** (a scratch
  rsync copy of the REAL repo incl. .git + the gitignored overlay; `git ls-files` is a read, so the
  guard runs unmodified; each mutate→run→restore `cmp`-checked byte-identical). The clean room strips
  docs/ + the overlay and the FEAT-135 git-write guard blocks in-room `git init`, so (as every prior
  round) the load-bearing evidence is these live-tree runs, labeled MINE:
  - (1) SCAN SCOPE — round-7 PRIMARY fix HOLDS: untracked-not-ignored `docs/guide/notes.local.md`
    with the known pre-scrub prose → **exit 1** (6 hits; was exit 0 in round 6). Control `docs/guide/
    notes.md` same prose → exit 1. SECONDARY fix HOLDS: a filename with a LEADING SPACE → **exit 1**
    (was silently skipped by the old `.trim()`). Deny-list AUDIT: of 1417 candidates, 29 prose files
    are scanned (README, CONTRIBUTING, docs/guide/*, docs/prompts/* incl. all WA versions + ROUTING,
    docs/CONVENTIONS.md, .orchard/*.md, .claude/agents/worker.md); the 642 denied prose files are all
    within header-justified buckets (docs/bugs 614 append-only history, docs/analysis 16 internal
    dated, scripts 11, public 1) + docs/PROVIDERS.md — NO outsider-facing/setup prose is hidden.
    Overlay candidates = 0 (correctly gitignored out of the candidate set).
  - (2) OVERLAY UN-IGNORED → loud FAIL: removing `/docs/prompts/*.local.md` from .gitignore in the
    copy put the overlay in `--others` → **exit 1** "the operator-local overlay is NOT gitignored …
    would be published". .gitignore restored byte-identical → exit 0.
  - (3) FAIL-CLOSED: guard in a non-repo scratch dir with a leak file → **exit 1** "FAIL (fail-closed)
    — git file enumeration failed". The zero-files branch shares the same `if(!scan.ok) exit 1` path
    (lines 239-240 → 388); not independently executed (in-room/agent `git init` is blocked).
  - (4) TOKENIZE SYMMETRY spot-check: a synthetic distinctive overlay fact whose marker WRAPS onto its
    own line + a verbatim one-line copy into README.md → **exit 1** (derives "subscription costs $73"
    etc.); overlay + README restored byte-identical → exit 0. (Round-6 redesign holds; one spot-check
    as scoped.)
  - (5) CLEAN tree with the REAL overlay → **PASS exit 0** (scanned 29; 11 overlay-derived sigs).
- **Verifier's sole finding adjudicated a RESIDUAL, not a break (verdict HOLDS):** the OpenAI
  verifier composed BROKEN on one case — a `sample.dat` built by prefixing a NUL byte to verbatim
  pre-scrub prose is SCANNED (exit 1), which it called a "binary-exclusion" violation. This FAILS the
  severity bar: it is an OVER-match (the guard CAUGHT the prose; exit 1), the OPPOSITE of a silent
  miss, on a contrived 2-file stubbed scan — not a realistic accidental reintroduction path. The
  header's "NUL-byte" wording vs the extension-only `BINARY_EXT` code is a cosmetic/documentation
  mismatch in the SAFE direction (the code scans MORE than the header says → it catches more, never
  misses). Confirmed on the real tree there is NO silent-miss exposure: all 9 binary-extension
  candidates (favicon.svg, scripts/fixtures/*.gz) are also denied by the src/public/scripts prefixes,
  so no publication-bound binary-ext file could hide a leak and be skipped.
- **Verdict: HOLDS.** Zero breaks (two-break stop not reached). The one verifier finding is a residual
  (over-match on a contrived NUL `.dat`; safe-direction header/code wording mismatch). All five scoped
  attacks held on real artifacts. Recommend the author optionally align the header's "NUL-byte" clause
  with the extension-only implementation (cosmetic, no behavior change).
- **No files changed by this lane** (verification only; every mutate→run→restore on the scratch copy
  `cmp`-verified byte-identical; the real tree was never modified). Requirement + synthetic driver
  under /tmp/ppv7; scratch repo copy under /tmp/ppv7-copy.*; clean room/record under
  ~/.local/state/claude-station/scratch are disposable.
