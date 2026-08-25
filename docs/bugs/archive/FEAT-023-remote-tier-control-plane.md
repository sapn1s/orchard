# FEAT-023 — Remote tier / control plane (drive sessions in containers on another machine)

- **Status:** OPEN — recommend staying parked behind FEAT-021/022; security-gated; revisit when those land.
- **Area:** claude-station platform
- **Reported:** 2026-08-04 (lift from external-project-P)

## In plain terms
A larger future feature: run Claude sessions inside isolated containers on another machine and drive them from
the browser — a "control plane" on top of the container support we already have. It would let you work across
machines — but done carelessly it could expose sessions or credentials over a network, which is why it carries
hard security requirements (encryption and a login before it could ever be reached over a network).

**Recommendation:** keep it parked behind the earlier work (FEAT-021/022) it was deliberately sequenced after;
its size and security requirements don't warrant starting it before those land.

**What I need from you:** triage only — confirm it stays parked, or re-prioritise it.

**If you do nothing:** nothing breaks; it stays a parked design.

> Everything below is the detailed design, security gates, and verification plan — reference.

## Goal
Drive Claude sessions running in per-project containers from the browser, including
on a remote machine — a control plane on top of the existing container tier.

## Design (lift from external-project-P, scouted)
- Per-project containers via dockerode-style management (ensureProjectContainer /
  isStale / stale-config recreation); an in-container agent exposing /health +
  PTY-over-websocket (/ws/terminal); JWT-cookie auth.
- REUSE the existing container-manager.ts rather than the wrapper's own — this is a
  control-plane + transport layer over what we already have.

## Security gates (BLOCKING — from the scout)
- TLS + auth required before binding beyond 127.0.0.1.
- Do NOT copy the wrapper's shared READ-WRITE `claude-auth-data` volume (one
  compromised container can rewrite all projects' creds) — use the narrow
  per-project cred bind (external-project-O-linux posture).
- docker socket off by default.

## Verification (REQUIRED)
Loopback-only first: create a project container, health-check its agent, drive a PTY
over ws, tear down. Assert no cross-project cred access. Then the auth/TLS gate.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. User deferred to recommendation: sequence after boot-aware + autonomous.
