# BUG-100 — the composer footer replaces its stable label with raw running-command text (and a cost line)

- **Status:** VERIFIED
- **Area:** the composer footer / status line under the chat input (public/app.js + public/styles.css)
- **Reported:** 2026-08-14 by user

## Symptom
The strip under the chat input normally shows a stable, short label (e.g. `direct · full access`). While a
dispatched agent runs shell work, it instead shows the **raw text of the running command** — in the
reported case a multi-hundred-character heredoc script (`GUARD_BYPASS=1 rm -rf /tmp/… mkdir -p … node
/tmp/…/harness.mjs 2>… & HARNESS=$! sleep 0.5 PROMPT='…' timeout 120 codex exec --sandbox …`), truncated
mid-word. It then flips to a run summary (`success · 37.8s · $65.5067 · 3 turns`).

User words: "at the bottom under chat input it keeps changing text to [huge command] … and normally its
just label info 'direct - full access' or so".

## Why this is wrong
- The footer is a **persistent status affordance**, not a log. Raw command text is unbounded, changes every
  few seconds, and is unreadable at that width.
- It reads as ALARMING: an `rm -rf` fragment and a `GUARD_BYPASS=1` prefix flashing under the input looks
  like something dangerous is happening to the user's machine, when it is a scratch dir under /tmp inside a
  worker's own sandbox test.
- It **displaces** the information the strip exists to convey (isolation mode / access level), which is
  exactly the state a user needs at a glance while typing.

## Wanted
- Keep the stable label as the DEFAULT and PRIMARY content of the footer.
- Represent running work as a compact, bounded indicator (e.g. "1 agent running" / a short verb +
  truncated description), NEVER the raw command string. If the command is surfaced at all, put it behind
  hover/expand or in the running-agents strip that already exists for this purpose.
- Cap length hard and truncate on a word/segment boundary with an ellipsis; never let a single status item
  exceed the strip.
- Decide where the run summary (`success · 37.8s · $X · N turns`) belongs — it is useful, but it should not
  be what replaces the isolation label. Consider the running/outcomes rail instead.

## Related question raised by the same observation (investigate separately if real)
The summary line read `$65.5067 · 3 turns`. Confirm whether that is a SINGLE dispatch's cost or a
cumulative session/day figure — if a single cross-provider dispatch really costs ~$65, that is a budget
fact the user needs surfaced deliberately, not glimpsed in a footer. Do not assume; measure.

## Verification (§C)
- Drive the real UI with a dispatched agent running a long multi-line shell command: assert the footer
  keeps the isolation label and shows a bounded running indicator; assert the raw command string never
  appears in the footer (must-FAIL pre-fix: it does).
- Assert the footer's rendered width/length is capped regardless of command length (fuzz with a
  2,000-char command).
- Anti-regress: verify:ui, the proc/status-chip suites (BUG-082 shortened the proc chip's port list —
  same class), typecheck, leak-gate.
- Risk bucket: UI/status surface (low functional risk; moderate user-trust impact — a flashing `rm -rf`
  under the input is alarming).

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user report while a harness-repair worker was running sandboxed codex tests. Same family as
  BUG-082 (proc chip port list too long): unbounded machine detail displacing a stable status label.

### 2026-08-14 — worker (VERIFIED)
**Mechanism found.** The footer is `#fine` (`.fine`), written ONLY by `say(text, isErr)`
(public/app.js). It is dual-purpose: it holds the resting isolation/access label AND transient
ticker messages. The stable label ("Direct · full access to this machine" / Container / Sandbox) was
set inline in `paintSeal()` when `!state.busy`. Two paths displaced it with unbounded/inappropriate
content:
  - `case 'status'` (onEvent) did `if (!state.busy) say(e.status)`. The server (agent-bridge.ts:2520)
    emits `t:'status'` with an agent task-notification `String(m.message ?? …)` — for a dispatched
    shell/codex agent that is the RAW command line (the multi-hundred-char heredoc), dumped raw into
    the footer.
  - `case 'turn-end'` built `bits = [subtype, "37.8s", "$65.5067", "3 turns"]` and did
    `say(bits.join(' · '))`, replacing the label with the run summary — including a bare `$` figure
    that reads as real spend.
There was NO length cap anywhere; `say()` wrote `textContent` verbatim.

**Cost question (ticket §36-39).** `e.costUsd` is the SDK `result` cost for ONE turn/dispatch (per
FEAT/`turn-end`), not cumulative and not billed money — an API-EQUIVALENT ESTIMATE (user is on a fixed
plan). The reported `$65.5067` was a single cross-provider codex dispatch's estimate. Handled by
labelling, not by treating it as a spend fact.

**Fix map (public/ only — stayed out of src/server/*):**
  - `say()` now hard-caps at `MAX_FINE=88`, truncating on a word/`·`/`/` boundary + ellipsis and
    stashing the full/raw text on the element `title` (nothing lost to hover). Universal safety net
    for EVERY caller.
  - `.fine` CSS: `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%` — a
    wide item can never wrap to a 2nd line or spill past the composer.
  - Extracted `isoLabel(p)` (single source for the label) + `restLabel()` (re-asserts it as the
    resting content) + `runningAgentCount()`.
  - `case 'status'`: never adopts raw command text. While agents run it shows
    `"<isoLabel> · N agents running"` (bounded); the raw command rides the title; the running rail
    (#strip) remains the home for what's in flight. Short human notices still show (capped).
  - `case 'turn-end'`: cost labelled `~$X est.`; a clean/interrupted run summary goes to a durable
    transcript OUTCOME line (`appendTurnOutcome` → `.ran-lbl.turn-outcome`, with a "not billed"
    title) and `restLabel()` returns the footer to its label. An ERROR still speaks up in the footer
    ticker (that IS a transient, marked alert).

**Where the run summary belongs — decision.** The running/outcomes RAIL, not the footer. The footer
`#fine` exists to hold the isolation label; the strip (#strip) hides on completion, so a *durable*
per-turn outcome lands as a `.ran-lbl` line at the foot of the main transcript (the same durable
outcome surface the codebase already uses for compact-boundary markers — see the app.js comment
praising a "transcript card (durable, unlike the one-line #fine ticker)"). Errors are the one thing
that still uses the footer ticker, because an error IS a transient alert.

**Verification (§C).** New suite `scripts/verify-bug-100-footer-label.mjs` — real UI in headless
brave over CDP, free port, PID-kill only, never :4317. Realistic busy-state fixture: server snapshot
reports TWO running agents and one emits the reported multi-LINE `GUARD_BYPASS=1 rm -rf … codex exec`
heredoc.
  - 14/14 PASS with the fix.
  - Must-FAIL pre-fix (reverted the two handlers to the old raw-dump): 5 PASS / 9 FAIL — (2c) LEAKED
    "GUARD_BYPASS, rm -rf, harness.mjs, codex exec, mkdir" into the footer; (4a/4c) the bare
    `$65.5067` summary displaced the label. Restored the fix → 14/14.
  - Fuzz: a 3,137-char command routed through the footer renders 86≤88 chars, single line, no spill,
    ellipsis, full text on title.
  - Anti-regress: verify:ui 7/0 (its transcript now correctly shows the new
    `success · 2.5s · ~$0.1041 est. · 1 turns` outcome line), verify:proc-chip 16/16,
    verify:processes 9/0, verify:feat-083 22/22, verify:feat-083-adversarial 170/0, `tsc --noEmit`
    clean, leak-gate PASS (0 hits / 439 files).

**Screenshots (idle + agent-running, both themes):** /tmp/iv-orchard/footer-after.png (light) and
/tmp/iv-orchard/footer-after-dark.png (dark) — footer reads "Direct · full access to this machine ·
2 agents running" in both. An unbiased visual review is expected to follow.

**Risk bucket / skeptic note.** UI/status surface — low functional risk, moderate user-trust impact.
Not security/session-lifecycle/data-loss; routine enough that an independent clean-room pass is not
required, but an unbiased *visual* review of the two screenshots is warranted (functional asserts are
not sufficient for a UI change).
