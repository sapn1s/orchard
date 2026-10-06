# BUG-206 — a session id in both the Claude and Codex stores changes engine after it is first opened

- **Status:** OPEN — filed 2026-09-29 by the BUG-196 round-5 fix lane; reproduces at clean HEAD, not fixed
- **Severity:** low
- **Area:** server (resume engine resolution, `src/server/orchard-transcripts.ts`)
- **Reported:** 2026-09-29 by the BUG-196 round-4 clean-room verifier (finding 3); attributed by the round-5 fix lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
If one session id has a transcript in the Claude store AND an Orchard OpenAI transcript, resuming it
before anyone opens it runs on OpenAI Codex, but after it has been opened once it runs on Claude.
Same id, same files, different engine, depending only on whether the session was viewed first.
Not observed arising naturally (Codex and Claude mint different ids), only constructed.

## Repro
1. Write `<claude-store>/<dir>/<id>.jsonl` and `<data>/transcripts/openai/<dir>/<id>.jsonl`.
2. `start{resumeSessionId:<id>}` → ack `effective.provider = openai`.
3. `GET /api/transcript/<dir>/<id>` — the FEAT-144 Claude mirror writes
   `<data>/transcripts/anthropic/<dir>/<id>.jsonl`.
4. `start{resumeSessionId:<id>}` again → ack `effective.provider = anthropic`.

The engine resolver returns the first provider directory that holds the id, in `readdir` order, so
once the `anthropic` mirror exists it can win. Proven at clean HEAD `a977e76` (file copy, no
checkout) with the round-4 verifier's own probe `adv-server.mjs both`: unopened=openai,
opened=anthropic. Scratch: `~/.local/state/claude-station/scratch/bug196-r5/head/both-head.log`.
On the BUG-196 tree the same flip remains (4/5 there vs 2/5 at HEAD: BUG-196 made the declared
engine always equal the engine run; the flip itself predates it).

## Expected
One deterministic answer for an id, whatever was opened first, and it must be the answer the
resume path uses. Decide which store wins for a dual-store id (for example: an engine-owned store
beats the Claude mirror, which only copies the Claude store), and make the resolver order explicit
instead of `readdir` order.

## Context pack
- Files/functions in play: `providerRoots()` (readdir order), `resolveOrchardSessionFile`,
  `resumeProviderOf` (orchard-transcripts.ts); FEAT-144 `mirrorClaudeStore` (writes the
  `anthropic` mirror on a transcript read); agent-bridge P2b and the index.ts start door (both read
  `resumeProviderOf`).
- Related tickets: BUG-196 (where it was found), FEAT-144 (Claude mirror), FEAT-037 P2b.
- Repro test: the verifier's `adv-server.mjs both` in
  `~/.local/state/claude-station/scratch/cleanroom-verify-25CZGu/`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — BUG-196 round-5 fix lane (Opus 5.5) — filed
- **Understood:** The engine for a dual-store id depends on `readdir` order of the provider roots,
  and a transcript read adds an `anthropic` mirror, so the first open can change the answer.
- **Verified:** reproduces at clean HEAD (file copy) — predates BUG-196, so not fixed there.
- **Still open / handoff:** pick the precedence rule (a product call if in doubt), make the
  resolver's provider order explicit, and add a must-FAIL case that resumes before AND after one
  open and asserts the same engine.
