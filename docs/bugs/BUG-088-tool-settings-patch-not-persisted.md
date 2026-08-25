```orchard-ticket
{
  "id": "BUG-088",
  "type": "bug",
  "title": "Tool settings changes failed to persist",
  "summary": "Tool toggles now remain in the client’s saved project settings instead of disappearing after an accepted update. The server already handled these settings correctly. The corrected client asset still must be deployed before users receive the change.",
  "impact_if_we_wait": "Users may remain unable to enable Playwright or retain other tool selections. Bounded: this affects settings and display correctness, not project data or session history.",
  "current_need": "Close the ticket: persistence cases and related session checks passed, with type and leak checks clean.",
  "severity": "medium",
  "area": "Project tool settings",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Enabling Playwright persists after the project is read again",
    "A partial tool update preserves the other tool setting",
    "Browser and snapshot settings persist when changed",
    "Unknown tool keys are rejected",
    "The tool toggle explains any legitimate disabled state"
  ],
  "code_refs": [
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "Client-side fix preserves tool settings when saving project changes"
    },
    {
      "path": "src/server/validate.ts",
      "symbol": "validateProjectPatch",
      "note": "Investigated as the suspected cause; server validation was already correct"
    },
    {
      "path": "src/server/registry.ts",
      "symbol": null,
      "note": "Defines Serena and Playwright tool settings and their defaults"
    }
  ],
  "related": [
    {
      "id": "BUG-089",
      "relation": "recurrence_of"
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-088-tool-settings-patch-not-persisted.md",
    "sha256": "ef87a2540b8ff36fa1b1903c00b9ccdea681d4d7e19a3ea2a22bfc7889ef45fa",
    "bytes": 7726,
    "original_title": "tool settings (playwright/serena MCP) don't persist: PATCH validated but `tools` silently dropped",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the supplied ticket; the symptom, corrected client cause, deployment requirement, requested checks, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-088 — Tool settings changes failed to persist

## Diagnosis

The original diagnosis blamed server validation for accepting `tools` without copying it. Investigation showed the server path was already correct. The loss occurred in `public/lib/drawer.js`, where the client-side settings update omitted `tools`, causing the returned project to retain its previous values and triggering the persistence warning.

## Evidence

The targeted tool-toggle suite passed 13/13, MCP attachment passed 20/20, session coverage passed 52/52, and the BUG-088 regression suite passed 11/11. Type checking and the leak gate were clean. `verify:bug-088-tool-settings` was named but has no recorded run result.

## Implementation notes

The client save path now carries tool selections through the project update. Server validation remains unchanged because it already persisted the supported settings. The original request also called for checking browser and snapshot settings and retaining any legitimate toggle gate with a legible explanation.

## Verification plan

Exercise enabling Playwright, read the project again, and confirm the setting remains enabled. Patch one tool without changing the other, exercise browser and snapshot settings, and reject an unsupported tool key. The executed regression suites cover tool toggles, MCP attachment, sessions, and BUG-088 behavior.

## Migration and rollback

Deploy the updated client asset before expecting the fix in served environments. Rollback consists of restoring the previous drawer asset, which would also restore the settings-loss behavior.

## Risks

A stale cached or undeployed client asset can continue dropping tool selections even though the source fix is complete. Changes to partial settings updates must not overwrite the other tool’s value.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed + root-caused from the user's report. Server fix (validate.ts) → needs a deploy.

### 2026-08-13 — worker (BUG-088 lane)
**The ticket's confirmed root cause was WRONG — the server was never broken.** Verified
against a live scratch server (free port, scratch dataDir; never :4317) and by reading the code:

- `validate.ts` ALREADY has full `if ('tools' in src)` / `if ('browser' in src)` /
  `if ('snapshots' in src)` copy blocks (validate.ts:188-207 tools, :155-187 browser,
  :208-247 snapshots — all present since the initial commit df2362a, no "missing block").
- `updateProject` (registry.ts:352-359) already one-level merges `tools` against
  `{...defaultToolSettings(), ...cur.settings.tools, ...patch}` — a partial `{playwright:true}`
  does NOT wipe `serena`. Same for browser (:347-349) and snapshots (:357-359).
- Live proof: `PATCH settings.tools.playwright=true` → GET → `playwright:true` persisted;
  partial patch preserved the sibling; browser + snapshots persisted; `{tools:{foo:true}}`
  rejected 400 "unknown tools field \"foo\"". So (S1..S4) all PASS on HEAD as anti-regression
  guards, not as the fix — there was nothing to fix in validate.ts. **No server change made.**

**Browser / snapshots audit (ticket item 2):** both already have copy blocks + deep merges
(above). No silent-drop bug. Noted, no change.

**Actual root cause (client-side):** the user-facing error
`"could not save tool settings: settings did not persist: tools"` comes from the drawer's
save path, not the server. `public/lib/api.js` `patchProject` echo-checks the save by comparing
the object it SENT key-for-key (`same()`, requires equal key-count) against the object the server
ECHOES. On a project whose stored `settings.tools` is ABSENT or PARTIAL — any project predating
FEAT-025, i.e. a real older project, which is exactly what the reporting user had — the drawer's
`putTools` sent a one-key partial `{playwright:true}` (because `settings().tools` was `undefined`);
the server correctly filled defaults and echoed the SUPERSET `{serena:true, playwright:true}`;
`same()` failed on key-count and the client threw "did not persist" **even though the server had
persisted the value**. Fresh projects store a full tools object and so never hit this — which is
why the minimal fixture would have missed it; the decisive test runs against a no-tools project.
(regressed-from: none — shipped this way in df2362a; the `same()` strict-key-count check is the
latent flaw. `putBrowser`/`putSnapshots` share the SAME latent class — see follow-up below.)

**Greyed-out toggle (ticket item 3):** LEGITIMATE gate, not an accidental disable. The switch is
disabled only when `readOnly` is true, and `readOnly === (d.scope === 'session')` (drawer.js:292,
565). In session scope the browser + MCP tools are project-scope only: they are baked into the
launch `mcpServers` config and a running session can't attach/detach them (consistent with
`validateSessionOverrides`, which rejects project-scope fields). The gate was kept. BUT the reason
was NOT legible — `integrationsGroup` had no note in session scope (unlike Isolation/Mounts/Snapshots
which do). Added a legible note so the greyed toggles read as intentional, not broken.

**Fix map:**
- `public/lib/drawer.js` — `putTools` (~:580) now sends the resolved FULL tool object via new
  `effectiveTools()` (~:568) `{ ...effectiveTools(), ...patch }` so sent===echoed and a real save
  stops being misreported. `integrationsGroup` (~:552) now appends a project-scope note when
  `readOnly`, explaining why the toggles are greyed in session scope.
- `scripts/verify-bug-088-tool-settings.mjs` (+ `package.json` `verify:bug088`) — boots a real
  scratch server AND drives the REAL `public/lib/api.js` `patchProject` against a REALISTIC
  older-project fixture (no stored `tools`, both tools resolved).

**Verification:** `verify:bug088` 11/11 (MUST-FAIL proven: with the drawer edits reverted → 9/11,
W1+W2 fail; C1 reproduces the exact user error string live). Anti-regress: verify:tool-toggle 13/13,
verify:mcp-attach 20/20, verify:sessions 52/52, typecheck clean, leak-gate PASS.

**Risk bucket:** settings-persistence / UI-save fix — self-verify sufficient (not
security/lifecycle/data-loss). No independent clean-room pass required.

**Deploy:** the change is a client asset (`public/lib/drawer.js`) served by the station server →
needs a deploy/restart to serve the updated file. NOT deployed by this worker.

**Follow-up recommended (out of this lane):** the deeper/general fix is in `public/lib/api.js`
`echoed()`/`same()` — make the nested-object compare SUBSET-aware (server may add default keys),
which would also cure the identical latent false-negative for `putBrowser`/`putSnapshots` partial
sends. `api.js` was outside this lane; filing/dispatching that is left to the orchestrator.
