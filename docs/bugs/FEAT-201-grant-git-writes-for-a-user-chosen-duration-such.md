```orchard-ticket
{
  "id": "FEAT-201",
  "type": "feature",
  "title": "Grant git writes for a user-chosen duration such as 24 hours",
  "summary": "The user grants git-write access from the Git tab and currently gets 30 minutes, so long autonomous runs need repeated re-granting. The user wants to pick an arbitrary duration (e.g. 1h, 8h, 24h) or until revoked.",
  "impact_if_we_wait": "The user must keep re-granting every 30 minutes during long runs.",
  "current_need": "check what the grant API already accepts (scope duration with minutes, permanent); expose a duration picker in the Git tab; keep revoke and expiry visible; independent verify that agents still cannot mint or extend a grant.",
  "severity": "medium",
  "area": "git/grants",
  "reported": "2026-10-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "User can grant git for 1h, 8h, 24h or a custom duration from the Git tab",
    "Remaining time is shown and the grant can be revoked early",
    "An agent still cannot create or extend a grant"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17ea9-c751-7e72-bc0d-15eaf7f6ff7e",
      "verdict": "holds",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T18:41:48.252Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "50e08dc96736f9966080d9d9377e8067f90c3e38d84f5b1dab5d22be97fcbb9d",
      "verify_mode": "mixed-state"
    }
  ],
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

# FEAT-201 — Grant git writes for a user-chosen duration such as 24 hours

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-27 — dispatch openai
- **Verification recorded:** dispatch openai run 01a17ea9-c751-7e72-bc0d-15eaf7f6ff7e — VERDICT: HOLDS — mixed-state candidate 50e08dc96736. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-201 fixing r1)
- **plan+review, build, verify:** Implemented the user-chosen git-write duration.

  PLAN REVIEW (cross-provider): openai quota was exhausted (retry 8:31 PM), so per charter fell back to a fresh anthropic plan reviewer — verdict THUMBS UP with two refinements, both adopted: (1) cut dual-surface scope creep → the duration presets live in the Manage panel ONLY, the header pill stays one-click 'Allow 30 min'; (2) note in the store comment that raising MAX_GRANT_MS also widens the scope:'once' fallback ttl (cosmetic — a once-grant self-expires on first write).

  OWNERSHIP CHECK (charter step 0): the four files the charter flagged as held by FEAT-200 (public/app.js, styles.css, lib/api.js, lib/drawer.js) were NOT needed — the grant picker lives in public/lib/git-view.js + public/git-view.css, and api.grantGitWrite(id,body) already passes an arbitrary body so api.js needed no change. No file-lock references any of the four (the 23 live locks are all /tmp/feat200-r4 scratch + src/server/*.ts, owned by the FEAT-200 verify lane via the server pid). FEAT-200 is mid-flight (board IN-PROGRESS) but its domain (container host-access, src/server) is disjoint from git-grants UI, and I edited none of its files. Proceeded fully in place.

  HYPOTHESIS (confirmed with a twist): the POST /api/projects/:id/git-write-grant route already accepts {scope:'duration',minutes:N} and scope:'permanent'. The ONLY server cap blocking 8h/24h was MAX_GRANT_MS=6h in scripts/lib/git-grant-store.mjs (ttl is Math.min(...,MAX_GRANT_MS)). An 8h/24h request was SILENTLY clamped to 6h.

  CHANGE (smallest): (a) scripts/lib/git-grant-store.mjs — MAX_GRANT_MS 6h→24h (+comment). (b) public/lib/git-view.js — the Manage panel 'For a set time' branch now reveals preset chips 30m/1h/8h/24h + a Custom minutes input capped at 1440 (so no silent clamp is reachable from the UI); gwAllowTimed() sends the chosen minutes; Save/notify labels reflect the duration. (c) public/git-view.css — chip styles. 'Until I turn it off' (the standing/permanent grant, unchanged) still serves durations beyond a day. Remaining-time + early-revoke already existed and render for multi-hour durations (pill shows '24h left' + Revoke).

  PROVENANCE INVARIANT: unchanged. The grant POST stays requireUserCaller-gated, so an agent cannot mint OR extend (re-grant is also a POST); DELETE/revoke stays open by design. Only a numeric ceiling + UI changed; the caller-provenance path was not touched.

  PROOF:
  - must-FAIL baseline: with MAX_GRANT_MS=6h a 24h request clamps to 6h (demonstrated against a sed'd copy of the store), so the new assertions fail on the pre-change tree.
  - scripts/verify-feat-201-duration-grant.mjs: 15/15 — chosen durations stored exactly (30m/1h/8h/24h/90m), 48h clamps to exactly 24h, expiry ENFORCED on claimGrant/useClaim (authorised in-window, refused+purged past expiry), early revoke removes a live 24h grant.
  - scripts/verify-feat-201-ui.mjs: 8/8 in a real headless browser over an isolated scratch server — picker renders 30m/1h/8h/24h/Custom, choosing 24h labels Save 'Allow for 24 hours', Custom reveals a minutes input max=1440, the grant POST stored a ~24h expiry (86399489 ms, NOT clamped to 6h), pill shows '24h left'+Revoke, no page errors. Screenshots in ~/.local/state/claude-station/scratch/feat201/shots.
  - VISUAL review caught + fixed a real hover-contrast bug: '.gt-gw-chip:hover' (specificity 0,3,0) beat '.gt-gw-chip[data-on=true]' (0,2,0), so a hovered SELECTED chip rendered --ink text on its --solid background = invisible (confirmed by a computed-style probe in both palettes). Fixed by scoping the hover to :not([data-on='true']); re-verified the selected chip now resolves --on-solid (readable) in light and dark token sets. Also removed a duplicate 'HOW LONG' header. (Dark-theme screenshots render in the light palette due to a headless-SPA theming quirk — data-theme does not reach the git-view surface at capture; dark contrast is proven by the computed-style probe instead.)
  - anti-regression: scripts/verify-feat-164-self-grant.mjs 65/0 (agent POST grant refused; the mint/extend invariant end-to-end) with my changes applied.
  - npm run gate: PASS (exit 0).
  - Independent verify (scripts/independent-verify.mjs --ticket FEAT-201, mixed-state candidate 50e08dc96736): VERDICT HOLDS, manifest-backed. Verifier added an adversarial suite — all 1440 whole-minute durations exact-expiry, last-ms allowed, above-ceiling clamp to 24h, revoke/replace deny all prior claims, and the actual POST route refuses creation AND extension. Its UNTESTED items (end-to-end caller classification; browser picker) are covered by verify-feat-164-self-grant (65/0) and verify-feat-201-ui (8/8) above.

  Files changed (unstaged, left for the user): scripts/lib/git-grant-store.mjs, public/lib/git-view.js, public/git-view.css; new tests scripts/verify-feat-201-duration-grant.mjs, scripts/verify-feat-201-ui.mjs.
