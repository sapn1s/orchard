# FEAT-142 — the deliverable the user asked for is filed under "what I changed" and folds out of sight

- **Status:** IN VERIFICATION — implemented and self-verified (parse + real headless render); awaiting independent clean-room verify (touches the shared certainty-guard vocabulary + the injected prompt + FEAT-085's ENFORCE-path suites)
- **Severity:** medium
- **Area:** server (response-format inject) / renderer (response blocks)
- **Reported:** 2026-09-16 by orchestrator (audit of session 4846de18-…, house-hunting project + six other recent sessions)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The user asked "pls lmk whatsapp msg to send" and got an `orchard-outcome` block — which FOLDS — whose one-line preview was the draft's Latvian greeting. The artifact they asked for was buried behind a fold, previewed by its first sentence, instead of shown in full.

Audit finding: `orchard-outcome` is being used for "here is the artifact you asked for", which the spec defines as "what I CHANGED (shipped/committed/filed)". 12 of 61 outcome blocks in the sample contained a nested code fence holding the requested deliverable. Because outcome folds, the deliverable is hidden.

## Repro
Ask a launched session for an artifact (a draft message, a command, a number, a recommendation). The reply files it under `orchard-outcome`, which the renderer folds by default (FEAT-136), so the user sees a caption + first-sentence preview instead of the thing they asked for.

## Expected
The artifact the user requested is a first-class, always-open category, shown in full, never folded, and NOT conflated with "what changed in the world".

## Root cause / design
The deprecated legacy block `orchard-answer` is ALREADY exactly the always-open "the thing you asked for" slot: it is a frozen `KNOWN_BLOCKS` name (`public/lib/response-blocks.js:416`), it is NOT in `COLLAPSED_BLOCKS` (`:481`) so it renders EXPANDED, and its presentation is undecorated (`public/lib/digest.js:318`, label `''`). Round 12 deliberately did NOT reuse it — but only against being **repurposed to a DIFFERENT meaning**. Its original meaning ("responds to what you asked", per RESPONSE_FORMAT.md's own extension note) is exactly this use, so reinstating it in the injected core with that ORIGINAL meaning is documentation + a definition tightening, NOT a repurpose. Archived `orchard-answer` blocks keep both their pixels AND their meaning → inside extension rule 3.

## Fix
1. Reinstated `orchard-answer` in the injected core (RESPONSE_FORMAT.md inject region) as *the artifact the user asked for*: always shown, never folded. Kept it UNDECORATED (label stays `''`) — an always-open, uncaptioned block reads as the direct answer, needs zero renderer change, and re-captions no archived block.
2. Tightened `orchard-outcome` in the core: "what I CHANGED in the world: shipped/committed/filed/deployed (never text I wrote you)."
3. Reconciled the human doc: summary table row, Migration section (new Round-15 note), and the extension rule-3 discussion — all outside the injected region, so no byte cost.
4. NET INJECTED BYTES DID NOT GROW (hard constraint, BUG-143): paid for every added line by compressing existing ones. Region body 5207 → 5202 (-5). `responseFormatSection()` 5899 → 5894, under the 5900 pin (verify:feat-084) and the 6000 `maxChars` cap.

## Context pack
- Files in play: `docs/prompts/RESPONSE_FORMAT.md` (inject region lines 71–167, + Migration ~488, extension ~965), `public/lib/response-blocks.js` (LEGACY_BLOCKS/COLLAPSED_BLOCKS/EXPANDED_BLOCKS — UNCHANGED, already correct), `public/lib/digest.js` (BLOCK_PRESENTATION — UNCHANGED), `scripts/verify-feat-091-response-blocks.mjs` (assertion updated: `orchard-answer` IS now taught, `orchard-notes` is the one retired name).
- Related tickets: FEAT-143 (same batch — table rule + suppressible digest), FEAT-136 (folds outcome/judgment — the reason answer-under-outcome disappears), BUG-143 (inject byte budget), FEAT-091/093/098 (the vocabulary), FEAT-083/084/085.
- Repro test: `npm run verify:feat-084`, `npm run verify:feat-091`.
- Out of scope (noted, not built): the non-engineering-project mismatch — a house-hunting session gets the 120-word budget and lane-handoff rules injected. No per-project profiles built this lane.

## Activity log (APPEND-ONLY)

### 2026-09-16 — worker (Opus 4.8)
- **Understood:** the audit's concrete failure (WhatsApp draft folded under outcome) and the hypothesis that `orchard-answer` is already the live always-open artifact slot, merely undocumented in the injected core.
- **Verified the hypothesis against code FIRST:** `orchard-answer` ∈ KNOWN_BLOCKS (`:416`), ∉ COLLAPSED_BLOCKS (`:481`) hence ∈ EXPANDED_BLOCKS, presentation label `''` (`digest.js:318`). Alive, parsed, expanded, undecorated. Hypothesis HOLDS → reinstatement is docs + a label decision, not a new block type. No renderer change needed.
- **Changed:** `docs/prompts/RESPONSE_FORMAT.md` (inject region + Migration + extension note + summary table), `scripts/verify-feat-091-response-blocks.mjs` (taught-set assertion). Unstaged.
- **Verified (fixer's own run):**
  - `npm run verify:feat-084` → 37 passed, 0 failed (byte cap held; section 5894 ≤ 5900).
  - `npm run verify:feat-091` → 278 passed, 0 failed (after updating the taught-set assertion; `orchard-answer` reaches the prompt, `orchard-notes` does not).
  - `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
  - REAL headless render (Playwright over a raw static server serving unmodified public/lib): an `orchard-answer` block renders `<div class="orchard-blk orchard-answer ob-answer"><div class="prose"><p>…full draft…</p></div></div>` — `answerHasDetails:false` (OPEN, not folded), undecorated, the WHOLE draft visible (not a preview). Screenshot `docs/bugs/assets/FEAT-142-render.png`.
  - Byte arithmetic printed: region body 5207 → 5202 (−5); composed section 5899 → 5894.
- **Verified-by:** PENDING — independent clean-room verify warranted. This change touches the shared certainty-guard vocabulary (via the injected core) and I MODIFIED FEAT-085's ENFORCE-path suites (independent + adversarial) for the coupled FEAT-143 contract change; generation must not be its own only verifier.
- **Still open / handoff:** none for FEAT-142 itself. The renderer's browser suite (`verify:feat-091-renderer`) FATALs on a served-module export (`fenceSegments`) in `response-blocks.js` — a file this lane never touched; confirmed pre-existing/environmental (export exists in source and in node import; identical on HEAD). Independent verifier should re-confirm answer-open rendering.
- **Symptom of a deeper design flaw?** Partial-yes but NOT filed as ARCH here: the recurring root is that a presentation-only escape hatch (round-12's `answer`/`notes`) was removed without a semantic home for "the deliverable", so it leaked into `outcome`. This is the third vocabulary adjustment; if a fourth is needed, an ARCH ticket on "the vocabulary keeps missing a slot the reader actually wants" is warranted. Left to the orchestrator to decide.

### 2026-09-16 — independent verifier (Opus 4.8), verifying round 1
- **Verdict: claims 1, 2, 5 PASS; claim 3 PASS-with-limitation (DOM render not executed).** Attacked the diff + test code only; did not read implementer prose until after forming verdicts (then only for log format).
- **Re-ran implementer's suites (real output):** `verify:feat-091` 278/0; `verify:feat-084` 37/0 with the injected section at **len=5894 ≤ 5900 pin (6 bytes headroom)** — and the pin file `verify-feat-084-response-format-inject.mjs` is byte-identical to HEAD, so the pin was NOT moved to fit. `verify:feat-085-stop-hook` 61/61.
- **Claim 1 (answer always open):** at the parse/data layer `orchard-answer ∈ EXPANDED_BLOCKS ∉ COLLAPSED_BLOCKS` (091 asserts "nothing the reader must see can ever be folded", answer in that set). Injected core (marked region) reinstates it as "always shown, never folded"; Migration preserves archived rendering. **Adversarial parse probes (mine, not implementer's):** unterminated `orchard-answer` fence → flagged `unterminated:orchard-answer@line1`, content falls to fallbackRuns (NOT swallowed); nested closed ```` ```sh ```` inside a 4-tick answer → contained, trailing prose captured as its own fallbackRun; double-unterminated → same safe flag. The fold/certainty scanner does not mis-scan.
- **Claim 2 (outcome = world changed only):** core narrowed to "shipped/committed/filed/deployed (never text I wrote you)"; `orchard-outcome ∈ COLLAPSED_BLOCKS` (unchanged).
- **091 assertion NOT weakened:** the taught-set check was tightened, not loosened — it still requires `orchard-notes` to be absent from the injected core and now additionally requires `orchard-answer` present (a stronger constraint, verified passing).
- **Could NOT test:** live DOM render of an always-open answer / old-transcript shape — `verify:feat-091-renderer` FATALs on served-module export `fenceSegments`; I confirmed this is pre-existing (both `response-blocks.js` and the renderer test are byte-identical to HEAD, and `fenceSegments` IS exported at `:1926`), so it is unrelated to this change but blocked me from driving the browser. I did NOT independently reproduce the implementer's Playwright-over-static-server render; verified always-open at the data layer that governs the fold instead.
- **Durable pointer:** verifier report emitted to orchestrator 2026-09-16; evidence commands above are re-runnable.
