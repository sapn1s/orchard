# BUG-031 — provider/API errors may never reach the UI (529 Overloaded etc.) — audit + agnostic relay

- **Status:** VERIFIED
- **Area:** server (agent-bridge/runtime) + UI — error surfacing, provider-agnostic
- **Reported:** 2026-08-05 by user ("if claude code returns 'API Error: 529 Overloaded…' would our
  ui even relay it? similarly other things possibly not considered? … being agnostic since
  providers do it differently")

## Question (audit first — do NOT assume the answer either way)
When the underlying CLI/SDK emits provider-side failures — 529 Overloaded, 429 rate-limit,
5-hour-window exhaustion, auth/credential expiry mid-session, network drops, model-unavailable,
plus the SDK's error-shaped stream events — does the station relay them to the user honestly
(visible, attributed, actionable), or do they vanish into logs / render as a silent hang /
generic "error" state? The user must never stare at a stuck session that actually received a
clear, retryable server-side error.

## Scope of audit
Enumerate the REAL error surface: SDK/CLI error event shapes (sdk.d.ts + stream-json probes),
result subtypes (error_during_execution etc.), stderr patterns, process exit codes, the broker's
error paths (session-host), and what each currently maps to in agent-bridge → StationEvents →
app.js render. Grade each: relayed-honestly / swallowed / mislabeled / hang.

## Fix direction (design for TWO providers)
A provider-agnostic error taxonomy on the runtime seam (FEAT-037): the AgentRuntime maps its
provider's native failures into normalized shapes — e.g. {kind: overloaded|rate-limited|
quota-window|auth-expired|network|model-unavailable|internal, retryable, provider, detail,
statusUrl?} — the bridge relays, the UI renders an honest attributed line/state (with retry
affordance where retryable). ClaudeRuntime maps 529/429/etc.; CodexRuntime (P2) maps its own
(rolling 5h window!). No error class may terminate in a log only.

## Verification (REQUIRED)
Fixture-driven: inject each enumerated error shape through the real bridge path and assert the
UI renders the honest attributed message (and busy-state resolves — no stuck composer). Must
FAIL pre-fix for at least the swallowed classes found. typecheck + ui offline + a live-session
sanity verify.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from user question; pairs with FEAT-037 P2 (Codex fails differently — taxonomy must be
  provider-agnostic from day one). Audit before fixing (§C: find what's ACTUALLY swallowed).

### 2026-08-05 — audit + fix + verify agent (AUDIT first, then provider-agnostic relay; VERIFIED)

#### Phase 1 — AUDIT (ground truth, not assumption)

Sources: `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` (SDKAssistantMessageError,
SDKAPIRetryMessage, SDKResultError/Success, SDKRateLimitEvent, SDKAuthStatusMessage), a LIVE
CLI probe (claude 2.1.222, `-p --model totally-bogus-model-xyz --output-format stream-json`,
$0 — the request 404s before any model runs), `session-host.mjs`, and the full
claude-runtime → agent-bridge → events → app.js trace.

**KEY DISCOVERY (probed, not assumed):** a terminal API failure is carried as a SYNTHETIC
assistant frame — `model:'<synthetic>'`, `is_api_error_message:true`, `error:` one of
SDKAssistantMessageError, content = one text block holding the provider's own message —
followed by a `result` whose subtype is LITERALLY `'success'` with `is_error:true`,
`terminal_reason:'api_error'`, `api_error_status:<code>`. While the CLI is still retrying,
`system/api_retry` frames carry attempt/max_retries/retry_delay_ms/error_status.

**Graded table (pre-fix behaviour):**

| # | Error class | Native shape (Claude path) | Bridge → UI pre-fix | Grade |
|---|---|---|---|---|
| 1 | **529 Overloaded (terminal)** | synthetic assistant frame `error:'overloaded'` + result `subtype:'success'`, `is_error:true`, 529 | error text emitted as ORDINARY assistant text (reads as if Claude said it); turn-end labels the turn by subtype | **MISLABELED** — visible but unattributed; the session-status hover literally read "success · N s" |
| 2 | 529/429/5xx while CLI retries | `system/api_retry` | `#handleSystem` default: dropped | **SWALLOWED** — user watches "Thinking…" through minutes of provider failure |
| 3 | 429 rate_limit (terminal) | assistant carrier, `error:'rate_limit'` | as #1 | **MISLABELED** |
| 4 | Subscription window exhausted (5h/7d) | `rate_limit_event` `status:'rejected'`, `rateLimitType`, `resetsAt` | one transient `#fine` line "rate limit: rejected · N%"; `resetsAt` dropped; nothing durable | **MISLABELED/WEAK** |
| 5 | Auth expiry mid-session | `auth_status` frame (+ terminal carrier `authentication_failed`) | `auth_status` → `#handle` default: dropped; carrier as #1 | **SWALLOWED** (channel) / MISLABELED (carrier) |
| 6 | Model unavailable | probed: carrier `error:'model_not_found'` + result 404 | as #1 (probe-verified) | **MISLABELED** |
| 7 | Billing/credits | carrier `error:'billing_error'` | as #1 | **MISLABELED** |
| 8 | Loop errors (`error_during_execution` etc.) | SDKResultError with `errors: string[]` | turn-end carries subtype only; `errors[]` array NEVER read | **DETAIL SWALLOWED** |
| 9 | Transport death (CLI crash, container kill, OOM) | messages() iterator throws/ends | `#run` catch → fatal error + session-closed; OOM named | RELAYED (generic but honest) |
| 10 | Broker (session-host) CLI crash | child exit → status file; stderr → errlog only | stream end → "agent process ended" | RELAYED-GENERIC (stderr tail stays in errlog; see note) |
| 11 | Network (no HTTP response) | api_retry `error_status:null`, then carrier or throw | as #2/#1/#9 | SWALLOWED during retry, MISLABELED terminal |

**No true HANG exists**: every terminal path emits `result` or throws, so busy resolved even
pre-fix (confirmed by the pre-fix verify run — the busy-resolution check was one of only two
passes). The stuck-composer risk was already fenced by app.js's 4s busy watchdog.

**THE 529 ANSWER (definitive):** *Yes-but-dishonestly.* Pre-fix, "API Error: 529 Overloaded …
status.claude.com" DID reach the transcript — but only because the CLI ships it as a synthetic
assistant text block, so it rendered as if Claude said it, with zero attribution; the
session-status chip then said "Error" whose detail literally read **"success · N s"** (the
SDK's subtype for an api-error result is 'success'); there was no retry affordance; and during
the CLI's internal retry loop preceding it the UI showed plain "Thinking…" with every
`api_retry` frame swallowed. Pre-fix proof: the verify's "never labels the api-error turn
'success'" check FAILED on the stashed tree.

#### Phase 2 — FIX (mapping at the RUNTIME seam, provider-agnostic, additive)

- `src/server/runtime/runtime.ts` — **additive only**: `ProviderErrorKind`
  (overloaded | rate-limited | quota-window | auth-expired | network | model-unavailable |
  internal) + `ProviderError` {kind, retryable, provider, detail (verbatim), statusUrl?,
  statusCode?, retrying?{attempt,maxRetries,delayMs}, resetsAt?} + OPTIONAL
  `AgentRuntime.classifyProviderError?(msg)` — a pure per-message classifier. No existing
  member signature changed, so the concurrent CodexRuntime build cannot break; Codex later
  maps `turn.failed`/rolling-5h-window into the same shape (its window → 'quota-window').
- `src/server/runtime/claude-runtime.ts` — `classifyProviderError` implementation
  (~line 285): synthetic assistant carrier via `ASSISTANT_ERROR_MAP` (overloaded→overloaded/
  retryable+status.claude.com, rate_limit→rate-limited, model_not_found→model-unavailable,
  authentication_failed/oauth_org_not_allowed→auth-expired, billing_error→quota-window,
  server_error→internal/retryable+statusUrl, …); `system/api_retry` → same kind with
  `retrying{…}` (error_status null → 'network'); `auth_status.error` → auth-expired;
  `rate_limit_event` rejected → quota-window + resetsAt; SDKResultError with non-empty
  `errors[]` → internal with joined detail. `terminal_reason:'api_error'` results deliberately
  NOT classified (their carrier frame was), and an interrupt's empty-errors
  error_during_execution stays silent.
- `src/server/events.ts` — new `{t:'provider-error'} & ProviderError` StationEvent; additive
  `turn-end.terminalReason?` so no client can ever have to print "success" for an error turn.
- `src/server/agent-bridge.ts` — `#handle` relays a non-null classification as
  `provider-error` (guarded: a user-requested interrupt's result is never reported as a
  provider error, ~line 1264); suppresses the duplicate plain-text emission for
  `is_api_error_message` frames (~line 1290); passes `terminal_reason` on turn-end.
- `public/app.js` — `provider-error` handler: terminal → durable ATTRIBUTED transcript card
  (.provider-error: "anthropic — servers overloaded", provider detail verbatim, status-page
  link, resets-at time, Retry button when retryable via `retryLastTurn()` re-sending
  `state.lastTurnPrompt`) + ticker + sessError attribution + belt-and-braces busy watchdog;
  `retrying` present → ticker line "… retry 4/10 in 8s" only (turn alive, busy stays true, no
  card spam). turn-end now labels via provError / terminalReason, never the raw 'success'
  subtype. State hygiene: provError/lastTurnPrompt cleared on new turn + session switch.
- `public/styles.css` — .provider-error card (hairline + warm #B0703C accent, pe-head/detail/
  foot/retry).
- `session-host.mjs` — NOT changed (deliberate): broker child death funnels to the SDK
  transport end → the bridge's existing fatal relay (grade: relayed-generic, not swallowed).
  The stderr errlog tail is recoverable on disk; plumbing it live through survival.ts is a
  separate, larger change — flagged as a possible follow-up, not a swallow.

#### Verification (§C — fixture-driven, non-vacuous, real paths)

`scripts/verify-provider-errors.mjs` (new; scratch server on a free port, brave headless CDP,
kill-by-pid, :4317 never touched):
- **A. runtime mapping** — the REAL `ClaudeRuntime.classifyProviderError` against probe-shaped
  fixtures: all 9 error classes + a 5-frame null (non-error) sweep. 10 checks.
- **B. end-to-end, NO mocks** — a REAL CLI session on a nonexistent model ($0): real API 404 →
  real carrier frame → real bridge → attributed card, busy resolves, status attributed (never
  "success"), no duplicate assistant-speech, no Retry on a non-retryable kind. 5 checks.
- **C. non-induceable classes** via the real client event seam (same as FEAT-042/BUG-021):
  529 terminal (card + status.claude.com link + Retry), 529 retrying (ticker, busy stays
  true), quota-window (resets time, no Retry), auth-expired. 5 checks.
- **B2. Retry affordance for real** — clicking Retry re-sends the failed prompt into the live
  session; a SECOND real api-error round-trip observed. 1 check.
- **D. live sanity** — a real haiku turn: clean, zero cards, idle, reply rendered. 1 check.

Results:
- POST-FIX: **22 passed, 0 failed** (two full runs).
- **PRE-FIX (fix files stashed): 2 passed, 11 failed** — every class graded
  swallowed/mislabeled FAILED; the only passes were busy-resolution (audit: no hang class
  exists) and the healthy-turn sanity. Non-vacuity proven, then stash popped and post-fix
  re-run green.
- Anti-regressions: `npm run typecheck` PASS · `verify:ui --offline` 3/0 PASS ·
  `verify:budget-stop` 5/0 PASS · `verify:model-chip` 1 passed.
- Screenshots: `docs/bugs/assets/BUG-031-529-overloaded.png` (attributed 529 card with
  status link + Retry), `docs/bugs/assets/BUG-031-model-unavailable-live.png` (the REAL
  end-to-end api-error render).

package.json was NOT touched (per charter). Entry to add when the orchestrator lands this:
`"verify:provider-errors": "node scripts/verify-provider-errors.mjs"`.

Open/handoff (non-blocking):
- Transcript-on-disk replays (jsonl → transcript route) still render the synthetic carrier
  frame as plain assistant text on reload — the live path is fixed; the store renderer is
  FEAT-037 P2b territory (Orchard-owned capture) if wanted.
- session-host errlog tail live-relay (audit row 10) — possible small follow-up.
- CodexRuntime should implement `classifyProviderError` mapping `turn.failed` / usage-window
  refusals → the same taxonomy ('quota-window' for the rolling 5h window) when P2c lands.
