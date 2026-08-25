```orchard-ticket
{
  "id": "FEAT-052",
  "type": "feature",
  "title": "Public repository had no readable introduction or screenshots",
  "summary": "The public mirror of the project now opens with a short README that explains what the tool is, how to start it, where to point a provider, and how the security posture works. Screenshots seeded entirely with fictional data sit alongside it. No real project names, home paths or personal data appear.",
  "impact_if_we_wait": "A stranger landing on the public repository could not tell what the project was or how to run it. Bounded: this was presentation of the public mirror only, with no effect on the application, stored data or the private history.",
  "current_need": "Nothing is outstanding. The leak scan passed with the new files present, the screenshots were inspected by eye for private data, and standing checks stayed clean.",
  "severity": "low",
  "area": "Public repository presentation",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The leak scan passes with the new README and screenshot files present",
    "Screenshots contain only fictional project data, no home paths or usernames",
    "The README explains what the project is, quick start, and provider setup",
    "The Security posture section stays prominent in the public README",
    "No marketing language, and nothing a stranger does not need"
  ],
  "code_refs": [
    {
      "path": "docs/assets/",
      "symbol": null,
      "note": "new directory for public screenshots; the ticket-board assets directory stays separate"
    },
    {
      "path": "scripts/leak-gate.mjs",
      "symbol": null,
      "note": "the release gate that had to pass with the new files present"
    },
    {
      "path": "README.md",
      "symbol": null,
      "note": "rewritten for the public mirror; retains the Security posture section"
    }
  ],
  "related": [
    {
      "id": "FEAT-049",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-075",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-052-public-readme.md",
    "sha256": "450659255ab230942839000cbd5d157df7cb2b4367b672dab1ee82fc2d89df85",
    "bytes": 5737,
    "original_title": "public README + placeholder screenshots",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the goal, the three work items, the placeholder-only constraint, the retained security section and the recorded checks are all present.",
    "dropped": [
      "the verbatim wording of the original request quoted in the Reported line",
      "the explicit no-marketing-language instruction, which survives as a success criterion rather than prose"
    ]
  }
}
```

# FEAT-052 — Public repository had no readable introduction or screenshots

## Diagnosis

The fresh-history public mirror created under FEAT-052's predecessor work had no reader-facing entry point. A visitor could see the code but not learn what the project does, how to start it, or which provider to configure.

## Evidence

The leak scan passed with the new README and screenshots in the tree. The UI suite ran 3/3 as a sanity check, since no interface code was touched, and typecheck was clean. Screenshots were inspected by eye and carry only fictional project names.

## Implementation notes

Screenshots were captured from a scratch server on a free port with a throwaway data directory, seeded with invented projects. One short real model turn was allowed for a live-looking transcript, using a generic prompt. Files landed in a new public assets directory so that ticket-board images stay where they are.

## Verification plan

Run the leak scan with the new files staged; open each screenshot and confirm no real project name, home path, username or personal content is visible; run typecheck.

## Risks

Screenshot privacy is established by human inspection rather than by an automated check, so a future screenshot added the same way carries the same manual burden.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed per user request; queued behind FEAT-049 scrub (leak gate already green).

### 2026-08-06 — README + screenshots lane
**Screenshots (item 1).** Scratch server: OS-assigned free port (38225 this run),
`CLAUDE_STATION_DATA` = a fresh `/tmp` dir, :4317 never touched, torn down by pid.
Seeded three FICTIONAL projects under `/tmp/orchard-demo/` — `aurora-web`, `atlas-api`,
`lumen-cli` — each with a hand-written placeholder transcript in the Claude store
(generic engineering tickets: cursor pagination, `--json` stdout purity, a focus-trap
fix), timestamps set to hours/days ago so the sidebar reads naturally. One REAL Haiku
turn ran in `aurora-web` (prompt: fizzbuzz + why the multiples are checked in that
order) so the transcript, cost/duration footer and model chip are live, not mocked; a
real `POST /api/sessions/:id/needs-you` decision ("ship to staging or hold?") populated
the Needs-You rail. Driven with brave `--headless=new` over raw CDP (1680x980).
Captured to the new `docs/assets/`: `screenshot-dashboard.png` (sidebar + live
transcript + rail card + Haiku chip), `screenshot-model-picker.png` (model/effort
picker), `screenshot-settings.png` (project settings drawer: model, permissions,
isolation tiers, snapshots).
**Visual privacy check (manual, all three images read back at full size):** project
names are the invented three only; no real project appears; NO filesystem paths, home
dirs or usernames rendered anywhere (the only path-ish affordances — project titles,
the `Direct` chip, "CLAUDE.md only" — carry no path text); no email, no hostname, no
tokens/ids beyond synthetic session titles; the git chip shows `master · 2 dirty` from
the throwaway `/tmp` repo. An earlier draft that leaked a duplicate live session and an
inactive-project row was discarded and re-shot; the superseded
`screenshot-model-chip.png` was deleted. All scratch stores
(`~/.claude/projects/-tmp-orchard-demo-*`), `/tmp/orchard-demo` and the scratch data dir
were removed afterwards.
**README (item 2).** Rewritten end to end, concise: title + 2-paragraph what-it-is
(local multi-project dashboard; both providers on the user's own subscription, never API
keys) → dashboard screenshot → Quick start (npm install/start, Node ≥ 23, systemd unit,
data dir, provider prerequisites pointing at docs/PROVIDERS.md) → "What it does" one-line
bullets (queue, subagent visibility, multi-provider + model chip, boards + Needs-You
rail, restart survival, dispatch + gatekeeper, honest state/errors, instruction
templates, reflink snapshots) → picker + settings screenshots → Optional integrations
(serena = third-party LSP nav via uvx; playwright = third-party ephemeral clean-profile
browser; stealth-browser = OUR thin wrapper over a SEPARATE local `stealth-browser-mcp`
project that is **not in this repo and not published with it** — bring-your-own at
`~/random_projects/stealth-browser-mcp` or `CLAUDE_STATION_SBMCP_REPO`, toggle degrades
with a "not found at <path>" message) → **Security posture retained verbatim** from
FEAT-049 → Verify (4 commands) → compact Layout table → Status ("personal project, moving
fast", no deprecation periods, docs/bugs is the honest record) + out-of-scope line. Cut:
the long snapshots essay (now one bullet + the mechanism in a clause), the per-suite
verify list, the templates deep-dive.
**Verification.** `npm run typecheck` — clean. `node scripts/leak-gate.mjs` — FAIL, but
the ONLY hits are `scripts/.b33-probe.mjs:8` (2 hits, hardcoded repo path), an untracked
in-flight scratch probe belonging to the concurrent BUG-033 lane, not mine and not mine
to delete; re-scanning README.md, this ticket and the three PNG paths with the gate's own
token list gives **0 hits**, so the gate goes green the moment that probe is removed.
`node scripts/verify-ui.ts --offline` — crashes in `paintQueue` (`$('#queueBox')` with an
undefined document) BEFORE printing checks; reproduced identically in a clean worktree at
**HEAD** (`/tmp/orchard-head-wt`), so it is pre-existing/environmental and unrelated to
this ticket (no UI code touched here — diff is README.md + docs/assets/*.png + this file).
Reported up rather than papered over.
**Open:** re-run the leak gate once BUG-033's probe file is gone; verify-ui offline
breakage belongs to whoever owns the UI lane.
