# BUG-205 — a Codex session recorded with a trailing slash is listed but cannot be resumed

- **Status:** OPEN — filed 2026-09-29 by the BUG-196 round-5 fix lane; reproduces at clean HEAD, not fixed
- **Severity:** medium
- **Area:** server (native Codex import, `src/server/codex-native.ts`)
- **Reported:** 2026-09-29 by the BUG-196 round-4 clean-room verifier (finding 4); attributed by the round-5 fix lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom
A native Codex session (a rollout in `$CODEX_HOME/sessions`) whose recorded working directory ends
in a path separator shows up in the project's session list as an OpenAI session. Opening it shows
no transcript (the transcript route returns 404), and sending a message into it fails with a fatal
error: "cannot resume <id>: no transcript for it in <store>/<dir>, and no other store dir under
<store> has it either". The user sees a session they can pick but can never continue.

## Repro
1. Write a native rollout whose `session_meta.cwd` is the project dir plus a trailing `/`.
2. List the project's sessions → the rollout is listed, `provider: openai`.
3. `GET /api/transcript/<encodedDir>/<id>` → 404.
4. `start{resumeSessionId:<id>, prompt}` → fatal "cannot resume … no transcript".

Proven at clean HEAD `a977e76` (file copy of HEAD, no checkout) with the round-4 verifier's own
probe `adv-server.mjs slash`: 0/1, identical fatal message. Same result on the BUG-196 tree.
Scratch: `~/.local/state/claude-station/scratch/bug196-r5/head/slash-head.log`.

## Expected
Whatever the list shows, the transcript route and a resume must be able to open. Either the import
compares the cwd the same way the listing does, or the listing excludes what the import will
refuse.

## Context pack
- Files/functions in play: `listNativeCodexSessions` compares `normCwd(head.cwd)` to
  `normCwd(hostPath)` (tolerates a trailing separator); `importNativeCodexSession` compares
  `encodeCwd(head.cwd)` to `expectedEncodedDir` (does not), and files the import under
  `encodeCwd(head.cwd)`, which carries an extra trailing `-`. Callers: the transcript route
  (index.ts) and the ws `start` backfill (index.ts, moved up by BUG-196 round 4, unchanged in
  behaviour).
- Related tickets: BUG-196 (where it was found), FEAT-078 (native Codex import).
- Repro test: none in-tree yet; the verifier's `adv-server.mjs slash` is in
  `~/.local/state/claude-station/scratch/cleanroom-verify-25CZGu/`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — BUG-196 round-5 fix lane (Opus 5.5) — filed
- **Understood:** The two native-Codex readers disagree on what "this project's cwd" means: the
  listing normalises a trailing separator, the import's safety check does not.
- **Verified:** reproduces at clean HEAD (file copy) — so it predates BUG-196 and is not fixed there.
- **Still open / handoff:** make `importNativeCodexSession` compare and file under the SAME
  normalised cwd the listing uses (one owner for "is this rollout in this project"), then add a
  must-FAIL case with a trailing-separator rollout (and a Windows-style `\` one).
