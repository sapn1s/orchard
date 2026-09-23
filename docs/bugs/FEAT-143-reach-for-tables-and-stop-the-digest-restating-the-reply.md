# FEAT-143 — reach for the table rendering that already exists, and stop the digest restating the reply

- **Status:** IN VERIFICATION — implemented and self-verified (real headless render + full FEAT-085 suite baseline diff); awaiting independent clean-room verify (Stop-hook ENFORCE-path behaviour change; I modified the independent + adversarial FEAT-085 suites)
- **Severity:** medium
- **Area:** server (response-format inject) / Stop-hook gate (`scripts/hooks/response-format-gate.mjs`)
- **Reported:** 2026-09-16 by orchestrator (same audit as FEAT-142)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
Two things from the audit:
1. **Zero markdown tables in 211 blocks across seven sessions**, despite property comparisons, cost breakdowns and running-total arithmetic written as comma-run prose. The renderer already draws GFM pipe tables (`public/lib/dom.js:250 tryTable`, invoked from the shared block-content renderer at `:359`); the gap is instruction, not capability.
2. **Digest-as-preamble**: 72/73 replies opened with a digest whose items paraphrase the prose immediately below. The user's complaint verbatim: it "unnecessarily splits things into decision and whatnot" — the `Decision`/`Done` group labels on every single reply.

## Expected
- Comparisons/breakdowns/line-items/per-option trade-offs go in a markdown table; the renderer draws them.
- The digest is a scan surface for a reply too long to scan, not a mandatory preamble: omit it for short replies and single-artifact replies, and never let an item merely paraphrase the prose that follows.

## Fix
1. **Table rule** added to the injected core: "Comparisons go in a table. Anything sharing attributes — candidate lists, cost breakdowns, before/after, per-option trade-offs — is a GFM pipe table (`| a | b |`, then `|---|---|`); the renderer draws it. Never a comma-run." Concrete shapes named so it fires.
2. **Digest made suppressible** in the core: "OMIT it for a short reply, or one whose body is a single artifact — it is a scan surface, not a preamble." Plus: "Items are NEWS, one sentence each; an item that paraphrases prose below is not news — cut it."
3. **Gate mirror kept in sync** (`scripts/hooks/response-format-gate.mjs`) — the local mirror of the digest instruction, so the hook does not punish the new behaviour:
   - Updated the parroted instruction wording ("When a reply is substantive, lead with … ; omit it for a short reply or one whose whole body is a single artifact").
   - Added a `digestOptional(parsed, text)` predicate: a MISSING digest is a defect only for a SUBSTANTIVE reply. Exemptions: SINGLE ARTIFACT (whole body is exactly one `orchard-answer` block, no loose prose) and SHORT (< 40 words, the readability minWords floor). A digest that is PRESENT but malformed/empty is still always flagged. The missing-digest push is deferred until blocks are parsed so the predicate can see them; falls back to a word count (biased toward "required") if block parsing fails.
4. NET INJECTED BYTES DID NOT GROW (shared with FEAT-142): region body 5207 → 5202 (−5); composed section 5894 ≤ 5900 pin.

Note on blast radius: in production `ORCHARD_STOP_HOOK_ENFORCE` is UNSET (grep of `src/`), so missing-digest is ADVISORY (never blocks) — the block path is exercised only by the ENFORCE=1 verifier suites. FEAT-137 length and FEAT-138 ask-ownership remain enforced independently and are untouched.

## Context pack
- Files in play: `docs/prompts/RESPONSE_FORMAT.md` (inject region), `scripts/hooks/response-format-gate.mjs` (`digestOptional` + deferred missing-digest push + summarise wording), `public/lib/dom.js:250/:359` (tryTable — UNCHANGED, already renders tables inside blocks), `scripts/lib/format-metrics.mjs` / `scripts/lib/readability.mjs` (word/short measures reused conceptually).
- Verifier changes: `scripts/verify-feat-085-stop-hook.mjs` (builder suite — updated short fixtures to substantive; added 3 positive cases: short→ALLOW, single orchard-answer→ALLOW, answer+substantive-prose→BLOCK), and — flagged for independence — `scripts/verify-feat-085-independent.mjs` + `scripts/verify-feat-085-adversarial.mjs` (mechanically updated the collateral "must-block" exemplars to substantive prose; the R1/R2 read-during-write incident assertions flipped to expect ALLOW, which the incident comment itself anticipated).
- Related tickets: FEAT-142 (same batch), FEAT-136 (fold), FEAT-138 (enforced length), FEAT-137 (ask ownership), BUG-155/BUG-169/BUG-167 (renderer — not regressed), BUG-143 (byte budget).
- Repro test: `npm run verify:feat-084`, `npm run verify:feat-091`, `node scripts/verify-feat-085-stop-hook.mjs`, `node scripts/verify-feat-085-independent.mjs`, `node scripts/verify-feat-085-adversarial.mjs`.
- Out of scope (noted): per-project budget profiles (the 120-word budget injected into a non-engineering session).

## Activity log (APPEND-ONLY)

### 2026-09-16 — worker (Opus 4.8)
- **Understood:** the digest-on-every-reply and no-tables findings; that the renderer already draws tables inside layer-2 blocks; that the gate mirror would "punish" a legitimately-omitted digest unless synced. Confirmed `ORCHARD_STOP_HOOK_ENFORCE` is unset in `src/` → missing-digest is advisory in prod.
- **Changed:** injected core (table rule + suppressible digest), the hook (`digestOptional` + deferred push + wording), and the three FEAT-085 suites. Unstaged.
- **Verified (fixer's own run):**
  - Real headless render (Playwright, raw static server, unmodified public/lib): a GFM pipe table INSIDE an `orchard-finding` block renders as `<table class="md-table">` with 3 rows (`tableCount:1, tableRows:3, tableInBlock:true`); a no-digest short reply renders cleanly (`cChildCount:1`, exact text preserved). Screenshot `docs/bugs/assets/FEAT-142-render.png`.
  - `node scripts/verify-feat-085-stop-hook.mjs` → 61/61 (incl. the 3 new suppression cases).
  - **BASELINE DIFF (must-FAIL discipline):** built a HEAD-hook + HEAD-verifier baseline tree and diffed.
    - independent: baseline 56/3 fail {1.10, R1×2}; after fix 59/1 fail {1.10}. My change REMOVED the 2 pre-existing R1 failures (flipped to the now-correct ALLOW) and added none. The remaining 1.10 is pre-existing (HEAD also BLOCKs — FEAT-138 length enforcement on a 61-line reply, unrelated).
    - adversarial: baseline 77/2 fail {F6, G5}; after fix 77/2 fail {F6, G5} — IDENTICAL. Zero new regressions. F6 (1MB prose → length block) and G5 (prose-first digest allowed) are both pre-existing and unrelated.
    - Per-fixture HEAD-vs-mine probe confirmed 2.5/2.12 were my regressions (fixed by substantive fixtures) while inc1/F6/1.10/G5 behave identically on HEAD.
  - `npm run verify:feat-084` → 37/0; `npm run verify:feat-091` → 278/0; `npm run verify:feat-091-commonmark-diff` → 23/0 (table rendering); `npm run gate` → PASS (exit 0).
- **Verified-by:** PENDING — independent clean-room verify REQUIRED. This is a Stop-hook (session-lifecycle, wedge-capable) behaviour change AND I edited the two independent FEAT-085 suites (independent + adversarial) to track the contract change — so my self-verification is explicitly not the last word. The independent pass should re-derive: (i) short and single-artifact replies ALLOW without a digest; (ii) a substantive no-digest reply still BLOCKs under enforce; (iii) a PRESENT-but-broken digest still BLOCKs; (iv) the digest predicate cannot be tricked (answer-block + loose prose is not a single artifact).
- **Still open / handoff:** pre-existing suite failures 1.10 (independent) and F6/G5 (adversarial) are NOT this ticket's — they predate it (baseline-proven) and stem from FEAT-138 length enforcement / a prose-first-digest grading gap. Flag to whoever owns FEAT-085/138.
- **Symptom of a deeper design flaw?** no (the gate's "always require a digest" was a latent gap vs the spec's own "when substantive" wording; this closes it).

### 2026-09-16 — independent verifier (Opus 4.8), verifying round 1
- **Verdict: claim 4 (digest optional + hook) PASS; claim 3 (table) PASS-with-limitation.** Attacked diff + test code only.
- **NO assertion weakened to mask a regression — the single most suspicious artifact cleared.** Built a clean HEAD export (`git archive HEAD`, read-only) and ran the HEAD suites myself:
  - independent: HEAD 56/3 fail {1.10, R1×2}; post-change 59/1 fail {1.10}. The change REMOVED 2 failures and added none. Critically, the OLD R1 assertions ("still BLOCKs"/"ADVISORY reported") were ALREADY RED at HEAD — inc1 already ALLOWed under the old hook — so flipping R1→ALLOW corrects a stale assertion, it does not hide a break. R2's BLOCK→ALLOW flip is the genuine short-reply feature: inc23's graded text is 13 words (<40).
  - adversarial: HEAD 2/2 fail {F6, G5} == post-change {F6, G5}, IDENTICAL. Fixture swaps (→SUBSTANTIVE) preserve the same BLOCK verdicts; the anti-over-permissiveness cases (answer+prose→BLOCK, R3b substantive shapes→BLOCK) are additive.
  - stop-hook: HEAD 58/58 green → post-change 61/61 green (3 new ALLOW/BLOCK guard cases). Nothing needed weakening.
- **Pre-existing-noise claims verified against HEAD (not accepted):** F6, G5, 1.10 all fail at HEAD identically. `verify-feat-091-renderer` FATAL (`fenceSegments`) is pre-existing — the module + test are byte-identical to HEAD and the export exists. **Extra undocumented noise found:** HEAD independent R1×2 were also already red (charter only named 1.10).
- **Direct hook adversarial probes (mine, with the BUG-118 launcher trigger `ORCHARD_SESSION`==`session_id` + ENFORCE=1):** 39-word no-digest → ALLOW; 40-word → BLOCK (exact `SHORT_REPLY_WORDS=40` boundary); 600-word plain prose no-digest → BLOCK (missing-digest, no wedge); single `orchard-answer` (short/empty/600w) → digest exemption applies (a 600w answer blocks only on the pre-existing 120-word readability budget, NOT missing-digest — exemption intact); answer-block + 600 loose words → BLOCK (correctly not a single artifact); present-but-empty digest items → BLOCK. No wedge/crash on any (600w, 250MB via I2, empty body).
- **Could NOT test:** GFM table → real `<table>` DOM render (claim 3) — depends on the unchanged markdown renderer; `verify-feat-091-renderer` FATALs (pre-existing) so I could not drive it. `verify:feat-091-commonmark-diff` (23/0) validates the fence scanner vs CommonMark, not table→DOM. Parse layer preserves the table markdown verbatim inside a layer-2 block (probe A3). Model behavioural compliance (does it actually emit tables / omit digest) is unfalsifiable statically; only injected-core presence verified.
- **High-stakes note:** this IS a Stop-hook (wedge-capable, session-lifecycle) change and the author edited the FEAT-085 policing suites — my clean-HEAD baseline diff satisfies the skeptic requirement for THIS pass; a second fresh-context/cross-provider clean-room dispatch remains warranted if the orchestrator wants full ARCH-grade assurance (I ran the decoupled-execution half of the harness, not the nested-LLM half — degradation noted: deterministic suites carry the signal).
- **Durable pointer:** verifier report emitted to orchestrator 2026-09-16; all evidence commands re-runnable.
