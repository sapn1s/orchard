# FEAT-085 — Stop hook enforces the response format deterministically (check-first, re-prompt only on failure)

- **Status:** VERIFIED (ADVISORY-ONLY by default since 2026-08-15 — blocking is opt-in behind
  `ORCHARD_STOP_HOOK_ENFORCE=1` and has a KNOWN, documented grading gap; see the final log entry)
- **Area:** Claude Code hooks (settings.json `Stop` hook) + a small validator script in this repo
- **Reported:** 2026-08-14 by user (from Anthropic/community Opus 5 guidance)

## Why
Opus 5's default responses run long, and lowering effort does not fix it. The standard fix — a
conciseness instruction in the prompt — decays over a long session (observed repeatedly today: the user
had to re-flag verbosity several times despite a standing memory rule). Prompt-level rules also cost
permanent context on every request, which the same guidance says makes Opus 5 *worse*.

The harness-level fix: a **Stop hook** fires the moment the model decides the turn is done and can
REFUSE to let it close, injecting a fresh instruction just-in-time — so the instruction is maximally
salient and costs nothing in standing context.

## Design (improves on the naive version)
The naive hook re-prompts on EVERY turn (an extra model round-trip every time). Instead:
**check first, re-prompt only on failure.**

1. On `Stop`, a validator script inspects the assistant's final message.
2. **PASS → allow the stop.** Zero added cost on compliant turns.
3. **FAIL → block the stop** and return a corrective instruction naming exactly what was missing.

### Checks (deterministic, cheap, no model call)
- A leading ```orchard-digest fenced block is present and parses as valid JSON with a non-empty `items`
  array (reuse the FEAT-083 parser rules — leading-fence only, `text` non-empty).
- Item shape sane: each item has non-empty `text`, a recognised `kind`, an `importance`.
- **No emojis** anywhere in the reply (explicit user requirement).
- Optional/tunable heuristics: prose length beyond the digest over a threshold; obvious
  significance-restatement/validation openers ("You're right", "Good catch", "That's why … matters") —
  keep these ADVISORY and configurable, since false positives would be worse than the disease.

### Loop safety (mandatory)
Claude Code passes `stop_hook_active` when a Stop hook already blocked once — the hook MUST allow the
stop when that flag is set, so it can never loop indefinitely. Cap corrections at ONE per turn.

### Scope + escape hatch
- Configure in the PROJECT's `.claude/settings.json` (not the user's global settings) so it applies where
  it's wanted and is trivially removable.
- Must be disable-able (env var or a config flag) and must FAIL OPEN: any error in the validator allows
  the stop rather than wedging the session.

## Verification (§C)
- Feed the validator a compliant reply (leading valid digest, no emoji) → PASS, stop allowed, no
  re-prompt (must-FAIL: a naive always-block implementation would re-prompt here).
- Feed a non-compliant reply (no digest / malformed JSON / emoji present) → BLOCK with a corrective
  message naming the specific failure.
- `stop_hook_active` set → ALWAYS allow (loop-safety test).
- Validator throws / receives garbage input → FAILS OPEN (stop allowed), never wedges the turn.
- Disable flag set → hook is inert.
- Anti-regress: normal sessions still end normally; typecheck, leak-gate.
- **Risk bucket:** harness/session-lifecycle — a buggy Stop hook can WEDGE every turn in the session.
  Fail-open + loop-cap are the load-bearing safety properties; test them adversarially.

## Notes / related
- Same "cap it deterministically in the harness rather than adding another prompt rule" principle already
  used successfully here: leak-gate, board:check, docs:fresh.
- Related open item from the same guidance: a **deterministic cap on concurrent subagent fan-out** (Opus 5
  dispatches subagents more liberally; 4 concurrent lanes ran in this session with no cap). Worth its own
  ticket if this pattern proves out.
- Complements [[FEAT-084]] (response-format injection + per-project guidance) — FEAT-084 tells the agent
  the format, this ENFORCES it. Both should read the same `responseDigest` enable flag so a project that
  disables the digest is not blocked by the hook.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from the user's request after reviewing Anthropic/community Opus 5 guidance. Chosen design
  (check-first, re-prompt only on failure) improves on the naive always-re-prompt hook by costing nothing
  on compliant turns. Loop-safety via `stop_hook_active` and fail-open are mandatory.

### 2026-08-14 — worker (implementation + verification)

**VERIFIED Stop-hook contract** (confirmed against the `update-config` skill's settings schema AND a
real orchard transcript on disk, not assumption):
- stdin JSON the Stop hook receives: `{ session_id, transcript_path, cwd, hook_event_name:"Stop",
  stop_hook_active: boolean }`.
- `stop_hook_active` is `true` when a Stop hook already blocked once this turn — the load-bearing
  loop cap. Honour it -> at most ONE correction per turn.
- `transcript_path` is a JSONL file; each line an event. Assistant turns are
  `{ type:"assistant", isSidechain?:bool, message:{ role:"assistant", content:[{type:"text",text},…] } }`.
  Subagent output carries `isSidechain:true` and is ignored — only the MAIN thread's final text is graded.
- **BLOCK** = print `{"decision":"block","reason":"…"}` to stdout, exit 0 — Claude Code feeds `reason`
  back to the model as the just-in-time correction. **ALLOW** = print nothing, exit 0 (we prefer silence
  so a compliant turn emits no re-prompt at all; `decision:"approve"` would also allow). We deliberately
  do NOT set `continue:false` (that would hard-halt the turn instead of re-prompting).

**Fix map:**
- `scripts/hooks/response-format-gate.mjs` — the validator. Reads stdin, grades the final main-thread
  assistant message. Digest PASS/FAIL is delegated to the SINGLE source of truth `parseDigest()` in
  `public/lib/digest.js` (imported directly — it loads cleanly under node; no divergent grammar). A local
  mirror of the same leading-fence regex is used ONLY to word the failure (missing / malformed / empty),
  never to decide pass/fail. Emoji check (`\p{Emoji_Presentation}` + VS16 pictographs + regional
  indicators) forbids emoji while NOT flagging the arrows/dashes/™©® the project actually uses.
- `scripts/verify-feat-085-stop-hook.mjs` + `verify:feat-085` npm script — drives the validator directly
  with crafted payloads + synthetic JSONL transcripts (no live session).
- `.claude/settings.json` (NEW, project-scoped) — wires the `Stop` hook:
  `node "$CLAUDE_PROJECT_DIR/scripts/hooks/response-format-gate.mjs"`, `timeout: 5`. Trivially removable.

**Safety properties (all tested adversarially):**
- `stop_hook_active:true` on a non-compliant reply -> ALLOW (loop cap; one correction max).
- FAIL OPEN on: empty stdin, garbage stdin, missing `transcript_path`, missing transcript file, corrupt
  JSONL lines, sidechain-only / tool-only final turn, unloadable grammar. Plus `uncaughtException` /
  `unhandledRejection` handlers and a 3s watchdog that all ALLOW. A buggy path can never wedge the turn.
- Disable switch: env `ORCHARD_STOP_HOOK_DISABLED` truthy (`1`/`true`/`yes`) -> inert; `0`/`false` do not
  disable. Per-project opt-out: registry `responseDigest.enabled === false` for the project rooted at
  `cwd` -> inert (parity with FEAT-083/084; registry read is best-effort and never throws).

**Verification counts:**
- `verify:feat-085` — 27/27 (compliant ALLOW + must-FAIL "emits NO corrective"; each non-compliant BLOCK
  reason: missing / malformed / empty-items / blank-text / emoji / both-at-once; loop-safety; 5 fail-open
  paths; disable flag incl. falsey-does-not-disable; per-project opt-out both directions).
- **must-FAIL proof**: a naive always-block hook emits `{"decision":"block",…}` on the COMPLIANT reply
  (fails the "emits NO corrective" assertion); this implementation emits empty stdout on the same input.
- Anti-regress: `verify:feat-083` 22/22, `verify:feat-083-adversarial` 170/170 (digest.js contract holds
  under the direct import), `typecheck` clean, leak-gate PASS.

**Activation (user action required):** the `.claude/` settings watcher only watches directories that had
a settings file when the session started; this is the first `.claude/settings.json` in the repo. To make
the Stop hook live, open the `/hooks` menu once (reloads config) or restart the session. Review/disable it
there any time, or delete `.claude/settings.json`, or set `ORCHARD_STOP_HOOK_DISABLED=1`.

**Risk bucket:** session-lifecycle / regression-prone (a Stop hook can wedge every turn). Self-verified
27/27 with adversarial fail-open + loop-cap coverage; an independent clean-room verify pass
(`scripts/independent-verify.mjs` or a fresh-context agent re-running `verify:feat-085`) is warranted
before this is treated as battle-proven, since generation should not be its own only verifier.

### 2026-08-14 — independent adversarial verify (clean-room, did NOT author the hook)

**VERDICT: contract HOLDS.** No wedge (block-when-must-allow), no emoji false-positive, no crash on
any realistic input. New own-suite `scripts/verify-feat-085-adversarial.mjs` (`verify:feat-085-adversarial`),
written from scratch without reading the builder's verify script; drives the LIVE hook as a subprocess
with hostile stdin + synthetic/real transcripts and classifies each run ALLOW/BLOCK/CRASH/HANG the way
Claude Code reads a Stop hook. **60/60 asserts pass, 0 fail, 1 WARN** (non-realistic, below).

Coverage that mattered:
- **Loop-cap / wedge core:** `stop_hook_active:true` + non-compliant -> ALLOW; +compliant -> ALLOW.
- **Fail-open on hostile stdin:** empty, whitespace, non-JSON, truncated, JSON non-object (number/
  string/null/true/array), `{}`, 2MB junk -> all ALLOW.
- **Transcript read failures:** missing key, non-string path, nonexistent file, directory (EISDIR),
  symlink loop (ELOOP), unreadable (EACCES), empty file, all-garbage JSONL -> all ALLOW.
- **Transcript semantics:** no-assistant-turn, sidechain-only, compliant-subagent-but-non-compliant-main
  (grades MAIN -> BLOCK, subagent ignored), non-compliant-subagent-then-compliant-main -> ALLOW,
  tool_use-only final, `content` a plain string, multiple text blocks, trailing/partial lines -> correct.
- **Emoji false-positive hunt:** a compliant reply packed with arrows → ← ⇒, em/en dashes, ™©®, box-
  drawing, ✓✗✔✘, math ∑∫≤≥≠±×÷∞√, Greek, CJK, accented latin, currency €£¥₹₽, bullets, curly quotes,
  fractions, superscripts, and bare ⚠/ℹ (no VS16) -> ALLOW. True positives still BLOCK: 🎉 in prose,
  and VS16-forced ⚠️ (emoji presentation). No legitimate character class trips the gate.
- **Compliant-shape edge cases -> ALLOW:** leading blank lines, CRLF, 4-backtick fence, unicode item
  text, 500-item digest, digest + 1MB prose.
- **Correct BLOCK (not permissive):** no digest, malformed JSON, empty items, all-blank item text,
  digest-not-at-top.
- **Disable/opt-out:** `ORCHARD_STOP_HOOK_DISABLED` truthy (`1`/`true`/`yes`) -> inert; `0`/`false`/``
  do NOT disable (still BLOCK). Registry `responseDigest.enabled===false` for `cwd` -> ALLOW; `true` ->
  BLOCK; corrupt/missing registry -> fail-soft, still grades (no crash).
- **Perf within watchdog:** REAL biggest transcript (~35MB) grades in ~130ms; synthetic ~250MB grades
  in ~0.5s — both well under the 3s watchdog / 5s hook timeout.

**Robustness NOTES (not defects; do not brick a turn):**
1. **WARN — synchronous `fs.readFileSync` is not preemptible by the unref'd watchdog.** A never-EOF FIFO
   at `transcript_path` blocks past the timeout. NOT a realistic input: Claude Code always writes a real,
   finite JSONL file, never a FIFO. And the harness-level outcome of a hook timeout is *no* `decision:block`
   output => Claude Code treats it as non-blocking (allow) — degrades to latency, not a hard brick.
   Oversized REAL files fail open cleanly (`ERR_STRING_TOO_LONG` -> caught -> ALLOW, confirmed). If ever
   hardening: async read / bounded tail read. Left as-is (an async refactor of a live Stop hook carries
   more risk than the non-realistic issue it fixes).
2. **Loop-cap is `stop_hook_active === true` (strict boolean).** Correct against the verified boolean
   contract. Non-boolean truthy variants (`1`, `"true"`) would NOT be treated as active and the hook
   would grade again (probes B2-B4 document this). If a future Claude Code ever sent a non-boolean here
   the one-correction cap could weaken — a leniency (`Boolean(stop_hook_active)`) would be the safe
   direction. No change applied since the contract is boolean and looseness has its own under-enforcement
   failure mode; flagged for awareness only.

**Anti-regress (all green):** `verify:feat-085` 27/27, `verify:feat-083` 22/22,
`verify:feat-083-adversarial` 170/170, `typecheck` clean, leak-gate PASS. Foreground Bash only; no
push/restart/deploy; committed locally staging only the verifier + package.json script + this log.

### 2026-08-15 — worker (LIVE false-positive fix: multi-line split message)
regressed-from: FEAT-085 (original implementation — grader read a single JSONL line)

**Incident (real):** a reply that DID lead with a valid ```orchard-digest fence was blocked with
"Missing the leading ```orchard-digest block." One block in the entire session.

**Root cause (transcript evidence, session 87564f3e… lines 13683–13686):** Claude Code (SDK 2.1.220)
persists ONE logical assistant turn — sharing a single `message.id` — as MULTIPLE JSONL lines: a
thinking-block line, then one or more text-block lines. In the incident the reply's `message.id`
(`msg_011Ce4Fd…`) appears as line 13684 (a `thinking` block, empty text) and line 13685 (the `text`
block that leads with the valid digest). The whole session has 1423 thinking-only assistant lines —
this split is the routine shape, not an edge case. The original `lastAssistantText()` scanned backward
and graded only the SINGLE last JSONL line. When the Stop hook observed the message's text persisted
across lines with the fence on an earlier line and trailing prose on the last line (a read-during-write
/ chunked-persist state — the final collapsed file grades ALLOW, confirming the block came from a
transient split state), it graded only the fence-less trailing line → false "missing digest" block.
Note the ticket's leading hypothesis (multi text-block in ONE `content` array) was already handled —
that path concatenates blocks; the real gap was multi-LINE, same-`message.id` splitting.

**MUST-FAIL reproduction (pre-fix, exact live reason):** a transcript whose final logical message is one
`message.id` split across JSONL lines — thinking line, then a `text` line with the real blocked digest,
then a `text` line with the trailing prose — makes the ORIGINAL hook emit
`{"decision":"block","reason":"…Missing the leading ```orchard-digest block…"}`. Reverting the hook and
re-running the suite: builder 30/32 (both split cases FAIL with that reason), adversarial D9 FAILS as a
WEDGE ("blocks a turn that must be allowed"). Post-fix all green.

**Fix (`scripts/hooks/response-format-gate.mjs`):** `lastAssistantText()` now reconstructs the FULL final
main-thread logical message — it finds the last main-thread assistant JSONL line, then concatenates the
`text` of every earlier line that shares the same non-empty `message.id`, in file order (a new
`blockText()` helper joins all `text` blocks within each line). A leading digest anywhere at the start of
the logical message is therefore always seen. Guards preserved: id-less/older transcripts grade the
single last line (unchanged, bias-to-allow); different-`message.id` neighbours are NOT merged (a prior
compliant turn cannot rescue a later non-compliant one); a thinking-only final line (mid-stream) grades
empty → ALLOW (no false block during the flush window). All safety properties intact: `stop_hook_active`
→ allow, fail-open on every error path, disable env var, per-project opt-out, sidechain ignored, emoji
detection unchanged.

**Counts:** `verify:feat-085` **32/32** (+5: live-repro ALLOW, fence-split ALLOW, all-prose-split still
BLOCK, different-id-no-rescue BLOCK, thinking-only ALLOW). `verify:feat-085-adversarial` **63/63**, 1
WARN (pre-existing non-realistic FIFO note) (+3: D9 split ALLOW, D10 all-prose-split BLOCK, D11
different-id BLOCK). Anti-regress: `verify:feat-083` 22/22, `verify:feat-083-adversarial` 170/170,
`typecheck` clean, leak-gate PASS (0 hits / 442 files). Foreground Bash only; no push/restart/deploy;
staged only the hook + the two verify scripts + this log.

**Risk bucket:** session-lifecycle / regression-prone. Self-verified with a real-transcript-shaped
MUST-FAIL and over-permissiveness guards in both directions. An independent clean-room verify pass
(`scripts/independent-verify.mjs` or a fresh-context agent re-running both suites) is warranted before
this is treated as battle-proven — a Stop hook can wedge every turn, and generation should not be its
own only verifier.

---

### Independent-verify — 2026-08-15 (fresh-context skeptic, adversarial)

Requested clean-room pass (fix is session-lifecycle / regression-prone; a live Stop hook can wedge every
turn). Did NOT write the fix; wrote a from-scratch suite — cases not lifted from the existing suites —
attacking both failure directions plus every safety invariant, and graded a COPY of the real 34MB live
transcript. New suite: `scripts/verify-feat-085-independent.mjs` (`npm run verify:feat-085-independent`),
**52/52 passed, 0 failed**.

**MUST-FAIL proof of mechanism:** rebuilt the pre-fix `lastAssistantText()` (grades only the last JSONL
line) and ran it, correctly located inside `scripts/hooks/` so its `../../public/lib/digest.js` import
resolves. On a compliant split (digest on an earlier same-`id` line, plain prose on the last same-`id`
line) the **pre-fix hook BLOCKs** with the exact live reason ("Missing the leading orchard-digest
block"); the **post-fix hook ALLOWs**. Fix is real and correctly targeted.

**Coverage (independent):**
- WEDGE (15): real `[thinking]->[text]` shape; digest-earlier + prose-last; thinking-only final line;
  `tool_use`-only final line; JSON fence split mid-token across two lines; CRLF; leading whitespace/blank
  lines before the fence; 4-backtick fence; arrows/em-dash/…/™©® in prose (not emoji); 61-line long
  reply; `tool_use` interleaved between same-`id` text lines; blank line inside the group; no trailing
  newline at EOF; unicode in digest text; id-less single compliant line — all ALLOW.
- OVER-PERMISSIVE (12): all-prose split BLOCKs; prior-compliant turn (different `id`) never rescues a
  later non-compliant one — adjacent, corrupt-line-between, blank-line-between all BLOCK; digest not at
  the start of the reconstruction BLOCKs; whitespace-only item / malformed JSON / non-space-before-fence
  BLOCK; emoji in trailing prose AND emoji on an EARLIER merged line (now caught by concat) BLOCK; flag
  and VS16 emoji BLOCK.
- SAFETY (each independently, 20): `stop_hook_active:true` → ALLOW even for a blatant violation; empty /
  whitespace / non-JSON / non-object stdin → ALLOW; missing transcript / no `transcript_path` /
  directory-as-path / symlink loop / 5MB garbage → ALLOW (fail-open); disable env truthy → inert, but
  `false`/`0` still enforce; per-project opt-out (registry `responseDigest.enabled:false`) → ALLOW while
  a non-opted project still BLOCKs; sidechain final ignored (main-good ALLOW, main-bad BLOCK — sidechain
  cannot rescue); sidechain-only / no-assistant / thinking-only-no-text transcripts → ALLOW; corrupt
  trailing line with a compliant line before → ALLOW.
- PERFORMANCE (real): graded a COPY of the real 34MB / 13.7k-line live transcript in **~130–180ms**
  (watchdog is 3000ms); an adversarial 80k-line megagroup all sharing the final `message.id` (worst case
  for the backward walk) graded in **~110ms** and correctly ALLOWed — the backward walk does not degrade.

**Reality check:** confirmed the real live transcript has **4592 main-thread assistant lines, 0 with a
missing/empty `message.id`** — so the id-less grading path and the theoretical mixed-id-within-one-turn
wedge are not reachable on real Claude Code output; the concatenation always has the stable id it needs.

**Note (not a defect):** the commit's incident citation (lines 13684–13685 sharing `msg_011Ce4Fd`) is
imprecise — line 13685 is a `user` line with no id, and line 13684 already leads with the digest, so the
OLD single-line grader would have PASSED that exact pair. The genuine regression the fix fixes is the
"digest on an earlier same-`id` text line, plain prose on the last same-`id` line" shape, which the
MUST-FAIL above reproduces cleanly. Mis-cited incident, correct fix.

Anti-regress re-run green: `verify:feat-085` **32/32**, `verify:feat-085-adversarial` **63/63** (+1
pre-existing FIFO warn), `verify:feat-083` **22/22**, `verify:feat-083-adversarial` **170/170**,
`typecheck` clean, **leak-gate PASS** (0 hits / 443 files, checked exit code). Foreground Bash only; no
push/restart/deploy; staged only the new verify script + its `package.json` line + this log entry.

**VERDICT: HOLDS.** Cannot wedge a compliant reply on any realistic (or the probed adversarial) shape;
not over-permissive — different-`id` turns are never merged, all-prose/empty/mis-placed/emoji cases still
BLOCK; every safety invariant independently intact; performance well inside the watchdog on the real
transcript and an adversarial megagroup.

---

### 2026-08-15 — worker (DEMOTED TO ADVISORY-ONLY BY DEFAULT + real false-positive data set)
regressed-from: FEAT-085 (the gate itself — net value was negative in live use)

**Why the demotion.** Live scoreboard after three "fixes": **three false blocks, zero true positives.**
Each false block cost the user a real wasted turn on a reply that was already fully compliant. Meanwhile
the gate carried 87+ passing synthetic asserts and an independent clean-room verifier at 52/52 — so the
suites plainly do not model the real transcript shape, and a fourth blocking fix would have been another
guess. A gate whose only observed effect is punishing compliant turns must not be able to spend turns.

**Non-blocking channel used: `systemMessage`.** Checked the REAL schema via the `update-config` skill
rather than assuming. Non-blocking feedback fields available to a Stop hook:
- `systemMessage` — free-form string **displayed to the user in the UI, for all hook events**. Does not
  block, does not re-prompt the model, costs no turn. **This is what we use** — the strongest signal the
  schema actually supports for Stop.
- `suppressOutput` (bool) — hides raw stdout from the transcript; set alongside so only the clean
  systemMessage surfaces.
- `hookSpecificOutput.additionalContext` — injects text into the MODEL's context. Documented for
  PreToolUse/PostToolUse/UserPromptSubmit/SessionStart; **not documented for Stop**, so it was NOT used —
  the brief said do not invent a field.
- Rejected: `asyncRewake` (schema-real, but it re-wakes the model on exit 2 — i.e. it spends a turn,
  which is the exact cost being removed); `continue:false` (hard-halts the turn, strictly worse).
Belt and braces alongside `systemMessage`: a JSONL line appended to
`<dataDir>/logs/stop-hook-advisory.log` (`CLAUDE_STATION_DATA` / XDG data dir — **outside the repo**) and
a line on stderr. All three sinks are individually wrapped so a log/write failure can never affect a turn.

**Blocking is impossible by construction, not by a late conditional.** `makeViolationReporter()` runs once
at startup and returns ONE of two closures. In advisory mode the enforcing closure — the only code in the
file that can write `{"decision":"block"}` — is **never constructed**. There is no code path from the
advisory closure to a block. Opt in with `ORCHARD_STOP_HOOK_ENFORCE=1|true|yes` (case-insensitive,
trimmed); every other value, including `0`/`false`/`no`/``/garbage, stays advisory.

**THE VALUABLE ARTIFACT — all three real false blocks located and root-caused.** Found in the live
transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, 35.7MB, worked on a COPY,
original untouched) as `attachment.type === "hook_blocking_error"` events at JSONL lines **13687, 13750,
13785**. All three reasons were verbatim "Missing the leading ```orchard-digest block."; all three replies
DID lead with a valid fence.

Reproduction: truncating the copy at each incident point and re-running the hook **emits the exact live
reason**. The final, fully-flushed file grades ALLOW at all three points. So this was never a grammar bug —
it is a **read-during-write RACE**: the Stop hook can read the JSONL before the final assistant text line
is flushed, and `lastAssistantText()` then falls back to an EARLIER main-thread assistant message and
grades that. Two distinct shapes produced it:

| # | line | last VISIBLE main-thread assistant state at read time | why it graded FAIL |
|---|------|--------------------------------------------------------|--------------------|
| 1 | 13687 | previous completed turn, single `[text]` line, id `msg_011Ce4F7iPMT2DVDgpRDPVJz`, 3294 chars, opening `"Switching modes — this is advice, not a dispatch.\n\n```orchard-digest\n…"` | one lead-in sentence sits BEFORE the fence, so `parseDigest` (leading-fence only) fails → "missing digest" |
| 2 | 13750 | mid-turn group id `msg_011Ce4JAw1oxY4g1MhNzfUji`: line 13738 `[thinking]`, 13739 `[text]` = `"The reviewer found two real regressions — and the cause is a genuine design flaw, not a tuning miss."`, 13740 `[tool_use]` (last) | the last line alone is `tool_use` → `''` → would ALLOW, but the same-`message.id` MERGE (the earlier FEAT-085 fix) pulls in the preamble text, so it grades a bare preamble → "missing digest" |
| 3 | 13785 | identical shape, id `msg_011Ce4KhG6y336TCfyFWCYvb`: 13773 `[thinking]`, 13774 `[text]` = `"The named defects are fixed, but the inversion reappeared one level up — now in the labels rather than the rails. …"`, 13775 `[tool_use]` (last) | same as #2 |

Note the sting: incidents 2 and 3 were **caused by the previous fix**. The same-`message.id` merge that
cured the multi-line split ALSO defeated the "tool_use-only final line grades empty → allow" guard, by
merging a mid-turn preamble into a grading unit that used to be safely empty. Every "fix" so far has moved
the false positive rather than removed it — which is the concrete reason enforcement is now opt-in.

Both shapes are encoded as a permanent regression data set in
`scripts/verify-feat-085-independent.mjs` §5 (R1/R2, sanitised text, identical structure). They are
asserted to (a) still BLOCK under `ENFORCE=1` — documenting the OPEN grading gap so it cannot silently
change — and (b) never cost a turn in the shipped advisory default. **Whoever fixes the grading should
start there, not from new synthetic cases.** The likely correct fix is a freshness/completeness signal
(e.g. only grade a message whose `stop_reason` is set / that is not followed by a pending tool call, or
re-read the tail after a short settle), not more grammar work.

**Fix map**
- `scripts/hooks/response-format-gate.mjs` — advisory default via `makeViolationReporter()`; `summarise()`
  shared by both modes; `dataDir()` factored out of `registryPath()` for the advisory log sink.
- `.claude/settings.json` — unchanged wiring; `statusMessage` now says "(advisory)".
- All three verify suites: their runners now inject `ORCHARD_STOP_HOOK_ENFORCE=1` by default, so the entire
  pre-existing BLOCK/ALLOW contract was **re-pointed at enforce mode, not deleted**; new advisory sections
  clear it and assert the shipped default.

**Verification counts**
- `verify:feat-085` **58/58** (was 32; +26 advisory: must-FAIL non-compliant→no block, systemMessage
  present with no `decision`/`continue`, stderr + out-of-repo log sinks, log path proven outside the repo,
  compliant→silent, 5 falsey + 5 truthy opt-in values, 7 advisory safety paths).
- `verify:feat-085-adversarial` **79/79**, 1 pre-existing FIFO WARN (was 63; +16 §K advisory).
- `verify:feat-085-independent` **60/60** (was 52; +8: R1/R2 real incident shapes × ENFORCE-blocks /
  advisory-allows / systemMessage, plus R3 "no hostile shape can block by default" and R3b "all four still
  block under the opt-in").
- **must-FAIL proof**: the identical non-compliant payload emits `{"decision":"block",…}` with
  `ORCHARD_STOP_HOOK_ENFORCE=1` and emits `{"systemMessage":…}` with exit 0 and no `decision` when the var
  is unset. The pre-change hook blocks on it unconditionally.
- Safety re-verified in BOTH modes: loop cap (`stop_hook_active`), fail-open (empty / garbage / truncated /
  missing / directory / symlink-loop / corrupt-JSONL transcript), `ORCHARD_STOP_HOOK_DISABLED`, per-project
  `responseDigest.enabled:false` opt-out, sidechain-ignore, no emoji false positive on arrows/dashes/™©®.
- One pre-existing FLAKE fixed while re-pointing: adversarial `I1` graded the LIVE (still-growing) biggest
  transcript and asserted ALLOW. Mid-turn its final main-thread line is a tool-call preamble, so it blocked
  — the very race above, firing inside the test suite. `I1` now grades a stable COPY and asserts its real
  subject (performance + no crash/hang), leaving verdicts to the deterministic synthetic cases.
- Anti-regress: `verify:feat-083` 22/22, `verify:feat-083-adversarial` 170/170, `typecheck` clean,
  **leak-gate PASS** (0 hits / 443 files, exit code checked directly, not piped).

**Residual risk:** LOW by design. Worst case in the shipped default is a spurious `systemMessage` and a log
line — no turn is ever spent. The grading gap is real but now costs nothing; enforce mode is documented as
carrying it. Foreground Bash only; no push/restart/deploy; staged only the hook, `.claude/settings.json`,
the three verify scripts, and this log.

### 2026-08-18 — worker (READABILITY enforcement added on the same advisory/enforce path)

Extends the gate to ENFORCE readability on the reply's PROSE, calibrated against the controlled experiment
(`/tmp/iv-orchard/readability-experiment.md`) and its 12 real sample texts. Readability rides the EXACT same
advisory/enforce split as the format checks — advisory (shipped default) reports via `systemMessage`, never
blocks; enforce (`ORCHARD_STOP_HOOK_ENFORCE=1`) blocks. Every prior safety invariant is untouched.

**Fix map**
- `scripts/lib/readability.mjs` (NEW) — shared, pure, no-I/O module. `analyzeReadability(text)` returns word
  count, sentence count, mean & max sentence length, subordinate-clause density, and Flesch–Kincaid grade;
  `evaluateReadability(text)` applies thresholds and returns `{measured, tooShort, violations[]}` with an
  ACTIONABLE per-offence message. Proxies are IDENTICAL to the experiment's `metrics.py` (sentence = a line
  then split on `.!?`+ws; word = `/[A-Za-z0-9']+/`; clause density = commas+semicolons+` - `/em-dash
  separators per sentence; FK = `0.39·w/s + 11.8·syl/w − 15.59`), so it reproduces the experiment's headline
  numbers to the digit (verified: S1_A max=49/clause=1.26, S4_A max=38, etc.). Deliberately standalone so the
  planned ticket-readability check consumes the same module.
- `scripts/hooks/response-format-gate.mjs` — imports `evaluateReadability`; `main()` now builds categorized
  reasons `{formatReasons, readabilityReasons}` and adds the readability check AFTER the emoji check, wrapped
  in try/catch (fail-open). `summarise()` reworked to word each category separately (a readability-only
  violation is no longer mislabelled "missing digest", and vice-versa). The `reportViolation` closures
  (advisory `advise` / enforce `enforce`) take the categorized object — blocking is STILL impossible in
  advisory by construction (the enforcing closure is never built).
- `scripts/verify-feat-085-readability.mjs` (NEW) + `verify:feat-085-readability` — 32/32.

**What is EXCLUDED from measurement and why** (all skew every metric and are not the reply's running prose):
the leading ```orchard-digest block and ALL fenced code blocks; markdown table rows/dividers; blockquote
lines (quoted = someone else's prose); bare URLs. Inline `` `code` `` spans collapse to one placeholder word
(as the experiment did). Anything left under the length guard is not judged at all.

**Thresholds — justified against BOTH distributions** (originals = hard-to-process; rewrites = effortless 1/5):
- **PRIMARY — clause density > 1.0.** CLEAN GAP in the data: every rewrite ≤ 0.81, every original ≥ 1.10.
  1.0 sits ~23% above the good ceiling and below every bad case. This is the strongest discriminator and the
  one that catches the borderline original S4_A (clause 1.10) whose max sentence (38) COLLIDES with the good
  S4_B rewrite (also 38).
- **PRIMARY — max sentence length > 40.** Good rewrites top out at 38; the clearly-hard originals are 42/49/52.
  40 gives headroom over good writing while still flagging a runaway sentence. (S4 is the one pair max cannot
  separate — 38 vs 38 — which is exactly why BOTH primaries are kept: clause density separates it.)
- Gate fires if EITHER primary is exceeded.
- **SECONDARY (context only, never a sole trigger — bias to allow): mean sentence length 22, FK 12.** Original
  means were 16.8 / FK 8.1; good means 8.8 / FK 4.5 — both thresholds sit well above BOTH ranges, so they only
  ever add colour to a message a primary already raised. This keeps false positives near zero.
- **LENGTH GUARD (bias hard toward allowing): below 40 words OR 5 sentences of prose → not judged.** Calibration
  texts were 140–637 words / 15–43 sentences, so 40/5 is safely below every real hard case while protecting
  every short reply. A two-sentence answer (even a dense one, e.g. max 72 / clause 10.5) is reported `tooShort`
  and ALLOWED — verified.

**Must-FAIL proof on the REAL samples (both directions):** feeding the 12 experiment texts to the module —
all four un-rewritten ORIGINALS VIOLATE (S1_A max49/cl1.26, S2_A max42/cl1.15, S3_A max52/cl1.73, S4_A
max38/cl1.10-via-clause-density-only); all eight readability REWRITES PASS (B & C, max ≤38, clause ≤0.81).
Zero misclassifications. This is the calibrated separator working on real data rather than invented strings.

**Counts**
- `verify:feat-085-readability` **32/32** (real-sample must-FAIL ×16, headroom sanity ×2, hook-level
  convoluted→advisory-report/enforce-block + readable→ALLOW ×6, no-false-positive short/code/table/quote/
  digest-only ×5, advisory-split + loop-cap ×2, metric fidelity ×1 folded in).
- Hook-level: a convoluted BUT format-compliant reply (valid digest) triggers readability alone — advisory
  emits a `systemMessage` naming the offence with NO `decision`/`continue`; enforce BLOCKs with a reason that
  names the readability offence and NOT a missing digest. A readable reply ALLOWs silently in both modes.
- No false positives: two-sentence, code-heavy (big fenced block), table-heavy, quote-heavy, and
  dense-digest-only replies all ALLOW under enforce.
- Anti-regress ALL GREEN (exit codes checked): `verify:feat-085` **58/58**, `verify:feat-085-adversarial`
  **79/79** (+1 pre-existing FIFO warn), `verify:feat-085-independent` **60/60**, `verify:feat-083` **22/22**,
  `verify:feat-083-adversarial` **170/170**. `npm run gate` PASS (leak-gate + typecheck, exit 0, unpiped).

**Safety confirmation:** advisory/enforce split intact (readability follows the identical path — blocking
impossible in advisory by construction); `stop_hook_active:true` still short-circuits even a readability
violation (loop cap); fail-open preserved (readability call is try/caught, and the module is pure with a
`tooShort` bias-to-allow); disable env var, per-project opt-out, sidechain-ignore, multi-line same-`message.id`
reconstruction, emoji detection — all unchanged. The readability check can only ADD a reason to an already-
constructed report; it can never turn advisory into a block.

**Risk bucket:** session-lifecycle / regression-prone (this hook has burned the user twice). Self-verified
with a real-data must-FAIL in both directions and explicit short/code/table/quote false-positive coverage.
An independent clean-room verify pass (a fresh-context agent re-running `verify:feat-085-readability` +
re-deriving the thresholds against both distributions) is WARRANTED before enforce mode is trusted on live
traffic — generation should not be its own only verifier. The shipped default stays advisory, so the residual
risk in production is a spurious `systemMessage`, never a spent turn. Foreground Bash only; no
push/restart/deploy; staged only `scripts/lib/readability.mjs`, the hook, the new verify script, its
`package.json` line, and this log.
