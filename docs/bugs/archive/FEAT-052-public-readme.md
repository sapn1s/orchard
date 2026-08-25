# FEAT-052 — public README + placeholder screenshots

- **Status:** VERIFIED
- **Area:** docs / release
- **Reported:** 2026-08-06 by user ("screenshot of the app (don't show anything private —
  placeholders), brief README, concise, any info that's useful, no unnecessary information")

## Goal
The public-facing README for the fresh-history mirror (FEAT-049): what Orchard is, real
screenshots seeded with fictional placeholder data only, quick start, provider pointer,
one-line feature bullets, the FEAT-049 Security posture section retained prominently, and
an honest project-status note. Zero marketing language.

## Work items
1. Screenshots from a scratch server (free port, scratch dataDir) seeded with fictional
   projects; optionally one real tiny haiku turn for a live-looking transcript (generic
   prompt). Manual visual check: no real project names, no home paths/usernames, no
   personal data. Saved to `docs/assets/screenshot-*.png` (new dir; docs/bugs/assets
   stays for tickets).
2. README rewrite: concise, useful-to-a-stranger only; Security posture section kept.
3. Gate: `node scripts/leak-gate.mjs` must PASS with the new files present.

## Verification
leak-gate PASS; `verify-ui.ts --offline` 3/3 (no UI code touched — sanity);
`npm run typecheck` clean; screenshots visually inspected for private data.

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
