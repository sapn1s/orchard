# BUG-103 — the Bash `grep` shim silently SKIPS `agent-bridge.ts` (a NUL byte makes it "binary"), returning an empty result indistinguishable from "not found"

- **Status:** FIXED 2026-08-18 (self-verified; independent clean-room verify warranted — regression-prone `agent-bridge.ts`) — decision made: **do all three remedies**. (1) The lone NUL in `src/server/agent-bridge.ts` is removed (regex rewritten `/<NUL>/g` → `/\x00/g`, behaviour proven byte-identical); the Bash `grep` shim now returns **13** for `parent_tool_use_id` where it previously returned empty. (2) New guard `scripts/check-nul.mjs`, wired into `npm run gate`, FAILS on any tracked text file with a NUL and explains the *consequence* (silent skip → false negative); binary assets (png/font/archive) exempt by extension. (3) The guard travels via `scripts/onboard.mjs` and runs in a fresh onboarded project (proven end-to-end). Remedy 2's `rg`-not-shim convention was already landed by the filing lane. See the 2026-08-18 fix-lane log entry. Two pre-existing out-of-lane NUL text files surfaced (see log) and are allowlisted+reported, not fixed here.
- **Severity:** high — not a wrong answer but a CONFIDENT WRONG answer, on the largest and most bug-dense file in the tree, poisoning investigation of exactly the bug class that lives there.
- **Area:** tooling / investigation hygiene (the Bash tool's `grep`), source hygiene (`src/server/agent-bridge.ts`)
- **Reported:** 2026-08-18 by the ARCH-003 build lane (uncovered while confirming the parentage frames)
- **Verification-class:** trivial (the defect is a reproducible command; the remedy, once chosen, is docs/convention or a one-char source edit)

## Symptom
A search over `src/server/agent-bridge.ts` from the Bash tool prints NOTHING and exits without error, so
the searcher reads "no matches" — when the term is in fact present six times:

```
$ grep -c parent_tool_use_id src/server/agent-bridge.ts      # Bash tool shim (ugrep -I)
                                                              # → empty output, no match
$ /usr/bin/grep -c parent_tool_use_id src/server/agent-bridge.ts
6
$ rg -c parent_tool_use_id src/server/agent-bridge.ts
6
```

`file` calls the whole 2958-line source binary:
```
$ file src/server/agent-bridge.ts    # reports NUL / data, not text
```

## Root cause
`src/server/agent-bridge.ts` contains one raw **NUL byte at offset 135077** — line 2704, inside a regex
literal written as `s.replace(/<NUL>/g, '')` (a control-character stripper whose pattern is the literal
NUL rather than an escape like `\x00` or `\\0`). One NUL makes the file "binary" to content classifiers.
The Bash tool's `grep` is a `ugrep` shim invoked with `-I` (skip binary files); on a binary-classified file
`-I` **skips the file entirely and prints nothing, exit 0/1 with no diagnostic** — there is no "Binary file
matches" line, no warning to stderr, nothing. A silent empty result from a search tool is then
INDISTINGUISHABLE from a genuine absence.

## Impact — this already produced a confident false negative
BUG-096's investigation grepped `src/server/` for parent linkage, got the empty result, and concluded
*"there is no `parent_task_id` linkage anywhere in `src/server/`"*. That premise drove **three** failed fixes
(ARCH-003 "How we got here") and the eventual raising of ARCH-003 as "undetectable." In fact the linkage
(`parent_tool_use_id`, 6 occurrences) was in that exact file all along — the tool skipped it. `rg`, `ripgrep`,
`/usr/bin/grep -a`, `ast-grep`, and the Read tool are all UNAFFECTED; only the `-I` shim silently lies.

## Expected
A search that cannot read a file must FAIL LOUD, not return an empty result that reads as "no matches." At
minimum the tree should not contain a NUL byte that flips its largest source file to "binary."

## Proposed remedies (pick; do not bundle unrelated rewrites)
1. **Remove the NUL from source (smallest, highest-leverage).** Rewrite the regex literal at
   `agent-bridge.ts:2704` to an escape — `s.replace(/\\x00/g, '')` (or `/\x00/g` written with the escape,
   not a literal NUL). Behaviour is byte-identical; the file becomes plain text and every tool sees it. This
   removes the trap at its source and is the one change that helps EVERY future searcher, human or agent.
2. **Convention: search with `rg`, never the Bash `grep` shim, for content hunts** — added to
   `docs/CONVENTIONS.md` under the testing/tooling material by this ticket. `rg` reads NUL-containing files
   and is already the house tool (`ast-grep` note lives beside it). Cheap, immediate, does not touch source.
3. **A gate/check that detects the condition** — e.g. `board:check`-adjacent lint that greps the tree for a
   raw NUL byte in any `src/**/*.ts` and fails, so the trap cannot silently reappear. More plumbing; catches
   regressions #1 alone would not.

Remedy 1 + 2 together are the recommendation: fix the one existing instance AND stop relying on the lying
tool. 3 is optional hardening. This ticket does NOT unilaterally rewrite the source — it records the hazard,
reproduces it, and leaves the source edit to a decision, since `agent-bridge.ts` is under active change by
other lanes.

## Context pack
- Offending byte: `src/server/agent-bridge.ts` offset 135077, line 2704 (`s.replace(/<NUL>/g, '')`).
- Reproduce the skip: `grep -c parent_tool_use_id src/server/agent-bridge.ts` (empty) vs
  `/usr/bin/grep -c … ` (`6`) vs `rg -c …` (`6`).
- Find the NUL: `/usr/bin/grep -aPn '\x00' src/server/agent-bridge.ts` → line 2704.
- Related: BUG-096 (the false negative it produced), ARCH-003 (the fix that re-established the linkage the
  false negative hid).
- Convention entry: `docs/CONVENTIONS.md` → "Testing / tooling" (added alongside the `ast-grep` caveat).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — ARCH-003 build lane
- **Understood:** while confirming ARCH-003's parentage claim I re-ran the BUG-096 probe's grep and got the
  same empty result it did; traced it to the NUL byte at offset 135077 flipping the file to "binary" so the
  Bash `grep` (`ugrep -I`) skips it wordlessly. `/usr/bin/grep` and `rg` both return 6.
- **Changed:** filed this ticket; added the "content hunts use `rg`, not the Bash grep shim" rule to
  `docs/CONVENTIONS.md`. Did NOT edit `agent-bridge.ts:2704` (remedy 1) — the file is under active change by
  other lanes and the source edit is left to a decision to avoid an index race.
- **Verified:** reproduced the three-way divergence (empty / 6 / 6) above; located the byte at line 2704.
- **Still open / handoff:** pick remedy 1 (remove the NUL) and/or 3 (a NUL-in-source check). The convention
  (remedy 2) is landed with this ticket.

### 2026-08-18 — BUG-103 fix lane
- **Decision:** do ALL THREE remedies. They cover different ground and none substitutes for another:
  remedy 1 fixes the one existing trap, remedy 3 stops the next one silently reappearing (the whole
  failure mode is invisible by construction), remedy 2 (the `rg`-not-shim convention) was already landed
  by the filing lane. The NUL had migrated since filing — now at **offset 153630, line 2986** (still the
  same `/<NUL>/g` control-stripper regex in `previewOf`, not the old 135077/2704 — the file grew).
- **Changed:**
  1. `src/server/agent-bridge.ts:2986` — rewrote the regex literal `s.replace(/<NUL>/g, '')` →
     `s.replace(/\x00/g, '')`. Byte-level edit (a raw NUL cannot be typed through the tools); exactly one
     NUL was present and it is now zero.
  2. `scripts/check-nul.mjs` (NEW) — scans `git ls-files`; FAILS (exit 1) on a raw NUL in any tracked
     file except recognised binary assets (`BINARY_EXT`: images/fonts/archives/media/compiled). The
     failure message states the CONSEQUENCE — the `ugrep -I` shim skips the file silently so a search
     returns EMPTY, indistinguishable from "no matches" — not merely that a NUL exists.
  3. `scripts/gate.mjs` — `check-nul` wired in as gate #2 (before typecheck); consumes its exit STATUS via
     `spawnSync().status`, never a pipe (BUG-102 discipline preserved).
  4. `scripts/onboard.mjs` — `scripts/check-nul.mjs` added to `METHOD_FILES` (travels with `gate.mjs`) and
     a `check:nul` npm script added to the onboard wiring block.
  5. `package.json` — `"check:nul": "node scripts/check-nul.mjs"`.
- **Verified (numbers with exit codes):**
  - *Must-FAIL, before→after:* on the unmodified HEAD copy the shim `grep -c parent_tool_use_id` printed
    nothing at **exit 1** while `/usr/bin/grep`=**13** and `rg`=**13**; on the fixed working tree all three
    return **13, exit 0**. NUL count 1→0.
  - *Regex equivalence:* `s.replace(new RegExp('\0','g'),'')` vs `s.replace(/\x00/g,'')` — identical output
    across 6 inputs (adjacent controls, repeated/leading/only-NUL, multibyte); `\x00` touches ONLY U+0000.
    ALL EQUAL, exit 0.
  - *Guard both directions (in a scratch onboarded project):* clean tree → PASS exit 0; a `.ts` file with a
    NUL → FAIL exit 1; removed → PASS; png+woff2+zip all containing NULs → PASS exit 0 (binary non-trip).
  - *Travel:* `onboard.mjs` into a fresh git repo COPIED `scripts/check-nul.mjs` and wired `check:nul`+`gate`;
    the COPIED `gate.mjs` ran there — `PASS check-nul` clean, `FAIL check-nul` (gate exit 1) with a NUL.
  - *Anti-regression:* `verify:onboard` **36 passed, 0 failed, exit 0**; `typecheck` clean (via gate).
  - *`npm run gate` (real repo, exit read directly, unpiped):* **exit 1** — but the ONLY failing gate is
    `leak-gate`, and every one of its 353 hits is in **untracked** `scripts/experiments/*` (build-corpus.mjs,
    corpus/corpus.json, corpus/raw-reports.jsonl) — another lane's pollution, off-limits, NOT in this commit.
    `check-nul` PASS and `typecheck` PASS. My own 5 files, scanned in isolation, are leak-clean (**0 hits**).
- **Surfaced (out of this lane — reported, NOT fixed):** two OTHER tracked TEXT files also carry NULs and are
  today hidden from the shim: `public/app.js` (~line 2562, NUL used as a client composite-key delimiter —
  `public/*` is a separate live lane) and `scripts/verify-arch-watch.mjs` (~line 284, a deliberate NUL in a
  corrupt-board test FIXTURE, which ironically makes that test's own source unsearchable). Both are
  allowlisted by path in `check-nul.mjs` (with reasons) so the gate is green today and printed as WARNINGs on
  every run so they are not forgotten — an allowlist entry DEFERS the fix, it does not make the NUL safe.
  Their owning lanes should escape/remove them (write `\x00` in app.js's key; use printable garbage in the
  fixture).
- **Still open / handoff:** an independent clean-room verify pass is warranted (`agent-bridge.ts` is
  regression-prone). The two allowlisted NUL files above are follow-ups for their owning lanes.
