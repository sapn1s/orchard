```orchard-ticket
{
  "id": "FEAT-196",
  "type": "feature",
  "title": "git-write grant cannot be given from a phone over Tailscale",
  "summary": "Granting agent git-write from the phone UI (reached over Tailscale) is refused with \"could not identify the calling process (fails closed).\" The grant route trusts only localhost callers whose owning process it can read; a `tailscale serve` request arrives via root-owned tailscaled, whose process the user-run server cannot inspect.",
  "impact_if_we_wait": "A git-write grant can only be given at the desktop (or by ssh-ing in and curling the route). Away from the machine, the user cannot approve an agent's git write at all, even for their own repo.",
  "current_need": "Pick a remote-identity mechanism that lets the user grant from a trusted device while still making a grant unreachable by any agent, then build it.",
  "severity": "medium",
  "area": "git grant provenance",
  "reported": "2026-10-26",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The user can grant git-write from their phone over Tailscale and the grant takes effect.",
    "No agent-reachable request path can mint a grant: not localhost curl, not a direct hit on the Tailscale IP, not forged identity headers.",
    "A localhost (desktop) grant keeps working unchanged."
  ],
  "code_refs": [
    {
      "path": "src/server/caller-provenance.ts"
    },
    {
      "path": "src/server/index.ts"
    }
  ],
  "related": [
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "FEAT-171",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "82356183-ba35-4ebb-8abf-03f437565f20",
      "verdict": "holds",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T20:18:22.581Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "954a007f6a979f55d9fcf970ce26c89406c21e6fa797fc6f59a20e8b216bb96d",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
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

# FEAT-196 — git-write grant cannot be given from a phone over Tailscale

## Diagnosis

The caller-identification gate `requireUserCaller` (src/server/caller-provenance.ts) answers "user or agent?" by mapping the request's **loopback** peer socket to the owning local process (`/proc/net/tcp{,6}` inode -> `/proc/<pid>/fd` -> cgroup/ancestry). The grant route `POST /api/projects/:id/git-write-grant` (src/server/index.ts ~L1321) calls it and sends its 403 body unchanged.

The server binds `127.0.0.1:4317` only (`const HOST = '127.0.0.1'`, src/server/index.ts L305) and has no auth of its own (by design; README "Security"). The phone reaches it through `tailscale serve`, which the user runs as `https://<host>.ts.net -> proxy http://127.0.0.1:4317`. tailscaled (running as **root**) terminates the Tailscale TLS and opens a fresh loopback connection to the server.

So the request the server sees has `remoteAddress = 127.0.0.1` -> `classifyCaller` treats it as local (L174) and tries to find the owning pid. The owning process is tailscaled (root). The server runs as the **user** (uid 1000), so `fs.readdirSync('/proc/<tailscaled-pid>/fd')` throws EACCES and the pid is never matched -> `pids` is empty -> `kind: 'unknown'` (L179) -> fail closed with the exact message the user saw.

The charter hypothesis (a remote Tailscale IP has no local process, so it fails closed) is the wrong mechanism: a **direct** non-loopback Tailscale connection is classified as `user` at L175 and would SUCCEED. The refusal is specific to the `tailscale serve` proxy: it makes the connection look loopback AND makes the owning pid unreadable.

## Evidence

Verified live on this machine 2026-10-26:
- `tailscale serve status` -> `https://arch-desktop.<tailnet>.ts.net (tailnet only) |-- / proxy http://127.0.0.1:4317`.
- `tailscaled` is pid 857, user `root`.
- The live Orchard server is pid 925, `node .../src/server/index.ts`, the non-root user (uid 1000), cgroup `.../claude-station.service`, listening on `127.0.0.1:4317`.
- As that non-root user: `ls /proc/857/fd` -> `Permission denied`. This is precisely the read `pidsHoldingSockets` performs, so the proxied connection's pid can never be resolved.

## Implementation notes

The invariant any design MUST keep: **an agent can never produce a grant, even via a remote-looking request.** An agent shares the user's uid and can `curl` localhost; if the server is ever bound to the Tailscale interface, an agent could also hit the `100.x` IP, which today classifies as `user` at L175 (a latent self-grant hole the moment loopback-only binding is relaxed). So no design may simply trust "the request looks remote."

Three options:

1. **Tailscale whois identity of the peer node.** Identify the connecting device via tailscaled's verified WireGuard identity (serve's injected `Tailscale-User-Login` header, or a LocalAPI whois on the real peer when bound to the TS interface). Benefit: strongest identity, no new secret, naturally distinguishes the phone (a distinct tailnet node) from a same-host agent (the local node). Cost/risk: the injected header is forgeable by a localhost agent curling `:4317` directly, so the server must accept Tailscale identity ONLY on connections it can prove came from tailscaled (and strip any client-supplied copy) -- and the EACCES above is exactly what makes "prove the peer is tailscaled" non-trivial for a user-run server.

2. **Per-device pairing token in the browser.** Enrol a device once from a localhost/user-verified session; the browser stores a token (localStorage) and presents it on every grant. An un-enrolled agent has no token. Benefit: works regardless of transport, no dependence on reading root processes. Cost/risk: a token is a bearer secret; an agent that can read the paired browser's storage (CDP-attach to the user's own browser) could lift it -- the same residual class already named in caller-provenance.ts.

3. **One-time code / desktop approval.** The remote device's grant request parks as a Needs-You item that must be approved from a localhost-trusted surface (where provenance already works), optionally confirmed by a short code. Benefit: reuses the existing trusted path exactly, adds no new secret. Cost/risk: it needs a second trusted surface in reach, so it does not serve a user who is ONLY on the phone -- it defeats the point for the pure-remote case.

**Recommendation: option 1 (Tailscale whois identity).** It matches the user's actual situation (a phone that is a real, cryptographically-identified tailnet node), adds no bearer secret to leak, and the same-host agent is not a separate authenticated node so the invariant holds by construction. The design work is closing the header-forgery / binding surface: trust Tailscale identity only on a connection proven to originate from tailscaled, keep the existing localhost provenance check for localhost callers, and do NOT relax loopback-only binding without first fixing the L175 non-loopback = user shortcut. If that proof turns out intractable for a user-run server, fall back to option 2.

## Verification plan

Must-fail first: reproduce the refusal by POSTing the grant route through `tailscale serve` from a second device, capturing the `caller-unknown` 403. Then, for the chosen design: (a) the remote device grants successfully; (b) a localhost `curl` with forged identity headers is still refused; (c) a simulated agent in a session-host scope is still refused; (d) the existing localhost dashboard grant still works. Drive the real grant route against a real server, not a provenance unit fixture alone.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-26 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-27 — agent (fixing, round 1, plan+review)
- **Chosen option: 2 (per-device pairing token), not option 1.** Option 1 (trust `tailscale serve`'s
  `Tailscale-User-*` headers) is REFUTED by live evidence on this machine: serve injects only the
  tailnet USER identity, identical for the phone and for a same-host agent routing through the tailnet
  name (`tailscale whois` of the desktop's OWN node returns the user's own tailnet login; a same-host curl to the
  tailnet name returns 200; serve injects no NODE header). A bearer token the agent cannot obtain is the
  mechanism instead.
- **Build.** New `src/server/device-pairing.ts`: enrol mints a 256-bit token returned ONCE; the store
  (`<dataDir>/device-pairings.json`) holds only `sha256(token)`, each record HMAC-sealed with the FEAT-164
  seal key (an agent-written/unsealed record is ignored — same residual bar as the sealed standing grant,
  no NEW casual path). `caller-provenance.ts`: `requireUserCaller(allowPaired)` accepts a paired caller
  ONLY when the loopback peer socket is owned by uid 0 (the root tailscaled proxy, read from
  `/proc/net/tcp` col 7 — a same-uid agent's direct curl is never uid 0) AND the token validates.
  `index.ts`: `POST/GET/DELETE /api/pairings` gated to a LOCALHOST user (no `allowPaired`) so an agent AND
  a paired phone cannot mint pairings; only the git-write-grant POST opts into the token (not global).
  Client (`api.js`): token captured from the URL FRAGMENT `#pair=` (never sent to the server), stored in
  localStorage, attached as `x-orchard-pairing`. Pairing UI added to the git "Manage" panel
  (`git-view.js`/`git-view.css`).
- **Cross-provider plan review (codex/openai)** attacked forgery and flagged 6 issues; adopted: explicit
  `peerUid===0` (not `!=serverUid`); fragment transfer (no URL/log leak); enrolment localhost-only + token
  scoped to the grant route (not global); store holds only a sealed hash.
- **Latent L175 hole found by independent verify and FIXED (regressed-from: FEAT-164).** A same-uid agent
  that binds its client socket to a local NON-loopback source (100.x/192.168.x) while connecting to
  127.0.0.1 made `req.socket.remoteAddress` non-loopback, so `classifyCaller` returned `'user'` and MINTED
  a grant / enrolled a pairing with HTTP 200 — no token needed. This bypassed BOTH the new pairing gate and
  the pre-existing FEAT-164 grant. Fixed: a non-loopback peer to a loopback-only server is now `'unknown'`
  (fail closed) for every `requireUserCaller` route. Two further independent-verify findings fixed: a
  fragment-strip that could leak a second `pair=` token into `location.search` on reload; and an enrolment
  that could grow the store past its 256 KiB read cap (now capped at 128 devices).
- **Verification (honest counts).** `verify-feat-196-pairing-store.mjs` 25/25; `verify-feat-196-remote-grant.mjs`
  13/13 (REAL scratch server + REAL agent session). Anti-regression: self-grant 65/65, provenance-check 17/17,
  session-provenance 25 + endpoint 7/7. `npm run gate` exit 0. (Pre-existing unrelated failure:
  `verify-session-provenance-fold` 5/7 — drives the contended `public/app.js` which was already `M` from
  another session; I never touched app.js.)
- **Independent verify: HOLDS** — `scripts/independent-verify.mjs --ticket FEAT-196`, provider anthropic
  (openai quota exhausted, fell back), run `82356183-ba35-4ebb-8abf-03f437565f20`, candidate `954a007f6a97`.
  Three prior rounds returned BROKEN (source-bind, fragment-leak, store-capacity); all fixed with permanent
  regression tests. UNTESTED (accepted): the live `tailscale serve`→root-tailscaled→loopback happy path (a
  uid-1000 test cannot create a root-owned peer, so uid0+valid-token ALLOW is exercised via the in-process
  peer-uid seam); the phone browser end-to-end; and the FEAT-164 residual class (seal-key theft, stolen
  phone token, CDP-puppeting the user's own browser, scope escape).
- **USER ACTION ONCE:** pair the phone from the desktop — git page → "Manage" (agent-git) → "Grant from your
  phone (Tailscale)" → "Pair a phone…"; the token shows once as `#pair=<token>`; open your Orchard phone URL
  with that fragment appended once. After that the phone can grant agent git-write.
- **UI note:** the pairing panel section was functionally exercised (live API in the integration suite) and
  passes typecheck/JS-syntax, but has NOT had an unbiased visual-review screenshot — flagged for the visual gate.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 82356183-ba35-4ebb-8abf-03f437565f20 — VERDICT: HOLDS — mixed-state candidate 954a007f6a97. Typed entry in the record's verification[]; this line is an echo, not proof.
