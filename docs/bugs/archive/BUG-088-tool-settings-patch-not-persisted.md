# BUG-088 — tool settings (playwright/serena MCP) don't persist: PATCH validated but `tools` silently dropped

- **Status:** FIXED (client-side, in `public/lib/drawer.js`; needs a deploy to serve the updated asset) — root cause was NOT where the ticket said (server was already correct); see 2026-08-13 worker log.
- **Area:** src/server/validate.ts `validateProjectPatch` (+ maybe the client greyed-out toggle)
- **Reported:** 2026-08-13 by user:
  > "trying to enable playwright mcp for project, the toggle is greyed out and clicking it shows
  > 'could not save tool settings: settings did not persist: tools — server accepted the PATCH but
  > echoed back the old values'."

## Root cause (confirmed)
`validateProjectPatch` lists `tools` in the recognized SETTINGS key set (validate.ts ~:26, so it
does NOT throw "unknown settings field"), but there is **no `if ('tools' in src)` block** that
validates + copies it into the returned `settings`. Every other field (model, effort,
permissionMode, allowedTools, instructions, mounts, container) has such a copy block; `tools` does
not. So a PATCH of `settings.tools = {playwright:true}` passes validation, `updateProject` writes
settings WITHOUT tools, and the route echoes the OLD `tools` → the client's persist-check fails
("echoed back the old values: tools"). **`browser` and `snapshots` are also in the key set — verify
they have copy blocks too; if not, same bug.**

`settings.tools` shape (registry.ts): `{ serena: boolean, playwright: boolean }` (serena default ON,
playwright default OFF).

## Wanted
1. Add an `if ('tools' in src)` handler in validateProjectPatch: validate it's an object with only
   `serena`/`playwright` boolean keys, and copy to `settings.tools` (merge-friendly — a partial
   `{playwright:true}` must not wipe `serena`; follow how the server merges tool settings, e.g.
   `resolveToolSettings`/`{...defaults, ...project.settings.tools}`). Then the PATCH persists.
2. Audit `browser` and `snapshots` the same way — if they're in the key set without a copy block,
   fix them too (same silent-drop bug).
3. Investigate the **greyed-out toggle**: why playwright's toggle renders disabled. If it's a
   real gate (e.g. only editable when no session live, or requires a specific isolation), keep it
   but make the reason legible; if it's an accidental disable, fix it. (drawer.js toolToggleRow ~:529.)

## Verification (§C)
Scratch server: PATCH `settings.tools.playwright=true` → GET the project → `tools.playwright===true`
persisted (must FAIL pre-fix: echoes old/false); a partial tools patch does not wipe the other tool;
browser/snapshots patches persist; unknown tools key rejected. Anti-regressions: verify:tool-toggle,
verify:mcp-attach, verify:sessions, typecheck, leak-gate.

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
