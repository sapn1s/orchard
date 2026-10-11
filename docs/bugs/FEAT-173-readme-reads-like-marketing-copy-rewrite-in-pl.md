# FEAT-173 — README reads like marketing copy; rewrite in plain engineer register

- **Status:** VERIFIED
- **Severity:** low
- **Area:** docs (README.md)
- **Reported:** 2026-10-09 by user
- **Verification-class:** docs-only

## Symptom
The user said the published README "reads kinda cringe."

## Repro
Read `README.md`. The "Why it exists" section is a stack of bold emotional
slogans ("You end up explaining how to work, over and over."), most feature
bullets lead with a bold marketing phrase, and several lines are self-praising
("Honest state.", "honest record", "There is no licensing email address,
deliberately.") — a landing-page/manifesto voice rather than reference docs.

## Expected
A plain, factual open-source README: what it is in 1-2 sentences, who it's for,
a feature list with no adjectives doing the work, requirements, install/run steps
that work from a fresh clone, configuration (env vars), optional integrations, a
link to the Working Agreement as the methodology, and a license line.

## Context pack
- Files in play: `README.md` (only file changed).
- Diagnosis confirmed: the content was accurate and up to date; the problem was
  register (hype/manifesto voice), not inaccuracy. So this was a rewrite-for-tone,
  not a correctness fix.
- Cross-checks run against ground truth: every referenced path exists (`LICENSE`,
  `CONTRIBUTING.md`, `docs/PROVIDERS.md`, `docs/guide/README.md`, the three
  `docs/assets/*.png`, `deploy/claude-station.service`, `docs/prompts/WORKING_AGREEMENT.v2.md`);
  every command exists in `package.json` scripts (`npm ci`, `npm start`,
  `npm run typecheck`, `scripts/verify.ts`, `npm run verify:ui`, `npm run verify`,
  `npm run gate`, `scripts/dispatch.mjs`, `scripts/gatekeeper.mjs`); systemd unit
  path and `PORT=4317` match `deploy/claude-station.service`; license id matches
  `package.json` and `LICENSE`.
- Related: FEAT-172 (publish-safety redaction) — ran concurrently but did NOT
  touch README.md (confirmed via `git status`), so no clobber.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-09 — fixing lane (Opus 4.8)
- **Understood:** The "cringe" was tone, not inaccuracy. The hypothesis (hype,
  marketing adjectives, manifesto prose) held; there was no emoji and little
  internal jargon to strip, and the facts were current.
- **Changed:** `README.md` only. Rewrote in a plain engineering register:
  replaced the bold-slogan "Why it exists" with plain problem/solution bullets;
  stripped marketing lead-ins and self-praise from the feature list; added a
  "Who it's for", a "Requirements", a "Configuration" env-var table, and a
  "Methodology" section linking `docs/prompts/WORKING_AGREEMENT.v2.md`; kept the
  three screenshots, security posture, verify commands, layout table and license.
  No home paths, budget facts or personal details introduced.
- **Verified:** Confirmed every referenced file path exists and every command
  appears in `package.json`/`deploy/` (see Context pack). `npm run gate` →
  EXIT 0 (leak gate + typecheck pass). Install steps checked against package.json
  scripts and the systemd unit; all resolve. No install step went unverified
  beyond actually booting a server, which a docs rewrite does not require.
- **Still open / handoff:** none.
- **Symptom of a deeper design flaw?** no.

### 2026-10-09 — fixing lane round 2 (Opus 4.8)
- Follow-up: README Methodology link pointed at the stale `WORKING_AGREEMENT.v2.md`; updated to the current `WORKING_AGREEMENT.v4.md`. Confirmed no other v2/v3 references remain in README.md. `npm run gate` → EXIT 0.
</content>

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
