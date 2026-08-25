```orchard-ticket
{
  "id": "BUG-076",
  "type": "bug",
  "title": "Websites could control local sessions without permission",
  "summary": "Local sessions now reject untrusted browser origins and host headers while preserving dashboard and non-browser access. Before the fix, any visited website could start sessions and bypass permission prompts through the local endpoint.",
  "impact_if_we_wait": "The former flaw allowed hostile websites to execute session commands on the host. Bounded: the deployed checks close this browser and DNS-rebinding path, not the broader absence of authentication for trusted local clients.",
  "current_need": "Treat the ticket as closed: hostile requests failed after the change, legitimate clients passed, and standing checks stayed clean.",
  "severity": "high",
  "area": "Local session security",
  "reported": "2026-08-12",
  "reported_by": "area-review workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Foreign browser origins are rejected during the WebSocket handshake",
    "Foreign host headers are rejected for WebSocket and HTTP requests",
    "Same-origin dashboard connections remain accepted",
    "Clients without an Origin header remain accepted",
    "Documentation explains the browser and DNS-rebinding mitigation"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": "verifyClient",
      "note": "BUG-076 added Origin and Host allowlist enforcement during WebSocket upgrades"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "The HTTP handler also enforces the Host allowlist"
    },
    {
      "path": "src/server/claude-runtime.ts",
      "symbol": "allowDangerouslySkipPermissions",
      "note": "Made unauthenticated session control especially consequential before request checks landed"
    },
    {
      "path": "README",
      "symbol": null,
      "note": "Security posture needed to describe the browser and DNS-rebinding vector"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-076-ws-no-origin-check.md",
    "sha256": "8dfe9c936056aa8922759a57e4c54a4cb1592691b203c0adfe8eda9ae88b4f30",
    "bytes": 5995,
    "original_title": "no Origin/CSRF check on the WebSocket endpoint: any website can drive sessions (localhost boundary defeated)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the attack path, deployed checks, client compatibility, documentation requirement, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-076 — Websites could control local sessions without permission

## Diagnosis

The WebSocket upgrade and HTTP handler accepted requests without checking Origin or Host. A malicious page could connect to the loopback service, send `start` with `permissionMode: bypassPermissions`, change permission mode, or submit approval responses. Because browsers require the server to validate WebSocket origins, binding to `127.0.0.1:4317` did not prevent this attack. DNS rebinding could also present a hostile domain while reaching the local service.

## Evidence

The pre-fix clean-room run, with `index.ts` stashed, produced 3/3 expected failures: a foreign Origin was accepted and ran `start`, a foreign Host WebSocket connected, and a foreign Host HTTP request returned 200. After the fix, `verify:bug-076` passed 6/6, `verify:ui` passed 7/7, and `verify:sessions` passed 52/52. An additional matched tally recorded 3/3. Typecheck and leak-gate were clean. `verify:bug-076-ws-origin` was named without a recorded result.

## Implementation notes

The WebSocket upgrade now accepts browser requests only when Origin matches the configured localhost allowlist. Requests without Origin remain available to non-browser clients. Both WebSocket and HTTP paths restrict Host to localhost values, with environment overrides for legitimate reverse proxies.

## Verification plan

Reject a foreign-Origin WebSocket handshake and confirm its `start` handler cannot run. Accept same-origin dashboard traffic and clients without Origin. Reject foreign Host values on WebSocket and HTTP paths. Exercise the dashboard, session suite, typecheck, and leak checks.

## Migration and rollback

This server-side change required deployment. The ticket status records the allowlist as deployed. Rollback would restore the browser and DNS-rebinding exposure, so any rollback must retain equivalent Origin and Host enforcement.

## Risks

Overly narrow allowlists can block legitimate reverse proxies, alternate localhost spellings, or non-browser integrations. Environment overrides must not become unrestricted defaults that recreate the original exposure.

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
