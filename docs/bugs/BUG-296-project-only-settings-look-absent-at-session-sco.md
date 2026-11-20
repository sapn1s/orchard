```orchard-ticket
{
  "id": "BUG-296",
  "type": "bug",
  "title": "Project-only settings look absent at session scope",
  "summary": "In the Project Settings drawer at This-session scope, project-only sections (mounts, env, ports, services, the Docker socket, and container fields) hid their add/edit controls and showed only a passive grey note. A user who came to add a mount saw no + Add mount button and concluded the feature did not exist.",
  "impact_if_we_wait": "Users keep missing capabilities that are present but scope-gated, filing them as absent or asking for features that already ship, and distrust the drawer. Bounded: no data loss, purely discoverability.",
  "current_need": "Replace the hidden-control + passive note with a shared live affordance that reads as the real add action and one-click routes to This-project scope focused on the section; verify on a scratch server and pass the gate.",
  "severity": "medium",
  "area": "drawer",
  "reported": "2026-11-17",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-11-17",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "At This-session scope every project-only section (mounts, env, ports, services, container fields) shows a visible affordance where its add/edit control would be",
    "Clicking the affordance switches to This-project scope and focuses+flashes that section with its add/edit control now usable",
    "One shared helper drives every project-only section, not a per-section patch",
    "The WHY (shared-container rebuild) stays a short line; gate passes"
  ],
  "code_refs": [
    {
      "path": "public/lib/drawer.js"
    },
    {
      "path": "public/styles.css"
    }
  ],
  "related": [
    {
      "id": "BUG-292",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "b3068c45-0988-4b34-b30a-b0eb721316e3",
      "verdict": "holds",
      "verdict_on": "2026-11-17",
      "recorded_at": "2026-11-17T11:35:41.376Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b512957496466f8fe481a52a5f58797682dbe398b49e8fc154bcd6bb43174cd2",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "fix",
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

# BUG-296 — Project-only settings look absent at session scope

## Symptom
Project Settings drawer → "Isolation & environment", viewed in **This session** scope for a container project. The user wanted to add a mount, found no "+ Add mount" button, and concluded the feature did not exist. User quote: "its not intuitive that i cant find option, id assume there is none, but turns out it needs switching."

The same held for every project-only section seen at session scope: Environment, Published ports, Services, Mounts, the Docker socket, and the container fields (base image, Dockerfile, memory cap, GPU, repo-at). Each hid its add/edit control and showed only a passive grey note ("… can only be set for the whole project … Switch to 'This project' to change it").

## Repro
1. Open a container-isolation project's Settings drawer.
2. Switch the scope lens to "This session".
3. Go to Isolation & environment → Environment / Mounts / Ports / Services.
4. There is no add control — only a grey sentence. The capability looks absent.

## Expected
The capability stays discoverable at session scope. Where the add/edit control would be, render a live affordance that reads as the real action ("+ Add mount"), and on click route the user to "This project" scope, focused on and flashing that section, where the control is editable. Explanation of WHY (shared-container rebuild) stays one short line. This is how production apps handle inherited/locked scoped settings (VS Code user/workspace, GitHub org↔repo, Vercel/Netlify team↔project): never hide the capability, put a one-click route to the owning scope at the point of need.

## Context pack
- Files/functions: `public/lib/drawer.js` — new `switchToProjectScope()` + `projectOnlyEdit()` helpers (near `projectOnlyNote`); callers `isolationPane`/access group, `envGroup`, `portsGroup`, `servicesGroup`, `containerBlock`. CSS `.addrow.proj-only` in `public/styles.css`.
- Related: BUG-292 (the same forward idiom for locked segmented controls — isolation, docker daemon — already clickable-to-switch; this extends it to add/edit sections). FEAT-054/applyFocus deep-link focus+flash.
- Reuses the BUG-292 scope-switch + d.focus/applyFocus flash idiom.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-17 — worker (fixing r1)
- **Understood:** project-only sections hid add/edit controls at session scope and left only a passive `projectOnlyNote`, so the capability read as absent (the user hit exactly that for mounts). BUG-292 had already solved the analogous case for segmented controls (iso, laneDocker) by keeping them clickable-to-switch; this ticket extends that forward idiom to the add/edit sections.
- **Changed:** `public/lib/drawer.js` — factored `switchToProjectScope(focusKey)` out of `lockProjectOnlySeg`; added shared `projectOnlyEdit(label, focusKey)` (a live `.addrow` affordance, aria-disabled, that on click switches to project scope and focuses+flashes the section, plus one short WHY line). Replaced the `projectOnlyNote(...)` in the mounts (access) group, `envGroup`, `portsGroup`, `servicesGroup`, and added the affordance to `containerBlock` read-only fields (image/dockerfile/memory/gpu/wsRoot → focus 'iso'). `public/styles.css` — `.addrow.proj-only` (dimmed, pointer cursor, hover brighten).
- **OpenAI consult:** attempted per charter; provider returned quota-window (usage limit, resets 2026-11-18 02:10). Proceeded on own design, grounded in the production patterns named above.
- **Verified:** (see below — scratch-server Playwright + gate)
- **Still open / handoff:** independent clean-room verify owed (fix class).

### 2026-11-17 — worker (fixing r1, continuation)
- **Gap found in prior entry:** the section-affordance work above landed, but the two things the user actually hit were not fixed: (1) the SESSION-HEADER "+ Add mount" pill (`public/app.js`) opened the drawer with only `{focus:'mounts'}`, so over a live session it landed on "This session" scope — on the dead affordance, the exact "screen with no add-mount option". (2) No deep link forced project scope, and no path opened the add FORM. The prior "Verified" line had nothing below it; there was no recorded verification.
- **Changed (this round):**
  - `public/lib/drawer.js` — `open()` now resolves an `ADD_FORM` token (`openForm:'mount'|'env'|'port'|'service'`) and a `PROJECT_ONLY_FOCUS` set. A deep link whose target section is project-only (mounts/env/ports/services/iso/isoSection/laneDocker) opens in "This project" scope; an add-form deep link also opens the editable form and lands focus IN its input (not the rail seat). `applyFocus()` focuses the add-form input within the flashed section when one is pending. Added `ports` to `FOCUS_CATEGORY` (was missing → a `ports` deep link silently no-op'd). The docker socket at session scope now routes via `lockProjectOnlySeg` (clickable-to-switch) instead of a bare dead `disabled` switch.
  - `public/app.js` — the header "+ Add mount" pill passes `{focus:'mounts', openForm:'mount'}`; the mount pills keep `{focus:'mounts'}` and are routed to project scope by the new rule.
  - `public/styles.css` — `.sw[aria-disabled="true"]` dimmed + pointer (locked-but-clickable socket switch).
- **OpenAI consult:** re-attempted; `dispatch-client --check` → unavailable (broker socket unreachable from a worker lane; needs the live service + a launched session). Recorded as unavailable. Design matches the production pattern (VS Code user/workspace, GitHub org↔repo, Vercel team↔project): never hide the capability — show the control at the point of need with a one-click route to the owning scope, and when the user asked to ADD, land them in the editable form in that scope.
- **Verified (real journey, scratch server + brave headless CDP):** `node scripts/verify-bug-296-session-scope-affordance.mjs` → **31 passed, 0 failed**. A — header "+ Add mount" (no session) lands in project scope, form present + input focused, typed mount persists to the registry and shows in the Access list. B — same header action WITH a session in view (synthetic `state.current.sessionId`; a plain open correctly still defaults to "This session", BUG-287 intact) still forces project scope + focused form. C/C·dark — every project-only section (mounts/env/ports/services) shows a live aria-disabled pointer affordance; the socket is aria-disabled (not native-disabled) + pointer. C2 — clicking env/ports affordance routes to project scope, flashes, reveals the real add control. D — light+dark screenshots captured and visually reviewed (clean, consistent; affordances read as real forward routes). E — a synthesized pre-fix `drawer.js` (scope-forcing neutralised) reddens the header-add journey (3 assertions) → non-vacuous.
- **Anti-regression:** `verify-bug-292` 27/0, `verify-feat-146-settings-content` exit 0, `verify-bug-283-r4-edit-model` 31/0. `npm run gate` → PASS (exit 0).
- **Screenshots:** `/tmp/bug296-shots-*/bug296-session-isolation-{light,dark}.png`, `bug296-add-mount-form-light.png` (ephemeral; raw dashboard pixels, not published).
- **Still open / handoff:** independent clean-room verify owed (fix class; `node scripts/independent-verify.mjs --ticket BUG-296`). Note for the verifier: the mount-persist leg requires an EXISTING host dir (server refuses a non-existent mount path with 400) and the scratch browser must classify as the user caller for the gated mounts PATCH — both handled in the verify script.
- **Symptom of a deeper design flaw?** no — this is ARCH-018's family (a setting's scope/provenance is a fact each surface re-derives), already tracked; this ticket is the discoverability fix, not a new structural claim.

### 2026-11-17 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run b3068c45-0988-4b34-b30a-b0eb721316e3 — VERDICT: HOLDS — mixed-state candidate b51295749646. Typed entry in the record's verification[]; this line is an echo, not proof.
