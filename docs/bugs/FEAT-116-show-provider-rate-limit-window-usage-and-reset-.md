```orchard-ticket
{
  "id": "FEAT-116",
  "type": "feature",
  "title": "Show provider rate-limit window usage and reset for dispatch-now vs park",
  "summary": "Orchard shows model names and cost spend but nothing about how much of the provider's rate-limit window is already consumed or when it resets. The user has to guess whether a lane fits in the remaining window, and finds out only when a session dies on a quota wall.",
  "impact_if_we_wait": "The user can't answer the in-the-moment question 'can I afford to run this lane now, or should I park a ticket until the window resets?' They dispatch blind and burn a window, or hold back conservatively for no reason.",
  "current_need": "Surface, per provider, the percent of each rate-limit window consumed and its reset time, from the provider's own interface (never our token accounting). Never block a session; degrade to unknown on timeout; leak no credentials.",
  "severity": "medium",
  "area": "Provider status — rate-limit windows",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "For OpenAI/Codex, the 5-hour and weekly window usedPercent and reset epochs are read from the codex app-server account/rateLimits/read method and shown with an as-of time.",
    "For Anthropic/Claude, the 5-hour and 7-day window utilization and resets are read from the OAuth usage endpoint the CLI's /usage view uses.",
    "The read never blocks a session or UI control: bounded, cached, failing quietly to 'unknown' rather than showing a stale value as live.",
    "A provider with no available source shows 'not available'; usage is never inferred from Orchard's own token/cost accounting.",
    "No OAuth token or credential appears in logs, tickets, or the UI (leak gate clean).",
    "The surface fits the FEAT-114 header (a quiet tier-2 readout), not a competing panel."
  ],
  "code_refs": [
    {
      "path": "src/server/provider-usage.ts",
      "note": "readers for both providers (codex app-server rateLimits + Claude oauth/usage), bounded + cached + fail-quiet normaliser"
    },
    {
      "path": "src/server/index.ts",
      "note": "GET /api/usage route returning both providers' snapshots with asOf; never blocks"
    },
    {
      "path": "public/index.html",
      "note": "#usageBtn tier-2 readout in #seal"
    },
    {
      "path": "public/app.js",
      "note": "paintUsage() + slow poll of /api/usage"
    },
    {
      "path": "public/styles.css",
      "note": "usage readout severity styling"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# FEAT-116 — Show provider rate-limit window usage and reset for dispatch-now vs park

## Implementation notes

Two real sources, each established from the tool's own interface and driven live
(not guessed):

- **OpenAI/Codex** — `codex app-server` speaks `account/rateLimits/read`
  (JSON-RPC; schema `GetAccountRateLimitsResponse`, codex-cli 0.152.1). Its
  `rateLimits.primary` is the rolling 5-hour window and `.secondary` the weekly
  one, each `{ usedPercent, resetsAt (unix sec), windowDurationMins }`. We spawn a
  short-lived app-server, `initialize`, read once, and kill it.
- **Anthropic/Claude** — the CLI's `/usage` view is backed by
  `GET https://api.anthropic.com/api/oauth/usage`, authorized with the same
  subscription OAuth token Claude Code stores at `~/.claude/.credentials.json`.
  It returns `five_hour` / `seven_day` `{ utilization, resets_at }` plus a
  `limits[]` array that flags the currently-binding window (e.g. a model-scoped
  weekly cap). This is **not** scraping the TUI — it is the same JSON the TUI
  itself fetches. There is no documented public endpoint for subscription-window
  usage (the Messages API `x-ratelimit-*` headers are API-key ITPM/OTPM tiers, a
  different thing, and Orchard authenticates by subscription, not an API key), so
  this OAuth endpoint is the supported equivalent of Codex's method.

`src/server/provider-usage.ts` normalizes both into
`{ provider, available, asOf, windows:[{label, usedPercent, resetsAt, binding?}], plan, note }`.
`GET /api/usage` (index.ts) serves the **cached** snapshots and never awaits the
network: `getUsageSnapshots` returns immediately and revalidates in the
background (stale-while-refresh, 60s TTL), so the route cannot block a UI
control. Each read is bounded (6s) and fails quietly to `available:false`
("unknown"), preserving the last good `asOf` rather than overwriting a good value
with a lie. The OAuth token is read at call time, used only in the Authorization
header, and never logged, returned, or surfaced. The UI is a quiet tier-2
`.readout` (`#usageBtn`) in the FEAT-114 header showing the binding window
("49% wk · 5d") with severity tint (≥75% amber / ≥90% red / dim when unknown);
the full both-providers detail (percent, exact reset, plan, as-of) is in the
tooltip. Painted by `paintUsageChip()`, polled every 30s.

## Verification plan

`scripts/verify-feat-116-provider-usage.mts` — 29/29 against the REAL providers:
Codex normalized read matches a raw `account/rateLimits/read`; Claude normalized
read matches the raw `/api/oauth/usage` JSON; failure/degrade paths (Codex
not-found, Codex hang→timeout-and-kill, Claude no-credential, Claude network
timeout, Claude bad-token→401) are all bounded and fail-quiet with no throw and
no token in any note; the request surface returns synchronously; and no OAuth
token appears in the rendered snapshot. Endpoint proven live on a scratch server
(free port): first call returns "reading…" placeholders, a later poll returns
real values, and a leak scan of the payload for the live token found nothing.
A real-headless-browser visual review of the readout (both themes) is warranted
per the UI-visual-review rule.

## Risks

- The Claude source is an **undocumented** OAuth endpoint; Anthropic could change
  or remove it. Failure is already handled (degrades to "not available"), so the
  blast radius is a missing readout, not a broken app.
- The OAuth access token can expire; a 401/403 degrades to "sign-in expired —
  re-authenticate" (no token in the message). No refresh is attempted.
- The tree carried other lanes' uncommitted work across `public/*`, `src/server/
  index.ts` and `src/server/runtime/claude-runtime.ts`. Edits were kept to
  disjoint hunks (a new module, one route in a clean gap, additive UI lines
  after `#procBtn`); nothing was overwritten.
- This is subscription/quota state (session-lifecycle-adjacent, credential-
  touching): an independent clean-room verify pass is reasonable before merge.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — worker lane (explore-then-build, round 1)
- **Established sources:** Codex `account/rateLimits/read` from
  `codex app-server generate-json-schema` (`GetAccountRateLimitsResponse`) and
  drove it live (5h + weekly `usedPercent`/`resetsAt`, plan). Claude has no
  documented subscription-usage API; found `/api/oauth/usage` — the endpoint the
  CLI's own `/usage` view calls — and drove it live (`five_hour`/`seven_day`
  utilization + resets + a `limits[]` binding flag). Confirmed the Messages API
  rate-limit headers are API-key tiers, not the subscription windows.
- **Built:** `src/server/provider-usage.ts` (bounded, cached, fail-quiet readers
  + normalizer); `GET /api/usage` (index.ts, non-blocking); `public/lib/api.js`
  `usage()`; `public/app.js` `paintUsageChip()` + `startUsagePolling()`;
  `public/index.html` `#usageBtn` tier-2 readout; `public/styles.css` severity.
- **Verified:** verify-feat-116 29/29 against both real providers incl. all
  failure/timeout/leak paths; live `/api/usage` on a scratch server
  (reading→real values, no token in payload). Real-browser visual review
  dispatched.
- **Gate:** `npm run gate` exits 1 for reasons NOT in my slice — leak-gate flags
  three untracked root `.py` files and a pre-existing comment in
  `src/server/runtime/runtime.ts:44`; typecheck PASSES with my changes in. My own
  files are leak-clean (grepped for home-path / bare-username / token shapes) and
  TS-clean. Left unstaged for the orchestrator to commit.
- **Handoff:** `work_state` in_verification, `human_action` review.
