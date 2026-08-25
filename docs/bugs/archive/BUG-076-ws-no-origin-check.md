# BUG-076 — no Origin/CSRF check on the WebSocket endpoint: any website can drive sessions (localhost boundary defeated)

- **Status:** VERIFIED 2026-08-13 (deployed) — HIGH (security). Origin + Host allowlist landed
  on the WS upgrade (`verifyClient`) and HTTP handler in `src/server/index.ts`. New
  `verify:bug-076` 6/6 post-fix; pre-fix clean-room (index.ts stashed) 3/3 must-FAILs failed
  (foreign Origin ACCEPTED + `start` handler ran; foreign Host WS ACCEPTED; foreign Host HTTP 200).
  Anti-regressions: typecheck clean, leak-gate PASS (0/329), verify:ui 7/7 (live same-origin WS
  path intact), verify:sessions 52/52. SERVER change → needs a deploy (deferred — user away, no
  restart).
- **Area:** src/server/index.ts WS upgrade + HTTP handler — security posture
- **Reported:** 2026-08-12 by the area-review workflow (security reviewer + skeptic verify)

## Finding (code-confirmed)
`new WebSocketServer({ server, path: '/ws' })` (index.ts:2518) has NO `verifyClient` and no
Origin/Host check anywhere in the connection handler (:2520) or the HTTP request handler
(:2454-2469). The full `start` command surface — projectId, prompt, overrides incl.
`permissionMode: bypassPermissions`, plus `set-permission-mode` and self-answered
`approval-response` — is accepted over `/ws` with no credential. Browsers do NOT apply
same-origin policy to WebSocket *connection establishment* (they send an Origin header the
server must check). `allowDangerouslySkipPermissions` is armed for every session
(claude-runtime.ts:183).

## Failure scenario
Victim runs claude-station on 127.0.0.1:4317 and, in the same browser, visits any attacker page.
The page opens `new WebSocket('ws://127.0.0.1:4317/ws')` and sends a `start` with an attacker
prompt + `bypassPermissions`; the server accepts it (no Origin check) and executes on the host.
Works via a plain cross-origin page, and via DNS-rebinding from a stable attacker domain. The
README presents the 127.0.0.1 binding as THE security boundary (README:85-88) — this vector
silently defeats it. This is distinct from the deliberately-out-of-scope "auth tier": an Origin
allowlist on the WS upgrade + a Host-header check is the standard, proportionate fix.

## Wanted
1. `verifyClient` (or an upgrade-time check) on the WS server: reject unless the `Origin` header
   is absent (non-browser clients like the dashboard's own fetch/CLI) OR matches an allowlist
   (`http://127.0.0.1:PORT`, `http://localhost:PORT`, configurable via env). A browser page on
   any other origin is rejected at handshake.
2. Host-header allowlist on both HTTP and WS to blunt DNS-rebinding (only 127.0.0.1/localhost:PORT
   Host values accepted) — env-overridable for legitimate reverse-proxy setups.
3. Update the README security posture to state the browser/rebinding vector and that the Origin
   allowlist is the mitigation (honesty: the old text omitted it).
4. Must not break the real dashboard (same-origin) or the CLI/dispatch clients (no Origin header).

## Verification (§C)
Scratch server: a WS handshake with a foreign `Origin` is rejected (must FAIL pre-fix: accepted +
a `start` runs); no-Origin client still connects (CLI/dispatch path); same-origin dashboard Origin
accepted; a foreign `Host` header rejected. verify:ui, verify:sessions, typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow (security reviewer, skeptic-verified high-confidence). Top
  severity of the review batch; server-side, needs a deploy (deferred — user away, no restart).

### 2026-08-12 — worker (fix + verify)
- **Wanted 1 (Origin allowlist):** `verifyClient` on the WS server rejects a handshake whose
  `Origin` is present AND not in the allowlist; a MISSING Origin (CLI/dispatch, any non-browser
  client) is allowed; `http://127.0.0.1:PORT` / `http://localhost:PORT` allowed;
  `CLAUDE_STATION_ALLOWED_ORIGINS` (comma-separated) adds to the defaults.
- **Wanted 2 (Host allowlist):** enforced on BOTH the HTTP request handler (403 before routing)
  and the WS upgrade (`verifyClient`, since upgrade requests bypass the HTTP handler). Defaults
  `127.0.0.1:PORT` / `localhost:PORT`; `CLAUDE_STATION_ALLOWED_HOSTS` adds to them for reverse
  proxies. Absent Host = reject (HTTP/1.1 requires it).
- **Wanted 3 (README):** added a "Browser / DNS-rebinding boundary" bullet naming the vector
  honestly (WS establishment is not gated by same-origin policy) and the Origin+Host mitigation.
- **Wanted 4 (no breakage):** verify:ui 7/7 — the live same-origin dashboard WS path streams as
  before; the no-Origin CLI/dispatch path connects in verify:bug-076.
- **Verification (§C):** new `scripts/verify-bug-076-ws-origin.mjs` (`npm run verify:bug-076`),
  scratch server on a free ephemeral port + scratch dataDir (never :4317). Post-fix 6/6 PASS.
  **Pre-fix must-FAIL (clean-room, `git stash push -- src/server/index.ts` at HEAD):** 3/3 target
  checks FAILED — foreign Origin `http://evil.example.com` handshake OPENED and the `start` handler
  ran (`no project bug076-nonexistent`); foreign-Host WS handshake OPENED; foreign-Host HTTP = 200.
  Anti-regressions: `typecheck` clean, `leak-gate` PASS (0 hits / 329 files), `verify:ui` 7/7,
  `verify:sessions` 52/52.
- **Lane discipline:** touched only `src/server/index.ts` (WS/HTTP handlers), `README.md`,
  `scripts/verify-bug-076-ws-origin.mjs`, `package.json` entry, this ticket. Did not touch
  agent-bridge.ts / runtime/* / app.js / scripts/* other lanes.
- **DEPLOY NOTE:** server-side change — the running service on :4317 still has the OLD (unguarded)
  handler until redeployed. Not deployed / not restarted (user away). Deploy required to close the
  vector in the live instance.

### 2026-08-13 — board reconciliation
- Deploy has since happened (commit 9412773 live; pid 1162138 runs the latest code). Status header
  relabeled FIXED→VERIFIED so board:gen moves this row out of Open (queued-count reconciliation).
